// Behavioral tests for the host git-access layer (docs/requirements-git-access.md),
// no docker and no real remotes: the per-env credential broker is driven over
// real HTTP (§4), and hostGitAccess resolves the managed/ambient/blocked mode
// matrix (§8) from on-disk workspace + credential fixtures.
import { afterAll, it } from 'vitest'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import type { EnvRef } from '../src/shared/types'
import type { CredentialEntry } from '../src/shared/credentials'

// GURT_ROOT must be set before the modules load (read at import time).
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-git-broker-'))
process.env.GURT_ROOT = GURT_ROOT
const { resolveGitBroker, stopGitBroker } = await import('../src/main/git/broker')
const { hostGitAccess, hostGitAccessForRepo } = await import('../src/main/git/env')
const { BLOCKED_SSH_COMMAND } = await import('../src/main/git/config')
const { hostCredHelperPath } = await import('../src/main/git/shims')

const ws = 'w'
const task = 't'

// Verified git-token for github.com, explicit ambient opt-in for
// ambient.example.com, and a pre-§3.2 (unverified) token for gitlab.com that
// must never be served.
const credentials: CredentialEntry[] = [
  {
    id: 'tok1',
    label: 'gh token',
    kind: 'git-token',
    hosts: ['github.com'],
    data: { secret: 'S3CRET', gitName: 'Me', gitEmail: '7+me@users.noreply.github.com' }
  },
  { id: 'host1', label: 'ambient', kind: 'git-host', hosts: ['ambient.example.com'], data: {} },
  { id: 'unv1', label: 'stale', kind: 'git-token', hosts: ['gitlab.com'], data: { secret: 'OLD' } }
]

fs.mkdirSync(path.join(GURT_ROOT, ws, task), { recursive: true })
fs.writeFileSync(path.join(GURT_ROOT, 'credentials.json'), JSON.stringify({ credentials }))
fs.writeFileSync(
  path.join(GURT_ROOT, ws, 'workspace.json'),
  JSON.stringify({
    repos: [
      { name: 'app', url: 'https://github.com/me/app.git' },
      { name: 'amb', url: 'git@ambient.example.com:me/inner.git' },
      { name: 'amb-linked', url: 'https://github.com/me/other.git', credentialId: 'host1' },
      { name: 'none', url: 'https://bitbucket.org/me/app.git' },
      { name: 'unv', url: 'https://gitlab.com/me/app.git' }
    ],
    envs: []
  })
)
// Env instances: per-session records carrying the provisioned repo (the broker
// resolves through them); sess-bare never went up, so it carries no repo.
fs.writeFileSync(
  path.join(GURT_ROOT, ws, task, 'task.json'),
  JSON.stringify({
    envs: [
      { session: 'sess-app', env: 'e', repo: 'app', status: 'running' },
      { session: 'sess-amb', env: 'e', repo: 'amb', status: 'running' },
      { session: 'sess-bare', env: 'e', status: 'stopped' }
    ]
  })
)

const ref = (session: string): EnvRef => ({ workspace: ws, task, env: 'e', session })
const refApp = ref('sess-app')
const refAmb = ref('sess-amb')
const refBare = ref('sess-bare')

afterAll(() => {
  for (const r of [refApp, refAmb, refBare]) stopGitBroker(r)
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

/** The broker URL is container-shaped (host.docker.internal); hit it locally. */
const local = (url: string) => url.replace('host.docker.internal', '127.0.0.1')

/** Plain node:http client, no keep-alive — a closed broker refuses, never reuses. */
function request(
  url: string,
  opts: { method?: string; body?: string } = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: opts.method ?? 'GET', agent: false }, (res) => {
      let data = ''
      res.on('data', (d) => (data += d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })
    req.on('error', reject)
    req.end(opts.body)
  })
}

const FILL = 'protocol=https\nhost=github.com\npath=me/app.git\n'
const fill = (url: string, body: string) => request(url + '/credential', { method: 'POST', body })

let appUrl = ''

// --- broker (§4) ------------------------------------------------------------

