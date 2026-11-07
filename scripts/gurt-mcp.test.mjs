// Pure-node test for the `gurt` host MCP server: the turn contract (§7.1 of
// docs/requirements-turn-contract.md), the per-role tool set (§4 of
// docs/requirements-repo-mounts.md) and the mount table in the instructions.
// No docker, no electron: it bundles the
// server with esbuild and drives it over real HTTP with MCP JSON-RPC. Harness
// style of scripts/session-log.test.mjs.
//
//   node scripts/gurt-mcp.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-mcp-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await bundle({
  stdin: {
    contents: `export { buildGurtHttpServer, instructionsFor } from ${S('src/main/mcp/gurtServer.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})

const { buildGurtHttpServer, instructionsFor } = await import(pathToFileURL(outfile).href)

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
for (const role of ['executor', 'researcher', 'inspector']) {
  const server = buildGurtHttpServer(TOKEN, {
    role,
    // Stands in for the session manager's host-side rule: a repo it does not
    // write is refused by throwing, which the tool turns into `isError`.
    onComplete: (p) => {
      if (p.repos?.some((r) => r.repo === 'nope')) throw new Error('repo "nope" is not mounted for write')
      received.push(p)
    },
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
    ['commit', 'notes', 'outcome', 'pr', 'reason', 'repos', 'version'],
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

// --- per-repo proposals (repo-mounts §3) ------------------------------------
test('per-repo proposals', async () => {
  const before = received.length
  const ok = await complete({
    version: 1,
    outcome: 'changes',
    repos: [
      { repo: 'alpha', commit: { subject: 'alpha: do it' } },
      { repo: 'beta', commit: { subject: 'beta: follow' }, pr: { title: 'beta pr' } }
    ]
  })
  assert.equal(ok.isError, false, 'repos alone satisfy "changes"')
  assert.equal(received.length, before + 1)
  assert.deepEqual(received.at(-1).repos.map((r) => r.repo), ['alpha', 'beta'])
  const both = await complete({
    version: 1,
    outcome: 'changes',
    commit: { subject: 'shared' },
    repos: [{ repo: 'alpha', commit: { subject: 'own' } }]
  })
  assert.equal(both.isError, false, 'a shared commit and per-repo entries may go together')
  const refused = await complete({
    version: 1,
    outcome: 'changes',
    repos: [{ repo: 'nope', commit: { subject: 's' } }]
  })
  assert.equal(refused.isError, true, 'a host-side refusal is an isError result')
  assert.match(refused.text, /not mounted for write/, 'carrying the host message')
  assert.equal(received.length, before + 2, 'the refused call recorded nothing')
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
    ['over-long subject', { version: 1, outcome: 'changes', commit: { subject: 'x'.repeat(121) } }],
    ['repos outside changes', { version: 1, outcome: 'no_changes', repos: [{ repo: 'a', commit: { subject: 's' } }] }],
    ['empty repos', { version: 1, outcome: 'changes', repos: [] }],
    ['repo entry without commit', { version: 1, outcome: 'changes', repos: [{ repo: 'a' }] }]
  ]
  for (const [label, args] of rejects) {
    const r = await complete(args)
    assert.equal(r.isError, true, `${label} → isError`)
  }
  assert.equal(received.length, guard, 'no rejected call reached the host callback')
})

// --- per-role tool sets (repo-mounts §4) ------------------------------------
test('per-role tool sets', async () => {
  const researcherTools = await tools('researcher')
  assert.deepEqual(
    Object.keys(researcherTools),
    ['create_session'],
    'a researcher gets create_session and NO complete'
  )
  // No admin hooks wired here: an inspector's server is create_session alone.
  const inspectorTools = await tools('inspector')
  assert.deepEqual(Object.keys(inspectorTools), ['create_session'], 'an inspector gets create_session and NO complete')
  // The offered `role` is narrowed per spawner, in the schema itself.
  assert.deepEqual(
    researcherTools.create_session.inputSchema.properties.role.enum,
    ['executor', 'researcher'],
    'a researcher may draft executors and researchers'
  )
  assert.deepEqual(
    inspectorTools.create_session.inputSchema.properties.role.enum,
    ['operator'],
    'an inspector may draft the operator only'
  )
  for (const [role, t] of Object.entries({ researcher: researcherTools, inspector: inspectorTools })) {
    const props = t.create_session.inputSchema.properties
    assert.ok('task' in props, `${role} may aim a draft at another task`)
    // Repos come with their mode, and the mode is required: the agent states
    // how each repo is mounted, the way a user does.
    const item = props.repos.items
    assert.deepEqual(Object.keys(item.properties).sort(), ['mode', 'name'], `${role}: repos are { name, mode }`)
    assert.deepEqual(item.required.sort(), ['mode', 'name'], `${role}: both required`)
    assert.deepEqual(item.properties.mode.enum, ['write', 'read-locked', 'read'], `${role}: the three modes`)
    // The env rule is carried by the schema, not by a warning the agent has
    // to remember.
    assert.match(
      props.env.description,
      /target repo's own default environment/,
      `${role}: \`env\` documents the repo-based default, not the caller's env`
    )
    assert.equal(props.confirmNonDefaultEnv.type, 'boolean', `${role}: a non-default container takes an explicit confirmation`)
    assert.ok(
      !(t.create_session.inputSchema.required ?? []).includes('confirmNonDefaultEnv'),
      `${role}: which is optional — the common case names no env at all`
    )
  }
})

