// The provider seam of docs/requirements-oauth-credentials.md §3: every
// specific of one provider (endpoints, client_id, scopes, body encodings,
// where the account name lives) is declared by the agent plugin whose CLI
// borrows that sign-in (`AgentMainPlugin.oauth`), and reaches the refresh path
// (`./index.ts`) and the sign-in flow only through these two calls.

import type { TokenSet } from '../../shared/agentPlugin'

export type { TokenSet }

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
