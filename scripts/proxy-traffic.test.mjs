// The traffic surface (docs/requirements-mcp-proxy.md §8): the proxy's JSON
// lines, the ledger they fold into, and the event the session pane renders.
//
// The lines are not hand-written here. They are produced by the proxy's own
// `jsonLineLogger`, from `resources/proxy/gurt-proxy.mjs` — the file the
// container actually mounts — so the two halves of this contract are pinned
// against each other the way `proxy-config.test.mjs` pins the scope file. A
// record the proxy stops writing, or starts writing differently, breaks here
// rather than silently emptying a panel.
//
// What is checked, in the order it matters:
//
//   1. Refusals survive the trip intact — host, port and the rule that refused
//      them. That is the whole "why doesn't X work?" answer (§8); everything
//      else in this file is secondary to it.
//   2. Allowed and refused are separate lists, folded per host:port with a
//      count and a last-seen time, most recent first, bounded.
//   3. Nothing else in the stream becomes traffic: MCP routing, the proxy's own
//      lifecycle records and non-JSON noise are counted or dropped, never
//      rendered as a host the agent reached for.
//   4. The ledger outlives the tail (an idle session keeps its explanation) and
//      dies with the session.
//
// No docker: the log follower is injected, which is also how a container-less
// machine runs this.
//
//   node scripts/proxy-traffic.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { jsonLineLogger } from '../resources/proxy/gurt-proxy.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const S = (rel) => JSON.stringify(path.join(ROOT, rel))
const outfile = path.join(os.tmpdir(), `gurt-proxy-traffic-${process.pid}.mjs`)

