// Credential store — CRUD over ~/.gurt/credentials.json, in the store.ts style.
//
// Plaintext for now, the same tradeoff as agents.json; encrypted storage
// (safeStorage) is a later, isolated change. Secrets never leave this file
// except through the git broker's per-request responses (§3, §4).
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CredentialEntry, CredentialsFile } from '../shared/credentials'
import { gurtRoot, getWorkspace, listWorkspaces } from './store'

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

/**
 * Replace the whole credential set. Refuses to drop an entry a repo still links
 * to (§9: delete blocked while linked) — unlink in repo settings first.
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
  await write(data)
}

/** Convenience for the broker/host paths: the raw entry list. */
export async function listCredentials(): Promise<CredentialEntry[]> {
  return (await read()).credentials
}
