// The generic `mcp` OAuth provider (docs/requirements-oauth-credentials.md §3,
// phase 3) against a mock MCP server + authorization server on loopback:
//
//   - discovery, both ways in: the 401 `resource_metadata` challenge, and the
//     `/.well-known/oauth-protected-resource` fallbacks; RFC 8414 metadata, and
//     the OIDC fallback;
//   - the refusals (no PKCE S256, no dynamic registration, a protected-resource
//     document for another resource);
//   - dynamic client registration of a public client for the real loopback
//     redirect, PKCE S256, the RFC 8707 `resource` on the authorize URL and on
//     every token request, scopes from the metadata and the override;
//   - what the sign-in stores, and a refresh that takes its endpoint and client
//     from the credential — single-flight, rotated token persisted, the
//     refresh token in no proxy config;
//   - a dead refresh token blocking with the §2 sentence, a sign-in bound to
//     one server refused by another;
//   - the live-scope keeper (oauth/keeper.ts): renews before expiry, pushes
//     only a changed token, stops on unwatch, retries a blip, never retries a
//     signed-out entry.
//
//   node scripts/mcp-oauth.test.mjs
import { test, after, before } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import http from 'node:http'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-mcp-oauth-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-mcp-oauth-'))
process.env.GURT_ROOT = GURT_ROOT
process.env.GURT_FORCE_PLAINTEXT = '1'

