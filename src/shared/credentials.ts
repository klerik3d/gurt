// Credential store schema + resolution, shared by main and renderer.
//
// The store is deliberately generic (`kind` + opaque `data`) so it is not
// git-only: agent secrets in agents.json migrate to entries here later
// (`agent-*` kinds, phase 3) and link by id the same way repos do.

import type { RepoConfig } from './types'
import { canonicalRepoId } from './repoId'
import { headerValueProblem, isHeaderName } from './mcp'

export type CredentialKind =
  | 'git-token'
  | 'git-app'
  | 'git-host'
  | 'agent-token'
  | 'mcp-token'
  | 'oauth'

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
  /** True when secrets are stored unencrypted — no OS keystore available (or
   *  GURT_FORCE_PLAINTEXT=1). Main-computed, renderer-facing warning only. */
  plaintext?: boolean
}

/** Default HTTP-basic username for token credentials (GitHub App / PAT convention). */
export const DEFAULT_TOKEN_USER = 'x-access-token'

/** Header an `mcp-token` is sent in, and the scheme prefixing it, unless the
 *  entry overrides them (§3.2). */
export const DEFAULT_MCP_HEADER = 'Authorization'
export const DEFAULT_MCP_SCHEME = 'Bearer'

/** The header an `mcp-token` credential resolves to, ready to send upstream. */
export interface McpAuthHeader {
  name: string
  value: string
}

/** Commit identity of a credential's owner, stamped by save-time verification (§3.2). */
export interface GitIdentity {
  name: string
  email: string
}

/** The stamped identity of an entry, or null when it was never verified. */
export const credentialIdentity = (entry: CredentialEntry): GitIdentity | null =>
  entry.data['gitName'] && entry.data['gitEmail']
    ? { name: entry.data['gitName'], email: entry.data['gitEmail'] }
    : null

/**
 * Kinds a previous gurt stored and this one no longer implements. `git-ssh-key`
 * went with ssh git support (docs/requirements-mcp-proxy.md §10.1): the session
 * container authenticates to nothing, so a key-based second path to the forge
 * had no user left, and an agent socket bridged into a container is exactly the
 * ambient authority that change exists to remove.
 *
 * An entry stored under one still survives a read/write round-trip of
 * credentials.json (see CREDENTIALS_ENVELOPE in main/credentials.ts) — nothing
 * silently deletes a user's data. What it does not do is resolve: per the
 * credential policy an unresolvable credential *blocks*, it never falls back to
 * ambient auth.
 */
export const RETIRED_KINDS: readonly string[] = ['git-ssh-key']

/** Whether this build still implements `kind` at all. */
export const isRetiredKind = (kind: string): boolean => RETIRED_KINDS.includes(kind)

/** Why a stored entry cannot be resolved as-is, or undefined when it can:
 *  a retired kind (above), or — §3.2 — a git-token without stamped identity,
 *  which predates save-time verification. */
const entryError = (entry: CredentialEntry): string | undefined => {
  if (isRetiredKind(entry.kind))
    return `credential "${entry.label || entry.id}" is an ssh key — unsupported credential kind, ssh git support was removed; replace it with a token credential`
  if (entry.kind === 'git-token' && !credentialIdentity(entry))
    return `credential "${entry.label || entry.id}" has no verified identity — re-save it in Credentials`
  return undefined
}

