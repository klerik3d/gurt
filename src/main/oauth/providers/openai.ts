// OpenAI sign-in — ChatGPT subscription plans.
//
// BORROWED CLIENT_ID (docs/requirements-oauth-credentials.md §3): this is the
// public OAuth client of OpenAI's own Codex CLI. gurt launches that exact CLI
// (`AGENT_DEFS` in src/shared/agents.ts), so the token this flow mints is
// consumed by the client the id names. The registration is NOT ours: OpenAI
// can rotate, restrict or revoke it without notice, and this flow then breaks
// with no action on our side. That risk is accepted knowingly — if ChatGPT
// sign-in suddenly fails, start here.
import type { OAuthProvider, TokenSet } from '../provider'
import { authorizeGrant, idTokenClaims, refreshGrant, type AuthCodeConfig } from '../flow'

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
  current?: TokenSet
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

const CONFIG: AuthCodeConfig = {
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
  redirectPath: '/auth/callback',
  extraData: openaiExtraData
}

/** The account rides in the id_token's `email` claim. */
const accountOf = (tokens: Record<string, unknown>): string => {
  const email = idTokenClaims(tokens['id_token'])['email']
  return typeof email === 'string' ? email : ''
}

export const openai: OAuthProvider = {
  id: CONFIG.id,
  authorize: (signal?: AbortSignal): Promise<TokenSet> =>
    authorizeGrant(CONFIG, accountOf, signal),
  refresh: (current: TokenSet): Promise<TokenSet> => refreshGrant(CONFIG, current)
}
