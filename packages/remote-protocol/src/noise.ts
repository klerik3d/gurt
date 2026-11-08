// The Noise Protocol Framework (revision 34), as much of it as the channel
// needs: the `25519_ChaChaPoly_BLAKE2s` suite and the IK and IKpsk1 patterns
// (requirements-remote-protocol.md §6.1). Written here over the audited
// @noble primitives rather than taken from a library, so it is small enough to
// read and pinned by the specification's own test vectors
// (test/noise.test.mjs; requirements-remote-access.md §13 Q5).
//
// Randomness comes only from @noble's `randomBytes`, which uses
// `crypto.getRandomValues` and throws when there is none: in Hermes the app
// installs an OS-backed polyfill before anything loads. Nothing here falls back
// to `Math.random`.

import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { blake2s } from '@noble/hashes/blake2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { concatBytes, utf8Encode } from './bytes'

export const DHLEN = 32
export const HASHLEN = 32
const TAGLEN = 16
/** Largest Noise message (§3 of the Noise spec). */
export const MAX_NOISE_MESSAGE = 65535

export interface Keypair {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

/** A fresh X25519 key pair from the platform's secure random source. */
export function generateKeypair(): Keypair {
  const secretKey = x25519.utils.randomSecretKey()
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) }
}

export function keypairFromSecret(secretKey: Uint8Array): Keypair {
  if (secretKey.length !== DHLEN) throw new Error('X25519 secret key must be 32 bytes')
  return { secretKey: secretKey.slice(), publicKey: x25519.getPublicKey(secretKey) }
}

/** Raised for every failure of a handshake or transport message: a bad tag,
 *  a short message, a low-order key. Deliberately says no more than that. */
export class NoiseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoiseError'
  }
}

function dh(kp: Keypair, pub: Uint8Array): Uint8Array {
  try {
    return x25519.getSharedSecret(kp.secretKey, pub)
  } catch {
    throw new NoiseError('DH failed')
  }
}

const hash = (data: Uint8Array): Uint8Array => blake2s(data)

function hkdf(ck: Uint8Array, ikm: Uint8Array, n: 2 | 3): Uint8Array[] {
  const tempKey = hmac(blake2s, ck, ikm)
  const out1 = hmac(blake2s, tempKey, Uint8Array.of(1))
  const out2 = hmac(blake2s, tempKey, concatBytes(out1, Uint8Array.of(2)))
  if (n === 2) return [out1, out2]
  return [out1, out2, hmac(blake2s, tempKey, concatBytes(out2, Uint8Array.of(3)))]
}

/** ChaChaPoly's nonce: 32 bits of zeros, then the counter as 64-bit little-endian. */
function nonceBytes(n: number): Uint8Array {
  const out = new Uint8Array(12)
  let v = n
  for (let i = 4; i < 12; i++) {
    out[i] = v % 256
    v = Math.floor(v / 256)
  }
  return out
}

/** One direction's key and nonce. */
export class CipherState {
  private k: Uint8Array | undefined
  private n = 0

  constructor(key?: Uint8Array) {
    if (key) this.initializeKey(key)
  }

  initializeKey(key: Uint8Array): void {
    this.k = key.slice()
    this.n = 0
  }

  hasKey(): boolean {
    return this.k !== undefined
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.k) return plaintext.slice()
    // The spec reserves 2^64-1; a JS number is exact well short of that, and a
    // connection that sends 2^53 messages is not one this channel will see.
    if (this.n >= Number.MAX_SAFE_INTEGER) throw new NoiseError('nonce exhausted')
    const out = chacha20poly1305(this.k, nonceBytes(this.n), ad).encrypt(plaintext)
    this.n++
    return out
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.k) return ciphertext.slice()
    if (this.n >= Number.MAX_SAFE_INTEGER) throw new NoiseError('nonce exhausted')
    let out: Uint8Array
    try {
      out = chacha20poly1305(this.k, nonceBytes(this.n), ad).decrypt(ciphertext)
    } catch {
      throw new NoiseError('decryption failed')
    }
    this.n++
    return out
  }

  /** Transport encryption: no associated data. */
  encrypt(plaintext: Uint8Array): Uint8Array {
    if (plaintext.length + TAGLEN > MAX_NOISE_MESSAGE) throw new NoiseError('message too large')
    return this.encryptWithAd(new Uint8Array(0), plaintext)
  }

  decrypt(ciphertext: Uint8Array): Uint8Array {
    if (ciphertext.length > MAX_NOISE_MESSAGE) throw new NoiseError('message too large')
    return this.decryptWithAd(new Uint8Array(0), ciphertext)
  }
}

