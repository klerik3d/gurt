// Pure-logic tests for the git contract (no docker, no electron): repo
// identity, credential resolution, the transport rewrite matrix, the container
// identity injection, and the github forge provider. Bundles the TS with
// esbuild on the fly, then asserts against the real modules.
//
//   node scripts/git-logic.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-git-logic-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

const entry = `
export * from ${S('src/shared/repoId.ts')}
export * from ${S('src/shared/credentials.ts')}
export { rewriteRules, containerGitEnv } from ${S('src/main/git/config.ts')}
export { providerForHost } from ${S('src/main/git/providers.ts')}
`

await bundle({
  stdin: { contents: entry, resolveDir: ROOT, loader: 'ts', sourcefile: 'entry.ts' },
  outfile
})

const m = await import(pathToFileURL(outfile).href)
const repo = (url, credentialId) => ({ name: 'app', url, devcontainer: '', credentialId })

// Shared credential fixtures (§3.1/§3.2).
// Verified entries: save-time verification (§3.2) stamps gitName/gitEmail.
const identity = { gitName: 'Me', gitEmail: '42+me@users.noreply.github.com' }
const tok = { id: 't1', label: 'gh', kind: 'git-token', hosts: ['github.com'], data: { secret: 'SEC', ...identity } }
const gl = { id: 'g1', label: 'gl', kind: 'git-token', hosts: ['gitlab.com'], data: { secret: 'XEC', ...identity } }
const creds = [tok, gl]
const agentTok = { id: 'a1', label: 'claude token', kind: 'agent-token', hosts: ['github.com'], data: { secret: 'ATOK' } }
const p = m.providerForHost('github.com')

after(() => {
  fs.rmSync(outfile, { force: true })
})

// --- repo identity (§2.1) ---
test('repo identity (§2.1)', () => {
  const id = { host: 'github.com', path: 'me/app' }
  assert.deepEqual(m.canonicalRepoId('git@github.com:me/app.git'), id)
  assert.deepEqual(m.canonicalRepoId('ssh://git@github.com/me/app'), id)
  assert.deepEqual(m.canonicalRepoId('https://github.com/me/app.git'), id)
  assert.equal(m.repoIdString(id), 'github.com/me/app')
  assert.equal(m.canonicalRepoId('git@github.com-work:me/app.git').host, 'github.com-work')
  assert.equal(m.canonicalRepoId('/tmp/local/bare.git'), null)
  assert.equal(m.canonicalRepoId('file:///tmp/x.git'), null)
})

// --- credential resolution (§3.1) ---
test('credential resolution (§3.1)', () => {
  let r = m.resolveCredential(creds, repo('https://github.com/me/app'), 'github.com')
  assert.equal(r.entry.id, 't1')
  assert.equal(r.source, 'match')

  r = m.resolveCredential(creds, repo('https://github.com/me/app', 'g1'), 'github.com')
  assert.equal(r.entry.id, 'g1')
  assert.equal(r.source, 'link')

  // Cross-host submodule ignores the env repo's link, matches by host.
  r = m.resolveCredential(creds, repo('https://github.com/me/app', 't1'), 'gitlab.com')
  assert.equal(r.entry.id, 'g1')
  assert.equal(r.source, 'match')

  r = m.resolveCredential([], repo('https://bitbucket.org/me/app'), 'bitbucket.org')
  assert.equal(r.kind, 'git-host')
  assert.equal(r.source, 'implicit')
  assert.equal(r.entry, undefined)

  r = m.resolveCredential([], repo('https://github.com/me/app', 'missing'), 'github.com')
  assert.ok(r.error)
  assert.equal(r.kind, 'git-host')

  assert.equal(m.hasManagedCredential(m.resolveForRepo(creds, repo('https://github.com/me/app'))), true)
  assert.equal(m.hasManagedCredential(m.resolveForRepo([], repo('https://github.com/me/app'))), false)
})

