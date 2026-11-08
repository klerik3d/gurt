// An in-process stand-in for gurt-relay's host side
// (docs/requirements-remote-protocol.md §3), for tests of Gurt's relay client.
// No network: `relay.factory` hands the client one end of an in-memory socket
// pair, and the relay plays the other end with the real frame codec from
// packages/remote-protocol. Delivery is asynchronous (one macrotask), like a
// socket's.
//
// It does what the relay contract says and records what it saw: HELLO with a
// fresh challenge, REGISTER checked against the signature and the version,
// READY, a newer registration of a host id replacing the older one (4409),
// push token sets held in memory per host, pushes recorded, push frames
// refused with PUSH_ERR, everything else malformed closed with 4400.

const OPEN = 1
const CLOSED = 3
const tick = () => new Promise((r) => setImmediate(r))

/**
 * @param {any} p the protocol package (frames, register helpers)
 * @param {{ version?: number, supported?: number[], refuseSignature?: boolean, push?: boolean }} [opts]
 */
export function createFakeRelay(p, opts = {}) {
  const relay = {
    /** Every host connection ever made, oldest first. */
    connections: [],
    /** hostId → the live, registered connection. */
    hosts: new Map(),
    /** hostId → the last PUSH_SET's tokens. Memory only, like the real one. */
    tokens: new Map(),
    /** Every accepted push: `{ hostId, push, tokens }`. */
    pushes: [],
    /** URLs the client asked for. */
    urls: [],
    /** The client side's socket factory. */
    factory: (url) => {
      relay.urls.push(url)
      return connect(url).client
    },
    /** A relay restart: every socket drops, all memory is gone. */
    restart(code = 1012) {
      for (const c of relay.connections) if (c.open) c.close(code, 'restart')
      relay.hosts.clear()
      relay.tokens.clear()
    },
    /** The current connection (the latest one). */
    get last() {
      return relay.connections[relay.connections.length - 1]
    }
  }

  let nextStream = 1

  function connect(url) {
    /** The socket Gurt holds. */
    const client = {
      binaryType: 'blob',
      readyState: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send(data) {
        if (client.readyState !== OPEN) throw new Error('socket not open')
        const copy = Uint8Array.from(data)
        void tick().then(() => conn.receive(copy))
      },
      close(code = 1000, reason = '') {
        if (client.readyState === CLOSED) return
        client.readyState = CLOSED
        // After what was sent before it, as a real socket flushes on close.
        void tick().then(() => {
          if (!conn.open) return
          conn.open = false
          conn.closedBy = { side: 'host', code, reason }
          relay.dropHost(conn)
        })
      }
    }

    const conn = {
      url,
      client,
      open: true,
      state: 'hello',
      hostId: undefined,
      challenge: p.generateRelayIdentity().secretKey, // 32 random bytes
      /** Frames the relay received, decoded. */
      frames: [],
      streams: new Set(),
      closedBy: undefined,
      /** Relay → Gurt, a frame. */
      send(frame) {
        conn.sendRaw(p.encodeFrame(frame))
      },
      /** Relay → Gurt, raw bytes or a text message. */
      sendRaw(data) {
        if (!conn.open) return
        const buf = typeof data === 'string' ? data : Uint8Array.from(data).buffer
        void tick().then(() => conn.open && client.onmessage?.({ data: buf }))
      },
      /** The relay closes the host socket. */
      close(code, reason = '') {
        if (!conn.open) return
        conn.open = false
        conn.closedBy = { side: 'relay', code, reason }
        relay.dropHost(conn)
        void tick().then(() => {
          client.readyState = CLOSED
          client.onclose?.({ code, reason })
        })
      },
      /** A client connected for this host. */
      openStream() {
        const s = nextStream++
        conn.streams.add(s)
        conn.send({ type: 'OPEN', stream: s })
        return s
      },
      receive(bytes) {
        if (!conn.open) return
        let f
        try {
          f = p.decodeFrame(bytes)
        } catch (e) {
          if (e.code === 'bad-push' && conn.state === 'ready') return conn.send({ type: 'PUSH_ERR', stream: 0, code: 1 })
          return conn.close(4400, e.code)
        }
        conn.frames.push(f)
        if (conn.state !== 'ready' && f.type !== 'REGISTER') return conn.close(4400, 'frame before READY')
        switch (f.type) {
          case 'REGISTER': {
            if (conn.state !== 'hello') return conn.close(4400, 'REGISTER twice')
            if (!(opts.supported ?? [1]).includes(f.version)) return conn.close(4426, (opts.supported ?? [1]).join(','))
            if (opts.refuseSignature || !p.verifyRegister(f.pubkey, conn.challenge, f.sig)) return conn.close(4401, 'bad signature')
            const hostId = p.hostIdFromPublicKey(f.pubkey)
            const older = relay.hosts.get(hostId)
            if (older && older !== conn) older.close(4409, 'replaced')
            conn.hostId = hostId
            conn.state = 'ready'
            relay.hosts.set(hostId, conn)
            return conn.send({ type: 'READY', stream: 0 })
          }
          case 'PUSH_SET':
            if (f.tokens.length > p.MAX_PUSH_TOKENS) return conn.send({ type: 'PUSH_ERR', stream: 0, code: 2 })
            relay.tokens.set(conn.hostId, f.tokens)
            return
          case 'PUSH':
            if (opts.push === false) return conn.send({ type: 'PUSH_ERR', stream: 0, code: 4 })
            relay.pushes.push({ hostId: conn.hostId, push: f.push, tokens: relay.tokens.get(conn.hostId) ?? [] })
            return
          case 'DATA':
          case 'CLOSE':
            if (f.type === 'CLOSE') conn.streams.delete(f.stream)
            return
          default:
            return conn.close(4400, `${f.type} from a host`)
        }
      }
    }

    relay.connections.push(conn)
    void tick().then(() => {
      if (!conn.open) return
      client.readyState = OPEN
      client.onopen?.({})
      conn.send({ type: 'HELLO', stream: 0, version: opts.version ?? 1, challenge: conn.challenge })
    })
    return conn
  }

  /** A host socket went away: its registration and its tokens with it (§3.2). */
  relay.dropHost = (conn) => {
    if (conn.hostId && relay.hosts.get(conn.hostId) === conn) {
      relay.hosts.delete(conn.hostId)
      relay.tokens.delete(conn.hostId)
    }
  }

  return relay
}
