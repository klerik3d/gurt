// Writes testdata/frames.json, testdata/channel.json and testdata/pairing.json.
// The files are committed; the tests read them and never regenerate them, so a
// change to this script shows up as a diff of the vectors, for review.
//
// Frame bytes are put together here by hand, from §3 of the protocol, not with
// the codec under test — a vector that only restates the encoder would pin
// nothing. Keys and nonces are fixed, so every run writes the same bytes.
//
//   node packages/remote-protocol/scripts/gen-testdata.mjs
import fs from 'node:fs'
import path from 'node:path'
import { loadProtocol, TESTDATA_DIR } from '../test/load.mjs'

const p = await loadProtocol()
const { toHex, utf8Encode } = p

const write = (name, doc) => fs.writeFileSync(path.join(TESTDATA_DIR, name), JSON.stringify(doc, null, 2) + '\n')

/** A fixed 32-byte value: byte i = (seed + i) mod 256. */
const fixed = (seed, n = 32) => Uint8Array.from({ length: n }, (_, i) => (seed + i) & 255)

// ------------------------------------------------------------------ frames

const be16 = (n) => [(n >> 8) & 255, n & 255]
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const hexOf = (type, stream, payload = []) => toHex(Uint8Array.from([type, ...be32(stream), ...payload]))
const json = (o) => [...utf8Encode(typeof o === 'string' ? o : JSON.stringify(o))]

const relayId = p.relayIdentityFromSecret(fixed(0x40))
const challenge = fixed(0x00)
const sig = p.signRegister(relayId.secretKey, challenge)

const vectors = []
const ok = (name, hex, frame, canonical = true, note) =>
  vectors.push({ name, hex, frame, canonical, ...(note ? { note } : {}) })
const bad = (name, hex, error, note) => vectors.push({ name, hex, error, ...(note ? { note } : {}) })

ok('HELLO, version 1', hexOf(0x01, 0, [...be16(1), ...challenge]), {
  type: 'HELLO', stream: 0, version: 1, challenge: toHex(challenge)
})
ok('HELLO, version 2: the codec reads any version, negotiation is above it', hexOf(0x01, 0, [...be16(2), ...fixed(0xa0)]), {
  type: 'HELLO', stream: 0, version: 2, challenge: toHex(fixed(0xa0))
})
ok('REGISTER with a valid signature over the HELLO challenge above', hexOf(0x02, 0, [...be16(1), ...relayId.publicKey, ...sig]), {
  type: 'REGISTER', stream: 0, version: 1, pubkey: toHex(relayId.publicKey), sig: toHex(sig)
}, true, `hostId ${p.hostIdFromPublicKey(relayId.publicKey)}; Ed25519 seed ${toHex(fixed(0x40))}`)
ok('READY', hexOf(0x03, 0), { type: 'READY', stream: 0 })
ok('OPEN, stream 1', hexOf(0x10, 1), { type: 'OPEN', stream: 1 })
ok('OPEN, the largest stream id', hexOf(0x10, 0xffffffff), { type: 'OPEN', stream: 4294967295 })
ok('DATA', hexOf(0x11, 7, json('hello')), { type: 'DATA', stream: 7, data: toHex(utf8Encode('hello')) })
ok('DATA, empty', hexOf(0x11, 7), { type: 'DATA', stream: 7, data: '' })
const big = fixed(0x11, 65536)
ok('DATA, 65 536 bytes: the largest', hexOf(0x11, 2, [...big]), { type: 'DATA', stream: 2, data: toHex(big) })
for (const r of [0, 1, 2, 3, 4, 5, 6]) ok(`CLOSE, reason ${r}`, hexOf(0x12, 9, be16(r)), { type: 'CLOSE', stream: 9, reason: r })

const tokens = [
  { d: 'dev-1', p: 'apns', t: 'a1b2c3' },
  { d: 'dev-2', p: 'fcm', t: 'fcm:token-xyz' }
]
ok('PUSH_SET, two tokens', hexOf(0x20, 0, json({ tokens })), { type: 'PUSH_SET', stream: 0, json: { tokens } })
ok('PUSH_SET, empty: no device has a token', hexOf(0x20, 0, json({ tokens: [] })), { type: 'PUSH_SET', stream: 0, json: { tokens: [] } })
const many = Array.from({ length: 33 }, (_, i) => ({ d: `d${i}`, p: 'fcm', t: `t${i}` }))
ok('PUSH_SET, 33 tokens: well-formed; the relay refuses it with PUSH_ERR 2', hexOf(0x20, 0, json({ tokens: many })), {
  type: 'PUSH_SET', stream: 0, json: { tokens: many }
})
ok(
  'PUSH_SET, unknown members and whitespace are ignored',
  hexOf(0x20, 0, json('{ "tokens": [ { "d": "dev-1", "p": "apns", "t": "a1", "x": 1 } ], "future": true }')),
  { type: 'PUSH_SET', stream: 0, json: { tokens: [{ d: 'dev-1', p: 'apns', t: 'a1' }] } },
  false
)
ok('PUSH', hexOf(0x21, 0, json({ t: 'awaiting', s: 'sess-1' })), { type: 'PUSH', stream: 0, json: { t: 'awaiting', s: 'sess-1' } })
ok('PUSH, withdrawal with the reserved p', hexOf(0x21, 0, json({ t: 'error', s: 'sess-2', w: true, p: 'AAEC' })), {
  type: 'PUSH', stream: 0, json: { t: 'error', s: 'sess-2', w: true, p: 'AAEC' }
})
for (const t of ['proposal', 'turn-ended'])
  ok(`PUSH, type ${t}`, hexOf(0x21, 0, json({ t, s: 's' })), { type: 'PUSH', stream: 0, json: { t, s: 's' } })
