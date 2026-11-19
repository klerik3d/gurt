// OAuth credential resolution: the main-side half of the §2 seam in
// docs/requirements-oauth-credentials.md. The pure resolvers in
// shared/credentials.ts identify an `oauth` entry; this module is what turns
// it into a live access token — refreshing when needed (§5.3), persisting
// through the credential save chain, feeding the redactor the moment tokens
// exist (§5.4), and blocking with the signed-out sentence when the refresh
// token is dead. It also owns the sign-in attempts the Credentials modal
// starts (§4).
import type { CredentialEntry } from '../../shared/credentials'
import { CREDENTIAL_KINDS, oauthSignedOut, signedOutError } from '../../shared/credentials'
import { listCredentials, patchCredentialData, upsertCredentialEntry } from '../credentials'
import { addSecrets, createLogger } from '../log'
import type { AgentOAuth, OAuthTools } from '../../shared/agentPlugin'
import { agentMains } from '../agentPlugins'
import { authorizeGrant, idTokenClaims, isSignedOut, refreshGrant, type AuthCodeConfig } from './flow'
import { MCP_PROVIDER_ID, mcpProvider } from './mcp'
import type { OAuthProvider, TokenSet } from './provider'

const log = createLogger('oauth')

/** What the engine lends a plugin's OAuth hooks. */
const TOOLS: OAuthTools = { fetch: (...args) => fetch(...args), idTokenClaims }

/** One plugin's declared sign-in, run by the shared flow. */
function providerOf(oauth: AgentOAuth): OAuthProvider {
  const extraData = oauth.extraData
  const cfg: AuthCodeConfig = {
    ...oauth.client,
    ...(extraData ? { extraData: (tokens, current) => extraData(tokens, current, TOOLS) } : {})
  }
  return {
    id: cfg.id,
    authorize: (signal?: AbortSignal): Promise<TokenSet> =>
      authorizeGrant(cfg, (tokens) => oauth.account(tokens, TOOLS), signal),
    refresh: (current: TokenSet): Promise<TokenSet> => refreshGrant(cfg, current)
  }
}

/** Every sign-in an agent plugin declares, by provider id — the id stored as
 *  an oauth credential's `providerId`, and the same set the renderer's
 *  provider picker offers (`OAUTH_PROVIDER_CHOICES`, from the manifests). */
export const OAUTH_PROVIDERS: Record<string, OAuthProvider> = Object.fromEntries(
  agentMains().flatMap((p) => (p.oauth ? [[p.oauth.client.id, providerOf(p.oauth)]] : []))
)

/** Everything a stored `providerId` may name: the plugin-declared sign-ins
 *  above plus the generic `mcp` provider, which no plugin declares — it signs
 *  in to whatever server URL the credential names (phase 3, §3). It is kept out
 *  of {@link OAUTH_PROVIDERS} on purpose: that set is pinned to the agent kinds
 *  (the picker's, and the ids already in users' credentials.json), and `mcp` is
 *  started from the MCP registry editor, never from the picker. The resolve,
 *  refresh and sign-in paths all default to this registry. */
export const OAUTH_PROVIDER_REGISTRY: Record<string, OAuthProvider> = {
  ...OAUTH_PROVIDERS,
  [MCP_PROVIDER_ID]: mcpProvider
}

/** The refresh token is dead and the entry is signed out (§2) — as opposed to
 *  a refresh that merely failed. The message is the §2 sentence; the class is
 *  for callers (the live-scope keeper) that must not retry it. */
export class SignedOutError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SignedOutError'
  }
}

/** Refresh when the access token is expired *or* within this window of it — a
 *  token that dies mid-injection helps nobody (§5.3). */
export const EXPIRY_SKEW_MS = 5 * 60_000

const stillFresh = (expiresAt: string): boolean => {
  const t = Date.parse(expiresAt)
  return Number.isFinite(t) && t - Date.now() > EXPIRY_SKEW_MS
}

