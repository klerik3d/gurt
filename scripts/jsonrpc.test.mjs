// src/main/jsonrpc.ts is the whole transport to an agent: newline-delimited
// JSON over a subprocess's stdio, with everything on the far end untrusted.
// This test drives the real `JsonRpcPeer` over a fake child process — an
// EventEmitter for stdout and a `write` sink for stdin — and covers:
//
//   * framing: one message split into arbitrary chunks, several messages in one
//     chunk, empty chunks, blank lines, CRLF, and an unterminated remainder;
//   * the noise gate: unparsable lines and JSON that is not a frame are skipped
//     without disturbing the frames around them;
//   * requests out (id allocation, response routing, schema-checked results,
//     error responses) and requests in (results, handler failures, unknown
//     methods, notifications);
//   * teardown: `close` rejects everything pending, `error` reaches `onFatal`;
//   * the DBG trace, which must carry method/id/direction/size and never params
//     (docs/logging.md: "JSON-RPC params — a frame is logged as method, id,
//     direction and byte size").
//
// Two behaviours below are *characterized*, not endorsed — both are called out
// with a "TODAY:" comment where they are asserted:
//   1. `onData` decodes each chunk with `d.toString()`, so a multi-byte UTF-8
//      character split across two chunks is corrupted (sibling `lineBuffer()`
//      in provision.ts uses a StringDecoder for exactly this reason);
//   2. there is no cap on the buffered remainder — an agent that never writes
//      a newline grows it without bound (`lineBuffer()` caps at 32 KiB).
//
// No timers, no sleeps: the peer's dispatch is driven by the data we feed it,
// and every "nothing happened" assertion is taken after draining the microtask
// queue with setImmediate.
//
//   node scripts/jsonrpc.test.mjs
import { test, after } from 'node:test'
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-jsonrpc-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

// log.ts reads both at import time. DBG is the level the frame trace runs at,
// and the level its privacy rule has to hold at.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-jsonrpc-'))
process.env.GURT_ROOT = path.join(sandbox, 'gurt')
process.env.GURT_LOG = 'debug'
const logFile = path.join(process.env.GURT_ROOT, 'logs', 'gurt.log')

await build({
  stdin: {
    contents:
      `export { JsonRpcPeer, issuePaths } from ${S('src/main/jsonrpc.ts')}\n` +
      `export { z } from 'zod'`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  // jsonc-parser's `main` is a UMD build esbuild can't wrap into ESM output —
  // prefer each package's ESM entry, like vite does.
  mainFields: ['module', 'main'],
  outfile,
  logLevel: 'silent'
})

const m = await import(pathToFileURL(outfile).href)
const { z } = m

/** Let every already-queued microtask and callback run. Not a sleep. */
const drain = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r))
}

/**
 * Poll until `cond()` holds. Used only for the log sink, which hands its
 * batches to the event loop — the wait ends on the condition, never on a
 * fixed delay, and the cap is a failure path, not a timing assumption.
 */
async function until(cond, what) {
  for (let i = 0; i < 500; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.fail(`timed out waiting for ${what}`)
}

/** A `JsonRpcPeer` over a fake child process. */
function makePeer(sessionId) {
  const writes = []
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    // stdin is an EventEmitter too: the peer subscribes to its 'error' so that
    // an EPIPE write into a dead adapter's pipe reaches onFatal instead of
    // throwing uncaught. A plain `{ write }` sink would have no `.on`.
    stdin: Object.assign(new EventEmitter(), {
      write(line) {
        writes.push(line)
        return true
      }
    })
  })
  const fatal = []
  const peer = new m.JsonRpcPeer(child, (e) => fatal.push(e), sessionId)
  return {
    peer,
    fatal,
    /** The fake child itself — for raising stream-level failures. */
    child,
    /** Raw lines the peer wrote to the child's stdin. */
    writes,
    /** Those lines, parsed. */
    sent: () => writes.map((l) => JSON.parse(l)),
    /** One `data` event, as bytes — what a real pipe delivers. */
    feed: (s) => child.stdout.emit('data', Buffer.from(s, 'utf8')),
    feedBytes: (buf) => child.stdout.emit('data', buf),
    close: () => child.emit('close', 0, null),
    fail: (e) => child.emit('error', e)
  }
}

