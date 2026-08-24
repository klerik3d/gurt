// Pure-node test for the `gurt` host MCP server: the turn contract (§7.1 of
// docs/requirements-turn-contract.md) and the per-role tool set (§5 of
// docs/requirements-session-roles.md). No docker, no electron: it bundles the
// server with esbuild and drives it over real HTTP with MCP JSON-RPC. Harness
// style of scripts/session-log.test.mjs.
//
//   node scripts/gurt-mcp.test.mjs
import { test, after } from 'node:test'
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-mcp-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await build({
  stdin: {
    contents: `export { buildGurtHttpServer } from ${S('src/main/mcp/gurtServer.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  // jsonc-parser's `main` is a UMD build esbuild can't wrap into ESM output —
  // prefer each package's ESM entry, like vite does.
  mainFields: ['module', 'main'],
  outfile,
  logLevel: 'silent'
})

const { buildGurtHttpServer } = await import(pathToFileURL(outfile).href)

const TOKEN = 'test-token'
/** Payloads the host callbacks received — the machine-readable outcomes. */
const received = []
const drafted = []
/** Whatever the next `create_session` should do: return a draft, or throw the
 *  way a host-side rule (role gating, unknown repo) does. */
/** What the host callback answers with — a draft, or the rejection it throws.
 *  @type {{ sessionId: string, title: string } | Error} */
let draftResult = { sessionId: 'sess-1', title: 'fix review findings' }

/** One server per role, all on the same token — a session's role is fixed, so
 *  each is exactly what one session would be handed. */
const servers = {}
const ports = {}
for (const role of ['executor', 'researcher', 'reviewer']) {
  const server = buildGurtHttpServer(TOKEN, {
    role,
    onComplete: (p) => received.push(p),
    onCreateSession: async (req) => {
      drafted.push({ role, req })
      if (draftResult instanceof Error) throw draftResult
      return draftResult
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  servers[role] = server
  ports[role] = server.address().port
}

const url = (role, token = TOKEN) => `http://127.0.0.1:${ports[role]}/mcp/${token}`

/**
 * POST one JSON-RPC message; returns { status, body }.
 * @param {unknown} message
 * @param {{ role?: string, token?: string, method?: string }} [opts]
 */
async function post(message, { role = 'executor', token, method = 'POST' } = {}) {
  const res = await fetch(url(role, token), {
    method,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: method === 'GET' ? undefined : JSON.stringify(message)
  })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, body }
}

let id = 0
/** Call a tool; returns { isError, text }. */
async function call(name, args, role = 'executor') {
  const { body } = await post(
    { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } },
    { role }
  )
  return { isError: body.result?.isError === true, text: body.result?.content?.[0]?.text ?? '' }
}
const complete = (args) => call('complete', args, 'executor')

/** tools/list for one role, as name → tool. */
async function tools(role) {
  const { body } = await post({ jsonrpc: '2.0', id: ++id, method: 'tools/list', params: {} }, { role })
  return Object.fromEntries(body.result.tools.map((t) => [t.name, t]))
}

// --- tools/list: exactly `complete`, with a real (non-empty, strict) schema ---
test('tools/list', async () => {
  const executorTools = await tools('executor')
  assert.deepEqual(Object.keys(executorTools), ['complete'], 'executor gets exactly `complete`')
  const schema = executorTools.complete.inputSchema
  assert.equal(schema.additionalProperties, false, 'input schema rejects unknown keys')
  assert.deepEqual(
    Object.keys(schema.properties).sort(),
    ['commit', 'notes', 'outcome', 'pr', 'reason', 'version'],
    'input schema advertises the proposal fields'
  )
})

// --- valid changes call → callback gets the payload, result not an error ----
test('valid changes', async () => {
  const before = received.length
  const ok = await complete({ version: 1, outcome: 'changes', commit: { subject: 'do the thing' } })
  assert.equal(ok.isError, false, 'valid changes call is not an error')
  assert.equal(received.length, before + 1, 'valid call fired the callback exactly once')
  assert.deepEqual(received[received.length - 1], {
    version: 1,
    outcome: 'changes',
    commit: { subject: 'do the thing' }
  })
})

// valid no_changes and blocked (+ optional pr on changes) also succeed --------
test('valid no_changes / blocked / changes+pr', async () => {
  assert.equal((await complete({ version: 1, outcome: 'no_changes' })).isError, false)
  assert.equal(
    (await complete({ version: 1, outcome: 'blocked', reason: 'missing credentials' })).isError,
    false
  )
  assert.equal(
    (
      await complete({
        version: 1,
        outcome: 'changes',
        commit: { subject: 's', body: 'b' },
        pr: { title: 't' }
      })
    ).isError,
    false
  )
})

// --- invalid calls: isError, and the callback never fires -------------------
test('invalid calls rejected, callback untouched', async () => {
  const guard = received.length
  const rejects = [
    ['changes without commit', { version: 1, outcome: 'changes' }],
    ['blocked without reason', { version: 1, outcome: 'blocked' }],
    ['commit outside changes', { version: 1, outcome: 'no_changes', commit: { subject: 's' } }],
    ['reason outside blocked', { version: 1, outcome: 'no_changes', reason: 'x' }],
    ['unknown top-level key', { version: 1, outcome: 'no_changes', bogus: 1 }],
    ['wrong version literal', { version: 2, outcome: 'no_changes' }],
    ['multi-line subject', { version: 1, outcome: 'changes', commit: { subject: 'a\nb' } }],
    ['over-long subject', { version: 1, outcome: 'changes', commit: { subject: 'x'.repeat(121) } }]
  ]
  for (const [label, args] of rejects) {
    const r = await complete(args)
    assert.equal(r.isError, true, `${label} → isError`)
  }
  assert.equal(received.length, guard, 'no rejected call reached the host callback')
})

// --- per-role tool sets (roles doc §5) --------------------------------------
test('per-role tool sets', async () => {
  const researcherTools = await tools('researcher')
  assert.deepEqual(
    Object.keys(researcherTools),
    ['create_session'],
    'a researcher gets create_session and NO complete'
  )
  const reviewerTools = await tools('reviewer')
  assert.deepEqual(
    Object.keys(reviewerTools),
    ['create_session'],
    'a reviewer gets create_session and NO complete'
  )
  // The offered `role` is narrowed per spawner: a reviewer may only draft the
  // executor that fixes its findings, so the schema itself says so.
  assert.deepEqual(
    researcherTools.create_session.inputSchema.properties.role.enum,
    ['executor', 'reviewer'],
    'a researcher may draft executors and reviewers'
  )
  assert.deepEqual(
    reviewerTools.create_session.inputSchema.properties.role.enum,
    ['executor'],
    'a reviewer may draft executors only'
  )
  // Cross-task drafting is researcher-only, and the schema itself says so: a
  // reviewer's tool cannot even express a `task`.
  assert.ok(
    'task' in researcherTools.create_session.inputSchema.properties,
    'a researcher may aim a draft at another task'
  )
  assert.ok(
    !('task' in reviewerTools.create_session.inputSchema.properties),
    'a reviewer has no `task` field at all'
  )
})

// --- create_session: valid call reaches the host, result names the draft ----
test('create_session', async () => {
  const draftedBefore = drafted.length
  const spawn = await call(
    'create_session',
    { role: 'executor', repos: ['alpha'], prompt: 'fix the findings below', title: 'fixer' },
    'reviewer'
  )
  assert.equal(spawn.isError, false, 'valid create_session is not an error')
  assert.equal(drafted.length, draftedBefore + 1, 'it reached the host exactly once')
  assert.deepEqual(drafted[drafted.length - 1].req, {
    role: 'executor',
    repos: ['alpha'],
    prompt: 'fix the findings below',
    title: 'fixer'
  })
  assert.match(spawn.text, /sess-1/, 'the result carries the draft id')
  assert.match(spawn.text, /launch/, 'the result says the user still has to launch it')

  // A researcher aiming the draft at another task: the name reaches the host
  // verbatim and the result names the destination.
  const crossSpawn = await call(
    'create_session',
    { role: 'executor', repos: ['alpha'], prompt: 'p', task: 'spinoff' },
    'researcher'
  )
  assert.equal(crossSpawn.isError, false, 'a researcher cross-task spawn is not an error')
  assert.equal(drafted[drafted.length - 1].req.task, 'spinoff', 'the task name reaches the host')
  assert.match(crossSpawn.text, /in task "spinoff"/, 'the result names the target task')
  // The reviewer's schema has no `task`, so the same call is a schema error.
  const reviewerCross = await call(
    'create_session',
    { role: 'executor', repos: ['alpha'], prompt: 'p', task: 'spinoff' },
    'reviewer'
  )
  assert.equal(reviewerCross.isError, true, 'a reviewer cannot express a cross-task draft')
})

// --- create_session rejections ---------------------------------------------
test('tool gating per role', async () => {
  const spawnGuard = drafted.length
  /** @type {[label: string, args: object, role: string][]} */
  const badSpawns = [
    ['role a reviewer may not draft', { role: 'reviewer', repos: ['a'], prompt: 'p' }, 'reviewer'],
    ['role no one may draft', { role: 'researcher', repos: ['a'], prompt: 'p' }, 'researcher'],
    ['no repo', { role: 'executor', repos: [], prompt: 'p' }, 'researcher'],
    ['two repos', { role: 'executor', repos: ['a', 'b'], prompt: 'p' }, 'researcher'],
    ['empty prompt', { role: 'executor', repos: ['a'], prompt: '' }, 'researcher'],
    ['unknown key', { role: 'executor', repos: ['a'], prompt: 'p', bogus: 1 }, 'researcher']
  ]
  for (const [label, args, role] of badSpawns) {
    const r = await call('create_session', args, role)
    assert.equal(r.isError, true, `${label} → isError`)
  }
  assert.equal(drafted.length, spawnGuard, 'no rejected spawn reached the host callback')

  // A host-side rule (unknown repo, role gating in the session manager) reads
  // like a schema failure to the agent: isError + the message, not a crash.
  draftResult = new Error('repo "nope" is not registered in "w"')
  const hostReject = await call(
    'create_session',
    { role: 'executor', repos: ['nope'], prompt: 'p' },
    'researcher'
  )
  assert.equal(hostReject.isError, true, 'a host-side rejection is an isError result')
  assert.match(hostReject.text, /not registered/, 'and carries the host message')
  draftResult = { sessionId: 'sess-1', title: 'fix review findings' }

  // The executor has no create_session at all — calling it is an error, and it
  // never reaches the host.
  const notOffered = await call('create_session', { role: 'executor', repos: ['a'], prompt: 'p' })
  assert.equal(notOffered.isError, true, 'an executor cannot spawn')
  // …and neither role without the contract can report a proposal.
  const noComplete = await call('complete', { version: 1, outcome: 'no_changes' }, 'researcher')
  assert.equal(noComplete.isError, true, 'a researcher has no `complete` tool')
})

// --- transport guards -------------------------------------------------------
test('token / method guards', async () => {
  assert.equal((await post({ jsonrpc: '2.0', id: ++id, method: 'tools/list' }, { token: 'nope' })).status, 404, 'wrong token → 404')
  assert.equal((await post({}, { method: 'GET' })).status, 405, 'GET → 405')
})

after(() => {
  for (const server of Object.values(servers)) server.close()
  fs.rmSync(outfile, { force: true })
})
