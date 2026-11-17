// The host socket, Gurt ↔ relay (requirements-remote-protocol.md §3): one
// binary WebSocket message is one frame, `type:u8 | stream:u32 | payload`.
//
// `decodeFrame` is the strict half — everything it accepts the relay accepts
// too, and the relay's vectors (testdata/relay/, pinned) pin both. Rules beyond
// the table in §3.1, each a `FrameError` code:
//
//   truncated     fewer than 5 bytes (no full header)
//   unknown-type  a type not in §3.1
//   bad-stream    a connection frame (HELLO, REGISTER, READY, PUSH_*) on a
//                 stream other than 0, or a stream frame (OPEN, DATA, CLOSE)
//                 on stream 0
//   bad-length    a fixed-size payload of the wrong size, or a payload on a
//                 frame that has none (READY, OPEN)
//   too-large     DATA, or the JSON of a push frame, over 65 536 bytes
//   bad-reason    a CLOSE reason not in §3.3
//   bad-code      a PUSH_ERR code not in §3.5
//   bad-push      a PUSH_SET / PUSH / PUSH_GONE payload that is not UTF-8
//                 JSON of the §3.5 shape, including an unknown `p` platform or
//                 `t` type, or a PUSH `p` that is not unpadded base64url of at
//                 most 2 048 characters. The relay answers these with
//                 PUSH_ERR 1, never by closing the socket (§3.5).
//
// Every other codec error is a protocol error: WS close 4400 (§3.4).

import { concatBytes, readU16, readU32, u16, u32, utf8Decode, utf8Encode } from './bytes'

/** Relay protocol version (§2): the host and client sockets. */
export const RELAY_PROTOCOL_VERSION = 1

export const FRAME_TYPE = {
  HELLO: 0x01,
  REGISTER: 0x02,
  READY: 0x03,
  OPEN: 0x10,
  DATA: 0x11,
  CLOSE: 0x12,
  PUSH_SET: 0x20,
  PUSH: 0x21,
  PUSH_GONE: 0x22,
  PUSH_ERR: 0x23
} as const

export type FrameTypeName = keyof typeof FRAME_TYPE

/** Largest DATA payload (§3.1) — and the largest client-socket message (§4.2). */
export const MAX_DATA = 65536

/** `CLOSE` reasons (§3.3). */
export const CLOSE_REASON = {
  normal: 0,
  rejected: 1,
  protocolError: 2,
  tooLarge: 3,
  idle: 4,
  goingAway: 5,
  rateLimited: 6
} as const
export type CloseReason = (typeof CLOSE_REASON)[keyof typeof CLOSE_REASON]

/** `PUSH_ERR` codes (§3.5). */
export const PUSH_ERR_CODE = {
  malformed: 1,
  tooManyTokens: 2,
  rateLimited: 3,
  notConfigured: 4
} as const
export type PushErrCode = (typeof PUSH_ERR_CODE)[keyof typeof PUSH_ERR_CODE]

/** At most this many tokens in one `PUSH_SET` (§3.5). The codec does not
 *  enforce it: more is a well-formed frame the relay refuses with PUSH_ERR 2.
 *  (The relay's own codec reports it as the error `too-many-tokens`; the
 *  conformance test applies this constant to the decoded tokens instead.) */
export const MAX_PUSH_TOKENS = 32

/** Largest push-frame JSON the relay reads (it reads host messages of at most
 *  5 + 65 536 bytes; the protocol gives no separate number). */
export const MAX_PUSH_JSON = 65536

/** Longest `PUSH.p` the relay forwards: it keeps the built APNs/FCM payload
 *  under their 4 KiB limits. */
export const MAX_PUSH_P = 2048

/** WebSocket close codes on the host socket (§3.4). */
export const HOST_CLOSE = {
  protocolError: 4400,
  badSignature: 4401,
  replaced: 4409,
  versionNotSupported: 4426,
  rateLimited: 4429
} as const

