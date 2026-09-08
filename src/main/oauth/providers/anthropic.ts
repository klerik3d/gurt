// Anthropic sign-in — Claude subscription plans (claude.ai accounts).
//
// BORROWED CLIENT_ID (docs/requirements-oauth-credentials.md §3): this is the
// public OAuth client of Anthropic's own Claude Code CLI. gurt launches that
// exact CLI (`AGENT_DEFS` in src/shared/agents.ts), so the token this flow
// mints is consumed by the client the id names. The registration is NOT ours:
// Anthropic can rotate, restrict or revoke it without notice, and this flow
// then breaks with no action on our side. That risk is accepted knowingly —
// if Claude sign-in suddenly fails, start here.
import type { OAuthProvider, TokenSet } from '../provider'
import { authorizeGrant, refreshGrant, type AuthCodeConfig } from '../flow'

const CONFIG: AuthCodeConfig = {
  id: 'anthropic',
  authorizationEndpoint: 'https://claude.ai/oauth/authorize',
  tokenEndpoint: 'https://console.anthropic.com/v1/oauth/token',
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  scopes: ['org:create_api_key', 'user:profile', 'user:inference'],
  // Anthropic's endpoint takes JSON, not form encoding.
  tokenBody: 'json',
  authParams: { code: 'true' },
  // The borrowed registration pins its loopback redirect to this exact port
  // and hostname — a random port (the RFC 8252 default elsewhere in this
  // directory) would be rejected as an unregistered redirect_uri.
  port: 54545,
  redirectHost: 'localhost',
  redirectPath: '/callback'
}

/** Anthropic's token response carries the account inline. */
const accountOf = (tokens: Record<string, unknown>): string => {
  const account = tokens['account']
  if (account && typeof account === 'object') {
    const email = (account as Record<string, unknown>)['email_address']
    if (typeof email === 'string') return email
  }
  return ''
}

export const anthropic: OAuthProvider = {
  id: CONFIG.id,
  authorize: (signal?: AbortSignal): Promise<TokenSet> =>
    authorizeGrant(CONFIG, accountOf, signal),
  refresh: (current: TokenSet): Promise<TokenSet> => refreshGrant(CONFIG, current)
}
