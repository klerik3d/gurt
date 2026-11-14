// Byte helpers the protocol needs, written against the language alone: the
// package runs in Hermes, which has no Buffer, and whose TextEncoder /
// TextDecoder support depends on the React Native version. Every decoder here
// is strict — a malformed input throws instead of being repaired, because each
// of them reads something an untrusted party sent.

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let len = 0
  for (const p of parts) len += p.length
  const out = new Uint8Array(len)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** Constant-time for equal lengths; the length itself is not secret anywhere
 *  this is used. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

// ------------------------------------------------------------------- UTF-8

/** UTF-8 encode. A lone surrogate becomes U+FFFD, as TextEncoder does. */
export function utf8Encode(s: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00)
        i++
      } else c = 0xfffd
    } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    else
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f)
      )
  }
  return Uint8Array.from(out)
}

/** Strict UTF-8 decode: overlong forms, surrogates, code points past
 *  U+10FFFF and truncated sequences throw. */
export function utf8Decode(b: Uint8Array): string {
  let out = ''
  let chunk: number[] = []
  const flush = (): void => {
    out += String.fromCharCode(...chunk)
    chunk = []
  }
  for (let i = 0; i < b.length; ) {
    const c = b[i] as number
    let cp: number
    let need: number
    let min: number
    if (c < 0x80) {
      cp = c
      need = 0
      min = 0
    } else if (c >= 0xc2 && c <= 0xdf) {
      cp = c & 0x1f
      need = 1
      min = 0x80
    } else if (c >= 0xe0 && c <= 0xef) {
      cp = c & 0x0f
      need = 2
      min = 0x800
    } else if (c >= 0xf0 && c <= 0xf4) {
      cp = c & 0x07
      need = 3
      min = 0x10000
    } else throw new Error('invalid UTF-8')
    for (let k = 1; k <= need; k++) {
      const d = b[i + k]
      if (d === undefined || (d & 0xc0) !== 0x80) throw new Error('invalid UTF-8')
      cp = (cp << 6) | (d & 0x3f)
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw new Error('invalid UTF-8')
    i += need + 1
    if (cp >= 0x10000) {
      cp -= 0x10000
      chunk.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff))
    } else chunk.push(cp)
    if (chunk.length >= 8192) flush()
  }
  flush()
  return out
}

// --------------------------------------------------------------------- hex

const HEX = '0123456789abcdef'

export function toHex(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += (HEX[x >> 4] as string) + (HEX[x & 15] as string)
  return s
}

/** Lowercase or uppercase hex, even length, nothing else. */
export function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) throw new Error('invalid hex')
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return out
}

// ------------------------------------------------------- base64url (no pad)

const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** RFC 4648 §5, no padding. */
export function toB64u(b: Uint8Array): string {
  let s = ''
  let i = 0
  for (; i + 3 <= b.length; i += 3) {
    const n = ((b[i] as number) << 16) | ((b[i + 1] as number) << 8) | (b[i + 2] as number)
    s += (B64U[n >> 18] as string) + B64U[(n >> 12) & 63] + B64U[(n >> 6) & 63] + B64U[n & 63]
  }
  const rest = b.length - i
  if (rest === 1) {
    const n = (b[i] as number) << 16
    s += (B64U[n >> 18] as string) + B64U[(n >> 12) & 63]
  } else if (rest === 2) {
    const n = ((b[i] as number) << 16) | ((b[i + 1] as number) << 8)
    s += (B64U[n >> 18] as string) + B64U[(n >> 12) & 63] + B64U[(n >> 6) & 63]
  }
  return s
}

/** Strict: no padding, no whitespace, no standard-alphabet `+` `/`, and the
 *  unused trailing bits must be zero (one encoding per byte string). */
export function fromB64u(s: string): Uint8Array {
  if (s.length % 4 === 1) throw new Error('invalid base64url')
  const vals: number[] = []
  for (const ch of s) {
    const v = B64U.indexOf(ch)
    if (v < 0) throw new Error('invalid base64url')
    vals.push(v)
  }
  const out = new Uint8Array(Math.floor((s.length * 3) / 4))
  let o = 0
  let i = 0
  for (; i + 4 <= vals.length; i += 4) {
    const n = ((vals[i] as number) << 18) | ((vals[i + 1] as number) << 12) | ((vals[i + 2] as number) << 6) | (vals[i + 3] as number)
    out[o++] = n >> 16
    out[o++] = (n >> 8) & 255
    out[o++] = n & 255
  }
  const rest = vals.length - i
  if (rest === 2) {
    const n = ((vals[i] as number) << 18) | ((vals[i + 1] as number) << 12)
    if (n & 0xffff) throw new Error('invalid base64url')
    out[o] = n >> 16
  } else if (rest === 3) {
    const n = ((vals[i] as number) << 18) | ((vals[i + 1] as number) << 12) | ((vals[i + 2] as number) << 6)
    if (n & 0xff) throw new Error('invalid base64url')
    out[o] = n >> 16
    out[o + 1] = (n >> 8) & 255
  }
  return out
}

// ---------------------------------------------------- base32 (lower, no pad)

const B32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** RFC 4648 base32, lowercase, no padding. */
export function toBase32(b: Uint8Array): string {
  let s = ''
  let bits = 0
  let acc = 0
  for (const x of b) {
    acc = (acc << 8) | x
    bits += 8
    while (bits >= 5) {
      s += B32[(acc >> (bits - 5)) & 31]
      bits -= 5
    }
    acc &= (1 << bits) - 1
  }
  if (bits > 0) s += B32[(acc << (5 - bits)) & 31]
  return s
}

// ---------------------------------------------------------------- integers

export function u16(n: number): Uint8Array {
  return Uint8Array.of((n >>> 8) & 255, n & 255)
}

export function u32(n: number): Uint8Array {
  return Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255)
}

export function readU16(b: Uint8Array, at: number): number {
  return (((b[at] as number) << 8) | (b[at + 1] as number)) >>> 0
}

export function readU32(b: Uint8Array, at: number): number {
  return (
    (((b[at] as number) << 24) | ((b[at + 1] as number) << 16) | ((b[at + 2] as number) << 8) | (b[at + 3] as number)) >>>
    0
  )
}
