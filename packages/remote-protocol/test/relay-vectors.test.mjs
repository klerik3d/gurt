// The host-socket codec (§3) and the registration signature (§2, §3.2) against
// the relay's own conformance vectors — the pinned copy in testdata/relay/,
// which the Go relay runs too (testdata/relay/README.md).
//
//   node --test packages/remote-protocol/test/relay-vectors.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadProtocol, testdata } from './load.mjs'
import { checkPinned, compareWithRelay, defaultRelayDir } from '../scripts/sync-relay-vectors.mjs'

const p = await loadProtocol()
const { fromHex, toHex } = p
const frames = testdata('relay/frames.json')
const register = testdata('relay/register.json')

// The relay's error identifiers (relay/README.md) and this codec's FrameError
// codes name the same faults; one row each. A vector file with an identifier
// not in this table fails, as the format's stability rules require.
const ERROR_CODE = {
  short: 'truncated',
  'unknown-type': 'unknown-type',
  stream: 'bad-stream',
  length: 'bad-length',
  'too-large': 'too-large',
  reason: 'bad-reason',
  code: 'bad-code',
  json: 'bad-push',
  'too-many-tokens': null // not a FrameError here; see the case below
}

/** The codec's frame in the vector file's payload layout (the normalised form:
 *  `w` always present, `p` only when non-empty). */
function payloadOf(f) {
  switch (f.type) {
    case 'HELLO':
      return { version: f.version, challenge: toHex(f.challenge) }
    case 'REGISTER':
      return { version: f.version, pubkey: toHex(f.pubkey), sig: toHex(f.sig) }
    case 'DATA':
      return { data: toHex(f.data) }
    case 'CLOSE':
      return { reason: f.reason }
    case 'PUSH_ERR':
      return { code: f.code }
    case 'PUSH_SET':
      return { tokens: f.tokens }
    case 'PUSH':
      return { t: f.push.t, s: f.push.s, w: f.push.w ?? false, ...(f.push.p ? { p: f.push.p } : {}) }
    case 'PUSH_GONE':
      return { d: f.d }
    default:
      return {}
  }
}

/** A vector's `frame`, back into the codec's frame. */
function frameOf({ type, stream, payload }) {
  switch (type) {
    case 'HELLO':
      return { type, stream, version: payload.version, challenge: fromHex(payload.challenge) }
    case 'REGISTER':
      return { type, stream, version: payload.version, pubkey: fromHex(payload.pubkey), sig: fromHex(payload.sig) }
    case 'DATA':
      return { type, stream, data: fromHex(payload.data) }
    case 'CLOSE':
      return { type, stream, reason: payload.reason }
    case 'PUSH_ERR':
      return { type, stream, code: payload.code }
    case 'PUSH_SET':
      return { type, stream, tokens: payload.tokens }
    case 'PUSH':
      return { type, stream, push: payload }
    case 'PUSH_GONE':
      return { type, stream, d: payload.d }
    default:
      return { type, stream }
  }
}

/** Neither the vector file nor the codec may be partly understood. */
test('frames.json: format 1, and every case has the documented shape', () => {
  assert.equal(frames.format, 1)
  assert.equal(frames.protocol, p.RELAY_PROTOCOL_VERSION)
  const names = new Set()
  for (const c of frames.cases) {
    assert.match(c.name, /^[a-z0-9-]+$/)
    assert.ok(!names.has(c.name), `${c.name}: duplicate name`)
    names.add(c.name)
    assert.ok(['host-to-relay', 'relay-to-host', 'both'].includes(c.direction), `${c.name}: direction ${c.direction}`)
    assert.match(c.hex, /^([0-9a-f]{2})*$/, c.name)
    assert.ok(('frame' in c) !== ('error' in c), `${c.name}: exactly one of frame / error`)
    if ('frame' in c) {
      assert.equal(typeof c.roundtrip, 'boolean', `${c.name}: roundtrip`)
      assert.ok(c.frame.type in p.FRAME_TYPE, `${c.name}: unknown type ${c.frame.type}`)
    } else {
      assert.ok(c.error in ERROR_CODE, `${c.name}: unknown error identifier ${c.error}`)
      assert.equal('relay' in c, c.direction !== 'relay-to-host', `${c.name}: relay member`)
    }
  }
})

