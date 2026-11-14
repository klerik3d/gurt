import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadProtocol } from './load.mjs'
import { probeHost, memoryDial } from './probe-host.mjs'
import { createFakeRelay } from '../../../scripts/lib/fake-relay.mjs'
import { dialProbe } from '../../../scripts/lib/probe-socket.mjs'
const p = await loadProtocol()
const turn = () => new Promise(resolve => setImmediate(resolve))
async function until(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await turn() } throw new Error('condition timeout') }

async function relayDial(host) {
  const relay = createFakeRelay(p)
  const identity = p.generateRelayIdentity()
  host.pointer.h = p.hostIdFromPublicKey(identity.publicKey)
  const socket = relay.factory('wss://relay.example/v1/host')
  const ends = new Map()
  socket.onmessage = ({ data }) => {
    const f = p.decodeFrame(new Uint8Array(data))
    if (f.type === 'HELLO') socket.send(p.encodeFrame({ type: 'REGISTER', stream: 0, version: 1, pubkey: identity.publicKey, sig: p.signRegister(identity.secretKey, f.challenge) }))
    if (f.type === 'OPEN') ends.set(f.stream, host.attach(data => socket.send(p.encodeFrame({ type: 'DATA', stream: f.stream, data })), reason => { ends.get(f.stream)?.dispose(); socket.send(p.encodeFrame({ type: 'CLOSE', stream: f.stream, reason })) }))
    if (f.type === 'DATA') ends.get(f.stream)?.receive(f.data)
    if (f.type === 'CLOSE') { ends.get(f.stream)?.dispose(); ends.delete(f.stream) }
  }
  await until(() => relay.hosts.size)
  return h => dialProbe(h, 'ws://relay.example', relay.factory)
}

for (const transport of ['memory', 'relay']) {
  test(`${transport}: acceptance scenarios reusable against a host`, async () => {
    const host = probeHost(p)
    const dial = transport === 'memory' ? memoryDial(host) : await relayDial(host)
    const probe = new p.RemoteProbe(dial, p.generateKeypair())
    await assert.rejects(probe.connect(host.pointer))
    assert.equal(host.received.length, 1)
    assert.equal(host.sent.length, 0)
    let code
    const pairing = probe.pair(p.parsePairingUrl(p.buildPairingUrl(host.pointer)), value => { code = value })
    await until(() => code)
    assert.equal(host.devices.size, 0)
    assert.equal(code, host.pending[0].code)
    host.pending[0].confirm()
    await pairing
    assert.equal(host.devices.size, 1)
    await assert.rejects(new p.RemoteProbe(dial, p.generateKeypair()).pair(host.pointer, () => {}))
    const hello = await probe.connect(host.pointer)
    assert.deepEqual(hello.methods, [...p.REMOTE_API_METHODS])
    assert.deepEqual(await probe.call('tree.get', {}), { workspaces: [] })
    await probe.call('permission.answer', { sessionId: 's', promptId: 'p', optionId: 'yes' })
    await assert.rejects(probe.call('permission.answer', { sessionId: 's', promptId: 'p', optionId: 'yes' }), e => e.code === -32010)
    const seen = []
    probe.trackSession('s', 0)
    probe.onEvent(e => { if (e.ch === 'session-log') seen.push(e.p.record.seq) })
    host.append('secret chat text')
    await until(() => seen.length === 1)
    probe.close()
    await turn()
    host.append('second'); host.append('third')
    await probe.connect(host.pointer)
    assert.deepEqual(await probe.resume(), { s: 'ok' })
    host.append('fourth')
    await until(() => seen.length === 4)
    assert.deepEqual(seen, [1, 2, 3, 4])
    assert.ok(host.received.every(bytes => !Buffer.from(bytes).includes(Buffer.from('tree.get'))))
    probe.close()
  })
}
test('QR expiry with injected clock, rejected confirmation, API range', async () => {
  let now = 0
  const host = probeHost(p, () => now)
  const probe = new p.RemoteProbe(memoryDial(host), p.generateKeypair())
  now = 300000
  await assert.rejects(probe.pair(host.pointer, () => {}))
  assert.equal(host.devices.size, 0)
  const fresh = probeHost(p)
  const client = new p.RemoteProbe(memoryDial(fresh), p.generateKeypair())
  const pairing = client.pair(fresh.pointer, () => {})
  await until(() => fresh.pending.length)
  fresh.pending[0].confirm(false)
  await assert.rejects(pairing, /rejected/)
  assert.equal(fresh.devices.size, 0)
  fresh.devices.add(p.toHex(client.deviceKey.publicKey))
  fresh.api = { min: 2, version: 2 }
  await assert.rejects(client.connect(fresh.pointer), /update app/)
})
