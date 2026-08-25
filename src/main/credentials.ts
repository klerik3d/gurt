// Credential store — CRUD over ~/.gurt/credentials.json, in the store.ts style.
//
// Secret-flagged fields (CREDENTIAL_KINDS[].fields[].secret) are sealed at
// rest with Electron's safeStorage: ciphertext rides in the file under
// `sealed`, the encryption key lives in the OS keystore (macOS Keychain,
// Linux Secret Service/kwallet). Everything else in `data` stays plaintext.
// When no keystore is available (or GURT_FORCE_PLAINTEXT=1), secrets stay in
// `data` as before — an honest plaintext fallback, surfaced to the UI via
// `CredentialsFile.plaintext`. Secrets never leave this file except through
// the host credential broker's per-request responses (git/hostCredBroker.ts),
// the resolved MCP header pushed to a session's proxy, and the masked view
// served to the renderer (getCredentials()).
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { z } from 'zod'
import type { AgentInstance, AgentsFile } from '../shared/types'
import type { CredentialEntry, CredentialKind, CredentialsFile } from '../shared/credentials'
import {
  CREDENTIAL_KINDS,
  checkMcpSecret,
  credentialIdentity,
  resolveMcpCredential
} from '../shared/credentials'
import { canonicalRepoId } from '../shared/repoId'
import { mcpLabel } from '../shared/mcp'
import {
  gurtRoot,
  getWorkspace,
  listWorkspaces,
  getAgents,
  liftAgent,
  setAgents,
  STORED_AGENTS
} from './store'
import { addSecrets, createLogger } from './log'
import { providerForHost, type ForgeProvider } from './git/providers'

const log = createLogger('credentials')
const credentialsFile = (): string => path.join(gurtRoot, 'credentials.json')

// --- sealing (safeStorage) --------------------------------------------------

/** Minimal shape this module needs from 'electron' — hand-rolled instead of
 *  the ambient `Electron` types so this file never statically imports
 *  'electron' (see `requireFn` below: it must stay resolvable, and safely
 *  absent, outside a real Electron process). */
interface ElectronSealing {
  app: { isReady(): boolean }
  safeStorage: {
    isEncryptionAvailable(): boolean
    getSelectedStorageBackend?(): string
    encryptString(plainText: string): Buffer
    decryptString(encrypted: Buffer): string
  }
}

// Resolved lazily via `require`, never a static `import ... from 'electron'`:
// a static import is link-time — it would throw before any code (including
// the GURT_FORCE_PLAINTEXT short-circuit) runs in a non-Electron host, which
// is exactly the environment the agent-migration test bundles this file into.
const requireFn = createRequire(import.meta.url)

function getElectron(): ElectronSealing | null {
  try {
    const mod = requireFn('electron') as Partial<ElectronSealing> | string
    if (!mod || typeof mod === 'string' || !mod.app || !mod.safeStorage) return null
    return mod as ElectronSealing
  } catch {
    return null
  }
}

/** Whether secret-flagged fields should be sealed on this write. `basic_text`
 *  on Linux is hardcoded-key obfuscation, not real encryption — treated as
 *  unavailable so the UI's plaintext warning stays honest. */
function sealingAvailable(): boolean {
  if (process.env['GURT_FORCE_PLAINTEXT'] === '1') return false
  const electron = getElectron()
  if (!electron) return false
  try {
    if (!electron.app.isReady()) return false
    if (!electron.safeStorage.isEncryptionAvailable()) return false
    if (process.platform === 'linux' && electron.safeStorage.getSelectedStorageBackend?.() === 'basic_text')
      return false
    return true
  } catch {
    return false
  }
}

/** The `data` keys CREDENTIAL_KINDS flags `secret: true` for a given kind. */
function secretKeys(kind: CredentialKind): string[] {
  return (CREDENTIAL_KINDS.find((k) => k.kind === kind)?.fields ?? [])
    .filter((f) => f.secret)
    .map((f) => f.key)
}

