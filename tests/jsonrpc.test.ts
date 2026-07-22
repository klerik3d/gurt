// Wire-contract tests for the JSON-RPC 2.0 peer that fronts ACP agent children
// (src/main/jsonrpc.ts): newline-delimited JSON over stdio. No real child — a
// fake process over PassThrough pairs, driven both as two wired peers and as
// raw frames to pin down framing, correlation, and error codes.
import { it } from 'vitest'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { JsonRpcPeer } from '../src/main/jsonrpc'

const noop = () => {}

/** Minimal stand-in for ChildProcessWithoutNullStreams: stdio + events. */
const fakeChild = (stdin: PassThrough, stdout: PassThrough): any =>
  Object.assign(new EventEmitter(), { stdin, stdout })

/** Two peers wired stdin↔stdout, like the app talking to its agent. */
function pair() {
  const aToB = new PassThrough()
  const bToA = new PassThrough()
  return {
    a: new JsonRpcPeer(fakeChild(aToB, bToA), noop),
    b: new JsonRpcPeer(fakeChild(bToA, aToB), noop)
  }
}

/** One peer plus its raw wire: `push` feeds its stdout, `sent` collects the
 *  JSON frames it wrote to stdin, `raw` the exact bytes. */
function rawPeer(onFatal: (e: Error) => void = noop) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const child = fakeChild(stdin, stdout)
  const sent: any[] = []
  const raw: string[] = []
  let buf = ''
  stdin.on('data', (d: Buffer) => {
    raw.push(d.toString())
    buf += d.toString()
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      sent.push(JSON.parse(buf.slice(0, nl)))
      buf = buf.slice(nl + 1)
    }
  })
  return { peer: new JsonRpcPeer(child, onFatal), child, push: (s: string) => stdout.write(s), sent, raw }
}

/** Stream delivery is async — spin the event loop until `cond` (or fail). */
async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setImmediate(r))
  assert.ok(cond(), what)
}

it('request/response correlation, resilient to out-of-order replies', async () => {
  const { a, b } = pair()
  let release!: (v: string) => void
  b.onRequest('sum', (p) => p.x + p.y)
  b.onRequest('slow', () => new Promise<string>((r) => (release = r)))
  assert.equal(await a.request('sum', { x: 2, y: 3 }), 5)

  const slow = a.request('slow', null)
  const fast = a.request('sum', { x: 1, y: 1 })
  assert.equal(await fast, 2) // the later request was answered first…
  assert.equal(await Promise.race([slow, Promise.resolve('pending')]), 'pending')
  release('done')
  assert.equal(await slow, 'done') // …and the early one still finds its promise

  // A remote -32601 surfaces to the caller as a rejection with the message.
  await assert.rejects(a.request('missing', null), /method not found: missing/)
})

it('both directions at once: ids are numbered per peer and never collide', async () => {
  const { a, b } = pair()
  a.onRequest('who', () => 'peer-a')
  b.onRequest('who', () => 'peer-b')
  // Both first requests go out as id 1 — correlation is per direction.
  const [fromB, fromA] = await Promise.all([a.request('who', null), b.request('who', null)])
  assert.equal(fromB, 'peer-b')
  assert.equal(fromA, 'peer-a')
})

it('notify: fire-and-forget across the pair', async () => {
  const { a, b } = pair()
  const seen: any[] = []
  b.onNotification('log', (p) => seen.push(p))
  a.notify('log', { line: 'hi' })
  await until(() => seen.length === 1, 'notification arrived')
  assert.deepEqual(seen, [{ line: 'hi' }])
})

it('outgoing framing: one JSON object per line, request ids counting from 1', async () => {
  const { peer, sent, raw } = rawPeer()
  void peer.request('first', { a: 1 }) // never answered — stays pending, that is fine
  peer.notify('second', null)
  void peer.request('third', null)
  await until(() => sent.length === 3, 'three frames written')
  assert.deepEqual(sent[0], { jsonrpc: '2.0', id: 1, method: 'first', params: { a: 1 } })
  assert.deepEqual(sent[1], { jsonrpc: '2.0', method: 'second', params: null }) // no id on notifications
  assert.deepEqual(sent[2], { jsonrpc: '2.0', id: 2, method: 'third', params: null })
  const bytes = raw.join('')
  assert.ok(bytes.endsWith('\n') && bytes.split('\n').length === 4, 'newline-delimited, no extra lines')
})

