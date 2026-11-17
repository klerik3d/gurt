// Test oracle only: no production host implementation lives here.
export function probeHost(p, now = () => Date.now()) {
  const key = p.generateKeypair()
  const secret = crypto.getRandomValues(new Uint8Array(32))
  const expires = now() + 300000
  let used = false
  const devices = new Set()
  const pending = []
  const logs = []
  const live = new Set()
  let answered = false
  const host = {
    devices, pending, logs, received: [], sent: [],
    pointer: { v: 1, r: 'wss://relay.example', h: 'a'.repeat(32), k: key.publicKey, n: 'test', s: secret },
    api: { version: 1, min: 1 },
    attach(send, close) {
      let channel
      let paired = false
      const notify = (method, params) => {
        for (const data of channel.seal(JSON.stringify(p.rpcNotification(method, params)))) { host.sent.push(data); send(data) }
      }
      const event = record => notify('remote.event', { ch: 'session-log', p: { id: 's', record } })
      const receive = data => {
        host.received.push(data)
        try {
          if (!channel) {
            const hs = p.readFirstMessage(data, { hostId: host.pointer.h, hostKey: key,
              ...(!used && now() < expires ? { pairingSecret: secret } : {}) })
            const id = p.toHex(hs.deviceKey)
            if (hs.mode === 'connect' && !devices.has(id)) return close(1)
            if (hs.mode === 'pair') used = true
            const accepted = hs.accept()
            channel = accepted.transport
            host.sent.push(accepted.message)
            send(accepted.message)
            if (hs.mode === 'pair') {
              paired = true
              notify('remote.pairing', { state: 'pending' })
              pending.push({ code: p.pairingCode(channel.handshakeHash), confirm(ok = true) {
                const state = now() >= expires ? 'expired' : ok ? 'accepted' : 'rejected'
                if (state === 'accepted') devices.add(id)
                notify('remote.pairing', { state, ...(state === 'accepted' ? { deviceId: id } : {}) }); close(0)
              } })
            } else {
              notify('remote.hello', { v: 1, api: host.api, methods: [...p.REMOTE_API_METHODS], events: [...p.REMOTE_EVENTS], gurt: 'test', device: { id, name: 'test' }, host: { name: 'test' } })
              live.add(event)
            }
            return
          }
          const bytes = channel.open(data)
          if (!bytes) return
          if (paired) return close(2)
          const msg = p.parseRpc(p.utf8Decode(bytes))
          if (msg?.kind !== 'request') return close(2)
          let result = null
          let error
          if (msg.method === 'tree.get') result = { workspaces: [] }
          else if (msg.method === 'remote.resume') {
            result = {}
            for (const [id, seq] of Object.entries(msg.params.sessions)) {
              result[id] = 'ok'
              for (const record of logs.filter(r => r.seq > seq)) event(record)
              if (logs.length) event(logs.at(-1)) // live/replay overlap
            }
          } else if (msg.method === 'permission.answer') {
            if (answered) error = p.rpcFailure(msg.id, -32010, 'stale')
            else answered = true
          } else if (!p.REMOTE_API_METHODS.includes(msg.method) && !p.REMOTE_CHANNEL_METHODS.includes(msg.method)) error = p.rpcFailure(msg.id, -32601, 'method not found')
          for (const data of channel.seal(JSON.stringify(error ?? p.rpcSuccess(msg.id, result)))) send(data)
        } catch (e) { close(e.reason ?? 2) }
      }
      return { receive, dispose() { live.delete(event) } }
    },
    append(text) {
      const record = { seq: logs.length + 1, type: 'append', id: 1, text }
      logs.push(record)
      for (const event of live) event(record)
    }
  }
  return host
}

export function memoryDial(host) {
  return async () => {
    const queue = []
    let waiting
    let dead = false
    const end = host.attach(data => {
      if (dead) return
      if (waiting) { const w = waiting; waiting = undefined; w.resolve(data) } else queue.push(data)
    }, reason => {
      dead = true
      waiting?.reject(new Error(`closed ${reason}`)); waiting = undefined
    })
    return {
      send: data => { if (dead) throw new Error('closed'); end.receive(data) },
      receive: () => queue.length ? Promise.resolve(queue.shift()) : dead ? Promise.reject(new Error('closed')) : new Promise((resolve, reject) => { waiting = { resolve, reject } }),
      close: () => { dead = true; end.dispose(); waiting?.reject(new Error('closed')); waiting = undefined }
    }
  }
}
