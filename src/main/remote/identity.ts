// The host's relay identity (docs/requirements-remote-protocol.md §2, §3.2,
// §9): an Ed25519 key, made once, kept sealed in ~/.gurt/remote/identity.json.
// Its public key is the host id, so it must outlive restarts — a new key is a
// new host id, and every paired device would be pointing at the old one.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import {
  fromB64u,
  generateRelayIdentity,
  hostIdFromPublicKey,
  relayIdentityFromSecret,
  toB64u,
  type RelayIdentity
} from '../../../packages/remote-protocol/src/index'
import { sealHostSecret, unsealHostSecret } from '../credentials'
import { gurtRoot } from '../store'

export const remoteDir = (): string => path.join(gurtRoot, 'remote')
const identityFile = (): string => path.join(remoteDir(), 'identity.json')

const SEALED = z.union([z.object({ sealed: z.string() }), z.object({ plain: z.string() })])
const IDENTITY_FILE = z.looseObject({ v: z.literal(1), relayIdentity: SEALED })

export interface HostIdentity extends RelayIdentity {
  hostId: string
}

/**
 * The relay identity, made on first use. A file that exists but cannot be
 * read back (keystore locked, copied from another machine, damaged) is an
 * error, never a reason to make a new key silently: that would change the
 * host id under every paired device.
 */
export async function loadOrCreateIdentity(): Promise<HostIdentity> {
  let raw: string | undefined
  try {
    raw = await fs.readFile(identityFile(), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  if (raw !== undefined) {
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      json = undefined
    }
    const parsed = IDENTITY_FILE.safeParse(json)
    if (!parsed.success) throw new Error('remote/identity.json is damaged')
    const seed = unsealHostSecret(parsed.data.relayIdentity, 'remote-relay-identity')
    if (!seed) throw new Error('the relay identity key cannot be unsealed (is the keystore locked?)')
    const id = relayIdentityFromSecret(fromB64u(seed))
    return { ...id, hostId: hostIdFromPublicKey(id.publicKey) }
  }
  const id = generateRelayIdentity()
  await fs.mkdir(remoteDir(), { recursive: true, mode: 0o700 })
  const file = { v: 1, relayIdentity: sealHostSecret(toB64u(id.secretKey)) }
  // `wx`: two starts racing must not both write — the loser reads the winner's.
  try {
    await fs.writeFile(identityFile(), JSON.stringify(file, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return loadOrCreateIdentity()
    throw e
  }
  return { ...id, hostId: hostIdFromPublicKey(id.publicKey) }
}