// --- the mount table rides the instructions ---------------------------------
test('instructions state each repo and its mode', () => {
  const text = instructionsFor('executor', [
    { repo: 'alpha', mode: 'write' },
    { repo: 'beta', mode: 'read-locked' },
    { repo: 'gamma', mode: 'read' }
  ])
  assert.match(text, /\/workspaces\/alpha — writable/)
  assert.match(text, /\/workspaces\/beta — read-only — the working tree does not move/)
  assert.match(text, /\/workspaces\/gamma — read-only — other sessions may change it/)
  assert.doesNotMatch(text, /`repos`/, 'one writable repo: no per-repo rule to explain')
  const multi = instructionsFor('executor', [
    { repo: 'alpha', mode: 'write' },
    { repo: 'beta', mode: 'write' }
  ])
  assert.match(multi, /its own commit in\n`complete`'s `repos`/, 'several writable repos: the per-repo rule is stated')
  assert.match(instructionsFor('researcher', []), /No repository is mounted/)
  assert.doesNotMatch(instructionsFor('researcher', []), /mounted read-only and you/, 'the role text claims nothing about mounts')
})

// --- create_session: valid call reaches the host, result names the draft ----
test('create_session', async () => {
  const draftedBefore = drafted.length
  const spawn = await call(
    'create_session',
    { role: 'researcher', repos: [{ name: 'alpha', mode: 'read-locked' }], prompt: 'review the changes', title: 'review' },
    'researcher'
  )
  assert.equal(spawn.isError, false, 'valid create_session is not an error')
  assert.equal(drafted.length, draftedBefore + 1, 'it reached the host exactly once')
  assert.deepEqual(drafted[drafted.length - 1].req, {
    role: 'researcher',
    repos: ['alpha'],
    repoModes: { alpha: 'read-locked' },
    prompt: 'review the changes',
    title: 'review'
  }, 'the { name, mode } list reaches the host as names + modes')
  assert.match(spawn.text, /sess-1/, 'the result carries the draft id')
  assert.match(spawn.text, /launch/, 'the result says the user still has to launch it')

  const crossSpawn = await call(
    'create_session',
    { role: 'executor', repos: [{ name: 'alpha', mode: 'write' }, { name: 'beta', mode: 'write' }], prompt: 'p', task: 'spinoff' },
    'researcher'
  )
  assert.equal(crossSpawn.isError, false, 'a cross-task spawn of several repos is not an error')
  assert.equal(drafted[drafted.length - 1].req.task, 'spinoff', 'the task name reaches the host')
  assert.match(crossSpawn.text, /in task "spinoff"/, 'the result names the target task')

  const op = await call('create_session', { role: 'operator', repos: [], prompt: 'add the env' }, 'inspector')
  assert.equal(op.isError, false, 'an inspector drafts a repo-less operator')
})

// --- create_session rejections ---------------------------------------------
test('tool gating per role', async () => {
  const spawnGuard = drafted.length
  /** @type {[label: string, args: object, role: string][]} */
  const badSpawns = [
    ['role an inspector may not draft', { role: 'executor', repos: [], prompt: 'p' }, 'inspector'],
    ['role a researcher may not draft', { role: 'operator', repos: [], prompt: 'p' }, 'researcher'],
    ['the reviewer is gone', { role: 'reviewer', repos: [], prompt: 'p' }, 'researcher'],
    ['a repo without a mode', { role: 'executor', repos: [{ name: 'a' }], prompt: 'p' }, 'researcher'],
    ['a bare repo name', { role: 'executor', repos: ['a'], prompt: 'p' }, 'researcher'],
    ['an unknown mode', { role: 'executor', repos: [{ name: 'a', mode: 'rw' }], prompt: 'p' }, 'researcher'],
    ['empty prompt', { role: 'executor', repos: [], prompt: '' }, 'researcher'],
    ['unknown key', { role: 'executor', repos: [], prompt: 'p', bogus: 1 }, 'researcher']
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
    { role: 'executor', repos: [{ name: 'nope', mode: 'write' }], prompt: 'p' },
    'researcher'
  )
  assert.equal(hostReject.isError, true, 'a host-side rejection is an isError result')
  assert.match(hostReject.text, /not registered/, 'and carries the host message')
  draftResult = { sessionId: 'sess-1', title: 'fix review findings' }

  // The executor has no create_session at all — calling it is an error, and it
  // never reaches the host.
  const notOffered = await call('create_session', { role: 'executor', repos: [], prompt: 'p' })
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
