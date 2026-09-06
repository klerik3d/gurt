// The network converge planner (docs/requirements-mcp-proxy.md §7.2) and the
// naming/label conventions the sweeps depend on.
//
// Why this file exists: nothing in provisioning may assume a fresh start. A
// session's container is reused across stop/start (`teardown('stop')` keeps it
// and its endpoints), the app can be killed between any two docker calls, and
// the daemon can be restarted underneath everything. So the network step is not
// "connect the container" — it is a converge: observe what the daemon has, diff
// it against what this phase wants, apply the delta. That planner is a pure
// function of (observed, desired), and this is where it is pinned:
//
//   - connect before disconnect, always: a container that is briefly on no
//     network at all has no route to anything, and on a live container that is
//     a dropped connection rather than a rewired one;
//   - a converged container plans nothing, so a resume costs no docker calls
//     and cannot flap a working session's interfaces;
//   - fresh (`bridge`), reused (`gurt-s-<id>`) and half-attached-after-a-crash
//     (both) all produce the plan that lands in the same place — that is the
//     whole claim of "reconcile, not assume".
//
// The planner half is pure node. The second half drives the applier against a
// stub `docker` on PATH, because the planner being right is not enough: a
// converge is only a guarantee if it *fails closed*, and the one query it plans
// against has three answers that must stay three (§7.2). Fold "the daemon did
// not answer" into "there is no such container" and the converge does nothing,
// says nothing, and leaves an internal session's container on the default
// bridge with the agent about to start on it — the only failure in this file
// that fails open.
//
//   node scripts/network-converge.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const S = (rel) => JSON.stringify(path.join(ROOT, rel))
const outfile = path.join(os.tmpdir(), `gurt-network-converge-${process.pid}.mjs`)

// store.ts reads GURT_ROOT at module load — set it before the import.
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-network-'))
process.env.GURT_ROOT = GURT_ROOT

// --- a `docker` that can be made to fail in each distinguishable way ---------

const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-network-bin-'))
const STATE = path.join(BIN, 'daemon.json')
const CALLS = path.join(BIN, 'calls.log')
const FAKE = path.join(BIN, 'fake-docker.cjs')

/**
 * Only the calls this module makes, and only the failure modes that have to be
 * told apart:
 *
 *   - `gone`  — the daemon answered, and the answer is that the object does not
 *     exist. `Error: No such object: <id>` on stderr, exit 1, exactly as
 *     `docker inspect` reports it.
 *   - `down`  — nothing answered. The daemon's own wording for an unreachable
 *     socket, which shares neither vocabulary nor exit code convention with the
 *     above and must not be classified with it.
 *   - `flaky` — `down` for the first `flaky` inspects and fine afterwards: a
 *     daemon reload, which is the case retrying exists for.
 *
 * Every invocation is appended to CALLS, so "how many times did it ask" is an
 * assertion rather than an inference.
 */
