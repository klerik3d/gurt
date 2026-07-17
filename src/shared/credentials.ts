// Credential store schema + resolution, shared by main and renderer.
//
// The store is deliberately generic (`kind` + opaque `data`) so it is not
// git-only: agent secrets in agents.json migrate to entries here later
// (`agent-*` kinds, phase 3) and link by id the same way repos do.

import type { RepoConfig } from './types'
import { canonicalRepoId } from './repoId'

export type CredentialKind = 'git-token' | 'git-ssh-key' | 'git-app' | 'git-host'

export interface CredentialEntry {
  /** uuid, stable — configs link by this. */
  id: string
  label: string
  kind: CredentialKind
  /** Git hosts for auto-match; [] = explicit link only. */
  hosts: string[]
  /** Kind-specific opaque fields — see CREDENTIAL_KINDS below. */
  data: Record<string, string>
}

export interface CredentialsFile {
  credentials: CredentialEntry[]
}

/** Default HTTP-basic username for token credentials (GitHub App / PAT convention). */
export const DEFAULT_TOKEN_USER = 'x-access-token'

/** Commit identity of a credential's owner, stamped by save-time verification (§3.2). */
export interface GitIdentity {
  name: string
  email: string
}

/** The stamped identity of an entry, or null when it was never verified. */
export const credentialIdentity = (entry: CredentialEntry): GitIdentity | null =>
  entry.data.gitName && entry.data.gitEmail
    ? { name: entry.data.gitName, email: entry.data.gitEmail }
    : null

/**
 * §3.2: a git-token entry without stamped identity predates save-time
 * verification and must not be used — resolution errors instead of serving it.
 */
const unverifiedError = (entry: CredentialEntry): string | undefined =>
  entry.kind === 'git-token' && !credentialIdentity(entry)
    ? `credential "${entry.label || entry.id}" has no verified identity — re-save it in Credentials`
    : undefined

/** One editable field of a credential kind, for the credentials modal. */
export interface CredentialField {
  key: string
  label: string
  /** Rendered as a password input and never echoed back to the UI in cleartext. */
  secret?: boolean
  placeholder?: string
}

/** UI metadata + which phase implements each kind's runtime path. */
export interface CredentialKindDef {
  kind: CredentialKind
  label: string
  hint: string
  fields: CredentialField[]
  /** false → shown in the modal but the runtime path is not implemented yet. */
  implemented: boolean
}

export const CREDENTIAL_KINDS: CredentialKindDef[] = [
  {
    kind: 'git-token',
    label: 'token (HTTPS)',
    hint: 'PAT, fine-grained PAT, GitLab/Gitea token — anything usable as HTTP basic auth.',
    fields: [
      { key: 'secret', label: 'token', secret: true, placeholder: 'ghp_… / glpat-…' },
      { key: 'username', label: 'username (optional)', placeholder: DEFAULT_TOKEN_USER }
    ],
    implemented: true
  },
  {
    kind: 'git-host',
    label: 'host credentials',
    hint:
      "Explicit opt-in to the host's ambient git auth (ssh keys / gh login). " +
      'Never applied unless a repo resolves to this entry.',
    fields: [],
    implemented: true
  },
  {
    kind: 'git-ssh-key',
    label: 'ssh key',
    hint: 'Dedicated key file, or a bridge to the host ssh-agent. (phase 2)',
    fields: [
      { key: 'keyPath', label: 'key path (host)', placeholder: '~/.ssh/id_ed25519' },
      { key: 'hostAgent', label: 'or bridge host agent ("1")', placeholder: '' }
    ],
    implemented: false
  },
  {
    kind: 'git-app',
    label: 'github app',
    hint: 'Broker mints short-lived installation tokens. (phase 3)',
    fields: [
      { key: 'provider', label: 'provider', placeholder: 'github-app' },
      { key: 'appId', label: 'app id' },
      { key: 'installationId', label: 'installation id' },
      { key: 'privateKeyPath', label: 'private key path' }
    ],
    implemented: false
  }
]

export const credentialKindLabel = (kind: CredentialKind): string =>
  CREDENTIAL_KINDS.find((k) => k.kind === kind)?.label ?? kind

/**
 * Outcome of resolving a credential for a request to `host` on behalf of `repo`.
 * `entry` absent ⇒ nothing resolved: consumers must block remote access, not
 * fall back to ambient — ambient is only the explicit `git-host` kind (§3.1).
 * `error` set ⇒ a configuration problem to surface in the UI.
 */
export interface CredResolution {
  entry?: CredentialEntry
  kind: CredentialKind
  source: 'link' | 'match' | 'implicit'
  error?: string
}

/**
 * Resolve which credential answers a request to `host` for `repo` (§3.1):
 *   1. repo.credentialId (only for the repo's own host) → that entry,
 *   2. else the first entry whose `hosts` contains `host` (auto-match),
 *   3. else nothing (`entry` absent) — consumers block remote access; ambient
 *      is never a fallback.
 *
 * Per-request, not per-env: a submodule fetch on another host auto-matches by
 * that host (step 2), independent of the env repo's link.
 */
export function resolveCredential(
  credentials: CredentialEntry[],
  repo: RepoConfig,
  host: string
): CredResolution {
  const ownHost = canonicalRepoId(repo.url)?.host
  // Step 1: the explicit link, honored only for the repo's own host.
  if (repo.credentialId && host === ownHost) {
    const entry = credentials.find((c) => c.id === repo.credentialId)
    if (!entry)
      return { kind: 'git-host', source: 'implicit', error: 'linked credential no longer exists' }
    return { entry, kind: entry.kind, source: 'link', error: unverifiedError(entry) }
  }
  // Step 2: auto-match by host.
  const match = credentials.find((c) => c.hosts.includes(host))
  if (match) return { entry: match, kind: match.kind, source: 'match', error: unverifiedError(match) }
  // Step 3: implicit ambient host credentials.
  return { kind: 'git-host', source: 'implicit' }
}

/** Resolution for a repo against its own host — used by the repo-settings preview. */
export function resolveForRepo(
  credentials: CredentialEntry[],
  repo: RepoConfig
): CredResolution | null {
  const host = canonicalRepoId(repo.url)?.host
  if (!host) return null
  return resolveCredential(credentials, repo, host)
}

/** True when a resolution yields a real, gurt-managed credential (not ambient). */
export const hasManagedCredential = (r: CredResolution | null): boolean =>
  !!r && !!r.entry && r.kind !== 'git-host' && !r.error
