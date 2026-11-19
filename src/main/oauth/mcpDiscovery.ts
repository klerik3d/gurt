// Discovery and dynamic client registration for the generic `mcp` OAuth
// provider (docs/requirements-oauth-credentials.md §3, phase 3). Everything a
// remote MCP server's sign-in needs is learned from the server itself:
//
//   1. an unauthenticated request to the MCP URL answers 401 with a
//      `WWW-Authenticate: Bearer resource_metadata="…"` challenge (RFC 9728 §5.1);
//   2. that URL — or, failing it, `/.well-known/oauth-protected-resource` —
//      is the protected-resource metadata, which names the authorization server;
//   3. the authorization server's metadata is RFC 8414
//      (`/.well-known/oauth-authorization-server`), falling back to OIDC
//      discovery (`/.well-known/openid-configuration`);
//   4. a public client is registered for the loopback redirect (RFC 7591).
//
// Nothing here logs and nothing here stores: errors are sentences for the
// Credentials/MCP editor, built from the server's own words, never from a URL
// that carried a query string.

import { canonicalMcpUrl, sameMcpUrl } from '../../shared/mcp'
import { OAuthFlowError } from './flow'

/** One probe, one metadata fetch — a server that cannot answer in this long is
 *  not going to complete a sign-in either. */
const REQUEST_TIMEOUT_MS = 15_000
const MAX_REDIRECTS = 3

/** What a sign-in against one MCP server needs, learned by discovery. */
export interface McpDiscovery {
  /** The canonical MCP URL — the RFC 8707 `resource` (the PRM's own spelling
   *  was checked against it). */
  resource: string
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint: string
  /** The scopes to ask for by default: the challenge's `scope`, else the
   *  protected resource's `scopes_supported`, else none. The authorization
   *  server's own `scopes_supported` is deliberately not used: it lists every
   *  scope the server can ever grant (Cloudflare's lists ~400), which is the
   *  opposite of a least-privilege default. A server that needs more is
   *  answered by the per-credential `scopes` override. */
  scopes: string[]
  /** The authorization server advertises `offline_access` — only used to word
   *  the error when no refresh token comes back. */
  offlineAccess: boolean
}

type FetchFn = typeof fetch

export interface DiscoveryOptions {
  fetch?: FetchFn
  signal?: AbortSignal
  /** The MCP server is on loopback, so its endpoints may be too. Set by
   *  {@link discoverMcpOAuth}; the default (false) is the remote rule, which
   *  every redirect hop is also held to. */
  loopbackOk?: boolean
  /** Per-request bound, headers *and* body (default {@link REQUEST_TIMEOUT_MS}). */
  timeoutMs?: number
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []

/** Every endpoint is https — except a loopback one, and only when the MCP
 *  server itself is on loopback (a local server, the tests). A remote server
 *  must not be able to aim gurt's requests, a client registration and the
 *  token exchange at services on the user's own machine. */
export function endpointProblem(raw: string, loopbackOk: boolean): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'is not a URL'
  }
  // The address is judged before the scheme: https://localhost is as much "this
  // machine" as http://localhost.
  if (isLoopbackHost(url.hostname))
    return loopbackOk && (url.protocol === 'http:' || url.protocol === 'https:')
      ? null
      : 'points at this machine, not at the server'
  return url.protocol === 'https:' ? null : 'is not https'
}

/** Names that reach this machine itself: the loopback addresses (all of
 *  127.0.0.0/8, ::1), `localhost` and its subdomains, and the unspecified
 *  address, which connects to the local host on most systems. */
export const isLoopbackHost = (hostname: string): boolean => {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '[::1]' ||
    h === '[::]' ||
    h === '0.0.0.0' ||
    /^127\.\d+\.\d+\.\d+$/.test(h)
  )
}

/** Bearer-challenge parameters (`resource_metadata`, `scope`, …) of a
 *  `WWW-Authenticate` header; the first value of a name wins. */