await bundle({
  stdin: {
    contents: `export { TrafficWatcher, parseTrafficLine } from ${S('src/main/proxy/traffic.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  external: ['electron'],
  outfile
})

const { TrafficWatcher, parseTrafficLine } = await import(pathToFileURL(outfile).href)

after(() => fs.rmSync(outfile, { force: true }))

/** One line exactly as the proxy would write it for `record`. */
const line = (record) => {
  let written = ''
  jsonLineLogger((text) => {
    written = text
  })(record)
  return written
}

/** A watcher with an injectable stream, emitting on the next tick. */
function harness() {
  const streams = new Map()
  const seen = []
  const watcher = new TrafficWatcher({
    emitMs: 1,
    follow: (containerId, onLine, onExit) => {
      const stream = { onLine, onExit, killed: false }
      streams.set(containerId, stream)
      return () => {
        stream.killed = true
      }
    }
  })
  watcher.onChange((t) => seen.push(t))
  return {
    watcher,
    seen,
    stream: (id) => streams.get(id),
    /** Feed records through the proxy's own writer into a container's tail. */
    write: (containerId, ...records) =>
      records.forEach((r) => streams.get(containerId).onLine(line(r).trimEnd())),
    settled: () => new Promise((r) => setTimeout(r, 20))
  }
}

const at = (iso) => ({ t: iso })

// --- the refusal, end to end ---------------------------------------------

test('a refused host arrives with the rule that refused it', async () => {
  const h = harness()
  h.watcher.watch('s1', 'c1', true)
  h.write('c1', {
    ...at('2026-08-25T10:00:00.000Z'),
    kind: 'connect',
    host: 'pastebin.com',
    port: 443,
    decision: 'deny',
    rule: 'allowlist'
  })
  await h.settled()

  const traffic = h.watcher.get('s1')
  assert.deepEqual(traffic.blocked, [
    {
      host: 'pastebin.com',
      port: 443,
      attempts: 1,
      last: '2026-08-25T10:00:00.000Z',
      reason: 'allowlist'
    }
  ])
  assert.equal(traffic.internal, true, 'the mode rides along: enforced here, merely observed in open mode')
  assert.deepEqual(traffic.allowed, [])
  assert.equal(h.seen.at(-1).session, 's1', 'and the change was announced')
})

test('a plain-HTTP refusal is the same kind of record as a CONNECT one', async () => {
  const h = harness()
  h.watcher.watch('s1', 'c1', true)
  h.write(
    'c1',
    { ...at('2026-08-25T10:00:00.000Z'), kind: 'http', host: 'evil.test', port: 80, decision: 'deny', rule: 'allowlist' },
    // Before the scope lands the proxy fails closed — a real answer, and a
    // different one from "your policy says no".
    { ...at('2026-08-25T10:00:01.000Z'), kind: 'connect', host: 'api.example.com', port: 443, decision: 'deny', reason: 'no-scope' }
  )
  await h.settled()
  assert.deepEqual(
    h.watcher.get('s1').blocked.map((b) => [b.host, b.reason]),
    [
      ['api.example.com', 'no-scope'],
      ['evil.test', 'allowlist']
    ],
    'most recently seen first'
  )
})

test('a built-in refusal is distinguishable from a policy one, which is the whole fix', async () => {
  // The two refusals a user has to tell apart: "your allow list says no" (edit
  // the allow list) and "gurt says no by default" (add an allow-list
  // entry). They only differ by this field, so it has to survive the trip.
  const h = harness()
  h.watcher.watch('s1b', 'c1b', false)
  h.write(
    'c1b',
    {
      ...at('2026-08-25T10:00:00.000Z'),
      kind: 'connect',
      host: '169.254.169.254',
      port: 80,
      decision: 'deny',
      rule: 'builtin-denylist',
      ip: '169.254.169.254'
    },
    // The rebinding case: an unremarkable name, refused on the address it
    // answered with. The ledger keeps the name, because that is what the agent
    // asked for and what the user will recognise.
    {
      ...at('2026-08-25T10:00:01.000Z'),
      kind: 'http',
      host: 'metrics.vendor.example',
      port: 80,
      decision: 'deny',
      rule: 'builtin-denylist',
      ip: '169.254.169.254'
    }
  )
  await h.settled()
  assert.deepEqual(
    h.watcher.get('s1b').blocked.map((b) => [b.host, b.reason]),
    [
      ['metrics.vendor.example', 'builtin-denylist'],
      ['169.254.169.254', 'builtin-denylist']
    ]
  )
})

// --- folding --------------------------------------------------------------

test('repeat attempts fold into one entry with a count and the newest time', async () => {
  const h = harness()
  h.watcher.watch('s2', 'c2', true)
  const deny = (t) => ({ ...at(t), kind: 'connect', host: 'pastebin.com', port: 443, decision: 'deny', rule: 'allowlist' })
  h.write('c2', deny('2026-08-25T10:00:00.000Z'), deny('2026-08-25T10:00:05.000Z'), deny('2026-08-25T10:00:09.000Z'))
  await h.settled()

  assert.deepEqual(h.watcher.get('s2').blocked, [
    { host: 'pastebin.com', port: 443, attempts: 3, last: '2026-08-25T10:00:09.000Z', reason: 'allowlist' }
  ])
  assert.ok(h.seen.length < 3, 'changes are coalesced, not one event per connection')
})

test('the same host on two ports is two entries', async () => {
  const h = harness()
  h.watcher.watch('s3', 'c3', false)
  h.write(
    'c3',
    { ...at('2026-08-25T10:00:00.000Z'), kind: 'connect', host: 'example.com', port: 443, decision: 'allow', ms: 12 },
    { ...at('2026-08-25T10:00:01.000Z'), kind: 'connect', host: 'example.com', port: 8443, decision: 'allow', ms: 12 }
  )
  await h.settled()
  assert.deepEqual(
    h.watcher.get('s3').allowed.map((a) => a.port),
    [8443, 443]
  )
})

test('a permitted host that then failed to connect is not a policy refusal', async () => {
  // `decision: 'error'` is DNS/refused/timeout — the policy let it through, so
  // it must not appear as something the session was blocked from.
  const h = harness()
  h.watcher.watch('s4', 'c4', true)
  h.write('c4', {
    ...at('2026-08-25T10:00:00.000Z'),
    kind: 'connect',
    host: 'gone.example.com',
    port: 443,
    decision: 'error',
    error: 'ENOTFOUND'
  })
  await h.settled()
  const traffic = h.watcher.get('s4')
  assert.deepEqual(traffic.blocked, [])
  assert.deepEqual(traffic.allowed.map((a) => a.host), ['gone.example.com'])
})

// --- what is not traffic --------------------------------------------------

test('MCP routing and the proxy’s own lifecycle are counted, never listed as hosts', async () => {
  const h = harness()
  h.watcher.watch('s5', 'c5', true)
  h.write(
    'c5',
    { ...at('2026-08-25T10:00:00.000Z'), kind: 'server', decision: 'listening', port: 8100 },
    { ...at('2026-08-25T10:00:01.000Z'), kind: 'config', decision: 'loaded', mcp: ['github'] },
    { ...at('2026-08-25T10:00:02.000Z'), kind: 'mcp', id: 'linear', up: 'api.linear.app', host: 'api.linear.app', port: 443, decision: 'allow', status: 200 },
    { ...at('2026-08-25T10:00:03.000Z'), kind: 'mcp', id: 'nope', decision: 'deny', reason: 'unknown-id', status: 404 }
  )
  await h.settled()
  const traffic = h.watcher.get('s5')
  assert.deepEqual(traffic.blocked, [], 'an MCP id that is not in scope is not a blocked host')
  assert.deepEqual(traffic.allowed, [], 'and a routed MCP call is not a host the agent reached for')
  assert.equal(traffic.seen, 4, 'but everything read is counted')
})

test('non-JSON output in the stream is dropped, not surfaced', async () => {
  const h = harness()
  h.watcher.watch('s6', 'c6', true)
  const stream = h.stream('c6')
  stream.onLine('Debugger listening on ws://127.0.0.1:9229')
  stream.onLine('{ not json at all')
  stream.onLine('{"t":"2026-08-25T10:00:00.000Z"}') // no kind
  stream.onLine('[]')
  await h.settled()
  const traffic = h.watcher.get('s6')
  assert.equal(traffic.seen, 0)
  assert.deepEqual(traffic.blocked, [])
  assert.equal(parseTrafficLine('hello'), null)
  assert.equal(parseTrafficLine('{"kind":"connect"}').at.length > 0, true, 'a record with no timestamp still parses')
})

// --- lifecycle ------------------------------------------------------------

test('the ledger outlives the tail: an idle session keeps its explanation', async () => {
  const h = harness()
  h.watcher.watch('s7', 'c7', true)
  h.write('c7', {
    ...at('2026-08-25T10:00:00.000Z'),
    kind: 'connect',
    host: 'pastebin.com',
    port: 443,
    decision: 'deny',
    rule: 'allowlist'
  })
  await h.settled()

  // The idle path: the proxy is stopped, the tail goes with it (§9).
  h.watcher.unwatch('s7')
  assert.equal(h.stream('c7').killed, true, 'the follower is stopped')
  assert.equal(h.watcher.get('s7').blocked.length, 1, 'what it observed is still there')

  // The session is deleted: everything goes.
  h.watcher.forget('s7')
  assert.deepEqual(h.watcher.get('s7'), {
    session: 's7',
    internal: false,
    blocked: [],
    allowed: [],
    seen: 0
  })
})

test('a session nothing was observed for reads as empty, not absent', () => {
  const h = harness()
  assert.deepEqual(h.watcher.get('unknown', true), {
    session: 'unknown',
    internal: true,
    blocked: [],
    allowed: [],
    seen: 0
  })
})

test('re-watching the same container keeps the one tail; a new one replaces it', async () => {
  const h = harness()
  h.watcher.watch('s8', 'c8', false)
  h.watcher.watch('s8', 'c8', true)
  assert.equal(h.stream('c8').killed, false, 'the same container is not re-followed')
  assert.equal(h.watcher.get('s8').internal, true, 'but the mode is refreshed')

  // A resumed session gets a fresh proxy (§9) — the old tail must not be left
  // reading a container that is gone.
  h.watcher.watch('s8', 'c8-new', true)
  assert.equal(h.stream('c8').killed, true)
  h.write('c8', {
    ...at('2026-08-25T10:00:00.000Z'),
    kind: 'connect',
    host: 'registry.npmjs.org',
    port: 443,
    decision: 'allow'
  })
  await h.settled()
  assert.deepEqual(h.watcher.get('s8').allowed.map((a) => a.host), ['registry.npmjs.org'])
})

test('the host list is bounded, and the count says so', async () => {
  const h = harness()
  h.watcher.watch('s9', 'c9', true)
  for (let i = 0; i < 140; i++)
    h.write('c9', {
      ...at(`2026-08-25T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`),
      kind: 'connect',
      host: `h${i}.example.com`,
      port: 443,
      decision: 'allow'
    })
  await h.settled()
  const traffic = h.watcher.get('s9')
  assert.equal(traffic.allowed.length, 100, 'bounded')
  assert.equal(traffic.seen, 140, 'and what was dropped is still counted')
  assert.equal(traffic.allowed[0].host, 'h139.example.com', 'the newest is kept')
  assert.ok(
    !traffic.allowed.some((a) => a.host === 'h0.example.com'),
    'the least recently seen is the one evicted'
  )
})