/** One warning per entry per process — a lost keychain item or a file copied
 *  from another machine fails every read, and the log must say so once, not
 *  on every IPC round trip. */
const warnedUnseal = new Set<string>()

function decryptField(electron: ElectronSealing | null, entryId: string, b64: string): string {
  try {
    if (!electron) throw new Error('no keystore access in this process')
    return electron.safeStorage.decryptString(Buffer.from(b64, 'base64'))
  } catch (e) {
    if (!warnedUnseal.has(entryId)) {
      warnedUnseal.add(entryId)
      log.warn('credential.unseal-failed', { id: entryId, err: e })
    }
    return ''
  }
}

/** On-disk entry → in-memory `CredentialEntry`: merge `sealed` (decrypted)
 *  into `data` and drop the main-only `sealed` key. Tolerates v1 plaintext,
 *  v2 plaintext, v2 sealed, and mixed files (some entries sealed, some not —
 *  e.g. after toggling GURT_FORCE_PLAINTEXT). When a field has BOTH a
 *  plaintext value in `data` and a `sealed` blob (a hand-edited file), the
 *  plaintext wins — it is the user's newer intent, and sealPlaintextSecrets
 *  reseals it (replacing the stale ciphertext) on the next start. */
function unseal(raw: unknown, electron: ElectronSealing | null): CredentialEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const { sealed, ...rest } = raw as CredentialEntry & { sealed?: Record<string, unknown> }
  if (!sealed || typeof sealed !== 'object') return rest
  const data = { ...rest.data }
  for (const [key, b64] of Object.entries(sealed)) {
    if (typeof b64 === 'string' && !data[key]) data[key] = decryptField(electron, rest.id, b64)
  }
  return { ...rest, data }
}

/**
 * The envelope of credentials.json, and only the envelope. Entries stay
 * `unknown` and are narrowed one at a time by `unseal`: an entry whose `kind`
 * this version does not know (a file written by a newer gurt, then downgraded)
 * must still survive a read/write round-trip — dropping it here would erase a
 * real credential from the file on the next save.
 */
const CREDENTIALS_ENVELOPE = z
  .looseObject({ credentials: z.array(z.unknown()).catch([]) })
  .catch({ credentials: [] })

async function read(): Promise<CredentialsFile> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(credentialsFile(), 'utf8'))
    const rawCredentials = CREDENTIALS_ENVELOPE.parse(raw).credentials
    const electron = getElectron()
    const credentials = rawCredentials
      .map((e) => unseal(e, electron))
      .filter((e): e is CredentialEntry => e !== null)
    // Every read feeds the log redactor, so a value that entered the store
    // through any path (save, migration, hand-edited file) is redacted from
    // then on — no call site has to remember that a string was a secret.
    feedRedactor(credentials)
    return { credentials }
  } catch {
    return { credentials: [] }
  }
}

/** Hand every stored secret to the log redactor (value-based redaction). */
function feedRedactor(credentials: CredentialEntry[]): void {
  const values: string[] = []
  for (const entry of credentials) {
    for (const key of secretKeys(entry.kind)) {
      const secret = entry.data?.[key]
      if (typeof secret === 'string' && secret) values.push(secret)
    }
  }
  addSecrets(values)
}

/** Load the credential store once at startup so redaction is armed before the
 *  first session (and thus the first token-bearing subprocess) exists. */
export async function loadSecrets(): Promise<void> {
  await read()
}

/** On-disk shape only — `sealed` never appears on the in-memory
 *  `CredentialEntry` shared with the rest of the app. */
interface OnDiskEntry extends CredentialEntry {
  sealed?: Record<string, string>
}

/** Just the two members `rawSealedByEntry` reads: an entry that carries no
 *  usable `sealed` blob simply has none to report. */
const SEALED_BLOBS = z.looseObject({
  id: z.string(),
  sealed: z.record(z.string(), z.string()).optional().catch(undefined)
})

