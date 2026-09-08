// The mechanics every provider shares: the PKCE authorization-code flow in the
// system browser with a loopback redirect (RFC 8252), and the token-endpoint
// POSTs for the code exchange and the refresh grant
// (docs/requirements-oauth-credentials.md §3, §4).
//
// Nothing here logs. The authorization code, the callback query string and
// every token value appear in no record at any level (§7) — errors carry the
// provider's own prose, never the URL that failed. Token values are handed to
// the redactor the moment a token response parses, so there is no window in
// which a live token is loggable (§5.4).

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { addSecrets } from '../redact'
import type { TokenSet } from './provider'

/** How each provider's flow differs — the data behind one provider module. */
export interface AuthCodeConfig {
  /** Provider id, for error sentences ("anthropic answered: …"). */
  id: string
  authorizationEndpoint: string
  tokenEndpoint: string
  clientId: string
  /** Google installed-app registrations carry a *published* "secret" (it ships
   *  in the official CLI's source); the flow is still a public client with
   *  PKCE — this is not a confidential-client credential. */
  clientSecret?: string
  scopes: string[]
  /** Extra authorize-URL params (`access_type=offline`, …). */
  authParams?: Record<string, string>
  /** How the token endpoint wants its body: RFC 6749 form encoding, or JSON
   *  (Anthropic's endpoint). */
  tokenBody: 'form' | 'json'
  /** Loopback port the borrowed registration pins; 0/absent = random, per
   *  RFC 8252 and §4. The listener binds 127.0.0.1 either way. */
  port?: number
  /** Path of the registered redirect; default `/callback`. */
  redirectPath?: string
  /** Hostname the registered redirect_uri spells (`localhost` for the CLIs
   *  that registered it that way); the socket still binds 127.0.0.1 only. */
  redirectHost?: string
  /** Provider-specific extra `TokenSet.extra` fields mined from a token
   *  response (§2). On the refresh grant it also receives the current set,
   *  so a value the response omits (a non-rotated id_token, say) can be
   *  carried forward instead of erased. */
  extraData?: (tokens: Record<string, unknown>, current?: TokenSet) => Record<string, string>
}

/** A flow-level failure. `code` is the OAuth error code when the provider sent
 *  one (`invalid_grant`, `access_denied`, …). */
export class OAuthFlowError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message)
    this.name = 'OAuthFlowError'
  }
}

/** True when the provider has declared the refresh token dead (RFC 6749 §5.2
 *  `invalid_grant`) — the sign-in is over, as opposed to a network blip that
 *  leaves it intact. The refresh path signs the entry out only on this. */
export const isSignedOut = (e: unknown): boolean =>
  e instanceof OAuthFlowError && e.code === 'invalid_grant'

/** A browser round-trip that produced nothing by now is abandoned (§4: the
 *  attempt times out on its own; the loopback listener closes with it). */
const AUTHORIZE_TIMEOUT_MS = 5 * 60_000

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** `expires_in` (seconds) → ISO `expiresAt`; an absent value assumes an hour,
 *  which only means the next resolve refreshes a little early. */
export const expiryFrom = (expiresIn: unknown): string => {
  const seconds =
    typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600
  return new Date(Date.now() + seconds * 1000).toISOString()
}

/** The payload claims of a JWT, or {} — for providers whose account identity
 *  rides in an `id_token`. No signature check: the token arrived over TLS from
 *  the issuer itself, and only a display string is read from it. */
export function idTokenClaims(idToken: unknown): Record<string, unknown> {
  const payload = str(idToken).split('.')[1]
  if (!payload) return {}
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * POST one grant to the provider's token endpoint and parse the response.
 * Every string that could be a token in the answer is registered with the
 * redactor before this returns (§5.4).
 */
export async function tokenRequest(
  cfg: AuthCodeConfig,
  grant: Record<string, string>
): Promise<Record<string, unknown>> {
  const host = new URL(cfg.tokenEndpoint).host
  const body: Record<string, string> = {
    ...grant,
    client_id: cfg.clientId,
    ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {})
  }
  let res: Response
  try {
    res = await fetch(
      cfg.tokenEndpoint,
      cfg.tokenBody === 'json'
        ? {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(body).toString()
          }
    )
  } catch (e) {
    throw new OAuthFlowError(
      `could not reach ${host} — ${e instanceof Error ? e.message : String(e)}`
    )
  }
  const text = await res.text()
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    // a non-JSON error page; the status line below is all there is to say
  }
  if (!res.ok) {
    const code = str(parsed['error']) || undefined
    const detail = str(parsed['error_description']) || code || `HTTP ${res.status}`
    throw new OAuthFlowError(`${host} answered: ${detail}`, code)
  }
  addSecrets(
    [parsed['access_token'], parsed['refresh_token'], parsed['id_token']].filter(
      (v): v is string => typeof v === 'string'
    )
  )
  return parsed
}

/**
 * The refresh grant (§5.3's network half). Rotation is the provider's choice:
 * a response without a new refresh token means the current one is still live
 * (Google's shape), and the returned set says so.
 */
export async function refreshGrant(cfg: AuthCodeConfig, current: TokenSet): Promise<TokenSet> {
  const parsed = await tokenRequest(cfg, {
    grant_type: 'refresh_token',
    refresh_token: current.refresh
  })
  const access = str(parsed['access_token'])
  if (!access)
    throw new OAuthFlowError(`${new URL(cfg.tokenEndpoint).host} returned no access token`)
  return {
    access,
    refresh: str(parsed['refresh_token']) || current.refresh,
    expiresAt: expiryFrom(parsed['expires_in']),
    // Identity does not change on a refresh.
    account: current.account,
    ...(cfg.extraData ? { extra: cfg.extraData(parsed, current) } : {})
  }
}