/** One editable field of a credential kind, for the credentials modal. */
export interface CredentialField {
  key: string
  label: string
  /** Rendered as a password input and never echoed back to the UI in cleartext. */
  secret?: boolean
  placeholder?: string
  /** Never rendered in the modal. The field is still declared because this
   *  list is the sealing manifest (docs/requirements-oauth-credentials.md
   *  §2.1): `secretKeys()` reads it to decide what gets sealed, masked and
   *  fed to the redactor, so a value obtained by a flow rather than typed
   *  must be hidden here — never omitted. */
  hidden?: boolean
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
  },
  {
    kind: 'agent-token',
    label: 'agent token',
    // Presented as a peer of `oauth sign-in` below, the hint saying which path
    // each is (docs/requirements-oauth-credentials.md §4): neither recommended,
    // neither buried.
    hint:
      'Paste an API key — CI, self-hosted gateways, enterprise proxies. ' +
      'Linked from an agent in ⚙ Agents; not a git host, so it needs no hosts.',
    fields: [
      { key: 'secret', label: 'token / api key', secret: true, placeholder: 'sk-… / oauth token' }
    ],
    implemented: true
  },
  {
    kind: 'oauth',
    label: 'oauth sign-in',
    hint:
      'Sign in with your Claude / ChatGPT / Gemini account — gurt runs the browser ' +
      'sign-in and refreshes the tokens itself. Links from an agent or an MCP server ' +
      'exactly like a token.',
    // Hidden, not omitted (§2.1): no text input ever renders for these, but the
    // declaration is what makes `secretKeys()` seal, mask and redact the token
    // set the sign-in flow stores.
    fields: [
      { key: 'refresh', label: 'refresh token', secret: true, hidden: true },
      { key: 'access', label: 'access token', secret: true, hidden: true },
      // Provider-specific (§2: extra fields are legal, named by the provider
      // module): openai's id_token JWT — bearer-ish, so sealed like the tokens.
      { key: 'idToken', label: 'id token', secret: true, hidden: true }
    ],
    implemented: true
  },
  {
    kind: 'mcp-token',
    label: 'mcp token',
    hint:
      'Auth for an MCP server in ⚙ MCP servers. Sent as "<header>: <scheme> <secret>". ' +
      'Leave scheme unset for Bearer; clear it to send the bare secret (X-Api-Key style).',
    fields: [
      { key: 'secret', label: 'token / api key', secret: true, placeholder: 'sk-… / api key' },
      { key: 'header', label: 'header (optional)', placeholder: DEFAULT_MCP_HEADER },
      { key: 'scheme', label: 'scheme (optional)', placeholder: DEFAULT_MCP_SCHEME }
    ],
    implemented: true
  }
]

/** Kinds that are not a git transport: they link explicitly (from an agent, from
 *  an MCP registry entry) and never auto-match a host. */
const NON_GIT_KINDS: readonly CredentialKind[] = ['agent-token', 'mcp-token', 'oauth']

/** Whether a kind matches a git host (auto-match, forge verification, hosts field). */
export const isGitKind = (kind: CredentialKind): boolean => !NON_GIT_KINDS.includes(kind)

/** The provider modules `src/main/oauth/providers/` implements, for the
 *  renderer's provider picker — ids must match `OAUTH_PROVIDERS` in main. */
export const OAUTH_PROVIDER_CHOICES: readonly { id: string; label: string }[] = [
  { id: 'anthropic', label: 'Claude (Anthropic)' },
  { id: 'openai', label: 'ChatGPT (OpenAI)' },
  { id: 'google', label: 'Gemini (Google)' }
]

/**
 * §2 of docs/requirements-oauth-credentials.md: the sentence an unresolvable
 * `oauth` entry blocks with. Actionable on purpose — the Credentials modal is
 * where "sign in again" points.
 */
export const signedOutError = (entry: CredentialEntry): string =>
  `credential "${entry.label || entry.id}" is signed out — sign in again in Credentials`

/**
 * Whether an `oauth` entry holds no usable sign-in: it was never signed in (no
 * refresh token), or the provider declared the refresh token dead — recorded
 * as the plaintext `data.signedOut` marker by main's refresh path, since the
 * detection happens at resolve time and the modal has to be able to show it.
 * Works on the renderer's masked view too: a served mask is non-empty exactly
 * when the stored token is.
 */
export const oauthSignedOut = (entry: CredentialEntry): boolean =>
  entry.kind === 'oauth' && (!!entry.data['signedOut'] || !entry.data['refresh'])

/** Agent-token and oauth entries — the pool the Agents editor links against. */
export const agentCredentials = (credentials: CredentialEntry[]): CredentialEntry[] =>
  credentials.filter((c) => c.kind === 'agent-token' || c.kind === 'oauth')

/** Mcp-token and oauth entries — the pool the MCP registry editor links against. */
export const mcpCredentials = (credentials: CredentialEntry[]): CredentialEntry[] =>
  credentials.filter((c) => c.kind === 'mcp-token' || c.kind === 'oauth')