/** The core `data` keys every oauth entry owns; everything else is a
 *  provider-named extra (§2) and rides in `TokenSet.extra`. */
const CORE_KEYS = new Set(['providerId', 'access', 'refresh', 'expiresAt', 'account', 'signedOut'])

const extraOf = (data: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(data).filter(([k]) => !CORE_KEYS.has(k)))

/** §5.4 for a whole set, extras included: the manifest (§2.1) says which extra
 *  keys are secrets — those go to the redactor with the tokens; plaintext
 *  extras (an account id) stay loggable like `account` itself. */
const OAUTH_SECRET_KEYS = new Set(
  (CREDENTIAL_KINDS.find((k) => k.kind === 'oauth')?.fields ?? [])
    .filter((f) => f.secret)
    .map((f) => f.key)
)
const redactTokenSet = (set: TokenSet): void =>
  addSecrets([
    set.access,
    set.refresh,
    ...Object.entries(set.extra ?? {})
      .filter(([k]) => OAUTH_SECRET_KEYS.has(k))
      .map(([, v]) => v)
  ])

/** One in-flight resolution per credential id — see {@link resolveOAuthAccess}. */
const resolving = new Map<string, Promise<string>>()

/**
 * Resolve an `oauth` entry to a live access token, refreshing (and persisting)
 * first when the stored one is expired or nearly so.
 *
 * Single-flight per credential id — a correctness rule, not a nicety (§5.3):
 * providers may rotate the refresh token on every refresh, and two racing
 * `refresh()` calls leave one side holding a rotated-away token. Concurrent
 * callers therefore share one promise whatever state the entry is in, so at
 * most one refresh can ever be in flight per id — and the rotated set is on
 * disk before any caller proceeds, because the persist is awaited inside the
 * shared promise.
 *
 * `providers` is injectable for the tests that prove exactly that.
 */
export function resolveOAuthAccess(
  credentialId: string,
  providers: Record<string, OAuthProvider> = OAUTH_PROVIDER_REGISTRY
): Promise<string> {
  const inflight = resolving.get(credentialId)
  if (inflight) return inflight
  const p = resolveUncoalesced(credentialId, providers)
  resolving.set(credentialId, p)
  p.finally(() => resolving.delete(credentialId)).catch(() => {})
  return p
}

