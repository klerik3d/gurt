// The channel, Gurt ↔ App (requirements-remote-protocol.md §6): which Noise
// pattern a stream speaks, the prologue, the handshake payloads, the pairing
// code (SAS) and the chunked transport.
//
// The app is always the initiator; Gurt the responder. A stream's first DATA
// is `mode:u8 | noise message 1`; every later DATA a bare Noise message.

import { blake2s } from '@noble/hashes/blake2.js'
import { concatBytes, readU32, utf8Decode, utf8Encode } from './bytes'
import { CLOSE_REASON, type CloseReason } from './frames'
import {
  type CipherState,
  HandshakeState,
  type Keypair,
  MAX_NOISE_MESSAGE,
  NoiseError,
  type NoisePattern
} from './noise'

/** Channel version (§2), carried as `v` in both handshake payloads. */
export const CHANNEL_VERSION = 1

export const MODE = { connect: 0x01, pair: 0x02 } as const
export type ChannelMode = keyof typeof MODE

const PATTERN_OF: Record<ChannelMode, NoisePattern> = { connect: 'IK', pair: 'IKpsk1' }

/** `utf8("gurt-remote/1 ") | mode:u8 | utf8(" " + hostId)` (§6.1). */
export function channelPrologue(mode: ChannelMode, hostId: string): Uint8Array {
  return concatBytes(utf8Encode('gurt-remote/1 '), Uint8Array.of(MODE[mode]), utf8Encode(' ' + hostId))
}

/**
 * The pairing code (§6.3): `u32(BLAKE2s(h | utf8("gurt-remote/1 sas"))[0..4])
 * mod 1 000 000`, the u32 big-endian like every integer on the wire, shown as
 * six digits, zero-padded.
 */
export function pairingCode(handshakeHash: Uint8Array): string {
  const d = blake2s(concatBytes(handshakeHash, utf8Encode('gurt-remote/1 sas')))
  return String(readU32(d, 0) % 1_000_000).padStart(6, '0')
}

export type DevicePlatform = 'ios' | 'android'

/** Message 1's payload, App → Gurt (§6.2). */
export interface ClientHello {
  v: number
  /** The app's build version. */
  app: string
  platform: DevicePlatform
  /** The device's own label; read only in pair mode, as the default name. */
  label?: string
}

/** Message 2's payload, Gurt → App (§6.2). */
export interface ServerHello {
  v: number
}

/**
 * A stream the host must close: `reason` is the §3.3 CLOSE reason. For a
 * failed handshake Gurt sends nothing else (§6.2), and nothing in `message` is
 * meant for the client.
 */
export class ChannelError extends Error {
  constructor(
    readonly reason: CloseReason,
    message: string
  ) {
    super(message)
    this.name = 'ChannelError'
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function parseJsonPayload(bytes: Uint8Array): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(utf8Decode(bytes))
    return isObject(v) ? v : undefined
  } catch {
    return undefined
  }
}

/** Canonical JSON for the handshake payloads: keys in §6.2's order. */
export function encodeClientHello(h: ClientHello): Uint8Array {
  return utf8Encode(
    JSON.stringify({
      v: h.v,
      app: h.app,
      platform: h.platform,
      ...(h.label !== undefined ? { label: h.label } : {})
    })
  )
}

// ------------------------------------------------------------- the transport

/** Largest plaintext in one Noise transport message: 65 535 − the 16-byte tag. */
export const MAX_PLAINTEXT = MAX_NOISE_MESSAGE - 16
/** Largest chunk: the plaintext less its flags byte. */
export const MAX_CHUNK = MAX_PLAINTEXT - 1
/** Largest reassembled application message (§6.4), the same cap as
 *  `MAX_FRAME` in Gurt's src/main/jsonrpc.ts. */
export const MAX_MESSAGE = 16 * 1024 * 1024

const MORE = 0x01

/**
 * The established channel: chunking (§6.4) over one Noise cipher per
 * direction. Each value `seal` returns is one `DATA` payload; `open` takes one
 * and returns the application message once its last chunk is in.
 *
 * Failures are `ChannelError`s carrying the reason the stream closes with: an
 * AEAD failure or an unknown flag bit is a protocol error (2), a message past
 * 16 MiB is too large (3). The transport is unusable after one.
 */
