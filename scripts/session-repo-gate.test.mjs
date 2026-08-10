// The start/resume gate of the 1:1 session↔container model (no docker, no agent).
//
// A container belongs to one session, so running the same env twice is fine —
// what may NOT overlap is the clone: `<task>/<repo>` is a single working tree
// shared by every session of the task that picked that repo. The gate therefore
// keys on the repo alone, and treats a session as holding it only while it is
// mid-start or owns a live container; an auto-stopped session releases it.
//
// The container state is driven through `sessions.patchContainer`, the same seam
// the container manager writes through, so no daemon is needed to stage a holder.
//
//   node scripts/session-repo-gate.test.mjs
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// GURT_ROOT must be set before the store module loads (read at import time).
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-repo-gate-'))
process.env.GURT_ROOT = GURT_ROOT

const outfile = path.join(os.tmpdir(), `gurt-repo-gate-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await build({
  stdin: {
    contents: `export { createKernel } from ${S('src/main/kernel.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  mainFields: ['module', 'main'],
  outfile,
  logLevel: 'silent'
})

const { createKernel } = await import(pathToFileURL(outfile).href)

/** Wait until the session leaves `starting` and report how it settled. */
async function settle(kernel, id) {
  for (let i = 0; i < 200; i++) {
    const snap = kernel.sessions.snapshot(id)
    if (snap && snap.info.state !== 'starting') return snap
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`session ${id} never left "starting"`)
}

try {
  const ws = 'w'
  const task = 't'
  fs.mkdirSync(path.join(GURT_ROOT, ws, task), { recursive: true })
  fs.writeFileSync(
    path.join(GURT_ROOT, ws, 'workspace.json'),
    JSON.stringify({
      repos: [
        { name: 'alpha', url: 'https://github.com/o/alpha.git' },
        { name: 'beta', url: 'https://github.com/o/beta.git' }
      ],
      envs: [{ name: 'dev', devcontainer: '{"image":"x"}', repo: 'alpha' }]
    })
  )
  fs.writeFileSync(path.join(GURT_ROOT, ws, task, 'task.json'), JSON.stringify({}))
  fs.writeFileSync(path.join(GURT_ROOT, ws, 'agents.json' ), JSON.stringify({}))

  const kernel = createKernel()
  // Wait out the boot reconcile before staging container records: it drops every
  // record Docker does not confirm, and landing mid-test it would release a clone
  // the gate is being asked about (see queue-handoff.test.mjs).
  await kernel.ready
  const ref = { workspace: ws, task, env: 'dev' }
  const mk = (repo, title) => {
    const info = kernel.sessions.createSession(ref, repo, 'a1', 'hi', 'none')
    kernel.sessions.renameSession(info.id, title)
    return info.id
  }

  const a = mk('alpha', 'A')
  const b = mk('alpha', 'B')
  const c = mk('beta', 'C')

  // --- a live container makes its session the holder of the clone ---
  kernel.sessions.patchContainer(a, {
    status: 'running',
    id: 'container-a',
    remoteWorkspaceFolder: '/app',
    repo: 'alpha'
  })

  kernel.sessions.run(b)
  const blocked = await settle(kernel, b)
  assert.equal(blocked.info.state, 'draft', 'a blocked start falls back to draft')
  assert.match(
    blocked.startError ?? '',
    /repository "alpha" is in use by session "A"/,
    'the gate names the repo and the session holding it'
  )

  // --- a different repo is not blocked by it ---
  // C cannot actually come up here (no daemon), but it must fail *past* the gate:
  // reaching provisioning at all is the proof that A did not block it.
  kernel.sessions.run(c)
  const other = await settle(kernel, c)
  assert.doesNotMatch(
    other.startError ?? '',
    /is in use by session/,
    'a session on another repo is not gated by A'
  )
  console.log('repo is exclusive, env is not OK')

  // --- the same env twice is fine: A holds `alpha`, and D shares its env ---
  const d = mk('beta', 'D')
  kernel.sessions.run(d)
  const sameEnv = await settle(kernel, d)
  assert.doesNotMatch(
    sameEnv.startError ?? '',
    /is in use by session/,
    'sharing an env definition is not a conflict'
  )
  console.log('two sessions may run one env definition OK')

  // --- an auto-stopped container releases the clone ---
  kernel.sessions.patchContainer(a, {
    status: 'stopped',
    id: 'container-a',
    remoteWorkspaceFolder: '/app',
    repo: 'alpha'
  })
  kernel.sessions.run(b)
  const released = await settle(kernel, b)
  assert.doesNotMatch(
    released.startError ?? '',
    /is in use by session/,
    'an idle session with a stopped container holds nothing'
  )
  console.log('idle session releases its repo OK')

  // --- the scheduler honours the same gate: a queued session on a held repo
  //     stays queued instead of being started by the next pass ---
  kernel.sessions.patchContainer(a, {
    status: 'running',
    id: 'container-a',
    remoteWorkspaceFolder: '/app',
    repo: 'alpha'
  })
  const e = mk('alpha', 'E')
  kernel.sessions.enqueue(e)
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(kernel.sessions.snapshot(e).info.state, 'queued', 'E waits while A holds alpha')

  // …and is released by the scheduler once the holder's container comes down.
  kernel.sessions.patchContainer(a, undefined)
  kernel.sessions.schedule()
  const woken = await settle(kernel, e)
  assert.doesNotMatch(
    woken.startError ?? '',
    /is in use by session/,
    'freeing the repo lets the queued session through'
  )
  console.log('queue waits for the repo, then advances OK')

  console.log('session-repo-gate.test: PASS')
} catch (e) {
  console.error('session-repo-gate.test: FAIL')
  console.error(e)
  process.exitCode = 1
} finally {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
}