async function resolveUncoalesced(
  id: string,
  providers: Record<string, OAuthProvider>
): Promise<string> {
  // Read fresh, inside the flight: the caller's copy of the entry may predate
  // a re-authentication (or another resolver's refresh) by minutes.
  const entry = (await listCredentials()).find((c) => c.id === id)
  if (!entry) throw new Error('linked credential no longer exists')
  const label = entry.label || entry.id
  if (entry.kind !== 'oauth') throw new Error(`credential "${label}" is not an oauth entry`)
  if (oauthSignedOut(entry)) throw new SignedOutError(signedOutError(entry))
  const providerId = entry.data['providerId'] ?? ''
  const provider = providers[providerId]
  if (!provider)
    throw new Error(
      `credential "${label}" names unknown oauth provider "${providerId}" — recreate it in Credentials`
    )
  const current: TokenSet = {
    access: entry.data['access'] ?? '',
    refresh: entry.data['refresh'] ?? '',
    expiresAt: entry.data['expiresAt'] ?? '',
    account: entry.data['account'] ?? '',
    extra: extraOf(entry.data)
  }
  if (current.access && stillFresh(current.expiresAt)) return current.access

  const started = Date.now()
  let set: TokenSet
  try {
    set = await provider.refresh(current)
  } catch (e) {
    if (isSignedOut(e)) {
      // The provider declared the refresh token dead. Record it — the marker
      // is what lets the modal show "sign in again" (§4) — and block with the
      // §2 sentence. A best-effort persist: the block holds regardless.
      log.warn('oauth.expired', { id, provider: provider.id })
      // Only while the dead token is still the stored one: a sign-in that
      // landed during the request must not be marked signed out for it.
      const marked = await patchCredentialData(id, { signedOut: 'true' }, { refresh: current.refresh }).catch(
        () => true
      )
      // Superseded: the token that died belonged to a sign-in that has been
      // replaced meanwhile. Say nothing about the new one — resolve it.
      if (!marked) return resolveUncoalesced(id, providers)
      throw new SignedOutError(signedOutError(entry), { cause: e })
    }
    // A network blip or provider outage leaves the sign-in intact: block this
    // resolve honestly, sign nothing out.
    log.info('oauth.refresh', { id, provider: provider.id, ok: false, ms: Date.now() - started })
    throw new Error(
      `credential "${label}": token refresh failed — ${e instanceof Error ? e.message : String(e)}`,
      { cause: e }
    )
  }
  // §5.4: registered the moment refresh() returns — not left to the store
  // write below, so there is no window in which a live token is loggable.
  // (flow.ts feeds the raw response too; addSecrets is idempotent.)
  redactTokenSet(set)
  log.info('oauth.refresh', {
    id,
    provider: provider.id,
    ok: true,
    rotated: set.refresh !== current.refresh,
    ms: Date.now() - started
  })
  // §5.3: the (possibly rotated) refresh token is on disk before the access
  // token reaches any consumer — losing it is losing the sign-in. The patch
  // rides the save chain, so it read-modify-writes against any renderer save.
  // Provider extras (§2 — an idToken/accountId, say) persist alongside; the
  // patch merges keys, so an extra the provider did not return this time
  // simply keeps its stored value.
  const written = await patchCredentialData(
    id,
    {
      ...set.extra,
      access: set.access,
      refresh: set.refresh,
      expiresAt: set.expiresAt,
      account: set.account,
      signedOut: undefined
    },
    // Compare-and-set on the refresh token this result was derived from: a
    // re-authentication that completed while the request was in flight stored
    // a newer sign-in, and writing this one over it would clobber it (and the
    // old token may already be revoked server-side).
    { refresh: current.refresh }
  )
  // Superseded: this result belongs to the old sign-in. Resolve again — the
  // newer entry is fresh, so that is a store read.
  if (!written) return resolveUncoalesced(id, providers)
  return set.access
}

/** The access token stored for an `oauth` entry, *without* refreshing: null
 *  when the entry is gone, signed out, or its token is missing or already
 *  expired. A token inside the refresh skew still counts — it is valid, and
 *  asking for it must not cause a write (the keeper reacts to writes). */
export async function oauthStoredAccess(credentialId: string): Promise<string | null> {
  const entry = (await listCredentials()).find((c) => c.id === credentialId)
  if (!entry || entry.kind !== 'oauth' || oauthSignedOut(entry)) return null
  const access = entry.data['access'] ?? ''
  const t = Date.parse(entry.data['expiresAt'] ?? '')
  return access && Number.isFinite(t) && t > Date.now() ? access : null
}

/** When the stored access token of an `oauth` entry expires (epoch ms), or
 *  null when the entry is gone, not an oauth entry, or has no usable expiry —
 *  what the live-scope keeper schedules its next refresh from. Read from the
 *  store rather than returned by the resolve, so a refresh another session
 *  made is seen too. */
export async function oauthExpiresAtMs(credentialId: string): Promise<number | null> {
  const entry = (await listCredentials()).find((c) => c.id === credentialId)
  if (!entry || entry.kind !== 'oauth') return null
  const t = Date.parse(entry.data['expiresAt'] ?? '')
  return Number.isFinite(t) ? t : null
}

/**
 * The §2 seam for the MCP callers (`resolveProxyPlan`, the local-server env,
 * the probe): a copy of `credentials` in which every `oauth` entry named by
 * `ids` carries a live access token, plus an error per id for those that
 * could not deliver one. The pure resolvers then read `data.access` exactly
 * as they read a pasted secret; a failed id keeps its stored entry, and the
 * caller surfaces the error instead of composing a stale header.
 */
