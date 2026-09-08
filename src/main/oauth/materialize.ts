// §5.2.1 of docs/requirements-oauth-credentials.md: which agent kinds consume
// an oauth sign-in through a native auth file instead of their `secretEnv`
// var, and the exact file each pinned CLI expects. Pure composition — the
// container write happens in `resolveLaunch` through provision.ts's
// `writeContainerUserFile`, at every adapter launch, with the freshly
// host-refreshed access token.
//
// ACCESS-ONLY, by decision: the refresh token never enters a container
// (§5.2), so neither file carries one. The CLI cannot self-refresh; the
// session lives until the access token expires, and §6's "mid-turn expiry is
// accepted, restart the turn" covers it.
//
// Shapes are verified against the *pinned* versions in AGENT_DEFS
// (src/shared/agents.ts) — a pin bump re-checks this file, same rule as
// `skillsDir`.

import type { CredentialEntry } from '../../shared/credentials'

/** A native auth file to materialize into the container before the adapter
 *  spawns — or, when `oauthAuthFile` returns null, the kind keeps the
 *  `secretEnv` path (claude-code, and every non-oauth credential). */
export interface OAuthAuthFile {
  /** Path relative to the container `$HOME`. */
  path: string
  /** The exact file content, one JSON document. */
  content: string
}

/**
 * The delivery decision, per agent kind (§5.2.1): the file an oauth-linked
 * `agentKind` launch must materialize, or null when the kind consumes the env
 * var (then the caller injects `access` as `secretEnv`, unchanged). For a
 * codex/gemini file the caller must ALSO suppress the env var — a non-key
 * value in OPENAI_API_KEY / GEMINI_API_KEY sends those CLIs down the API-key
 * path, which is the shipped bug §11 records.
 *
 * `access` is passed alongside the entry because the caller (resolveLaunch)
 * holds the freshly refreshed token, which may be newer than `entry.data`.
 */
export function oauthAuthFile(
  agentKind: string,
  entry: CredentialEntry,
  access: string,
  nowMs: number
): OAuthAuthFile | null {
  if (entry.kind !== 'oauth') return null
  if (agentKind === 'codex') {
    // Verified against @openai/codex@0.148.0, the version codex-acp@1.6.2
    // resolves (run against the actual binary, 2026-09-08): `OPENAI_API_KEY`
    // null-or-absent selects ChatGPT-token mode — any non-null value, even
    // "", wins over `tokens` and takes the API-key path. In `tokens`,
    // `id_token` is REQUIRED and must be a parseable JWT; `refresh_token` is
    // required *present* by serde but "" is accepted (it cannot be omitted —
    // empty is the access-only §5.2 shape, and a refresh attempt then fails,
    // the accepted §6 outcome); `account_id` is optional; `last_refresh` is
    // optional RFC 3339 (toISOString satisfies it).
    const idToken = entry.data['idToken'] ?? ''
    if (!idToken)
      // An entry signed in before idToken was captured (§2): composing a file
      // codex will reject with a parse error helps nobody — block with the
      // §2-style actionable sentence instead.
      throw new Error(
        `credential "${entry.label || entry.id}" has no ChatGPT id token — sign in again in Credentials`
      )
    const accountId = entry.data['accountId'] ?? ''
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
        last_refresh: new Date(nowMs).toISOString()
      })
    }
  }
  if (agentKind === 'gemini') {
    // Verified against @google/gemini-cli@0.56.0 (bundle source, 2026-09-08):
    // the file is JSON.parse'd with no field validation and handed to
    // google-auth-library's OAuth2Client.setCredentials. `refresh_token` may
    // be omitted entirely: getAccessToken only consults it when the token is
    // missing or expiring, so an access token fresh at launch (resolveLaunch
    // guarantees >5 min, its skew window) carries the session to expiry.
    // `expiry_date` is epoch ms, compared straight to Date.now(). Startup
    // verifies the token with a live tokeninfo call — a freshly refreshed
    // access token passes it.
    const expiry = Date.parse(entry.data['expiresAt'] ?? '')
    return {
      path: '.gemini/oauth_creds.json',
      content: JSON.stringify({
        access_token: access,
        token_type: 'Bearer',
        ...(Number.isFinite(expiry) ? { expiry_date: expiry } : {})
      })
    }
  }
  return null
}
