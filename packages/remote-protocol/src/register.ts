// Host registration (requirements-remote-protocol.md §2, §3.2): the host id
// and the Ed25519 signature over the relay's challenge.

import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, toBase32, utf8Encode } from './bytes'

/** lowercase base32, no padding, of the first 20 bytes of SHA-256 of the
 *  relay-identity public key: 32 characters of `[a-z2-7]`. */
export function hostIdFromPublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error('relay identity key must be 32 bytes')
  return toBase32(sha256(publicKey).subarray(0, 20))
}

export const HOST_ID_RE = /^[a-z2-7]{32}$/

/** The bytes `REGISTER.sig` signs: `utf8("gurt-relay/1 register") | 0x00 | challenge`. */
export function registerMessage(challenge: Uint8Array): Uint8Array {
  if (challenge.length !== 32) throw new Error('challenge must be 32 bytes')
  return concatBytes(utf8Encode('gurt-relay/1 register'), Uint8Array.of(0), challenge)
}

export interface RelayIdentity {
  /** Ed25519 secret key (32-byte seed). */
  secretKey: Uint8Array
  publicKey: Uint8Array
}

/** A fresh relay identity, from the platform's secure random source. */
export function generateRelayIdentity(): RelayIdentity {
  const secretKey = ed25519.utils.randomSecretKey()
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) }
}

export function relayIdentityFromSecret(secretKey: Uint8Array): RelayIdentity {
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) }
}

export function signRegister(secretKey: Uint8Array, challenge: Uint8Array): Uint8Array {
  return ed25519.sign(registerMessage(challenge), secretKey)
}

export function verifyRegister(publicKey: Uint8Array, challenge: Uint8Array, sig: Uint8Array): boolean {
  try {
    return ed25519.verify(sig, registerMessage(challenge), publicKey)
  } catch {
    return false
  }
}
