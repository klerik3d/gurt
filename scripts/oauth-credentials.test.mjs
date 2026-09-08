// OAuth credential resolution (docs/requirements-oauth-credentials.md §9):
// single-flight refresh with the rotated token persisted before any caller
// proceeds (§9.4), the signed-out blocking sentence (§9.5), redaction the
// moment a token exists (§9.3), the read-modify-write save chain (§5.3), an
// unknown-kind entry surviving the new write paths (§9.2), the pure resolvers
// accepting the kind, the per-agent-kind delivery of §5.2.1 (the composed
// codex/gemini auth files, access-only, and the null that keeps every other
// path on the env var), the openai provider extras (§2), and — with a stub
// keystore — the token set landing under `sealed` with the renderer seeing
// only masks (§9.3).
//
//   node scripts/oauth-credentials.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-oauth-credentials-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

// store.ts reads GURT_ROOT at module load — set it before the import.
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-oauth-'))
process.env.GURT_ROOT = GURT_ROOT
// No keystore outside real Electron: credential writes stay plaintext here.
// The sealing tests at the bottom import a second bundle next to a stub
// electron module and clear this flag first.
process.env.GURT_FORCE_PLAINTEXT = '1'

const ENTRY = `
export {
  resolveOAuthAccess, freshenOAuthCredentials, oauthSignIn, cancelOAuthSignIn
} from ${S('src/main/oauth/index.ts')}
export { OAuthFlowError } from ${S('src/main/oauth/flow.ts')}
export { oauthAuthFile } from ${S('src/main/oauth/materialize.ts')}
export { openaiExtraData } from ${S('src/main/oauth/providers/openai.ts')}
export {
  getCredentials, setCredentials, listCredentials, patchCredentialData, upsertCredentialEntry
} from ${S('src/main/credentials.ts')}
export {
  resolveAgentSecret, resolveMcpCredential, resolveMcpEnvSecret,
  agentCredentials, mcpCredentials, signedOutError
} from ${S('src/shared/credentials.ts')}
export { planProxy } from ${S('src/main/proxy/config.ts')}
export { redact } from ${S('src/main/redact.ts')}
`

await bundle({
  stdin: { contents: ENTRY, resolveDir: ROOT, loader: 'ts', sourcefile: 'entry.ts' },
  external: ['electron'],
  outfile
})
const m = await import(pathToFileURL(outfile).href)

const credsPath = path.join(GURT_ROOT, 'credentials.json')
const readDisk = () => JSON.parse(fs.readFileSync(credsPath, 'utf8'))
const diskEntry = (id) => readDisk().credentials.find((c) => c.id === id)

/** Seed credentials.json directly — the §8.1 "token set placed by hand" path. */
const seed = (credentials) =>
  fs.writeFileSync(credsPath, JSON.stringify({ version: 2, credentials }, null, 2))

const HOUR = 3_600_000
const past = new Date(Date.now() - HOUR).toISOString()
const future = new Date(Date.now() + HOUR).toISOString()

const oauthEntry = (id, data) => ({
  id,
  label: `oauth ${id}`,
  kind: 'oauth',
  hosts: [],
  data: { providerId: 'fake', account: 'jane@example.com', ...data }
})

/** A provider that counts refresh() calls and rotates both tokens. */
function fakeProvider({ fail = null, delayMs = 25 } = {}) {
  const provider = {
    id: 'fake',
    calls: 0,
    authorize: () => Promise.reject(new Error('not under test')),
    refresh: async (current) => {
      provider.calls++
      await new Promise((r) => setTimeout(r, delayMs))
      if (fail) throw fail
      return {
        access: `ACCESS-${provider.calls}-${current.access}`,
        refresh: `ROTATED-${provider.calls}`,
        expiresAt: future,
        account: current.account
      }
    }
  }
  return provider
}

