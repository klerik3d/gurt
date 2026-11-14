// The host's relay identity (docs/requirements-remote-protocol.md §2, §3.2,
// §9): an Ed25519 key, made once and kept in the credential store as a
// `remote-identity` entry — sealed, masked and redacted like any credential
// secret. Its public key is the host id, so it must outlive restarts: a new
// key is a new host id, and every paired device would be pointing at the old
// one.
import {
  fromB64u,
  generateRelayIdentity,
  hostIdFromPublicKey,
  relayIdentityFromSecret,
  toB64u,
  type RelayIdentity
} from '../../../packages/remote-protocol/src/index'
import { listCredentials, upsertCredentialEntry } from '../credentials'

/** Fixed, so the entry is found again; a `remote-identity` entry made by hand
 *  in Settings gets a random id and is never taken for this one. */
export const RELAY_IDENTITY_ID = 'gurt-remote-identity'

export interface HostIdentity extends RelayIdentity {
  hostId: string
}

/**
 * The relay identity, made on first use. An entry that exists but cannot be
 * read back (keystore locked, a file copied from another machine, a damaged
 * value) is an error, never a reason to make a new key silently: that would
 * change the host id under every paired device.
 */
export async function loadOrCreateIdentity(): Promise<HostIdentity> {
  const entry = (await listCredentials()).find((c) => c.id === RELAY_IDENTITY_ID)
  if (entry) {
    const seed = entry.data['secret']
    if (!seed) throw new Error('the remote access key cannot be unsealed (is the keystore locked?)')
    let secretKey: Uint8Array
    try {
      secretKey = fromB64u(seed)
    } catch {
      secretKey = new Uint8Array(0)
    }
    if (secretKey.length !== 32) throw new Error('the remote access key in the credential store is damaged')
    const id = relayIdentityFromSecret(secretKey)
    return { ...id, hostId: hostIdFromPublicKey(id.publicKey) }
  }
  const id = generateRelayIdentity()
  await upsertCredentialEntry({
    id: RELAY_IDENTITY_ID,
    kind: 'remote-identity',
    label: 'remote access key',
    hosts: [],
    data: { secret: toB64u(id.secretKey) }
  })
  return { ...id, hostId: hostIdFromPublicKey(id.publicKey) }
}
