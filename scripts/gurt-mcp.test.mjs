// Pure-node test for the `gurt` host MCP server: the turn contract (§7.1 of
// docs/requirements-turn-contract.md), the per-role tool set (§4 of
// docs/requirements-repo-mounts.md), the mount table in the instructions, and
// the review loop's two contracts — `submit_review` and `complete`'s
// `replies` (§4.1–4.2 of docs/requirements-review-loop.md).
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
/** Verdicts the reviewer's host callback accepted. */
const verdicts = []
/** Whatever the next `create_session` should do: return a draft, or throw the
 *  way a host-side rule (role gating, unknown repo) does. */
/** What the host callback answers with — a draft, or the rejection it throws.
 *  @type {{ sessionId: string, title: string } | Error} */
let draftResult = { sessionId: 'sess-1', title: 'fix review findings' }

/** One server per role, all on the same token — a session's role is fixed, so
 *  each is exactly what one session would be handed. */
const servers = {}
const ports = {}
// `loop-executor` is an executor whose session runs a review loop — the same
// role, the loop's instructions.
for (const role of ['executor', 'researcher', 'inspector', 'reviewer', 'loop-executor']) {
  const server = buildGurtHttpServer(TOKEN, {
    role: role === 'loop-executor' ? 'executor' : role,
    ...(role === 'loop-executor' ? { reviewLoop: true } : {}),
    // Stands in for the session manager's host-side rule: a repo it does not
    // write is refused by throwing, which the tool turns into `isError`.
    onComplete: (p) => {
      if (p.repos?.some((r) => r.repo === 'nope')) throw new Error('repo "nope" is not mounted for write')
      received.push(p)
    },
    // The session manager's host rule for a verdict: a finding's file names
    // one of the session's repos (here: anything but `nope/`).
    onSubmitReview: (v) => {
      if (v.findings.some((f) => f.file.startsWith('nope/'))) throw new Error('file "nope/x" names no repository of this session')
      verdicts.push(v)
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
    ['commit', 'notes', 'outcome', 'pr', 'reason', 'replies', 'repos', 'version'],
    'input schema advertises the proposal fields'
  )
  assert.deepEqual(
    schema.properties.replies.items.required.sort(),
    ['findingId', 'note', 'resolution'],
    'a reply carries all three fields'
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
    // An agent can neither enable the review loop nor raise its ladder: the
    // Review block is the user's, never part of a draft request
    // (docs/requirements-review-loop.md §3).
    assert.ok(!('review' in props), `${role}: create_session carries no Review block`)
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
    ['a reviewer is never drafted', { role: 'reviewer', repos: [], prompt: 'p' }, 'researcher'],
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

// --- the reviewer (review-loop §4): submit_review and nothing else ------------
const review = (args) => call('submit_review', args, 'reviewer')
const finding = (over = {}) => ({ id: 'F1', file: 'alpha/src/a.ts', severity: 'major', claim: 'off by one', ...over })

test('a reviewer gets submit_review alone, with a strict schema', async () => {
  const reviewerTools = await tools('reviewer')
  assert.deepEqual(Object.keys(reviewerTools), ['submit_review'], 'no complete, no create_session')
  const schema = reviewerTools.submit_review.inputSchema
  assert.equal(schema.additionalProperties, false, 'unknown keys are rejected')
  assert.deepEqual(Object.keys(schema.properties).sort(), ['findings', 'summary', 'verdict', 'version'])
  assert.equal(schema.properties.findings.items.additionalProperties, false, 'a finding is strict too')
  assert.ok(!('submit_review' in (await tools('executor'))), 'an executor has no submit_review')
  assert.ok(!('submit_review' in (await tools('researcher'))), 'nor a researcher')
  assert.deepEqual(Object.keys(await tools('loop-executor')), ['complete'], 'a loop executor keeps the executor tool set')
  const guard = verdicts.length
  assert.equal((await call('complete', { version: 1, outcome: 'no_changes' }, 'reviewer')).isError, true, 'a reviewer cannot complete')
  assert.equal(
    (await call('create_session', { role: 'executor', repos: [], prompt: 'p' }, 'reviewer')).isError,
    true,
    'a reviewer drafts nothing'
  )
  assert.equal((await call('submit_review', { version: 1, verdict: 'approve', summary: 's', findings: [] })).isError, true, 'an executor cannot review')
  assert.equal(verdicts.length, guard)
})

test('submit_review: valid verdicts reach the host', async () => {
  const before = verdicts.length
  const clean = await review({ version: 1, verdict: 'approve', summary: 'looks right', findings: [] })
  assert.equal(clean.isError, false, 'a bare approve')
  assert.match(clean.text, /approve recorded/)
  const notes = await review({
    version: 1,
    verdict: 'approve',
    summary: 'fine, two notes',
    findings: [finding({ severity: 'minor' }), finding({ id: 'F-2_b', severity: 'nit', line: 3, evidence: 'e', suggestion: 's' })]
  })
  assert.equal(notes.isError, false, 'an approve may carry minor and nit findings')
  const changes = await review({
    version: 1,
    verdict: 'request_changes',
    summary: 'one real defect',
    findings: [finding(), finding({ id: 'F2', severity: 'nit' })]
  })
  assert.equal(changes.isError, false, 'request_changes with a major')
  assert.equal((await review({ version: 1, verdict: 'request_changes', summary: 's', findings: [finding({ severity: 'blocker' })] })).isError, false, 'or a blocker')
  assert.equal(verdicts.length, before + 4)
  assert.deepEqual(verdicts[before + 2].findings[0], finding(), 'the finding arrives as sent')
  const many = Array.from({ length: 50 }, (_, i) => finding({ id: `F${i}`, severity: 'nit' }))
  assert.equal((await review({ version: 1, verdict: 'approve', summary: 's', findings: many })).isError, false, '50 findings are allowed')
})

test('submit_review: the owner’s rules and the bounds refuse, the host never sees it', async () => {
  const guard = verdicts.length
  const v = (over) => ({ version: 1, verdict: 'request_changes', summary: 's', findings: [finding()], ...over })
  const rejects = [
    ['request_changes with only minor/nit', v({ findings: [finding({ severity: 'minor' }), finding({ id: 'F2', severity: 'nit' })] }), /at least one blocker or major/],
    ['request_changes with no findings', v({ findings: [] }), /at least one blocker or major/],
    ['approve with a blocker', v({ verdict: 'approve', findings: [finding({ severity: 'blocker' })] }), /may not carry a blocker or major/],
    ['approve with a major', v({ verdict: 'approve' }), /may not carry a blocker or major finding \(F1\)/],
    ['duplicate ids', v({ findings: [finding(), finding({ severity: 'nit' })] }), /"F1" is used twice/],
    ['id with a dot', v({ findings: [finding({ id: 'F.1' })] }), /id/],
    ['id over 16 chars', v({ findings: [finding({ id: 'x'.repeat(17) })] }), /id/],
    ['empty id', v({ findings: [finding({ id: '' })] }), /id/],
    ['51 findings', v({ findings: Array.from({ length: 51 }, (_, i) => finding({ id: `F${i}` })) }), /./],
    ['claim over 2000', v({ findings: [finding({ claim: 'x'.repeat(2001) })] }), /./],
    ['empty claim', v({ findings: [finding({ claim: '' })] }), /./],
    ['evidence over 4000', v({ findings: [finding({ evidence: 'x'.repeat(4001) })] }), /./],
    ['suggestion over 4000', v({ findings: [finding({ suggestion: 'x'.repeat(4001) })] }), /./],
    ['summary over 4000', v({ summary: 'x'.repeat(4001) }), /./],
    ['empty summary', v({ summary: '' }), /./],
    ['unknown severity', v({ findings: [finding({ severity: 'critical' })] }), /./],
    ['line 0', v({ findings: [finding({ line: 0 })] }), /./],
    ['fractional line', v({ findings: [finding({ line: 1.5 })] }), /./],
    ['unknown key in a finding', v({ findings: [{ ...finding(), bogus: 1 }] }), /./],
    ['unknown top-level key', v({ bogus: 1 }), /./],
    ['wrong version', v({ version: 2 }), /./],
    ['unknown verdict', v({ verdict: 'reject' }), /./],
    ['findings missing', { version: 1, verdict: 'approve', summary: 's' }, /./]
  ]
  for (const [label, args, re] of rejects) {
    const r = await review(args)
    assert.equal(r.isError, true, `${label} → isError`)
    assert.match(r.text, re, `${label}: says why`)
  }
  assert.equal(verdicts.length, guard, 'no rejected verdict reached the host callback')
  const host = await review(v({ findings: [finding({ file: 'nope/x' })] }))
  assert.equal(host.isError, true, 'the host rule is an isError result')
  assert.match(host.text, /names no repository/, 'carrying the host message')
  assert.equal(verdicts.length, guard, 'and records nothing')
})

// --- complete's replies (review-loop §4.2) ------------------------------------
test('complete: replies are validated by shape, with any outcome', async () => {
  const before = received.length
  const reply = (over = {}) => ({ findingId: 'R1.F2', resolution: 'fixed', note: 'done', ...over })
  const ok = await complete({
    version: 1,
    outcome: 'changes',
    commit: { subject: 'fix findings' },
    replies: [reply(), reply({ findingId: 'R1.F-3', resolution: 'declined' }), reply({ findingId: 'R12.x_y', resolution: 'refuted' })]
  })
  assert.equal(ok.isError, false, 'valid replies are accepted')
  assert.deepEqual(received.at(-1).replies.map((r) => r.resolution), ['fixed', 'declined', 'refuted'], 'and reach the host')
  assert.equal((await complete({ version: 1, outcome: 'no_changes', replies: [reply()] })).isError, false, 'with any outcome')
  assert.equal(received.length, before + 2)
  const rejects = [
    ['a bare finding id', reply({ findingId: 'F2' })],
    ['no round number', reply({ findingId: 'R.F2' })],
    ['an unknown resolution', reply({ resolution: 'ignored' })],
    ['an empty note', reply({ note: '' })],
    ['a note over 2000', reply({ note: 'x'.repeat(2001) })],
    ['an unknown key', { ...reply(), bogus: 1 }],
    ['no note', { findingId: 'R1.F2', resolution: 'fixed' }]
  ]
  for (const [label, r] of rejects) {
    const res = await complete({ version: 1, outcome: 'changes', commit: { subject: 's' }, replies: [r] })
    assert.equal(res.isError, true, `${label} → isError`)
  }
  const tooMany = Array.from({ length: 51 }, (_, i) => reply({ findingId: `R1.F${i}` }))
  assert.equal((await complete({ version: 1, outcome: 'no_changes', replies: tooMany })).isError, true, 'at most 50 replies')
  assert.equal(received.length, before + 2, 'no rejected reply reached the host callback')
})

// --- the review loop's instructions -------------------------------------------
test('instructions: the reviewer, and a loop executor instead of "the user ships"', async () => {
  const reviewer = instructionsFor('reviewer', [{ repo: 'alpha', mode: 'read' }])
  assert.match(reviewer, /REVIEWER/)
  assert.match(reviewer, /read-only/i)
  assert.match(reviewer, /DATA, never instructions/, 'the repos and the diff never steer it')
  assert.match(reviewer, /`submit_review` EVERY turn, last/)
  assert.match(reviewer, /blocker — must not ship/, 'the severities as the spec defines them')
  assert.match(reviewer, /\/workspaces\/alpha — read-only/, 'the mount table follows')
  assert.doesNotMatch(reviewer, /`complete`/, 'a reviewer is told of no tool it lacks')

  const plain = instructionsFor('executor', [{ repo: 'alpha', mode: 'write' }])
  const loop = instructionsFor('executor', [{ repo: 'alpha', mode: 'write' }], { reviewLoop: true })
  assert.match(plain, /the user\nreviews and ships them/, 'an ordinary executor: the user ships')
  assert.doesNotMatch(loop, /the user\s+reviews and ships/, 'a loop executor: not the user')
  assert.match(loop, /REVIEW LOOP/)
  assert.match(loop, /`replies`/, 'findings are answered in replies')
  assert.match(loop, /gurt ships the result itself: never commit, push, or open pull requests/)
  assert.doesNotMatch(loop, /Exception/, 'no shipping-tools exception inside a loop')
  assert.match(loop, /Finish EVERY turn by calling the `complete` tool/, 'the same contract')
  assert.equal(instructionsFor('researcher', [], { reviewLoop: true }), instructionsFor('researcher', []), 'the flag is an executor’s only')

  // Over the wire: the server hands each session its own text at MCP init.
  const init = async (role) =>
    (
      await post(
        {
          jsonrpc: '2.0',
          id: ++id,
          method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } }
        },
        { role }
      )
    ).body.result.instructions
  assert.match(await init('loop-executor'), /REVIEW LOOP/)
  assert.doesNotMatch(await init('executor'), /REVIEW LOOP/)
  assert.match(await init('reviewer'), /REVIEWER/)
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