/** Records every dispatch, so "nothing arrived" is checkable. */
function recorder(h) {
  const seen = []
  h.peer.onNotification('note', (params) => seen.push({ kind: 'note', params }))
  return seen
}

/**
 * Feed a frame the peer must always dispatch, then wait for it. Anything fed
 * before it has been handled by the time this resolves — which is how the
 * negative assertions below stay deterministic without a timeout.
 */
async function sentinel(h, seen) {
  const before = seen.length
  h.feed(`{"jsonrpc":"2.0","method":"note","params":{"sentinel":${before}}}\n`)
  await drain()
  assert.equal(seen.length, before + 1, 'the sentinel frame itself was dispatched')
  assert.deepEqual(seen[before], { kind: 'note', params: { sentinel: before } })
}

// ---------------------------------------------------------------- framing
test('one frame across single-byte chunks', async () => {
  const h = makePeer('s1')
  const seen = recorder(h)
  const frame = '{"jsonrpc":"2.0","method":"note","params":{"deep":{"n":[1,2,3]}}}\n'
  // One byte per `data` event — the pathological split a pipe is allowed to
  // produce, and the one that catches a peer that assumes chunk == message.
  for (const byte of Buffer.from(frame, 'utf8')) {
    h.feedBytes(Buffer.from([byte]))
    // Nothing may be dispatched before the terminating newline arrives.
    if (byte !== 0x0a) assert.equal(seen.length, 0, 'a partial frame is buffered, not dispatched')
  }
  await drain()
  assert.equal(seen.length, 1, 'a frame split into 64 chunks dispatches exactly once')
  assert.deepEqual(seen[0].params, { deep: { n: [1, 2, 3] } }, 'and arrives whole')
})

test('several frames per chunk, remainder carried over', async () => {
  const h = makePeer('s2')
  const seen = recorder(h)
  // Three frames plus the head of a fourth, all in one `data` event.
  h.feed(
    '{"jsonrpc":"2.0","method":"note","params":1}\n' +
      '{"jsonrpc":"2.0","method":"note","params":2}\n' +
      '{"jsonrpc":"2.0","method":"note","params":3}\n' +
      '{"jsonrpc":"2.0","method":"note","par'
  )
  await drain()
  assert.deepEqual(
    seen.map((s) => s.params),
    [1, 2, 3],
    'every complete frame in one chunk is dispatched, in order'
  )
  h.feed('ams":4}\n')
  await drain()
  assert.deepEqual(
    seen.map((s) => s.params),
    [1, 2, 3, 4],
    'the remainder joins the next chunk instead of being dropped'
  )
})

test('empty chunk, blank lines, CRLF', async () => {
  const h = makePeer('s3')
  const seen = recorder(h)
  h.feedBytes(Buffer.alloc(0)) // an empty `data` event
  h.feed('\n\n')
  h.feed('   \n\t\n')
  // CRLF: the line is trimmed before parsing, so a Windows-side adapter works.
  h.feed('{"jsonrpc":"2.0","method":"note","params":"crlf"}\r\n')
  await drain()
  assert.deepEqual(
    seen.map((s) => s.params),
    ['crlf'],
    'empty chunks and blank lines are skipped; a CRLF-terminated frame still parses'
  )
})

// ------------------------------------------------------------- noise gate
test('unparsable / non-frame lines skipped, stream still live', async () => {
  const h = makePeer('s4')
  const seen = recorder(h)
  const noise = [
    'starting agent adapter…', //        a plain log line on stdout
    '{"jsonrpc":"2.0","method":', //     truncated JSON
    '[1,2,3]', //                        JSON, but not an object
    '"a string"',
    '42',
    'null',
    '{"method":123}', //                 frame-shaped, but `method` is not a string
    '{"id":{"nested":true}}', //         `id` is neither number nor string
    '{"error":{"message":42},"id":1}' // `error.message` is not a string
  ]
  for (const line of noise) h.feed(`${line}\n`)
  await drain()
  assert.equal(seen.length, 0, `none of the ${noise.length} noise lines dispatched`)
  assert.deepEqual(h.writes, [], 'and none of them provoked a reply')
  // The pipe is still usable — a bad line must not poison the buffer.
  await sentinel(h, seen)
})