/** Raw `sealed` blobs currently on disk, per entry id — read fresh (no
 *  decrypt attempt) so `seal()` can tell "this field is empty because it was
 *  never set" apart from "this field is empty because read() couldn't
 *  decrypt it a moment ago" without needing to thread that distinction
 *  through every caller. */
async function rawSealedByEntry(): Promise<Map<string, Record<string, string>>> {
  const map = new Map<string, Record<string, string>>()
  try {
    const raw: unknown = JSON.parse(await fs.readFile(credentialsFile(), 'utf8'))
    for (const e of CREDENTIALS_ENVELOPE.parse(raw).credentials) {
      const entry = SEALED_BLOBS.safeParse(e)
      if (entry.success && entry.data.sealed) map.set(entry.data.id, entry.data.sealed)
    }
  } catch {
    // no file yet — nothing to preserve
  }
  return map
}

/** In-memory entry → on-disk shape: secret-flagged fields move from `data`
 *  into `sealed` (encrypted) when sealing is available; otherwise the entry
 *  is written through unchanged (v2, no `sealed`).
 *
 *  A field that is empty at write time is NEVER treated as "clear this
 *  secret" when `priorSealed` still has ciphertext for it — read()'s decrypt
 *  failure (locked keychain, unavailable Secret Service, a file copied from
 *  another machine) collapses to the same empty string as "never set", and
 *  the two must not be conflated: the former still has a real secret, just
 *  unreadable *right now*, and a save that never touched this field (editing
 *  only the label, say) must not destroy it. The original ciphertext is
 *  carried through unchanged instead — it stays exactly as unreadable as it
 *  was, but nothing is lost, and it recovers on its own once the keystore is
 *  available again.
 *
 *  GURT_FORCE_PLAINTEXT=1 is different: the keystore still decrypts (read()
 *  does not consult the flag), so a save under the flag deliberately rewrites
 *  the decrypted secret as plaintext — the honest-plaintext contract the flag
 *  exists for, resealed by sealPlaintextSecrets on the next normal start. */
function seal(
  entry: CredentialEntry,
  electron: ElectronSealing | null,
  priorSealed: Map<string, Record<string, string>>
): OnDiskEntry {
  const keys = secretKeys(entry.kind)
  if (keys.length === 0) return entry
  const data = { ...entry.data }
  const sealed: Record<string, string> = {}
  const priorForEntry = priorSealed.get(entry.id)
  for (const key of keys) {
    const plain = data[key]
    if (plain) {
      if (electron) {
        sealed[key] = electron.safeStorage.encryptString(plain).toString('base64')
        delete data[key]
      }
      continue
    }
    const original = priorForEntry?.[key]
    if (typeof original === 'string') {
      sealed[key] = original
      delete data[key]
    }
  }
  return Object.keys(sealed).length ? { ...entry, data, sealed } : entry
}

async function write(data: CredentialsFile): Promise<void> {
  const electron = sealingAvailable() ? getElectron() : null
  const priorSealed = await rawSealedByEntry()
  const out = {
    version: 2,
    credentials: data.credentials.map((entry) => seal(entry, electron, priorSealed))
  }
  await fs.mkdir(path.dirname(credentialsFile()), { recursive: true })
  await fs.writeFile(credentialsFile(), JSON.stringify(out, null, 2) + '\n')
}

/** Every mask starts with this — and no real token can (U+2022 is not in any
 *  token alphabet), which is what lets resolveSentinels recognize a served
 *  mask by shape alone, without needing the stored value it was made from. */
const MASK_PREFIX = '••••••'

/** `'••••••' + last4` for a value longer than 8 chars, else `'••••••'`, or
 *  `''` when unset — the mask a secret-flagged field is replaced with before
 *  it ever reaches the renderer. */
function maskValue(secret: string): string {
  if (!secret) return ''
  return `${MASK_PREFIX}${secret.length > 8 ? secret.slice(-4) : ''}`
}

