// codex, main half: the ChatGPT sign-in it borrows, the native auth file that
// sign-in is delivered through, the token probe and the plan usage ChatGPT
// reports.
import {
  isRecord,
  type AgentMainPlugin,
  type OAuthTools,
  type PlanWindow,
  type TokenSet
} from '../../../shared/agentPlugin'
import { manifest } from './manifest'

// --- sign-in -------------------------------------------------------------------
//
// OpenAI sign-in — ChatGPT subscription plans.
//
// BORROWED CLIENT_ID (docs/requirements-oauth-credentials.md §3): this is the
// public OAuth client of OpenAI's own Codex CLI. gurt launches that exact CLI
// (./manifest.ts), so the token this flow mints is consumed by the client the
// id names. The registration is NOT ours: OpenAI can rotate, restrict or
// revoke it without notice, and this flow then breaks with no action on our
// side. That risk is accepted knowingly — if ChatGPT sign-in suddenly fails,
// start here.

/**
 * The extra entry fields codex's native `~/.codex/auth.json` needs beyond the
 * access token (§2, §5.2.1): the `id_token` JWT itself, and the ChatGPT
 * account id its `https://api.openai.com/auth` claim carries (the same claim
 * codex's own IdTokenInfo parser reads). A refresh response may rotate the
 * id_token or omit it — when absent, the stored values are carried forward
 * rather than erased. Exported for the unit test.
 */
export const openaiExtraData = (
  tokens: Record<string, unknown>,
  current: TokenSet | undefined,
  { idTokenClaims }: Pick<OAuthTools, 'idTokenClaims'>
): Record<string, string> => {
  const idToken = typeof tokens['id_token'] === 'string' ? tokens['id_token'] : ''
  if (!idToken) {
    return {
      idToken: current?.extra?.['idToken'] ?? '',
      accountId: current?.extra?.['accountId'] ?? ''
    }
  }
  const auth = idTokenClaims(idToken)['https://api.openai.com/auth']
  const accountId =
    auth && typeof auth === 'object'
      ? (auth as Record<string, unknown>)['chatgpt_account_id']
      : undefined
  return {
    idToken,
    accountId:
      typeof accountId === 'string' && accountId
        ? accountId
        : (current?.extra?.['accountId'] ?? '')
  }
}

// --- plan usage ----------------------------------------------------------------

const USAGE_ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage'

/** Codex CLI's /backend-api/wham/usage response (backend-client, v0.160.1).
 * Only the main quota is shown; code-review and model-specific pools are separate.
 * Percentages and duration seconds are explicit, never inferred from magnitudes. */
export function parseCodexPlanWindows(body: unknown): PlanWindow[] {
  if (!isRecord(body) || !isRecord(body['rate_limit'])) return []
  const out: PlanWindow[] = []
  for (const slot of ['primary', 'secondary']) {
    const value = body['rate_limit'][`${slot}_window`]
    if (!isRecord(value)) continue
    const raw = value['used_percent']
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) continue
    const seconds = value['limit_window_seconds']
    const durationSeconds = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
    const reset = value['reset_at']
    const at = typeof reset === 'number' && Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : undefined
    const resetsAt = at && Number.isFinite(at.getTime()) ? at.toISOString() : undefined
    const label = durationSeconds === 604800 ? 'week'
      : durationSeconds !== undefined && durationSeconds % 3600 === 0 ? `${durationSeconds / 3600}h`
        : durationSeconds !== undefined ? `${durationSeconds / 60}m` : slot
    out.push({ id: `codex_${slot}`, label, utilization: Math.min(100, raw), raw,
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      ...(resetsAt ? { resetsAt } : {}) })
  }
  return out
}

/** Can this account spend past an exhausted window, per a usage poll?
 *  `credits: { has_credits, unlimited }` (codex-rs `CreditsSnapshot`).
 *  Anything absent or unreadable is "no": the hold is the safe side of a
 *  guess. */
export function parseCreditsOverage(body: unknown): boolean {
  if (!isRecord(body)) return false
  const c = body['credits']
  return isRecord(c) && (c['unlimited'] === true || c['has_credits'] === true)
}

