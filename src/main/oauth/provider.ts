// The provider seam of docs/requirements-oauth-credentials.md §3: one module
// per provider under ./providers/, every specific (endpoints, client_id,
// scopes, body encodings, where the account name lives) behind these two
// calls. The refresh path (`../index.ts`) and the sign-in flow know nothing a
// provider does not tell them through this interface.

export interface TokenSet {
  access: string
  refresh: string
  /** When `access` expires (ISO 8601). */
  expiresAt: string
  /** Display identity of the signed-in user ("jane@example.com"). */
  account: string
  /**
   * Provider-specific extra entry `data` (§2: legal, named by the provider
   * module) — e.g. openai's `idToken`/`accountId`, which codex's native
   * auth.json needs (§5.2.1). Persisted alongside the core fields; a key
   * declared secret in CREDENTIAL_KINDS seals and redacts like the tokens.
   */
  extra?: Record<string, string>
}

export interface OAuthProvider {
  id: string
  /** Run the full sign-in: system browser, loopback redirect, code exchange.
   *  Resolves when the tokens are in hand. The signal cancels the attempt —
   *  the loopback listener closes and the promise rejects. */
  authorize(signal?: AbortSignal): Promise<TokenSet>
  /** Exchange a refresh token for a new access token. MAY rotate the refresh
   *  token — the returned set is the truth. */
  refresh(current: TokenSet): Promise<TokenSet>
}