fs.writeFileSync(
  FAKE,
  `'use strict'
const fs = require('fs')
const STATE = ${JSON.stringify(STATE)}
const CALLS = ${JSON.stringify(CALLS)}
const args = process.argv.slice(2)
fs.appendFileSync(CALLS, JSON.stringify(args) + '\\n')
const state = JSON.parse(fs.readFileSync(STATE, 'utf8'))
const save = () => fs.writeFileSync(STATE, JSON.stringify(state))
const last = args[args.length - 1]
const unreachable = () => {
  process.stderr.write(
    'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\\n'
  )
  process.exit(1)
}
if (args[0] === 'inspect') {
  if (state.flaky > 0) {
    state.flaky--
    save()
    unreachable()
  }
  if (state.mode === 'down') unreachable()
  if (state.mode === 'gone') {
    process.stderr.write('Error: No such object: ' + last + '\\n')
    process.exit(1)
  }
  process.stdout.write((state.networks || []).join(' ') + ' \\n')
  process.exit(0)
}
if (args[0] === 'network' && (args[1] === 'connect' || args[1] === 'disconnect')) {
  if (state.mode === 'down') unreachable()
  const name = args[args.length - 2]
  state.networks =
    args[1] === 'connect'
      ? (state.networks || []).concat(name)
      : (state.networks || []).filter((n) => n !== name)
  save()
  process.exit(0)
}
process.exit(0)
`
)
fs.writeFileSync(
  path.join(BIN, 'docker'),
  `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`,
  { mode: 0o755 }
)
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`

/** Reset the stub: what the container is attached to, and how docker misbehaves. */
function daemon(networks, { mode = 'ok', flaky = 0 } = {}) {
  fs.writeFileSync(STATE, JSON.stringify({ networks, mode, flaky }))
  fs.writeFileSync(CALLS, '')
}
/** What the stub says the container is attached to now. */
const attached = () => JSON.parse(fs.readFileSync(STATE, 'utf8')).networks
/** Every `docker` invocation since the last `daemon()`, as argv arrays. */
const calls = () =>
  fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
/** Just the ones that would have changed something. */
const mutations = () => calls().filter((a) => a[0] === 'network').map((a) => a.slice(1).join(' '))

await bundle({
  stdin: {
    contents: `
      export {
        planNetworkConverge, sessionNetworkName,
        containerNetworks, convergeContainerNetworks, assertContainerNetworks, isNoSuchObject,
        DEFAULT_BRIDGE, EGRESS_NETWORK, SESSION_LABEL, MANAGED_LABEL
      } from ${S('src/main/proxy/network.ts')}
      export { PROXY_LABEL, proxyContainerName, PROXY_IMAGE } from ${S('src/main/proxy/manager.ts')}
      export { proxyEnv, PROXY_ALIAS, PROXY_PORT, NO_PROXY_HOSTS } from ${S('src/shared/proxy.ts')}
    `,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})
const m = await import(pathToFileURL(outfile).href)

after(() => {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(BIN, { recursive: true, force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

const SESSION = 'a3f9'
const SESSION_NET = m.sessionNetworkName(SESSION)

test('the plan is the delta, and nothing else', () => {
  // Fresh out of `devcontainer up`: on the default bridge, wants its own network.
  assert.deepEqual(m.planNetworkConverge([m.DEFAULT_BRIDGE], [SESSION_NET]), {
    connect: [SESSION_NET],
    disconnect: [m.DEFAULT_BRIDGE]
  })
  // Provisioning the same container again: back to the open network, because
  // image builds and postCreate hooks need unrestricted egress (§7.3).
  assert.deepEqual(m.planNetworkConverge([SESSION_NET], [m.DEFAULT_BRIDGE]), {
    connect: [m.DEFAULT_BRIDGE],
    disconnect: [SESSION_NET]
  })
})

test('an already-converged container plans nothing at all', () => {
  // The resume path, and the one that must not cost docker calls: endpoints
  // survive a container's stop/start, so the common case is "already there".
  assert.deepEqual(m.planNetworkConverge([SESSION_NET], [SESSION_NET]), {
    connect: [],
    disconnect: []
  })
  assert.deepEqual(
    m.planNetworkConverge([m.EGRESS_NETWORK, SESSION_NET], [m.EGRESS_NETWORK, SESSION_NET]),
    { connect: [], disconnect: [] },
    "the proxy's two endpoints are as idempotent as the container's one"
  )
})

test('every starting state converges to the same desired state', () => {
  const desired = [SESSION_NET]
  const apply = (observed) => {
    const plan = m.planNetworkConverge(observed, desired)
    // What the caller does with the plan, in the caller's order.
    const after = [...observed]
    for (const n of plan.connect) after.push(n)
    for (const n of plan.disconnect) after.splice(after.indexOf(n), 1)
    return { plan, after }
  }
  for (const [what, observed] of [
    ['fresh from `up`', [m.DEFAULT_BRIDGE]],
    ['reused, already converged', [SESSION_NET]],
    ['half-attached after a crash', [m.DEFAULT_BRIDGE, SESSION_NET]],
    ['attached to nothing at all', []],
    ['left on a network nobody asked for', ['some-compose-network']]
  ]) {
    const { after } = apply(observed)
    assert.deepEqual(after, desired, `${what} converges to exactly the desired set`)
  }
})

test('connect is planned before disconnect, so nothing is ever off every network', () => {
  const plan = m.planNetworkConverge([m.DEFAULT_BRIDGE], [SESSION_NET])
  // The ordering guarantee is structural: the two lists are separate, and the
  // applier drains `connect` first. Assert the property the applier relies on —
  // that a network being both left and joined never appears in both lists.
  assert.equal(plan.connect.some((n) => plan.disconnect.includes(n)), false)
  // And that a container mid-plan is never on nothing: after the connects, the
  // observed set still holds everything the disconnects are about to take.
  const midway = [m.DEFAULT_BRIDGE, ...plan.connect]
  assert.ok(midway.length > plan.disconnect.length, 'something is always attached')
})

test('desired order is preserved, so a connect happens in the order asked for', () => {
  // The proxy is connected to its egress bridge first and the session network
  // second; the alias it answers to lives on the second one.
  assert.deepEqual(
    m.planNetworkConverge([], [m.EGRESS_NETWORK, SESSION_NET]).connect,
    [m.EGRESS_NETWORK, SESSION_NET]
  )
})

test('the names and labels the sweeps are built on', () => {
  assert.equal(SESSION_NET, `gurt-s-${SESSION}`)
  assert.equal(m.proxyContainerName(SESSION), `gurt-proxy-${SESSION}`)
  assert.equal(m.SESSION_LABEL, 'gurt.session')
  // Deliberately NOT gurt.session: `dockerSessionContainers()` builds
  // session → devcontainer from that label and treats every hit as a container
  // to stop, adopt or remove. A proxy carrying it would be swept as if it were
  // the session's own container (§4.1). Networks are a different namespace and
  // cannot collide, so they do carry gurt.session.
  assert.equal(m.PROXY_LABEL, 'gurt.proxy')
  assert.notEqual(m.PROXY_LABEL, m.SESSION_LABEL)
  assert.equal(m.MANAGED_LABEL, 'gurt.managed')
  assert.equal(m.EGRESS_NETWORK, 'gurt-egress')
  // Pinned by digest, not tag: a mutable tag would let a compromised release
  // flow straight into the process holding every session's credentials.
  assert.match(m.PROXY_IMAGE, /^node:22-alpine@sha256:[0-9a-f]{64}$/)
})

test('the agent gets both spellings of every proxy variable', () => {
  const env = m.proxyEnv()
  const base = `http://${m.PROXY_ALIAS}:${m.PROXY_PORT}`
  // curl and Node disagree about which spelling they read, so both are set.
  for (const [upper, lower] of [
    ['HTTP_PROXY', 'http_proxy'],
    ['HTTPS_PROXY', 'https_proxy']
  ]) {
    assert.equal(env[upper], base)
    assert.equal(env[lower], base)
  }
  assert.equal(env.NO_PROXY, env.no_proxy)
  // The proxy itself and the container's own loopback are never proxied — the
  // first would be a loop, the second would arrive at the *proxy's* loopback.
  assert.deepEqual(env.NO_PROXY.split(','), m.NO_PROXY_HOSTS)
  assert.ok(m.NO_PROXY_HOSTS.includes(m.PROXY_ALIAS))
  // No secret rides in here: the token is in the MCP descriptor URLs, not in
  // the environment the agent can dump.
  assert.equal(Object.keys(env).length, 6)
})

