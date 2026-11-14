import { ChannelInitiator, CHANNEL_VERSION, pairingCode, type ChannelTransport } from './channel'
import { utf8Decode } from './bytes'
import type { Keypair } from './noise'
import type { PairingPayload, RelayPointer } from './pairing'
import { apiCompatibility, type RemoteHello, type RemoteEventMessage, type RemoteApi, type RemoteChannelApi } from './remoteApi'
import { parseRpc, rpcRequest, MAX_IN_FLIGHT } from './rpc'

/** One stream; implementations must preserve message order and reject reads on close. */
export interface ProbeStream {
  send(data: Uint8Array): void
  receive(): Promise<Uint8Array>
  close(): void
}
export type ProbeDial = (host: RelayPointer) => Promise<ProbeStream>
type Api = RemoteApi & RemoteChannelApi
export class ProbeRpcError extends Error {
  constructor(readonly code: number, message: string) { super(message) }
}

/** Headless app side. Own one per host; seq survives stream reconnections. */
export class RemoteProbe {
  /** Last asynchronous protocol/transport failure, available to test drivers. */
  lastError: Error | undefined
  readonly sessions: Record<string, number> = {}
  private listeners = new Set<(event: RemoteEventMessage) => void>()
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  private serial = 0
  private connection: { stream: ProbeStream; channel: ChannelTransport; hello: RemoteHello } | undefined

  constructor(private readonly dial: ProbeDial, readonly deviceKey: Keypair) {}

  onEvent(listener: (event: RemoteEventMessage) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private async handshake(host: RelayPointer, secret?: Uint8Array) {
    const stream = await this.dial(host)
    try {
      const init = new ChannelInitiator({ mode: secret ? 'pair' : 'connect', hostId: host.h,
        hostKey: host.k, deviceKey: this.deviceKey, ...(secret ? { pairingSecret: secret } : {}),
        hello: { v: CHANNEL_VERSION, app: 'remote-probe/1', platform: 'android', label: 'Remote probe' } })
      stream.send(init.first)
      return { stream, channel: init.finish(await stream.receive()).transport }
    } catch (e) { stream.close(); throw e }
  }

  async pair(host: PairingPayload, showCode: (code: string) => void): Promise<string> {
    const { stream, channel } = await this.handshake(host, host.s)
    try {
      showCode(pairingCode(channel.handshakeHash))
      let pending = false
      for (;;) {
        const msg = await this.read(stream, channel)
        if (msg?.kind !== 'notification' || msg.method !== 'remote.pairing') throw new Error('expected remote.pairing')
        const state = msg.params as { state?: string; deviceId?: string }
        if (!pending && state?.state === 'pending') { pending = true; continue }
        if (pending && state?.state === 'accepted' && typeof state.deviceId === 'string') return state.deviceId
        if (pending && (state?.state === 'rejected' || state?.state === 'expired')) throw new Error('pairing ' + state.state)
        throw new Error('invalid pairing state')
      }
    } finally { stream.close() }
  }

  async connect(host: RelayPointer): Promise<RemoteHello> {
    this.close()
    this.lastError = undefined
    const { stream, channel } = await this.handshake(host)
    try {
      const msg = await this.read(stream, channel)
      if (msg?.kind !== 'notification' || msg.method !== 'remote.hello') throw new Error('expected remote.hello')
      const hello = msg.params as RemoteHello
      if (!hello || hello.v !== 1 || !hello.api || !Number.isInteger(hello.api.min) ||
          !Number.isInteger(hello.api.version) || hello.api.min < 1 || hello.api.min > hello.api.version ||
          !Array.isArray(hello.methods) || !hello.methods.every(m => typeof m === 'string') ||
          !Array.isArray(hello.events) || !hello.events.every(e => typeof e === 'string')) throw new Error('invalid remote.hello')
      const compatibility = apiCompatibility(hello.api)
      if (!compatibility.ok) throw new Error('update ' + compatibility.update)
      const connection = { stream, channel, hello }
      this.connection = connection
      void this.pump(connection)
      return hello
    } catch (e) { stream.close(); throw e }
  }

  async call<M extends keyof Api>(method: M, params: Parameters<Api[M]>[0]): Promise<Awaited<ReturnType<Api[M]>>> {
    const c = this.connection
    if (!c) throw new Error('not connected')
    if (!method.startsWith('remote.') && !c.hello.methods.includes(method)) throw new Error('method unavailable')
    if (this.pending.size >= MAX_IN_FLIGHT) throw new Error('too many requests')
    const id = ++this.serial
    return new Promise<Awaited<ReturnType<Api[M]>>>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as Awaited<ReturnType<Api[M]>>), reject })
      try { for (const frame of c.channel.seal(JSON.stringify(rpcRequest(id, method, params)))) c.stream.send(frame) }
      catch (e) { this.pending.delete(id); reject(e) }
    })
  }

  /** Seed with session.get.logSeq after applying the snapshot. */
  trackSession(id: string, seq: number): void { this.sessions[id] = seq }
  resume(): Promise<Record<string, 'ok' | 'reset'>> { return this.call('remote.resume', { sessions: { ...this.sessions } }) }

  private async read(stream: ProbeStream, channel: ChannelTransport) {
    for (;;) {
      const bytes = channel.open(await stream.receive())
      if (bytes !== undefined) {
        const msg = parseRpc(utf8Decode(bytes))
        if (!msg) throw new Error('invalid JSON-RPC')
        return msg
      }
    }
  }

  private async pump(c: NonNullable<RemoteProbe['connection']>) {
    try {
      while (this.connection === c) {
        const msg = await this.read(c.stream, c.channel)
        if (this.connection !== c) return
        if (msg.kind === 'success' || msg.kind === 'failure') {
          const pending = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined
          if (pending) {
            this.pending.delete(msg.id as number)
            if (msg.kind === 'success') pending.resolve(msg.result)
            else pending.reject(new ProbeRpcError(msg.error.code, msg.error.message))
          }
        } else if (msg.kind === 'notification' && msg.method === 'remote.event') {
          const event = msg.params as RemoteEventMessage
          if (!event || !c.hello.events.includes(event.ch)) throw new Error('unexpected event')
          if (event.ch === 'session-log') {
            const { id, record } = event.p
            if (!Number.isSafeInteger(record.seq) || record.seq < 1) throw new Error('invalid seq')
            const last = this.sessions[id]
            if (last === undefined || record.seq <= last) continue
            if (record.seq !== last + 1) throw new Error('session log gap; refetch snapshot')
            this.sessions[id] = record.seq
          }
          for (const listener of this.listeners) listener(event)
        } else if (msg.kind === 'request') {
          for (const frame of c.channel.seal(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }))) c.stream.send(frame)
        } else throw new Error('unexpected channel message')
      }
    } catch (error) {
      if (this.connection === c) {
        this.lastError = error instanceof Error ? error : new Error('channel failed')
        this.close()
      }
    }
  }

  close(): void {
    const c = this.connection
    this.connection = undefined
    c?.stream.close()
    for (const p of this.pending.values()) p.reject(new Error('stream closed'))
    this.pending.clear()
  }
}