export async function freshenOAuthCredentials(
  credentials: readonly CredentialEntry[],
  ids: Iterable<string | undefined>,
  providers: Record<string, OAuthProvider> = OAUTH_PROVIDER_REGISTRY,
  /** Tokens already resolved by the caller (id → access): used as they are, no
   *  resolve — so a rebuild does not refresh a short-lived token a second time. */
  reuse: Readonly<Record<string, string>> = {}
): Promise<{ credentials: CredentialEntry[]; errors: Record<string, string> }> {
  const wanted = new Set<string>()
  for (const id of ids) if (id) wanted.add(id)
  const errors: Record<string, string> = {}
  const out = await Promise.all(
    credentials.map(async (entry) => {
      if (entry.kind !== 'oauth' || !wanted.has(entry.id)) return entry
      try {
        const access = reuse[entry.id] ?? (await resolveOAuthAccess(entry.id, providers))
        return { ...entry, data: { ...entry.data, access } }
      } catch (e) {
        errors[entry.id] = e instanceof Error ? e.message : String(e)
        return entry
      }
    })
  )
  return { credentials: out, errors }
}

/** Pending sign-in attempt per entry id — one at most (§4). */
const attempts = new Map<string, AbortController>()

/**
 * Run the full sign-in for one entry and persist the resulting token set
 * (§4). The entry may be an unsaved draft — a successful sign-in is what
 * stores it. One pending attempt per entry: a second call cancels the first
 * and restarts rather than racing two loopback listeners. On failure nothing
 * is written and the stored entry stays as it was.
 */
export async function oauthSignIn(
  entry: CredentialEntry,
  providers: Record<string, OAuthProvider> = OAUTH_PROVIDER_REGISTRY
): Promise<void> {
  if (entry.kind !== 'oauth')
    throw new Error(`credential "${entry.label || entry.id}" is not an oauth entry`)
  const providerId = entry.data['providerId'] ?? ''
  const provider = providers[providerId]
  if (!provider) throw new Error(`unknown oauth provider "${providerId}"`)
  attempts.get(entry.id)?.abort()
  const ctl = new AbortController()
  attempts.set(entry.id, ctl)
  const started = Date.now()
  try {
    const set = await provider.authorize(ctl.signal, { data: entry.data })
    // Cancelled (or superseded) while the code exchange was in flight: the
    // callback had settled the listener, so the abort only shows up here. The
    // user abandoned this attempt — storing its tokens would leave a live
    // refresh token nobody asked for.
    if (ctl.signal.aborted) {
      redactTokenSet(set)
      throw new Error('sign-in cancelled')
    }
    // §5.4, same rule as the refresh path: redactor first, store write second.
    redactTokenSet(set)
    log.info('oauth.authorize', { id: entry.id, provider: provider.id, ok: true, ms: Date.now() - started })
    await upsertCredentialEntry({
      id: entry.id,
      label: entry.label,
      kind: 'oauth',
      hosts: [],
      data: {
        ...set.extra,
        providerId: provider.id,
        access: set.access,
        refresh: set.refresh,
        expiresAt: set.expiresAt,
        account: set.account
      }
    })
  } catch (e) {
    // Success, failure or timeout — every attempt ends in exactly one record.
    log.info('oauth.authorize', { id: entry.id, provider: provider.id, ok: false, ms: Date.now() - started })
    throw e
  } finally {
    if (attempts.get(entry.id) === ctl) attempts.delete(entry.id)
  }
}

/** Cancel the pending sign-in attempt of one entry, if any — the modal's
 *  Cancel button (§4). The attempt's promise rejects as cancelled. */
export function cancelOAuthSignIn(credentialId: string): void {
  attempts.get(credentialId)?.abort()
  attempts.delete(credentialId)
}