// ==========================================================================
// The applier: three answers to one query, and a converge that fails closed
// ==========================================================================

const CONTAINER = 'c0ffee0123456789'
const log = () => {}

test('a live container reports its endpoints, and an empty list is a real answer', async () => {
  daemon([m.DEFAULT_BRIDGE, SESSION_NET])
  assert.deepEqual(await m.containerNetworks(CONTAINER), [m.DEFAULT_BRIDGE, SESSION_NET])
  // Not null: a container genuinely on no network is a state the daemon can be
  // in, and it is not the same state as "there is no such container".
  daemon([])
  assert.deepEqual(await m.containerNetworks(CONTAINER), [])
  assert.equal(calls().length, 1, 'one answer costs one call — nothing is retried')
})

test('"no such object" is an answer: null, once, and no retry', async () => {
  daemon([], { mode: 'gone' })
  assert.equal(await m.containerNetworks(CONTAINER), null)
  assert.equal(
    calls().length,
    1,
    'the daemon told us the container is gone — asking again cannot change that'
  )
})

test('an inspect nobody answered throws — it never reads as "nothing to converge"', async () => {
  daemon([m.DEFAULT_BRIDGE], { mode: 'down' })
  await assert.rejects(
    () => m.containerNetworks(CONTAINER),
    /could not inspect container c0ffee012345/,
    'the failure has to reach the caller: this is the switch that has not happened yet'
  )
  assert.ok(calls().length > 1, 'and it was retried before being believed')
})