class SymmetricState {
  ck: Uint8Array
  h: Uint8Array
  readonly cs = new CipherState()

  constructor(protocolName: string) {
    const name = utf8Encode(protocolName)
    if (name.length <= HASHLEN) {
      this.h = new Uint8Array(HASHLEN)
      this.h.set(name)
    } else this.h = hash(name)
    this.ck = this.h.slice()
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, k] = hkdf(this.ck, ikm, 2) as [Uint8Array, Uint8Array]
    this.ck = ck
    this.cs.initializeKey(k)
  }

  mixHash(data: Uint8Array): void {
    this.h = hash(concatBytes(this.h, data))
  }

  mixKeyAndHash(ikm: Uint8Array): void {
    const [ck, th, k] = hkdf(this.ck, ikm, 3) as [Uint8Array, Uint8Array, Uint8Array]
    this.ck = ck
    this.mixHash(th)
    this.cs.initializeKey(k)
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ct = this.cs.encryptWithAd(this.h, plaintext)
    this.mixHash(ct)
    return ct
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const pt = this.cs.decryptWithAd(this.h, ciphertext)
    this.mixHash(ciphertext)
    return pt
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf(this.ck, new Uint8Array(0), 2) as [Uint8Array, Uint8Array]
    return [new CipherState(k1), new CipherState(k2)]
  }
}

type Token = 'e' | 's' | 'ee' | 'es' | 'se' | 'ss' | 'psk'

/** The two patterns the channel uses. Both have the responder's static key as
 *  a pre-message (`<- s`). */
const PATTERNS: Record<NoisePattern, Token[][]> = {
  IK: [
    ['e', 'es', 's', 'ss'],
    ['e', 'ee', 'se']
  ],
  IKpsk1: [
    ['e', 'es', 's', 'ss', 'psk'],
    ['e', 'ee', 'se']
  ]
}

export type NoisePattern = 'IK' | 'IKpsk1'

export const protocolName = (pattern: NoisePattern): string => `Noise_${pattern}_25519_ChaChaPoly_BLAKE2s`

export interface HandshakeOptions {
  pattern: NoisePattern
  initiator: boolean
  prologue: Uint8Array
  /** Our static key pair. */
  s: Keypair
  /** The responder's static public key; required for the initiator (IK). */
  rs?: Uint8Array
  /** The pre-shared key for IKpsk1, 32 bytes. */
  psk?: Uint8Array
  /** A fixed ephemeral key pair. Only for test vectors: a real handshake must
   *  leave this unset, so a fresh one is generated per handshake. */
  e?: Keypair
}

export interface HandshakeResult {
  /** Encrypts what we send. */
  send: CipherState
  /** Decrypts what we receive. */
  receive: CipherState
  /** The final handshake hash `h` — channel binding, the input of the SAS. */
  handshakeHash: Uint8Array
  /** The peer's static public key. */
  remoteStatic: Uint8Array
}

export class HandshakeState {
  private readonly ss: SymmetricState
  private readonly initiator: boolean
  private readonly pattern: Token[][]
  private readonly isPsk: boolean
  private readonly s: Keypair
  private readonly psk: Uint8Array | undefined
  private e: Keypair | undefined
  private rs: Uint8Array | undefined
  private re: Uint8Array | undefined
  private index = 0
  private result: HandshakeResult | undefined
  private failed = false

  constructor(opts: HandshakeOptions) {
    this.pattern = PATTERNS[opts.pattern]
    this.isPsk = opts.pattern.includes('psk')
    if (this.isPsk && (!opts.psk || opts.psk.length !== 32)) throw new Error('IKpsk1 needs a 32-byte PSK')
    if (!this.isPsk && opts.psk) throw new Error('a PSK is only used with IKpsk1')
    if (opts.initiator && (!opts.rs || opts.rs.length !== DHLEN))
      throw new Error('the IK initiator needs the responder static key')
    this.initiator = opts.initiator
    this.s = opts.s
    this.e = opts.e
    this.rs = opts.initiator ? opts.rs : undefined
    this.psk = opts.psk
    this.ss = new SymmetricState(protocolName(opts.pattern))
    this.ss.mixHash(opts.prologue)
    // Pre-message `<- s`: the responder's static key.
    this.ss.mixHash(opts.initiator ? (opts.rs as Uint8Array) : opts.s.publicKey)
  }