ok(
  'PUSH, keys out of order and an unknown member',
  hexOf(0x21, 0, json('{"s":"sess-1","x":[1],"t":"awaiting"}')),
  { type: 'PUSH', stream: 0, json: { t: 'awaiting', s: 'sess-1' } },
  false
)
ok('PUSH_GONE', hexOf(0x22, 0, json({ d: ['dev-1', 'dev-2'] })), { type: 'PUSH_GONE', stream: 0, json: { d: ['dev-1', 'dev-2'] } })
for (const c of [1, 2, 3, 4]) ok(`PUSH_ERR, code ${c}`, hexOf(0x23, 0, be16(c)), { type: 'PUSH_ERR', stream: 0, code: c })

bad('empty message', '', 'truncated')
bad('four bytes: no full header', '10000000', 'truncated')
for (const t of [0x00, 0x04, 0x13, 0x24, 0xff]) bad(`unknown type 0x${t.toString(16).padStart(2, '0')}`, hexOf(t, 0), 'unknown-type')
bad('HELLO on stream 1', hexOf(0x01, 1, [...be16(1), ...challenge]), 'bad-stream')
bad('READY on stream 1', hexOf(0x03, 1), 'bad-stream')
bad('PUSH on stream 3', hexOf(0x21, 3, json({ t: 'awaiting', s: 's' })), 'bad-stream')
bad('PUSH_ERR on stream 1', hexOf(0x23, 1, be16(1)), 'bad-stream')
bad('OPEN on stream 0', hexOf(0x10, 0), 'bad-stream')
bad('DATA on stream 0', hexOf(0x11, 0, json('x')), 'bad-stream')
bad('CLOSE on stream 0', hexOf(0x12, 0, be16(0)), 'bad-stream')
bad('HELLO, 31-byte challenge', hexOf(0x01, 0, [...be16(1), ...fixed(0, 31)]), 'bad-length')
bad('HELLO, 33-byte challenge', hexOf(0x01, 0, [...be16(1), ...fixed(0, 33)]), 'bad-length')
bad('REGISTER, signature one byte short', hexOf(0x02, 0, [...be16(1), ...relayId.publicKey, ...sig.slice(0, 63)]), 'bad-length')
bad('READY with a payload', hexOf(0x03, 0, [0]), 'bad-length')
bad('OPEN with a payload', hexOf(0x10, 1, [0]), 'bad-length')
bad('CLOSE, one byte', hexOf(0x12, 1, [0]), 'bad-length')
bad('CLOSE, three bytes', hexOf(0x12, 1, [0, 0, 0]), 'bad-length')
bad('PUSH_ERR, three bytes', hexOf(0x23, 0, [0, 1, 0]), 'bad-length')
bad('DATA, 65 537 bytes', hexOf(0x11, 2, [...fixed(0x11, 65537)]), 'too-large')
bad('CLOSE, reason 7', hexOf(0x12, 1, be16(7)), 'bad-reason')
bad('CLOSE, reason 256', hexOf(0x12, 1, be16(256)), 'bad-reason')
bad('PUSH_ERR, code 0', hexOf(0x23, 0, be16(0)), 'bad-code')
bad('PUSH_ERR, code 5', hexOf(0x23, 0, be16(5)), 'bad-code')
bad('PUSH_SET, not JSON', hexOf(0x20, 0, json('{tokens')), 'bad-push')
bad('PUSH_SET, empty payload', hexOf(0x20, 0), 'bad-push')
bad('PUSH_SET, invalid UTF-8', hexOf(0x20, 0, [0x7b, 0xff, 0x7d]), 'bad-push')
bad('PUSH_SET, a JSON array', hexOf(0x20, 0, json([])), 'bad-push')
bad('PUSH_SET, tokens missing', hexOf(0x20, 0, json({})), 'bad-push')
bad('PUSH_SET, unknown platform', hexOf(0x20, 0, json({ tokens: [{ d: 'a', p: 'web', t: 'b' }] })), 'bad-push')
bad('PUSH_SET, empty device id', hexOf(0x20, 0, json({ tokens: [{ d: '', p: 'fcm', t: 'b' }] })), 'bad-push')
bad('PUSH_SET, token not a string', hexOf(0x20, 0, json({ tokens: [{ d: 'a', p: 'fcm', t: 5 }] })), 'bad-push')
bad('PUSH, unknown notification type', hexOf(0x21, 0, json({ t: 'nudge', s: 's' })), 'bad-push')
bad('PUSH, session id missing', hexOf(0x21, 0, json({ t: 'awaiting' })), 'bad-push')
bad('PUSH, w not a boolean', hexOf(0x21, 0, json({ t: 'awaiting', s: 's', w: 'yes' })), 'bad-push')
bad('PUSH, p not base64url', hexOf(0x21, 0, json({ t: 'awaiting', s: 's', p: 'a+b/' })), 'bad-push')
bad('PUSH_GONE, d not an array', hexOf(0x22, 0, json({ d: 'dev-1' })), 'bad-push')

