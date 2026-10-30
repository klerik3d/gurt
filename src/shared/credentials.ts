// Credential store schema + resolution, shared by main and renderer.
//
// The store is deliberately generic (`kind` + opaque `data`) so it is not
// git-only: agent secrets in agents.json migrate to entries here later
// (`agent-*` kinds, phase 3) and link by id the same way repos do.

import type { RepoConfig } from './types'
import { canonicalRepoId } from './repoId'
import type { McpHeader, McpHttpEntry, McpLocalEntry } from './mcp'
import { headerValueProblem, isHeaderName, isMcpCredentialRef } from './mcp'

export type CredentialKind =
  | 'git-token'
  | 'git-app'
  | 'git-host'
  | 'agent-token'
  | 'mcp-token'
  | 'oauth'
  | 'pii-detector'

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

/** The header a legacy http link (`McpHttpEntry.credentialId`) is sent in, and
 *  the scheme prefixing it, unless the `mcp-token` overrode them (§3.2). */
export const DEFAULT_MCP_HEADER = 'Authorization'
export const DEFAULT_MCP_SCHEME = 'Bearer'

/** A header with its credential resolved, ready to send upstream. */
export interface McpResolvedHeader {
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
    kind: 'pii-detector',
    label: 'pii detector',
    hint:
      'URL + api key of an external PII detector (a Presidio analyzer you run). ' +
      'Linked from ⚙ Masking; not a git host, so it needs no hosts.',
    fields: [
      { key: 'url', label: 'analyzer url', placeholder: 'https://presidio.internal:3000' },
      { key: 'apiKey', label: 'api key (optional)', secret: true, placeholder: '' }
    ],
    implemented: true
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
      'A secret for an MCP server in ⚙ MCP servers. Which header or environment variable ' +
      'it goes into, and with what prefix, is set on the server, not here.',
    // `header` and `scheme` are no longer edited here: where a secret goes is
    // the server's business. An entry saved with them keeps them in `data`,
    // where `legacyMcpHeader` still reads them.
    fields: [
      { key: 'secret', label: 'token / api key', secret: true, placeholder: 'sk-… / api key' }
    ],
    implemented: true
  }
]

/** Kinds that are not a git transport: they link explicitly (from an agent, from
 *  an MCP registry entry, from Settings → Masking) and never auto-match a host. */
const NON_GIT_KINDS: readonly CredentialKind[] = ['agent-token', 'mcp-token', 'oauth', 'pii-detector']

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

/** pii-detector entries — the pool Settings → Masking links against (§5.3). */
export const piiCredentials = (credentials: CredentialEntry[]): CredentialEntry[] =>
  credentials.filter((c) => c.kind === 'pii-detector')

/** Agent-token and oauth entries — the pool the Agents editor links against. */
export const agentCredentials = (credentials: CredentialEntry[]): CredentialEntry[] =>
  credentials.filter((c) => c.kind === 'agent-token' || c.kind === 'oauth')

/** Mcp-token and oauth entries — the pool the MCP registry editor links against. */
export const mcpCredentials = (credentials: CredentialEntry[]): CredentialEntry[] =>
  credentials.filter((c) => c.kind === 'mcp-token' || c.kind === 'oauth')

/**
 * The bare secret behind one MCP credential link (docs/requirements-mcp-proxy.md
 * §3.2), in the style of `resolveCredential`: a dangling or wrong-kind link is a
 * configuration error the caller surfaces, never a silent unauthenticated call.
 *
 * An `mcp-token` contributes its pasted secret, an `oauth` entry its access
 * token — which this pure half reads as it is; the main-side callers refresh it
 * first (§2 of docs/requirements-oauth-credentials.md). Whether the secret can
 * be *carried* depends on where it goes, so that is the caller's check
 * ({@link resolveMcpHeaders}, {@link resolveMcpSecretEnv}). `label` is for those
 * callers' error messages.
 */
export function resolveMcpSecret(
  credentials: readonly CredentialEntry[],
  credentialId: string
): { secret?: string; label?: string; error?: string } {
  const entry = credentials.find((c) => c.id === credentialId)
  if (!entry) return { error: 'linked credential no longer exists' }
  const label = entry.label || entry.id
  if (entry.kind === 'oauth') {
    if (oauthSignedOut(entry)) return { error: signedOutError(entry) }
    return { secret: (entry.data['access'] ?? '').trim(), label }
  }
  if (entry.kind !== 'mcp-token') return { error: `linked credential "${label}" is not an MCP token` }
  return { secret: (entry.data['secret'] ?? '').trim(), label }
}