/** WebSocket close codes on the client socket (§4.2). 4000 + r is the host's
 *  `CLOSE` reason r. */
export const CLIENT_CLOSE = {
  streamClosedBase: 4000,
  protocolError: 4400,
  hostOffline: 4404,
  idle: 4408,
  tooLarge: 4413,
  rateLimited: 4429,
  hostWentAway: 4503
} as const

export type PushPlatform = 'apns' | 'fcm'
export const PUSH_PLATFORMS: readonly PushPlatform[] = ['apns', 'fcm']

/** What a push announces — the desktop's notification types. */
export type NotificationType = 'awaiting' | 'proposal' | 'error' | 'turn-ended'
export const NOTIFICATION_TYPES: readonly NotificationType[] = ['awaiting', 'proposal', 'error', 'turn-ended']

export interface PushToken {
  /** Device id. */
  d: string
  /** Platform. */
  p: PushPlatform
  /** The platform's device token. */
  t: string
}

export interface PushRequest {
  t: NotificationType
  /** Session id. */
  s: string
  /** A withdrawal (§8). */
  w?: boolean
  /** Reserved, b64u, forwarded unchanged; unused in version 1. */
  p?: string
}

export type Frame =
  | { type: 'HELLO'; stream: 0; version: number; challenge: Uint8Array }
  | { type: 'REGISTER'; stream: 0; version: number; pubkey: Uint8Array; sig: Uint8Array }
  | { type: 'READY'; stream: 0 }
  | { type: 'OPEN'; stream: number }
  | { type: 'DATA'; stream: number; data: Uint8Array }
  | { type: 'CLOSE'; stream: number; reason: CloseReason }
  | { type: 'PUSH_SET'; stream: 0; tokens: PushToken[] }
  | { type: 'PUSH'; stream: 0; push: PushRequest }
  | { type: 'PUSH_GONE'; stream: 0; d: string[] }
  | { type: 'PUSH_ERR'; stream: 0; code: PushErrCode }

export type FrameErrorCode =
  | 'truncated'
  | 'unknown-type'
  | 'bad-stream'
  | 'bad-length'
  | 'too-large'
  | 'bad-reason'
  | 'bad-code'
  | 'bad-push'

export class FrameError extends Error {
  constructor(
    readonly code: FrameErrorCode,
    message: string = code
  ) {
    super(message)
    this.name = 'FrameError'
  }
}

const NAME_OF = new Map<number, FrameTypeName>(
  (Object.entries(FRAME_TYPE) as [FrameTypeName, number][]).map(([k, v]) => [v, k])
)
const CONNECTION_FRAMES = new Set<FrameTypeName>(['HELLO', 'REGISTER', 'READY', 'PUSH_SET', 'PUSH', 'PUSH_GONE', 'PUSH_ERR'])
const CLOSE_REASONS = new Set<number>(Object.values(CLOSE_REASON))
const PUSH_ERR_CODES = new Set<number>(Object.values(PUSH_ERR_CODE))

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** Unpadded base64url (§2): a length of 1 mod 4 cannot be the encoding of bytes. */
const isB64u = (s: string): boolean => /^[A-Za-z0-9_-]*$/.test(s) && s.length % 4 !== 1

function pushJson(payload: Uint8Array): Record<string, unknown> {
  let v: unknown
  try {
    v = JSON.parse(utf8Decode(payload))
  } catch {
    throw new FrameError('bad-push', 'push payload is not UTF-8 JSON')
  }
  if (!isObject(v)) throw new FrameError('bad-push', 'push payload is not a JSON object')
  return v
}