after(() => {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

// --- §9.4: single-flight, rotated token on disk before either caller proceeds ---
test('two concurrent resolves produce exactly one refresh, persisted first', async () => {
  seed([oauthEntry('sf', { access: 'STALE', refresh: 'OLD-REFRESH', expiresAt: past })])
  const provider = fakeProvider()
  const providers = { fake: provider }
  // What the file held at the exact moment each resolver was handed its token.
  const persistedAt = []
  const observe = (p) =>
    p.then((access) => {
      persistedAt.push(diskEntry('sf').data.refresh)
      return access
    })
  const [a, b] = await Promise.all([
    observe(m.resolveOAuthAccess('sf', providers)),
    observe(m.resolveOAuthAccess('sf', providers))
  ])
  assert.equal(provider.calls, 1, 'concurrent resolvers must share one refresh()')
  assert.equal(a, b, 'both callers get the same fresh token')
  assert.equal(a, 'ACCESS-1-STALE')
  for (const refresh of persistedAt)
    assert.equal(refresh, 'ROTATED-1', 'rotated refresh token on disk before a caller proceeds')
  assert.equal(diskEntry('sf').data.access, 'ACCESS-1-STALE')
  assert.equal(diskEntry('sf').data.expiresAt, future)
  // A later resolve sees the fresh token and does not refresh again.
  assert.equal(await m.resolveOAuthAccess('sf', providers), 'ACCESS-1-STALE')
  assert.equal(provider.calls, 1)
})

test('freshenOAuthCredentials rides the same single flight', async () => {
  seed([
    oauthEntry('fr', { access: 'STALE', refresh: 'OLD', expiresAt: past }),
    { id: 'tok', label: 'pat', kind: 'agent-token', hosts: [], data: { secret: 'sk-plain' } }
  ])
  const provider = fakeProvider()
  const providers = { fake: provider }
  const [one, two] = await Promise.all([
    m.freshenOAuthCredentials(await m.listCredentials(), ['fr'], providers),
    m.freshenOAuthCredentials(await m.listCredentials(), ['fr', undefined], providers)
  ])
  assert.equal(provider.calls, 1)
  for (const { credentials, errors } of [one, two]) {
    assert.deepEqual(errors, {})
    assert.equal(credentials.find((c) => c.id === 'fr').data.access, 'ACCESS-1-STALE')
    // Non-oauth entries pass through untouched.
    assert.equal(credentials.find((c) => c.id === 'tok').data.secret, 'sk-plain')
  }
})

// --- §9.3 (redaction half): tokens are redactable the moment refresh returns ---
test('a live token fed to a log line prints [redacted]', () => {
  // ACCESS-1-STALE / ROTATED-1 entered addSecrets inside the refresh above.
  assert.equal(m.redact('injecting ACCESS-1-STALE now'), 'injecting [redacted] now')
  assert.equal(m.redact('rotated to ROTATED-1'), 'rotated to [redacted]')
  const b64 = Buffer.from('ACCESS-1-STALE', 'utf8').toString('base64')
  assert.ok(!m.redact(`b64 ${b64}`).includes(b64), 'base64 form redacted too')
})

// --- §9.5: signed-out blocks with the sentence, nothing falls back ---
test('a never-signed-in entry blocks with the §2 sentence', async () => {
  seed([oauthEntry('empty', { access: '', refresh: '', expiresAt: past })])
  const provider = fakeProvider()
  await assert.rejects(m.resolveOAuthAccess('empty', { fake: provider }), {
    message: 'credential "oauth empty" is signed out — sign in again in Credentials'
  })
  assert.equal(provider.calls, 0, 'no refresh attempted without a refresh token')
})

test('invalid_grant signs the entry out, persists the marker, and blocks', async () => {
  seed([oauthEntry('dead', { access: 'STALE', refresh: 'REVOKED', expiresAt: past })])
  const provider = fakeProvider({ fail: new m.OAuthFlowError('grant revoked', 'invalid_grant') })
  await assert.rejects(m.resolveOAuthAccess('dead', { fake: provider }), {
    message: 'credential "oauth dead" is signed out — sign in again in Credentials'
  })
  assert.equal(provider.calls, 1)
  assert.equal(diskEntry('dead').data.signedOut, 'true', 'sign-out recorded for the modal')
  // The next resolve short-circuits on the marker — the dead grant is not retried.
  await assert.rejects(m.resolveOAuthAccess('dead', { fake: provider }), /is signed out/)
  assert.equal(provider.calls, 1)
})

test('a transient refresh failure blocks honestly without signing out', async () => {
  seed([oauthEntry('flaky', { access: 'STALE', refresh: 'STILL-GOOD', expiresAt: past })])
  const provider = fakeProvider({ fail: new m.OAuthFlowError('could not reach example.com') })
  await assert.rejects(m.resolveOAuthAccess('flaky', { fake: provider }), {
    message: /token refresh failed — could not reach example\.com/
  })
  const stored = diskEntry('flaky').data
  assert.equal(stored.signedOut, undefined, 'a network blip is not a sign-out')
  assert.equal(stored.refresh, 'STILL-GOOD', 'the refresh token survives')
})

// --- §5.3: the save chain is the lock — no last-write-wins either way ---
test('a refresh persist and a renderer save interleave without losing either', async () => {
  seed([oauthEntry('rmw', { access: 'STALE', refresh: 'OLD', expiresAt: past })])
  // The renderer's view: masked secrets, edited label — built BEFORE the
  // refresh starts, saved while it is in flight.
  const served = (await m.getCredentials()).credentials
  const rendererSave = served.map((c) => ({ ...c, label: 'renamed by user' }))
  const provider = fakeProvider()
  const [, access] = await Promise.all([
    m.setCredentials({ credentials: rendererSave }),
    m.resolveOAuthAccess('rmw', { fake: provider })
  ])
  assert.equal(access, 'ACCESS-1-STALE')
  const final = diskEntry('rmw')
  assert.equal(final.label, 'renamed by user', 'the renderer edit survives')
  assert.equal(final.data.refresh, 'ROTATED-1', 'the rotated token survives')
  assert.equal(final.data.access, 'ACCESS-1-STALE')
})

// --- §9.2: the new write paths cost existing and unknown entries nothing ---
test('patchCredentialData leaves every other entry alone, unknown kinds included', async () => {
  const future_kind = {
    id: 'future',
    label: 'from a newer gurt',
    kind: 'quantum-vault',
    hosts: [],
    data: { blob: 'opaque' }
  }
  seed([
    oauthEntry('keep', { access: 'A', refresh: 'R', expiresAt: future }),
    future_kind,
    { id: 'tok', label: 'pat', kind: 'agent-token', hosts: [], data: { secret: 'sk-live' } }
  ])
  await m.patchCredentialData('keep', { access: 'A2', expiresAt: future })
  const disk = readDisk()
  assert.deepEqual(
    disk.credentials.find((c) => c.id === 'future'),
    future_kind,
    'an unknown-kind entry round-trips byte-equal'
  )
  assert.equal(disk.credentials.find((c) => c.id === 'tok').data.secret, 'sk-live')
  assert.equal(diskEntry('keep').data.access, 'A2')
  await assert.rejects(m.patchCredentialData('gone', { access: 'x' }), {
    message: 'linked credential no longer exists'
  })
})

// --- the pure resolvers accept the kind (§2) ---
test('pure resolvers hand an oauth entry onward like a pasted secret', async () => {
  const signedIn = oauthEntry('in', { access: 'LIVE', refresh: 'R', expiresAt: future })
  const signedOut = oauthEntry('out', { access: '', refresh: '' })
  const creds = [signedIn, signedOut]

  const agent = m.resolveAgentSecret(creds, 'in')
  assert.equal(agent.secret, 'LIVE')
  assert.equal(agent.entry.kind, 'oauth')
  assert.equal(agent.error, undefined)
  assert.equal(m.resolveAgentSecret(creds, 'out').error, m.signedOutError(signedOut))

  const header = m.resolveMcpCredential(creds, 'in')
  assert.deepEqual(header.header, { name: 'Authorization', value: 'Bearer LIVE' })
  assert.equal(m.resolveMcpCredential(creds, 'out').error, m.signedOutError(signedOut))

  assert.equal(m.resolveMcpEnvSecret(creds, 'in').secret, 'LIVE')
  assert.equal(m.resolveMcpEnvSecret(creds, 'out').error, m.signedOutError(signedOut))

  // The link pools grow to include the kind.
  assert.deepEqual(m.agentCredentials(creds).map((c) => c.id), ['in', 'out'])
  assert.deepEqual(m.mcpCredentials(creds).map((c) => c.id), ['in', 'out'])
})

// --- planProxy: a freshen failure drops the server with the error (§2) ---
test('planProxy composes an oauth header and drops entries whose freshen failed', () => {
  const creds = [
    oauthEntry('mc', { access: 'LIVE', refresh: 'REFRESH-NEVER-LEAVES', expiresAt: future })
  ]
  const registry = [{ id: 'srv', url: 'https://mcp.example.com/mcp', credentialId: 'mc' }]
  const input = (extra) => ({
    sessionId: 's1',
    token: 'proxytoken',
    selection: [{ id: 'srv' }],
    registry,
    credentials: creds,
    hostMcpUrl: 'http://host.docker.internal:1/mcp/t',
    ...extra
  })
  const ok = m.planProxy(input({}))
  assert.deepEqual(ok.config.mcp['srv'].headers, [
    { name: 'Authorization', value: 'Bearer LIVE' }
  ])
  assert.deepEqual(ok.errors, [])
  // §9.6: only the access token rides in the scope and the descriptors — the
  // refresh token exists in credentials.json and nowhere else.
  assert.ok(
    !JSON.stringify({ config: ok.config, mcpServers: ok.mcpServers }).includes(
      'REFRESH-NEVER-LEAVES'
    ),
    'the refresh token appears in no proxy config and no descriptor'
  )

  const failed = m.planProxy(input({ credentialErrors: { mc: 'token refresh failed — offline' } }))
  assert.equal(failed.config.mcp['srv'], undefined, 'no upstream on a failed credential')
  assert.ok(!failed.mcpServers.some((s) => s.name === 'srv'), 'no descriptor either')
  assert.deepEqual(failed.errors, ['MCP server "srv": token refresh failed — offline'])
})

// --- §4: sign-in persists the set; a second attempt cancels the first ---
test('sign-in persists the token set and a second attempt cancels the first', async () => {
  // The entry exists, signed out — a successful re-auth must clear the marker.
  seed([oauthEntry('new1', { access: '', refresh: '', signedOut: 'true' })])
  let firstAborted = false
  let calls = 0
  const providers = {
    fake: {
      id: 'fake',
      refresh: () => Promise.reject(new Error('not under test')),
      authorize: (signal) =>
        new Promise((resolve, reject) => {
          // First attempt hangs until cancelled; the restarted one succeeds.
          if (++calls === 1)
            signal.addEventListener('abort', () => {
              firstAborted = true
              reject(new m.OAuthFlowError('sign-in cancelled'))
            })
          else
            resolve({
              access: 'AUTH-ACCESS',
              refresh: 'AUTH-REFRESH',
              expiresAt: future,
              account: 'jane@example.com'
            })
        })
    }
  }
  const draft = { id: 'new1', label: 'my claude', kind: 'oauth', hosts: [], data: { providerId: 'fake' } }
  const p1 = m.oauthSignIn(draft, providers)
  const p2 = m.oauthSignIn(draft, providers)
  await assert.rejects(p1, /cancelled/)
  await p2
  assert.equal(firstAborted, true, 'the second click cancelled the first listener')
  const stored = diskEntry('new1')
  assert.equal(stored.label, 'my claude')
  assert.equal(stored.data.access, 'AUTH-ACCESS')
  assert.equal(stored.data.refresh, 'AUTH-REFRESH')
  assert.equal(stored.data.account, 'jane@example.com')
  assert.equal(stored.data.signedOut, undefined, 're-auth clears the signed-out marker')
  // §5.4 again, for the authorize path.
  assert.equal(m.redact('AUTH-ACCESS'), '[redacted]')
})

test('cancelOAuthSignIn aborts the pending attempt and a failure stores nothing', async () => {
  seed([])
  let calls = 0
  const providers = {
    fake: {
      id: 'fake',
      refresh: () => Promise.reject(new Error('not under test')),
      authorize: (signal) =>
        new Promise((_resolve, reject) => {
          calls++
          signal.addEventListener('abort', () => reject(new m.OAuthFlowError('sign-in cancelled')))
        })
    }
  }
  const draft = { id: 'gone1', label: 'x', kind: 'oauth', hosts: [], data: { providerId: 'fake' } }
  const p = m.oauthSignIn(draft, providers)
  m.cancelOAuthSignIn('gone1')
  await assert.rejects(p, /cancelled/)
  assert.equal(calls, 1)
  // On failure nothing is written and the entry stays as it was (§4) — here,
  // absent entirely.
  assert.equal(diskEntry('gone1'), undefined)
})

// --- §5.2.1: delivery is per agent kind — the materialized native auth files ---
const fakeJwt = (claims) =>
  `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.sig`

test('codex auth.json composes access-only, from the entry extras', () => {
  const entry = oauthEntry('cx', {
    providerId: 'openai',
    access: 'STORED-ACCESS',
    refresh: 'REFRESH-NEVER-LEAVES',
    expiresAt: future,
    idToken: fakeJwt({ email: 'jane@example.com' }),
    accountId: 'acct_123'
  })
  const now = Date.UTC(2026, 8, 8, 12, 0, 0)
  const file = m.oauthAuthFile('codex', entry, 'FRESH-ACCESS', now)
  assert.equal(file.path, '.codex/auth.json')
  const parsed = JSON.parse(file.content)
  // OPENAI_API_KEY must be null: any non-null value (even "") wins over
  // `tokens` in the pinned codex and forces the API-key path.
  assert.ok('OPENAI_API_KEY' in parsed && parsed.OPENAI_API_KEY === null)
  assert.equal(parsed.tokens.access_token, 'FRESH-ACCESS', 'the freshly resolved token, not the stored one')
  assert.equal(parsed.tokens.id_token, entry.data.idToken)
  assert.equal(parsed.tokens.account_id, 'acct_123')
  // refresh_token: the pinned codex requires the key present; empty is the
  // access-only shape (§5.2 — the refresh token never enters a container).
  assert.equal(parsed.tokens.refresh_token, '')
  assert.ok(!file.content.includes('REFRESH-NEVER-LEAVES'), 'no refresh token in the file (§9.6)')
  assert.equal(parsed.last_refresh, new Date(now).toISOString())
})

test('codex without a stored id token blocks with the sign-in-again sentence', () => {
  // An entry signed in before idToken capture existed: the pinned codex
  // hard-requires a parseable id_token, so composing would only defer the
  // failure to a cryptic CLI error.
  const entry = oauthEntry('old', { access: 'A', refresh: 'R', expiresAt: future })
  assert.throws(() => m.oauthAuthFile('codex', entry, 'FRESH', Date.now()), {
    message: 'credential "oauth old" has no ChatGPT id token — sign in again in Credentials'
  })
})

test('gemini oauth_creds.json composes access-only with epoch-ms expiry', () => {
  const entry = oauthEntry('gm', { access: 'S', refresh: 'REFRESH-NEVER-LEAVES', expiresAt: future })
  const file = m.oauthAuthFile('gemini', entry, 'FRESH-ACCESS', Date.now())
  assert.equal(file.path, '.gemini/oauth_creds.json')
  const parsed = JSON.parse(file.content)
  assert.equal(parsed.access_token, 'FRESH-ACCESS')
  assert.equal(parsed.token_type, 'Bearer')
  assert.equal(parsed.expiry_date, Date.parse(future), 'epoch ms, straight against Date.now()')
  // The pinned gemini tolerates the key's absence outright — omitted, not empty.
  assert.ok(!('refresh_token' in parsed), 'refresh_token key omitted entirely')
  assert.ok(!file.content.includes('REFRESH-NEVER-LEAVES'), 'no refresh token in the file (§9.6)')
})

test('the env-var path is untouched where it belongs', () => {
  const entry = oauthEntry('cc', {
    access: 'A', refresh: 'R', expiresAt: future, idToken: fakeJwt({}), accountId: 'x'
  })
  // claude-code consumes the access token via CLAUDE_CODE_OAUTH_TOKEN — no file.
  assert.equal(m.oauthAuthFile('claude-code', entry, 'A', Date.now()), null)
  assert.equal(m.oauthAuthFile('opencode', entry, 'A', Date.now()), null)
  // An agent-token link never materializes a file, codex/gemini included:
  // null is what keeps resolveLaunch on the secretEnv injection.
  const token = { id: 't', label: 'pat', kind: 'agent-token', hosts: [], data: { secret: 'sk-1' } }
  assert.equal(m.oauthAuthFile('codex', token, 'sk-1', Date.now()), null)
  assert.equal(m.oauthAuthFile('gemini', token, 'sk-1', Date.now()), null)
})

// --- §2: the openai provider's extra fields (idToken / accountId) ---
test('openaiExtraData mines the auth claim and carries values forward', () => {
  const jwt = fakeJwt({
    email: 'jane@example.com',
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct_777' }
  })
  assert.deepEqual(m.openaiExtraData({ id_token: jwt }), {
    idToken: jwt,
    accountId: 'acct_777'
  })
  // A refresh response may omit the id_token: the stored values survive.
  const current = { access: '', refresh: '', expiresAt: '', account: '',
    extra: { idToken: 'OLD-JWT', accountId: 'acct_old' } }
  assert.deepEqual(m.openaiExtraData({}, current), { idToken: 'OLD-JWT', accountId: 'acct_old' })
  // A rotated id_token without the claim keeps the known account id.
  assert.deepEqual(m.openaiExtraData({ id_token: fakeJwt({ email: 'j@x' }) }, current), {
    idToken: fakeJwt({ email: 'j@x' }),
    accountId: 'acct_old'
  })
})

test('provider extras persist through a refresh and ride the current set', async () => {
  seed([oauthEntry('ex', {
    access: 'STALE', refresh: 'OLD', expiresAt: past, idToken: 'OLD-IDTOKEN-VALUE', accountId: 'acct_1'
  })])
  const seen = []
  const provider = {
    id: 'fake',
    authorize: () => Promise.reject(new Error('not under test')),
    refresh: async (current) => {
      seen.push(current.extra)
      return {
        access: 'NEW-ACCESS-VALUE', refresh: 'NEW-REFRESH', expiresAt: future,
        account: current.account,
        extra: { idToken: 'NEW-IDTOKEN-VALUE', accountId: 'acct_1' }
      }
    }
  }
  assert.equal(await m.resolveOAuthAccess('ex', { fake: provider }), 'NEW-ACCESS-VALUE')
  assert.deepEqual(seen, [{ idToken: 'OLD-IDTOKEN-VALUE', accountId: 'acct_1' }],
    'the provider sees its stored extras on the current set')
  const stored = diskEntry('ex').data
  assert.equal(stored.idToken, 'NEW-IDTOKEN-VALUE')
  assert.equal(stored.accountId, 'acct_1')
  // §5.4 covers secret extras too: the idToken is redactable the moment the
  // refresh returns (accountId is plaintext, like `account`).
  assert.equal(m.redact('leaking NEW-IDTOKEN-VALUE here'), 'leaking [redacted] here')
})

// --- §9.3 with a keystore: sealed at rest, masks to the renderer ---
// A second bundle, placed next to a stub `electron` module so the lazy
// `createRequire(...)('electron')` inside main/credentials.ts resolves it —
// which is exactly how the real process finds safeStorage.
test('oauth tokens seal at rest and the renderer sees masks', async (t) => {
  const sealDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-oauth-seal-'))
  t.after(() => fs.rmSync(sealDir, { recursive: true, force: true }))
  const stubDir = path.join(sealDir, 'node_modules', 'electron')
  fs.mkdirSync(stubDir, { recursive: true })
  fs.writeFileSync(
    path.join(stubDir, 'package.json'),
    JSON.stringify({ name: 'electron', version: '0.0.0', main: 'index.cjs' })
  )
  fs.writeFileSync(
    path.join(stubDir, 'index.cjs'),
    `module.exports = {
      app: { isReady: () => true },
      safeStorage: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'gnome_libsecret',
        encryptString: (s) => Buffer.from('SEALED:' + s, 'utf8'),
        decryptString: (b) => {
          const t = b.toString('utf8')
          if (!t.startsWith('SEALED:')) throw new Error('bad blob')
          return t.slice(7)
        }
      }
    }`
  )
  const sealedOutfile = path.join(sealDir, 'entry.mjs')
  const sealedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-oauth-seal-root-'))
  t.after(() => fs.rmSync(sealedRoot, { recursive: true, force: true }))
  process.env.GURT_ROOT = sealedRoot
  delete process.env.GURT_FORCE_PLAINTEXT
  t.after(() => {
    process.env.GURT_ROOT = GURT_ROOT
    process.env.GURT_FORCE_PLAINTEXT = '1'
  })
  await bundle({
    stdin: { contents: ENTRY, resolveDir: ROOT, loader: 'ts', sourcefile: 'entry.ts' },
    external: ['electron'],
    outfile: sealedOutfile
  })
  const sealed = await import(pathToFileURL(sealedOutfile).href)

  await sealed.upsertCredentialEntry(
    oauthEntry('s1', {
      access: 'LIVE-ACCESS',
      refresh: 'LIVE-REFRESH',
      expiresAt: future,
      // §2's provider extras: idToken is secret (bearer-ish JWT), accountId is
      // plaintext like `account`.
      idToken: 'LIVE-IDTOKEN',
      accountId: 'acct_9'
    })
  )
  const raw = JSON.parse(fs.readFileSync(path.join(sealedRoot, 'credentials.json'), 'utf8'))
  const onDisk = raw.credentials.find((c) => c.id === 's1')
  assert.equal(onDisk.data.access, undefined, 'access only under sealed')
  assert.equal(onDisk.data.refresh, undefined, 'refresh only under sealed')
  assert.equal(onDisk.data.idToken, undefined, 'idToken only under sealed')
  assert.ok(onDisk.sealed.access && onDisk.sealed.refresh && onDisk.sealed.idToken, 'all three sealed')
  assert.ok(
    ['LIVE-ACCESS', 'LIVE-REFRESH', 'LIVE-IDTOKEN'].every((v) => !JSON.stringify(raw).includes(v)),
    'no plaintext token anywhere in the file'
  )
  // Plaintext fields stay readable; the renderer view masks the secrets.
  assert.equal(onDisk.data.account, 'jane@example.com')
  assert.equal(onDisk.data.accountId, 'acct_9', 'accountId stays plaintext')
  const served = (await sealed.getCredentials()).credentials.find((c) => c.id === 's1')
  assert.ok(served.data.access.startsWith('••••••'), 'renderer sees a mask')
  assert.ok(served.data.refresh.startsWith('••••••'), 'renderer sees a mask')
  assert.ok(served.data.idToken.startsWith('••••••'), 'renderer sees a mask for the idToken')
  // And main-side resolution still reads the real value through unseal.
  assert.equal(m.resolveAgentSecret((await sealed.listCredentials()), 's1').secret, 'LIVE-ACCESS')
})