write('frames.json', {
  format: 'gurt-frames/1',
  description:
    'Host-socket frame vectors, requirements-remote-protocol.md §3. Format: testdata/README.md. Generated by scripts/gen-testdata.mjs.',
  vectors
})

// ----------------------------------------------------------------- channel

const hostRelay = relayId
const hostId = p.hostIdFromPublicKey(hostRelay.publicKey)
const hostKey = p.keypairFromSecret(fixed(0x50))
const deviceKey = p.keypairFromSecret(fixed(0x60))
const initE = p.keypairFromSecret(fixed(0x70))
const respE = p.keypairFromSecret(fixed(0x80))
const psk = fixed(0x90)
const hello = { v: 1, app: '1.0.0', platform: 'ios', label: 'Test phone' }

function channelVector(mode) {
  const init = new p.ChannelInitiator({
    mode,
    hostId,
    hostKey: hostKey.publicKey,
    deviceKey,
    ...(mode === 'pair' ? { pairingSecret: psk } : {}),
    hello,
    ephemeral: initE
  })
  const pending = p.readFirstMessage(init.first, {
    hostId,
    hostKey,
    ...(mode === 'pair' ? { pairingSecret: psk } : {}),
    ephemeral: respE
  })
  const { message, transport: host } = pending.accept()
  const { transport: app } = init.finish(message)
  const msgs = []
  const send = (from, text) => {
    const t = from === 'app' ? app : host
    const r = from === 'app' ? host : app
    const data = t.seal(text)
    let got
    for (const d of data) got = r.open(d)
    if (new TextDecoder().decode(got) !== text) throw new Error('round trip failed')
    msgs.push({ from, message: text.length > 200 ? { repeat: text[0], length: text.length } : text, data: data.map(toHex) })
  }
  send('app', '{"jsonrpc":"2.0","id":1,"method":"remote.ping","params":{}}')
  send('gurt', '{"jsonrpc":"2.0","id":1,"result":{}}')
  send('gurt', '')
  send('app', 'x'.repeat(p.MAX_CHUNK + 1))
  return {
    mode,
    pattern: p.protocolName(mode === 'pair' ? 'IKpsk1' : 'IK'),
    prologue: toHex(p.channelPrologue(mode, hostId)),
    first: toHex(init.first),
    second: toHex(message),
    handshakeHash: toHex(app.handshakeHash),
    sas: p.pairingCode(app.handshakeHash),
    transport: msgs
  }
}

write('channel.json', {
  format: 'gurt-channel/1',
  description:
    'Channel vectors, requirements-remote-protocol.md §6: the handshake with the §6.1 prologue and the §6.2 payloads, the §6.3 pairing code, and §6.4 chunked transport messages. Format: testdata/README.md. Generated by scripts/gen-testdata.mjs.',
  keys: {
    hostId,
    hostStaticSecret: toHex(hostKey.secretKey),
    hostStaticPublic: toHex(hostKey.publicKey),
    deviceStaticSecret: toHex(deviceKey.secretKey),
    deviceStaticPublic: toHex(deviceKey.publicKey),
    appEphemeralSecret: toHex(initE.secretKey),
    hostEphemeralSecret: toHex(respE.secretKey),
    pairingSecret: toHex(psk)
  },
  clientHello: hello,
  vectors: [channelVector('connect'), channelVector('pair')],
  sas: [
    { h: '00'.repeat(32), sas: p.pairingCode(new Uint8Array(32)) },
    { h: 'ff'.repeat(32), sas: p.pairingCode(new Uint8Array(32).fill(0xff)) },
    { h: toHex(fixed(0x01)), sas: p.pairingCode(fixed(0x01)) }
  ]
})