/** Shown instead of a mask when a field has ciphertext on disk (`sealed[key]`
 *  present — `seal()` never seals an empty string, so this can only mean a
 *  decrypt failure) but read() could not decrypt it just now — distinct from
 *  both a real mask and the "unset" empty string, so the user is not misled
 *  into thinking the secret was never set. Never itself stored as a "new"
 *  secret: `resolveSentinels` treats it as "untouched" and swaps the stored
 *  value (an empty string here) back in, and `seal()`'s empty-field branch
 *  then preserves the real ciphertext above. */
const UNSEAL_FAILED_MASK = '⚠ unavailable — keystore locked'

/** Renderer-facing view: secret-flagged fields replaced by their mask, never
 *  the plaintext. `plaintext: true` when sealing is unavailable, so the UI
 *  can warn that secrets are stored unencrypted. */
export async function getCredentials(): Promise<CredentialsFile> {
  const data = await read()
  const priorSealed = await rawSealedByEntry()
  const credentials = data.credentials.map((entry) => {
    const keys = secretKeys(entry.kind)
    if (keys.length === 0) return entry
    const masked = { ...entry.data }
    for (const key of keys) {
      const plain = masked[key] ?? ''
      masked[key] = !plain && priorSealed.get(entry.id)?.[key] ? UNSEAL_FAILED_MASK : maskValue(plain)
    }
    return { ...entry, data: masked }
  })
  return sealingAvailable() ? { credentials } : { credentials, plaintext: true }
}

/**
 * Startup migration: if sealing is available and the on-disk file still has
 * any secret-flagged field in plaintext (pre-dates this feature, was written
 * while GURT_FORCE_PLAINTEXT was set, or was hand-edited next to a stale
 * `sealed` blob — the plaintext wins, see unseal()), reseal it. Idempotent —
 * once no secret-flagged field has plaintext in `data`, there is nothing to
 * do.
 */
export async function sealPlaintextSecrets(): Promise<void> {
  if (!sealingAvailable()) return
  let raw: unknown
  try {
    raw = JSON.parse(await fs.readFile(credentialsFile(), 'utf8'))
  } catch {
    return // no file yet
  }
  const rawCredentials = Array.isArray((raw as { credentials?: unknown })?.credentials)
    ? (raw as { credentials: unknown[] }).credentials
    : []
  const needsSeal = rawCredentials.some((e) => {
    const entry = e as { kind?: CredentialKind; data?: Record<string, unknown> }
    return secretKeys(entry?.kind as CredentialKind).some(
      (key) => typeof entry?.data?.[key] === 'string' && entry.data[key]
    )
  })
  if (!needsSeal) return
  await write(await read())
}

/**
 * Everything that links to `credentialId`: repos (as `ws/repo`) and MCP
 * registry entries across every workspace, and agents (as `agent "<label>"`).
 * Every link kind blocks deletion the same way (§9).
 */
export async function credentialUsedBy(credentialId: string): Promise<string[]> {
  const used: string[] = []
  for (const ws of await listWorkspaces()) {
    const data = await getWorkspace(ws)
    for (const repo of data.repos)
      if (repo.credentialId === credentialId) used.push(`${ws}/${repo.name}`)
    for (const server of data.mcpServers ?? [])
      if (server.credentialId === credentialId) used.push(`mcp "${mcpLabel(server)}" (${ws})`)
  }
  for (const a of Object.values(await getAgents()))
    if (a.credentialId === credentialId) used.push(`agent "${a.label}"`)
  return used
}

/** The first `hosts` entry a forge provider matches (full URLs tolerated), for §3.2. */
function verificationTarget(entry: CredentialEntry): { host: string; provider: ForgeProvider } | null {
  for (const raw of entry.hosts) {
    const host = canonicalRepoId(raw)?.host ?? raw.trim().toLowerCase()
    const provider = providerForHost(host)
    if (provider) return { host, provider }
  }
  return null
}