// --- the plugin ----------------------------------------------------------------

export const main: AgentMainPlugin = {
  id: manifest.id,

  // §5.2.1 of docs/requirements-oauth-credentials.md: codex consumes a sign-in
  // through its native auth file, and its secretEnv var must stay unset — a
  // non-key value in OPENAI_API_KEY sends it down the API-key path, which is
  // the shipped bug §11 records.
  authFile: ({ credential, access, now }) => {
    // Verified against @openai/codex@0.153.4, the version codex-acp@1.11.0
    // resolves (run against the actual binary, 2026-09-10): `OPENAI_API_KEY`
    // null-or-absent selects ChatGPT-token mode — any non-null value, even
    // "", wins over `tokens` and takes the API-key path. In `tokens`,
    // `id_token` is REQUIRED and must be a parseable JWT; `refresh_token` is
    // required *present* by serde but "" is accepted (it cannot be omitted —
    // empty is the access-only §5.2 shape, and a refresh attempt then fails,
    // the accepted §6 outcome); `account_id` is optional; `last_refresh` is
    // optional RFC 3339 (toISOString satisfies it).
    const idToken = credential.data['idToken'] ?? ''
    if (!idToken)
      // An entry signed in before idToken was captured (§2): composing a file
      // codex will reject with a parse error helps nobody — block with the
      // §2-style actionable sentence instead.
      throw new Error(
        `credential "${credential.label || credential.id}" has no ChatGPT id token — sign in again in Credentials`
      )
    const accountId = credential.data['accountId'] ?? ''
    return {
      path: '.codex/auth.json',
      content: JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: {
          id_token: idToken,
          access_token: access,
          refresh_token: '',
          ...(accountId ? { account_id: accountId } : {})
        },
        last_refresh: new Date(now).toISOString()
      })
    }
  },

  oauth: {
    client: {
      id: 'openai',
      authorizationEndpoint: 'https://auth.openai.com/oauth/authorize',
      tokenEndpoint: 'https://auth.openai.com/oauth/token',
      clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
      // offline_access is what makes a refresh token exist at all; openid/email
      // are where the account identity comes from (the id_token below).
      scopes: ['openid', 'profile', 'email', 'offline_access'],
      tokenBody: 'form',
      // The borrowed registration pins its loopback redirect to this exact port
      // and path — a random port would be rejected as an unregistered
      // redirect_uri.
      port: 1455,
      redirectHost: 'localhost',
      redirectPath: '/auth/callback'
    },
    /** The account rides in the id_token's `email` claim. */
    account: (tokens, { idTokenClaims }) => {
      const email = idTokenClaims(tokens['id_token'])['email']
      return typeof email === 'string' ? email : ''
    },
    extraData: openaiExtraData
  },

  probeToken: (token) => ({
    label: 'OpenAI',
    url: 'https://api.openai.com/v1/models',
    headers: { Authorization: `Bearer ${token}` }
  }),

  // Only a ChatGPT sign-in has a plan to report; the usage endpoint wants its
  // access token fresh, and the account id the sign-in carries.
  planUsage: {
    eligible: ({ credential, error }) =>
      credential?.kind !== 'oauth' || credential.data['providerId'] !== manifest.oauthProvider || error
        ? { error: error ?? 'Link a ChatGPT sign-in in Settings → Agents' }
        : true,
    freshSignIn: true,
    request: ({ secret, credential, error }) => {
      if (credential?.kind !== 'oauth' || credential.data['providerId'] !== manifest.oauthProvider || error || !secret)
        throw new Error('no ChatGPT sign-in linked')
      return {
        url: USAGE_ENDPOINT,
        headers: {
          Authorization: `Bearer ${secret}`,
          ...(credential.data['accountId'] ? { 'ChatGPT-Account-Id': credential.data['accountId'] } : {}),
          'User-Agent': 'codex-cli',
          Accept: 'application/json'
        }
      }
    },
    parse: (body) => ({ windows: parseCodexPlanWindows(body), overage: parseCreditsOverage(body) })
  }
}