export class ChannelTransport {
  private parts: Uint8Array[] = []
  private size = 0
  private dead = false

  constructor(
    private readonly sendCipher: CipherState,
    private readonly receiveCipher: CipherState,
    /** The final handshake hash, for channel binding and the SAS. */
    readonly handshakeHash: Uint8Array,
    /** The peer's static public key. */
    readonly remoteStatic: Uint8Array
  ) {}

  /** Split one application message into encrypted DATA payloads. */
  seal(message: Uint8Array | string): Uint8Array[] {
    if (this.dead) throw new ChannelError(CLOSE_REASON.protocolError, 'channel closed')
    const bytes = typeof message === 'string' ? utf8Encode(message) : message
    if (bytes.length > MAX_MESSAGE) throw new ChannelError(CLOSE_REASON.tooLarge, 'message larger than 16 MiB')
    const out: Uint8Array[] = []
    let at = 0
    do {
      const chunk = bytes.subarray(at, at + MAX_CHUNK)
      at += chunk.length
      const flags = at < bytes.length ? MORE : 0
      out.push(this.sendCipher.encrypt(concatBytes(Uint8Array.of(flags), chunk)))
    } while (at < bytes.length)
    return out
  }

  /** Take one DATA payload; the whole message when it was the last chunk. */
  open(data: Uint8Array): Uint8Array | undefined {
    if (this.dead) throw new ChannelError(CLOSE_REASON.protocolError, 'channel closed')
    let plain: Uint8Array
    try {
      plain = this.receiveCipher.decrypt(data)
    } catch (e) {
      this.dead = true
      throw new ChannelError(CLOSE_REASON.protocolError, e instanceof NoiseError ? e.message : 'decryption failed')
    }
    const flags = plain[0]
    if (flags === undefined || (flags & ~MORE) !== 0) {
      this.dead = true
      throw new ChannelError(CLOSE_REASON.protocolError, 'bad chunk flags')
    }
    const chunk = plain.subarray(1)
    this.size += chunk.length
    if (this.size > MAX_MESSAGE) {
      this.dead = true
      this.parts = []
      throw new ChannelError(CLOSE_REASON.tooLarge, 'message larger than 16 MiB')
    }
    this.parts.push(chunk)
    if (flags & MORE) return undefined
    const msg = this.parts.length === 1 ? (this.parts[0] as Uint8Array).slice() : concatBytes(...this.parts)
    this.parts = []
    this.size = 0
    return msg
  }
}

// ---------------------------------------------------------- the app's side

export interface InitiatorOptions {
  mode: ChannelMode
  hostId: string
  /** The host's Noise static public key (from the QR code, then storage). */
  hostKey: Uint8Array
  /** The device's static key pair. */
  deviceKey: Keypair
  /** Pair mode only: the 32-byte pairing secret `s` from the QR code. */
  pairingSecret?: Uint8Array
  hello: ClientHello
  /** Test vectors only. */
  ephemeral?: Keypair
}

/**
 * The app's half of the handshake. `first` is the stream's first DATA
 * payload; hand Gurt's answer to `finish`.
 */
export class ChannelInitiator {
  readonly first: Uint8Array
  private readonly hs: HandshakeState

  constructor(opts: InitiatorOptions) {
    const pattern = PATTERN_OF[opts.mode]
    if ((opts.mode === 'pair') !== (opts.pairingSecret !== undefined))
      throw new Error('a pairing secret is given in pair mode, and only there')
    this.hs = new HandshakeState({
      pattern,
      initiator: true,
      prologue: channelPrologue(opts.mode, opts.hostId),
      s: opts.deviceKey,
      rs: opts.hostKey,
      ...(opts.pairingSecret ? { psk: opts.pairingSecret } : {}),
      ...(opts.ephemeral ? { e: opts.ephemeral } : {})
    })
    this.first = concatBytes(Uint8Array.of(MODE[opts.mode]), this.hs.writeMessage(encodeClientHello(opts.hello)))
  }