it('resolveGitBroker: container-reachable URL with a token path, idempotent per env', async () => {
  const d1 = await resolveGitBroker(refApp)
  assert.match(
    d1.url,
    /^http:\/\/host\.docker\.internal:\d+\/git\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    'URL is host.docker.internal:<port>/git/<uuid>'
  )
  const d2 = await resolveGitBroker(refApp)
  assert.equal(d2.url, d1.url, 'second resolve reuses the running broker')
  appUrl = local(d1.url)
})

it('POST /credential serves the managed verified token for the repo host (§4.1)', async () => {
  const res = await fill(appUrl, FILL)
  assert.equal(res.status, 200)
  assert.equal(res.body, 'username=x-access-token\npassword=S3CRET\n')
})

it('POST /credential: everything that must not be served answers 204 (§3.1, §3.2)', async () => {
  // non-https protocol
  const ssh = await fill(appUrl, 'protocol=ssh\nhost=github.com\n')
  assert.equal(ssh.status, 204)
  assert.equal(ssh.body, '', 'a 204 carries no credential material')
  // no host field
  assert.equal((await fill(appUrl, 'protocol=https\n')).status, 204)
  // per-request resolution: a host with no credential gets nothing, even though
  // the env repo's own host resolves fine
  assert.equal((await fill(appUrl, 'protocol=https\nhost=bitbucket.org\n')).status, 204)
  // unverified git-token entry (pre-§3.2) errors out, never served
  assert.equal((await fill(appUrl, 'protocol=https\nhost=gitlab.com\n')).status, 204)
  // git-host resolution: ambient is the host's business, the broker serves nothing
  const ambUrl = local((await resolveGitBroker(refAmb)).url)
  assert.equal((await fill(ambUrl, 'protocol=https\nhost=ambient.example.com\n')).status, 204)
  // an instance that never went up has no provisioned repo
  const bareUrl = local((await resolveGitBroker(refBare)).url)
  assert.equal((await fill(bareUrl, FILL)).status, 204)
})

it('GET /forge-env: provider env for a token repo, 204 when no provider matches (§7)', async () => {
  const res = await request(appUrl + '/forge-env')
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body), { GH_TOKEN: 'S3CRET' }, 'github.com needs no GH_HOST')
  const ambUrl = local((await resolveGitBroker(refAmb)).url)
  assert.equal((await request(ambUrl + '/forge-env')).status, 204)
})

it('unknown token, path or method → 404', async () => {
  const origin = new URL(appUrl).origin
  const wrongTok = await request(`${origin}/git/not-the-token/credential`, {
    method: 'POST',
    body: FILL
  })
  assert.equal(wrongTok.status, 404)
  assert.equal((await request(appUrl + '/nope')).status, 404)
  assert.equal((await request(appUrl + '/credential')).status, 404) // GET, not POST
  assert.equal((await request(appUrl + '/forge-env', { method: 'POST', body: '' })).status, 404)
})

it('stopGitBroker tears down; the next resolve starts a fresh broker', async () => {
  stopGitBroker(refApp)
  await assert.rejects(fill(appUrl, FILL), 'stopped broker no longer accepts connections')
  stopGitBroker(refApp) // no-op on an already-stopped env
  const d3 = await resolveGitBroker(refApp)
  assert.notEqual(local(d3.url), appUrl, 'restart mints a new port/token')
  appUrl = local(d3.url)
  assert.equal((await fill(appUrl, FILL)).status, 200, 'fresh broker serves again')
})

// --- host git access (§8) ---------------------------------------------------