test('unknown frame members tolerated', async () => {
  // Loose envelope: a newer agent's extra members must not fail the parse.
  const h = makePeer('s5')
  const seen = recorder(h)
  h.feed('{"jsonrpc":"2.0","method":"note","params":"x","futureField":{"a":1}}\n')
  await drain()
  assert.deepEqual(seen.map((s) => s.params), ['x'], 'unknown members of a frame are ignored, not fatal')
})

// --------------------------------------------------------- requests (out)
test('request ids, out-of-order responses, unknown-id response ignored', async () => {
  const h = makePeer('s6')
  const p1 = h.peer.request('session/prompt', { text: 'hi' }, z.object({ stopReason: z.string() }))
  const p2 = h.peer.request('session/set_mode', { modeId: 'x' })
  assert.equal(h.writes.length, 2, 'each request is written immediately, one line each')
  for (const line of h.writes) assert.ok(line.endsWith('\n'), 'every outgoing frame is newline-terminated')
  const [out1, out2] = h.sent()
  assert.deepEqual(out1, { jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { text: 'hi' } })
  assert.equal(out2.id, 2, 'request ids increment')

  // Answers arrive out of order, in one chunk, with an unrelated id mixed in.
  h.feed(
    '{"jsonrpc":"2.0","id":99,"result":{"stray":true}}\n' +
      '{"jsonrpc":"2.0","id":2,"result":null}\n' +
      '{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn","extra":1}}\n'
  )
  assert.deepEqual(await p1, { stopReason: 'end_turn' }, 'the schema-checked result is parsed, not passed raw')
  assert.equal(await p2, null, 'a schema-less request resolves with whatever came back')
})

test('malformed response rejects with paths only, no content', async () => {
  const h = makePeer('s7')
  const SECRET = 'PROMPT-TEXT-9c1f7e-never-in-an-error'
  const p = h.peer.request('session/prompt', {}, z.object({ stopReason: z.string() }))
  h.feed(`{"jsonrpc":"2.0","id":1,"result":{"stopReason":${JSON.stringify(SECRET)}0}}\n`)
  // (that line is deliberately malformed JSON — it must be ignored entirely)
  h.feed(`{"jsonrpc":"2.0","id":1,"result":{"stopReason":{"note":${JSON.stringify(SECRET)}}}}\n`)
  const err = await p.then(
    () => assert.fail('a response that does not match the schema must reject'),
    (e) => e
  )
  assert.match(err.message, /^session\/prompt: malformed response \(/, 'the rejection names the method')
  assert.match(err.message, /stopReason: invalid_type/, 'and reports the failing path and issue code')
  assert.ok(!err.message.includes(SECRET), 'a rejection never quotes the value it received')
})

test('error responses, missing message, string-id response', async () => {
  const h = makePeer('s8')
  const pMsg = h.peer.request('m', {})
  h.feed('{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"agent said no"}}\n')
  await assert.rejects(pMsg, /agent said no/, 'an error response rejects with the agent\'s message')

  const pBare = h.peer.request('m', {})
  h.feed('{"jsonrpc":"2.0","id":2,"error":{"code":-32000}}\n')
  await assert.rejects(pBare, /^Error: agent error$/, 'an error response with no message still rejects')

  // Our own ids are numbers; a string id can only be the agent addressing us.
  const pending = h.peer.request('m', {})
  let settled = false
  void pending.then(
    () => (settled = true),
    () => (settled = true)
  )
  h.feed('{"jsonrpc":"2.0","id":"3","result":1}\n')
  await drain()
  assert.equal(settled, false, 'a string-id response does not resolve our number-id request')
})

test('notify() writes an id-less frame', () => {
  const h = makePeer('s9')
  h.peer.notify('session/cancel', { sessionId: 'abc' })
  assert.deepEqual(h.sent(), [{ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'abc' } }])
  assert.equal('id' in h.sent()[0], false, 'a notification carries no id')
})