  /** True once the last message was written or read. */
  get complete(): boolean {
    return this.result !== undefined
  }

  /** Whose turn: true when the next message is ours to write. */
  get myTurn(): boolean {
    return (this.index % 2 === 0) === this.initiator
  }

  /** The remote static key, once it has been received (after message 1 on the
   *  responder) — available before the handshake completes, so the host can
   *  look a device up before answering. */
  get remoteStatic(): Uint8Array | undefined {
    return this.rs?.slice()
  }

  /** The handshake hash so far. */
  get handshakeHash(): Uint8Array {
    return this.ss.h.slice()
  }

  finish(): HandshakeResult {
    if (!this.result) throw new Error('handshake not complete')
    return this.result
  }

  private dh(token: 'ee' | 'es' | 'se' | 'ss'): Uint8Array {
    const e = this.e
    const re = this.re
    const rs = this.rs
    const need = <T>(v: T | undefined): T => {
      if (v === undefined) throw new NoiseError('handshake key missing')
      return v
    }
    switch (token) {
      case 'ee':
        return dh(need(e), need(re))
      case 'es':
        return this.initiator ? dh(need(e), need(rs)) : dh(this.s, need(re))
      case 'se':
        return this.initiator ? dh(this.s, need(re)) : dh(need(e), need(rs))
      case 'ss':
        return dh(this.s, need(rs))
    }
  }

  private guard(): Token[] {
    if (this.failed) throw new NoiseError('handshake already failed')
    const tokens = this.pattern[this.index]
    if (!tokens) throw new Error('handshake already complete')
    return tokens
  }

  writeMessage(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    const tokens = this.guard()
    if (!this.myTurn) throw new Error('not our turn to write')
    try {
      const parts: Uint8Array[] = []
      for (const t of tokens) {
        if (t === 'e') {
          this.e ??= generateKeypair()
          parts.push(this.e.publicKey)
          this.ss.mixHash(this.e.publicKey)
          if (this.isPsk) this.ss.mixKey(this.e.publicKey)
        } else if (t === 's') parts.push(this.ss.encryptAndHash(this.s.publicKey))
        else if (t === 'psk') this.ss.mixKeyAndHash(this.psk as Uint8Array)
        else this.ss.mixKey(this.dh(t))
      }
      parts.push(this.ss.encryptAndHash(payload))
      const msg = concatBytes(...parts)
      if (msg.length > MAX_NOISE_MESSAGE) throw new NoiseError('handshake message too large')
      this.advance()
      return msg
    } catch (e) {
      this.failed = true
      throw e
    }
  }

  readMessage(message: Uint8Array): Uint8Array {
    const tokens = this.guard()
    if (this.myTurn) throw new Error('not our turn to read')
    try {
      if (message.length > MAX_NOISE_MESSAGE) throw new NoiseError('handshake message too large')
      let at = 0
      const take = (n: number): Uint8Array => {
        if (at + n > message.length) throw new NoiseError('handshake message too short')
        const out = message.subarray(at, at + n)
        at += n
        return out
      }
      for (const t of tokens) {
        if (t === 'e') {
          this.re = take(DHLEN).slice()
          this.ss.mixHash(this.re)
          if (this.isPsk) this.ss.mixKey(this.re)
        } else if (t === 's') {
          this.rs = this.ss.decryptAndHash(take(this.ss.cs.hasKey() ? DHLEN + TAGLEN : DHLEN))
        } else if (t === 'psk') this.ss.mixKeyAndHash(this.psk as Uint8Array)
        else this.ss.mixKey(this.dh(t))
      }
      const payload = this.ss.decryptAndHash(message.subarray(at))
      this.advance()
      return payload
    } catch (e) {
      this.failed = true
      throw e
    }
  }

  private advance(): void {
    this.index++
    if (this.index < this.pattern.length) return
    const [c1, c2] = this.ss.split()
    this.result = {
      send: this.initiator ? c1 : c2,
      receive: this.initiator ? c2 : c1,
      handshakeHash: this.ss.h.slice(),
      remoteStatic: (this.rs as Uint8Array).slice()
    }
  }
}