export function challengeParams(header: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const m of header.matchAll(/([A-Za-z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,"]+))/g)) {
    const name = m[1]!.toLowerCase()
    if (!(name in out)) out[name] = (m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1')
  }
  return out
}

/** One answer, its body already read when the caller wanted it. */
interface Answer {
  status: number
  ok: boolean
  headers: Headers
  text: string
}

/**
 * A fetch bounded by the request timeout and the caller's cancellation, with
 * both kept armed until the body has been read: a server that flushes headers
 * and stalls the body must neither hang discovery nor be immune to Cancel
 * (discovery runs before the flow's own sign-in timer starts, so nothing else
 * would rescue it). `readBody: false` is for the probe, which only needs the
 * status line and headers.
 */
async function timed(
  doFetch: FetchFn,
  url: string,
  init: RequestInit,
  opts: DiscoveryOptions,
  what: string,
  readBody = true
): Promise<Answer> {
  const signal = opts.signal
  const ctl = new AbortController()
  const timer = setTimeout(
    () => ctl.abort(new Error('timed out')),
    opts.timeoutMs ?? REQUEST_TIMEOUT_MS
  )
  const onAbort = (): void => ctl.abort(signal?.reason)
  if (signal?.aborted) onAbort()
  signal?.addEventListener('abort', onAbort)
  try {
    // Redirects are followed by hand, each hop held to the same transport rule
    // as the endpoint that sent it there: a validated https URL must not be
    // able to hand the request on to cleartext or to this machine.
    let target = url
    let current = init
    let res: Response
    for (let hop = 0; ; hop++) {
      res = await doFetch(target, { ...current, signal: ctl.signal, redirect: 'manual' })
      const location = res.headers.get('location')
      if (res.status < 300 || res.status >= 400 || !location) break
      void res.body?.cancel().catch(() => {})
      if (hop >= MAX_REDIRECTS) throw new OAuthFlowError(`${new URL(url).host} redirected ${what} too many times`)
      const next = new URL(location, target).href
      const bad = endpointProblem(next, opts.loopbackOk ?? false)
      if (bad)
        throw new OAuthFlowError(
          `${new URL(url).host} redirected ${what} to an address that ${bad} — not following it`
        )
      // 301/302/303 turn the request into a body-less GET; 307/308 repeat it.
      if (res.status === 301 || res.status === 302 || res.status === 303) {
        const { method: _m, body: _b, ...rest } = current
        current = { ...rest, method: 'GET' }
      }
      target = next
    }
    let text = ''
    if (readBody) text = await res.text()
    else void res.body?.cancel().catch(() => {})
    return { status: res.status, ok: res.ok, headers: res.headers, text }
  } catch (e) {
    if (signal?.aborted) throw new OAuthFlowError('sign-in cancelled')
    if (e instanceof OAuthFlowError) throw e
    const host = (() => {
      try {
        return new URL(url).host
      } catch {
        return 'the server'
      }
    })()
    throw new OAuthFlowError(
      `could not reach ${host} for ${what} — ${e instanceof Error ? e.message : String(e)}`
    )
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** GET a JSON object, or null on anything that is not one (404, an HTML page,
 *  a body that does not parse or never finishes) — the caller moves on to its
 *  next candidate. A user cancellation is not "nothing there": it throws. */
async function getJson(
  doFetch: FetchFn,
  url: string,
  opts: DiscoveryOptions,
  what: string
): Promise<Record<string, unknown> | null> {
  let answer: Answer
  try {
    answer = await timed(doFetch, url, { headers: { accept: 'application/json' } }, opts, what)
  } catch (e) {
    if (opts.signal?.aborted) throw e
    return null
  }
  if (!answer.ok) return null
  try {
    const body: unknown = JSON.parse(answer.text)
    return isRecord(body) ? body : null
  } catch {
    return null
  }
}

/** `<origin>/.well-known/<name>` with the path of `base` appended (RFC 8414
 *  §3.1 / RFC 9728 §3.1 "path insertion"), or without it. */
function wellKnown(base: URL, name: string, withPath: boolean): string {
  const path = withPath && base.pathname !== '/' ? base.pathname.replace(/\/$/, '') : ''
  return `${base.origin}/.well-known/${name}${path}`
}

/** Step 1–2: the protected-resource metadata of the MCP server, and the scope
 *  its 401 challenge named. */
async function protectedResource(
  doFetch: FetchFn,
  server: URL,
  opts: DiscoveryOptions,
  loopbackOk: boolean
): Promise<{ meta: Record<string, unknown>; challengeScope: string[] }> {
  // The unauthenticated probe. A POST, because that is the request every
  // streamable-HTTP server must answer (a GET may legitimately be 405).
  const probe = await timed(
    doFetch,
    server.href,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'gurt', version: '0' }
        }
      })
    },
    opts,
    'the MCP endpoint',
    false
  )
  const challenge = probe.status === 401 ? challengeParams(probe.headers.get('www-authenticate')) : {}

  // The advertised URL first, then the two well-known spellings (the one with
  // the MCP path inserted, then the origin's own).
  const candidates: string[] = []
  const advertised = challenge['resource_metadata']
  if (advertised && !endpointProblem(advertised, loopbackOk)) candidates.push(advertised)
  candidates.push(wellKnown(server, 'oauth-protected-resource', true))
  candidates.push(wellKnown(server, 'oauth-protected-resource', false))
  for (const url of [...new Set(candidates)]) {
    const meta = await getJson(doFetch, url, opts, 'the protected-resource metadata')
    if (!meta || strings(meta['authorization_servers']).length === 0) continue
    // RFC 9728 §3.3: the document must describe the resource it was fetched
    // for — otherwise it is another server's answer, and trusting it would let
    // that server pick where this one's users sign in.
    // `resource` is REQUIRED there; a document without one proves nothing about
    // which resource it describes — and the challenge's URL can point anywhere
    // — so it is not a candidate at all.
    const claimed = meta['resource']
    if (typeof claimed !== 'string') continue
    if (!sameMcpUrl(claimed, server.href))
      throw new OAuthFlowError(
        `${server.host} advertises OAuth metadata for a different resource (${claimed}) — refusing to sign in`
      )
    return { meta, challengeScope: (challenge['scope'] ?? '').split(/\s+/).filter(Boolean) }
  }
  throw new OAuthFlowError(
    probe.status === 401
      ? `${server.host} asked for authorization but publishes no OAuth protected-resource metadata (RFC 9728) — it cannot be signed in to without a pre-registered client, which gurt does not support`
      : `${server.host} did not ask for authorization (HTTP ${probe.status}) — nothing to sign in to`
  )
}

