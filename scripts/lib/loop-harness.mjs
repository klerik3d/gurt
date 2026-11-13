// A headless kernel for the review loop's session-manager seams
// (docs/requirements-review-loop.md §5.1, §5.4–§5.6): temp GURT_ROOT, a stubbed
// container stop, sessions restored into the state they need, and a fake agent —
// `sessions.attach` swapped for a connection whose `session/prompt` runs a
// script — so `runPrompt` really runs, nudge and all, with no docker and no
// adapter. The harness of scripts/queue-handoff.test.mjs, plus that agent.
//
// GURT_ROOT is read when the store module loads, so this sets it before
// bundling: import this file, then `await loopHarness(...)` at module level
// (before the first `test()`).
import { bundle } from './bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * @param {string} name  file-name stem for the temp dirs
 * @param {{
 *   agents?: Record<string, unknown>,
 *   workspace?: Record<string, unknown>,  // workspace.json (default: repos alpha, beta; env dev)
 *   credentials?: unknown[],              // credentials.json entries
 *   kernel?: Record<string, unknown>      // createKernel options (the review loop's clock)
 * }} [opts]
 */
export async function loopHarness(name, opts = {}) {
  const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `gurt-${name}-`))
  process.env.GURT_ROOT = GURT_ROOT
  const outfile = path.join(os.tmpdir(), `gurt-${name}-${process.pid}.mjs`)
  await bundle({
    stdin: {
      contents:
        `export { createKernel } from ${JSON.stringify(path.join(ROOT, 'src/main/kernel.ts'))}\n` +
        `export * as reviewLoop from ${JSON.stringify(path.join(ROOT, 'src/shared/reviewLoop.ts'))}\n` +
        `export * as store from ${JSON.stringify(path.join(ROOT, 'src/main/store.ts'))}\n` +
        `export * as api from ${JSON.stringify(path.join(ROOT, 'src/shared/api.ts'))}`,
      resolveDir: ROOT,
      loader: 'ts',
      sourcefile: 'entry.ts'
    },
    outfile
  })
  const { createKernel, reviewLoop, store, api } = await import(pathToFileURL(outfile).href)

  const ws = 'w'
  const task = 't'
  fs.mkdirSync(path.join(GURT_ROOT, ws, task), { recursive: true })
  fs.writeFileSync(
    path.join(GURT_ROOT, ws, 'workspace.json'),
    JSON.stringify(
      opts.workspace ?? {
        repos: [
          { name: 'alpha', url: 'https://github.com/o/alpha.git' },
          { name: 'beta', url: 'https://github.com/o/beta.git' }
        ],
        envs: [{ name: 'dev', image: 'x', repo: 'alpha' }]
      }
    )
  )
  if (opts.credentials)
    fs.writeFileSync(path.join(GURT_ROOT, 'credentials.json'), JSON.stringify({ version: 2, credentials: opts.credentials }))
  fs.writeFileSync(path.join(GURT_ROOT, ws, task, 'task.json'), JSON.stringify({}))
  fs.writeFileSync(path.join(GURT_ROOT, 'agents.json'), JSON.stringify(opts.agents ?? {}))

  /** What runs "in" each container: host processes the test's `spawnExec` fake
   *  registers with `inContainer`. Shared by every kernel life of this harness (a
   *  rebooted kernel's session ids, and so its container, are the dead one's).
   *  Stopping the container kills their groups — the only way a check dies (§5.3). */
  const inside = new Map()
  const inContainer = (id, child) => {
    if (!inside.has(id)) inside.set(id, new Set())
    inside.get(id).add(child)
    child.once('exit', () => inside.get(id)?.delete(child))
    return child
  }

  /** The helpers of one kernel instance. A rebooted instance (see `boot`) is
   *  wired BEFORE its `ready`, so the recovery of §8 runs against the stubs. */
  function wire(kernel, root, mod, { reboot }) {
    const ref = { workspace: ws, task, env: 'dev' }
    if (reboot) kernel.containers.reconcile = async () => {} // the container records are kept as written
    // No container is ever provisioned here. A real start (a writer the
    // scheduler lets through, a reviewer) gets past every gate and then fails
    // at once, the same on every machine. Left to the real `resolveLaunch`, how
    // fast it failed depended on the host: at once with no docker, but on a
    // runner with docker and network it went on to real `docker` and `git`
    // calls. The session then stayed `starting` past the tests' 3 s waits,
    // holding its repo for every test after it. Every successful launch needs
    // docker anyway (`ensure`, then the adapter install by `docker exec`), so
    // none could succeed here.
    kernel.containers.resolveLaunch = async () => {
      throw new Error('no containers in the loop harness')
    }
    /** Every container stop the session manager / handoff asked for. */
    const stops = []
    kernel.containers.stop = async (id, reason) => {
      stops.push({ id, reason })
      for (const child of inside.get(id) ?? []) {
        for (const target of [-child.pid, child.pid]) {
          try { process.kill(target, 'SIGKILL') } catch { /* gone */ }
        }
      }
      const c = kernel.sessions.snapshot(id)?.info.container
      if (c) kernel.sessions.patchContainer(id, { ...c, status: 'stopped' })
    }
    /** The daemon's answer, from the record the stub above writes. */
    kernel.containers.isRunning = async (id) => kernel.sessions.snapshot(id)?.info.container?.status === 'running'

    /** Restore a started session (executor by default) and, when `up`, give it a
     *  running container. */
    function started(id, repos, extra = {}, { up = true } = {}) {
      const modes = extra.repoModes ?? Object.fromEntries(repos.map((r) => [r, 'write']))
      kernel.sessions.restore([
        {
          info: {
            id,
            env: 'dev',
            role: 'executor',
            repos,
            repoModes: modes,
            task,
            workspace: ws,
            title: id,
            agent: 'a1',
            state: 'started',
            mcp: [],
            startPrompt: 'x',
            ...extra
          },
          acpSessionId: `acp-${id}`,
          log: []
        }
      ])
      if (up) container(id, 'running')
      return id
    }
    const container = (id, status) =>
      kernel.sessions.patchContainer(id, {
        status,
        id: `container-${id}`,
        remoteWorkspaceFolder: '/app',
        repos: kernel.sessions.snapshot(id).info.repos
      })

    /** The fake agent: `scripts[sessionId](n, text)` answers the n-th
     *  `session/prompt` (1-based) with a stop reason, or throws. */
    const scripts = {}
    kernel.sessions.attach = async (s) => ({
      promptCapabilities: undefined,
      peer: {
        request: async (method, params) => {
          if (method !== 'session/prompt') return {}
          const sc = scripts[s.info.id]
          sc.n = (sc.n ?? 0) + 1
          return { stopReason: 'end_turn', ...(await sc.run(sc.n, params.prompt[0].text)) }
        },
        notify() {}
      }
    })
    const agent = (id, run) => (scripts[id] = { run })

    const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
    /** Poll until `fn()` is truthy. */
    async function until(fn, what = 'condition') {
      for (let i = 0; i < 200; i++) {
        const v = fn()
        if (v) return v
        await tick(15)
      }
      throw new Error(`never: ${what}`)
    }

    return {
      kernel, reviewLoop: mod.reviewLoop, store: mod.store, api: mod.api, ws, task, ref, stops, inContainer,
      started, container, agent, tick, until, GURT_ROOT: root
    }
  }

  const roots = [GURT_ROOT]
  let boots = 0
  /** A copy of a data root as the disk holds it right now — what a crash at this
   *  instant leaves behind. Synchronous on purpose: called from inside a hook,
   *  nothing moves between the decision and the copy. */
  function image(from = GURT_ROOT) {
    const to = fs.mkdtempSync(path.join(os.tmpdir(), `gurt-${name}-img-`))
    fs.cpSync(from, to, { recursive: true })
    roots.push(to)
    return to
  }
  /** Boot a second kernel life on a root (an `image`): a fresh copy of every
   *  module (`store` reads GURT_ROOT when it loads), `prepare(instance)` run
   *  synchronously before the kernel's own boot — install the stubs the recovery
   *  needs — then the boot itself, awaited. The dead kernel keeps running in its
   *  own root; the caller freezes whatever it still drives. */
  async function boot(root, prepare) {
    process.env.GURT_ROOT = root
    const mod = await import(`${pathToFileURL(outfile).href}?boot=${++boots}`)
    const kernel = mod.createKernel(opts.kernel)
    const inst = wire(kernel, root, mod, { reboot: true })
    prepare?.(inst)
    await kernel.ready
    return inst
  }

  const kernel = createKernel(opts.kernel)
  // The boot reconcile drops container records Docker does not confirm; stage
  // after it, not into it (scripts/queue-handoff.test.mjs).
  await kernel.ready
  const first = wire(kernel, GURT_ROOT, { reviewLoop, store, api }, { reboot: false })

  function cleanup() {
    fs.rmSync(outfile, { force: true })
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true })
  }

  return { ...first, cleanup, image, boot }
}

/** A promise with its resolver — a gate the fake agent waits on. */
export function gate() {
  let open
  const p = new Promise((r) => (open = r))
  return Object.assign(p, { open })
}
