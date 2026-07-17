// Pure-logic tests for the native-git contract (no docker, no electron):
// repo identity, credential resolution, the transport rewrite matrix, the
// container injection env, and the github forge provider. Bundles the TS with
// esbuild on the fly, then asserts against the real modules.
//
//   node scripts/git-logic.test.mjs
import { build } from 'esbuild'
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
export { rewriteRules, containerGitEnv, CRED_HELPER_BIN } from ${S('src/main/git/config.ts')}
export { providerForHost, forgeFeatures, forgeWrappers } from ${S('src/main/git/providers.ts')}
`

await build({
  stdin: { contents: entry, resolveDir: ROOT, loader: 'ts', sourcefile: 'entry.ts' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  logLevel: 'silent'
})

const m = await import(pathToFileURL(outfile).href)
const repo = (url, credentialId) => ({ name: 'app', url, devcontainer: '', credentialId })

try {
  // --- repo identity (§2.1) ---
  const id = { host: 'github.com', path: 'me/app' }
  assert.deepEqual(m.canonicalRepoId('git@github.com:me/app.git'), id)
  assert.deepEqual(m.canonicalRepoId('ssh://git@github.com/me/app'), id)
  assert.deepEqual(m.canonicalRepoId('https://github.com/me/app.git'), id)
  assert.equal(m.repoIdString(id), 'github.com/me/app')
  assert.equal(m.canonicalRepoId('git@github.com-work:me/app.git').host, 'github.com-work')
  assert.equal(m.canonicalRepoId('/tmp/local/bare.git'), null)
  assert.equal(m.canonicalRepoId('file:///tmp/x.git'), null)

  // --- credential resolution (§3.1) ---
  // Verified entries: save-time verification (§3.2) stamps gitName/gitEmail.
  const identity = { gitName: 'Me', gitEmail: '42+me@users.noreply.github.com' }
  const tok = { id: 't1', label: 'gh', kind: 'git-token', hosts: ['github.com'], data: { secret: 'SEC', ...identity } }
  const gl = { id: 'g1', label: 'gl', kind: 'git-token', hosts: ['gitlab.com'], data: { secret: 'XEC', ...identity } }
  const creds = [tok, gl]

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

  // --- unverified entries are blocked, never served (§3.2) ---
  const unverified = { ...tok, data: { secret: 'SEC' } }
  r = m.resolveCredential([unverified], repo('https://github.com/me/app'), 'github.com')
  assert.equal(r.entry.id, 't1')
  assert.ok(r.error && r.error.includes('re-save'))
  assert.equal(m.hasManagedCredential(r), false)
  assert.deepEqual(m.credentialIdentity(tok), { name: 'Me', email: '42+me@users.noreply.github.com' })
  assert.equal(m.credentialIdentity(unverified), null)

  // --- agent-token is never a git credential ---
  const agentTok = { id: 'a1', label: 'claude token', kind: 'agent-token', hosts: ['github.com'], data: { secret: 'ATOK' } }
  // Hosts on an agent-token (e.g. left behind by a kind switch) never auto-match.
  r = m.resolveCredential([agentTok], repo('https://github.com/me/app'), 'github.com')
  assert.equal(r.entry, undefined)
  assert.equal(r.source, 'implicit')
  // An explicit repo link to one is a config error, not a served credential.
  r = m.resolveCredential([agentTok], repo('https://github.com/me/app', 'a1'), 'github.com')
  assert.ok(r.error && r.error.includes('not a git credential'))
  assert.equal(r.entry, undefined)
  assert.equal(m.hasManagedCredential(r), false)

  // --- agent secret resolution ---
  assert.deepEqual(m.resolveAgentSecret([agentTok], undefined), { secret: '' })
  assert.equal(m.resolveAgentSecret([agentTok], 'a1').secret, 'ATOK')
  assert.ok(m.resolveAgentSecret([], 'a1').error.includes('no longer exists'))
  // A link pointing at a git kind must not inject the git PAT as the agent secret.
  const wrongKind = m.resolveAgentSecret([tok], 't1')
  assert.equal(wrongKind.secret, '')
  assert.ok(wrongKind.error.includes('not an agent token'))
  assert.deepEqual(m.agentCredentials([tok, agentTok]), [agentTok])

  // --- rewrite matrix (§6.1) ---
  assert.deepEqual(m.rewriteRules('github.com', 'git-token'), [
    ['url.https://github.com/.insteadOf', 'git@github.com:'],
    ['url.https://github.com/.insteadOf', 'ssh://git@github.com/']
  ])
  assert.deepEqual(m.rewriteRules('github.com', 'git-ssh-key'), [
    ['url.ssh://git@github.com/.insteadOf', 'https://github.com/']
  ])
  assert.deepEqual(m.rewriteRules('github.com', 'git-host'), [])
  assert.deepEqual(m.rewriteRules('github.com', 'agent-token'), [])

  // --- container injection env (§6) ---
  const env = m.containerGitEnv('http://host.docker.internal:5000/git/abc', 'github.com', 'git-token')
  assert.equal(env.GURT_GIT_BROKER, 'http://host.docker.internal:5000/git/abc')
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(env.GIT_CONFIG_COUNT, '4') // reset helper, helper, 2 rewrites
  assert.equal(env.GIT_CONFIG_KEY_0, 'credential.helper')
  assert.equal(env.GIT_CONFIG_VALUE_0, '')
  assert.equal(env.GIT_CONFIG_KEY_1, 'credential.helper')
  assert.equal(env.GIT_CONFIG_VALUE_1, m.CRED_HELPER_BIN)
  assert.equal(env.GIT_CONFIG_KEY_2, 'url.https://github.com/.insteadOf')
  // git-host injects only the (204-ing) helper, no rewrites.
  assert.equal(m.containerGitEnv('http://h/git/x', 'github.com', 'git-host').GIT_CONFIG_COUNT, '2')
  // Commit identity rides in as config pairs (§3.2); absent → nothing injected.
  const envId = m.containerGitEnv('http://h/git/x', 'github.com', 'git-token', {
    name: 'Me',
    email: '42+me@users.noreply.github.com'
  })
  assert.equal(envId.GIT_CONFIG_COUNT, '6')
  assert.equal(envId.GIT_CONFIG_KEY_4, 'user.name')
  assert.equal(envId.GIT_CONFIG_VALUE_4, 'Me')
  assert.equal(envId.GIT_CONFIG_KEY_5, 'user.email')
  assert.equal(envId.GIT_CONFIG_VALUE_5, '42+me@users.noreply.github.com')

  // --- github forge provider (§7) ---
  const p = m.providerForHost('github.com')
  assert.equal(p.id, 'github')
  assert.equal(m.providerForHost('gitlab.com'), null)
  const fe = await p.forgeEnv(tok, 'github.com')
  assert.equal(fe.GH_TOKEN, 'SEC')
  assert.equal(fe.GH_HOST, undefined)
  const fee = await p.forgeEnv({ ...tok, data: { secret: 'SEC' } }, 'ghe.corp.com')
  assert.equal(fee.GH_HOST, 'ghe.corp.com')
  const ssh = await p.forgeEnv({ id: 'k', label: 'k', kind: 'git-ssh-key', hosts: [], data: {} }, 'github.com')
  assert.equal(ssh, null)
  assert.ok('ghcr.io/devcontainers/features/github-cli:1' in m.forgeFeatures('github.com'))
  assert.deepEqual(m.forgeWrappers('github.com'), ['gh'])
  assert.deepEqual(m.forgeFeatures('gitlab.com'), {})

  // --- identity lookup (§3.2), fetch mocked ---
  const realFetch = globalThis.fetch
  try {
    let seen
    globalThis.fetch = async (url, opts) => {
      seen = { url, auth: opts.headers.Authorization }
      return { ok: true, status: 200, json: async () => ({ login: 'me', id: 42, name: null, email: null }) }
    }
    const idn = await p.identity(tok, 'github.com')
    assert.equal(seen.url, 'https://api.github.com/user')
    assert.equal(seen.auth, 'Bearer SEC')
    // No public name/email → login + the id-qualified noreply form.
    assert.deepEqual(idn, { name: 'me', email: '42+me@users.noreply.github.com' })
    await p.identity(tok, 'ghe.corp.com')
    assert.equal(seen.url, 'https://ghe.corp.com/api/v3/user')

    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) })
    await assert.rejects(() => p.identity(tok, 'github.com'), /rejected the token \(HTTP 401\)/)
    await assert.rejects(
      () => p.identity({ ...tok, kind: 'git-host', data: {} }, 'github.com'),
      /cannot verify/
    )
  } finally {
    globalThis.fetch = realFetch
  }

  console.log('git-logic.test: PASS')
} catch (e) {
  console.error('git-logic.test: FAIL')
  console.error(e)
  process.exitCode = 1
} finally {
  fs.rmSync(outfile, { force: true })
}
