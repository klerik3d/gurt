// Docker-backed smoke for the per-session network and the proxy container
// (docs/requirements-mcp-proxy.md §6, §7, §9). Not part of `npm run smoke` —
// it needs a real daemon and pulls node:22-alpine and alpine on first run.
//
//   node scripts/smoke-proxy-net.mjs
//
// It stands a fake "session container" (alpine, labelled `gurt.session=<id>`,
// on the default bridge, exactly where `devcontainer up` leaves one) next to a
// real proxy and drives the lifecycle end to end:
//
//   1. ensure  — network created, proxy started, both attached, alias resolves
//   2. converge — the session container is switched off the default bridge onto
//      its own network, with no restart, and a second converge does nothing
//   3. scope   — a scope written on the host reaches the proxy through the
//      bind-mounted *directory* (a file mount would pin an inode and the
//      rename would never be seen), and an allow-list edit takes effect on a
//      running proxy without restarting anything
//   4. stop/start — endpoints survive, which is what makes a resume a converge
//      that plans nothing
//   5. internal — the network is recreated with no route out: direct egress
//      from the session container fails, the proxy still reaches upstream
//   6. teardown — no proxy container, no network, no scope left behind
//
// Steps 3 and 5 reach the public internet (example.com). Everything else is
// local to the daemon.
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-proxy-smoke-'))
process.env.GURT_ROOT = GURT_ROOT
// The bundle does not sit where the app's does, so point the container at the
// script in this checkout rather than at a path relative to the bundle.
process.env.GURT_PROXY_SCRIPT = path.join(ROOT, 'resources', 'proxy', 'gurt-proxy.mjs')

