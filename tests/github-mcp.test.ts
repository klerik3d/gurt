// Pure-node test for the host github MCP server: no docker, no electron — it
// drives the real server over HTTP with MCP JSON-RPC, mirroring
// tests/gurt-mcp.test.ts. The only mocked seam is `hostGitAccessForRepo` (the
// credential resolution, covered elsewhere); the tools then run fake `git`/`gh`
// executables from a controlled PATH that record their argv + env, so the
// tests assert the real behavior: which command runs, with which config args,
// credential env and cwd, and how failures map to isError results.
import { afterAll, beforeEach, it, vi } from 'vitest'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { HostGitAccess } from '../src/main/git/env'
import type { CredentialEntry } from '../src/shared/credentials'
import type { EnvRef } from '../src/shared/types'

const { accessMock } = vi.hoisted(() => ({
  accessMock: vi.fn<(ws: string, repo: string) => Promise<unknown>>()
}))
vi.mock('../src/main/git/env', () => ({ hostGitAccessForRepo: accessMock }))

const { buildGithubHttpServer } = await import('../src/main/mcp/githubServer')

// --- fixtures: fake git/gh on PATH, recording every invocation --------------

// realpath: the fake tools print $PWD, which the shell resolves physically
// (mkdtemp under os.tmpdir() is a symlinked path on macOS).
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-ghmcp-')))
const binDir = path.join(tmp, 'bin')
const clone = path.join(tmp, 'clone')
const logFile = path.join(tmp, 'calls.log')
fs.mkdirSync(binDir)
fs.mkdirSync(clone)
fs.writeFileSync(logFile, '')

fs.writeFileSync(
  path.join(binDir, 'git'),
  `#!/bin/sh
echo "git $*" >> "$FAKE_LOG"
if [ -n "$FAKE_GIT_FAIL" ]; then
  echo "fake git failure" >&2
  exit 1
fi
echo "git-args:$*"
echo "cred:\${GURT_CRED_ID:-none}"
`,
  { mode: 0o755 }
)
fs.writeFileSync(
  path.join(binDir, 'gh'),
  `#!/bin/sh
echo "gh $*" >> "$FAKE_LOG"
echo "gh-args:$*"
echo "token:\${GH_TOKEN:-none}"
echo "host:\${GH_HOST:-none}"
echo "pwd:$PWD"
`,
  { mode: 0o755 }
)

const logLines = () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean)

const tokenEntry: CredentialEntry = {
  id: 'cred-1',
  label: 'work token',
  kind: 'git-token',
  hosts: ['github.com'],
  data: { secret: 'sekret-token', gitName: 'Octo', gitEmail: 'octo@example.com' }
}

/** A managed-mode access resolution wired to the fake tools. */
function managed(over: Partial<HostGitAccess> = {}, env: NodeJS.ProcessEnv = {}): HostGitAccess {
  return {
    mode: 'managed',
    env: { PATH: binDir, FAKE_LOG: logFile, GURT_CRED_ID: 'cred-1', ...env },
    gitArgs: ['-c', 'credential.helper=gurt'],
    host: 'github.com',
    resolution: { entry: tokenEntry, kind: 'git-token', source: 'link' },
    ...over
  }
}

beforeEach(() => {
  accessMock.mockReset()
  accessMock.mockResolvedValue(managed())
})

// --- the servers under test: one per mode, real HTTP ------------------------

const ref: EnvRef = { workspace: 'w', task: 't', env: 'dev', session: 's1' }
const fullSrv = buildGithubHttpServer(ref, 'alpha', clone, 'full', 'full-token')
const roSrv = buildGithubHttpServer(ref, 'alpha', clone, 'read-only', 'ro-token')
await new Promise<void>((r) => fullSrv.listen(0, '127.0.0.1', r))
await new Promise<void>((r) => roSrv.listen(0, '127.0.0.1', r))
const fullUrl = `http://127.0.0.1:${(fullSrv.address() as AddressInfo).port}/mcp/full-token`
const roUrl = `http://127.0.0.1:${(roSrv.address() as AddressInfo).port}/mcp/ro-token`