/**
 * §3.2: unverified credentials are never stored. Every git-token entry that is
 * new, has a changed secret, or lacks a stamped identity is verified against
 * its forge; the owner's identity lands in data.gitName/gitEmail. Any failure
 * rejects the whole save.
 */
async function verifyTokens(next: CredentialEntry[], before: CredentialEntry[]): Promise<void> {
  const prev = new Map(before.map((c) => [c.id, c]))
  for (const entry of next) {
    if (entry.kind !== 'git-token') continue
    const old = prev.get(entry.id)
    const sameSecret = old?.kind === 'git-token' && old.data['secret'] === entry.data['secret']
    if (sameSecret && credentialIdentity(entry)) continue
    const target = verificationTarget(entry)
    if (!target)
      throw new Error(
        `credential "${entry.label || entry.id}": no forge provider matches its hosts — a git-token entry needs a verifiable forge host (e.g. github.com)`
      )
    const identity = await target.provider.identity(entry, target.host)
    entry.data['gitName'] = identity.name
    entry.data['gitEmail'] = identity.email
  }
}

/**
 * A save from the renderer leaves a secret-flagged field empty — or carrying
 * the mask / unseal-failure placeholder getCredentials() served — when the
 * user did not touch it. Swap each such value back to the stored one — per
 * entry id, never across entries — so an untouched field round-trips
 * unchanged. There is deliberately no "clear" spelling: an empty field always
 * means "keep what's stored" (removing a secret means deleting the entry), so
 * an untouched-but-undecryptable field resolves to '' and seal()'s
 * empty-field branch preserves its ciphertext instead of destroying it.
 *
 * "Untouched" is recognized by SHAPE (MASK_PREFIX / UNSEAL_FAILED_MASK), not
 * by comparing against the mask of the currently-stored value: the stored
 * value may be undecryptable at save time (keystore locked between
 * getCredentials and here), and comparing against its mask-of-'' would let
 * the served mask through as a "new" secret — silently stored, destroying the
 * real ciphertext. No real token starts with U+2022, so shape is safe.
 */
function resolveSentinels(entry: CredentialEntry, prior: CredentialEntry | undefined): CredentialEntry {
  const keys = secretKeys(entry.kind)
  if (keys.length === 0) return entry
  const data = { ...entry.data }
  for (const key of keys) {
    const incoming = data[key] ?? ''
    if (!incoming) {
      data[key] = prior?.data[key] ?? ''
      continue
    }
    if (incoming === UNSEAL_FAILED_MASK || incoming.startsWith(MASK_PREFIX)) {
      // A mask-shaped value on an entry with no stored counterpart cannot be
      // "untouched" — the renderer never serves a mask for a fresh entry, so
      // this is a pasted placeholder. Reject rather than silently store ''.
      if (!prior)
        throw new Error(
          `credential "${entry.label || entry.id}": the secret looks like a masked placeholder — paste the real token`
        )
      data[key] = prior.data[key] ?? ''
    }
  }
  return { ...entry, data }
}

/**
 * Save-time enforcement for `mcp-token` entries (docs/requirements-mcp-proxy.md
 * §3.2): a secret that cannot be sent as a header value never reaches the
 * store, and the stored form is the trimmed one the proxy scope will carry.
 *
 * This is the first of the three places the rule holds. The second is
 * `resolveMcpCredential`, which covers entries saved before this check existed;
 * the third is the proxy, which answers 502 rather than dying if one gets
 * through anyway. A newline here would otherwise surface as a whole proxy
 * process gone, taking every MCP route and all egress with it.
 */
function checkedEntry(entry: CredentialEntry): CredentialEntry {
  if (entry.kind !== 'mcp-token') return entry
  return { ...entry, data: { ...entry.data, secret: checkMcpSecret(entry) } }
}

/** Serializes saves: `setCredentials` is read → (network) verify → write, and
 *  two overlapping saves would each read the same `before` and last-write-wins
 *  away the other's entries. */
let saveChain: Promise<unknown> = Promise.resolve()

