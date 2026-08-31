// The per-session network mode, from the composer's pick to the session record
// (docs/requirements-mcp-proxy.md §6.2): what is stored, what survives a
// restart, and what the boundary refuses to store at all.
//
// Three properties, in the order they matter:
//
//   1. The mode and its allow list are the session's record — persisted
//      verbatim next to the MCP selection and restored as chosen. The lifecycle
//      reads them at every start (`ensureProxy` → `proxies.ensure`), so a
//      forgotten flag is a session running with egress the user thought they
//      had closed.
//   2. The boundary sanitizes. `network` arrives from a renderer form or (via a
//      drafted session) an agent, and it decides how a container is wired: an
//      unreadable policy has to read as "no policy chosen" — an empty allow
//      list, i.e. rule 1 — never reach the scope file malformed, and never fail
//      the session outright. It is also where a session stored under the old
//      three-mode policy is migrated (§6.3).
//   3. Copies are copies. A duplicate and an agent-drafted session inherit the
//      spawner's setting, and none of the three shares a domain array with the
//      others — editing one allow list must not silently edit another session's.
//   4. `internal: true` is enforced, not merely recorded. The switch onto the
//      session network is what makes the flag mean anything — a container is
//      born on the default bridge and provisioning deliberately leaves it there
//      until step 5 (§7.1, §7.3) — so a switch that does not happen is a session
//      running with the egress the record says it does not have. Every way that
//      step can fail has to fail the *start*, and the one after the switch is a
//      re-inspection of what the daemon actually did.
//
// The first three need no docker: every session there stays a draft. The fourth
// drives `ContainerManager` against a stub `docker` on PATH, with the proxy half
// stubbed out — what is under test is the network switch and its post-condition,
// not the proxy container.
//
//   node scripts/session-network.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'
// The proxy is dependency-free ESM the container mounts as-is: the same file
// that decides these policies at runtime, imported here to check the host side
// agrees with it.
import * as proxy from '../resources/proxy/gurt-proxy.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

// store.ts reads GURT_ROOT at module load — set it before the import.
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-session-network-'))
process.env.GURT_ROOT = GURT_ROOT

const outfile = path.join(os.tmpdir(), `gurt-session-network-${process.pid}.mjs`)