/** Step 3: the authorization server's metadata — RFC 8414, then OIDC. */
async function authorizationServer(
  doFetch: FetchFn,
  issuerRaw: string,
  opts: DiscoveryOptions,
  loopbackOk: boolean
): Promise<Record<string, unknown>> {
  const bad = endpointProblem(issuerRaw, loopbackOk)
  if (bad) throw new OAuthFlowError(`the authorization server URL ${bad}`)
  const issuer = new URL(issuerRaw)
  const urls = [
    wellKnown(issuer, 'oauth-authorization-server', true),
    wellKnown(issuer, 'openid-configuration', true),
    `${issuer.origin}${issuer.pathname.replace(/\/$/, '')}/.well-known/openid-configuration`
  ]
  for (const url of [...new Set(urls)]) {
    const meta = await getJson(doFetch, url, opts, 'the authorization-server metadata')
    if (!meta) continue
    // RFC 8414 §3.3: the issuer in the document is the issuer it was fetched
    // for, compared as given (modulo a trailing slash).
    // Required (RFC 8414 §2): a document that does not name its issuer proves
    // nothing about whose endpoints it lists, so it is not accepted.
    const claimed = meta['issuer']
    if (typeof claimed !== 'string' || claimed.replace(/\/$/, '') !== issuerRaw.replace(/\/$/, ''))
      continue
    return meta
  }
  throw new OAuthFlowError(`${issuer.host} publishes no authorization-server metadata (RFC 8414 / OIDC discovery)`)
}

/**
 * Learn how to sign in to the MCP server at `serverUrl`. Throws an
 * {@link OAuthFlowError} sentence for everything that makes the server
 * unusable for gurt's flow — no metadata, no PKCE S256, no dynamic
 * registration, no public clients — rather than guessing around it.
 */