test('a daemon that is merely reloading is waited out, not failed on', async () => {
  // The case retrying exists for: `systemctl restart docker`, Docker Desktop
  // updating its VM, a laptop coming back from sleep. The switch still happens.
  daemon([m.DEFAULT_BRIDGE], { flaky: 2 })
  const plan = await m.convergeContainerNetworks(CONTAINER, [SESSION_NET], log)
  assert.deepEqual(plan, { connect: [SESSION_NET], disconnect: [m.DEFAULT_BRIDGE] })
  assert.deepEqual(attached(), [SESSION_NET], 'the container really did move')
})

test('a converge against an unreachable daemon rejects, and touches nothing', async () => {
  // The bug this file is here to prevent: the failed inspect used to be folded
  // into null, the caller read null as "nothing to do", and a fresh container —
  // born on the default bridge — stayed there while the agent was launched on
  // it. In internal mode that is the whole isolation guarantee, gone silently.
  daemon([m.DEFAULT_BRIDGE], { mode: 'down' })
  await assert.rejects(() => m.convergeContainerNetworks(CONTAINER, [SESSION_NET], log))
  assert.deepEqual(mutations(), [], 'nothing was rewired on a guess')
  assert.deepEqual(attached(), [m.DEFAULT_BRIDGE], 'and the container is where it was')
})

test('a converge against a container the daemon says is gone is a quiet no-op', async () => {
  // Unchanged behaviour, and deliberately so: a container that does not exist
  // is not one this can move, and there is nothing here to fail the start over.
  // `reconcile` drops the record for the same reason.
  daemon([], { mode: 'gone' })
  assert.equal(await m.convergeContainerNetworks(CONTAINER, [SESSION_NET], log), null)
  assert.deepEqual(mutations(), [])
})

test('the two failures are told apart by what docker said, not by that it failed', () => {
  for (const said of [
    'docker inspect failed (1): Error: No such object: c0ffee',
    'docker inspect failed (1): Error response from daemon: No such container: c0ffee'
  ])
    assert.equal(m.isNoSuchObject(new Error(said)), true, said)
  for (const said of [
    'docker inspect failed (1): Cannot connect to the Docker daemon at unix:///var/run/docker.sock.',
    'docker inspect timed out after 20000ms',
    'spawn docker ENOENT',
    'docker inspect failed (1): request returned Internal Server Error'
  ])
    assert.equal(m.isNoSuchObject(new Error(said)), false, said)
})

// --- the post-condition ----------------------------------------------------

test('the post-condition passes only on exactly the desired set', async () => {
  daemon([SESSION_NET])
  await m.assertContainerNetworks(CONTAINER, [SESSION_NET])

  // A leftover bridge endpoint IS the failure being checked for, so a superset
  // is as much a mismatch as a missing network.
  daemon([SESSION_NET, m.DEFAULT_BRIDGE])
  await assert.rejects(
    () => m.assertContainerNetworks(CONTAINER, [SESSION_NET]),
    /is on \[gurt-s-a3f9, bridge\], expected exactly \[gurt-s-a3f9\]/
  )

  // The shape of a converge that silently did nothing: still on the bridge only.
  daemon([m.DEFAULT_BRIDGE])
  await assert.rejects(
    () => m.assertContainerNetworks(CONTAINER, [SESSION_NET]),
    /is on \[bridge\], expected exactly \[gurt-s-a3f9\]/,
    'this is the assertion that turns a future converge bug into a startup error'
  )

  daemon([])
  await assert.rejects(
    () => m.assertContainerNetworks(CONTAINER, [SESSION_NET]),
    /is on \[no network\]/
  )
})

test('the post-condition is as loud about a query it could not make', async () => {
  daemon([SESSION_NET], { mode: 'down' })
  await assert.rejects(
    () => m.assertContainerNetworks(CONTAINER, [SESSION_NET]),
    /could not inspect container/
  )
  // And a container that vanished between the switch and the check is not a
  // pass either — nothing here may confirm isolation it did not observe.
  daemon([], { mode: 'gone' })
  await assert.rejects(
    () => m.assertContainerNetworks(CONTAINER, [SESSION_NET]),
    /no longer exists/
  )
})