/**
 * The header row a legacy http link (`McpHttpEntry.credentialId`) stands for.
 * Before any header could link a credential, the header name and scheme lived
 * on the `mcp-token` (`data.header`, `data.scheme`); an `oauth` entry had no
 * overrides. `scheme` unset ⇒ `Bearer`, explicitly empty ⇒ the bare secret.
 *
 * A link that no longer resolves still lifts — to the default header — so the
 * error it produces is the resolver's "no longer exists", not a lost link.
 */
export function legacyMcpHeader(
  credentials: readonly CredentialEntry[],
  credentialId: string
): McpHeader {
  const entry = credentials.find((c) => c.id === credentialId)
  const token = entry?.kind === 'mcp-token' ? entry : undefined
  const name = token?.data['header']?.trim() || DEFAULT_MCP_HEADER
  const raw = token?.data['scheme']
  const scheme = (raw === undefined ? DEFAULT_MCP_SCHEME : raw).trim()
  return { name, value: { credentialId, ...(scheme ? { prefix: `${scheme} ` } : {}) } }
}

/**
 * An http entry with its legacy link turned into the header row it means — the
 * shape the editor saves, and the one every resolver reads. The lifted header
 * replaces a static one of the same name, whatever its spelling: that is what
 * the legacy link always did.
 */
export function liftLegacyMcpCredential(
  credentials: readonly CredentialEntry[],
  entry: McpHttpEntry
): McpHttpEntry {
  if (!entry.credentialId) return entry
  const { credentialId, ...rest } = entry
  const header = legacyMcpHeader(credentials, credentialId)
  const key = header.name.toLowerCase()
  return {
    ...rest,
    headers: [...(entry.headers ?? []).filter((h) => h.name.toLowerCase() !== key), header]
  }
}

/**
 * The headers an http entry sends upstream, every credential link resolved
 * (docs/requirements-mcp-proxy.md §3.2). One error and nothing else when any
 * link fails: a request missing one of its headers is a request the upstream
 * would refuse in a way nobody could explain.
 *
 * Whether a secret *works* is not checked — an upstream's auth failure surfaces
 * on first use as a 401. What is checked is whether it can be sent at all: a
 * value carrying a newline (the ordinary paste artifact) makes a header node
 * refuses to construct, and it would do so inside the proxy's request listener.
 * `checkMcpSecret` rejects that on save, but a credential stored before that
 * check existed has never been through it, so this is the layer that has to
 * hold.
 */
export function resolveMcpHeaders(
  credentials: readonly CredentialEntry[],
  entry: McpHttpEntry
): { headers?: McpResolvedHeader[]; error?: string } {
  const headers: McpResolvedHeader[] = []
  for (const h of liftLegacyMcpCredential(credentials, entry).headers ?? []) {
    if (!isMcpCredentialRef(h.value)) {
      headers.push({ name: h.name, value: h.value })
      continue
    }
    const { secret, label, error } = resolveMcpSecret(credentials, h.value.credentialId)
    if (error) return { error }
    if (!isHeaderName(h.name))
      return { error: `linked credential "${label}" is sent as "${h.name}", which is not a valid header name` }
    // The composed value, not the secret alone: the prefix is user-typed too.
    const value = `${h.value.prefix ?? ''}${secret ?? ''}`
    const bad = headerValueProblem(value)
    if (bad) return { error: `linked credential "${label}" ${bad} — re-enter it as a single line` }
    headers.push({ name: h.name, value })
  }
  return { headers }
}

/**
 * The environment variables a local entry's credential links resolve to
 * (docs/requirements-mcp-stdio.md §3.4) — the linked half only; the typed-in
 * half is `mcpLiteralEnv`. Same contract as {@link resolveMcpHeaders}: one
 * error and nothing else when any link fails, rather than a process started
 * with half its secrets.
 *
 * The one check that survives the change of transport is the NUL byte: `execve`
 * cannot carry one, and a secret containing it would truncate the whole
 * environment entry rather than fail loudly. Newlines are legal in an
 * environment value and are left alone — the header rule they exist for does
 * not apply here.
 */
export function resolveMcpSecretEnv(
  credentials: readonly CredentialEntry[],
  entry: McpLocalEntry
): { env?: Record<string, string>; error?: string } {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(entry.env ?? {})) {
    if (!isMcpCredentialRef(value)) continue
    const { secret, label, error } = resolveMcpSecret(credentials, value.credentialId)
    if (error) return { error }
    const composed = `${value.prefix ?? ''}${secret ?? ''}`
    if (composed.includes('\0'))
      return { error: `linked credential "${label}" contains a NUL byte — re-enter it` }
    env[name] = composed
  }
  return { env }
}

/**
 * Throws when an `mcp-token` entry could not be sent as a header — the save-time
 * half of the same rule `resolveMcpHeaders` enforces at use time (§3.2).
 *
 * Leading and trailing whitespace is stripped rather than refused: it is a
 * paste artifact with no meaning in a token, and `resolveMcpSecret` trims
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