it('inbound requests: result echo, id 0 is a real id, JSON-RPC error codes', async () => {
  const { peer, push, sent } = rawPeer()
  peer.onRequest('sum', (p) => p.x + p.y)
  peer.onRequest('boom', () => {
    throw new Error('kaboom')
  })
  peer.onRequest('reject', async () => Promise.reject('string-reason'))
  push('{"jsonrpc":"2.0","id":0,"method":"sum","params":{"x":2,"y":3}}\n')
  push('{"jsonrpc":"2.0","id":1,"method":"nope","params":{}}\n')
  push('{"jsonrpc":"2.0","id":2,"method":"boom"}\n')
  push('{"jsonrpc":"2.0","id":3,"method":"reject"}\n')
  await until(() => sent.length === 4, 'four replies written')
  // Reply order is not part of the contract (handlers may be async) — match by id.
  const byId = new Map(sent.map((m) => [m.id, m]))
  assert.deepEqual(byId.get(0), { jsonrpc: '2.0', id: 0, result: 5 })
  assert.deepEqual(byId.get(1), {
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32601, message: 'method not found: nope' }
  })
  assert.deepEqual(byId.get(2), { jsonrpc: '2.0', id: 2, error: { code: -32603, message: 'kaboom' } })
  assert.deepEqual(byId.get(3), { jsonrpc: '2.0', id: 3, error: { code: -32603, message: 'string-reason' } })
})

it('inbound framing: split frames, batched frames, blank/garbage/CRLF lines', async () => {
  const { peer, push, sent } = rawPeer()
  const seen: any[] = []
  peer.onNotification('n', (p) => seen.push(p.k))
  push('starting agent on port 1234\n') // stray stdout logging — ignored
  push('\n   \n') // blank lines — ignored
  push('{"jsonrpc":"2.0","method":"n","pa') // one frame split mid-key…
  push('rams":{"k":1}}\n{"jsonrpc":"2.0","method":"n","params":{"k":2}}\n{"jso')
  push('nrpc":"2.0","method":"n","params":{"k":3}}\r\n') // …and a CRLF tail
  push('{"jsonrpc":"2.0","method":"unregistered","params":{}}\n') // no handler — ignored
  await until(() => seen.length === 3, 'all three frames decoded in order')
  assert.deepEqual(seen, [1, 2, 3])
  assert.deepEqual(sent, [], 'garbage and notifications never produced a reply')
})

it('junk frames are ignored and the peer keeps working', async () => {
  const { peer, push, sent } = rawPeer()
  push('{"jsonrpc":"2.0","id":999,"result":"nobody asked"}\n') // unknown response id
  push('{}\n') // neither id nor method
  push('{"jsonrpc":"2.0"}\n')
  await new Promise((r) => setImmediate(r))
  const p = peer.request('x', null)
  await until(() => sent.length === 1, 'request went out')
  push(`{"jsonrpc":"2.0","id":${sent[0].id},"result":"ok"}\n`)
  assert.equal(await p, 'ok')
})

it('error responses reject the caller; message falls back to "agent error"', async () => {
  const { peer, push, sent } = rawPeer()
  const p1 = peer.request('a', null)
  const p2 = peer.request('b', null)
  await until(() => sent.length === 2, 'both requests written')
  push(`{"jsonrpc":"2.0","id":${sent[0].id},"error":{"code":-32000,"message":"denied"}}\n`)
  push(`{"jsonrpc":"2.0","id":${sent[1].id},"error":{"code":-32000}}\n`)
  await assert.rejects(p1, /denied/)
  await assert.rejects(p2, /agent error/)
})

it('child close rejects every pending request; child error hits onFatal', async () => {
  const fatals: Error[] = []
  const { peer, child, push, sent } = rawPeer((e) => fatals.push(e))
  const p1 = peer.request('a', null)
  const p2 = peer.request('b', null)
  await until(() => sent.length === 2, 'requests in flight')
  child.emit('close')
  await assert.rejects(p1, /agent process exited/)
  await assert.rejects(p2, /agent process exited/)
  // Pending map is cleared — a late reply for a dead id is silently dropped.
  push(`{"jsonrpc":"2.0","id":${sent[0].id},"result":"too late"}\n`)
  await new Promise((r) => setImmediate(r))

  child.emit('error', new Error('spawn ENOENT'))
  assert.equal(fatals.length, 1)
  assert.equal(fatals[0].message, 'spawn ENOENT')
})