// ---------------------------------------------------------- requests (in)
test('incoming requests: result, string id, handler failure, unknown method, notification', async () => {
  const h = makePeer('s10')
  h.peer.onRequest('fs/read_text_file', async (params) => ({ content: `read:${params.path}` }))
  h.peer.onRequest('boom', () => {
    throw new Error('handler exploded')
  })

  h.feed('{"jsonrpc":"2.0","id":7,"method":"fs/read_text_file","params":{"path":"/a"}}\n')
  await drain()
  assert.deepEqual(h.sent()[0], { jsonrpc: '2.0', id: 7, result: { content: 'read:/a' } }, 'the handler\'s result goes back under the same id')

  // An agent may address us with a string id; it must come back unchanged.
  h.feed('{"jsonrpc":"2.0","id":"str-1","method":"fs/read_text_file","params":{"path":"/b"}}\n')
  await drain()
  assert.equal(h.sent()[1].id, 'str-1', 'a string id is echoed as-is')

  h.feed('{"jsonrpc":"2.0","id":8,"method":"boom","params":{}}\n')
  await drain()
  assert.deepEqual(h.sent()[2], {
    jsonrpc: '2.0',
    id: 8,
    error: { code: -32603, message: 'handler exploded' }
  })

  h.feed('{"jsonrpc":"2.0","id":9,"method":"nope/gone","params":{}}\n')
  await drain()
  assert.deepEqual(h.sent()[3], {
    jsonrpc: '2.0',
    id: 9,
    error: { code: -32601, message: 'method not found: nope/gone' }
  })

  // A notification for an unregistered method is dropped, not answered:
  // replying to something with no id would be a protocol violation.
  h.feed('{"jsonrpc":"2.0","method":"unregistered/notification","params":{}}\n')
  await drain()
  assert.equal(h.sent().length, 4, 'an unknown notification is ignored, never answered')
})

// -------------------------------------------------------------- teardown
test('close rejects pending requests, error reaches onFatal', async () => {
  const h = makePeer('s11')
  const a = h.peer.request('m', {})
  const b = h.peer.request('m', {})
  h.close()
  await assert.rejects(a, /agent process exited/, 'close rejects everything in flight')
  await assert.rejects(b, /agent process exited/)
  h.close() // idempotent: the pending map was cleared
  await drain()

  const boom = new Error('EPIPE')
  h.fail(boom)
  assert.deepEqual(h.fatal, [boom], 'a child `error` reaches onFatal')
})

// A write into a dead adapter's pipe raises 'error' on the stdin *stream*,
// not on the process. Unlistened it is an uncaught exception, which takes the
// whole app down — so the peer must route it to onFatal like a child error.
test('a stdin stream error reaches onFatal, not the uncaught handler', async () => {
  const h = makePeer('s12')
  const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
  h.child.stdin.emit('error', epipe)
  await drain()
  assert.deepEqual(h.fatal, [epipe], 'an EPIPE on the stdin stream reaches onFatal, uncaught by no one')
})

// ------------------------------------------------------- issuePaths alone
test('issuePaths reports paths and codes only', () => {
  const schema = z.object({ a: z.object({ b: z.string() }), n: z.number() })
  const bad = schema.safeParse({ a: { b: 12345 }, n: 'PROMPT-9f2c' })
  assert.equal(bad.success, false)
  const text = m.issuePaths(bad.error)
  assert.match(text, /a\.b: invalid_type/, 'a nested path is dotted')
  assert.match(text, /n: invalid_type/)
  assert.ok(!text.includes('PROMPT-9f2c') && !text.includes('12345'), 'issuePaths quotes no values')
  assert.match(m.issuePaths(z.string().safeParse(1).error), /^<root>: /, 'a root-level issue is named <root>')
})

// ------------------------------------------------- size: no cap (TODAY’s behaviour)
test('1 MiB frame passes: no size cap in jsonrpc.ts today', async () => {
  const h = makePeer('s12')
  const seen = recorder(h)
  const big = 'x'.repeat(1024 * 1024)
  const frame = `{"jsonrpc":"2.0","method":"note","params":${JSON.stringify(big)}}\n`
  // Split across a chunk boundary so the whole thing has to be buffered.
  const half = Math.floor(frame.length / 2)
  h.feed(frame.slice(0, half))
  h.feed(frame.slice(half))
  await drain()
  // TODAY: jsonrpc.ts caps neither the buffered remainder nor a single frame,
  // so a 1 MiB message goes through whole — and an agent that never writes a
  // newline can grow `buffer` without bound. `lineBuffer()` in provision.ts
  // caps its remainder at 32 KiB for that reason; this peer does not. If a cap
  // ever lands here, this is the assertion that has to change.
  assert.equal(seen.length, 1, 'a 1 MiB frame is buffered across chunks and dispatched — there is no size cap')
  assert.equal(seen[0].params.length, big.length, 'and it arrives whole')
})

