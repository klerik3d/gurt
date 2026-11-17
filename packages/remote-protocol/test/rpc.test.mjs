// The JSON-RPC envelope (protocol §7), the error codes (§7.7), the remote API
// method and event lists (§7.2, §7.4) and the hello version check (§7.1).
//
//   node --test packages/remote-protocol/test/rpc.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadProtocol } from './load.mjs'

const p = await loadProtocol()

test('the phase 1 method set is exactly this list', () => {
  // Adding a method to the remote API is a deliberate diff here
  // (requirements-remote-access.md §6.2, §12).
  assert.deepEqual([...p.REMOTE_API_METHODS].sort(), [
    'host.unpair',
    'inbox.list',
    'inbox.markRead',
    'permission.answer',
    'session.cancelQueued',
    'session.entry',
    'session.get',
    'session.send',
    'session.stop',
    'tree.get'
  ])
  assert.deepEqual([...p.REMOTE_CHANNEL_METHODS], ['remote.resume', 'remote.ping', 'remote.pushRegister', 'remote.pushUnregister'])
})

test('the event set', () => {
  assert.deepEqual([...p.REMOTE_EVENTS], [
    'tree-changed',
    'session-changed',
    'session-log',
    'notification',
    'notification-read',
    'host-state'
  ])
})

test('error codes (§7.7)', () => {
  assert.deepEqual(p.RPC_ERROR, {
    invalidRequest: -32600,
    methodNotFound: -32601,
    invalidParams: -32602,
    internal: -32603,
    tooManyInFlight: -32001,
    resultTooLarge: -32002,
    stale: -32010,
    confirmationRequired: -32011,
    notFound: -32012
  })
  assert.equal(p.MAX_IN_FLIGHT, 32)
})

test('parseRpc classifies the four kinds', () => {
  assert.deepEqual(p.parseRpc('{"jsonrpc":"2.0","id":1,"method":"tree.get","params":{}}'), {
    kind: 'request', jsonrpc: '2.0', id: 1, method: 'tree.get', params: {}
  })
  assert.deepEqual(p.parseRpc('{"jsonrpc":"2.0","method":"remote.hello","params":{"v":1},"x":1}'), {
    kind: 'notification', jsonrpc: '2.0', method: 'remote.hello', params: { v: 1 }
  })
  assert.deepEqual(p.parseRpc('{"jsonrpc":"2.0","id":"a","result":null}'), { kind: 'success', jsonrpc: '2.0', id: 'a', result: null })
  assert.deepEqual(p.parseRpc('{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"invalid request"}}'), {
    kind: 'failure', jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' }
  })
})

test('parseRpc refuses what is not a JSON-RPC 2.0 object', () => {
  for (const bad of [
    'nope',
    '[]',
    '[{"jsonrpc":"2.0","method":"a"}]', // batches are not part of the protocol
    '{"method":"a"}', // no jsonrpc member
    '{"jsonrpc":"1.0","method":"a"}',
    '{"jsonrpc":"2.0","id":{},"method":"a"}',
    '{"jsonrpc":"2.0","method":5}',
    '{"jsonrpc":"2.0","id":1}',
    '{"jsonrpc":"2.0","id":1,"result":1,"error":{"code":1,"message":"x"}}',
    '{"jsonrpc":"2.0","id":1,"error":{"code":"x","message":"y"}}'
  ])
    assert.equal(p.parseRpc(bad), undefined, bad)
})

test('builders', () => {
  assert.deepEqual(p.rpcRequest(3, 'session.stop', { id: 's' }), { jsonrpc: '2.0', id: 3, method: 'session.stop', params: { id: 's' } })
  assert.deepEqual(p.rpcNotification('remote.event', { ch: 'tree-changed' }), {
    jsonrpc: '2.0', method: 'remote.event', params: { ch: 'tree-changed' }
  })
  assert.deepEqual(p.rpcFailure(4, p.RPC_ERROR.stale, 'stale'), { jsonrpc: '2.0', id: 4, error: { code: -32010, message: 'stale' } })
})

test('api version ranges', () => {
  const c = p.apiCompatibility
  assert.deepEqual(c({ version: 3, min: 1 }, { version: 1, min: 1 }), { ok: true })
  assert.deepEqual(c({ version: 1, min: 1 }, { version: 3, min: 2 }), { ok: false, update: 'gurt' })
  assert.deepEqual(c({ version: 5, min: 4 }, { version: 2, min: 1 }), { ok: false, update: 'app' })
  assert.deepEqual(c({ version: p.REMOTE_API_VERSION, min: p.REMOTE_API_MIN }), { ok: true })
})
