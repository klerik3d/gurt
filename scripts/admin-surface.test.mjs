// The derived admin surface (docs/requirements-session-operator.md §3,
// acceptance §12 item 3), driven over real HTTP with MCP JSON-RPC the way
// gurt-mcp.test.mjs drives the turn contract: every GurtApi method is
// annotated, the generated tool list is exactly the read+write set,
// regenerating produces no diff, `ws` is absent from every schema and a call
// cannot reach another workspace, credentials come back valueless, snapshots
// come back chat-less, and every `none` method — and, in phase 1, every
// `write` method — is unreachable by any tool name.
//
//   node scripts/admin-surface.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-admin-'))
process.env.GURT_ROOT = GURT_ROOT
process.env.GURT_FORCE_PLAINTEXT = '1'

const outfile = path.join(os.tmpdir(), `gurt-admin-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await bundle({
  stdin: {
    contents:
      `export { createKernel } from ${S('src/main/kernel.ts')}\n` +
      `export { createAdminSurface } from ${S('src/main/adminSurface.ts')}\n` +
      `export { buildGurtHttpServer } from ${S('src/main/mcp/gurtServer.ts')}\n` +
      `export { ADMIN_TOOLS } from ${S('src/shared/adminTools.generated.ts')}\n` +
      `export { API_METHODS, METHOD_EXPOSURE } from ${S('src/shared/api.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  external: ['electron'],
  outfile
})

const m = await import(pathToFileURL(outfile).href)

const snake = (name) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

// --- two workspaces, so the binding has something to be tested against ------

for (const [ws, repo] of [
  ['w', 'alpha'],
  ['w2', 'beta']
]) {
  fs.mkdirSync(path.join(GURT_ROOT, ws, 't'), { recursive: true })
  fs.writeFileSync(
    path.join(GURT_ROOT, ws, 'workspace.json'),
    JSON.stringify({
      repos: [{ name: repo, url: `https://github.com/o/${repo}.git` }],
      envs: [{ name: 'dev', devcontainer: '{"image":"x"}', repo }],
      mcpServers: [
        { id: `${ws}-up`, url: 'https://mcp.example/mcp' },
        { id: `${ws}-local`, kind: 'command', command: '/bin/echo' }
      ]
    })
  )
  fs.writeFileSync(path.join(GURT_ROOT, ws, 't', 'task.json'), JSON.stringify({}))
}
fs.writeFileSync(path.join(GURT_ROOT, 'agents.json'), JSON.stringify({}))
fs.writeFileSync(
  path.join(GURT_ROOT, 'credentials.json'),
  JSON.stringify({
    credentials: [
      {
        id: 'cred-1',
        label: 'linear token',
        kind: 'mcp-token',
        hosts: [],
        data: { secret: 'sk-super-secret-value-42' }
      }
    ]
  })
)

const kernel = m.createKernel()
await kernel.ready
const admin = m.createAdminSurface(kernel)

// The operator's server for workspace `w`, hooks bound exactly as the session
// manager binds them (sessions.ts `gurtHooks`).
const TOKEN = 'test-token'
const server = m.buildGurtHttpServer(TOKEN, {
  role: 'operator',
  onComplete: () => {},
  onCreateSession: async () => ({ sessionId: 'x', title: 'x' }),
  admin: {
    call: (method, args) => admin.call('w', method, args),
    provisioningLog: (key, tail) => admin.provisioningLog('w', key, tail)
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}/mcp/${TOKEN}`

let id = 0
async function post(message) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify(message)
  })
  const text = await res.text()
  try {
    return { status: res.status, body: JSON.parse(text) }
  } catch {
    return { status: res.status, body: text }
  }
}

async function listTools() {
  const { body } = await post({ jsonrpc: '2.0', id: ++id, method: 'tools/list', params: {} })
  return body.result.tools.map((t) => t.name)
}

/** Call a tool; returns { isError, error, text }. */
async function call(name, args = {}) {
  const { body } = await post({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: { name, arguments: args }
  })
  if (body.error) return { isError: true, error: body.error, text: '' }
  return {
    isError: body.result.isError === true,
    text: (body.result.content ?? []).map((c) => c.text).join('\n')
  }
}

after(() => {
  server.close()
  server.closeAllConnections()
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

// --- the annotation covers everything, at runtime too -----------------------

test('every GurtApi method carries an exposure annotation', () => {
  for (const method of m.API_METHODS)
    assert.ok(
      ['read', 'write', 'none'].includes(m.METHOD_EXPOSURE[method]),
      `${method} is annotated`
    )
})

test('the generated tool list is exactly the read+write set, snake_cased', () => {
  const expected = m.API_METHODS.filter((x) => m.METHOD_EXPOSURE[x] !== 'none').sort()
  const generated = m.ADMIN_TOOLS.map((d) => d.method).sort()
  assert.deepEqual(generated, expected, 'one tool per read/write method, none for none')
  for (const def of m.ADMIN_TOOLS) {
    assert.equal(def.name, snake(def.method), `${def.method} → ${def.name}`)
    assert.equal(def.exposure, m.METHOD_EXPOSURE[def.method], 'exposure carried through')
  }
})

test('regenerating produces no diff', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'gen-admin-tools.mjs'), '--check'], {
    cwd: ROOT,
    encoding: 'utf8'
  })
  assert.equal(r.status, 0, `gen-admin-tools --check clean:\n${r.stdout}${r.stderr}`)
})

test('`ws` is absent from every schema', () => {
  for (const def of m.ADMIN_TOOLS) {
    assert.ok(!('ws' in def.input), `${def.name} schema has no ws`)
    assert.ok(!def.params.includes('ws'), `${def.name} params have no ws`)
  }
})

// --- the offered tool set (phase 1: reads only) -----------------------------

test('tools/list offers exactly the read tools + get_provisioning_log', async () => {
  const names = await listTools()
  const readTools = m.ADMIN_TOOLS.filter((d) => d.exposure === 'read').map((d) => d.name)
  assert.deepEqual(
    names.sort(),
    [...readTools, 'get_provisioning_log'].sort(),
    'read set + the one extra tool; no complete, no create_session, no writes'
  )
})

test('every none — and, in phase 1, every write — method is unreachable by any tool name', async () => {
  const unreachable = m.API_METHODS.filter((x) => m.METHOD_EXPOSURE[x] !== 'read').map(snake)
  for (const name of unreachable) {
    const r = await call(name, {})
    assert.ok(r.isError, `${name} is not callable`)
  }
})

// --- the workspace binding (§3.2) -------------------------------------------

test('a call cannot reach another workspace', async () => {
  const tree = await call('get_tree')
  assert.ok(!tree.isError, tree.text)
  const parsed = JSON.parse(tree.text)
  assert.deepEqual(
    parsed.workspaces.map((w) => w.name),
    ['w'],
    'the tree is the bound workspace and nothing else'
  )
  // A session of the other workspace answers exactly like a session that does
  // not exist.
  const foreign = kernel.sessions.createSession(
    { workspace: 'w2', task: 't', env: 'dev' },
    ['beta'], 'a1', 'the secret plan', 'draft', [], true, {}, 'executor'
  )
  const snap = await call('session_snapshot', { id: foreign.id })
  assert.equal(snap.text.trim(), 'null', 'another workspace’s session is unknown')
  const traffic = await call('session_traffic', { id: foreign.id })
  assert.ok(traffic.isError, 'traffic of another workspace’s session refused')
  const log = await call('get_provisioning_log', { key: `env-build:w2/dev` })
  assert.ok(log.isError, 'another workspace’s build log refused')
  const mcp = await call('get_mcp_servers')
  assert.match(mcp.text, /w-up/, 'own registry visible')
  assert.ok(!/w2-up/.test(mcp.text), 'other workspace’s registry not reachable')
  kernel.sessions.deleteSession(foreign.id)
})

// --- the §3.2 narrowings ----------------------------------------------------

test('get_credentials returns no secret value', async () => {
  const r = await call('get_credentials')
  assert.ok(!r.isError, r.text)
  assert.ok(!r.text.includes('sk-super-secret-value-42'), 'no raw value')
  assert.ok(
    !r.text.includes(Buffer.from('sk-super-secret-value-42').toString('base64')),
    'no base64 value'
  )
  assert.match(r.text, /"cred-1"/, 'the id is there')
  assert.match(r.text, /linear token/, 'the label is there')
  assert.match(r.text, /\[redacted\]/, 'the value slot says why it is empty')
})

test('session_snapshot returns no chat', async () => {
  const s = kernel.sessions.createSession(
    { workspace: 'w', task: 't', env: 'dev' },
    ['alpha'], 'a1', 'the confidential start prompt', 'draft', [], true, {}, 'executor'
  )
  const r = await call('session_snapshot', { id: s.id })
  assert.ok(!r.isError, r.text)
  const snap = JSON.parse(r.text)
  assert.ok(!('entries' in snap), 'no timeline entries')
  assert.ok(!('pending' in snap), 'no queued prompt texts')
  assert.ok(!('proposal' in snap), 'no proposal prose')
  assert.equal(snap.info.startPrompt, '', 'no start prompt')
  assert.ok(!r.text.includes('confidential'), 'nothing the user typed leaks')
  assert.equal(snap.info.state, 'draft', 'state is there — the diagnostic need')
  kernel.sessions.deleteSession(s.id)
})

test('probe of a local entry resolves by saved id only', async () => {
  // An unsaved local entry is arbitrary host execution — refused with a
  // sentence pointing at Settings (§6's rule, applied at the host).
  const unsaved = await call('probe_mcp_server', {
    entry: { id: 'evil', kind: 'command', command: '/bin/echo' }
  })
  assert.ok(unsaved.isError, 'unsaved local entry refused')
  assert.match(unsaved.text, /saved/, 'the refusal says why')
  // A saved one probes the SAVED entry: pass a doctored command under a saved
  // id and assert what runs is the registry's own (echo answers no MCP, so the
  // probe reports a failure — but it must be /bin/echo failing, not /bin/rm).
  const doctored = await call('probe_mcp_server', {
    entry: { id: 'w-local', kind: 'command', command: '/bin/rm', args: ['-rf', '/tmp/x'] }
  })
  assert.ok(!doctored.isError, doctored.text)
  assert.ok(!doctored.text.includes('/bin/rm'), 'the doctored command never ran')
})
