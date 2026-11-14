// Remote access, Gurt's end of the host socket (src/main/remote/,
// docs/requirements-remote-protocol.md §3) against an in-process fake relay
// (scripts/lib/fake-relay.mjs): off by default and then inert, registration
// with the relay identity, version refusal, reconnect with backoff and what is
// not retried, the push token set and pushes (and what a push carries), the
// stream frames, protocol errors, and the identity key on disk.
//
//   node scripts/remote-relay-client.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { createFakeRelay } from './lib/fake-relay.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const S = (rel) => JSON.stringify(path.join(ROOT, rel))
const outfile = path.join(os.tmpdir(), `gurt-remote-relay-${process.pid}.mjs`)

// store.ts reads GURT_ROOT at import time; credentials seal nothing outside
// Electron, and say so.
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-remote-'))
process.env.GURT_ROOT = GURT_ROOT
process.env.GURT_FORCE_PLAINTEXT = '1'

await bundle({
  stdin: {
    contents: `
      export * from ${S('packages/remote-protocol/src/index.ts')}
      export { RelayClient, backoffDelay, hostSocketUrl } from ${S('src/main/remote/relayClient.ts')}
      export { startRemoteAccess } from ${S('src/main/remote/index.ts')}
      export { loadOrCreateIdentity, RELAY_IDENTITY_ID } from ${S('src/main/remote/identity.ts')}
      export { listCredentials, getCredentials } from ${S('src/main/credentials.ts')}
      export { isGitKind } from ${S('src/shared/credentials.ts')}
      export { sendExternal } from ${S('src/main/notify-external.ts')}
      export { getRemoteSettings, setRemoteSettings } from ${S('src/main/store.ts')}
      export { normalizeRemoteSettings, REMOTE_DEFAULTS } from ${S('src/shared/remote.ts')}
    `,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})
const m = await import(pathToFileURL(outfile).href)

after(() => {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

const FAST = { minMs: 2, maxMs: 16 }
const identity = () => {
  const id = m.generateRelayIdentity()
  return { ...id, hostId: m.hostIdFromPublicKey(id.publicKey) }
}

/** Wait for a condition that the event loop will make true. The cap is a
 *  failure path, not a timing assumption. */
async function until(cond, what) {
  for (let i = 0; i < 1000; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 2))
  }
  assert.fail(`timed out waiting for ${what}`)
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

/** A client against a fresh fake relay, with every state it went through. */
function setup(relayOpts = {}, clientOpts = {}) {
  const relay = createFakeRelay(m, relayOpts)
  const states = []
  const id = clientOpts.identity ?? identity()
  const client = new m.RelayClient({
    relayUrl: 'wss://relay.test/',
    identity: id,
    socketFactory: relay.factory,
    backoff: FAST,
    onState: (s) => states.push(s),
    ...clientOpts
  })
  return { relay, client, states, id, ready: () => until(() => client.status.state === 'ready', 'ready') }
}

// --------------------------------------------------------------- off is off

test('off by default: nothing is constructed, nothing connects, no key is made', async () => {
  assert.deepEqual(await m.getRemoteSettings(), m.REMOTE_DEFAULTS)
  assert.equal(m.REMOTE_DEFAULTS.enabled, false)
  let dialled = 0
  let keyed = 0
  const r = await m.startRemoteAccess({
    socketFactory: () => (dialled++, assert.fail('no socket while off')),
    identity: async () => (keyed++, identity())
  })
  assert.equal(r, undefined)
  assert.equal(dialled + keyed, 0)
  assert.deepEqual(
    (await m.listCredentials()).filter((c) => c.kind === 'remote-identity'),
    [],
    'no key in the credential store either'
  )

  const noUrl = await m.startRemoteAccess({
    settings: { enabled: true, relayUrl: '', keepAwake: true },
    socketFactory: () => assert.fail('no socket without a relay URL')
  })
  assert.equal(noUrl, undefined, 'on, but no relay URL: still nothing')
})

test('settings: coerced on read, a non-wss URL dropped', async () => {
  const n = m.normalizeRemoteSettings
  assert.deepEqual(n({ enabled: 'yes', relayUrl: 'https://x.org', keepAwake: 0 }), m.REMOTE_DEFAULTS)
  assert.deepEqual(n({ enabled: true, relayUrl: ' wss://relay.example.org:8443/r ' }), {
    enabled: true,
    relayUrl: 'wss://relay.example.org:8443/r',
    keepAwake: true
  })
  await m.setRemoteSettings({ enabled: true, relayUrl: 'wss://relay.example.org', keepAwake: false })
  assert.deepEqual(await m.getRemoteSettings(), { enabled: true, relayUrl: 'wss://relay.example.org', keepAwake: false })
  await m.setRemoteSettings(m.REMOTE_DEFAULTS)
})

// ------------------------------------------------------------ registration

test('registers: signed REGISTER, READY, the token set right after', async () => {
  const { relay, client, id, ready } = setup()
  client.start()
  await ready()
  assert.deepEqual(relay.urls, ['wss://relay.test/v1/host'], 'connects to <relay>/v1/host')
  const conn = relay.last
  assert.equal(conn.hostId, id.hostId, 'the relay derived the same host id')
  assert.deepEqual(
    conn.frames.map((f) => f.type),
    ['REGISTER', 'PUSH_SET'],
    'nothing but REGISTER before READY, and the token set right after'
  )
  assert.equal(conn.frames[0].version, 1)
  assert.deepEqual(relay.tokens.get(id.hostId), [], 'an empty set is still sent')
  assert.deepEqual(client.status, { state: 'ready', hostId: id.hostId, relayVersion: 1 })
  client.stop()
})

test('a relay that speaks a newer protocol too: Gurt registers with its own', async () => {
  const { relay, client, ready } = setup({ version: 2, supported: [1, 2] })
  client.start()
  await ready()
  assert.equal(relay.last.frames[0].version, 1)
  assert.equal(client.status.relayVersion, 2)
  client.stop()
})

test('a relay too old: both versions shown, no REGISTER, no retry', async () => {
  const { relay, client, states } = setup({ version: 0 })
  client.start()
  await until(() => client.status.state === 'failed', 'failed')
  assert.equal(client.status.reason, 'version')
  assert.match(client.status.detail, /protocol 0.*needs 1/)
  assert.deepEqual(relay.last.frames, [], 'did not register')
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(relay.connections.length, 1, 'not retried')
  assert.ok(!states.some((s) => s.state === 'retrying'))
})

test('4426 and 4401 are shown and not retried', async () => {
  {
    const { relay, client } = setup({ supported: [2, 3] })
    client.start()
    await until(() => client.status.state === 'failed', 'failed on 4426')
    assert.equal(client.status.reason, 'version')
    assert.match(client.status.detail, /supports: 2,3/, 'the relay’s reason text is passed on')
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(relay.connections.length, 1)
  }
  {
    const { relay, client } = setup({ refuseSignature: true })
    client.start()
    await until(() => client.status.state === 'failed', 'failed on 4401')
    assert.equal(client.status.reason, 'bad-signature')
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(relay.connections.length, 1)
  }
})

// ------------------------------------------------------------- reconnecting

test('backoff: exponential from the minimum, capped, jittered within bounds', () => {
  const b = { minMs: 1000, maxMs: 60_000 }
  assert.equal(m.backoffDelay(1, b, () => 0), 500)
  assert.equal(m.backoffDelay(1, b, () => 1), 1000)
  assert.equal(m.backoffDelay(4, b, () => 1), 8000)
  assert.equal(m.backoffDelay(30, b, () => 1), 60_000, 'capped at the maximum')
  assert.equal(m.backoffDelay(30, b, () => 0), 30_000, 'and never below half of it')
})

test('a dropped socket reconnects and re-registers; a restarted relay gets the tokens again', async () => {
  const { relay, client, states, id, ready } = setup()
  client.start()
  await ready()
  const tokens = [{ d: 'dev-1', p: 'apns', t: 'tok-1' }]
  client.setPushTokens(tokens)
  await until(() => relay.tokens.get(id.hostId)?.length === 1, 'PUSH_SET')
  relay.restart()
  assert.equal(relay.tokens.size, 0, 'a restarted relay holds nothing')
  await until(() => relay.connections.length === 2 && client.status.state === 'ready', 'second registration')
  assert.ok(states.some((s) => s.state === 'retrying'), 'went through a backoff wait')
  assert.deepEqual(relay.tokens.get(id.hostId), tokens, 'the token set is sent again after READY')
  client.stop()
})

test('replaced by a newer registration of the same host id (4409): retried', async () => {
  const a = setup()
  a.client.start()
  await a.ready()
  const b = new m.RelayClient({ relayUrl: 'wss://relay.test', identity: a.id, socketFactory: a.relay.factory, backoff: FAST })
  b.start()
  await until(() => a.states.some((s) => s.state === 'retrying' && /replaced/.test(s.reason)), 'a replaced')
  a.client.stop()
  await until(() => b.status.state === 'ready', 'b ready')
  b.stop()
})

test('protocol errors from the relay: closed with 4400 and retried', async () => {
  const { relay, client, ready } = setup()
  client.start()
  await ready()
  relay.last.sendRaw('{"text":"message"}')
  await until(() => relay.connections[0].closedBy?.code === 4400, 'text message → 4400')
  await until(() => relay.connections.length === 2 && client.status.state === 'ready', 'reconnected')
  relay.last.sendRaw(Uint8Array.of(0x7f, 0, 0, 0, 0))
  await until(() => relay.connections[1].closedBy?.code === 4400, 'unknown type → 4400')
  await until(() => client.status.state === 'ready' && relay.connections.length === 3, 'reconnected again')
  relay.last.send({ type: 'HELLO', stream: 0, version: 1, challenge: new Uint8Array(32) })
  await until(() => relay.connections[2].closedBy?.code === 4400, 'a second HELLO → 4400')
  client.stop()
})

test('a frame before READY is a protocol error', async () => {
  const relay = createFakeRelay(m)
  const factory = (url) => {
    const sock = relay.factory(url)
    const conn = relay.last
    // Open a stream before the registration is through.
    void new Promise((r) => setImmediate(r)).then(() => conn.send({ type: 'OPEN', stream: 5 }))
    return sock
  }
  const client = new m.RelayClient({ relayUrl: 'wss://r', identity: identity(), socketFactory: factory, backoff: FAST })
  client.start()
  await until(() => relay.connections[0].closedBy?.code === 4400, 'OPEN before READY → 4400')
  client.stop()
})

// ----------------------------------------------------------------- pushes

test('notifications become pushes: a type and a session id, nothing else', async () => {
  const relay = createFakeRelay(m)
  const id = identity()
  const r = await m.startRemoteAccess({
    settings: { enabled: true, relayUrl: 'wss://relay.test', keepAwake: true },
    identity: async () => id,
    socketFactory: relay.factory,
    backoff: FAST
  })
  await until(() => r.client.status.state === 'ready', 'ready')
  const TITLE = 'checkout · SECRET-SESSION-TITLE'
  await m.sendExternal('awaiting', {
    id: 'n1',
    type: 'awaiting',
    sessionId: 'sess-9',
    ref: { workspace: 'w', task: 't' },
    title: TITLE,
    detail: 'the agent asks: rm -rf /',
    ts: new Date().toISOString(),
    read: false
  })
  await until(() => relay.pushes.length === 1, 'PUSH')
  assert.deepEqual(relay.pushes[0].push, { t: 'awaiting', s: 'sess-9' })
  const wire = relay.last.frames.map((f) => JSON.stringify(f.push ?? {})).join()
  assert.ok(!wire.includes('SECRET') && !wire.includes('rm -rf'), 'no title, no detail on the wire')
  r.stop()
  // Stopped: the sink is gone, a notification goes nowhere.
  await m.sendExternal('error', { id: 'n2', type: 'error', sessionId: 's', ref: {}, title: '', detail: '', ts: '', read: false })
  await settle()
  assert.equal(relay.pushes.length, 1)
})

test('push when not registered is dropped, not queued', async () => {
  const { relay, client, ready } = setup()
  assert.equal(client.push({ t: 'error', s: 's' }), false, 'off')
  client.start()
  assert.equal(client.push({ t: 'error', s: 's' }), false, 'connecting')
  await ready()
  assert.equal(client.push({ t: 'error', s: 's2', w: true }), true)
  await until(() => relay.pushes.length === 1, 'the one push')
  assert.deepEqual(relay.pushes[0].push, { t: 'error', s: 's2', w: true })
  client.stop()
})

test('PUSH_GONE and PUSH_ERR reach their callbacks; the socket stays', async () => {
  const gone = []
  const errs = []
  const { relay, client, ready } = setup({}, { onPushGone: (d) => gone.push(d), onPushError: (c) => errs.push(c) })
  client.start()
  await ready()
  relay.last.send({ type: 'PUSH_GONE', stream: 0, d: ['dev-1'] })
  client.setPushTokens(Array.from({ length: 33 }, (_, i) => ({ d: `d${i}`, p: 'fcm', t: `t${i}` })))
  await until(() => gone.length === 1 && errs.length === 1, 'both callbacks')
  assert.deepEqual(gone, [['dev-1']])
  assert.deepEqual(errs, [2], 'too many tokens')
  assert.equal(client.status.state, 'ready')
  assert.equal(relay.connections.length, 1)
  client.stop()
})

// ---------------------------------------------------------------- streams

test('streams with nobody to serve them: the first message gets a close (1)', async () => {
  const { relay, client, ready } = setup()
  client.start()
  await ready()
  const s = relay.last.openStream()
  relay.last.send({ type: 'DATA', stream: s, data: Uint8Array.of(1, 1, 2, 3) })
  await until(() => relay.last.frames.some((f) => f.type === 'CLOSE'), 'CLOSE')
  assert.deepEqual(relay.last.frames.find((f) => f.type === 'CLOSE'), { type: 'CLOSE', stream: s, reason: 1 })
  assert.equal(relay.last.frames.filter((f) => f.type === 'DATA').length, 0, 'and nothing else')
  client.stop()
})

test('streams: open, data both ways, close from either side, going away', async () => {
  const seen = []
  const streams = {
    open: (s) => seen.push(['open', s]),
    data: (s, d) => seen.push(['data', s, [...d]]),
    closed: (s, r) => seen.push(['closed', s, r])
  }
  const { relay, client, ready } = setup({}, { streams })
  client.start()
  await ready()
  const conn = relay.last
  const a = conn.openStream()
  const b = conn.openStream()
  conn.send({ type: 'DATA', stream: a, data: Uint8Array.of(9) })
  await until(() => seen.length === 3, 'open, open, data')
  assert.equal(client.sendData(a, Uint8Array.of(7, 7)), true)
  await until(() => conn.frames.some((f) => f.type === 'DATA'), 'DATA to the relay')
  assert.deepEqual([...conn.frames.find((f) => f.type === 'DATA').data], [7, 7])

  conn.send({ type: 'CLOSE', stream: a, reason: 0 })
  await until(() => seen.some((e) => e[0] === 'closed'), 'closed by the relay')
  conn.send({ type: 'DATA', stream: a, data: Uint8Array.of(1) })
  await settle()
  assert.equal(seen.filter((e) => e[0] === 'data').length, 1, 'frames after CLOSE are ignored')
  assert.equal(client.sendData(a, Uint8Array.of(1)), false, 'and nothing goes out on it')

  client.stop({ goingAway: true })
  await until(() => conn.closedBy, 'the host socket closed')
  assert.deepEqual(conn.frames.at(-1), { type: 'CLOSE', stream: b, reason: 5 }, 'open streams are told the host is going away')
  assert.deepEqual(seen.at(-1), ['closed', b, 5])
  assert.equal(client.status.state, 'off')
  assert.equal(conn.closedBy?.side, 'host')
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(relay.connections.length, 1, 'stopped means no reconnect')
})

// ---------------------------------------------------------------- identity

test('identity: a credential made once, sealed like one, the same host id after a reload', async () => {
  const a = await m.loadOrCreateIdentity()
  const b = await m.loadOrCreateIdentity()
  assert.equal(b.hostId, a.hostId)
  assert.match(a.hostId, m.HOST_ID_RE)
  assert.ok(m.verifyRegister(b.publicKey, new Uint8Array(32), m.signRegister(b.secretKey, new Uint8Array(32))))

  const entries = (await m.listCredentials()).filter((c) => c.kind === 'remote-identity')
  assert.equal(entries.length, 1, 'one entry, not one per load')
  assert.equal(entries[0].id, m.RELAY_IDENTITY_ID)
  assert.equal(m.isGitKind('remote-identity'), false, 'never auto-matched to a git host')
  const masked = (await m.getCredentials()).credentials.find((c) => c.id === m.RELAY_IDENTITY_ID)
  assert.notEqual(masked.data.secret, entries[0].data.secret, 'the renderer sees a mask, not the key')

  // Unreadable or damaged: an error, never a silent new host id.
  const file = path.join(GURT_ROOT, 'credentials.json')
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  const mine = onDisk.credentials.find((c) => c.id === m.RELAY_IDENTITY_ID)
  delete mine.data.secret
  mine.sealed = { secret: 'AAAA' } // ciphertext this process cannot open
  fs.writeFileSync(file, JSON.stringify(onDisk))
  await assert.rejects(m.loadOrCreateIdentity(), /cannot be unsealed/)
  delete mine.sealed
  mine.data.secret = 'AAAA'
  fs.writeFileSync(file, JSON.stringify(onDisk))
  await assert.rejects(m.loadOrCreateIdentity(), /damaged/)
  assert.equal((await m.listCredentials()).filter((c) => c.kind === 'remote-identity').length, 1, 'and no second key was made')
})