function parsePushSet(payload: Uint8Array): PushToken[] {
  const v = pushJson(payload)
  const tokens = v['tokens']
  if (!Array.isArray(tokens)) throw new FrameError('bad-push', 'PUSH_SET: tokens is not an array')
  return tokens.map((t) => {
    if (!isObject(t) || !isNonEmptyString(t['d']) || !isNonEmptyString(t['t']))
      throw new FrameError('bad-push', 'PUSH_SET: a token needs non-empty d and t')
    const p = t['p']
    if (p !== 'apns' && p !== 'fcm') throw new FrameError('bad-push', 'PUSH_SET: unknown platform')
    return { d: t['d'], p, t: t['t'] }
  })
}

function parsePush(payload: Uint8Array): PushRequest {
  const v = pushJson(payload)
  const t = v['t']
  if (typeof t !== 'string' || !(NOTIFICATION_TYPES as readonly string[]).includes(t))
    throw new FrameError('bad-push', 'PUSH: unknown notification type')
  if (!isNonEmptyString(v['s'])) throw new FrameError('bad-push', 'PUSH: s must be a non-empty string')
  const out: PushRequest = { t: t as NotificationType, s: v['s'] }
  if (v['w'] !== undefined) {
    if (typeof v['w'] !== 'boolean') throw new FrameError('bad-push', 'PUSH: w must be a boolean')
    out.w = v['w']
  }
  if (v['p'] !== undefined) {
    if (typeof v['p'] !== 'string' || !isB64u(v['p']))
      throw new FrameError('bad-push', 'PUSH: p must be an unpadded base64url string')
    if (v['p'].length > MAX_PUSH_P) throw new FrameError('bad-push', `PUSH: p is longer than ${MAX_PUSH_P}`)
    // An empty p is the same as none (the relay forwards nothing for it).
    if (v['p'] !== '') out.p = v['p']
  }
  return out
}

function parsePushGone(payload: Uint8Array): string[] {
  const v = pushJson(payload)
  const d = v['d']
  if (!Array.isArray(d) || !d.every(isNonEmptyString))
    throw new FrameError('bad-push', 'PUSH_GONE: d must be an array of non-empty strings')
  return d
}

function expectPushSize(n: number, type: FrameTypeName): void {
  if (n > MAX_PUSH_JSON) throw new FrameError('too-large', `${type} payload of ${n} bytes`)
}

function expectLength(payload: Uint8Array, n: number, type: FrameTypeName): void {
  if (payload.length !== n)
    throw new FrameError('bad-length', `${type}: payload is ${payload.length} bytes, expected ${n}`)
}

/** Decode one host-socket frame. Throws `FrameError`. */
export function decodeFrame(bytes: Uint8Array): Frame {
  if (bytes.length < 5) throw new FrameError('truncated')
  const typeByte = bytes[0] as number
  const type = NAME_OF.get(typeByte)
  if (!type) throw new FrameError('unknown-type', `unknown frame type 0x${typeByte.toString(16).padStart(2, '0')}`)
  const stream = readU32(bytes, 1)
  if (CONNECTION_FRAMES.has(type) ? stream !== 0 : stream === 0)
    throw new FrameError('bad-stream', `${type} on stream ${stream}`)
  const payload = bytes.subarray(5)
  switch (type) {
    case 'HELLO':
      expectLength(payload, 34, type)
      return { type, stream: 0, version: readU16(payload, 0), challenge: payload.slice(2) }
    case 'REGISTER':
      expectLength(payload, 98, type)
      return {
        type,
        stream: 0,
        version: readU16(payload, 0),
        pubkey: payload.slice(2, 34),
        sig: payload.slice(34)
      }
    case 'READY':
      expectLength(payload, 0, type)
      return { type, stream: 0 }
    case 'OPEN':
      expectLength(payload, 0, type)
      return { type, stream }
    case 'DATA':
      if (payload.length > MAX_DATA) throw new FrameError('too-large', `DATA of ${payload.length} bytes`)
      return { type, stream, data: payload.slice() }
    case 'CLOSE': {
      expectLength(payload, 2, type)
      const reason = readU16(payload, 0)
      if (!CLOSE_REASONS.has(reason)) throw new FrameError('bad-reason', `CLOSE reason ${reason}`)
      return { type, stream, reason: reason as CloseReason }
    }
    case 'PUSH_SET':
      expectPushSize(payload.length, type)
      return { type, stream: 0, tokens: parsePushSet(payload) }
    case 'PUSH':
      expectPushSize(payload.length, type)
      return { type, stream: 0, push: parsePush(payload) }
    case 'PUSH_GONE':
      expectPushSize(payload.length, type)
      return { type, stream: 0, d: parsePushGone(payload) }
    case 'PUSH_ERR': {
      expectLength(payload, 2, type)
      const code = readU16(payload, 0)
      if (!PUSH_ERR_CODES.has(code)) throw new FrameError('bad-code', `PUSH_ERR code ${code}`)
      return { type, stream: 0, code: code as PushErrCode }
    }
  }
}