await bundle({
  stdin: {
    contents: `
export { createMcpProvider } from ${S('src/main/oauth/mcp.ts')}
export { OAuthFlowError } from ${S('src/main/oauth/flow.ts')}
export { discoverMcpOAuth, registerMcpClient, challengeParams } from ${S('src/main/oauth/mcpDiscovery.ts')}
export { ScopeKeeper, renewalDelay } from ${S('src/main/oauth/keeper.ts')}
export {
  resolveOAuthAccess, freshenOAuthCredentials, oauthSignIn, cancelOAuthSignIn, OAUTH_PROVIDERS, OAUTH_PROVIDER_REGISTRY, SignedOutError
} from ${S('src/main/oauth/index.ts')}
export { patchCredentialData, upsertCredentialEntry, listCredentials, onCredentialsWritten } from ${S('src/main/credentials.ts')}
export { agentCredentials, resolveAgentSecret, isMcpSignIn, oauthBoundElsewhere, resolveMcpHeaders, resolveMcpSecretEnv, resolveMcpSecret, signedOutError } from ${S('src/shared/credentials.ts')}
export { canonicalMcpUrl, sameMcpUrl } from ${S('src/shared/mcp.ts')}
export { planProxy } from ${S('src/main/proxy/config.ts')}
export { redact } from ${S('src/main/redact.ts')}
`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  external: ['electron'],
  outfile
})
const m = await import(pathToFileURL(outfile).href)

const credsPath = path.join(GURT_ROOT, 'credentials.json')
const diskEntry = (id) => JSON.parse(fs.readFileSync(credsPath, 'utf8')).credentials.find((c) => c.id === id)
const seed = (credentials) =>
  fs.writeFileSync(credsPath, JSON.stringify({ version: 2, credentials }, null, 2))

const HOUR = 3_600_000
const past = new Date(Date.now() - HOUR).toISOString()
const future = new Date(Date.now() + HOUR).toISOString()

// ---------------------------------------------------------------------------
// The mock: one loopback server playing the MCP server and its authorization
// server. `cfg` is mutated per test; `log` records what the client sent.

let server
let base = ''
const cfg = {}
const log = { register: [], token: [], probes: 0, authorize: [], redirected: [] }
let tokenSeq = 0

const sockets = new Set()

const resetMock = (over = {}) => {
  for (const k of Object.keys(cfg)) delete cfg[k]
  Object.assign(
    cfg,
    {
      // how the resource is found
      challenge: 'resource_metadata', // 'resource_metadata' | 'none' | 'scope'
      prmAt: 'path', // 'path' | 'root' | 'none' | 'other-resource'
      prmScopes: ['read', 'write'],
      asAt: 'rfc8414', // 'rfc8414' | 'oidc'
      pkce: ['S256'],
      registration: true,
      authMethods: ['none'],
      scopesSupported: ['read', 'write', 'offline_access', 'admin'],
      refreshOnExchange: true,
      refreshFails: null, // an OAuth error code the refresh grant answers
      asIssuer: 'ok', // 'ok' | 'missing' | 'number' | 'other'
      tokenRedirect: false,
      stall: null, // 'prm' | 'as' | 'register': flush headers, never finish the body
      expiresIn: 3600
    },
    over
  )
  log.register = []
  log.token = []
  log.probes = 0
  log.authorize = []
  log.redirected = []
  tokenSeq = 0
}

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

const readBody = (req) =>
  new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => resolve(b))
  })

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base)
    const p = url.pathname
    if (p === '/mcp' && req.method === 'POST') {
      log.probes++
      const www =
        cfg.challenge === 'none'
          ? 'Bearer realm="OAuth"'
          : cfg.challenge === 'scope'
            ? `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="from-challenge other"`
            : `Bearer realm="OAuth", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`
      res.writeHead(401, { 'www-authenticate': www })
      return res.end()
    }
    const prm = () => ({
      ...(cfg.prmAt === 'no-resource'
        ? {}
        : { resource: cfg.prmAt === 'other-resource' ? 'https://elsewhere.example/mcp' : `${base}/mcp` }),
      authorization_servers: [base],
      ...(cfg.prmScopes ? { scopes_supported: cfg.prmScopes } : {})
    })
    const stalled = (kind) => {
      if (cfg.stall !== kind) return false
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"truncat') // headers + a body that never completes
      return true
    }
    if (p.startsWith('/.well-known/oauth-protected-resource') && stalled('prm')) return
    if (p.startsWith('/.well-known/') && p.includes('authorization-server') && stalled('as')) return
    if (p === '/register' && stalled('register')) return
    if (p === '/.well-known/oauth-protected-resource/mcp' && ['path', 'other-resource', 'no-resource'].includes(cfg.prmAt))
      return json(res, 200, prm())
    if (p === '/.well-known/oauth-protected-resource' && cfg.prmAt === 'root') return json(res, 200, prm())
    const asMeta = () => ({
      ...(cfg.asIssuer === 'missing' ? {} : { issuer: cfg.asIssuer === 'number' ? 42 : cfg.asIssuer === 'other' ? 'https://elsewhere.example' : base }),
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      ...(cfg.registration ? { registration_endpoint: `${base}/register` } : {}),
      ...(cfg.pkce ? { code_challenge_methods_supported: cfg.pkce } : {}),
      token_endpoint_auth_methods_supported: cfg.authMethods,
      scopes_supported: cfg.scopesSupported
    })
    if (p === '/.well-known/oauth-authorization-server' && cfg.asAt === 'rfc8414') return json(res, 200, asMeta())
    if (p === '/.well-known/openid-configuration' && cfg.asAt === 'oidc') return json(res, 200, asMeta())
    if (p === '/register' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      log.register.push(body)
      return json(res, 201, { client_id: 'dcr-client-1', client_secret: 'MUST-BE-IGNORED', ...body })
    }
    if (p === '/token-elsewhere') {
      log.redirected.push(p)
      return json(res, 200, { access_token: 'LEAKED', refresh_token: 'LEAKED', expires_in: 3600 })
    }
    if (p === '/token' && req.method === 'POST' && cfg.tokenRedirect) {
      log.token.push(Object.fromEntries(new URLSearchParams(await readBody(req))))
      res.writeHead(307, { location: `${base}/token-elsewhere` })
      return res.end()
    }
    if (p === '/token' && req.method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(await readBody(req)))
      log.token.push(form)
      // Headers and the start of a body, then silence — until the client gives up.
      if (cfg.tokenStall && (cfg.tokenStall === 'all' || form.grant_type === cfg.tokenStall)) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.write('{"access_token":')
        return
      }
      if (form.grant_type === 'refresh_token') {
        if (cfg.refreshFails) return json(res, 400, { error: cfg.refreshFails, error_description: 'revoked' })
        await new Promise((r) => setTimeout(r, 25))
        tokenSeq++
        return json(res, 200, {
          access_token: `ACCESS-R${tokenSeq}`,
          refresh_token: `REFRESH-R${tokenSeq}`,
          expires_in: cfg.expiresIn
        })
      }
      return json(res, 200, {
        access_token: 'ACCESS-0',
        ...(cfg.refreshOnExchange ? { refresh_token: 'REFRESH-0' } : {}),
        expires_in: cfg.expiresIn
      })
    }
    res.writeHead(404)
    res.end()
  })
  server.on('connection', (sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => {
  for (const sock of sockets) sock.destroy()
  server?.close()
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

/** The "browser": records the authorization URL and completes it by calling the
 *  loopback redirect with a code and the state it was given. */
const browser = (over = {}) => (url) => {
  const u = new URL(url)
  log.authorize.push(Object.fromEntries(u.searchParams))
  const redirect = new URL(u.searchParams.get('redirect_uri'))
  if (over.error) redirect.searchParams.set('error', over.error)
  else redirect.searchParams.set('code', 'AUTH-CODE')
  redirect.searchParams.set('state', over.state ?? u.searchParams.get('state'))
  void fetch(redirect).catch(() => {})
}

const draft = (id, data = {}) => ({
  id,
  label: `mcp ${id}`,
  kind: 'oauth',
  hosts: [],
  data: { providerId: 'mcp', serverUrl: `${base}/mcp`, ...data }
})

// --- discovery -------------------------------------------------------------

test('discovery follows the 401 resource_metadata challenge to RFC 8414 metadata', async () => {
  resetMock()
  const d = await m.discoverMcpOAuth(`${base}/mcp`)
  assert.equal(d.resource, `${base}/mcp`)
  assert.equal(d.authorizationEndpoint, `${base}/authorize`)
  assert.equal(d.tokenEndpoint, `${base}/token`)
  assert.equal(d.registrationEndpoint, `${base}/register`)
  // The protected resource's scopes_supported, not the authorization server's
  // longer list: least privilege by default.
  assert.deepEqual(d.scopes, ['read', 'write'])
  assert.equal(d.offlineAccess, true)
  assert.equal(log.probes, 1, 'one unauthenticated probe of the MCP URL')
})

test('discovery falls back to /.well-known/oauth-protected-resource (path-inserted, then root)', async () => {
  resetMock({ challenge: 'none', prmAt: 'path' })
  assert.equal((await m.discoverMcpOAuth(`${base}/mcp`)).tokenEndpoint, `${base}/token`)
  resetMock({ challenge: 'none', prmAt: 'root' })
  assert.equal((await m.discoverMcpOAuth(`${base}/mcp`)).tokenEndpoint, `${base}/token`)
})

test('the challenge scope wins over the resource metadata scopes', async () => {
  resetMock({ challenge: 'scope' })
  assert.deepEqual((await m.discoverMcpOAuth(`${base}/mcp`)).scopes, ['from-challenge', 'other'])
})

test('discovery falls back to OIDC metadata when RFC 8414 has none', async () => {
  resetMock({ asAt: 'oidc' })
  assert.equal((await m.discoverMcpOAuth(`${base}/mcp`)).registrationEndpoint, `${base}/register`)
})

test('a server that advertises no scopes is asked for none', async () => {
  resetMock({ prmScopes: null })
  assert.deepEqual((await m.discoverMcpOAuth(`${base}/mcp`)).scopes, [])
})

test('discovery refuses what gurt cannot do, in a sentence', async () => {
  resetMock({ pkce: null })
  await assert.rejects(m.discoverMcpOAuth(`${base}/mcp`), /does not advertise PKCE S256/)
  resetMock({ pkce: ['plain'] })
  await assert.rejects(m.discoverMcpOAuth(`${base}/mcp`), /does not advertise PKCE S256/)
  resetMock({ registration: false })
  await assert.rejects(m.discoverMcpOAuth(`${base}/mcp`), /dynamic client registration/)
  resetMock({ authMethods: ['client_secret_basic'] })
  await assert.rejects(m.discoverMcpOAuth(`${base}/mcp`), /accepts no public clients/)
  resetMock({ prmAt: 'other-resource' })
  await assert.rejects(m.discoverMcpOAuth(`${base}/mcp`), /different resource/)
  // RFC 9728 makes `resource` required: a document without it proves nothing
  // about which resource it describes, so it is not trusted to name the AS.
  resetMock({ prmAt: 'no-resource', challenge: 'none' })
  await assert.rejects(m.discoverMcpOAuth(`${base}/mcp`), /no OAuth protected-resource metadata/)
  resetMock({ prmAt: 'none', challenge: 'none' })
  await assert.rejects(m.discoverMcpOAuth(`${base}/mcp`), /no OAuth protected-resource metadata/)
  // A cleartext MCP URL would have its bearer token sent in the clear.
  await assert.rejects(m.discoverMcpOAuth('http://mcp.example.com/mcp'), /cleartext/)
  await assert.rejects(m.discoverMcpOAuth('ftp://x.example/mcp'), /not an http\(s\) URL/)
})

// A server that flushes headers and stalls the body must not hang discovery or
// make Cancel inert: discovery runs before the flow's own sign-in timer starts.
const took = async (promise) => {
  const t0 = Date.now()
  const err = await promise.then(() => null, (e) => e)
  return { err, ms: Date.now() - t0 }
}

for (const stall of ['prm', 'as']) {
  test(`a stalled ${stall} body times out instead of hanging discovery`, async () => {
    resetMock({ stall })
    const { err, ms } = await took(m.discoverMcpOAuth(`${base}/mcp`, { timeoutMs: 150 }))
    assert.ok(err, 'discovery rejected')
    assert.ok(ms < 5_000, `rejected promptly (${ms} ms)`)
  })

  test(`Cancel aborts a stalled ${stall} body read`, async () => {
    resetMock({ stall })
    const ctl = new AbortController()
    setTimeout(() => ctl.abort(), 100)
    const { err, ms } = await took(
      m.discoverMcpOAuth(`${base}/mcp`, { signal: ctl.signal, timeoutMs: 60_000 })
    )
    assert.match(err?.message ?? '', /cancelled/)
    assert.ok(ms < 5_000, `cancelled promptly (${ms} ms)`)
  })
}

test('a stalled registration body times out, and Cancel aborts it', async () => {
  resetMock({ stall: 'register' })
  const slow = await took(
    m.registerMcpClient(`${base}/register`, 'http://127.0.0.1:1/callback', [], { timeoutMs: 150 })
  )
  assert.match(slow.err?.message ?? '', /could not reach/)
  assert.ok(slow.ms < 5_000)
  const ctl = new AbortController()
  setTimeout(() => ctl.abort(), 100)
  const cancelled = await took(
    m.registerMcpClient(`${base}/register`, 'http://127.0.0.1:1/callback', [], {
      signal: ctl.signal,
      timeoutMs: 60_000
    })
  )
  assert.match(cancelled.err?.message ?? '', /cancelled/)
  assert.ok(cancelled.ms < 5_000)
})

test('AS metadata must name the issuer it was fetched for', async () => {
  for (const asIssuer of ['missing', 'number', 'other']) {
    resetMock({ asIssuer })
    await assert.rejects(
      m.discoverMcpOAuth(`${base}/mcp`),
      /publishes no authorization-server metadata/,
      `issuer ${asIssuer}`
    )
  }
  // The OIDC fallback is held to the same rule.
  resetMock({ asAt: 'oidc', asIssuer: 'missing' })
  await assert.rejects(m.discoverMcpOAuth(`${base}/mcp`), /publishes no authorization-server metadata/)
  resetMock({ asAt: 'oidc' })
  assert.equal((await m.discoverMcpOAuth(`${base}/mcp`)).tokenEndpoint, `${base}/token`)
})

test('challengeParams reads quoted and bare Bearer parameters', () => {
  assert.deepEqual(
    m.challengeParams('Bearer realm="OAuth", resource_metadata="https://a/b", scope="x y", error=invalid_token'),
    { realm: 'OAuth', resource_metadata: 'https://a/b', scope: 'x y', error: 'invalid_token' }
  )
  assert.deepEqual(m.challengeParams(null), {})
})

// --- DCR + the whole sign-in ----------------------------------------------

test('sign-in: DCR for the loopback redirect, PKCE S256, resource on authorize and token', async () => {
  resetMock()
  const provider = m.createMcpProvider({ open: browser() })
  const set = await provider.authorize(undefined, { data: { serverUrl: `${base}/mcp` } })

  // RFC 7591: one public client, registered for the exact loopback redirect.
  assert.equal(log.register.length, 1)
  const reg = log.register[0]
  assert.equal(reg.token_endpoint_auth_method, 'none')
  assert.equal(reg.redirect_uris.length, 1)
  assert.match(reg.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/)
  assert.deepEqual(reg.grant_types, ['authorization_code', 'refresh_token'])

  // The authorize request: the registered client and redirect, PKCE S256, the
  // RFC 8707 resource, the scopes the metadata named.
  const a = log.authorize[0]
  assert.equal(a.client_id, 'dcr-client-1')
  assert.equal(a.redirect_uri, reg.redirect_uris[0])
  assert.equal(a.code_challenge_method, 'S256')
  assert.ok(a.code_challenge && a.state)
  assert.equal(a.resource, `${base}/mcp`)
  assert.equal(a.scope, 'read write')
  assert.equal(a.response_type, 'code')

  // The code exchange: verifier, redirect, resource, client — and no secret.
  const t = log.token[0]
  assert.equal(t.grant_type, 'authorization_code')
  assert.equal(t.code, 'AUTH-CODE')
  assert.equal(t.resource, `${base}/mcp`)
  assert.equal(t.client_id, 'dcr-client-1')
  assert.equal(t.redirect_uri, reg.redirect_uris[0])
  assert.ok(t.code_verifier)
  assert.equal(t.client_secret, undefined, 'a public client sends no client_secret')

  // What a refresh will need, stored in the set's extras (§2).
  assert.equal(set.access, 'ACCESS-0')
  assert.equal(set.refresh, 'REFRESH-0')
  assert.equal(set.account, new URL(base).host, 'no id_token: the server host stands in')
  assert.deepEqual(set.extra, {
    serverUrl: `${base}/mcp`,
    tokenEndpoint: `${base}/token`,
    clientId: 'dcr-client-1'
  })
  assert.ok(!JSON.stringify(set).includes('MUST-BE-IGNORED'), 'the DCR client_secret is never kept')
  assert.equal(m.redact('ACCESS-0'), '[redacted]', 'tokens reach the redactor on arrival (§5.4)')
})

test('the scopes override replaces the advertised scopes and is stored', async () => {
  resetMock()
  const provider = m.createMcpProvider({ open: browser() })
  const set = await provider.authorize(undefined, {
    data: { serverUrl: `${base}/mcp`, scopes: 'offline_access admin' }
  })
  assert.equal(log.authorize[0].scope, 'offline_access admin')
  assert.equal(log.register[0].scope, 'offline_access admin')
  assert.equal(set.extra.scopes, 'offline_access admin')
})

test('a failed discovery or a refused client never opens the browser', async () => {
  resetMock({ registration: false })
  let opened = 0
  const provider = m.createMcpProvider({ open: () => opened++ })
  await assert.rejects(provider.authorize(undefined, { data: { serverUrl: `${base}/mcp` } }), /dynamic client registration/)
  assert.equal(opened, 0)
  await assert.rejects(provider.authorize(undefined, { data: {} }), /no MCP server URL/)
})

test('a callback with the wrong state aborts the flow and exchanges nothing', async () => {
  resetMock()
  const provider = m.createMcpProvider({ open: browser({ state: 'forged' }) })
  await assert.rejects(
    provider.authorize(undefined, { data: { serverUrl: `${base}/mcp` } }),
    /state mismatch/
  )
  assert.equal(log.token.length, 0)
})

test('no refresh token back: the error names offline_access when the server offers it', async () => {
  resetMock({ refreshOnExchange: false })
  const provider = m.createMcpProvider({ open: browser() })
  await assert.rejects(
    provider.authorize(undefined, { data: { serverUrl: `${base}/mcp` } }),
    /no refresh token.*offline_access/
  )
})

test('a cancelled sign-in rejects as cancelled and registers nothing further', async () => {
  resetMock()
  const ctl = new AbortController()
  const provider = m.createMcpProvider({ open: () => ctl.abort() })
  await assert.rejects(
    provider.authorize(ctl.signal, { data: { serverUrl: `${base}/mcp` } }),
    /cancelled/
  )
})

test('oauthSignIn stores the mcp set with its extras; the registry has the provider', async () => {
  resetMock()
  seed([])
  assert.ok(m.OAUTH_PROVIDER_REGISTRY.mcp, "'mcp' is a registered provider")
  assert.equal(m.OAUTH_PROVIDERS.mcp, undefined, 'the agent-kind set stays the plugins\' own')
  const provider = m.createMcpProvider({ open: browser() })
  await m.oauthSignIn(draft('signin1'), { mcp: provider })
  const stored = diskEntry('signin1')
  assert.equal(stored.kind, 'oauth')
  assert.equal(stored.data.providerId, 'mcp')
  assert.equal(stored.data.serverUrl, `${base}/mcp`)
  assert.equal(stored.data.tokenEndpoint, `${base}/token`)
  assert.equal(stored.data.clientId, 'dcr-client-1')
  assert.equal(stored.data.access, 'ACCESS-0')
  assert.equal(stored.data.refresh, 'REFRESH-0')
})

// --- refresh: endpoint and client come from the credential ------------------

const storedMcp = (id, data = {}) => ({
  id,
  label: `mcp ${id}`,
  kind: 'oauth',
  hosts: [],
  data: {
    providerId: 'mcp',
    account: 'srv',
    serverUrl: `${base}/mcp`,
    tokenEndpoint: `${base}/token`,
    clientId: 'dcr-client-1',
    access: 'STALE',
    refresh: 'REFRESH-0',
    expiresAt: past,
    ...data
  }
})

test('two concurrent resolves of an mcp credential refresh once, from the credential\'s own endpoint', async () => {
  resetMock()
  seed([storedMcp('r1')])
  const providers = { mcp: m.createMcpProvider() }
  const [a, b] = await Promise.all([
    m.resolveOAuthAccess('r1', providers),
    m.resolveOAuthAccess('r1', providers)
  ])
  assert.equal(log.token.length, 1, 'single flight: exactly one token request')
  assert.equal(a, 'ACCESS-R1')
  assert.equal(b, a)
  const t = log.token[0]
  assert.equal(t.grant_type, 'refresh_token')
  assert.equal(t.refresh_token, 'REFRESH-0')
  assert.equal(t.client_id, 'dcr-client-1', 'the client is the credential\'s')
  assert.equal(t.resource, `${base}/mcp`, 'RFC 8707 resource on the refresh too')
  assert.equal(t.client_secret, undefined)
  // The rotated refresh token is on disk, extras intact.
  const stored = diskEntry('r1')
  assert.equal(stored.data.refresh, 'REFRESH-R1')
  assert.equal(stored.data.access, 'ACCESS-R1')
  assert.equal(stored.data.tokenEndpoint, `${base}/token`)
  assert.equal(stored.data.clientId, 'dcr-client-1')
  assert.equal(stored.data.account, 'srv')
  // And a later resolve is a read.
  await m.resolveOAuthAccess('r1', providers)
  assert.equal(log.token.length, 1)
})

test('an mcp credential missing its server details says how to fix it', async () => {
  resetMock()
  seed([storedMcp('r2', { tokenEndpoint: '' })])
  await assert.rejects(
    m.resolveOAuthAccess('r2', { mcp: m.createMcpProvider() }),
    /missing its server details/
  )
  assert.equal(log.token.length, 0)
})

// --- signed out -----------------------------------------------------------

test('a revoked refresh token blocks with the §2 sentence and drops the server from the plan', async () => {
  resetMock({ refreshFails: 'invalid_grant' })
  const entry = storedMcp('so1', { access: 'OLD-ACCESS' })
  seed([entry])
  const providers = { mcp: m.createMcpProvider() }
  const sentence = `credential "${entry.label}" is signed out — sign in again in Credentials`
  await assert.rejects(m.resolveOAuthAccess('so1', providers), (/** @type {any} */ e) => {
    assert.equal(e.message, sentence)
    assert.ok(e instanceof m.SignedOutError)
    return true
  })
  assert.equal(diskEntry('so1').data.signedOut, 'true')

  // The MCP session path: freshen reports it, planProxy leaves the route out —
  // never an unauthenticated call, never the stale token.
  const { credentials, errors } = await m.freshenOAuthCredentials(await m.listCredentials(), ['so1'], providers)
  assert.equal(errors['so1'], sentence)
  const plan = m.planProxy({
    sessionId: 's1',
    token: 'proxytoken',
    selection: [{ id: 'srv' }],
    registry: [
      { id: 'srv', url: `${base}/mcp`, headers: [{ name: 'Authorization', value: { credentialId: 'so1', prefix: 'Bearer ' } }] }
    ],
    credentials,
    credentialErrors: errors,
    hostMcpUrl: 'http://host.docker.internal:1/mcp/t'
  })
  assert.equal(plan.config.mcp.srv, undefined)
  assert.deepEqual(plan.errors, [`MCP server "srv": ${sentence}`])
  assert.ok(!JSON.stringify(plan).includes('OLD-ACCESS'))
})

test('a registration the server no longer knows signs the entry out', async () => {
  resetMock({ refreshFails: 'invalid_client' })
  const entry = storedMcp('so3')
  seed([entry])
  await assert.rejects(
    m.resolveOAuthAccess('so3', { mcp: m.createMcpProvider() }),
    /signed out — sign in again in Credentials/
  )
  assert.equal(diskEntry('so3').data.signedOut, 'true')
})

test('a re-authentication that lands during a refresh is not clobbered by it', async () => {
  seed([storedMcp('race1', { refresh: 'OLD-REFRESH' })])
  let release
  const slow = {
    id: 'mcp',
    authorize: async () => ({
      access: 'NEW-ACCESS',
      refresh: 'NEW-REFRESH',
      expiresAt: future,
      account: 'srv',
      extra: { serverUrl: `${base}/mcp`, tokenEndpoint: `${base}/token`, clientId: 'new-client' }
    }),
    // The refresh of the OLD sign-in, still in flight when the new one lands.
    refresh: () =>
      new Promise((resolve) => {
        release = () =>
          resolve({ access: 'STALE-RESULT', refresh: 'ROTATED-OLD', expiresAt: future, account: 'srv' })
      })
  }
  const pending = m.resolveOAuthAccess('race1', { mcp: slow })
  await new Promise((r) => setTimeout(r, 30))
  await m.oauthSignIn(draft('race1'), { mcp: slow })
  release()
  assert.equal(await pending, 'NEW-ACCESS', 'the caller gets the newer sign-in')
  const stored = diskEntry('race1').data
  assert.equal(stored.refresh, 'NEW-REFRESH')
  assert.equal(stored.access, 'NEW-ACCESS')
  assert.equal(stored.clientId, 'new-client')
})

test('a revoked token seen by a superseded refresh neither signs the new sign-in out nor fails the caller', async () => {
  seed([storedMcp('race2', { refresh: 'OLD-REFRESH' })])
  let fail
  const p = {
    id: 'mcp',
    authorize: async () => ({ access: 'NEW', refresh: 'NEW-REFRESH', expiresAt: future, account: 'srv', extra: {} }),
    refresh: () =>
      new Promise((_, reject) => {
        fail = () => reject(new m.OAuthFlowError('revoked', 'invalid_grant'))
      })
  }
  const pending = m.resolveOAuthAccess('race2', { mcp: p })
  await new Promise((r) => setTimeout(r, 30))
  await m.oauthSignIn(draft('race2'), { mcp: p })
  fail()
  // The old token died, but it is not the stored one any more: the caller gets
  // the newer sign-in, not a spurious "signed out".
  assert.equal(await pending, 'NEW')
  assert.equal(diskEntry('race2').data.signedOut, undefined, 'the new sign-in stays signed in')
  assert.equal(diskEntry('race2').data.refresh, 'NEW-REFRESH')
})

test('a transient refresh failure does not sign the entry out', async () => {
  resetMock({ refreshFails: 'temporarily_unavailable' })
  seed([storedMcp('so2')])
  await assert.rejects(m.resolveOAuthAccess('so2', { mcp: m.createMcpProvider() }), /token refresh failed/)
  assert.equal(diskEntry('so2').data.signedOut, undefined)
})

// --- composing the header; the refresh token stays home -------------------

const mcpHeaderEntry = (url = `${base}/mcp`) => ({
  id: 'srv',
  url,
  headers: [{ name: 'Authorization', value: { credentialId: 'h1', prefix: 'Bearer ' } }]
})

test('the access token composes into the header; the refresh token is in no scope', () => {
  const creds = [storedMcp('h1', { access: 'LIVE-ACCESS', refresh: 'REFRESH-NEVER-LEAVES', expiresAt: future })]
  const plan = m.planProxy({
    sessionId: 's1',
    token: 'proxytoken',
    selection: [{ id: 'srv' }],
    registry: [mcpHeaderEntry()],
    credentials: creds,
    hostMcpUrl: 'http://host.docker.internal:1/mcp/t'
  })
  assert.deepEqual(plan.config.mcp.srv.headers, [{ name: 'Authorization', value: 'Bearer LIVE-ACCESS' }])
  assert.ok(!JSON.stringify(plan).includes('REFRESH-NEVER-LEAVES'), '§9.6: only credentials.json holds it')
})

test('a sign-in is never sent to a different server than the one it was made for', () => {
  const creds = [storedMcp('h1', { access: 'LIVE-ACCESS', expiresAt: future })]
  const ok = m.resolveMcpHeaders(creds, mcpHeaderEntry(`${base}/mcp/`.replace(/\/$/, '')))
  assert.equal(ok.error, undefined)
  const other = m.resolveMcpHeaders(creds, mcpHeaderEntry('https://evil.example/mcp'))
  assert.match(other.error, /is signed in to .*\/mcp, not https:\/\/evil\.example\/mcp — sign in again/)
  assert.equal(other.headers, undefined)
  // A pasted-key credential has no binding and is unaffected.
  const tok = [{ id: 'h1', label: 'pat', kind: 'mcp-token', hosts: [], data: { secret: 'sk-x' } }]
  assert.equal(m.resolveMcpHeaders(tok, mcpHeaderEntry('https://evil.example/mcp')).error, undefined)
})

test('a server-bound sign-in is not given to a local server either', () => {
  const creds = [storedMcp('h1', { access: 'LIVE-ACCESS', expiresAt: future })]
  const local = { kind: 'command', id: 'loc', command: 'x', env: { TOKEN: { credentialId: 'h1' } } }
  const out = m.resolveMcpSecretEnv(creds, local)
  assert.match(out.error, /is a sign-in to .* and cannot be given to a local server/)
  assert.equal(out.env, undefined)
  // An unbound credential (the agent providers' kind of entry, a pasted token) is unaffected.
  const tok = [{ id: 'h1', label: 'pat', kind: 'mcp-token', hosts: [], data: { secret: 'sk-x' } }]
  assert.deepEqual(m.resolveMcpSecretEnv(tok, local).env, { TOKEN: 'sk-x' })
})

test('an MCP server\'s sign-in is never an agent credential', () => {
  const mcpSignIn = storedMcp('ag1', { access: 'MCP-ACCESS', expiresAt: future })
  const agentSignIn = { id: 'ag2', label: 'claude', kind: 'oauth', hosts: [], data: { providerId: 'anthropic', access: 'A', refresh: 'R' } }
  const pat = { id: 'ag3', label: 'key', kind: 'agent-token', hosts: [], data: { secret: 'sk-x' } }
  assert.equal(m.isMcpSignIn(mcpSignIn), true)
  assert.equal(m.isMcpSignIn(agentSignIn), false)
  // Not offered in the Agents editor…
  assert.deepEqual(m.agentCredentials([mcpSignIn, agentSignIn, pat]).map((c) => c.id), ['ag2', 'ag3'])
  // …and refused at launch if a link to it exists anyway (a stale selection).
  const r = m.resolveAgentSecret([mcpSignIn], 'ag1')
  assert.equal(r.secret, '')
  assert.match(r.error, /is a sign-in to an MCP server, not an agent credential/)
  assert.equal(m.resolveAgentSecret([agentSignIn], 'ag2').error, undefined)
})

test('a remote server cannot aim discovery at loopback services on this machine', async () => {
  /** @type {string[]} */
  const seen = []
  const jsonRes = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  const fakeFetch = (probeHeader, prm, as) => async (url, init) => {
    seen.push(String(url))
    const u = new URL(String(url))
    if (u.pathname === '/mcp' && init?.method === 'POST')
      return new Response(null, { status: 401, headers: { 'www-authenticate': probeHeader } })
    if (u.pathname.includes('oauth-protected-resource')) return jsonRes(prm)
    if (u.pathname.includes('oauth-authorization-server') || u.pathname.includes('openid-configuration'))
      return as ? jsonRes(as) : new Response(null, { status: 404 })
    return new Response(null, { status: 404 })
  }
  // 1: the challenge's metadata URL points at loopback — never fetched.
  seen.length = 0
  await assert.rejects(
    m.discoverMcpOAuth('https://mcp.remote.example/mcp', {
      fetch: fakeFetch('Bearer resource_metadata="http://127.0.0.1:9/x"', {})
    })
  )
  assert.ok(!seen.some((u) => u.includes('127.0.0.1')), `no request to loopback: ${seen}`)
  // 2: the authorization server it names is loopback — not accepted.
  seen.length = 0
  await assert.rejects(
    m.discoverMcpOAuth('https://mcp.remote.example/mcp', {
      fetch: fakeFetch('Bearer realm="x"', {
        resource: 'https://mcp.remote.example/mcp',
        authorization_servers: ['http://localhost:9']
      })
    }),
    /points at this machine/
  )
  assert.ok(!seen.some((u) => u.includes('localhost')), `no request to loopback: ${seen}`)
  // The address is judged before the scheme: https is no way round it.
  for (const as of ['https://localhost:9', 'https://127.0.0.1:9', 'https://[::1]:9', 'https://x.localhost']) {
    seen.length = 0
    await assert.rejects(
      m.discoverMcpOAuth('https://mcp.remote.example/mcp', {
        fetch: fakeFetch('Bearer realm="x"', {
          resource: 'https://mcp.remote.example/mcp',
          authorization_servers: [as]
        })
      }),
      /points at this machine/,
      as
    )
    assert.ok(seen.every((u) => u.startsWith('https://mcp.remote.example')), `${as}: ${seen}`)
  }
  // 3: a loopback endpoint inside an https server's AS metadata — refused.
  await assert.rejects(
    m.discoverMcpOAuth('https://mcp.remote.example/mcp', {
      fetch: fakeFetch(
        'Bearer realm="x"',
        { resource: 'https://mcp.remote.example/mcp', authorization_servers: ['https://as.remote.example'] },
        {
          issuer: 'https://as.remote.example',
          authorization_endpoint: 'https://as.remote.example/a',
          token_endpoint: 'https://as.remote.example/t',
          registration_endpoint: 'http://127.0.0.1:9/register',
          code_challenge_methods_supported: ['S256']
        }
      )
    }),
    /registration_endpoint points at this machine/
  )
})

test('a redirect cannot carry discovery to cleartext or to this machine', async () => {
  const res = (status, location) => new Response(null, { status, headers: location ? { location } : {} })
  const prmBody = { resource: 'https://mcp.remote.example/mcp', authorization_servers: ['https://as.remote.example'] }
  /** @type {string[]} */
  const seen = []
  const mk = (redirectTo) => async (url, init) => {
    seen.push(`${init?.method ?? 'GET'} ${url} redirect=${init?.redirect}`)
    const u = new URL(String(url))
    if (u.pathname === '/mcp') return res(401)
    if (u.host === 'mcp.remote.example' && u.pathname.includes('oauth-protected-resource') && !seen.some((x) => x.includes('/hop')))
      return res(302, redirectTo)
    if (u.pathname === '/hop') return new Response(JSON.stringify(prmBody), { status: 200 })
    return res(404)
  }
  for (const target of ['http://insecure.example/hop', 'https://localhost:9/hop', 'http://127.0.0.1:9/hop']) {
    seen.length = 0
    await assert.rejects(m.discoverMcpOAuth('https://mcp.remote.example/mcp', { fetch: mk(target) }), /no OAuth protected-resource metadata|not following it/, target)
    assert.ok(!seen.some((x) => x.includes('/hop')), `${target} was not followed: ${seen}`)
    assert.ok(seen.every((x) => x.endsWith('redirect=manual')), 'redirects are never left to fetch')
  }
  // A redirect to another https host is followed, and validated each hop.
  seen.length = 0
  const ok = await m
    .discoverMcpOAuth('https://mcp.remote.example/mcp', { fetch: mk('https://mcp.remote.example/hop') })
    .catch((e) => e)
  assert.ok(seen.some((x) => x.includes('/hop')), 'an https hop to the same host is followed')
  assert.ok(ok instanceof Error, 'and discovery then needs AS metadata, which this stub lacks')
})

test('the token endpoint is never followed through a redirect (exchange and refresh)', async () => {
  resetMock({ tokenRedirect: true })
  seed([storedMcp('rd1')])
  await assert.rejects(m.resolveOAuthAccess('rd1', { mcp: m.createMcpProvider() }), /redirect — not following it/)
  assert.equal(log.token.length, 1, 'only the original endpoint saw the refresh token')
  assert.equal(log.redirected.length, 0, 'the redirect target was never contacted')
  // A stored endpoint that points at this machine from a remote server is refused outright.
  seed([storedMcp('rd2', { serverUrl: 'https://mcp.remote.example/mcp', tokenEndpoint: 'https://localhost:9/token' })])
  await assert.rejects(
    m.resolveOAuthAccess('rd2', { mcp: m.createMcpProvider() }),
    /token endpoint of this sign-in points at this machine/
  )
  seed([storedMcp('rd3', { serverUrl: 'https://mcp.remote.example/mcp', tokenEndpoint: 'http://as.remote.example/token' })])
  await assert.rejects(m.resolveOAuthAccess('rd3', { mcp: m.createMcpProvider() }), /is not https/)
})

test('canonicalMcpUrl: no fragment, bare origin without a trailing slash, path kept', () => {
  assert.equal(m.canonicalMcpUrl('https://X.example'), 'https://x.example')
  assert.equal(m.canonicalMcpUrl('https://x.example/'), 'https://x.example')
  assert.equal(m.canonicalMcpUrl('https://x.example/mcp#frag'), 'https://x.example/mcp')
  assert.equal(m.canonicalMcpUrl('https://x.example/mcp/'), 'https://x.example/mcp/')
  assert.equal(m.canonicalMcpUrl('mailto:a@b'), null)
  assert.equal(m.canonicalMcpUrl('nope'), null)
  assert.ok(m.sameMcpUrl('https://x.example/mcp#a', 'https://x.example/mcp'))
})

// --- the live-scope keeper -------------------------------------------------

/** A keeper on a manual clock: timers are recorded, fired by hand. */
function fakeKeeper({ tokens, expiry }) {
  const timers = new Map()
  let nextHandle = 1
  let nowMs = 1_000_000
  const calls = { resolve: 0 }
  const listeners = new Set()
  const deps = {
    onStoreWrite: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    resolve: async (id) => {
      calls.resolve++
      const t = tokens[id]
      if (t instanceof Error) throw t
      return t
    },
    expiresAtMs: async (id) => expiry[id] ?? null,
    now: () => nowMs,
    setTimer: (fn, ms) => {
      const h = nextHandle++
      timers.set(h, { fn, ms })
      return h
    },
    clearTimer: (h) => timers.delete(h)
  }
  const settle = () => new Promise((r) => setImmediate(r))
  return {
    keeper: new m.ScopeKeeper(deps),
    listeners,
    // A credential-store write: the keeper coalesces it behind a 250 ms timer.
    writeStore: async () => {
      for (const fn of [...listeners]) fn()
      for (const [h, t] of [...timers]) {
        if (t.ms !== 250) continue
        timers.delete(h)
        t.fn()
      }
      await settle()
      await settle()
      await settle()
    },
    timers,
    calls,
    settle,
    fireAll: async () => {
      for (const [h, t] of [...timers]) {
        timers.delete(h)
        t.fn()
      }
      await settle()
      await settle()
    }
  }
}

test('keeper: renews ahead of expiry and pushes only a changed token', async () => {
  const exp = 1_000_000 + 3_600_000
  const tokens = { c1: 'T1' }
  const f = fakeKeeper({ tokens, expiry: { c1: exp } })
  let rebuilds = 0
  f.keeper.watch('sess', ['c1'], { rebuild: async () => void rebuilds++ }, { c1: 'T1' })
  await f.settle()
  assert.equal(f.timers.size, 1)
  // Fires when the 5-minute refresh window has just opened.
  const [{ ms }] = [...f.timers.values()]
  assert.equal(ms, 3_600_000 - 5 * 60_000 + 5_000)

  // Nothing changed (the cap-hit re-check): no push.
  await f.fireAll()
  assert.equal(rebuilds, 0)
  assert.equal(f.timers.size, 1, 're-armed')

  // The token was refreshed (by us or another session): one push.
  tokens.c1 = 'T2'
  await f.fireAll()
  assert.equal(rebuilds, 1)
  await f.fireAll()
  assert.equal(rebuilds, 1, 'the same token is not pushed twice')
})

test('keeper: a token that changed between the push and the watch is pushed at once', async () => {
  // The scope was composed with T1; another session refreshed to T2 before the
  // keeper armed. The proxy holds T1, so waiting for T2's timer would leave it
  // on a dying token — arming must push now.
  const f = fakeKeeper({ tokens: { c1: 'T2' }, expiry: { c1: 1_000_000 + 3_600_000 } })
  let rebuilds = 0
  f.keeper.watch('sess', ['c1'], { rebuild: async () => void rebuilds++ }, { c1: 'T1' })
  await f.settle()
  await f.settle()
  assert.equal(rebuilds, 1, 'rebuilt without waiting for a timer')
  assert.equal(f.timers.size, 1, 'then armed on the normal schedule')
  await f.fireAll()
  assert.equal(rebuilds, 1, 'and T2 is not pushed twice')
})

test('keeper: a baseline equal to the store pushes nothing on arming', async () => {
  const f = fakeKeeper({ tokens: { c1: 'T1' }, expiry: { c1: 1_000_000 + 3_600_000 } })
  let rebuilds = 0
  f.keeper.watch('sess', ['c1'], { rebuild: async () => void rebuilds++ }, { c1: 'T1' })
  await f.settle()
  assert.equal(rebuilds, 0)
})

test('keeper: unwatch clears timers and a late rebuild sees isCurrent() false', async () => {
  const tokens = { c1: 'T1' }
  const f = fakeKeeper({ tokens, expiry: { c1: 1_000_000 + 3_600_000 } })
  let sawCurrent = null
  let release
  f.keeper.watch('sess', ['c1'], {
    rebuild: async (isCurrent) => {
      await new Promise((r) => (release = r))
      sawCurrent = isCurrent()
    }
  }, { c1: 'T1' })
  await f.settle()
  tokens.c1 = 'T2'
  await f.fireAll() // rebuild now in flight
  f.keeper.unwatch('sess')
  release()
  await f.settle()
  assert.equal(sawCurrent, false, 'a stopped session must not get its scope rewritten')
  assert.equal(f.timers.size, 0)
  assert.deepEqual(f.keeper.watching(), [])
})

test('keeper: a failed renewal is retried, said once, and a rebuild failure retries too', async () => {
  /** @type {Record<string, any>} */
  const tokens = { c1: 'T1' }
  const f = fakeKeeper({ tokens, expiry: { c1: 1_000_000 + 3_600_000 } })
  const problems = []
  let rebuilds = 0
  let failRebuild = true
  f.keeper.watch('sess', ['c1'], {
    rebuild: async () => {
      rebuilds++
      if (failRebuild) throw new Error('scope push failed')
    },
    onProblem: (msg) => problems.push(msg)
  }, { c1: 'T1' })
  await f.settle()
  tokens.c1 = new Error('token refresh failed — offline')
  await f.fireAll()
  assert.equal(f.timers.size, 1, 'a blip is retried')
  const [{ ms: retry1 }] = [...f.timers.values()]
  assert.equal(retry1, 60_000)
  await f.fireAll()
  const [{ ms: retry2 }] = [...f.timers.values()]
  assert.equal(retry2, 120_000, 'backs off')
  assert.deepEqual(problems, ['token refresh failed — offline'], 'one message per streak')

  tokens.c1 = 'T2'
  await f.fireAll() // resolves, rebuild throws -> retried
  assert.equal(rebuilds, 1)
  assert.equal(f.timers.size, 1)
  failRebuild = false
  await f.fireAll()
  assert.equal(rebuilds, 2)
  // Recovered: re-armed on the normal schedule, not a retry.
  const [{ ms: normal }] = [...f.timers.values()]
  assert.ok(normal > 600_000)
})

test('keeper: a signed-out entry is parked, then picked up when the store is written', async () => {
  /** @type {Record<string, any>} */
  const tokens = { c1: 'T1' }
  const f = fakeKeeper({ tokens, expiry: { c1: 1_000_000 + 3_600_000 } })
  const problems = []
  const rebuilt = []
  f.keeper.watch(
    'sess',
    ['c1'],
    {
      rebuild: async (_isCurrent, id) => void rebuilt.push(id),
      onProblem: (msg) => problems.push(msg)
    },
    { c1: 'T1' }
  )
  await f.settle()
  assert.equal(f.listeners.size, 1, 'subscribed to store writes while a session is watched')
  tokens.c1 = new m.SignedOutError('credential "x" is signed out — sign in again in Credentials')
  await f.fireAll()
  assert.deepEqual(problems, ['credential "x" is signed out — sign in again in Credentials'])
  // Parked: no timer, no polling — the store subscription is what wakes it.
  assert.equal(f.timers.size, 0)
  assert.equal(f.listeners.size, 1)
  // An unrelated write re-checks it, finds it still signed out, parks it again,
  // says nothing more.
  await f.writeStore()
  assert.equal(f.listeners.size, 1)
  assert.equal(problems.length, 1, 'said once per streak')
  assert.deepEqual(rebuilt, [])
  // The user signs in again: that write finds a new token and pushes it.
  tokens.c1 = 'T-NEW'
  await f.writeStore()
  assert.deepEqual(rebuilt, ['c1'], 'rebuild is told which entry it is renewing')
  assert.equal(f.timers.size, 1, 're-armed on the normal schedule')
  f.keeper.unwatch('sess')
  assert.equal(f.listeners.size, 0, 'nothing watched: unsubscribed')
})

test('keeper: unwatching the last session drops the store subscription', async () => {
  /** @type {Record<string, any>} */
  const tokens = { c1: 'T1' }
  const f = fakeKeeper({ tokens, expiry: { c1: 1_000_000 + 3_600_000 } })
  f.keeper.watch('sess', ['c1'], { rebuild: async () => {} }, { c1: 'T1' })
  await f.settle()
  tokens.c1 = new m.SignedOutError('signed out')
  await f.fireAll()
  assert.equal(f.listeners.size, 1)
  f.keeper.watch('other', ['c1'], { rebuild: async () => {} }, { c1: 'T1' })
  f.keeper.unwatch('sess')
  assert.equal(f.listeners.size, 1, 'another session still watches')
  f.keeper.unwatch('other')
  assert.equal(f.listeners.size, 0)
})

test('keeper: a re-authentication while the token is still fresh reaches the running scope', async () => {
  // Signed in with hours left; the user re-authenticates in the editor, which
  // replaces the access token (and may revoke the old grant). The proxy must
  // not keep the old token until the old timer.
  /** @type {Record<string, any>} */
  const tokens = { c1: 'T1' }
  const f = fakeKeeper({ tokens, expiry: { c1: 1_000_000 + 3_600_000 } })
  const rebuilt = []
  f.keeper.watch('sess', ['c1'], { rebuild: async (_ok, id) => void rebuilt.push(id) }, { c1: 'T1' })
  await f.settle()
  assert.deepEqual(rebuilt, [])
  tokens.c1 = 'T-REAUTH'
  await f.writeStore()
  assert.deepEqual(rebuilt, ['c1'], 'pushed promptly, not at the old expiry window')
  // A burst of writes is one recheck; an unchanged token is not pushed again.
  await f.writeStore()
  await f.writeStore()
  assert.deepEqual(rebuilt, ['c1'])
  assert.equal(f.timers.size, 1)
})

test('keeper: a watch that starts signed out parks at once and picks up the sign-in', async () => {
  // Expiry still in the future, but the entry is signed out (revoked): the
  // initial check must park it, not schedule from the expiry and miss the
  // sign-in until that timer.
  /** @type {Record<string, any>} */
  const tokens = { c1: new m.SignedOutError('credential "x" is signed out — sign in again in Credentials') }
  const f = fakeKeeper({ tokens, expiry: { c1: 1_000_000 + 3_600_000 } })
  const problems = []
  const rebuilt = []
  f.keeper.watch(
    'sess',
    ['c1'],
    { rebuild: async (_ok, id) => void rebuilt.push(id), onProblem: (msg) => problems.push(msg) },
    { c1: 'STALE' }
  )
  await f.settle()
  await f.settle()
  assert.equal(f.timers.size, 0, 'no timer scheduled from the future expiry')
  assert.deepEqual(problems, [], 'the attach already reported it; not said twice')
  tokens.c1 = 'T-NEW'
  await f.writeStore()
  assert.deepEqual(rebuilt, ['c1'])
})

test('keeper: an entry whose route was left out of the scope is pushed once it resolves', async () => {
  const f = fakeKeeper({ tokens: { c1: 'T1' }, expiry: { c1: 1_000_000 + 3_600_000 } })
  const rebuilt = []
  f.keeper.watch('sess', ['c1'], { rebuild: async (_ok, id) => void rebuilt.push(id) }, {})
  await f.settle()
  await f.settle()
  assert.deepEqual(rebuilt, ['c1'])
})

test('keeper: nothing is watched without an oauth entry, and a re-watch replaces', async () => {
  const f = fakeKeeper({ tokens: { c1: 'T' }, expiry: { c1: 1_000_000 + 3_600_000 } })
  f.keeper.watch('plain', [], { rebuild: async () => {} }, {})
  assert.deepEqual(f.keeper.watching(), [])
  f.keeper.watch('sess', ['c1', 'c1'], { rebuild: async () => {} }, { c1: 'T' })
  await f.settle()
  assert.equal(f.timers.size, 1, 'one timer per entry')
  f.keeper.watch('sess', ['c1'], { rebuild: async () => {} }, { c1: 'T' })
  await f.settle()
  assert.equal(f.timers.size, 1, 'the earlier watch was dropped')
})

test('renewalDelay: never past the token\'s life, never a hot loop', () => {
  const SKEW = 5 * 60_000
  // Long-lived: when the refresh window has just opened.
  assert.equal(m.renewalDelay(3_600_000), 3_600_000 - SKEW + 5_000)
  // Shorter than the skew: inside the window from birth, so half the life.
  assert.equal(m.renewalDelay(60_000), 30_000)
  assert.equal(m.renewalDelay(200_000), 100_000)
  // A few seconds: the floor guards the loop, and still lands before expiry.
  assert.equal(m.renewalDelay(10_000), 5_000)
  assert.equal(m.renewalDelay(0), 5_000)
  assert.equal(m.renewalDelay(-1_000), 5_000)
  for (const life of [10_000, 20_000, 60_000, 120_000, 299_000, 301_000, 600_000, 3_600_000])
    assert.ok(m.renewalDelay(life) <= life - 5_000, `${life} ms token renewed with margin`)
})

// The scope the proxy holds must be valid at every moment of a long session,
// whatever the token lifetime — simulated on a manual clock against a token
// service that rotates on every refresh and only refreshes inside the skew.
for (const lifetime of [10_000, 60_000, 200_000, 3_600_000]) {
  test(`keeper keeps the pushed token valid across a ${lifetime / 1000}s token lifetime`, async () => {
    const SKEW = 5 * 60_000
    let now = 1_000_000
    let seq = 0
    let current = { token: 'T0', exp: now + lifetime }
    const expiryOf = new Map([['T0', current.exp]])
    const timers = new Map()
    let handle = 1
    const pushes = [{ at: now, token: 'T0' }]
    const keeper = new m.ScopeKeeper({
      // The store: stale (inside the skew) -> refresh, else read.
      resolve: async () => {
        if (current.exp - now <= SKEW) {
          const token = `T${++seq}`
          current = { token, exp: now + lifetime }
          expiryOf.set(token, current.exp)
        }
        return current.token
      },
      expiresAtMs: async () => current.exp,
      now: () => now,
      setTimer: (fn, ms) => {
        const h = handle++
        timers.set(h, { fn, at: now + ms })
        return h
      },
      clearTimer: (h) => timers.delete(h),
      onStoreWrite: () => () => {}
    })
    keeper.watch(
      'sess',
      ['c1'],
      { rebuild: async () => void pushes.push({ at: now, token: current.token }) },
      { c1: 'T0' }
    )
    const tick = () => new Promise((r) => setImmediate(r))
    await tick()
    // arm() resolves once, which already refreshed a token shorter than the skew
    // and pushed it; what matters is validity from here on.
    let held = pushes[pushes.length - 1].token
    const horizon = now + 3 * 3_600_000
    let guard = 0
    while (now < horizon && guard++ < 5_000) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      assert.ok(next, 'always something scheduled')
      const [h, t] = next
      // The token the proxy holds must still be valid when the next renewal fires.
      assert.ok(t.at < expiryOf.get(held), `renewal at ${t.at} lands before ${held} expires at ${expiryOf.get(held)}`)
      now = t.at
      timers.delete(h)
      t.fn()
      await tick()
      await tick()
      held = pushes[pushes.length - 1].token
    }
    assert.ok(pushes.length > 1, 'it did renew')
  })
}

test('a signed-out credential keeps its binding: another URL must not reuse it', () => {
  // Shared by two registry entries, signed out. The editor reuses a credential
  // only while the URL matches, whether or not it is signed in.
  const signedOutShared = storedMcp('shared', { refresh: '', signedOut: 'true', serverUrl: 'https://a.example/mcp' })
  assert.equal(m.oauthBoundElsewhere(signedOutShared, 'https://b.example/mcp'), true)
  assert.equal(m.oauthBoundElsewhere(signedOutShared, 'https://a.example/mcp#x'), false)
  const signedIn = storedMcp('shared2', { serverUrl: 'https://a.example/mcp' })
  assert.equal(m.oauthBoundElsewhere(signedIn, 'https://b.example/mcp'), true)
  // Not an mcp-bound credential at all.
  const tok = { id: 't', label: 't', kind: 'mcp-token', hosts: [], data: { secret: 'x' } }
  assert.equal(m.oauthBoundElsewhere(tok, 'https://b.example/mcp'), false)
  assert.equal(m.oauthBoundElsewhere({ ...signedIn, data: { providerId: 'anthropic' } }, 'https://b.example/mcp'), false)
})

// R1.F1: store-write notifications + a token shorter than the skew. Every
// resolve of such a token refreshes and persists; if a notification re-resolved,
// the keeper would chase its own writes. A store write is only *peeked*.
test('keeper: refresh-generated store notifications do not trigger further refreshes', async () => {
  let now = 1_000_000
  let seq = 0
  let refreshes = 0
  let current = { token: 'T0', exp: now + 60_000 }
  const timers = new Map()
  let handle = 1
  const listeners = new Set()
  const notify = () => listeners.forEach((fn) => fn())
  const keeper = new m.ScopeKeeper({
    resolve: async () => {
      if (current.exp - now <= 5 * 60_000) {
        refreshes++
        current = { token: `T${++seq}`, exp: now + 60_000 }
        notify() // the persist is a credential-store write
      }
      return current.token
    },
    peek: async () => (current.exp > now ? current.token : null),
    expiresAtMs: async () => current.exp,
    now: () => now,
    setTimer: (fn, ms) => (timers.set(handle, { fn, at: now + ms }), handle++),
    clearTimer: (h) => timers.delete(h),
    onStoreWrite: (fn) => (listeners.add(fn), () => listeners.delete(fn))
  })
  let rebuilds = 0
  keeper.watch(
    'sess',
    ['c1'],
    { rebuild: async (_ok, _id, token) => void (rebuilds++, assert.equal(token, current.token)) },
    { c1: 'T0' }
  )
  const tick = () => new Promise((r) => setImmediate(r))
  // Run 10 minutes of the manual clock, firing timers in order.
  const horizon = now + 10 * 60_000
  let guard = 0
  await tick()
  while (guard++ < 500) {
    const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (!next || next[1].at > horizon) break
    now = next[1].at
    timers.delete(next[0])
    next[1].fn()
    for (let i = 0; i < 4; i++) await tick()
  }
  assert.ok(guard < 500, 'no runaway loop')
  // Renewals follow renewalDelay (>= 5 s apart, ~30 s for a 60 s token): a 10
  // minute horizon allows ~20, never the hundreds a feedback loop produces.
  assert.ok(refreshes <= 25, `refreshes bounded by the renewal schedule (got ${refreshes})`)
  assert.ok(rebuilds <= refreshes, 'one rebuild per token at most')
  keeper.unwatch('sess')
})

// R1.F2: cancelled while the code exchange was in flight -> nothing is stored.
test('oauthSignIn: an attempt cancelled during the token exchange stores nothing', async () => {
  resetMock()
  seed([])
  let release
  const gate = new Promise((r) => (release = r))
  const provider = {
    id: 'mcp',
    authorize: async () => {
      await gate // the callback has arrived; the token response is still out
      return { access: 'A', refresh: 'R', expiresAt: new Date(Date.now() + 3600_000).toISOString(), account: '', extra: {} }
    },
    refresh: async () => {
      throw new Error('unused')
    }
  }
  const p = m.oauthSignIn(draft('late1'), { mcp: provider })
  const settled = assert.rejects(p, /cancelled/)
  m.cancelOAuthSignIn('late1')
  release()
  await settled
  assert.equal(diskEntry('late1'), undefined, 'no credential persisted for the abandoned attempt')
})

// R1.F1 (round 2): a token endpoint that answers and then stalls.
test('Cancel ends a code exchange stalled in the token body', async () => {
  resetMock({ tokenStall: 'authorization_code' })
  const ctl = new AbortController()
  const provider = m.createMcpProvider({ open: browser() })
  const started = Date.now()
  const p = provider.authorize(ctl.signal, { data: { serverUrl: `${base}/mcp` } })
  const settled = assert.rejects(p, /cancelled/)
  // Wait until the exchange is on the wire (the mock logged the grant), then cancel.
  while (!log.token.some((f) => f.grant_type === 'authorization_code')) await new Promise((r) => setTimeout(r, 10))
  await new Promise((r) => setTimeout(r, 50))
  ctl.abort()
  await settled
  assert.ok(Date.now() - started < 5_000, 'did not wait out any deadline')
})

test('a stalled refresh times out, frees the single-flight, and a retry succeeds', async () => {
  resetMock({ tokenStall: 'refresh_token' })
  seed([storedMcp('stall1', { expiresAt: new Date(Date.now() - 1000).toISOString() })])
  const provider = m.createMcpProvider({ tokenTimeoutMs: 300 })
  await assert.rejects(m.resolveOAuthAccess('stall1', { mcp: provider }), /did not answer the token request in time/)
  assert.equal(diskEntry('stall1').data.signedOut, undefined, 'a stall signs nothing out')
  delete cfg.tokenStall
  const access = await m.resolveOAuthAccess('stall1', { mcp: provider })
  assert.match(access, /^ACCESS-R/)
})