  /** Read message 2. Throws `ChannelError` (reason 2) when it does not
   *  decrypt or its payload is not a version this side speaks. */
  finish(message2: Uint8Array): { transport: ChannelTransport; hello: ServerHello } {
    let payload: Uint8Array
    try {
      payload = this.hs.readMessage(message2)
    } catch {
      throw new ChannelError(CLOSE_REASON.protocolError, 'handshake failed')
    }
    const v = parseJsonPayload(payload)
    if (!v || v['v'] !== CHANNEL_VERSION)
      throw new ChannelError(CLOSE_REASON.protocolError, 'unsupported channel version')
    const r = this.hs.finish()
    return {
      transport: new ChannelTransport(r.send, r.receive, r.handshakeHash, r.remoteStatic),
      hello: { v: CHANNEL_VERSION }
    }
  }
}

// --------------------------------------------------------- Gurt's side

export interface ResponderOptions {
  hostId: string
  /** The host's Noise static key pair. */
  hostKey: Keypair
  /** The live pairing secret, if one is. Without it a pair-mode stream is
   *  rejected before any cryptography runs. */
  pairingSecret?: Uint8Array | undefined
  /** Test vectors only. */
  ephemeral?: Keypair
}

/** Message 1, read and checked; the host decides on the device, then calls
 *  `accept`. */
export interface PendingHandshake {
  mode: ChannelMode
  /** The device's static public key. */
  deviceKey: Uint8Array
  hello: ClientHello
  /** Write message 2 and finish: `message` is the DATA payload to send back. */
  accept(): { message: Uint8Array; transport: ChannelTransport }
}

function parseClientHello(payload: Uint8Array): ClientHello {
  const v = parseJsonPayload(payload)
  // §6.2: a version Gurt does not support is rejected (1), like a bad key.
  if (!v || v['v'] !== CHANNEL_VERSION) throw new ChannelError(CLOSE_REASON.rejected, 'unsupported channel version')
  const { app, platform, label } = v
  if (typeof app !== 'string' || (platform !== 'ios' && platform !== 'android'))
    throw new ChannelError(CLOSE_REASON.protocolError, 'malformed handshake payload')
  if (label !== undefined && typeof label !== 'string')
    throw new ChannelError(CLOSE_REASON.protocolError, 'malformed handshake payload')
  return { v: CHANNEL_VERSION, app, platform, ...(label !== undefined ? { label } : {}) }
}

/**
 * Gurt reads a stream's first DATA payload. Throws `ChannelError` with the
 * reason to close with — 1 (rejected) when there is no live pairing secret or
 * the message does not decrypt, 2 for a payload too short to hold a mode and a
 * message or an unknown mode byte. The caller then checks `deviceKey` against
 * its device list (connect mode) and either `accept`s or closes with 1.
 */
export function readFirstMessage(first: Uint8Array, opts: ResponderOptions): PendingHandshake {
  const modeByte = first[0]
  const mode: ChannelMode | undefined =
    modeByte === MODE.connect ? 'connect' : modeByte === MODE.pair ? 'pair' : undefined
  if (!mode) throw new ChannelError(CLOSE_REASON.protocolError, 'unknown channel mode')
  if (mode === 'pair' && !opts.pairingSecret) throw new ChannelError(CLOSE_REASON.rejected, 'no pairing secret is live')
  const hs = new HandshakeState({
    pattern: PATTERN_OF[mode],
    initiator: false,
    prologue: channelPrologue(mode, opts.hostId),
    s: opts.hostKey,
    ...(mode === 'pair' ? { psk: opts.pairingSecret as Uint8Array } : {}),
    ...(opts.ephemeral ? { e: opts.ephemeral } : {})
  })
  let payload: Uint8Array
  try {
    payload = hs.readMessage(first.subarray(1))
  } catch {
    // A wrong PSK, a wrong host key or a mangled message all look the same.
    throw new ChannelError(CLOSE_REASON.rejected, 'handshake failed')
  }
  const hello = parseClientHello(payload)
  const deviceKey = hs.remoteStatic as Uint8Array
  let accepted = false
  return {
    mode,
    deviceKey,
    hello,
    accept() {
      if (accepted) throw new Error('already accepted')
      accepted = true
      const message = hs.writeMessage(utf8Encode(JSON.stringify({ v: CHANNEL_VERSION })))
      const r = hs.finish()
      return { message, transport: new ChannelTransport(r.send, r.receive, r.handshakeHash, r.remoteStatic) }
    }
  }
}
