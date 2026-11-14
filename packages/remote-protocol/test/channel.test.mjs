// The channel (protocol §6) against testdata/channel.json: both handshake
// modes with the §6.1 prologue, the §6.2 payloads, the §6.3 pairing code and
// the §6.4 chunked transport — and the host's rejections.
//
//   node --test packages/remote-protocol/test/channel.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadProtocol, testdata } from './load.mjs'

const p = await loadProtocol()
const { fromHex, toHex, utf8Encode, utf8Decode } = p
const doc = testdata('channel.json')
const K = doc.keys
const hostKey = p.keypairFromSecret(fromHex(K.hostStaticSecret))
const deviceKey = p.keypairFromSecret(fromHex(K.deviceStaticSecret))
const psk = fromHex(K.pairingSecret)

const expand = (m) => (typeof m === 'string' ? m : m.repeat.repeat(m.length))

for (const v of doc.vectors) {
  test(`${v.mode}: the vector replays byte for byte`, () => {
    assert.equal(toHex(p.channelPrologue(v.mode, K.hostId)), v.prologue)
    const pairing = v.mode === 'pair' ? { pairingSecret: psk } : {}
    const init = new p.ChannelInitiator({
      mode: v.mode,
      hostId: K.hostId,
      hostKey: hostKey.publicKey,
      deviceKey,
      ...pairing,
      hello: doc.clientHello,
      ephemeral: p.keypairFromSecret(fromHex(K.appEphemeralSecret))
    })
    assert.equal(toHex(init.first), v.first, 'message 1, with the mode byte')
    assert.equal(init.first[0], v.mode === 'pair' ? 2 : 1)
    const pending = p.readFirstMessage(init.first, {
      hostId: K.hostId,
      hostKey,
      ...pairing,
      ephemeral: p.keypairFromSecret(fromHex(K.hostEphemeralSecret))
    })
    assert.equal(pending.mode, v.mode)
    assert.equal(toHex(pending.deviceKey), K.deviceStaticPublic)
    assert.deepEqual(pending.hello, doc.clientHello)
    const { message, transport: host } = pending.accept()
    assert.equal(toHex(message), v.second, 'message 2')
    const { transport: app } = init.finish(message)
    assert.equal(toHex(app.handshakeHash), v.handshakeHash)
    assert.equal(toHex(host.handshakeHash), v.handshakeHash)
    assert.equal(p.pairingCode(app.handshakeHash), v.sas)
    assert.match(v.sas, /^\d{6}$/)
    for (const m of v.transport) {
      const [tx, rx] = m.from === 'app' ? [app, host] : [host, app]
      const data = tx.seal(expand(m.message))
      assert.deepEqual(data.map(toHex), m.data, `${m.from}: DATA payloads`)
      let got
      data.forEach((d, i) => {
        got = rx.open(d)
        if (i < data.length - 1) assert.equal(got, undefined, 'nothing before the last chunk')
      })
      assert.equal(utf8Decode(got), expand(m.message))
    }
  })

  test(`${v.mode}: Gurt reads the recorded message 1 with its own ephemeral`, () => {
    const pending = p.readFirstMessage(fromHex(v.first), {
      hostId: K.hostId,
      hostKey,
      ...(v.mode === 'pair' ? { pairingSecret: psk } : {})
    })
    assert.equal(toHex(pending.deviceKey), K.deviceStaticPublic)
  })
}

test('the SAS vectors', () => {
  for (const s of doc.sas) assert.equal(p.pairingCode(fromHex(s.h)), s.sas)
})

/** A fresh pair of ends over the given mode. */
function connect(mode = 'connect', opts = {}) {
  const host = { hostId: doc.keys.hostId, hostKey, ...opts.host }
  const init = new p.ChannelInitiator({
    mode,
    hostId: doc.keys.hostId,
    hostKey: hostKey.publicKey,
    deviceKey,
    ...(mode === 'pair' ? { pairingSecret: psk } : {}),
    hello: { v: 1, app: '1', platform: 'android' },
    ...opts.init
  })
  return { init, host }
}

const rejects = (fn, reason) =>
  assert.throws(fn, (e) => e instanceof p.ChannelError && e.reason === reason, `CLOSE reason ${reason}`)

test('rejections: no live secret, wrong secret, wrong host key, unknown mode, bad version', () => {
  const { init, host } = connect('pair')
  rejects(() => p.readFirstMessage(init.first, host), 1) // no pairing secret live
  rejects(() => p.readFirstMessage(init.first, { ...host, pairingSecret: new Uint8Array(32) }), 1)
  const other = connect('connect', { init: { hostKey: p.generateKeypair().publicKey } })
  rejects(() => p.readFirstMessage(other.init.first, other.host), 1)
  // The same message under the other mode byte: a different prologue and pattern.
  const c = connect('connect')
  const asPair = c.init.first.slice()
  asPair[0] = 2
  rejects(() => p.readFirstMessage(asPair, { ...c.host, pairingSecret: psk }), 1)
  const unknown = c.init.first.slice()
  unknown[0] = 3
  rejects(() => p.readFirstMessage(unknown, c.host), 2)
  rejects(() => p.readFirstMessage(new Uint8Array(0), c.host), 2)
  const v2 = connect('connect', { init: { hello: { v: 2, app: '1', platform: 'ios' } } })
  rejects(() => p.readFirstMessage(v2.init.first, v2.host), 1)
})

