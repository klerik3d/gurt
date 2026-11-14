// The pairing payload, Gurt → App out of band (requirements-remote-protocol.md
// §5): `gurt://pair#<b64u(JSON)>`, and the re-pointing form
// `gurt://relay#<b64u(JSON without s)>`.
//
// Parsing is strict because the input is whatever a camera read or another
// app opened: each failure is a `PairingParseError` with a stable code
// (testdata/pairing.json pins them).

import { fromB64u, toB64u, utf8Decode, utf8Encode } from './bytes'
import { HOST_ID_RE } from './register'

export const PAIRING_VERSION = 1

export interface RelayPointer {
  v: number
  /** Relay URL, `wss://…`. */
  r: string
  /** Host id (§2). */
  h: string
  /** Host Noise static public key, 32 bytes. */
  k: Uint8Array
  /** Host display name. */
  n: string
}

export interface PairingPayload extends RelayPointer {
  /** One-time pairing secret, 32 bytes — the PSK. */
  s: Uint8Array
}

export type ParsedPairingUrl = ({ kind: 'pair' } & PairingPayload) | ({ kind: 'relay' } & RelayPointer)

export type PairingParseErrorCode =
  | 'bad-url' //       not gurt://pair#… or gurt://relay#…
  | 'bad-encoding' //  the fragment is not base64url of UTF-8 JSON of an object
  | 'bad-version' //   `v` is not a version this side reads
  | 'bad-field' //     a field is missing or has the wrong form
  | 'unexpected-secret' // a gurt://relay URL carrying `s`

export class PairingParseError extends Error {
  constructor(
    readonly code: PairingParseErrorCode,
    message: string = code
  ) {
    super(message)
    this.name = 'PairingParseError'
  }
}

const SCHEME = 'gurt://'
const PAIR_PREFIX = `${SCHEME}pair#`
const RELAY_PREFIX = `${SCHEME}relay#`

/** `wss://host[:port][/path]`, no credentials, no query, no fragment, no space. */
const RELAY_URL_RE = /^wss:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~%!$&'()*+,;=:@/-]*)?$/

function pointerJson(p: RelayPointer): Record<string, unknown> {
  return { v: p.v, r: p.r, h: p.h, k: toB64u(p.k) }
}

/** `gurt://pair#…`, keys in §5's order. */
export function buildPairingUrl(p: PairingPayload): string {
  const json = { ...pointerJson(p), s: toB64u(p.s), n: p.n }
  return PAIR_PREFIX + toB64u(utf8Encode(JSON.stringify(json)))
}

/** `gurt://relay#…`: the same JSON without `s`. */
export function buildRelayUrl(p: RelayPointer): string {
  const json = { ...pointerJson(p), n: p.n }
  return RELAY_PREFIX + toB64u(utf8Encode(JSON.stringify(json)))
}

function key32(v: unknown, field: string): Uint8Array {
  if (typeof v !== 'string') throw new PairingParseError('bad-field', `${field} missing`)
  let b: Uint8Array
  try {
    b = fromB64u(v)
  } catch {
    throw new PairingParseError('bad-field', `${field} is not base64url`)
  }
  if (b.length !== 32) throw new PairingParseError('bad-field', `${field} must be 32 bytes`)
  return b
}

/** Parse a scanned or opened URL. The scheme is matched case-insensitively
 *  (RFC 3986 §3.1); the rest exactly. */
export function parsePairingUrl(url: string): ParsedPairingUrl {
  if (url.slice(0, SCHEME.length).toLowerCase() !== SCHEME) throw new PairingParseError('bad-url')
  const rest = url.slice(SCHEME.length)
  let kind: 'pair' | 'relay'
  let fragment: string
  if (rest.startsWith('pair#')) {
    kind = 'pair'
    fragment = rest.slice('pair#'.length)
  } else if (rest.startsWith('relay#')) {
    kind = 'relay'
    fragment = rest.slice('relay#'.length)
  } else throw new PairingParseError('bad-url')

  let json: unknown
  try {
    json = JSON.parse(utf8Decode(fromB64u(fragment)))
  } catch {
    throw new PairingParseError('bad-encoding')
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new PairingParseError('bad-encoding')
  const o = json as Record<string, unknown>

  if (o['v'] !== PAIRING_VERSION) throw new PairingParseError('bad-version')
  const r = o['r']
  if (typeof r !== 'string' || !RELAY_URL_RE.test(r)) throw new PairingParseError('bad-field', 'r must be a wss:// URL')
  const h = o['h']
  if (typeof h !== 'string' || !HOST_ID_RE.test(h)) throw new PairingParseError('bad-field', 'h must be a host id')
  const k = key32(o['k'], 'k')
  const n = o['n']
  if (typeof n !== 'string') throw new PairingParseError('bad-field', 'n must be a string')
  const pointer = { v: PAIRING_VERSION, r, h, k, n }

  if (kind === 'relay') {
    if (o['s'] !== undefined) throw new PairingParseError('unexpected-secret')
    return { kind, ...pointer }
  }
  return { kind, ...pointer, s: key32(o['s'], 's') }
}
