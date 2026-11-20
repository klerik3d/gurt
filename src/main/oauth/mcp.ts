// The generic `mcp` OAuth provider (docs/requirements-oauth-credentials.md §3,
// phase 3): the MCP-spec sign-in for any conforming remote server, with no
// per-server module and no endpoint written down here.
//
// What it is told is a server URL (`data.serverUrl` of the credential being
// signed in) and, optionally, a scope override (`data.scopes`, space
// separated). Discovery (RFC 9728 → RFC 8414/OIDC) and dynamic client
// registration (RFC 7591) happen at every sign-in; the loopback redirect
// (RFC 8252), PKCE S256 and the code exchange are the shared flow's. The
// `resource` parameter (RFC 8707) names the MCP URL on the authorize request
// and on every token request, so the token the server issues is bound to it.
//
// What a sign-in stores beyond the core fields is exactly what a later refresh
// needs and nothing else knows: `serverUrl`, `tokenEndpoint`, `clientId` (+ the
// `scopes` override when there is one). The refresh grant therefore takes its
// endpoint and client from the credential, not from any config — the registered
// client is the credential's own.
//
// Public clients only: no `client_secret` is requested, kept or sent.

import {
  OAuthFlowError,
  authorizeGrant,
  idTokenClaims,
  refreshGrant,
  type AuthCodeConfig,
  type AuthorizeHooks
} from './flow'
import { discoverMcpOAuth, endpointProblem, isLoopbackHost, registerMcpClient } from './mcpDiscovery'
import type { AuthorizeContext, OAuthProvider, TokenSet } from './provider'

/** The `providerId` of an `oauth` credential signed in to an MCP server. */
export const MCP_PROVIDER_ID = 'mcp'

/** `data` keys this provider owns, beyond the core fields (§2: extras are
 *  named by the provider). All plaintext — none is a secret. */
export const MCP_DATA_KEYS = ['serverUrl', 'tokenEndpoint', 'clientId', 'scopes'] as const

const splitScopes = (raw: string | undefined): string[] => (raw ?? '').split(/\s+/).filter(Boolean)

/** The display identity of an MCP sign-in. The protocol defines none, so: what
 *  the token response's `id_token` says if the server sends one (OIDC), else
 *  the server's own host — still true, and enough to tell two sign-ins apart. */
function accountOf(tokens: Record<string, unknown>, serverUrl: string): string {
  const claims = idTokenClaims(tokens['id_token'])
  for (const key of ['email', 'preferred_username', 'name']) {
    const v = claims[key]
    if (typeof v === 'string' && v) return v
  }
  return new URL(serverUrl).host
}

export interface McpProviderOptions {
  /** Test seam: how the authorization URL is opened (default: system browser). */
  open?: AuthorizeHooks['open']
  /** Test seam: deadline of one token request (default 30 s). */
  tokenTimeoutMs?: number
}

export function createMcpProvider(options: McpProviderOptions = {}): OAuthProvider {
  return {
    id: MCP_PROVIDER_ID,

    async authorize(signal?: AbortSignal, context?: AuthorizeContext): Promise<TokenSet> {
      const serverUrl = (context?.data['serverUrl'] ?? '').trim()
      if (!serverUrl)
        throw new OAuthFlowError(
          'this sign-in has no MCP server URL — sign in from the server in ⚙ MCP servers'
        )
      const found = await discoverMcpOAuth(serverUrl, signal ? { signal } : {})
      const override = splitScopes(context?.data['scopes'])
      const scopes = override.length ? override : found.scopes

      // Filled in by the registration hook, read by `extraData` once the code
      // has been exchanged: the client the refresh grant will present.
      let clientId = ''
      const cfg: AuthCodeConfig = {
        id: MCP_PROVIDER_ID,
        authorizationEndpoint: found.authorizationEndpoint,
        tokenEndpoint: found.tokenEndpoint,
        clientId: '',
        scopes,
        tokenBody: 'form',
        authParams: { resource: found.resource },
        tokenParams: { resource: found.resource },
        noRedirects: true,
        ...(options.tokenTimeoutMs ? { tokenTimeoutMs: options.tokenTimeoutMs } : {}),
        extraData: () => ({
          serverUrl: found.resource,
          tokenEndpoint: found.tokenEndpoint,
          clientId,
          ...(override.length ? { scopes: override.join(' ') } : {})
        })
      }
      try {
        return await authorizeGrant(cfg, (tokens) => accountOf(tokens, found.resource), signal, {
          register: async (redirectUri) => {
            clientId = await registerMcpClient(found.registrationEndpoint, redirectUri, scopes, {
              ...(signal ? { signal } : {}),
              loopbackOk: isLoopbackHost(new URL(found.resource).hostname)
            })
            return clientId
          },
          ...(options.open ? { open: options.open } : {})
        })
      } catch (e) {
        // A server that issues no refresh token usually wants to be asked for
        // one; say so rather than leave "sign-in incomplete" unexplained.
        if (e instanceof OAuthFlowError && /no refresh token/.test(e.message) && found.offlineAccess)
          throw new OAuthFlowError(
            `${e.message} — the server supports the "offline_access" scope; add it to this sign-in's scopes`,
            e.code
          )
        throw e
      }
    },

    refresh(current: TokenSet): Promise<TokenSet> {
      const extra = current.extra ?? {}
      const tokenEndpoint = extra['tokenEndpoint'] ?? ''
      const clientId = extra['clientId'] ?? ''
      const serverUrl = extra['serverUrl'] ?? ''
      if (!tokenEndpoint || !clientId || !serverUrl)
        return Promise.reject(
          new OAuthFlowError(
            'this sign-in is missing its server details — sign in again from the server in ⚙ MCP servers'
          )
        )
      // The stored endpoint was validated at sign-in; it is held to the same
      // rule again before the refresh token is sent to it, in case the entry
      // was edited or came from somewhere else.
      let bad: string | null
      try {
        bad = endpointProblem(tokenEndpoint, isLoopbackHost(new URL(serverUrl).hostname))
      } catch {
        bad = 'is not a URL'
      }
      if (bad)
        return Promise.reject(
          new OAuthFlowError(
            `the token endpoint of this sign-in ${bad} — sign in again from the server in ⚙ MCP servers`
          )
        )
      // The client and the endpoint are the credential's, not the plugin
      // config's: there is no config for a server gurt has never heard of.
      return refreshGrant(
        {
          id: MCP_PROVIDER_ID,
          authorizationEndpoint: '',
          tokenEndpoint,
          clientId,
          scopes: [],
          tokenBody: 'form',
          tokenParams: { resource: serverUrl },
          noRedirects: true,
          ...(options.tokenTimeoutMs ? { tokenTimeoutMs: options.tokenTimeoutMs } : {})
        },
        current
      ).catch((e: unknown) => {
        // The registration is this credential's own, and servers expire or
        // delete dynamic clients. Retrying cannot help and only a new
        // sign-in (a new registration) can: treat it as the refresh token
        // being dead, so the entry is marked signed out and says so.
        if (e instanceof OAuthFlowError && (e.code === 'invalid_client' || e.code === 'unauthorized_client'))
          throw new OAuthFlowError(
            `${e.message} — the server no longer knows this sign-in's client`,
            'invalid_grant'
          )
        throw e
      })
    }
  }
}

/** Registered under `mcp` in `OAUTH_PROVIDER_REGISTRY`. */
export const mcpProvider: OAuthProvider = createMcpProvider()