// --- unverified entries are blocked, never served (§3.2) ---
test('unverified entries are blocked, never served (§3.2)', () => {
  const unverified = { ...tok, data: { secret: 'SEC' } }
  const r = m.resolveCredential([unverified], repo('https://github.com/me/app'), 'github.com')
  assert.equal(r.entry.id, 't1')
  assert.ok(r.error && r.error.includes('re-save'))
  assert.equal(m.hasManagedCredential(r), false)
  assert.deepEqual(m.credentialIdentity(tok), { name: 'Me', email: '42+me@users.noreply.github.com' })
  assert.equal(m.credentialIdentity(unverified), null)
})

// --- retired kinds resolve as an error, never silently (§10.1) ---
test('a stored git-ssh-key entry blocks with a migration message (§10.1)', () => {
  // ssh support is gone, but an entry written by an older gurt survives in
  // credentials.json — resolving it must say so rather than fall through to
  // ambient auth (or, worse, look like "no credential configured").
  const ssh = { id: 's1', label: 'my key', kind: 'git-ssh-key', hosts: ['github.com'], data: {} }
  assert.equal(m.isRetiredKind('git-ssh-key'), true)
  assert.equal(m.isRetiredKind('git-token'), false)
  // The kind is gone from the pickable set, so no new one can be created.
  assert.equal(
    m.CREDENTIAL_KINDS.some((k) => k.kind === 'git-ssh-key'),
    false,
    'the kind is not offered in the credentials editor'
  )
  for (const [how, cfg] of [
    ['auto-matched by host', repo('https://github.com/me/app')],
    ['linked explicitly', repo('https://github.com/me/app', 's1')]
  ]) {
    const r = m.resolveCredential([ssh], cfg, 'github.com')
    assert.ok(r.error, `${how} → an error`)
    assert.ok(r.error.includes('unsupported credential kind'), `${how} names the cause`)
    assert.ok(r.error.includes('token'), `${how} says what to do instead`)
    assert.equal(m.hasManagedCredential(r), false, `${how} is never usable`)
  }
})

// --- agent-token is never a git credential ---
test('agent-token is never a git credential', () => {
  // Hosts on an agent-token (e.g. left behind by a kind switch) never auto-match.
  let r = m.resolveCredential([agentTok], repo('https://github.com/me/app'), 'github.com')
  assert.equal(r.entry, undefined)
  assert.equal(r.source, 'implicit')
  // An explicit repo link to one is a config error, not a served credential.
  r = m.resolveCredential([agentTok], repo('https://github.com/me/app', 'a1'), 'github.com')
  assert.ok(r.error && r.error.includes('not a git credential'))
  assert.equal(r.entry, undefined)
  assert.equal(m.hasManagedCredential(r), false)
})

// --- agent secret resolution ---
test('agent secret resolution', () => {
  assert.deepEqual(m.resolveAgentSecret([agentTok], undefined), { secret: '' })
  assert.equal(m.resolveAgentSecret([agentTok], 'a1').secret, 'ATOK')
  assert.ok(m.resolveAgentSecret([], 'a1').error.includes('no longer exists'))
  // A link pointing at a git kind must not inject the git PAT as the agent secret.
  const wrongKind = m.resolveAgentSecret([tok], 't1')
  assert.equal(wrongKind.secret, '')
  assert.ok(wrongKind.error.includes('not an agent token'))
  assert.deepEqual(m.agentCredentials([tok, agentTok]), [agentTok])
})

// --- rewrite matrix (§6.1) ---
test('rewrite matrix (§6.1)', () => {
  assert.deepEqual(m.rewriteRules('github.com', 'git-token'), [
    ['url.https://github.com/.insteadOf', 'git@github.com:'],
    ['url.https://github.com/.insteadOf', 'ssh://git@github.com/']
  ])
  assert.deepEqual(m.rewriteRules('github.com', 'git-host'), [])
  assert.deepEqual(m.rewriteRules('github.com', 'agent-token'), [])
})

