// The Noise core against the specification's own test vectors
// (testdata/noise-spec.json, copied from cacophony and snow): both patterns
// the channel uses, every handshake and transport message byte for byte, and
// the final handshake hash.
//
//   node --test packages/remote-protocol/test/noise.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadProtocol, testdata } from './load.mjs'

const p = await loadProtocol()
const { fromHex, toHex, utf8Encode } = p
const spec = testdata('noise-spec.json')

const pattern = (name) => name.match(/^Noise_(IK(?:psk1)?)_/)[1]

for (const v of spec.vectors) {
  test(`spec vector: ${v.source} ${v.protocol_name}`, () => {
    const pat = pattern(v.protocol_name)
    const psk = (list) => (list && list.length ? { psk: fromHex(list[0]) } : {})
    const init = new p.HandshakeState({
      pattern: pat,
      initiator: true,
      prologue: fromHex(v.init_prologue),
      s: p.keypairFromSecret(fromHex(v.init_static)),
      e: p.keypairFromSecret(fromHex(v.init_ephemeral)),
      rs: fromHex(v.init_remote_static),
      ...psk(v.init_psks)
    })
    const resp = new p.HandshakeState({
      pattern: pat,
      initiator: false,
      prologue: fromHex(v.resp_prologue),
      s: p.keypairFromSecret(fromHex(v.resp_static)),
      e: p.keypairFromSecret(fromHex(v.resp_ephemeral)),
      ...psk(v.resp_psks)
    })
    let i = 0
    // Handshake: initiator writes message 0, responder message 1.
    for (; i < 2; i++) {
      const m = v.messages[i]
      const [w, r] = i % 2 === 0 ? [init, resp] : [resp, init]
      const ct = w.writeMessage(fromHex(m.payload))
      assert.equal(toHex(ct), m.ciphertext, `handshake message ${i}`)
      assert.equal(toHex(r.readMessage(ct)), m.payload, `handshake payload ${i} round-trips`)
    }
    const a = init.finish()
    const b = resp.finish()
    if (v.handshake_hash) assert.equal(toHex(a.handshakeHash), v.handshake_hash, 'handshake hash')
    assert.equal(toHex(a.handshakeHash), toHex(b.handshakeHash), 'both sides agree on h')
    assert.equal(toHex(b.remoteStatic), toHex(p.keypairFromSecret(fromHex(v.init_static)).publicKey))
    // Transport: messages keep alternating initiator / responder.
    for (; i < v.messages.length; i++) {
      const m = v.messages[i]
      const [w, r] = i % 2 === 0 ? [a, b] : [b, a]
      const ct = w.send.encrypt(fromHex(m.payload))
      assert.equal(toHex(ct), m.ciphertext, `transport message ${i}`)
      assert.equal(toHex(r.receive.decrypt(ct)), m.payload)
    }
  })
}

test('a wrong PSK fails message 1 on the responder, and the state stays failed', () => {
  const host = p.generateKeypair()
  const mk = (initiator, psk) =>
    new p.HandshakeState({
      pattern: 'IKpsk1',
      initiator,
      prologue: utf8Encode('x'),
      s: initiator ? p.generateKeypair() : host,
      ...(initiator ? { rs: host.publicKey } : {}),
      psk
    })
  const i = mk(true, new Uint8Array(32).fill(1))
  const r = mk(false, new Uint8Array(32).fill(2))
  const m1 = i.writeMessage(new Uint8Array(0))
  assert.throws(() => r.readMessage(m1), p.NoiseError)
  assert.throws(() => r.readMessage(m1), /already failed/)
})

test('a different prologue fails the handshake', () => {
  const host = p.generateKeypair()
  const i = new p.HandshakeState({ pattern: 'IK', initiator: true, prologue: utf8Encode('a'), s: p.generateKeypair(), rs: host.publicKey })
  const r = new p.HandshakeState({ pattern: 'IK', initiator: false, prologue: utf8Encode('b'), s: host })
  assert.throws(() => r.readMessage(i.writeMessage()), p.NoiseError)
})

test('a tampered transport message fails and does not advance the nonce', () => {
  const host = p.generateKeypair()
  const i = new p.HandshakeState({ pattern: 'IK', initiator: true, prologue: new Uint8Array(0), s: p.generateKeypair(), rs: host.publicKey })
  const r = new p.HandshakeState({ pattern: 'IK', initiator: false, prologue: new Uint8Array(0), s: host })
  r.readMessage(i.writeMessage())
  i.readMessage(r.writeMessage())
  const a = i.finish()
  const b = r.finish()
  const ct = a.send.encrypt(utf8Encode('hello'))
  const bad = ct.slice()
  bad[0] ^= 1
  assert.throws(() => b.receive.decrypt(bad), p.NoiseError)
  assert.equal(new TextDecoder().decode(b.receive.decrypt(ct)), 'hello', 'the genuine message still decrypts')
})

test('key generation uses crypto.getRandomValues and never falls back', async () => {
  const saved = globalThis.crypto
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true })
  try {
    assert.throws(() => p.generateKeypair(), /getRandomValues/, 'no secure source: a throw, not Math.random')
    assert.throws(() => p.generateRelayIdentity(), /getRandomValues/)
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: saved, configurable: true, writable: true })
  }
  assert.equal(p.generateKeypair().publicKey.length, 32)
})
