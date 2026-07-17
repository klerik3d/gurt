// Credential store — CRUD over ~/.gurt/credentials.json, in the store.ts style.
//
// Plaintext for now, the same tradeoff as agents.json; encrypted storage
// (safeStorage) is a later, isolated change. Secrets never leave this file
// except through the git broker's per-request responses (§3, §4).
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { AgentInstance, AgentsFile } from '../shared/types'
import type { CredentialEntry, CredentialsFile } from '../shared/credentials'
import { credentialIdentity } from '../shared/credentials'
import { canonicalRepoId } from '../shared/repoId'
import { gurtRoot, getWorkspace, listWorkspaces, setAgents } from './store'
import { agentDef } from '../shared/agents'
import { providerForHost, type ForgeProvider } from './git/providers'

const credentialsFile = (): string => path.join(gurtRoot, 'credentials.json')

async function read(): Promise<CredentialsFile> {
  try {
    const raw = JSON.parse(await fs.readFile(credentialsFile(), 'utf8'))
    return { credentials: Array.isArray(raw?.credentials) ? raw.credentials : [] }
  } catch {
    return { credentials: [] }
  }
}

async function write(data: CredentialsFile): Promise<void> {
  await fs.mkdir(path.dirname(credentialsFile()), { recursive: true })
  await fs.writeFile(credentialsFile(), JSON.stringify(data, null, 2) + '\n')
}

export async function getCredentials(): Promise<CredentialsFile> {
  return read()
}

/** Repos (as `ws/repo`) that link to `credentialId`, across every workspace. */
export async function credentialUsedBy(credentialId: string): Promise<string[]> {
  const used: string[] = []
  for (const ws of await listWorkspaces()) {
    const data = await getWorkspace(ws)
    for (const repo of data.repos)
      if (repo.credentialId === credentialId) used.push(`${ws}/${repo.name}`)
  }
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
    const sameSecret = old?.kind === 'git-token' && old.data.secret === entry.data.secret
    if (sameSecret && credentialIdentity(entry)) continue
    const target = verificationTarget(entry)
    if (!target)
      throw new Error(
        `credential "${entry.label || entry.id}": no forge provider matches its hosts — a git-token entry needs a verifiable forge host (e.g. github.com)`
      )
    const identity = await target.provider.identity(entry, target.host)
    entry.data.gitName = identity.name
    entry.data.gitEmail = identity.email
  }
}

/**
 * Replace the whole credential set. Refuses to drop an entry a repo still links
 * to (§9: delete blocked while linked) — unlink in repo settings first — and
 * refuses to store an unverified git-token (§3.2).
 */
export async function setCredentials(data: CredentialsFile): Promise<void> {
  const keptIds = new Set(data.credentials.map((c) => c.id))
  const before = await read()
  for (const entry of before.credentials) {
    if (keptIds.has(entry.id)) continue
    const users = await credentialUsedBy(entry.id)
    if (users.length)
      throw new Error(
        `credential "${entry.label || entry.id}" is linked by ${users.join(', ')} — unlink it in repo settings first`
      )
  }
  await verifyTokens(data.credentials, before.credentials)
  await write(data)
}

/** Convenience for the broker/host paths: the raw entry list. */
export async function listCredentials(): Promise<CredentialEntry[]> {
  return (await read()).credentials
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
  let raw: Record<string, any>
  try {
    raw = JSON.parse(await fs.readFile(agentsPath, 'utf8'))
  } catch {
    return // no agents.json yet — nothing to migrate
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return

  const legacy = Object.entries(raw).filter(
    ([, a]) =>
      a && typeof a === 'object' && ('secret' in a || 'oauthToken' in a || 'enabled' in a)
  )
  if (legacy.length === 0) return // already in the new shape

  const store = await read()
  const nextAgents: AgentsFile = {}
  for (const [id, a] of Object.entries(raw)) {
    if (!a || typeof a !== 'object') continue
    const kind = typeof a.kind === 'string' ? a.kind : agentDef(id) ? id : undefined
    if (!kind) continue
    const inst: AgentInstance = {
      kind,
      label: a.label || agentDef(kind)?.label || kind,
      credentialId: typeof a.credentialId === 'string' ? a.credentialId : undefined,
      secretEnv: a.secretEnv || undefined,
      env: a.env && typeof a.env === 'object' ? a.env : undefined
    }
    // A non-empty inline secret becomes a linked agent-token credential.
    const secret: string = a.secret ?? a.oauthToken ?? ''
    if (secret && !inst.credentialId) {
      const entry: CredentialEntry = {
        id: randomUUID(),
        label: `${inst.label} token`,
        kind: 'agent-token',
        hosts: [],
        data: { secret }
      }
      store.credentials.push(entry)
      inst.credentialId = entry.id
    }
    nextAgents[id] = inst
  }

  await write(store)
  await setAgents(nextAgents)
}