test('a different host id in the prologue fails the handshake', () => {
  const c = connect('connect')
  rejects(() => p.readFirstMessage(c.init.first, { ...c.host, hostId: 'a'.repeat(32) }), 1)
})

test('transport: chunk boundaries, AEAD failure, unknown flags, the 16 MiB cap', () => {
  const c = connect()
  const pending = p.readFirstMessage(c.init.first, c.host)
  const { message, transport: host } = pending.accept()
  const { transport: app } = c.init.finish(message)
  for (const n of [0, 1, p.MAX_CHUNK - 1, p.MAX_CHUNK, p.MAX_CHUNK + 1, 3 * p.MAX_CHUNK]) {
    const msg = new Uint8Array(n).fill(7)
    const data = app.seal(msg)
    assert.equal(data.length, Math.max(1, Math.ceil(n / p.MAX_CHUNK)), `${n} bytes`)
    for (const d of data) assert.ok(d.length <= 65535, 'each DATA payload fits one Noise message')
    let got
    for (const d of data) got = host.open(d)
    assert.deepEqual(got, msg)
  }
  const d = app.seal('x')[0]
  d[3] ^= 1
  rejects(() => host.open(d), 2)
  rejects(() => host.open(app.seal('y')[0]), 2) // dead after a failure
})

test('transport: unknown flag bits and a message over 16 MiB', () => {
  // A raw Noise sender facing a ChannelTransport, so the test can put any
  // plaintext — flags included — under a valid tag.
  const mk = () => {
    const i = new p.HandshakeState({ pattern: 'IK', initiator: true, prologue: new Uint8Array(0), s: deviceKey, rs: hostKey.publicKey })
    const r = new p.HandshakeState({ pattern: 'IK', initiator: false, prologue: new Uint8Array(0), s: hostKey })
    r.readMessage(i.writeMessage())
    i.readMessage(r.writeMessage())
    const a = i.finish()
    const b = r.finish()
    return { raw: a.send, rx: new p.ChannelTransport(b.send, b.receive, b.handshakeHash, b.remoteStatic) }
  }
  for (const flags of [0x02, 0x80, 0xff]) {
    const { raw, rx } = mk()
    rejects(() => rx.open(raw.encrypt(Uint8Array.of(flags, 1, 2))), 2)
  }
  {
    const { raw, rx } = mk()
    rejects(() => rx.open(raw.encrypt(new Uint8Array(0))), 2) // no flags byte at all
  }
  {
    const { raw, rx } = mk()
    const chunk = new Uint8Array(1 + p.MAX_CHUNK)
    chunk[0] = 1 // more follows
    const full = Math.floor(p.MAX_MESSAGE / p.MAX_CHUNK)
    for (let i = 0; i < full; i++) assert.equal(rx.open(raw.encrypt(chunk)), undefined)
    // Up to the cap exactly is fine; one byte past it closes with reason 3.
    const rest = p.MAX_MESSAGE - full * p.MAX_CHUNK
    const last = new Uint8Array(1 + rest + 1)
    last[0] = 1
    rejects(() => rx.open(raw.encrypt(last)), 3)
  }
  {
    const { raw, rx } = mk()
    const chunk = new Uint8Array(1 + p.MAX_CHUNK)
    chunk[0] = 1
    const full = Math.floor(p.MAX_MESSAGE / p.MAX_CHUNK)
    for (let i = 0; i < full; i++) rx.open(raw.encrypt(chunk))
    const last = new Uint8Array(1 + p.MAX_MESSAGE - full * p.MAX_CHUNK)
    assert.equal(rx.open(raw.encrypt(last)).length, p.MAX_MESSAGE, 'exactly 16 MiB is accepted')
  }
  const { rx } = mk()
  assert.throws(() => rx.seal(new Uint8Array(p.MAX_MESSAGE + 1)), (e) => e.reason === 3, 'and never sent')
})

test('the initiator rejects a message 2 that does not decrypt', () => {
  const c = connect()
  const { message } = p.readFirstMessage(c.init.first, c.host).accept()
  const bad = message.slice()
  bad[bad.length - 1] ^= 1
  rejects(() => c.init.finish(bad), 2)
})

test('utf8: strict decoding', () => {
  assert.equal(utf8Decode(utf8Encode('a ☃ 😀')), 'a ☃ 😀')
  for (const bad of [[0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x98], [0x80], [0xff]])
    assert.throws(() => utf8Decode(Uint8Array.from(bad)), /invalid UTF-8/, `rejects ${bad}`)
})
