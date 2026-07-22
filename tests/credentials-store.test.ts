// Pure-fs tests for the credential store CRUD (no docker, no electron):
// save-time token verification (§3.2 — unverified git-tokens are never
// stored), delete blocked while linked (§9), and the read defaults. The
// forge identity call rides on fetch, mocked like tests/git-logic.test.ts.
import { afterAll, afterEach, it } from 'vitest'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

// gurtRoot is read from GURT_ROOT at module load — set it before the import.
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-cred-store-'))
process.env.GURT_ROOT = GURT_ROOT
const { getCredentials, setCredentials, listCredentials, credentialUsedBy } = await import(
  '../src/main/credentials'
)

const credsPath = path.join(GURT_ROOT, 'credentials.json')
const readDisk = () => JSON.parse(fs.readFileSync(credsPath, 'utf8'))

const realFetch = globalThis.fetch
/** Mock the forge identity endpoint; returns the call log. */
function mockIdentityFetch(response?: { ok: boolean; status: number; json: object }) {
  const calls: { url: string; auth: string }[] = []
  globalThis.fetch = (async (url: any, opts: any) => {
    calls.push({ url: String(url), auth: opts.headers.Authorization })
    const r = response ?? {
      ok: true,
      status: 200,
      json: { login: 'me', id: 42, name: null, email: null }
    }
    return { ok: r.ok, status: r.status, json: async () => r.json }
  }) as any
  return calls
}

afterEach(() => {
  globalThis.fetch = realFetch
})
afterAll(() => {
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

const gitToken = (over: object = {}): any => ({
  id: 'c-1',
  label: 'gh',
  kind: 'git-token',
  hosts: ['github.com'],
  data: { secret: 'SEC' },
  ...over
})

it('read defaults: absent and corrupted files read as empty', async () => {
  assert.deepEqual(await getCredentials(), { credentials: [] })
  assert.deepEqual(await listCredentials(), [])
  fs.mkdirSync(GURT_ROOT, { recursive: true })
  fs.writeFileSync(credsPath, 'not json')
  assert.deepEqual(await getCredentials(), { credentials: [] })
  fs.writeFileSync(credsPath, JSON.stringify({ credentials: 'bogus' }))
  assert.deepEqual(await getCredentials(), { credentials: [] })
  fs.rmSync(credsPath)
})

it('agent-token and git-host entries save without any forge call', async () => {
  const calls = mockIdentityFetch()
  await setCredentials({
    credentials: [
      { id: 'a-1', label: 'claude', kind: 'agent-token', hosts: [], data: { secret: 'ATOK' } },
      { id: 'h-1', label: 'host', kind: 'git-host', hosts: ['github.com'], data: {} }
    ] as any
  })
  assert.equal(calls.length, 0, 'no identity lookup for non-git-token kinds')
  assert.equal(readDisk().credentials.length, 2)
})

it('a new git-token is verified against its forge and stamped (§3.2)', async () => {
  const calls = mockIdentityFetch()
  await setCredentials({ credentials: [gitToken()] })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.github.com/user')
  assert.equal(calls[0].auth, 'Bearer SEC')
  const [stored] = readDisk().credentials
  assert.equal(stored.data.gitName, 'me')
  assert.equal(stored.data.gitEmail, '42+me@users.noreply.github.com')
})

it('unchanged secret with a stamped identity skips re-verification', async () => {
  const calls = mockIdentityFetch()
  const stamped = readDisk().credentials[0]
  await setCredentials({ credentials: [{ ...stamped, label: 'renamed' }] })
  assert.equal(calls.length, 0, 'same secret + identity → no forge call')
  assert.equal(readDisk().credentials[0].label, 'renamed')
})

it('a changed secret re-verifies and re-stamps', async () => {
  const calls = mockIdentityFetch({
    ok: true,
    status: 200,
    json: { login: 'other', id: 7, name: 'Other Name', email: 'o@x.com' }
  })
  const stamped = readDisk().credentials[0]
  await setCredentials({
    credentials: [{ ...stamped, data: { ...stamped.data, secret: 'NEW' } }]
  })
  assert.equal(calls.length, 1)
  const [stored] = readDisk().credentials
  assert.equal(stored.data.gitName, 'Other Name')
  assert.equal(stored.data.gitEmail, 'o@x.com')
})

it('a git-token without a verifiable forge host rejects the whole save', async () => {
  mockIdentityFetch()
  const before = fs.readFileSync(credsPath, 'utf8')
  await assert.rejects(
    () =>
      setCredentials({
        credentials: [...readDisk().credentials, gitToken({ id: 'c-2', hosts: ['git.corp.lan'] })]
      }),
    /no forge provider matches/
  )
  assert.equal(fs.readFileSync(credsPath, 'utf8'), before, 'rejected save writes nothing')
})

it('a forge rejection (HTTP 401) rejects the whole save, nothing written', async () => {
  mockIdentityFetch({ ok: false, status: 401, json: {} })
  const before = fs.readFileSync(credsPath, 'utf8')
  await assert.rejects(
    () =>
      setCredentials({
        credentials: [...readDisk().credentials, gitToken({ id: 'c-2', data: { secret: 'BAD' } })]
      }),
    /rejected the token/
  )
  assert.equal(fs.readFileSync(credsPath, 'utf8'), before)
})

it('delete blocked while linked (§9): repo and agent links both hold', async () => {
  // link the surviving token from a workspace repo and from an agent
  fs.mkdirSync(path.join(GURT_ROOT, 'w1'), { recursive: true })
  fs.writeFileSync(
    path.join(GURT_ROOT, 'w1', 'workspace.json'),
    JSON.stringify({
      repos: [{ name: 'r1', url: 'https://github.com/o/r1.git', credentialId: 'c-1' }],
      envs: []
    })
  )
  fs.writeFileSync(
    path.join(GURT_ROOT, 'agents.json'),
    JSON.stringify({ x: { kind: 'codex', label: 'work bot', credentialId: 'c-1' } })
  )
  assert.deepEqual(await credentialUsedBy('c-1'), ['w1/r1', 'agent "work bot"'])
  assert.deepEqual(await credentialUsedBy('nobody'), [])

  const keep = readDisk().credentials.filter((c: any) => c.id !== 'c-1')
  await assert.rejects(() => setCredentials({ credentials: keep }), /w1\/r1.*work bot/s)
  assert.ok(readDisk().credentials.some((c: any) => c.id === 'c-1'), 'linked entry survives')

  // unlink both → delete goes through
  fs.writeFileSync(
    path.join(GURT_ROOT, 'w1', 'workspace.json'),
    JSON.stringify({ repos: [{ name: 'r1', url: 'https://github.com/o/r1.git' }], envs: [] })
  )
  fs.writeFileSync(path.join(GURT_ROOT, 'agents.json'), JSON.stringify({}))
  await setCredentials({ credentials: keep })
  assert.ok(!readDisk().credentials.some((c: any) => c.id === 'c-1'))
})
