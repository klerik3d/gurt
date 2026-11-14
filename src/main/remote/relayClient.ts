// Gurt's end of the host socket (docs/requirements-remote-protocol.md §3):
// one long-lived outbound WebSocket to the relay, registration with the relay
// identity, reconnect with backoff, the stream frames handed to whoever serves
// streams, and the push frames.
//
// What the relay can see is the frame envelope; everything inside DATA is
// Noise ciphertext made elsewhere. Nothing here logs a payload or a push token.
import { randomInt } from 'node:crypto'
import {
  CLOSE_REASON,
  type CloseReason,
  decodeFrame,
  encodeFrame,
  type Frame,
  FrameError,
  HOST_CLOSE,
  type PushRequest,
  type PushToken,
  RELAY_PROTOCOL_VERSION,
  signRegister
} from '../../../packages/remote-protocol/src/index'
import { createLogger } from '../log'
import type { HostIdentity } from './identity'

const log = createLogger('remote')

/** The part of a WebSocket the client uses — the global `WebSocket` in
 *  production, an in-memory pair in tests. */
export interface RelaySocket {
  binaryType: string
  readonly readyState: number
  send(data: Uint8Array): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code: number; reason: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
}

export type SocketFactory = (url: string) => RelaySocket

const OPEN = 1

export type RelayState =
  | { state: 'off' }
  | { state: 'connecting'; attempt: number }
  /** Socket open, HELLO answered, waiting for READY. */
  | { state: 'registering' }
  | { state: 'ready'; hostId: string; relayVersion: number }
  /** Lost or refused; the next attempt is scheduled. */
  | { state: 'retrying'; retryInMs: number; reason: string }
  /** Refused for a reason retrying cannot fix (§3.4: 4401, 4426): shown to
   *  the user, not retried until the settings change. */
  | { state: 'failed'; reason: 'bad-signature' | 'version'; detail: string }

/** Whoever serves streams — the channel, once it exists. */
export interface StreamHandler {
  open(stream: number): void
  data(stream: number, data: Uint8Array): void
  /** The relay closed it (client gone), or the host socket went away. */
  closed(stream: number, reason: CloseReason): void
}

export interface RelayClientOptions {
  /** Relay base URL, `wss://…`; the client connects to `<url>/v1/host`. */
  relayUrl: string
  /** Explicit transport endpoint for integration tests (e.g. loopback ws://).
   *  Not a user setting; startRemoteAccess never supplies this override. */
  hostSocketUrl?: string
  identity: HostIdentity
  socketFactory?: SocketFactory
  streams?: StreamHandler
  /** Reconnect bounds (§3.4: 1 s to 60 s). Tests shrink them. */
  backoff?: { minMs: number; maxMs: number }
  onState?: (s: RelayState) => void
  /** `PUSH_GONE`: these devices' tokens are dead. */
  onPushGone?: (deviceIds: string[]) => void
  /** `PUSH_ERR`: a push or token set was refused. */
  onPushError?: (code: number) => void
}

const defaultFactory: SocketFactory = (url) => new WebSocket(url) as unknown as RelaySocket

/** `<base>/v1/host`, the base taken without a trailing slash. */
export const hostSocketUrl = (relayUrl: string): string => `${relayUrl.replace(/\/+$/, '')}/v1/host`

/**
 * Delay before attempt `n` (1-based): exponential from `minMs`, capped at
 * `maxMs`, with "equal jitter" — half fixed, half random — so a relay restart
 * does not bring every host back in the same second, and no delay collapses to
 * zero.
 */
export function backoffDelay(n: number, b: { minMs: number; maxMs: number }, rand01: () => number): number {
  const ceiling = Math.min(b.maxMs, b.minMs * 2 ** Math.max(0, n - 1))
  return Math.round(ceiling / 2 + (ceiling / 2) * rand01())
}

const rand01 = (): number => randomInt(0, 2 ** 32) / 2 ** 32

export class RelayClient {
  private socket: RelaySocket | undefined
  private state: RelayState = { state: 'off' }
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private running = false
  private tokens: PushToken[] = []
  /** The version the relay announced in its HELLO. */
  private relayVersion = 0
  /** Streams the relay opened and nobody has closed yet. */
  private streams = new Set<number>()
  private readonly backoff: { minMs: number; maxMs: number }
  private readonly factory: SocketFactory

