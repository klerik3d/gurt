// ContainerManager teardown + boot reconcile, driven against a fake `docker`
// CLI that behaves like a small daemon (it keeps a container list, `rm` really
// removes from it, `stop` really flips it to not-running).
//
// Why this file exists: a container that outlives the session that owns it is
// invisible — it holds a mount, a clone and, if it is still running, an agent,
// and nothing in the UI ever mentions it again. That leak has already shipped
// once (fcc244a, "Fix container leak on session delete"), and every invariant
// below is a way it could come back:
//
//   - the record is read BEFORE the first await, because `deleteSession` drops
//     the session synchronously right after starting the teardown (that is the
//     exact shape of fcc244a);
//   - removal is record-INDEPENDENT: `up` stamps the `gurt.session` label at
//     `docker run` but the id only reaches the record when `up` returns, so a
//     start that dies in between leaves a container only the daemon can name;
//   - `docker ps` failing means "we could not ask", never "there are none" —
//     reading the daemon's silence as an empty set drops the recorded id on
//     the floor (teardown) or deletes every container record (reconcile);
//   - short vs. full ids are the same container, and must be removed once;
//   - `detach` runs before any docker call — nothing derived from a container
//     may outlive it.
//
// The manager is constructed directly on its `ContainerManagerDeps` seam, so
// this is containers.ts itself and not the kernel around it
// (session-delete-container.test.mjs covers the kernel-level path).
//
// No wall-clock waits anywhere: every docker call the manager makes is awaited
// inside the call under test, so the recorded transcript is complete the moment
// that call resolves.
//
//   node scripts/containers-lifecycle.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

// store.ts / log.ts read GURT_ROOT / GURT_LOG at module load — set before import.
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-containers-'))
process.env.GURT_ROOT = GURT_ROOT
process.env.GURT_LOG = 'debug'

// --- the fake daemon --------------------------------------------------------

const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-containers-bin-'))
const STATE = path.join(BIN, 'daemon.json')
const CALLS = path.join(BIN, 'calls.log')
const FAKE = path.join(BIN, 'fake-docker.cjs')

/**
 * A `docker` that answers the subcommands provision.ts and proxy/* use, off a
 * JSON file this test owns. Three behaviours matter beyond bookkeeping:
 *   - `ps` honours `psExit`, so "the daemon is unreachable" is expressible
 *     (provision.ts turns a non-zero `ps` into `null`, which is emphatically
 *     not the empty list);
 *   - ids match by PREFIX, the way the real `docker ps` (short) and the
 *     devcontainer CLI (full) name the same container;
 *   - session containers (`gurt.session`), proxies (`gurt.proxy`) and networks
 *     are three separate registries, because that separation is the point of
 *     giving the proxy its own label: a query for one must never answer with
 *     the other (docs/requirements-mcp-proxy.md §4.1).
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
state.proxies = state.proxies || []
state.networks = state.networks || []
const save = () => fs.writeFileSync(STATE, JSON.stringify(state))
const same = (a, b) => a.startsWith(b) || b.startsWith(a)
const last = args[args.length - 1]
const flag = (name) => {
  const i = args.indexOf(name)
  return i < 0 ? '' : args[i + 1]
}
/** Which registry a \`--filter label=<key>[=<value>]\` names, and whose. */
const filtered = () => {
  const label = flag('--filter').slice('label='.length)
  const [key, owner] = label.split('=')
  return { key, owner: owner || null }
}
const anyContainer = (id) =>
  state.containers.find((c) => same(c.id, id)) || state.proxies.find((c) => same(c.id, id))