/**
 * Resolve the auth header an MCP registry entry's credential link injects
 * (docs/requirements-mcp-proxy.md §3.2), in the style of `resolveCredential`:
 * no link ⇒ nothing (an unauthenticated upstream is legal), a dangling or
 * wrong-kind link ⇒ a configuration error the caller surfaces.
 *
 * `scheme` unset ⇒ the `Bearer` default; explicitly empty ⇒ the bare secret.
 *
 * Whether the secret *works* is not checked here — an upstream's auth failure
 * surfaces on first use as a 401, and the renderer only ever holds a mask. What
 * is checked is whether it can be sent at all: a secret carrying a newline (the
 * ordinary paste artifact) makes a header value node refuses to construct, and
 * it would do so inside the proxy's request listener. `checkMcpSecret` rejects
 * that on save, but a credential stored before that check existed has never
 * been through it, so this is the layer that has to hold — a resolution error,
 * surfaced like a dangling link, rather than a poisoned header handed onward.
 */
export function resolveMcpCredential(
  credentials: readonly CredentialEntry[],
  credentialId: string | undefined
): { header?: McpAuthHeader; error?: string } {
  if (!credentialId) return {}
  const entry = credentials.find((c) => c.id === credentialId)
  if (!entry) return { error: 'linked credential no longer exists' }
  const label = entry.label || entry.id
  if (entry.kind === 'oauth') {
    // The access token composes exactly as an `mcp-token`'s secret does, with
    // the default header and scheme — an oauth entry has no overrides. This
    // pure half reads whatever `data.access` holds; the main-side caller
    // (resolveProxyPlan, the probe) refreshes it first (§2 of
    // docs/requirements-oauth-credentials.md).
    if (oauthSignedOut(entry)) return { error: signedOutError(entry) }
    const value = `${DEFAULT_MCP_SCHEME} ${(entry.data['access'] ?? '').trim()}`
    const problem = headerValueProblem(value)
    if (problem) return { error: `linked credential "${label}" ${problem}` }
    return { header: { name: DEFAULT_MCP_HEADER, value } }
  }
  if (entry.kind !== 'mcp-token')
    return { error: `linked credential "${label}" is not an MCP token` }
  const name = entry.data['header']?.trim() || DEFAULT_MCP_HEADER
  if (!isHeaderName(name))
    return { error: `linked credential "${label}" has "${name}" as its header name, which is not a valid header name` }
  const raw = entry.data['scheme']
  const scheme = (raw === undefined ? DEFAULT_MCP_SCHEME : raw).trim()
  const secret = (entry.data['secret'] ?? '').trim()
  // The composed value, not the secret alone: a scheme is user-typed too.
  const value = scheme ? `${scheme} ${secret}` : secret
  const bad = headerValueProblem(value)
  if (bad) return { error: `linked credential "${label}" ${bad} — re-enter it as a single line` }
  return { header: { name, value } }
}

/**
 * Resolve the same `mcp-token` link for a **local** MCP server, which has no
 * request headers to carry it (docs/requirements-mcp-stdio.md §3.4). The value
 * is the bare secret — no header name, no `Bearer` scheme — because it is going
 * into an environment variable the server names itself, exactly the way an
 * agent's `secretEnv` works.
 *
 * Same contract as {@link resolveMcpCredential} otherwise: no link ⇒ nothing (a
 * server that authenticates some other way is legal), a dangling or wrong-kind
 * link ⇒ a configuration error the caller surfaces rather than a silent
 * unauthenticated start.
 *
 * The one check that survives the change of transport is the NUL byte: `execve`
 * cannot carry one, and a secret containing it would truncate the whole
 * environment entry rather than fail loudly. Newlines are legal in an
 * environment value and are left alone — the header rule they exist for does
 * not apply here.
 */