for (const c of frames.cases) {
  if (c.error !== undefined) {
    test(`frames: rejects ${c.name} (${c.error})`, () => {
      if (c.error === 'too-many-tokens') {
        // The relay's codec reports the count; this one decodes a well-formed
        // PUSH_SET and leaves the count to `MAX_PUSH_TOKENS` (frames.ts), so a
        // sender or a fake relay sees PUSH_ERR 2 rather than a closed socket.
        const f = p.decodeFrame(fromHex(c.hex))
        assert.equal(f.type, 'PUSH_SET')
        assert.ok(f.tokens.length > p.MAX_PUSH_TOKENS, `${f.tokens.length} tokens`)
      } else {
        assert.throws(
          () => p.decodeFrame(fromHex(c.hex)),
          (e) => e instanceof p.FrameError && e.code === ERROR_CODE[c.error],
          `expected FrameError ${ERROR_CODE[c.error]}`
        )
      }
      // What the relay does with it, as far as this side can tell: a push
      // payload fault is a PUSH_ERR with the socket kept, anything else closes.
      if (c.relay) {
        const push = ['json', 'too-many-tokens'].includes(c.error)
        assert.deepEqual(
          c.relay,
          push
            ? { pushErr: c.error === 'json' ? p.PUSH_ERR_CODE.malformed : p.PUSH_ERR_CODE.tooManyTokens }
            : { close: p.HOST_CLOSE.protocolError }
        )
      }
    })
    continue
  }
  test(`frames: ${c.roundtrip ? 'round-trips' : 'decodes'} ${c.name}`, () => {
    const bytes = fromHex(c.hex)
    const f = p.decodeFrame(bytes)
    assert.equal(f.type, c.frame.type)
    assert.equal(f.stream, c.frame.stream)
    assert.deepEqual(payloadOf(f), c.frame.payload)
    const enc = p.encodeFrame(frameOf(c.frame))
    if (c.roundtrip) assert.equal(toHex(enc), c.hex, 'encodes to the same bytes')
    // Whatever the encoder writes, the decoder reads back as the same frame.
    assert.deepEqual(payloadOf(p.decodeFrame(enc)), c.frame.payload)
  })
}

test('frames: the encoder refuses frames the decoder rejects', () => {
  const big = new Uint8Array(65537)
  const code = (c) => (e) => e instanceof p.FrameError && e.code === c
  assert.throws(() => p.encodeFrame({ type: 'DATA', stream: 1, data: big }), code('too-large'))
  assert.throws(() => p.encodeFrame({ type: 'DATA', stream: 0, data: new Uint8Array(1) }), code('bad-stream'))
  assert.throws(() => p.encodeFrame({ type: 'READY', stream: 2 }), code('bad-stream'))
  assert.throws(() => p.encodeFrame({ type: 'OPEN', stream: 2 ** 32 }), code('bad-stream'))
  assert.throws(() => p.encodeFrame({ type: 'CLOSE', stream: 1, reason: 7 }), code('bad-reason'))
  assert.throws(() => p.encodeFrame({ type: 'PUSH_ERR', stream: 0, code: 5 }), code('bad-code'))
  assert.throws(() => p.encodeFrame({ type: 'PUSH_GONE', stream: 0, d: ['x'.repeat(65536)] }), code('too-large'))
  const push = (extra) => ({ type: 'PUSH', stream: 0, push: { t: 'error', s: 's', ...extra } })
  assert.throws(() => p.encodeFrame(push({ p: 'AAAAA' })), code('bad-push'))
  assert.throws(() => p.encodeFrame(push({ p: 'A'.repeat(2049) })), code('bad-push'))
})

test('frames: canonical PUSH leaves out w:false and an empty p', () => {
  const hex = (push) => toHex(p.encodeFrame({ type: 'PUSH', stream: 0, push }))
  assert.equal(hex({ t: 'error', s: 's', w: false, p: '' }), hex({ t: 'error', s: 's' }))
})

test('register.json: format 1 and the signed context', () => {
  assert.equal(register.format, 1)
  assert.equal(register.context, 'gurt-relay/1 register')
})

test('register.json: keys — public key and hostId from the seed', () => {
  for (const k of register.keys) {
    const id = p.relayIdentityFromSecret(fromHex(k.seed))
    assert.equal(toHex(id.publicKey), k.pubkey, `${k.name}: pubkey`)
    assert.equal(p.hostIdFromPublicKey(id.publicKey), k.hostId, `${k.name}: hostId`)
    assert.match(k.hostId, p.HOST_ID_RE)
  }
})

for (const c of register.cases) {
  test(`register: ${c.valid ? 'accepts' : 'rejects'} ${c.name}`, () => {
    const pub = fromHex(c.pubkey)
    const challenge = fromHex(c.challenge)
    const sig = fromHex(c.sig)
    assert.equal(toHex(p.registerMessage(challenge)), c.message, 'the signed bytes')
    assert.equal(p.verifyRegister(pub, challenge, sig), c.valid)
    if (c.valid) {
      assert.equal(p.hostIdFromPublicKey(pub), c.hostId)
      // Ed25519 is deterministic: the signer reproduces the file byte for byte.
      const key = register.keys.find((k) => k.pubkey === c.pubkey)
      assert.ok(key, `${c.name}: no key for this public key`)
      assert.equal(toHex(p.signRegister(fromHex(key.seed), challenge)), c.sig)
    } else {
      assert.equal(c.relay, p.HOST_CLOSE.badSignature)
    }
  })
}

// The pinned copy and the relay: SHA256SUMS catches a hand-edited copy without
// needing the relay; the comparison catches a copy that fell behind, when a
// gurt-relay checkout is at hand ($GURT_RELAY_DIR, or next to this repository).
test('testdata/relay/ matches its SHA256SUMS', () => {
  assert.deepEqual(checkPinned(), [])
})

test('testdata/relay/ is up to date with the gurt-relay checkout', (t) => {
  const relay = defaultRelayDir()
  if (!relay) return t.skip('no gurt-relay checkout (set GURT_RELAY_DIR)')
  assert.deepEqual(
    compareWithRelay(relay),
    [],
    'update: node packages/remote-protocol/scripts/sync-relay-vectors.mjs --update ' + relay
  )
})