  constructor(private readonly opts: RelayClientOptions) {
    this.backoff = opts.backoff ?? { minMs: 1000, maxMs: 60_000 }
    this.factory = opts.socketFactory ?? defaultFactory
  }

  get status(): RelayState {
    return this.state
  }

  get hostId(): string {
    return this.opts.identity.hostId
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.attempt = 0
    this.connect()
  }

  /**
   * Close the host socket and stop reconnecting. `goingAway` first tells every
   * open stream that the host is leaving (reason 5), so the app can say "Gurt
   * is restarting" rather than "offline" (remote-access §9.3).
   */
  stop(opts: { goingAway?: boolean } = {}): void {
    if (!this.running) return
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (opts.goingAway && this.state.state === 'ready')
      for (const s of this.streams) this.sendFrame({ type: 'CLOSE', stream: s, reason: CLOSE_REASON.goingAway })
    this.dropStreams()
    const sock = this.socket
    this.socket = undefined
    if (sock) {
      sock.onclose = sock.onmessage = sock.onerror = sock.onopen = null
      try {
        sock.close(1000, 'host stopping')
      } catch {
        // already closing
      }
    }
    this.setState({ state: 'off' })
  }

  /**
   * The complete set of push tokens for this host's devices (§3.5). Sent now
   * when registered, and again after every registration — the relay keeps it
   * in memory only.
   */
  setPushTokens(tokens: PushToken[]): void {
    this.tokens = tokens.map(({ d, p, t }) => ({ d, p, t }))
    if (this.state.state === 'ready') this.sendFrame({ type: 'PUSH_SET', stream: 0, tokens: this.tokens })
  }

  /** Ask the relay to push to every token of this host. False when not
   *  registered: a push is dropped, never queued (an old "needs you" is worse
   *  than none — the app fetches state when it opens). */
  push(req: PushRequest): boolean {
    if (this.state.state !== 'ready') return false
    return this.sendFrame({ type: 'PUSH', stream: 0, push: req })
  }

  /** One DATA payload on a stream. False when the stream or socket is gone. */
  sendData(stream: number, data: Uint8Array): boolean {
    if (this.state.state !== 'ready' || !this.streams.has(stream)) return false
    return this.sendFrame({ type: 'DATA', stream, data })
  }

  /** Drop a client: the relay closes its socket with 4000 + reason. */
  closeStream(stream: number, reason: CloseReason): void {
    if (!this.streams.delete(stream)) return
    if (this.state.state === 'ready') this.sendFrame({ type: 'CLOSE', stream, reason })
  }

  // ------------------------------------------------------------ internals

  private setState(s: RelayState): void {
    this.state = s
    log.info('relay.state', { ...s })
    this.opts.onState?.(s)
  }

  private connect(): void {
    if (!this.running) return
    this.attempt++
    this.setState({ state: 'connecting', attempt: this.attempt })
    let sock: RelaySocket
    try {
      sock = this.factory(this.opts.hostSocketUrl ?? hostSocketUrl(this.opts.relayUrl))
    } catch (e) {
      this.retry(e instanceof Error ? e.message : 'connect failed')
      return
    }
    this.socket = sock
    sock.binaryType = 'arraybuffer'
    sock.onmessage = (ev) => {
      if (this.socket === sock) this.onMessage(ev.data)
    }
    sock.onclose = (ev) => {
      if (this.socket === sock) this.onClose(ev.code, ev.reason)
    }
    // An error is always followed by a close; the close decides.
    sock.onerror = () => undefined
  }