it('hostGitAccess: managed mode for a verified token', async () => {
  const a = await hostGitAccessForRepo(ws, 'app')
  assert.equal(a.mode, 'managed')
  assert.equal(a.host, 'github.com')
  assert.equal(a.resolution?.entry?.id, 'tok1')
  assert.equal(a.resolution?.source, 'match')
  // helper coordinates ride in env; the secret never does
  assert.equal(a.env.GURT_CRED_ID, 'tok1')
  assert.equal(a.env.GURT_CRED_HOST, 'github.com')
  assert.equal(a.env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(a.env.GIT_SSH_COMMAND, BLOCKED_SSH_COMMAND, 'ambient ssh blocked')
  assert.equal(a.env.PATH, process.env.PATH, 'host env is inherited')
  // config rides in -c argv pairs: helper reset + host helper + rewrites + identity
  const helper = hostCredHelperPath()
  assert.ok(fs.existsSync(helper), 'the host credential helper was materialized')
  assert.deepEqual(a.gitArgs, [
    '-c',
    'credential.helper=',
    '-c',
    `credential.helper=!ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${helper}"`,
    '-c',
    'url.https://github.com/.insteadOf=git@github.com:',
    '-c',
    'url.https://github.com/.insteadOf=ssh://git@github.com/',
    '-c',
    'user.name=Me',
    '-c',
    'user.email=7+me@users.noreply.github.com'
  ])
  assert.ok(!JSON.stringify(a.gitArgs).includes('S3CRET'), 'secret never in argv')
})

it('hostGitAccess: ambient only via an explicit git-host entry — match or link', async () => {
  const m = await hostGitAccessForRepo(ws, 'amb')
  assert.equal(m.mode, 'ambient')
  assert.equal(m.host, 'ambient.example.com')
  assert.equal(m.resolution?.entry?.id, 'host1')
  assert.equal(m.resolution?.source, 'match')
  assert.deepEqual(m.gitArgs, [], 'no config overrides — host behavior as-is')
  assert.equal(m.env.GIT_TERMINAL_PROMPT, '0', 'except: never prompt')
  assert.equal(m.env.GIT_SSH_COMMAND, process.env.GIT_SSH_COMMAND, 'ambient ssh stays reachable')

  const l = await hostGitAccessForRepo(ws, 'amb-linked')
  assert.equal(l.mode, 'ambient')
  assert.equal(l.resolution?.source, 'link')
  assert.equal(l.resolution?.entry?.id, 'host1')
})

it('hostGitAccess: blocked — implicit, unverified entry, unknown repo (never ambient fallback)', async () => {
  const none = await hostGitAccessForRepo(ws, 'none')
  assert.equal(none.mode, 'blocked')
  assert.ok(none.reason?.includes('no gurt credential is configured for bitbucket.org'))
  assert.equal(none.resolution?.source, 'implicit')
  assert.deepEqual(none.gitArgs, ['-c', 'credential.helper='], 'helpers reset')
  assert.equal(none.env.GIT_SSH_COMMAND, BLOCKED_SSH_COMMAND, 'ambient ssh blocked')
  assert.equal(none.env.GIT_TERMINAL_PROMPT, '0')

  const unv = await hostGitAccessForRepo(ws, 'unv')
  assert.equal(unv.mode, 'blocked')
  assert.ok(unv.reason?.includes('re-save'), 'unverified token is a config error (§3.2)')

  const ghost = await hostGitAccessForRepo(ws, 'ghost')
  assert.equal(ghost.mode, 'blocked')
  assert.equal(ghost.host, null)
  assert.equal(ghost.resolution, null)
  assert.ok(ghost.reason?.includes('not registered'))
})

it('hostGitAccess: unparseable URL and unimplemented kinds block too', async () => {
  const loc = await hostGitAccess({ name: 'x', url: '/tmp/local/bare.git' }, [])
  assert.equal(loc.mode, 'blocked')
  assert.equal(loc.host, null)
  assert.ok(loc.reason?.includes('no recognizable git host'))

  const key: CredentialEntry = {
    id: 'k1',
    label: 'key',
    kind: 'git-ssh-key',
    hosts: ['github.com'],
    data: { keyPath: '/x' }
  }
  const ssh = await hostGitAccess({ name: 'x', url: 'https://github.com/me/app' }, [key])
  assert.equal(ssh.mode, 'blocked')
  assert.equal(ssh.resolution?.entry?.id, 'k1')
  assert.ok(ssh.reason?.includes('not usable yet'), 'phase-2 kind blocks, never falls through')
  assert.equal(ssh.env.GIT_SSH_COMMAND, BLOCKED_SSH_COMMAND)
})