/**
 * Replace the whole credential set. Refuses to drop an entry a repo still links
 * to (§9: delete blocked while linked) — unlink in repo settings first — and
 * refuses to store an unverified git-token (§3.2).
 */
export function setCredentials(data: CredentialsFile): Promise<void> {
  const next = saveChain.catch(() => {}).then(async () => {
    const keptIds = new Set(data.credentials.map((c) => c.id))
    const before = await read()
    for (const entry of before.credentials) {
      if (keptIds.has(entry.id)) continue
      const users = await credentialUsedBy(entry.id)
      if (users.length)
        throw new Error(
          `credential "${entry.label || entry.id}" is linked by ${users.join(', ')} — unlink it (repo / MCP settings, ⚙ Agents) first`
        )
    }
    const beforeById = new Map(before.credentials.map((c) => [c.id, c]))
    const resolved = data.credentials.map((entry) =>
      checkedEntry(resolveSentinels(entry, beforeById.get(entry.id)))
    )
    await verifyTokens(resolved, before.credentials)
    await write({ credentials: resolved })
    // Refresh the redaction set with whatever was just stored.
    feedRedactor(resolved)
  })
  saveChain = next.catch(() => {})
  return next
}

/** Convenience for the broker/host paths: the raw entry list. */
export async function listCredentials(): Promise<CredentialEntry[]> {
  return (await read()).credentials
}

/**
 * Reject an MCP registry entry whose credential link does not resolve to an
 * `mcp-token` (docs/requirements-mcp-proxy.md §3.2). Lives here rather than in
 * store.ts's validator because the credential store is what holds the answer,
 * and it is this module that reads workspace.json — not the other way round.
 */
export async function checkMcpCredential(credentialId: string | undefined): Promise<void> {
  if (!credentialId) return
  const { error } = resolveMcpCredential(await listCredentials(), credentialId)
  if (error) throw new Error(error)
}

/**
 * One-time on-disk migration: agent secrets used to live inline in agents.json
 * (`secret`/`oauthToken` + an `enabled` flag). They now live in the credential
 * store as `agent-token` entries, linked by id like a repo's credential. Run at
 * startup, before anything reads agents. Idempotent — once secrets are lifted
 * and the legacy fields are gone, it detects nothing to do and writes nothing.
 */
export async function migrateAgentSecrets(): Promise<void> {
  const agentsPath = path.join(gurtRoot, 'agents.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(agentsPath, 'utf8'))
  } catch {
    return // no agents.json yet — nothing to migrate
  }
  const raw = STORED_AGENTS.safeParse(parsed)
  if (!raw.success) return

  const stored = Object.entries(raw.data)
    .map(([id, value]) => ({ id, ...liftAgent(id, value) }))
    .filter((e): e is { id: string } & NonNullable<ReturnType<typeof liftAgent>> => !!e.instance)
  const legacy = stored.filter(
    (e) => e.data.secret !== undefined || e.data.oauthToken !== undefined || e.data.enabled !== undefined
  )
  if (legacy.length === 0) return // already in the new shape

  const store = await read()
  const nextAgents: AgentsFile = {}
  for (const { id, data, instance } of stored) {
    const inst: AgentInstance = { ...instance }
    // A non-empty inline secret becomes a linked agent-token credential. Reuse
    // an existing entry with the same secret so a crash between the two writes
    // below heals on the next run instead of duplicating entries.
    const secret = data.secret ?? data.oauthToken ?? ''
    if (secret && !inst.credentialId) {
      let entry = store.credentials.find(
        (c) => c.kind === 'agent-token' && c.data['secret'] === secret
      )
      if (!entry) {
        entry = {
          id: randomUUID(),
          label: `${inst.label} token`,
          kind: 'agent-token',
          hosts: [],
          data: { secret }
        }
        store.credentials.push(entry)
      }
      inst.credentialId = entry.id
    }
    nextAgents[id] = inst
  }

  await write(store)
  feedRedactor(store.credentials)
  await setAgents(nextAgents)
}