  private onMessage(data: unknown): void {
    // §3.1: every message is one binary frame; a text message is an error.
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) return this.protocolError('text message')
    const bytes =
      data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    let frame: Frame
    try {
      frame = decodeFrame(bytes)
    } catch (e) {
      return this.protocolError(e instanceof FrameError ? e.code : 'bad frame')
    }
    this.onFrame(frame)
  }

  private onFrame(f: Frame): void {
    const st = this.state.state
    switch (f.type) {
      case 'HELLO': {
        if (st !== 'connecting') return this.protocolError('HELLO twice')
        // The relay names the highest version it speaks. One that cannot
        // speak ours is refused here, without registering (§4.4, §12).
        if (f.version < RELAY_PROTOCOL_VERSION) {
          return this.fail(
            'version',
            `the relay speaks protocol ${f.version}; this Gurt needs ${RELAY_PROTOCOL_VERSION}`
          )
        }
        const id = this.opts.identity
        this.sendFrame({
          type: 'REGISTER',
          stream: 0,
          version: RELAY_PROTOCOL_VERSION,
          pubkey: id.publicKey,
          sig: signRegister(id.secretKey, f.challenge)
        })
        this.setState({ state: 'registering' })
        this.relayVersion = f.version
        return
      }
      case 'READY':
        if (st !== 'registering') return this.protocolError('READY out of order')
        this.attempt = 0
        this.setState({ state: 'ready', hostId: this.hostId, relayVersion: this.relayVersion })
        // §3.5: the complete token set, right after READY — a restarted relay
        // has none until this.
        this.sendFrame({ type: 'PUSH_SET', stream: 0, tokens: this.tokens })
        return
      case 'OPEN':
        if (st !== 'ready') return this.protocolError('OPEN before READY')
        this.streams.add(f.stream)
        this.opts.streams?.open(f.stream)
        return
      case 'DATA':
        if (st !== 'ready') return this.protocolError('DATA before READY')
        // After CLOSE, frames on that stream are ignored (§3.3).
        if (!this.streams.has(f.stream)) return
        if (this.opts.streams) this.opts.streams.data(f.stream, f.data)
        // Nobody serves streams yet: a first message gets nothing but a
        // close, as for an unknown device (remote-access §4.3).
        else this.closeStream(f.stream, CLOSE_REASON.rejected)
        return
      case 'CLOSE':
        if (st !== 'ready') return this.protocolError('CLOSE before READY')
        if (this.streams.delete(f.stream)) this.opts.streams?.closed(f.stream, f.reason)
        return
      case 'PUSH_GONE':
        if (st !== 'ready') return this.protocolError('PUSH_GONE before READY')
        this.opts.onPushGone?.(f.d)
        return
      case 'PUSH_ERR':
        if (st !== 'ready') return this.protocolError('PUSH_ERR before READY')
        log.warn('relay.push-refused', { code: f.code })
        this.opts.onPushError?.(f.code)
        return
      default:
        // REGISTER, PUSH_SET, PUSH: frames only Gurt sends.
        return this.protocolError(`${f.type} from the relay`)
    }
  }

  private onClose(code: number, reason: string): void {
    this.socket = undefined
    this.dropStreams()
    if (code === HOST_CLOSE.badSignature) return this.fail('bad-signature', 'the relay refused the registration signature')
    if (code === HOST_CLOSE.versionNotSupported)
      return this.fail(
        'version',
        `the relay does not speak protocol ${RELAY_PROTOCOL_VERSION}${reason ? ` (it supports: ${reason})` : ''}`
      )
    this.retry(code === HOST_CLOSE.replaced ? 'replaced by another registration' : `closed (${code})`)
  }

  private dropStreams(): void {
    const open = [...this.streams]
    this.streams.clear()
    for (const s of open) this.opts.streams?.closed(s, CLOSE_REASON.goingAway)
  }

  private protocolError(what: string): void {
    log.warn('relay.protocol-error', { what })
    const sock = this.socket
    this.socket = undefined
    this.dropStreams()
    if (sock) {
      sock.onclose = sock.onmessage = sock.onerror = sock.onopen = null
      try {
        sock.close(HOST_CLOSE.protocolError, 'protocol error')
      } catch {
        // already closing
      }
    }
    this.retry(`protocol error: ${what}`)
  }

  private fail(reason: 'bad-signature' | 'version', detail: string): void {
    const sock = this.socket
    this.socket = undefined
    if (sock) {
      sock.onclose = sock.onmessage = sock.onerror = sock.onopen = null
      try {
        sock.close(1000, 'not retried')
      } catch {
        // already closing
      }
    }
    this.running = false
    this.setState({ state: 'failed', reason, detail })
  }

  private retry(reason: string): void {
    if (!this.running) return
    const delay = backoffDelay(Math.max(1, this.attempt), this.backoff, rand01)
    this.setState({ state: 'retrying', retryInMs: delay, reason })
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.connect()
    }, delay)
    this.timer.unref?.()
  }

  private sendFrame(f: Frame): boolean {
    const sock = this.socket
    if (!sock || sock.readyState !== OPEN) return false
    try {
      sock.send(encodeFrame(f))
      return true
    } catch (e) {
      log.warn('relay.send-failed', { type: f.type, err: e })
      return false
    }
  }
}
