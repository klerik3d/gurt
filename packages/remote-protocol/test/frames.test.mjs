// What the host-socket codec does beyond the relay's shared vectors
// (relay-vectors.test.mjs): the TypeScript API, not the wire format.
//
//   node --test packages/remote-protocol/test/frames.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadProtocol } from './load.mjs'

const p = await loadProtocol()

test('encodeFrame then decodeFrame gives the frame back, byte arrays copied', () => {
  const data = Uint8Array.of(1, 2, 3)
  const bytes = p.encodeFrame({ type: 'DATA', stream: 5, data })
  const f = p.decodeFrame(bytes)
  bytes.fill(0)
  assert.deepEqual(f, { type: 'DATA', stream: 5, data: Uint8Array.of(1, 2, 3) })
})

test('a PUSH_SET above the token limit decodes: the relay answers PUSH_ERR 2, it does not close', () => {
  const tokens = Array.from({ length: p.MAX_PUSH_TOKENS + 1 }, (_, i) => ({ d: `d${i}`, p: 'fcm', t: `t${i}` }))
  const f = p.decodeFrame(p.encodeFrame({ type: 'PUSH_SET', stream: 0, tokens }))
  assert.equal(f.tokens.length, p.MAX_PUSH_TOKENS + 1)
})

test('hostId: 32 characters of lowercase base32', () => {
  const id = p.hostIdFromPublicKey(p.generateRelayIdentity().publicKey)
  assert.match(id, p.HOST_ID_RE)
})

test('a signature made here verifies, and not for another challenge', () => {
  const id = p.generateRelayIdentity()
  const challenge = new Uint8Array(32).fill(7)
  const sig = p.signRegister(id.secretKey, challenge)
  assert.ok(p.verifyRegister(id.publicKey, challenge, sig))
  const other = challenge.slice()
  other[0] ^= 1
  assert.equal(p.verifyRegister(id.publicKey, other, sig), false)
})