if (args[0] === 'ps') {
  if (state.psExit) process.exit(state.psExit)
  const { key, owner } = filtered()
  const rows = key === 'gurt.proxy' ? state.proxies : key === 'gurt.session' ? state.containers : []
  // The label is printed only when the caller's --format asked for it; the
  // per-session container query asks for the bare id.
  const withLabel = args.join(' ').includes('{{.Label')
  for (const c of rows)
    if (owner === null || c.session === owner)
      process.stdout.write((withLabel ? c.session + ' ' : '') + c.id + '\\n')
  process.exit(0)
}
if (args[0] === 'inspect') {
  const format = flag('-f')
  const c = anyContainer(last)
  if (!c) process.exit(1)
  if (format.includes('NetworkSettings.Networks')) {
    process.stdout.write((c.networks || []).join(' ') + '\\n')
  } else if (format.includes('Config.Image')) {
    const mounts = Object.entries(c.mounts || {}).map(([d, s]) => d + '=' + s).join(';')
    process.stdout.write((c.running ? 'true' : 'false') + '\\t' + (c.image || '') + '\\t' + mounts + '\\n')
  } else {
    process.stdout.write((c.running ? 'true' : 'false') + '\\n')
  }
  process.exit(0)
}
if (args[0] === 'rm') {
  state.containers = state.containers.filter((c) => !same(c.id, last))
  state.proxies = state.proxies.filter((c) => !same(c.id, last))
  // A removed container takes its endpoints with it, exactly like the daemon.
  for (const n of state.networks) n.endpoints = (n.endpoints || []).filter((id) => !same(id, last))
  save()
  process.exit(0)
}
if (args[0] === 'stop' || args[0] === 'kill') {
  const c = anyContainer(last)
  // SIGHUP is a reload, not a stop — the proxy stays up.
  if (c && args[0] === 'stop') c.running = false
  save()
  process.exit(0)
}
if (args[0] === 'network') {
  const name = last
  const net = state.networks.find((n) => n.name === name)
  if (args[1] === 'ls') {
    if (state.psExit) process.exit(state.psExit)
    const { owner } = filtered()
    for (const n of state.networks)
      if (owner === null || n.session === owner)
        process.stdout.write((n.session || '') + ' ' + n.name + '\\n')
    process.exit(0)
  }
  if (args[1] === 'inspect') {
    if (!net) process.exit(1)
    const format = flag('-f')
    if (format.includes('.Containers')) process.stdout.write((net.endpoints || []).join(' ') + '\\n')
    else process.stdout.write((net.internal ? 'true' : 'false') + '\\n')
    process.exit(0)
  }
  if (args[1] === 'create') {
    if (net) process.exit(1)
    const label = flag('--label').split('=')
    state.networks.push({
      name,
      session: label[0] === 'gurt.session' ? label[1] : null,
      internal: args.includes('--internal'),
      endpoints: []
    })
    save()
    process.exit(0)
  }
  if (args[1] === 'rm') {
    if (!net) process.exit(1)
    // The real daemon refuses a network that still has endpoints — the reason
    // teardown disconnects first.
    if ((net.endpoints || []).length) {
      process.stderr.write('error while removing network: has active endpoints\\n')
      process.exit(1)
    }
    state.networks = state.networks.filter((n) => n.name !== name)
    save()
    process.exit(0)
  }
  if (args[1] === 'connect' || args[1] === 'disconnect') {
    const container = anyContainer(last)
    const netName = args[args.length - 2]
    const target = state.networks.find((n) => n.name === netName)
    if (!target) process.exit(1)
    if (args[1] === 'connect' && !container) process.exit(1)
    target.endpoints = target.endpoints || []
    if (args[1] === 'connect') {
      container.networks = (container.networks || []).concat(netName)
      target.endpoints.push(container.id)
    } else {
      // --force disconnects an endpoint whose container the daemon can no
      // longer talk to: exactly the endpoint that blocks a network rm.
      if (container) container.networks = (container.networks || []).filter((n) => n !== netName)
      target.endpoints = target.endpoints.filter((id) => !same(id, last))
    }
    save()
    process.exit(0)
  }
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

/** Replace the fake daemon's world; also resets the call transcript. */
function daemon(containers, { psExit = 0, proxies = [], networks = [] } = {}) {
  fs.writeFileSync(STATE, JSON.stringify({ containers, proxies, networks, psExit }))
  fs.writeFileSync(CALLS, '')
}
/** Containers the fake daemon still has. */
const alive = () => JSON.parse(fs.readFileSync(STATE, 'utf8')).containers
/** Proxy containers it still has. */
const proxiesAlive = () => JSON.parse(fs.readFileSync(STATE, 'utf8')).proxies
/** Networks it still has. */
const networksAlive = () => JSON.parse(fs.readFileSync(STATE, 'utf8')).networks
/** Every `docker` invocation since the last `daemon()`, as argv arrays. */
const calls = () =>
  fs
    .readFileSync(CALLS, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
/** Just the mutating calls on *containers* — `ps`/`inspect` are queries and say
 *  nothing, and the network calls have their own view below. */
const mutations = () =>
  calls().filter((a) => a[0] === 'rm' || (a[0] === 'stop' && a[0] !== 'network'))
/** Mutating network calls, as `<verb> <args…>` strings. */
const networkCalls = () =>
  calls()
    .filter((a) => a[0] === 'network' && a[1] !== 'ls' && a[1] !== 'inspect')
    .map((a) => a.slice(1).join(' '))

// --- the module under test --------------------------------------------------

const outfile = path.join(os.tmpdir(), `gurt-containers-${process.pid}.mjs`)
await bundle({
  stdin: {
    contents: `
      export { ContainerManager } from ${S('src/main/containers.ts')}
      export { createBus } from ${S('src/main/bus.ts')}
      export { flushSync } from ${S('src/main/log.ts')}
    `,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})
const m = await import(pathToFileURL(outfile).href)

// --- the session-manager seam, faked ---------------------------------------

/** Session records, exactly the slice of SessionInfo the manager reads. */
const sessions = new Map()
/** `detach` calls, each stamped with how many docker calls had happened by then
 *  — that stamp is how the "detach first" ordering is asserted without clocks. */
let detaches = []
/** `patchContainer(id, undefined)` calls, in order. */
let cleared = []
let idle = new Set()

const bus = m.createBus()
const events = []
for (const type of ['container.status', 'tree.changed', 'provision.log'])
  bus.on(type, (p) => events.push({ type, p }))

const manager = new m.ContainerManager({
  bus,
  session: (id) => sessions.get(id),
  sessions: () => [...sessions.values()],
  patchContainer: (id, patch) => {
    const info = sessions.get(id)
    // A patch for a session that is already gone is a no-op, as in the kernel.
    if (!info) return
    if (patch) info.container = patch
    else {
      delete info.container
      cleared.push(id)
    }
  },
  isSessionIdle: (id) => idle.has(id),
  detach: (id) => detaches.push({ id, dockerCallsBefore: calls().length })
})

/** Register a session (and optionally its container record). */
function session(id, container, extra = {}) {
  sessions.set(id, {
    id,
    workspace: 'ws',
    task: 'task',
    env: 'dev',
    repos: ['alpha'],
    title: id,
    state: 'idle',
    startPrompt: '',
    ...extra,
    ...(container ? { container } : {})
  })
  return sessions.get(id)
}

/** Reset every observation channel between scenarios. */
function scenario(containers, opts) {
  sessions.clear()
  detaches = []
  cleared = []
  idle = new Set()
  events.length = 0
  daemon(containers, opts)
}

after(() => {
  m.flushSync()
  fs.rmSync(outfile, { force: true })
  fs.rmSync(BIN, { recursive: true, force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

// ==========================================================================
// release(): the container does not survive its session
// ==========================================================================
test('release removes the container, clears the record, detaches first', async () => {
  scenario([{ id: 'c-alpha', session: 's1', running: true }])
  session('s1', { status: 'running', id: 'c-alpha', remoteWorkspaceFolder: '/w', repos: ['alpha'] })

  await manager.release('s1', 'session-deleted')

  assert.deepEqual(mutations(), [['rm', '-f', 'c-alpha']], 'the container is removed, once')
  assert.deepEqual(alive(), [], 'the daemon no longer has it')
  assert.deepEqual(cleared, ['s1'], 'the container record is cleared')
  assert.equal(sessions.get('s1').container, undefined)
  assert.deepEqual(
    detaches.map((d) => d.dockerCallsBefore),
    [0],
    'detach runs before the first docker call — nothing derived outlives the container'
  )
  assert.ok(
    events.some((e) => e.type === 'tree.changed'),
    'the tree is told'
  )
})

// --- and doing it again changes nothing ---
test('teardown is idempotent, and harmless on an unknown session', async () => {
  const before = calls().length
  await manager.release('s1', 'session-deleted')
  await manager.release('s1', 'session-deleted')
  assert.deepEqual(mutations(), [['rm', '-f', 'c-alpha']], 'a repeat teardown removes nothing new')
  assert.ok(calls().length > before, 'it still asks the daemon (and finds nothing)')
  assert.deepEqual(alive(), [])
  // A teardown of a session that never existed at all is equally quiet.
  await manager.release('never-existed', 'session-deleted')
  assert.deepEqual(mutations(), [['rm', '-f', 'c-alpha']])
})

// ==========================================================================
// The record is not the registry
// ==========================================================================
test('teardown sweeps by label, not by record', async () => {
  // A start that died between `docker run` (which stamped the label) and `up`
  // returning (which would have recorded the id): the session's record names no
  // container at all, and only the daemon knows this one exists.
  scenario([{ id: 'c-unrecorded', session: 's2', running: true }])
  session('s2', { status: 'error', repos: ['alpha'], error: 'post-create hook failed' })
  await manager.release('s2', 'session-deleted')
  assert.deepEqual(
    mutations(),
    [['rm', '-f', 'c-unrecorded']],
    'a container the record never named is still removed'
  )
  assert.deepEqual(alive(), [])

  // Both at once, and a third session's container that must not be touched.
  scenario([
    { id: 'c-recorded', session: 's3', running: true },
    { id: 'c-leftover', session: 's3', running: false },
    { id: 'c-other', session: 's4', running: true }
  ])
  session('s3', { status: 'running', id: 'c-recorded', repos: ['alpha'] })
  session('s4', { status: 'running', id: 'c-other', repos: ['alpha'] })
  await manager.release('s3', 'session-deleted')
  assert.deepEqual(
    mutations().map((a) => a[2]).sort(),
    ['c-leftover', 'c-recorded'],
    'every container carrying the session label goes, recorded or not'
  )
  assert.deepEqual(alive(), [{ id: 'c-other', session: 's4', running: true }], "another session's container is untouched")
})

// --- short vs. full ids are one container, removed once ---
test('short and full container ids are not removed twice', async () => {
  const FULL = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
  scenario([{ id: FULL, session: 's5', running: true }])
  session('s5', { status: 'running', id: FULL.slice(0, 12), repos: ['alpha'] })
  await manager.release('s5', 'session-deleted')
  assert.equal(mutations().length, 1, 'the short record and the full sweep id are one container')
  assert.deepEqual(alive(), [])
})

// ==========================================================================
// `docker ps` failing is not "there are none"
// ==========================================================================
test('an unreachable daemon does not turn teardown into a no-op', async () => {
  scenario([{ id: 'c-blind', session: 's6', running: true }], { psExit: 1 })
  session('s6', { status: 'running', id: 'c-blind', repos: ['alpha'] })
  await manager.release('s6', 'session-deleted')
  assert.deepEqual(
    mutations(),
    // The proxy has no record to fall back to, so a blind teardown falls back
    // to the name it would have given it — same principle as the recorded id:
    // remove what we can name rather than read silence as "there is nothing".
    [['rm', '-f', 'c-blind'], ['rm', '-f', 'gurt-proxy-s6']],
    'an unreachable daemon falls back to the recorded id instead of removing nothing'
  )
  assert.deepEqual(cleared, ['s6'], 'the record is cleared either way')
})

// ==========================================================================
// The fcc244a shape: the session record vanishes mid-teardown
// ==========================================================================
//
// `deleteSession` calls the teardown and drops the session record
// synchronously right after — so anything the teardown reads after its first
// await is already gone. With `docker ps` also blind, the recorded id read
// before that await is the ONLY thing that can name the container: if
// containers.ts ever reads it later instead, this leaks.
test('a session dropped mid-teardown does not leak its container', async () => {
  scenario([{ id: 'c-race', session: 's7', running: true }], { psExit: 1 })
  session('s7', { status: 'running', id: 'c-race', repos: ['alpha'] })
  const inflight = manager.release('s7', 'session-deleted')
  sessions.delete('s7') // exactly what deleteSession does next
  await inflight
  assert.deepEqual(
    mutations(),
    [['rm', '-f', 'c-race'], ['rm', '-f', 'gurt-proxy-s7']],
    'a session deleted mid-teardown still takes its container with it'
  )
  assert.deepEqual(alive(), [])


  // The same race with the daemon reachable: the label sweep covers it.
  scenario([{ id: 'c-race2', session: 's8', running: true }])
  session('s8', { status: 'running', id: 'c-race2', repos: ['alpha'] })
  const inflight2 = manager.release('s8', 'session-deleted')
  sessions.delete('s8')
  await inflight2
  assert.deepEqual(alive(), [], 'the label sweep catches it too')
})

// ==========================================================================
// stop(): the container survives, the session can resume into it
// ==========================================================================
test('stop keeps the container and its record, and announces the transition', async () => {
  scenario([{ id: 'c-keep', session: 's9', running: true }])
  session('s9', { status: 'running', id: 'c-keep', remoteWorkspaceFolder: '/w', repos: ['alpha'], error: 'stale' })
  await manager.stop('s9', 'idle')
  assert.deepEqual(mutations(), [['stop', 'c-keep']], 'stop stops, and never removes')
  assert.deepEqual(alive(), [{ id: 'c-keep', session: 's9', running: false }], 'the container is kept')
  const rec = sessions.get('s9').container
  assert.equal(rec.status, 'stopped')
  assert.equal(rec.id, 'c-keep', 'the record still names it, so the next start resumes into it')
  assert.equal(rec.remoteWorkspaceFolder, '/w')
  assert.equal(rec.error, undefined, 'a stale error is cleared by the transition')
  assert.deepEqual(cleared, [], 'stop does not clear the record')
  assert.deepEqual(
    detaches.map((d) => d.dockerCallsBefore),
    [0],
    'stop detaches before stopping, too'
  )
  const statusEvent = events.find((e) => e.type === 'container.status')
  assert.ok(statusEvent, 'the status change is announced')
  assert.equal(statusEvent.p.status, 'stopped')
  assert.equal(statusEvent.p.reason, 'idle')
  assert.deepEqual(statusEvent.p.ref, { workspace: 'ws', task: 'task', env: 'dev' })
  assert.equal(manager.status('s9'), 'stopped')
  assert.equal(manager.status('no-such-session'), 'stopped', 'an unknown session reads as stopped')
  assert.equal(manager.container('no-such-session'), undefined)
})

test('a session with no container id still takes its proxy down', async () => {
  scenario([])
  session('s10', { status: 'error', repos: ['alpha'], error: 'never came up' })
  await manager.stop('s10', 'user')
  // The record naming no container does not mean nothing is running: a start
  // that died after the proxy came up and before `up` returned leaves one
  // findable only by its label. So the proxy sweep runs regardless — and finds
  // nothing here, which is why it stops and removes nothing.
  assert.deepEqual(mutations(), [], 'it stops nothing')
  assert.deepEqual(networkCalls(), [], 'and keeps the network, as every stop does')
  assert.ok(
    calls().some((a) => a[0] === 'ps' && a.join(' ').includes('label=gurt.proxy=s10')),
    'it does ask the daemon whether this session has a proxy'
  )
  assert.equal(sessions.get('s10').container.status, 'error', 'and does not clobber its status')
})

// ==========================================================================
// Task / workspace teardown
// ==========================================================================
test('task and workspace teardown cover exactly their own sessions', async () => {
  scenario([
    { id: 'c-t1', session: 'a1', running: true },
    { id: 'c-t2', session: 'a2', running: true },
    { id: 'c-t3', session: 'b1', running: true },
    { id: 'c-t4', session: 'z1', running: true }
  ])
  session('a1', { status: 'running', id: 'c-t1', repos: ['alpha'] }, { task: 'task-a' })
  session('a2', { status: 'running', id: 'c-t2', repos: ['alpha'] }, { task: 'task-a' })
  session('b1', { status: 'running', id: 'c-t3', repos: ['alpha'] }, { task: 'task-b' })
  session('z1', { status: 'running', id: 'c-t4', repos: ['alpha'] }, { workspace: 'other', task: 'task-a' })
  await manager.teardownTask('ws', 'task-a')
  assert.deepEqual(
    alive().map((c) => c.id).sort(),
    ['c-t3', 'c-t4'],
    'a task teardown takes every session of that task, and only that task'
  )
  assert.deepEqual(cleared.sort(), ['a1', 'a2'])
  assert.deepEqual(
    events.filter((e) => e.type === 'container.status').map((e) => e.p.reason),
    [],
    'a removal announces no status — the record is gone, not changed'
  )

  await manager.teardownWorkspace('ws')
  assert.deepEqual(alive().map((c) => c.id), ['c-t4'], 'the other workspace is untouched')

  // stopTask only touches containers that are not already stopped.
  scenario([
    { id: 'c-s1', session: 'r1', running: true },
    { id: 'c-s2', session: 'r2', running: false }
  ])
  session('r1', { status: 'running', id: 'c-s1', repos: ['alpha'] }, { task: 'task-a' })
  session('r2', { status: 'stopped', id: 'c-s2', repos: ['alpha'] }, { task: 'task-a' })
  session('r3', undefined, { task: 'task-a' })
  await manager.stopTask('ws', 'task-a')
  assert.deepEqual(mutations(), [['stop', 'c-s1']], 'an already-stopped container is left alone')
  assert.deepEqual(alive().length, 2, 'stopTask removes nothing')
})

// ==========================================================================
// The proxy and the session network go with the session
// ==========================================================================
//
// Same leak, one namespace over. A proxy that outlives its session holds that
// session's resolved MCP credentials in its heap and answers a token the agent
// may still have; a network that outlives it holds a subnet out of a pool that
// runs dry at ~16-31 entries (docs/requirements-mcp-proxy.md §6.1). Both are
// found the way containers are — by label, from the daemon, never from a record.

/** Where a session's scope file lives on the host. */
const scopeFile = (id) => path.join(GURT_ROOT, 'proxy', id, 'proxy.json')
/** Write one, as `pushProxyScope` would. */
function scope(id) {
  fs.mkdirSync(path.dirname(scopeFile(id)), { recursive: true })
  fs.writeFileSync(scopeFile(id), JSON.stringify({ version: 1, session: id, token: 't', mcp: {} }))
}

test('release takes the proxy and the network with the container', async () => {
  scenario([{ id: 'c-p1', session: 'p1', running: true }], {
    proxies: [{ id: 'proxy-p1', session: 'p1', running: true, networks: ['gurt-egress', 'gurt-s-p1'] }],
    networks: [
      { name: 'gurt-s-p1', session: 'p1', endpoints: ['c-p1', 'proxy-p1'] },
      { name: 'gurt-s-other', session: 'p2', endpoints: [] }
    ]
  })
  session('p1', { status: 'running', id: 'c-p1', repos: ['alpha'] })
  scope('p1')

  await manager.release('p1', 'session-deleted')

  assert.deepEqual(alive(), [], 'the container is gone')
  assert.deepEqual(proxiesAlive(), [], 'and so is its proxy')
  assert.deepEqual(
    networksAlive().map((n) => n.name),
    ['gurt-s-other'],
    "the session's network is removed; another session's is untouched"
  )
  // Ordering is the whole trick: a network with live endpoints refuses to be
  // removed, so everything on it goes (or is disconnected) first.
  const order = calls().filter(
    (a) => (a[0] === 'rm' && a[1] === '-f') || (a[0] === 'network' && a[1] === 'rm')
  )
  assert.deepEqual(order.map((a) => a[a.length - 1]), ['c-p1', 'proxy-p1', 'gurt-s-p1'])
  assert.equal(fs.existsSync(scopeFile('p1')), false, 'the scope is revoked with it')
  assert.equal(
    fs.existsSync(path.dirname(scopeFile('p1'))),
    false,
    'and its directory, which was the proxy bind-mount source, is retired too'
  )
})

test('an endpoint left on the network is disconnected before the rm', async () => {
  // The container a failed start left behind: nothing recorded it, the label
  // sweep above removes it — but a daemon that still holds *some* endpoint is
  // the normal case here, and `network rm` fails flat if one is left.
  scenario([], {
    networks: [{ name: 'gurt-s-p3', session: 'p3', endpoints: ['c-stranded'] }]
  })
  session('p3', { status: 'error', repos: ['alpha'] })
  await manager.release('p3', 'session-deleted')
  assert.deepEqual(networksAlive(), [], 'the network is gone despite the stranded endpoint')
  assert.deepEqual(
    networkCalls(),
    ['disconnect --force gurt-s-p3 c-stranded', 'rm gurt-s-p3'],
    'disconnect first, then remove'
  )
})

test('stop revokes the scope and stops the proxy, but keeps the network', async () => {
  scenario([{ id: 'c-p4', session: 'p4', running: true }], {
    proxies: [{ id: 'proxy-p4', session: 'p4', running: true }],
    networks: [{ name: 'gurt-s-p4', session: 'p4', endpoints: ['c-p4', 'proxy-p4'] }]
  })
  session('p4', { status: 'running', id: 'c-p4', repos: ['alpha'] })
  scope('p4')

  await manager.stop('p4', 'idle')

  assert.deepEqual(
    mutations(),
    [['stop', 'proxy-p4'], ['stop', 'c-p4']],
    'both containers stop; neither is removed'
  )
  assert.deepEqual(networkCalls(), [], 'the network is kept — endpoints survive a stop/start')
  assert.deepEqual(
    networksAlive()[0].endpoints,
    ['c-p4', 'proxy-p4'],
    'so the resume converges onto the same endpoints instead of rebuilding them'
  )
  assert.equal(fs.existsSync(scopeFile('p4')), false, 'the scope is revoked: an idle proxy has none')
  assert.equal(sessions.get('p4').container.status, 'stopped')
})

// ==========================================================================
// Boot reconcile: the daemon is the registry
// ==========================================================================
test('reconcile corrects records and reaps orphans', async () => {
  scenario(
    [
      { id: 'c-ok', session: 'k1', running: true },
      { id: 'c-exited', session: 'k2', running: false },
      { id: 'c-renamed', session: 'k3', running: true },
      { id: 'c-orphan', session: 'k-deleted-while-down', running: true }
    ],
    {
      proxies: [
        { id: 'proxy-k1', session: 'k1', running: true },
        { id: 'proxy-gone', session: 'k-deleted-while-down', running: true }
      ],
      networks: [
        { name: 'gurt-s-k1', session: 'k1', endpoints: ['c-ok'] },
        { name: 'gurt-s-k-deleted-while-down', session: 'k-deleted-while-down', endpoints: [] }
      ]
    }
  )
  session('k1', { status: 'running', id: 'c-ok', remoteWorkspaceFolder: '/w', repos: ['alpha'] })
  session('k2', { status: 'running', id: 'c-exited', repos: ['alpha'] })
  session('k3', { status: 'running', id: 'c-was-something-else', repos: ['alpha'] })
  session('k4', { status: 'running', id: 'c-gone', repos: ['alpha'] })
  session('k5', undefined)

  await manager.reconcile()

  assert.equal(sessions.get('k1').container.status, 'running', 'an accurate record is left alone')
  assert.equal(sessions.get('k2').container.status, 'stopped', 'a Docker restart is reflected')
  assert.equal(sessions.get('k3').container.id, 'c-renamed', 'a recreated container is re-pointed')
  assert.equal(sessions.get('k3').container.status, 'running')
  assert.equal(sessions.get('k4').container, undefined, 'a record naming nothing is dropped')
  assert.deepEqual(cleared, ['k4'], 'and only that one')
  assert.equal(sessions.get('k5').container, undefined, 'a session with no container stays that way')
  assert.deepEqual(
    mutations(),
    [['rm', '-f', 'c-orphan'], ['rm', '-f', 'proxy-gone']],
    'a container whose session is gone is reaped, with its proxy, and nothing else is'
  )
  assert.deepEqual(
    alive().map((c) => c.id).sort(),
    ['c-exited', 'c-ok', 'c-renamed'],
    'live containers of live sessions survive the reconcile'
  )
  assert.deepEqual(detaches, [], 'reconcile detaches nothing — it did not tear a session down')

  // The proxy and the network of a session that was deleted while the app was
  // down are orphans in exactly the same sense, and are swept the same way.
  assert.deepEqual(
    proxiesAlive().map((p) => p.id),
    ['proxy-k1'],
    "a live session's proxy survives; a deleted session's does not"
  )
  assert.deepEqual(
    networksAlive().map((n) => n.name),
    ['gurt-s-k1'],
    'same for the networks'
  )


  // An orphan is not logged into a session log file it would never own again.
  assert.ok(
    !fs.existsSync(path.join(GURT_ROOT, 'logs', 'session-k-deleted-while-down.log')),
    'reaping an orphan does not create a log file for a session that no longer exists'
  )
})

// --- the unreachable daemon: leave every record alone ---
test('reconcile skips entirely when docker is unreachable', async () => {
  scenario([{ id: 'c-safe', session: 'u1', running: true }], { psExit: 1 })
  session('u1', { status: 'running', id: 'c-safe', repos: ['alpha'] })
  session('u2', { status: 'running', id: 'c-also-safe', repos: ['alpha'] })
  await manager.reconcile()
  assert.deepEqual(cleared, [], 'a silent daemon does not wipe every container record')
  assert.deepEqual(proxiesAlive(), [], 'nothing was swept, because nothing could be asked')
  assert.equal(sessions.get('u1').container.id, 'c-safe')
  assert.equal(sessions.get('u2').container.id, 'c-also-safe')
  assert.deepEqual(mutations(), [], 'and removes nothing')
})

// ==========================================================================
// openVscode gates on a running container
// ==========================================================================
test('openVscode refuses anything but a fully-up container', () => {
  scenario([])
  session('v1', { status: 'stopped', id: 'c-v', remoteWorkspaceFolder: '/w', repos: ['alpha'] })
  session('v2', { status: 'running', repos: ['alpha'] })
  session('v3', { status: 'running', id: 'c-v3', repos: ['alpha'] })
  for (const [what, id] of [
    ['a stopped container', 'v1'],
    ['a container with no id', 'v2'],
    ['a container with no workspace folder', 'v3'],
    ['an unknown session', 'v4']
  ])
    assert.throws(() => manager.openVscode(id), /container is not running/, `${what} is refused`)
  assert.deepEqual(calls(), [], 'and nothing was spawned')
})
