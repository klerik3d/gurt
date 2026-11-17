// Real RelayClient ↔ a freshly built Go relay, protocol §3, §4, §8.
//   GURT_RELAY_DIR=../gurt-relay node --test scripts/remote-relay-integration.test.mjs
// Defaults to the sibling repository. Go >= 1.24 must be on PATH. Missing
// prerequisites SKIP; build failures and protocol disagreements FAIL.
// No TLS, push credentials, fake relay, or changes to the relay repository.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { bundle } from './lib/bundle.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const run = promisify(execFile)

async function until(condition, what, timeout = 5000) {
  const deadline = Date.now() + timeout
  do {
    const value = await condition()
    if (value) return value
    await delay(10)
  } while (Date.now() < deadline)
  assert.fail(`timed out waiting for ${what}`)
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(undefined))
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve(undefined)))
  return address.port
}

test('RelayClient ↔ built gurt-relay', { timeout: 180_000 }, async (t) => {
  const relayDir = path.resolve(process.env.GURT_RELAY_DIR || path.join(ROOT, '..', 'gurt-relay'))
  if (!fs.existsSync(path.join(relayDir, 'go.mod')) || !fs.existsSync(path.join(relayDir, 'cmd/gurt-relay'))) {
    t.skip(`gurt-relay repository missing at ${relayDir}; set GURT_RELAY_DIR`)
    return
  }
  let goVersion
  try {
    goVersion = (await run('go', ['version'], { env: { ...process.env, GOTOOLCHAIN: 'local' }, timeout: 10_000 })).stdout
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    t.skip('Go >= 1.24 is required; install Go and put it on PATH')
    return
  }
  const version = /go(\d+)\.(\d+)/.exec(goVersion)
  if (!version || Number(version[1]) < 1 || (Number(version[1]) === 1 && Number(version[2]) < 24)) {
    t.skip(`Go >= 1.24 is required; found ${goVersion.trim()}`)
    return
  }
  t.diagnostic(`${goVersion.trim()}; relay source: ${relayDir}`)

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-real-relay-'))
  const binary = path.join(tmp, process.platform === 'win32' ? 'gurt-relay.exe' : 'gurt-relay')
  const clients = []
  const sockets = []
  let relay
  let m
  t.after(async () => {
    for (const client of clients) client.stop()
    for (const socket of sockets) if (socket.readyState < WebSocket.CLOSING) socket.close()
    try {
      await stopRelay()
    } finally {
      m?.flushSync()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  // Keep all build output and Go caches outside the read-only relay source.
  await run('go', ['build', '-mod=readonly', '-modcacherw', '-o', binary, './cmd/gurt-relay'], {
    cwd: relayDir,
    env: { ...process.env, GOTOOLCHAIN: 'local', GOCACHE: path.join(tmp, 'go-build'), GOMODCACHE: path.join(tmp, 'go-mod') },
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024
  })
  process.env.GURT_ROOT = path.join(tmp, 'gurt-home')
  const source = (p) => JSON.stringify(path.join(ROOT, p))
  const outfile = path.join(tmp, 'client.mjs')
  await bundle({
    stdin: {
      contents: `
        export * from ${source('packages/remote-protocol/src/index.ts')}
        export { RelayClient } from ${source('src/main/remote/relayClient.ts')}
        export { isRelayUrl, normalizeRemoteSettings } from ${source('src/shared/remote.ts')}
        export { flushSync } from ${source('src/main/log.ts')}
      `,
      resolveDir: ROOT,
      loader: 'ts'
    },
    outfile
  })
  m = await import(pathToFileURL(outfile).href)
  const port = await freePort()
  const wsBase = `ws://127.0.0.1:${port}`
  const httpBase = `http://127.0.0.1:${port}`

  async function info() {
    const response = await fetch(`${httpBase}/v1/info`, { signal: AbortSignal.timeout(500), headers: { Connection: 'close' } })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /application\/json/)
    return response.json()
  }

  async function startRelay() {
    // Never inherit TLS, APNs/FCM credentials, proxy rules or limits from a
    // developer's environment. Only the following GURT_RELAY_* values apply.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GURT_RELAY_')))
    env.GURT_RELAY_LISTEN = `127.0.0.1:${port}`
    env.GURT_RELAY_LOG_LEVEL = 'debug'
    const child = spawn(binary, [], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    const instance = { child, stderr: '', exit: undefined }
    child.stderr.on('data', (chunk) => { instance.stderr = (instance.stderr + chunk).slice(-16_000) })
    child.once('error', (error) => { instance.exit = { error } })
    child.once('exit', (code, signal) => { instance.exit = { code, signal } })
    relay = instance
    await until(async () => {
      if (instance.exit) assert.fail(`relay exited on startup: ${JSON.stringify(instance.exit)}\n${instance.stderr}`)
      try { return await info() } catch { return false }
    }, 'relay HTTP listener')
  }

  async function stopRelay() {
    if (!relay) return
    const instance = relay
    relay = undefined
    if (instance.exit) {
      assert.fail(`relay exited unexpectedly: ${JSON.stringify(instance.exit)}\n${instance.stderr}`)
    }
    instance.child.kill('SIGTERM')
    try {
      await until(() => instance.exit, 'relay SIGTERM exit', 8000)
      assert.deepEqual(instance.exit, { code: 0, signal: null }, instance.stderr)
    } finally {
      if (!instance.exit) instance.child.kill('SIGKILL')
    }
  }

  function identity() {
    const id = m.generateRelayIdentity()
    return { ...id, hostId: m.hostIdFromPublicKey(id.publicKey) }
  }

  // Observe actual bytes sent/received by native WebSocket; no fake peer.
  // Only the version-refusal probe changes REGISTER.version on the wire.
  function host(options = {}, registerVersion = undefined) {
    const connections = []
    const states = []
    const errors = []
    const client = new m.RelayClient({
      relayUrl: 'wss://relay.integration.invalid',
      // Explicit constructor-only transport override, outside RemoteSettings.
      hostSocketUrl: `${wsBase}/v1/host`,
      identity: identity(),
      backoff: { minMs: 50, maxMs: 100 },
      ...options,
      onState: (state) => states.push(state),
      onPushError: (code) => errors.push(code),
      socketFactory: (url) => {
        assert.equal(url, `${wsBase}/v1/host`)
        const socket = new WebSocket(url)
        sockets.push(socket)
        const trace = { sent: [], received: [], events: [], closed: undefined }
        connections.push(trace)
        socket.addEventListener('message', ({ data }) => {
          const frame = m.decodeFrame(new Uint8Array(data))
          trace.received.push(frame)
          trace.events.push(`receive ${frame.type}`)
        })
        socket.addEventListener('close', ({ code, reason }) => { trace.closed = { code, reason } })
        const send = socket.send.bind(socket)
        socket.send = (data) => {
          assert.ok(data instanceof Uint8Array)
          let frame = m.decodeFrame(data)
          if (frame.type === 'REGISTER' && registerVersion !== undefined) {
            frame = { ...frame, version: registerVersion }
            data = m.encodeFrame(frame)
          }
          trace.sent.push(frame)
          trace.events.push(`send ${frame.type}`)
          send(data)
        }
        return socket
      }
    })
    clients.push(client)
    return { client, connections, states, errors }
  }

  async function ready(h) {
    await until(() => h.client.status.state === 'ready', 'RelayClient READY')
  }

  async function phone(hostId) {
    const socket = new WebSocket(`${wsBase}/v1/client?host=${hostId}`)
    socket.binaryType = 'arraybuffer'
    sockets.push(socket)
    const p = { socket, messages: [], closed: undefined }
    socket.addEventListener('message', ({ data }) => p.messages.push(new Uint8Array(data)))
    socket.addEventListener('close', ({ code, reason }) => { p.closed = { code, reason } })
    await until(() => socket.readyState === WebSocket.OPEN || p.closed, 'client WebSocket open')
    assert.equal(p.closed, undefined, 'client was accepted')
    return p
  }

  await startRelay()

  await t.test('constructor transport override leaves user ws:// settings invalid', () => {
    assert.equal(m.isRelayUrl(wsBase), false)
    assert.equal(m.normalizeRemoteSettings({ enabled: true, relayUrl: wsBase }).relayUrl, '')
    assert.equal(m.isRelayUrl('wss://relay.integration.invalid'), true)
  })

  await t.test('/v1/info, signed registration, PUSH_SET and PUSH_ERR without APNs/FCM', async (t) => {
    assert.deepEqual(await info(), { protocol: [1], push: [] })
    const h = host()
    t.after(() => h.client.stop())
    assert.equal(h.client.push({ t: 'error', s: 'offline' }), false)
    h.client.start()
    await ready(h)
    await until(() => h.errors.length === 1, 'initial PUSH_SET refusal')
    const trace = h.connections[0]
    assert.deepEqual(trace.received.map((f) => f.type), ['HELLO', 'READY', 'PUSH_ERR'])
    assert.deepEqual(trace.sent.map((f) => f.type), ['REGISTER', 'PUSH_SET'])
    assert.deepEqual(trace.events, ['receive HELLO', 'send REGISTER', 'receive READY', 'send PUSH_SET', 'receive PUSH_ERR'])
    const hello = trace.received[0]
    const register = trace.sent[0]
    assert.equal(hello.version, 1)
    assert.equal(hello.challenge.length, 32)
    assert.equal(register.version, 1)
    assert.equal(m.verifyRegister(register.pubkey, hello.challenge, register.sig), true)
    assert.equal(m.hostIdFromPublicKey(register.pubkey), h.client.hostId)
    assert.deepEqual(h.states.map((s) => s.state), ['connecting', 'registering', 'ready'])
    assert.deepEqual(trace.sent[1].tokens, [])
    const tokens = [{ d: 'ios', p: 'apns', t: 'integration-apns' }, { d: 'android', p: 'fcm', t: 'integration-fcm' }]
    h.client.setPushTokens(tokens)
    await until(() => h.errors.length === 2, 'updated PUSH_SET refusal')
    assert.deepEqual(trace.sent.at(-1), { type: 'PUSH_SET', stream: 0, tokens })
    for (const push of [{ t: 'awaiting', s: 'session' }, { t: 'turn-ended', s: 'session', w: true }]) {
      const count = h.errors.length
      assert.equal(h.client.push(push), true)
      await until(() => h.errors.length === count + 1, 'PUSH refusal')
      assert.deepEqual(trace.sent.at(-1), { type: 'PUSH', stream: 0, push })
    }
    assert.deepEqual(h.errors, [4, 4, 4, 4])
    assert.equal(h.client.status.state, 'ready')
    assert.equal(h.connections.length, 1, 'push errors never close the host socket')
  })

  await t.test('relay process restart: fresh HELLO, signed REGISTER, READY, same token set', async (t) => {
    const h = host()
    t.after(() => h.client.stop())
    const tokens = [{ d: 'restart-device', p: 'fcm', t: 'restart-token' }]
    h.client.setPushTokens(tokens)
    h.client.start()
    await ready(h)
    await until(() => h.errors.length === 1, 'first token-set refusal')
    const first = h.connections[0]
    await stopRelay()
    await until(() => h.states.some((s) => s.state === 'retrying'), 'reconnect backoff')
    await startRelay()
    await ready(h)
    await until(() => h.errors.length === 2, 'token-set refusal after restart')
    const second = h.connections.at(-1)
    assert.notEqual(first, second)
    assert.deepEqual(second.sent.map((f) => f.type), ['REGISTER', 'PUSH_SET'])
    assert.deepEqual(second.sent[1].tokens, tokens)
    assert.notDeepEqual(first.received[0].challenge, second.received[0].challenge)
    const register = second.sent[0]
    assert.equal(m.verifyRegister(register.pubkey, second.received[0].challenge, register.sig), true)
    assert.equal(m.hostIdFromPublicKey(register.pubkey), h.client.hostId)
    assert.equal(h.states.filter((s) => s.state === 'ready').length, 2)
    assert.deepEqual(h.errors, [4, 4])
  })

  await t.test('new registration of the same hostId replaces the older client with 4409', async (t) => {
    const id = identity()
    const a = host({ identity: id })
    const b = host({ identity: id })
    t.after(() => { a.client.stop(); b.client.stop() })
    a.client.start()
    await ready(a)
    b.client.start()
    await until(() => a.connections[0].closed, 'older host close')
    // Stop before its backoff expires, avoiding two hosts replacing each other.
    a.client.stop()
    assert.equal(a.connections[0].closed.code, 4409)
    assert.ok(a.states.some((s) => s.state === 'retrying' && /replaced/.test(s.reason)))
    await ready(b)
    assert.equal(b.client.hostId, id.hostId)
  })

  await t.test('unsupported REGISTER version: real 4426, displayed supported versions, no retry', async (t) => {
    // The signature covers only the challenge (§3.2), so changing the version
    // keeps REGISTER correctly signed. The real relay decides the close code.
    const h = host({}, 2)
    t.after(() => h.client.stop())
    h.client.start()
    await until(() => h.client.status.state === 'failed', 'version failure')
    assert.deepEqual(h.connections[0].closed, { code: 4426, reason: '1' })
    assert.equal(h.connections[0].sent[0].version, 2)
    assert.equal(h.client.status.reason, 'version')
    assert.match(h.client.status.detail, /supports: 1/)
    assert.deepEqual(h.connections[0].sent.map((f) => f.type), ['REGISTER'])
    await delay(150) // longer than the maximum reconnect delay
    assert.equal(h.connections.length, 1)
    assert.ok(!h.states.some((s) => s.state === 'retrying'))
  })

  await t.test('OPEN/DATA/CLOSE: raw client payloads both ways, ordered, stream isolation', async (t) => {
    const opened = [], received = [], closed = []
    const h = host({ streams: {
      open: (s) => opened.push(s),
      data: (s, data) => received.push({ stream: s, data }),
      closed: (s, reason) => closed.push({ stream: s, reason })
    } })
    t.after(() => h.client.stop())
    h.client.start()
    await ready(h)
    const a = await phone(h.client.hostId)
    await until(() => opened.length === 1, 'first OPEN')
    const b = await phone(h.client.hostId)
    await until(() => opened.length === 2, 'second OPEN')
    assert.deepEqual(opened, [1, 2])
    const payloads = [Uint8Array.of(0, 255, 17, 0), new Uint8Array(65_536).fill(0xa5)]
    for (const data of payloads) a.socket.send(data)
    b.socket.send(Uint8Array.of(3))
    await until(() => received.length === 3, 'client DATA')
    assert.deepEqual(received.filter((f) => f.stream === opened[0]).map((f) => f.data), payloads)
    assert.deepEqual(received.filter((f) => f.stream === opened[1]).map((f) => f.data), [Uint8Array.of(3)])
    for (const data of payloads) assert.equal(h.client.sendData(opened[0], data), true)
    await until(() => a.messages.length === 2, 'host DATA')
    assert.deepEqual(a.messages, payloads, 'no host envelope leaks onto /v1/client')
    assert.deepEqual(b.messages, [])
    a.socket.close(1000)
    await until(() => closed.length === 1, 'client CLOSE → host CLOSE 0')
    assert.deepEqual(closed, [{ stream: opened[0], reason: 0 }])
    assert.equal(h.client.sendData(opened[0], Uint8Array.of(1)), false)
    h.client.closeStream(opened[1], 2)
    await until(() => b.closed, 'host CLOSE 2 → client 4002')
    assert.equal(b.closed.code, 4002)
    assert.equal(h.client.sendData(opened[1], Uint8Array.of(1)), false)
    assert.equal(h.client.status.state, 'ready')
  })

  await t.test('first DATA without a stream handler: CLOSE 1 and client 4001, no reply', async (t) => {
    const h = host()
    t.after(() => h.client.stop())
    h.client.start()
    await ready(h)
    const p = await phone(h.client.hostId)
    await until(() => h.connections[0].received.some((f) => f.type === 'OPEN'), 'OPEN without a handler')
    assert.equal(p.closed, undefined, 'OPEN alone is not rejected')
    p.socket.send(Uint8Array.of(1, 1, 2, 3))
    await until(() => p.closed, 'unhandled first DATA rejection')
    const trace = h.connections[0]
    const open = trace.received.find((f) => f.type === 'OPEN')
    assert.deepEqual(trace.sent.filter((f) => f.type === 'CLOSE'), [{ type: 'CLOSE', stream: open.stream, reason: 1 }])
    assert.equal(p.closed.code, 4001)
    assert.deepEqual(p.messages, [])
    assert.ok(!trace.sent.some((f) => f.type === 'DATA'))
  })

  await t.test('stop(goingAway): CLOSE 5 for every open stream, client 4005, no reconnect', async () => {
    const h = host()
    h.client.start()
    await ready(h)
    const a = await phone(h.client.hostId)
    const b = await phone(h.client.hostId)
    await until(() => h.connections[0].received.filter((f) => f.type === 'OPEN').length === 2, 'two OPENs')
    h.client.stop({ goingAway: true })
    await until(() => a.closed && b.closed && h.connections[0].closed, 'goingAway close delivery')
    assert.deepEqual(h.connections[0].sent.filter((f) => f.type === 'CLOSE'), [
      { type: 'CLOSE', stream: 1, reason: 5 }, { type: 'CLOSE', stream: 2, reason: 5 }
    ])
    assert.equal(a.closed.code, 4005)
    assert.equal(b.closed.code, 4005)
    assert.equal(h.connections[0].closed.code, 1000)
    assert.equal(h.client.status.state, 'off')
    await delay(150)
    assert.equal(h.connections.length, 1)
  })
})