afterAll(() => {
  fullSrv.close()
  roSrv.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

// --- minimal MCP JSON-RPC client over fetch ---------------------------------

let id = 0
async function post(
  base: string,
  message: object,
  method = 'POST'
): Promise<{ status: number; body: any }> {
  const res = await fetch(base, {
    method,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: method === 'GET' ? undefined : JSON.stringify(message)
  })
  const text = await res.text()
  let body: any
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, body }
}

async function call(base: string, name: string, args: object = {}) {
  const { body } = await post(base, {
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: { name, arguments: args }
  })
  return {
    body,
    isError: body?.result?.isError === true,
    text: body?.result?.content?.[0]?.text ?? ''
  }
}

async function listTools(base: string): Promise<any[]> {
  const { body } = await post(base, { jsonrpc: '2.0', id: ++id, method: 'tools/list', params: {} })
  return body.result.tools
}

// --- tools/list + instructions: what each mode exposes ----------------------

it('full mode tools/list: pull, push and create_pull_request with a title/body schema', async () => {
  const tools = await listTools(fullUrl)
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['create_pull_request', 'git_pull', 'git_push'],
    'full mode exposes all three tools'
  )
  const pr = tools.find((t) => t.name === 'create_pull_request')
  assert.deepEqual(
    Object.keys(pr.inputSchema.properties).sort(),
    ['body', 'title'],
    'create_pull_request takes title + body'
  )
  assert.deepEqual(pr.inputSchema.required, ['title'], 'only the title is required')
})

it('read-only mode tools/list: exactly git_pull — no write tools', async () => {
  const tools = await listTools(roUrl)
  assert.deepEqual(tools.map((t) => t.name), ['git_pull'])
})

it('initialize: server instructions steer by mode', async () => {
  const init = (base: string) =>
    post(base, {
      jsonrpc: '2.0',
      id: ++id,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.0' }
      }
    })
  const full = (await init(fullUrl)).body.result.instructions
  const ro = (await init(roUrl)).body.result.instructions
  assert.match(full, /opening pull requests/, 'full mode advertises push/PR ops')
  assert.ok(!full.includes('read-only'), 'full mode has no read-only note')
  assert.match(ro, /pulling from origin/, 'read-only mode advertises pull only')
  assert.match(ro, /read-only/, 'read-only mode warns the agent not to publish')
})

// --- git_pull / git_push: host git with the resolved config -----------------

it('git_pull: runs host git in the clone with the resolved gitArgs and env', async () => {
  const r = await call(fullUrl, 'git_pull')
  assert.equal(r.isError, false)
  assert.ok(
    r.text.includes(`git-args:-C ${clone} -c credential.helper=gurt pull --ff-only`),
    `git got the -C dir, config args and pull --ff-only: ${r.text}`
  )
  assert.ok(r.text.includes('cred:cred-1'), 'the resolved credential env reached git')
})

it('git_push: pushes HEAD upstream with the same resolved config', async () => {
  const r = await call(fullUrl, 'git_push')
  assert.equal(r.isError, false)
  assert.ok(
    r.text.includes(`git-args:-C ${clone} -c credential.helper=gurt push -u origin HEAD`),
    `push argv: ${r.text}`
  )
})

it('blocked access: tool call is an isError result carrying the reason, git never runs', async () => {
  accessMock.mockResolvedValue({
    mode: 'blocked',
    env: {},
    gitArgs: [],
    host: null,
    resolution: null,
    reason: 'no credential resolves for github.com'
  } satisfies HostGitAccess)
  const before = logLines().length
  const r = await call(fullUrl, 'git_pull')
  assert.equal(r.isError, true)
  assert.equal(r.text, 'git access is blocked: no credential resolves for github.com')
  assert.equal(logLines().length, before, 'no command was executed')
})

it('git failure: exit code 1 maps to isError with the stderr text', async () => {
  accessMock.mockResolvedValue(managed({}, { FAKE_GIT_FAIL: '1' }))
  const r = await call(fullUrl, 'git_pull')
  assert.equal(r.isError, true)
  assert.ok(r.text.includes('fake git failure'), `stderr surfaced: ${r.text}`)
})

// --- read-only guard ---------------------------------------------------------

it('read-only server refuses write tool calls, and no command runs', async () => {
  const before = logLines().length
  for (const name of ['git_push', 'create_pull_request']) {
    const r = await call(roUrl, name, { title: 'x' })
    assert.equal(r.isError, true, `${name} is not callable in read-only mode`)
    assert.ok(r.text.includes(`Tool ${name} not found`), `the error names the missing tool: ${r.text}`)
  }
  assert.equal(logLines().length, before, 'neither git nor gh ran')
})

// --- create_pull_request: push, then gh with the forge credential -----------

