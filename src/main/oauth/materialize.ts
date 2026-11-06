// §5.2.1 of docs/requirements-oauth-credentials.md: which agent kinds consume
// an oauth sign-in through a native auth file instead of their `secretEnv`
// var. The file itself — its path and its exact shape for the pinned CLI — is
// the kind's plugin's (`AgentMainPlugin.authFile`); this is the composition
// around it. The container write happens in `resolveLaunch` through
// provision.ts's `writeContainerUserFile`, at every adapter launch, with the
// freshly host-refreshed access token.
//
// ACCESS-ONLY, by decision: the refresh token never enters a container
// (§5.2), so no file carries one. The CLI cannot self-refresh; the session
// lives until the access token expires, and §6's "mid-turn expiry is
// accepted, restart the turn" covers it.

import type { CredentialEntry } from '../../shared/credentials'
import type { AuthFile } from '../../shared/agentPlugin'
import { agentMain } from '../agentPlugins'

/** A native auth file to materialize into the container before the adapter
 *  spawns — or, when `oauthAuthFile` returns null, the kind keeps the
 *  `secretEnv` path (every kind without an `authFile` hook, and every
 *  non-oauth credential). */
export type OAuthAuthFile = AuthFile

/**
 * The delivery decision, per agent kind (§5.2.1): the file an oauth-linked
 * `agentKind` launch must materialize, or null when the kind consumes the env
 * var (then the caller injects `access` as `secretEnv`, unchanged). When a
 * file comes back the caller must ALSO suppress the env var — a non-key value
 * there sends such a CLI down the API-key path, which is the shipped bug §11
 * records.
 *
 * `access` is passed alongside the entry because the caller (resolveLaunch)
 * holds the freshly refreshed token, which may be newer than `entry.data`.
 * Throws whatever sentence the plugin blocks with (an entry its CLI would
 * reject, say).
 */
export function oauthAuthFile(
  agentKind: string,
  entry: CredentialEntry,
  access: string,
  nowMs: number
): OAuthAuthFile | null {
  if (entry.kind !== 'oauth') return null
  return agentMain(agentKind)?.authFile?.({ credential: entry, access, now: nowMs }) ?? null
}