export async function discoverMcpOAuth(
  serverUrl: string,
  opts: DiscoveryOptions = {}
): Promise<McpDiscovery> {
  const doFetch = opts.fetch ?? fetch
  const resource = canonicalMcpUrl(serverUrl)
  if (!resource) throw new OAuthFlowError(`"${serverUrl}" is not an http(s) URL`)
  const server = new URL(resource)
  // The token this sign-in mints is sent to this URL on every call: the same
  // rule as every endpoint discovery returns (https, or a loopback address).
  const loopbackOk = isLoopbackHost(server.hostname)
  const cleartext = endpointProblem(resource, true)
  if (cleartext) throw new OAuthFlowError(`${server.host}: the MCP server URL ${cleartext} — gurt will not sign in over cleartext`)

  // Every request below — and every redirect hop of each — is held to the rule.
  const o: DiscoveryOptions = { ...opts, loopbackOk }
  const { meta: prm, challengeScope } = await protectedResource(doFetch, server, o, loopbackOk)
  const issuer = strings(prm['authorization_servers'])[0]!
  const as = await authorizationServer(doFetch, issuer, o, loopbackOk)
  const host = new URL(issuer).host

  const authorizationEndpoint = typeof as['authorization_endpoint'] === 'string' ? as['authorization_endpoint'] : ''
  const tokenEndpoint = typeof as['token_endpoint'] === 'string' ? as['token_endpoint'] : ''
  const registrationEndpoint =
    typeof as['registration_endpoint'] === 'string' ? as['registration_endpoint'] : ''
  for (const [name, value] of [
    ['authorization_endpoint', authorizationEndpoint],
    ['token_endpoint', tokenEndpoint]
  ] as const) {
    if (!value) throw new OAuthFlowError(`${host}'s metadata has no ${name}`)
    const problem = endpointProblem(value, loopbackOk)
    if (problem) throw new OAuthFlowError(`${host}'s ${name} ${problem}`)
  }
  // The MCP authorization spec makes this a refusal, not a warning: an absent
  // list means the server does not support PKCE at all.
  if (!strings(as['code_challenge_methods_supported']).includes('S256'))
    throw new OAuthFlowError(`${host} does not advertise PKCE S256 — gurt will not sign in without it`)
  if (!registrationEndpoint)
    throw new OAuthFlowError(
      `${host} does not support dynamic client registration (RFC 7591) — gurt has no pre-registered client for it`
    )
  const regProblem = endpointProblem(registrationEndpoint, loopbackOk)
  if (regProblem) throw new OAuthFlowError(`${host}'s registration_endpoint ${regProblem}`)
  // RFC 8414 defaults an absent list to client_secret_basic only; servers that
  // omit it routinely accept `none`, so only an explicit list can refuse.
  const methods = strings(as['token_endpoint_auth_methods_supported'])
  if (methods.length > 0 && !methods.includes('none'))
    throw new OAuthFlowError(
      `${host} accepts no public clients (token auth methods: ${methods.join(', ')}) — confidential clients are not supported`
    )

  return {
    resource,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint,
    scopes: challengeScope.length ? challengeScope : strings(prm['scopes_supported']),
    offlineAccess: strings(as['scopes_supported']).includes('offline_access')
  }
}

/**
 * RFC 7591 dynamic client registration of a public client for one loopback
 * redirect. Returns the `client_id`. Any `client_secret` in the answer is
 * ignored and never stored — a server that insists on a confidential client
 * (`token_endpoint_auth_method` other than `none`) is refused.
 */
export async function registerMcpClient(
  registrationEndpoint: string,
  redirectUri: string,
  scopes: readonly string[],
  opts: DiscoveryOptions = {}
): Promise<string> {
  const doFetch = opts.fetch ?? fetch
  const host = new URL(registrationEndpoint).host
  const res = await timed(
    doFetch,
    registrationEndpoint,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'gurt',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...(scopes.length ? { scope: scopes.join(' ') } : {})
      })
    },
    opts,
    'client registration'
  )
  const text = res.text
  let body: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (isRecord(parsed)) body = parsed
  } catch {
    // not JSON; the status line below is all there is to say
  }
  if (!res.ok) {
    const code = typeof body['error'] === 'string' ? body['error'] : ''
    const detail =
      (typeof body['error_description'] === 'string' && body['error_description']) ||
      code ||
      `HTTP ${res.status}`
    throw new OAuthFlowError(`${host} refused client registration: ${detail}`, code || undefined)
  }
  const clientId = body['client_id']
  if (typeof clientId !== 'string' || !clientId)
    throw new OAuthFlowError(`${host} registered a client but returned no client_id`)
  const method = body['token_endpoint_auth_method']
  if (typeof method === 'string' && method !== 'none')
    throw new OAuthFlowError(
      `${host} registered a confidential client (${method}) — only public clients are supported`
    )
  return clientId
}