// ------------------------- multi-byte UTF-8 on a chunk boundary (TODAY’s behaviour)
test('multi-byte UTF-8 split across chunks: corrupted (known defect, characterized)', async () => {
  const h = makePeer('s13')
  const seen = recorder(h)
  const text = 'привет 😀 ok'
  const frame = Buffer.from(`{"jsonrpc":"2.0","method":"note","params":${JSON.stringify(text)}}\n`, 'utf8')
  // Cut inside the emoji's 4-byte sequence.
  const cut = frame.indexOf(Buffer.from('😀', 'utf8')) + 2
  h.feedBytes(frame.subarray(0, cut))
  h.feedBytes(frame.subarray(cut))
  await drain()
  assert.equal(seen.length, 1, 'the frame still parses — U+FFFD is valid inside a JSON string')
  // TODAY: `onData` does `d.toString()` per chunk, with no StringDecoder to
  // carry a partial sequence across chunks, so both halves of the character
  // become U+FFFD and the payload is silently corrupted. provision.ts's
  // lineBuffer() solves exactly this with `new StringDecoder('utf8')`; when
  // jsonrpc.ts does the same, flip this to `assert.equal(seen[0].params, text)`.
  assert.notEqual(seen[0].params, text, 'a multi-byte character split across chunks does NOT survive today')
  assert.ok(seen[0].params.includes('�'), 'it is replaced by U+FFFD')
  assert.ok(seen[0].params.startsWith('привет '), 'the rest of the line is unaffected')
})

// ------------------------------------------------------------- DBG trace
test('DBG frame trace carries envelope only (method/id/dir/bytes)', async () => {
  const h = makePeer('sess-trace')
  const SECRET = 'PROMPT-CONTENT-4d7b2a-must-not-be-logged'
  h.peer.notify('session/prompt', { text: SECRET })
  const inLine = `{"jsonrpc":"2.0","method":"session/update","params":{"text":${JSON.stringify(SECRET)}},"id":31}\n`
  h.peer.onRequest('session/update', () => 'ok')
  h.feed(inLine)
  await drain()

  // Every peer above traces too, so waiting for "some rpc.msg record" would
  // be a race with this one's two: wait for both of *this* session's.
  // A record is `<iso> DBG m [rpc] rpc.msg {…ctx}` — the ctx is the JSON tail.
  const readTraces = () =>
    (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '')
      .split('\n')
      .filter((l) => l.includes('] rpc.msg ') && l.includes('sess-trace') && l.endsWith('}'))
      .map((l) => JSON.parse(l.slice(l.indexOf('{'))))
  let traces = []
  await until(() => {
    traces = readTraces()
    return traces.some((t) => t.dir === 'in') && traces.some((t) => t.dir === 'out')
  }, "both of this session's rpc.msg records to reach gurt.log")

  const written = fs.readFileSync(logFile, 'utf8')
  assert.ok(!written.includes(SECRET), 'no frame params reach gurt.log, at any level')
  assert.ok(!written.includes('PROMPT-CONTENT'), 'not even partially')
  assert.ok(traces.length >= 2, `both directions are traced at DBG, got ${traces.length}`)
  const inbound = traces.find((t) => t.dir === 'in')
  assert.equal(inbound.method, 'session/update', 'the trace keeps the method')
  assert.equal(inbound.id, 31, 'and the id')
  assert.equal(inbound.bytes, Buffer.byteLength(inLine.trim(), 'utf8'), 'and the size in bytes, not code units')
  assert.deepEqual(
    Object.keys(inbound).sort(),
    ['bytes', 'dir', 'id', 'method', 's'],
    'and nothing else — no params, no result, no error text'
  )
  const outbound = traces.find((t) => t.dir === 'out')
  assert.equal(outbound.method, 'session/prompt', 'the outgoing notification is traced too')
  assert.equal(outbound.id, undefined, 'a notification has no id to trace')
})

after(() => {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(sandbox, { recursive: true, force: true })
})
