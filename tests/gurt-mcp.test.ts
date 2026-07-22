// Pure-node test for the `gurt` host MCP server (the turn contract, §7.1 of
// docs/requirements-turn-contract.md). No docker, no electron: it drives the
// real server over HTTP with MCP JSON-RPC.
import { afterAll, it } from 'vitest'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'

import { buildGurtHttpServer } from '../src/main/mcp/gurtServer'

const TOKEN = 'test-token'
/** Payloads the host callback received — the machine-readable outcome. */
const received: any[] = []
const server = buildGurtHttpServer(TOKEN, (p) => received.push(p))
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const port = (server.address() as AddressInfo).port
const url = (token = TOKEN) => `http://127.0.0.1:${port}/mcp/${token}`

afterAll(() => {
  server.close()
})

/** POST one JSON-RPC message; returns { status, body }. */
async function post(message: object, { token, method = 'POST' }: { token?: string; method?: string } = {}) {
  const res = await fetch(url(token), {
    method,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: method === 'GET' ? undefined : JSON.stringify(message)
  })
  const text = await res.text()
  let body: any
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, body }
}

let id = 0
/** Call the `complete` tool; returns { isError, text }. */
async function complete(args: object) {
  const { body } = await post({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: { name: 'complete', arguments: args }
  })
  return { isError: body.result?.isError === true, text: body.result?.content?.[0]?.text ?? '' }
}

it('tools/list: exactly `complete`, with a real (non-empty, strict) schema', async () => {
  const list = await post({ jsonrpc: '2.0', id: ++id, method: 'tools/list', params: {} })
  const tools = list.body.result.tools
  assert.deepEqual(
    tools.map((t: any) => t.name),
    ['complete'],
    'tools/list shows exactly `complete`'
  )
  const schema = tools[0].inputSchema
  assert.equal(schema.additionalProperties, false, 'input schema rejects unknown keys')
  assert.deepEqual(
    Object.keys(schema.properties).sort(),
    ['commit', 'notes', 'outcome', 'pr', 'reason', 'version'],
    'input schema advertises the proposal fields'
  )
})

it('valid changes call → callback gets the payload, result not an error', async () => {
  const before = received.length
  const ok = await complete({ version: 1, outcome: 'changes', commit: { subject: 'do the thing' } })
  assert.equal(ok.isError, false, 'valid changes call is not an error')
  assert.equal(received.length, before + 1, 'valid call fired the callback exactly once')
  assert.deepEqual(received[received.length - 1], {
    version: 1,
    outcome: 'changes',
    commit: { subject: 'do the thing' }
  })
})

it('valid no_changes / blocked / changes+pr also succeed', async () => {
  assert.equal((await complete({ version: 1, outcome: 'no_changes' })).isError, false)
  assert.equal(
    (await complete({ version: 1, outcome: 'blocked', reason: 'missing credentials' })).isError,
    false
  )
  assert.equal(
    (
      await complete({
        version: 1,
        outcome: 'changes',
        commit: { subject: 's', body: 'b' },
        pr: { title: 't' }
      })
    ).isError,
    false
  )
})

it('invalid calls: isError, and the callback never fires', async () => {
  const guard = received.length
  const rejects: [string, object][] = [
    ['changes without commit', { version: 1, outcome: 'changes' }],
    ['blocked without reason', { version: 1, outcome: 'blocked' }],
    ['commit outside changes', { version: 1, outcome: 'no_changes', commit: { subject: 's' } }],
    ['reason outside blocked', { version: 1, outcome: 'no_changes', reason: 'x' }],
    ['unknown top-level key', { version: 1, outcome: 'no_changes', bogus: 1 }],
    ['wrong version literal', { version: 2, outcome: 'no_changes' }],
    ['multi-line subject', { version: 1, outcome: 'changes', commit: { subject: 'a\nb' } }],
    ['over-long subject', { version: 1, outcome: 'changes', commit: { subject: 'x'.repeat(121) } }]
  ]
  for (const [label, args] of rejects) {
    const r = await complete(args)
    assert.equal(r.isError, true, `${label} → isError`)
  }
  assert.equal(received.length, guard, 'no rejected call reached the host callback')
})

it('transport guards: wrong token → 404, GET → 405', async () => {
  assert.equal((await post({ jsonrpc: '2.0', id: ++id, method: 'tools/list' }, { token: 'nope' })).status, 404)
  assert.equal((await post({}, { method: 'GET' })).status, 405)
})