const outfile = path.join(os.tmpdir(), `gurt-proxy-smoke-${process.pid}.mjs`)
await bundle({
  stdin: {
    contents: `
      export { proxies, dockerProxyContainers, proxyContainerName } from ${S('src/main/proxy/manager.ts')}
      export {
        containerNetworks, convergeContainerNetworks, dockerSessionNetworks,
        sessionNetworkName, EGRESS_NETWORK, DEFAULT_BRIDGE
      } from ${S('src/main/proxy/network.ts')}
      export { proxyConfigMount, proxyConfigPath } from ${S('src/main/proxy/config.ts')}
      export { PROXY_ALIAS, PROXY_PORT, proxyEnv } from ${S('src/shared/proxy.ts')}
    `,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})
const m = await import(pathToFileURL(outfile).href)

const SESSION = `smoke-${process.pid}`
const NET = m.sessionNetworkName(SESSION)
const FAKE_CONTAINER = `gurt-smoke-session-${process.pid}`
const log = (line) => process.stdout.write(`      ${line}\n`)

const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
/** Run a command inside the fake session container; null when it fails. */
const inSession = (script) => {
  try {
    return docker('exec', FAKE_CONTAINER, 'sh', '-c', script)
  } catch {
    return null
  }
}

let step = 0
const ok = (what) => console.log(`  ${String(++step).padStart(2)}. PASS  ${what}`)

async function main() {
  console.log(`session ${SESSION}`)

  // --- 1. ensure -----------------------------------------------------------
  const runtime = await proxiesEnsure({ internal: false })
  assert.equal(runtime.network, NET)
  assert.equal(runtime.base, `http://${m.PROXY_ALIAS}:${m.PROXY_PORT}`)
  assert.match(runtime.token, /^[A-Za-z0-9_-]{43}$/)
  assert.deepEqual(
    (await m.containerNetworks(runtime.containerId)).sort(),
    [m.EGRESS_NETWORK, NET].sort(),
    'the proxy sits on the shared egress bridge and on the session network'
  )
  assert.deepEqual((await m.dockerSessionNetworks(SESSION)).get(SESSION), [NET])
  ok('the session network and its proxy exist, labelled and attached')

  // The session's container, where `devcontainer up` would have left it.
  docker(
    'run', '-d', '--name', FAKE_CONTAINER, '--label', `gurt.session=${SESSION}`,
    '--add-host', 'host.docker.internal:host-gateway', 'alpine', 'sleep', '600'
  )
  assert.deepEqual(await m.containerNetworks(FAKE_CONTAINER), [m.DEFAULT_BRIDGE])

  // --- 2. converge ---------------------------------------------------------
  const plan = await m.convergeContainerNetworks(FAKE_CONTAINER, [NET], log)
  assert.deepEqual(plan, { connect: [NET], disconnect: [m.DEFAULT_BRIDGE] })
  assert.deepEqual(await m.containerNetworks(FAKE_CONTAINER), [NET])
  assert.equal(docker('inspect', '-f', '{{.State.Running}}', FAKE_CONTAINER), 'true',
    'the switch does not restart the container')
  // /etc/hosts survives the rewire, so host-side services stay reachable in the
  // default (non-internal) mode.
  assert.ok(inSession('grep -q host.docker.internal /etc/hosts && echo yes'))
  // The embedded resolver of a user-defined network is what makes HTTP_PROXY
  // nameable at all — the default bridge has none.
  assert.ok(inSession(`nslookup ${m.PROXY_ALIAS} | tail -2`), 'gurt-proxy resolves')
  ok('the session container is switched onto its network, live, and resolves the proxy')

  const again = await m.convergeContainerNetworks(FAKE_CONTAINER, [NET], log)
  assert.deepEqual(again, { connect: [], disconnect: [] })
  ok('converging again plans nothing — the resume path costs no rewiring')

  // --- 3. scope ------------------------------------------------------------
  const scope = (policy) => ({
    version: 1,
    session: SESSION,
    token: runtime.token,
    mcp: {},
    network: { internal: false, policy }
  })
  await m.proxies.pushScope(SESSION, scope({ allow: [] }))
  assert.equal(
    fs.readFileSync(m.proxyConfigPath(SESSION), 'utf8').includes(runtime.token),
    true
  )
  const env = m.proxyEnv(runtime.base)
  const fetchVia = (url) =>
    inSession(
      `export http_proxy=${env.http_proxy} no_proxy=${env.no_proxy}; ` +
        `wget -q -T 8 -O /dev/null ${url} && echo fetched`
    )
  assert.equal(await retry(() => fetchVia('http://example.com')), 'fetched')
  ok('a scope written on the host reaches the proxy, and egress flows through it')

  await m.proxies.pushScope(SESSION, scope({ allow: ['registry.npmjs.org'] }))
  assert.equal(
    await retry(() => (fetchVia('http://example.com') === null ? 'refused' : null)),
    'refused',
    'an allow-list edit takes effect on the running proxy — no restart, no new token'
  )
  ok('a policy edit reaches a live proxy through the bind-mounted directory')

  // --- 3b. reuse -----------------------------------------------------------
  // The same call a resume makes — and the same one a *restarted app* makes,
  // since reuse is decided from the daemon and the scope file, never from
  // in-process state.
  const reused = await proxiesEnsure({ internal: false })
  assert.equal(reused.containerId, runtime.containerId, 'a healthy proxy is reused, not replaced')
  assert.equal(reused.token, runtime.token, 'and keeps the token the agent already holds')
  assert.deepEqual(
    (await m.containerNetworks(reused.containerId)).sort(),
    [m.EGRESS_NETWORK, NET].sort(),
    'its endpoints are converged, not re-added'
  )
  ok('ensuring again reuses the proxy and recovers its token from the scope file')

  // A second container carrying this session's proxy label — the shape a crash
  // between `docker run` and the record write leaves behind. Two proxies on one
  // network both answer to `gurt-proxy`, and which one the agent reaches is a
  // coin toss, so the ensure must take the impostor down.
  const impostor = docker(
    'run', '-d', '--label', `gurt.proxy=${SESSION}`, 'alpine', 'sleep', '600'
  )
  const after = await proxiesEnsure({ internal: false })
  assert.equal(after.containerId, runtime.containerId)
  assert.equal(
    (await m.dockerProxyContainers(SESSION)).get(SESSION).length,
    1,
    'exactly one proxy carries the session label'
  )
  assert.ok(!(await m.dockerProxyContainers(SESSION)).get(SESSION).includes(impostor))
  ok('a second container carrying the proxy label is removed, never adopted')

  // --- 4. stop / start -----------------------------------------------------
  docker('stop', FAKE_CONTAINER)
  assert.deepEqual(await m.containerNetworks(FAKE_CONTAINER), [NET], 'endpoints survive a stop')
  docker('start', FAKE_CONTAINER)
  assert.deepEqual(await m.containerNetworks(FAKE_CONTAINER), [NET])
  ok('network endpoints survive the container stop/start a resume is made of')

  // --- 5. internal ---------------------------------------------------------
  await m.proxies.pushScope(SESSION, scope({ allow: [] }))
  const internal = await proxiesEnsure({ internal: true })
  assert.equal(
    docker('network', 'inspect', '-f', '{{.Internal}}', NET),
    'true',
    'the network was recreated with no route out'
  )
  await m.convergeContainerNetworks(FAKE_CONTAINER, [NET], log)
  assert.deepEqual(await m.containerNetworks(FAKE_CONTAINER), [NET])
  assert.deepEqual(
    (await m.containerNetworks(internal.containerId)).sort(),
    [m.EGRESS_NETWORK, NET].sort(),
    'the proxy is back on both, so it is still the way out'
  )
  assert.equal(
    inSession('wget -q -T 5 -O /dev/null http://example.com && echo fetched'),
    null,
    'direct egress is gone: the daemon installs no route for an internal network'
  )
  assert.equal(await retry(() => fetchVia('http://example.com')), 'fetched',
    'and the proxy is the one thing that still reaches the internet')
  ok('internal mode: no direct egress, proxy still the only way out')

  // --- 6. teardown ---------------------------------------------------------
  docker('rm', '-f', FAKE_CONTAINER)
  await m.proxies.remove(SESSION, log)
  assert.deepEqual((await m.dockerProxyContainers(SESSION)).get(SESSION), undefined)
  assert.deepEqual((await m.dockerSessionNetworks(SESSION)).get(SESSION), undefined)
  assert.equal(fs.existsSync(m.proxyConfigMount(SESSION)), false)
  ok('teardown leaves no proxy container, no network and no scope on disk')
}

/** `proxies.ensure`, with the log prefixed so the transcript reads. */
const proxiesEnsure = (settings) => m.proxies.ensure(SESSION, settings, log)

/** The proxy polls its config once a second and SIGHUP only nudges it; a
 *  network path also takes what it takes. Retry rather than sleep blindly. */
async function retry(fn, attempts = 15) {
  let last = null
  for (let i = 0; i < attempts; i++) {
    last = await fn()
    if (last !== null) return last
    await new Promise((r) => setTimeout(r, 500))
  }
  return last
}

let failure
try {
  await main()
} catch (e) {
  failure = e
} finally {
  // Best-effort: this is a smoke test, and a leaked container or network is
  // exactly the thing it exists to catch.
  try {
    docker('rm', '-f', FAKE_CONTAINER)
  } catch {
    // already gone
  }
  try {
    await m.proxies.remove(SESSION, () => {})
  } catch {
    // already gone
  }
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
}
if (failure) {
  console.error(`\nFAIL after ${step} step(s): ${failure.message}`)
  process.exit(1)
}
console.log(`\nPASS (${step} steps)`)