// ----------------------------------------------------------------- pairing

const b64json = (o) => p.toB64u(utf8Encode(typeof o === 'string' ? o : JSON.stringify(o)))
const base = {
  v: 1,
  r: 'wss://relay.example.org',
  h: hostId,
  k: p.toB64u(hostKey.publicKey),
  s: p.toB64u(psk),
  n: 'workstation'
}
const pointer = Object.fromEntries(Object.entries(base).filter(([k]) => k !== 's'))
const decoded = (o, kind) => ({
  kind,
  v: 1,
  r: o.r,
  h: o.h,
  k: toHex(p.fromB64u(o.k)),
  ...(kind === 'pair' ? { s: toHex(p.fromB64u(o.s)) } : {}),
  n: o.n
})
const cases = []
const good = (name, url, value, canonical = false) => cases.push({ name, url, value, canonical })
const fail = (name, url, error) => cases.push({ name, url, error })

good('pair', 'gurt://pair#' + b64json(base), decoded(base, 'pair'), true)
good('relay (re-pointing)', 'gurt://relay#' + b64json(pointer), decoded(pointer, 'relay'), true)
good('scheme in capitals', 'GURT://pair#' + b64json(base), decoded(base, 'pair'))
good('relay URL with port and path', 'gurt://pair#' + b64json({ ...base, r: 'wss://relay.example.org:8443/gurt' }), decoded({ ...base, r: 'wss://relay.example.org:8443/gurt' }, 'pair'))
good('unknown members ignored', 'gurt://pair#' + b64json({ ...base, x: { y: 1 } }), decoded(base, 'pair'))
good('empty display name', 'gurt://pair#' + b64json({ ...base, n: '' }), decoded({ ...base, n: '' }, 'pair'))
good('non-ASCII display name', 'gurt://pair#' + b64json({ ...base, n: 'Рабочий 💻' }), decoded({ ...base, n: 'Рабочий 💻' }, 'pair'))
fail('another scheme', 'https://pair#' + b64json(base), 'bad-url')
fail('unknown kind', 'gurt://link#' + b64json(base), 'bad-url')
fail('no fragment marker', 'gurt://pair?' + b64json(base), 'bad-url')
fail('kind in capitals', 'gurt://PAIR#' + b64json(base), 'bad-url')
fail('padded base64url', 'gurt://pair#' + b64json(base) + '==', 'bad-encoding')
fail('a character outside base64url', 'gurt://pair#+' + b64json(base).slice(1), 'bad-encoding')
fail('not JSON', 'gurt://pair#' + b64json('{"v":1'), 'bad-encoding')
fail('a JSON array', 'gurt://pair#' + b64json([1]), 'bad-encoding')
fail('empty fragment', 'gurt://pair#', 'bad-encoding')
fail('version 2', 'gurt://pair#' + b64json({ ...base, v: 2 }), 'bad-version')
fail('version as a string', 'gurt://pair#' + b64json({ ...base, v: '1' }), 'bad-version')
fail('relay over ws://', 'gurt://pair#' + b64json({ ...base, r: 'ws://relay.example.org' }), 'bad-field')
fail('relay over https://', 'gurt://pair#' + b64json({ ...base, r: 'https://relay.example.org' }), 'bad-field')
fail('relay URL with credentials', 'gurt://pair#' + b64json({ ...base, r: 'wss://u:p@relay.example.org' }), 'bad-field')
fail('host id in capitals', 'gurt://pair#' + b64json({ ...base, h: hostId.toUpperCase() }), 'bad-field')
fail('host id too short', 'gurt://pair#' + b64json({ ...base, h: hostId.slice(1) }), 'bad-field')
fail('host key of 31 bytes', 'gurt://pair#' + b64json({ ...base, k: p.toB64u(fixed(0, 31)) }), 'bad-field')
fail('secret of 33 bytes', 'gurt://pair#' + b64json({ ...base, s: p.toB64u(fixed(0, 33)) }), 'bad-field')
fail('secret missing', 'gurt://pair#' + b64json(pointer), 'bad-field')
fail('name missing', 'gurt://pair#' + b64json({ ...base, n: undefined }), 'bad-field')
fail('relay URL carrying a secret', 'gurt://relay#' + b64json(base), 'unexpected-secret')

write('pairing.json', {
  format: 'gurt-pairing/1',
  description:
    'Pairing payload parse cases, requirements-remote-protocol.md §5. Format: testdata/README.md. Generated by scripts/gen-testdata.mjs.',
  cases
})

console.log(`frames: ${vectors.length}, pairing: ${cases.length}`)