export function resolveMcpEnvSecret(
  credentials: readonly CredentialEntry[],
  credentialId: string | undefined
): { secret?: string; error?: string } {
  if (!credentialId) return {}
  const entry = credentials.find((c) => c.id === credentialId)
  if (!entry) return { error: 'linked credential no longer exists' }
  if (entry.kind === 'oauth' && oauthSignedOut(entry)) return { error: signedOutError(entry) }
  if (entry.kind !== 'mcp-token' && entry.kind !== 'oauth')
    return { error: `linked credential "${entry.label || entry.id}" is not an MCP token` }
  // An oauth entry contributes its (main-side refreshed, §2) access token the
  // way an mcp-token contributes its pasted secret: the bare value, into the
  // env var the server names.
  const secret = (entry.data[entry.kind === 'oauth' ? 'access' : 'secret'] ?? '').trim()
  if (secret.includes('\0'))
    return {
      error: `linked credential "${entry.label || entry.id}" contains a NUL byte — re-enter it`
    }
  return { secret }
}

/**
 * Throws when an `mcp-token` entry could not be sent as a header — the save-time
 * half of the same rule `resolveMcpCredential` enforces at use time (§3.2).
 *
 * Leading and trailing whitespace is stripped rather than refused: it is a
 * paste artifact with no meaning in a token, and `resolveMcpCredential` trims
 * too, so storing it trimmed is what makes the stored entry match the header it
 * will produce. A newline is not strippable in the same way — it may sit in the
 * middle, and a "token" that spans lines is not a token — so it is an error the
 * user has to see.
 */
export function checkMcpSecret(entry: CredentialEntry): string {
  const secret = (entry.data['secret'] ?? '').trim()
  const bad = headerValueProblem(secret)
  if (bad)
    throw new Error(
      `credential "${entry.label || entry.id}": the token ${bad} — paste it as a single line`
    )
  const header = entry.data['header']?.trim() || DEFAULT_MCP_HEADER
  if (!isHeaderName(header))
    throw new Error(`credential "${entry.label || entry.id}": "${header}" is not a valid header name`)
  const scheme = (entry.data['scheme'] ?? DEFAULT_MCP_SCHEME).trim()
  const schemeBad = headerValueProblem(scheme)
  if (schemeBad)
    throw new Error(`credential "${entry.label || entry.id}": the scheme ${schemeBad}`)
  return secret
}

/**
 * Resolve the secret an agent injects, from its linked credential id (§6, like
 * a repo's credential link). No link ⇒ empty (the adapter starts and reports its
 * own auth error); a dangling link is a config error the caller surfaces.
 *
 * For an `oauth` entry this pure half only identifies the entry and hands back
 * the *stored* access token, which may be stale: the main-side caller
 * (`resolveLaunch`) sees `entry.kind === 'oauth'` and awaits
 * `resolveOAuthAccess` before injecting anything — the §2 async seam of
 * docs/requirements-oauth-credentials.md.
 */
export function resolveAgentSecret(
  credentials: CredentialEntry[],
  credentialId: string | undefined
): { secret: string; entry?: CredentialEntry; error?: string } {
  if (!credentialId) return { secret: '' }
  const entry = credentials.find((c) => c.id === credentialId)
  if (!entry) return { secret: '', error: 'linked credential no longer exists' }
  if (entry.kind === 'oauth') {
    if (oauthSignedOut(entry)) return { secret: '', entry, error: signedOutError(entry) }
    return { secret: entry.data['access'] ?? '', entry }
  }
  if (entry.kind !== 'agent-token')
    return { secret: '', error: `linked credential "${entry.label}" is not an agent token` }
  return { secret: entry.data['secret'] ?? '', entry }
}

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
    if (!isGitKind(entry.kind))
      return {
        kind: 'git-host',
        source: 'implicit',
        error: `linked credential "${entry.label}" is not a git credential`
      }
    const linkError = entryError(entry)
    return { entry, kind: entry.kind, source: 'link', ...(linkError ? { error: linkError } : {}) }
  }
  // Step 2: auto-match by host — git kinds only; an agent-token is never a
  // git transport, whatever its hosts say.
  const match = credentials.find((c) => isGitKind(c.kind) && c.hosts.includes(host))
  if (match) {
    const matchError = entryError(match)
    return {
      entry: match,
      kind: match.kind,
      source: 'match',
      ...(matchError ? { error: matchError } : {})
    }
  }
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