await bundle({
  stdin: {
    contents: `
      export { createKernel } from ${S('src/main/kernel.ts')}
      export { ContainerManager } from ${S('src/main/containers.ts')}
      export { createBus } from ${S('src/main/bus.ts')}
      export { proxies } from ${S('src/main/proxy/manager.ts')}
      export { sanitizeSessionNetwork } from ${S('src/shared/types.ts')}
      export { sanitizeDomainPolicy, MAX_POLICY_DOMAINS } from ${S('src/shared/proxy.ts')}
      export { readSessions } from ${S('src/main/store.ts')}
    `,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  external: ['electron'],
  outfile
})

const m = await import(pathToFileURL(outfile).href)

const ws = 'w'
const task = 't'
const ref = { workspace: ws, task, env: 'dev' }

fs.mkdirSync(path.join(GURT_ROOT, ws, task), { recursive: true })
fs.writeFileSync(
  path.join(GURT_ROOT, ws, 'workspace.json'),
  JSON.stringify({
    repos: [{ name: 'alpha', url: 'https://github.com/o/alpha.git' }],
    envs: [{ name: 'dev', devcontainer: '{"image":"x"}', repo: 'alpha' }]
  })
)
fs.writeFileSync(path.join(GURT_ROOT, ws, task, 'task.json'), JSON.stringify({}))
fs.writeFileSync(path.join(GURT_ROOT, ws, 'agents.json'), JSON.stringify({}))

const kernel = m.createKernel()

after(() => {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

/** The persisted record of a session, straight off disk. */
const persisted = async (id) =>
  (await m.readSessions(ws, task)).find((r) => r.info.id === id)?.info

/**
 * Retry `check` until it holds, or give up after `deadlineMs` with whatever it
 * last threw. `sessions.json` is written on a 300ms debounce and the write
 * itself is async, so waiting a fixed 400ms is a race the moment the machine is
 * busy — which it always is here, `node --test` running every file at once.
 * Waiting for the assertion instead of for a number is the same test without
 * the flake.
 */
const eventually = async (check, deadlineMs = 5000) => {
  const until = Date.now() + deadlineMs
  for (;;) {
    try {
      return await check()
    } catch (e) {
      if (Date.now() >= until) throw e
      await new Promise((r) => setTimeout(r, 25))
    }
  }
}

/** A draft with the given network settings — the composer's create call. */
const mk = (network, prompt = 'do the thing', role = 'executor') =>
  // `undefined` in the skills slot: this fixture is about the network argument
  // that follows it (see `SessionManager.createSession`).
  kernel.sessions.createSession(ref, ['alpha'], 'a1', prompt, 'draft', [], true, {}, role, undefined, network)

let internal

// --- persistence ---------------------------------------------------------

test('an internal session records its mode and its policy', async () => {
  internal = mk({ internal: true, policy: { allow: ['registry.npmjs.org'] } })
  assert.deepEqual(internal.network, {
    internal: true,
    policy: { allow: ['registry.npmjs.org'] }
  })
  await eventually(async () =>
    assert.deepEqual((await persisted(internal.id)).network, {
      internal: true,
      policy: { allow: ['registry.npmjs.org'] }
    })
  )
})

test('the default mode is the absence of a record, not a synthesised one', async () => {
  // A session created before this setting existed and one created with the
  // default have to read identically everywhere downstream — `ensureProxy`
  // treats a missing record as `{}` and gets the open bridge either way.
  const open = mk(undefined, 'no network pick')
  assert.equal(open.network, undefined)
  // The record has to be *there* and have no network — an absent record would
  // satisfy a bare `.network === undefined` read by not existing yet.
  await eventually(async () => {
    const record = await persisted(open.id)
    assert.ok(record, 'the draft reached sessions.json')
    assert.equal(record.network, undefined)
  })
})

test('a restart restores the mode and the policy', async () => {
  const next = m.createKernel()
  await next.ready
  assert.deepEqual(next.sessions.sessionInfo(internal.id).network, {
    internal: true,
    policy: { allow: ['registry.npmjs.org'] }
  })
})

// --- editing a draft ------------------------------------------------------

test('editing a draft rewrites the mode, and the edit persists', async () => {
  await kernel.editDraft(internal.id, {
    network: { internal: true, policy: { allow: ['registry.npmjs.org', 'github.com'] } }
  })
  await eventually(async () =>
    assert.deepEqual((await persisted(internal.id)).network, {
      internal: true,
      policy: { allow: ['registry.npmjs.org', 'github.com'] }
    })
  )
})

test('a draft can be reopened to the default network', async () => {
  const s = mk({ internal: true })
  await kernel.editDraft(s.id, { network: { internal: false } })
  assert.deepEqual(kernel.sessions.sessionInfo(s.id).network, { internal: false })
})

// --- the boundary sanitizes ----------------------------------------------

test('an unreadable policy is read as "no policy chosen", not as an error', async () => {
  const s = mk({ internal: true, policy: 'open the internet' })
  assert.deepEqual(s.network, { internal: true, policy: { allow: [] } })

  // Same treatment on the edit path — both go through the kernel boundary.
  await kernel.editDraft(s.id, { network: { internal: true, policy: { allow: 7 } } })
  assert.deepEqual(kernel.sessions.sessionInfo(s.id).network, {
    internal: true,
    policy: { allow: [] }
  })
})

test('an empty allow list is open, on both sides of the config file', () => {
  // The reversal (§6.3): the empty list used to be the deny-all "allowlist
  // mode" and is now rule 1 — everything outward, minus the built-in denylist.
  // What the boundary stores is what the proxy reads, as always.
  const stored = m.sanitizeDomainPolicy({ allow: [] })
  assert.deepEqual(stored, { allow: [] })
  for (const host of ['github.com', 'api.example.com', 'registry.npmjs.org'])
    assert.equal(proxy.policyDecision(host, 443, stored).allowed, true, `${host} gets out`)
  // …and the built-in denylist is what is left to say no, which the policy
  // itself has no opinion about.
  assert.equal(proxy.vetTarget('10.0.0.1', 443, stored).rule, 'builtin-denylist')
})

test('one entry closes everything else, and that is the whole of the policy', () => {
  const stored = m.sanitizeDomainPolicy({ allow: ['registry.npmjs.org'] })
  assert.equal(proxy.policyDecision('registry.npmjs.org', 443, stored).allowed, true)
  assert.equal(proxy.policyDecision('github.com', 443, stored).allowed, false)
  // And the built-in denylist is not consulted once the list has entries.
  assert.equal(proxy.vetTarget('10.0.0.1', 443, m.sanitizeDomainPolicy({ allow: ['10.0.0.1'] })).allowed, true)
})

test('a session launched with an empty allow list keeps it all the way to the record', () => {
  const s = mk({ internal: true, policy: { allow: [] } })
  assert.deepEqual(s.network, { internal: true, policy: { allow: [] } })
  assert.equal(proxy.policyDecision('github.com', 443, s.network.policy).allowed, true)
})

test('a policy stored under the old three-mode shape is migrated, not refused', () => {
  // The modes are gone. What survives is what the user actually typed as an
  // explicit destination: an old allowlist's domains, and `alwaysAllow` in any
  // mode — which was already "connect this exactly as written" (rule 3).
  const p = (raw) => m.sanitizeDomainPolicy(raw)
  assert.deepEqual(p({ mode: 'allowlist', domains: ['npmjs.org', 'github.com'] }), {
    allow: ['npmjs.org', 'github.com']
  })
  assert.deepEqual(p({ mode: 'allow', alwaysAllow: ['host.docker.internal:5173'] }), {
    allow: ['host.docker.internal:5173']
  })
  assert.deepEqual(p({ mode: 'allowlist', domains: ['npmjs.org'], alwaysAllow: ['10.1.2.3'] }), {
    allow: ['npmjs.org', '10.1.2.3']
  })
  // A denylist's own entries are dropped: the built-in denylist is not editable
  // yet, so there is nowhere to put them, and dropping them widens rather than
  // narrows — which is the reading that cannot silently break a session.
  assert.deepEqual(p({ mode: 'denylist', domains: ['pastebin.com'] }), { allow: [] })
  assert.deepEqual(p({ mode: 'denylist', domains: ['pastebin.com'], alwaysAllow: ['10.1.2.3'] }), {
    allow: ['10.1.2.3']
  })
  assert.deepEqual(p({ mode: 'allow' }), { allow: [] })
  // The one that reverses meaning: an empty allowlist *was* deny-all, and there
  // is no state for that any more, so it becomes the open list.
  assert.deepEqual(p({ mode: 'allowlist', domains: [] }), { allow: [] })
  assert.equal(proxy.policyDecision('github.com', 443, p({ mode: 'allowlist', domains: [] })).allowed, true)
})

test('a session stored under the old shape migrates on the way in', () => {
  const s = mk({ internal: true, policy: { mode: 'allowlist', domains: ['a.example.com'] } })
  assert.deepEqual(s.network, { internal: true, policy: { allow: ['a.example.com'] } })
})

test('entries are cleaned, deduped and capped', () => {
  assert.deepEqual(
    m.sanitizeDomainPolicy({
      allow: [' API.Example.COM. ', 'api.example.com', 'registry.npmjs.org', '', 7, null]
    }),
    { allow: ['api.example.com', 'registry.npmjs.org'] }
  )
  const many = Array.from({ length: m.MAX_POLICY_DOMAINS + 50 }, (_, i) => `h${i}.example.com`)
  assert.equal(m.sanitizeDomainPolicy({ allow: many }).allow.length, m.MAX_POLICY_DOMAINS)
})

test('a restriction has to be asked for: only a literal true is internal', () => {
  assert.deepEqual(m.sanitizeSessionNetwork({ internal: 'yes' }), { internal: false })
  assert.deepEqual(m.sanitizeSessionNetwork({}), { internal: false })
  assert.equal(m.sanitizeSessionNetwork(undefined), undefined, 'no choice stays no choice')
  assert.equal(m.sanitizeSessionNetwork('internal'), undefined)
})

// --- copies ---------------------------------------------------------------

test('a duplicate inherits the mode without sharing its allow list', () => {
  const source = mk({ internal: true, policy: { allow: ['a.example.com'] } })
  const copy = kernel.sessions.duplicateSession(source.id)
  assert.deepEqual(copy.network, {
    internal: true,
    policy: { allow: ['a.example.com'] }
  })
  copy.network.policy.allow.push('b.example.com')
  assert.deepEqual(
    kernel.sessions.sessionInfo(source.id).network.policy.allow,
    ['a.example.com'],
    'the source keeps its own list'
  )
})

test('an agent-drafted session inherits its spawner’s network and cannot loosen it', async () => {
  // A researcher, because only a researcher drafts (requirements-session-roles).
  const spawner = mk(
    { internal: true, policy: { allow: ['a.example.com'] } },
    'draft me one',
    'researcher'
  )
  const made = await kernel.sessions.createAgentDraft(spawner.id, {
    role: 'executor',
    repos: ['alpha'],
    prompt: 'fix the thing',
    // Not part of `AgentSessionRequest` — an agent has no field to ask for open
    // egress with, and one that invents it is ignored (§6.2).
    network: { internal: false }
  })
  const draft = kernel.sessions.sessionInfo(made.sessionId)
  assert.deepEqual(draft.network, {
    internal: true,
    policy: { allow: ['a.example.com'] }
  })
  draft.network.policy.allow.push('c.example.com')
  assert.deepEqual(
    kernel.sessions.sessionInfo(spawner.id).network.policy.allow,
    ['a.example.com'],
    'the spawner keeps its own list'
  )
})

test('a spawner on the default network drafts one on the default network', async () => {
  const spawner = mk(undefined, 'open spawner', 'researcher')
  const made = await kernel.sessions.createAgentDraft(spawner.id, {
    role: 'executor',
    repos: ['alpha'],
    prompt: 'p'
  })
  assert.equal(kernel.sessions.sessionInfo(made.sessionId).network, undefined)
})

// --- internal is enforced, not just recorded ------------------------------

// A `docker` that answers only the two things the network switch asks of it,
// and can be told to fail in each way that has to be told apart:
//
//   - `down` — nothing answered (unreachable socket, daemon mid-restart). The
//     failure mode that used to be indistinguishable from "nothing to do".
//   - `lie`  — connect/disconnect report success and change nothing. Not a real
//     docker behaviour: it is a stand-in for *any* future converge bug, and the
//     only thing that catches it is re-inspecting after the switch.
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-session-network-bin-'))
const STATE = path.join(BIN, 'daemon.json')
const FAKE = path.join(BIN, 'fake-docker.cjs')

fs.writeFileSync(
  FAKE,
  `'use strict'
const fs = require('fs')
const STATE = ${JSON.stringify(STATE)}
const args = process.argv.slice(2)
let state
try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { process.exit(0) }
const save = () => fs.writeFileSync(STATE, JSON.stringify(state))
const down = () => {
  process.stderr.write('Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\\n')
  process.exit(1)
}
if (args[0] === 'inspect' && args.join(' ').includes('NetworkSettings.Networks')) {
  if (state.mode === 'down') down()
  process.stdout.write((state.networks || []).join(' ') + ' \\n')
  process.exit(0)
}
if (args[0] === 'network' && (args[1] === 'connect' || args[1] === 'disconnect')) {
  if (state.mode === 'down') down()
  if (state.mode !== 'lie') {
    const name = args[args.length - 2]
    state.networks =
      args[1] === 'connect'
        ? (state.networks || []).concat(name)
        : (state.networks || []).filter((n) => n !== name)
    save()
  }
  process.exit(0)
}
// Everything else (the kernel's own boot sweeps) sees an empty, healthy daemon.
process.exit(0)
`
)
fs.writeFileSync(
  path.join(BIN, 'docker'),
  `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`,
  { mode: 0o755 }
)
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`

after(() => fs.rmSync(BIN, { recursive: true, force: true }))

/** Put the container on `networks`, and set how docker misbehaves. */
const daemon = (networks, mode = 'ok') =>
  fs.writeFileSync(STATE, JSON.stringify({ networks, mode }))
/** What the stub says the container is attached to now. */
const attached = () => JSON.parse(fs.readFileSync(STATE, 'utf8')).networks

const CONTAINER = 'c0ffee0123456789ab'
const bus = m.createBus()
const provisionLog = []
bus.on('provision.log', ({ line }) => provisionLog.push(line))

// The proxy container is not what these assert: `ensure` normally creates the
// session network, runs the proxy and attaches it, none of which changes what
// the *session* container is wired to. Stubbing it leaves exactly the switch.
m.proxies.ensure = async (session, settings) => ({
  session,
  token: 'stub-token',
  containerId: 'proxy-' + session,
  network: `gurt-s-${session}`,
  base: 'http://127.0.0.1:1/',
  internal: settings.internal === true
})

const containers = new m.ContainerManager({
  bus,
  session: () => undefined,
  sessions: () => [],
  patchContainer: () => {},
  isSessionIdle: () => false,
  detach: () => {}
})

/**
 * Steps 4 and 5 for one session, straight at the seam `resolveLaunch` calls it
 * from — the last thing that runs before the agent is spawned into `CONTAINER`.
 */
const ensureProxy = (id, network) => {
  provisionLog.length = 0
  const info = { id, workspace: ws, task, env: 'dev', repos: ['alpha'], network }
  return containers.ensureProxy(info, CONTAINER)
}

test('an internal session is switched off the bridge, and the switch is verified', async () => {
  // Where a container is when step 5 starts: born on the default bridge, having
  // just run its image build and its hooks there (§7.3).
  daemon(['bridge'])
  const runtime = await ensureProxy('s-int', { internal: true })
  assert.equal(runtime.internal, true)
  assert.deepEqual(attached(), ['gurt-s-s-int'], 'on its own network, and off the bridge')
  assert.ok(
    provisionLog.some((l) => l.includes('the proxy is its only')),
    'and the log records where the open-network window closed'
  )
})

test('a switch that reports success without happening fails an internal start', async () => {
  // The shape of any converge bug, present or future: docker says fine, the
  // container never moves. Without the post-condition this is a session running
  // its agent on the open bridge with nothing anywhere saying so.
  daemon(['bridge'], 'lie')
  await assert.rejects(
    () => ensureProxy('s-int', { internal: true }),
    /internal but its network isolation could not be confirmed.*expected exactly \[gurt-s-s-int\]/s
  )
  assert.ok(
    provisionLog.some((l) => l.includes('refusing to start')),
    'the provisioning log says why, next to the lines about the switch'
  )
  assert.ok(
    !provisionLog.some((l) => l.includes('the proxy is its only')),
    'and never claims the session is closed'
  )
})

test('a docker hiccup during the switch fails the start instead of opening it', async () => {
  // The finding itself: one transient `docker inspect` failure used to be read
  // as "nothing to converge", and provisioning carried straight on to the agent
  // with the container still on the bridge.
  daemon(['bridge'], 'down')
  await assert.rejects(() => ensureProxy('s-int', { internal: true }))
  assert.deepEqual(attached(), ['bridge'], 'the container is exactly where it was')
  assert.ok(!provisionLog.some((l) => l.includes('the proxy is its only')))
})

test('the same hiccup fails a default-mode start too — every converge fails closed', async () => {
  daemon(['bridge'], 'down')
  await assert.rejects(() => ensureProxy('s-open', { internal: false }))
})

test('a default-mode session is not gated on the post-condition', async () => {
  // Deliberate asymmetry, and the reason the extra inspect is affordable: it is
  // the security boundary that gets it. In default mode the session network is
  // an ordinary bridge and a container left on two of them has lost nothing.
  daemon(['bridge'], 'lie')
  const runtime = await ensureProxy('s-open', { internal: false })
  assert.equal(runtime.internal, false)
})