/**
 * Encode one frame. JSON payloads are written canonically — keys in the order
 * §3.5 lists them, no whitespace, optional fields only when set — so a frame
 * encodes to the same bytes in every implementation that follows that order.
 * Throws `FrameError` for a frame `decodeFrame` would refuse.
 */
export function encodeFrame(frame: Frame): Uint8Array {
  let payload: Uint8Array
  switch (frame.type) {
    case 'HELLO':
      if (frame.challenge.length !== 32) throw new FrameError('bad-length', 'HELLO challenge must be 32 bytes')
      payload = concatBytes(u16(frame.version), frame.challenge)
      break
    case 'REGISTER':
      if (frame.pubkey.length !== 32 || frame.sig.length !== 64)
        throw new FrameError('bad-length', 'REGISTER needs a 32-byte key and a 64-byte signature')
      payload = concatBytes(u16(frame.version), frame.pubkey, frame.sig)
      break
    case 'READY':
    case 'OPEN':
      payload = new Uint8Array(0)
      break
    case 'DATA':
      if (frame.data.length > MAX_DATA) throw new FrameError('too-large', `DATA of ${frame.data.length} bytes`)
      payload = frame.data
      break
    case 'CLOSE':
      if (!CLOSE_REASONS.has(frame.reason)) throw new FrameError('bad-reason')
      payload = u16(frame.reason)
      break
    case 'PUSH_SET':
      payload = utf8Encode(JSON.stringify({ tokens: frame.tokens.map(({ d, p, t }) => ({ d, p, t })) }))
      expectPushSize(payload.length, frame.type)
      break
    case 'PUSH': {
      const { t, s, w, p } = frame.push
      if (p !== undefined && (!isB64u(p) || p.length > MAX_PUSH_P))
        throw new FrameError('bad-push', 'PUSH: p must be unpadded base64url of at most 2048 characters')
      // `w` only when true and `p` only when non-empty: the canonical form.
      payload = utf8Encode(JSON.stringify({ t, s, ...(w === true ? { w } : {}), ...(p ? { p } : {}) }))
      expectPushSize(payload.length, frame.type)
      break
    }
    case 'PUSH_GONE':
      payload = utf8Encode(JSON.stringify({ d: frame.d }))
      expectPushSize(payload.length, frame.type)
      break
    case 'PUSH_ERR':
      if (!PUSH_ERR_CODES.has(frame.code)) throw new FrameError('bad-code')
      payload = u16(frame.code)
      break
  }
  const stream = frame.stream
  if (!Number.isInteger(stream) || stream < 0 || stream > 0xffffffff)
    throw new FrameError('bad-stream', `stream ${stream}`)
  if (CONNECTION_FRAMES.has(frame.type) ? stream !== 0 : stream === 0)
    throw new FrameError('bad-stream', `${frame.type} on stream ${stream}`)
  return concatBytes(Uint8Array.of(FRAME_TYPE[frame.type]), u32(stream), payload)
}