// --- container injection env (§10.3): commit identity, and nothing else ---
test('container injection env is identity-only (§10.3)', () => {
  const env = m.containerGitEnv({ name: 'Me', email: '42+me@users.noreply.github.com' })
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(env.GIT_CONFIG_COUNT, '2', 'identity only — no helper, no rewrites')
  assert.equal(env.GIT_CONFIG_KEY_0, 'user.name')
  assert.equal(env.GIT_CONFIG_VALUE_0, 'Me')
  assert.equal(env.GIT_CONFIG_KEY_1, 'user.email')
  assert.equal(env.GIT_CONFIG_VALUE_1, '42+me@users.noreply.github.com')
  // The container authenticates to nothing: no credential helper is ever set,
  // and no broker URL exists to point one at.
  const keys = Object.keys(env)
  assert.ok(
    !keys.some((k) => k.startsWith('GURT_')),
    'no broker URL or credential handle reaches the container'
  )
  assert.ok(
    !Object.values(env).some((v) => String(v).includes('credential.helper')),
    'no credential helper is injected'
  )
  // No resolved identity (unverified or errored entry) → nothing to inject.
  assert.equal(m.containerGitEnv(null).GIT_CONFIG_COUNT, '0')
  assert.equal(m.containerGitEnv().GIT_CONFIG_COUNT, '0')
})

// --- github forge provider (§7) ---
test('github forge provider (§7)', async () => {
  assert.equal(p.id, 'github')
  assert.equal(m.providerForHost('gitlab.com'), null)
  const fe = await p.forgeEnv(tok, 'github.com')
  assert.equal(fe.GH_TOKEN, 'SEC')
  assert.equal(fe.GH_HOST, undefined)
  const fee = await p.forgeEnv({ ...tok, data: { secret: 'SEC' } }, 'ghe.corp.com')
  assert.equal(fee.GH_HOST, 'ghe.corp.com')
  // A kind that cannot serve the forge API resolves to nothing, never to a
  // partial env the caller might use anyway.
  const ambient = await p.forgeEnv({ id: 'h', label: 'h', kind: 'git-host', hosts: [], data: {} }, 'github.com')
  assert.equal(ambient, null)
  // The provider is host-side only now: no container wrappers, no devcontainer
  // features (docs/requirements-mcp-proxy.md §10.2).
  assert.equal(p.wrappers, undefined)
  assert.equal(p.features, undefined)
})

// --- identity lookup (§3.2), fetch mocked ---
test('identity lookup (§3.2), fetch mocked', async () => {
  const realFetch = globalThis.fetch
  try {
    let seen
    // Cast: the double answers only what `identity` reads off the response.
    globalThis.fetch = /** @type {typeof fetch} */ (
      async (url, opts) => {
        seen = { url, auth: opts.headers.Authorization }
        return { ok: true, status: 200, json: async () => ({ login: 'me', id: 42, name: null, email: null }) }
      }
    )
    const idn = await p.identity(tok, 'github.com')
    assert.equal(seen.url, 'https://api.github.com/user')
    assert.equal(seen.auth, 'Bearer SEC')
    // No public name/email → login + the id-qualified noreply form.
    assert.deepEqual(idn, { name: 'me', email: '42+me@users.noreply.github.com' })
    await p.identity(tok, 'ghe.corp.com')
    assert.equal(seen.url, 'https://ghe.corp.com/api/v3/user')

    globalThis.fetch = /** @type {typeof fetch} */ (
      /** @type {unknown} */ (async () => ({ ok: false, status: 401, json: async () => ({}) }))
    )
    await assert.rejects(() => p.identity(tok, 'github.com'), /rejected the token \(HTTP 401\)/)
    await assert.rejects(
      () => p.identity({ ...tok, kind: 'git-host', data: {} }, 'github.com'),
      /cannot verify/
    )
  } finally {
    globalThis.fetch = realFetch
  }
})