/** `shell.openExternal`, resolved lazily like main/credentials.ts resolves
 *  safeStorage: this module is bundled into node-only tests where 'electron'
 *  is absent, and only the sign-in path (never the refresh path) needs it. */
const requireFn = createRequire(import.meta.url)
function openInSystemBrowser(url: string): void {
  const electron = requireFn('electron') as {
    shell?: { openExternal(url: string): Promise<void> }
  } | null
  // §4: the system browser, never an embedded webview or a BrowserWindow — the
  // user's password manager, passkeys and SSO cookies live in their browser,
  // and an Electron surface asking for a provider password reads as a phish.
  if (!electron || typeof electron === 'string' || !electron.shell)
    throw new OAuthFlowError('no system browser available in this process')
  void electron.shell.openExternal(url)
}

/**
 * The full authorization-code sign-in (§3, §4): PKCE S256 verifier pair, a
 * loopback listener on 127.0.0.1 (random port unless the borrowed registration
 * pins one), the system browser, a strict per-attempt `state` check — a
 * mismatch is an aborted flow, not a warning — then the code exchange.
 * `account` pulls the display identity out of the token response.
 */
export async function authorizeGrant(
  cfg: AuthCodeConfig,
  account: (tokens: Record<string, unknown>) => Promise<string> | string,
  signal?: AbortSignal
): Promise<TokenSet> {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(16).toString('base64url')
  const redirectPath = cfg.redirectPath ?? '/callback'

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>(
    (resolve, reject) => {
      let redirectUri = ''
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== redirectPath) {
          res.statusCode = 404
          res.end()
          return
        }
        const error = url.searchParams.get('error')
        const gotCode = url.searchParams.get('code')
        if (error)
          return finish(res, 'Sign-in failed — you can close this tab.', () =>
            reject(new OAuthFlowError(`the provider answered: ${error}`, error))
          )
        // Checked strictly, per attempt, before the code is even looked at.
        if (url.searchParams.get('state') !== state)
          return finish(res, 'Sign-in rejected.', () =>
            reject(new OAuthFlowError('state mismatch on the OAuth callback — flow aborted'))
          )
        if (!gotCode)
          return finish(res, 'Sign-in failed — you can close this tab.', () =>
            reject(new OAuthFlowError('the callback carried no authorization code'))
          )
        finish(res, 'Signed in — you can close this tab and return to gurt.', () =>
          resolve({ code: gotCode, redirectUri })
        )
      })
      let done = false
      const settle = (fn: () => void): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        server.close()
        fn()
      }
      const finish = (res: ServerResponse, page: string, fn: () => void): void => {
        res.statusCode = 200
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end(`<!doctype html><meta charset="utf-8"><title>gurt</title><p>${page}</p>`)
        settle(fn)
      }
      const timer = setTimeout(
        () =>
          settle(() =>
            reject(new OAuthFlowError('sign-in timed out — no answer from the browser'))
          ),
        AUTHORIZE_TIMEOUT_MS
      )
      timer.unref?.()
      const onAbort = (): void => settle(() => reject(new OAuthFlowError('sign-in cancelled')))
      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort)
      server.on('error', (e: NodeJS.ErrnoException) =>
        settle(() =>
          reject(
            e.code === 'EADDRINUSE'
              ? new OAuthFlowError(
                  `port ${cfg.port} is already in use — close the other sign-in attempt and retry`
                )
              : new OAuthFlowError(`loopback listener failed — ${e.message}`)
          )
        )
      )
      // 127.0.0.1 only (§4/RFC 8252): the redirect_uri may *spell* `localhost`
      // when the borrowed registration does, but nothing off this machine can
      // reach the listener either way.
      server.listen(cfg.port ?? 0, '127.0.0.1', () => {
        const addr = server.address()
        const port = addr && typeof addr === 'object' ? addr.port : cfg.port
        redirectUri = `http://${cfg.redirectHost ?? '127.0.0.1'}:${port}${redirectPath}`
        const authorize = new URL(cfg.authorizationEndpoint)
        const params: Record<string, string> = {
          response_type: 'code',
          client_id: cfg.clientId,
          redirect_uri: redirectUri,
          scope: cfg.scopes.join(' '),
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          ...(cfg.authParams ?? {})
        }
        for (const [k, v] of Object.entries(params)) authorize.searchParams.set(k, v)
        try {
          openInSystemBrowser(authorize.toString())
        } catch (e) {
          settle(() => reject(e instanceof Error ? e : new Error(String(e))))
        }
      })
    }
  )

  const parsed = await tokenRequest(cfg, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    // Conforming servers ignore it; Anthropic's endpoint checks it.
    state
  })
  const access = str(parsed['access_token'])
  const refresh = str(parsed['refresh_token'])
  if (!access || !refresh)
    throw new OAuthFlowError(
      `${new URL(cfg.tokenEndpoint).host} returned no ${access ? 'refresh' : 'access'} token — sign-in incomplete`
    )
  return {
    access,
    refresh,
    expiresAt: expiryFrom(parsed['expires_in']),
    account: str(await account(parsed)),
    ...(cfg.extraData ? { extra: cfg.extraData(parsed) } : {})
  }
}
