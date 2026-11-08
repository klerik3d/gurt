// The host-socket frame codec (protocol §3) against the shared vectors in
// testdata/frames.json — the file the relay's Go codec runs too.
//
//   node --test packages/remote-protocol/test/frames.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadProtocol, testdata } from './load.mjs'

const p = await loadProtocol()
const { fromHex, toHex } = p
const doc = testdata('frames.json')

/** The codec's frame, in the vector file's language-neutral form. */
function neutral(f) {
  const base = { type: f.type, stream: f.stream }
  switch (f.type) {
    case 'HELLO':
      return { ...base, version: f.version, challenge: toHex(f.challenge) }
    case 'REGISTER':
      return { ...base, version: f.version, pubkey: toHex(f.pubkey), sig: toHex(f.sig) }
    case 'DATA':
      return { ...base, data: toHex(f.data) }
    case 'CLOSE':
      return { ...base, reason: f.reason }
    case 'PUSH_ERR':
      return { ...base, code: f.code }
    case 'PUSH_SET':
      return { ...base, json: { tokens: f.tokens } }
    case 'PUSH':
      return { ...base, json: f.push }
    case 'PUSH_GONE':
      return { ...base, json: { d: f.d } }
    default:
      return base
  }
}

/** The vector's decoded form, back into the codec's frame. */
function fromNeutral(v) {
  const { json, ...f } = v
  for (const k of ['challenge', 'pubkey', 'sig', 'data']) if (typeof f[k] === 'string') f[k] = fromHex(f[k])
  if (v.type === 'PUSH_SET') f.tokens = json.tokens
  if (v.type === 'PUSH') f.push = json
  if (v.type === 'PUSH_GONE') f.d = json.d
  return f
}

test('the vector file has the documented shape', () => {
  assert.equal(doc.format, 'gurt-frames/1')
  for (const v of doc.vectors) {
    assert.equal(typeof v.name, 'string')
    assert.match(v.hex, /^([0-9a-f]{2})*$/)
    assert.ok(('frame' in v) !== ('error' in v), `${v.name}: exactly one of frame / error`)
  }
})

for (const v of doc.vectors) {
  test(`${v.error ? 'rejects' : 'decodes'}: ${v.name}`, () => {
    if (v.error) {
      assert.throws(
        () => p.decodeFrame(fromHex(v.hex)),
        (e) => e instanceof p.FrameError && e.code === v.error,
        `expected FrameError ${v.error}`
      )
      return
    }
    assert.deepEqual(neutral(p.decodeFrame(fromHex(v.hex))), v.frame)
    if (v.canonical) assert.equal(toHex(p.encodeFrame(fromNeutral(v.frame))), v.hex, 'encodes to the same bytes')
  })
}

test('the REGISTER vector carries a signature that verifies', () => {
  const hello = p.decodeFrame(fromHex(doc.vectors.find((v) => v.frame?.type === 'HELLO').hex))
  const reg = p.decodeFrame(fromHex(doc.vectors.find((v) => v.frame?.type === 'REGISTER').hex))
  assert.ok(p.verifyRegister(reg.pubkey, hello.challenge, reg.sig))
  const other = hello.challenge.slice()
  other[0] ^= 1
  assert.equal(p.verifyRegister(reg.pubkey, other, reg.sig), false, 'a different challenge does not verify')
})

test('encodeFrame refuses what decodeFrame would', () => {
  assert.throws(() => p.encodeFrame({ type: 'DATA', stream: 0, data: new Uint8Array(1) }), /DATA on stream 0/)
  assert.throws(() => p.encodeFrame({ type: 'READY', stream: 2 }), /READY on stream 2/)
  assert.throws(() => p.encodeFrame({ type: 'DATA', stream: 1, data: new Uint8Array(65537) }), (e) => e.code === 'too-large')
  assert.throws(() => p.encodeFrame({ type: 'CLOSE', stream: 1, reason: 9 }), (e) => e.code === 'bad-reason')
  assert.throws(() => p.encodeFrame({ type: 'OPEN', stream: 2 ** 32 }), (e) => e.code === 'bad-stream')
})

test('hostId: 32 characters of lowercase base32', () => {
  const id = p.hostIdFromPublicKey(p.generateRelayIdentity().publicKey)
  assert.match(id, p.HOST_ID_RE)
})