it('create_pull_request: pushes first, then runs gh pr create with GH_TOKEN in the clone', async () => {
  const before = logLines().length
  const r = await call(fullUrl, 'create_pull_request', { title: 'My PR', body: 'Body text' })
  assert.equal(r.isError, false)
  assert.ok(
    r.text.includes('gh-args:pr create --title My PR --body Body text'),
    `gh argv carries the title/body: ${r.text}`
  )
  assert.ok(r.text.includes('token:sekret-token'), 'gh ran with the stored token as GH_TOKEN')
  assert.ok(r.text.includes('host:none'), 'github.com needs no GH_HOST')
  assert.ok(r.text.includes(`pwd:${clone}`), 'gh ran inside the clone')
  const calls = logLines().slice(before)
  assert.deepEqual(
    calls,
    [
      `git -C ${clone} -c credential.helper=gurt push -u origin HEAD`,
      'gh pr create --title My PR --body Body text'
    ],
    'push happens before gh, both with the expected argv'
  )
})

it('create_pull_request on an enterprise host: GH_HOST is set for gh', async () => {
  accessMock.mockResolvedValue(managed({ host: 'github.example.com' }))
  const r = await call(fullUrl, 'create_pull_request', { title: 'T' })
  assert.equal(r.isError, false)
  assert.ok(r.text.includes('host:github.example.com'), `GH_HOST reached gh: ${r.text}`)
  assert.ok(r.text.includes('token:sekret-token'))
})

it('create_pull_request: a failed push aborts — gh never runs', async () => {
  accessMock.mockResolvedValue(managed({}, { FAKE_GIT_FAIL: '1' }))
  const before = logLines().length
  const r = await call(fullUrl, 'create_pull_request', { title: 'T' })
  assert.equal(r.isError, true)
  assert.ok(r.text.includes('fake git failure'), `push error surfaced: ${r.text}`)
  const calls = logLines().slice(before)
  assert.equal(calls.length, 1, 'only the push ran')
  assert.ok(calls[0].startsWith('git '), 'and it was git, not gh')
})

it('create_pull_request: no forge provider for the host → isError, gh never runs', async () => {
  accessMock.mockResolvedValue(managed({ host: 'gitlab.example.com' }))
  const before = logLines().length
  const r = await call(fullUrl, 'create_pull_request', { title: 'T' })
  assert.equal(r.isError, true)
  assert.equal(r.text, 'no forge provider matches host "gitlab.example.com"')
  assert.ok(!logLines().slice(before).some((l) => l.startsWith('gh ')), 'gh never ran')
})

it('create_pull_request: credential without a usable secret → isError', async () => {
  const bare = { ...tokenEntry, data: { ...tokenEntry.data, secret: '' } }
  accessMock.mockResolvedValue(
    managed({ resolution: { entry: bare, kind: 'git-token', source: 'link' } })
  )
  const r = await call(fullUrl, 'create_pull_request', { title: 'T' })
  assert.equal(r.isError, true)
  assert.ok(r.text.includes('cannot serve the github API'), r.text)
})

it('create_pull_request under ambient access: host env as-is, no injected token or config', async () => {
  accessMock.mockResolvedValue({
    mode: 'ambient',
    env: { PATH: binDir, FAKE_LOG: logFile },
    gitArgs: [],
    host: 'github.com',
    resolution: { entry: { ...tokenEntry, kind: 'git-host' }, kind: 'git-host', source: 'match' }
  } satisfies HostGitAccess)
  const before = logLines().length
  const r = await call(fullUrl, 'create_pull_request', { title: 'T' })
  assert.equal(r.isError, false)
  assert.ok(r.text.includes('token:none'), 'no GH_TOKEN injected for ambient auth')
  assert.equal(
    logLines().slice(before)[0],
    `git -C ${clone} push -u origin HEAD`,
    'push ran without managed -c config'
  )
})

it('create_pull_request without a title: schema rejection, nothing runs', async () => {
  const before = logLines().length
  const r = await call(fullUrl, 'create_pull_request', { body: 'no title' })
  assert.equal(r.isError, true, 'missing title is rejected')
  assert.ok(r.text.includes('Invalid arguments'), `validation error surfaced: ${r.text}`)
  assert.equal(logLines().length, before, 'no command was executed')
})

// --- transport guards --------------------------------------------------------

it('transport guards: wrong/cross token → 404, GET → 405', async () => {
  const rpc = { jsonrpc: '2.0', id: ++id, method: 'tools/list', params: {} }
  const base = fullUrl.slice(0, fullUrl.lastIndexOf('/mcp/'))
  assert.equal((await post(`${base}/mcp/nope`, rpc)).status, 404)
  assert.equal((await post(`${base}/other`, rpc)).status, 404)
  // each server only answers its own token: the read-only token on the full server is a 404
  assert.equal((await post(`${base}/mcp/ro-token`, rpc)).status, 404)
  assert.equal((await post(fullUrl, rpc, 'GET')).status, 405)
})
