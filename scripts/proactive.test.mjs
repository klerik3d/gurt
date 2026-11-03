// Proactive agents (docs/design-proactive-agents.md), headless: the template
// that never runs, a run's tools (identity by ref, idempotent proposals,
// concurrent proposals, limits, deferrals, tombstones), the end of a run, the
// schedule clock, crash recovery, and the role's `gurt` tool set.
//
// No docker, no agent: a run's session is created as a draft (spawnRun is
// swapped for a copy that does not enqueue), so nothing ever starts — the
// tools are driven through the manager's hooks exactly as the `gurt` server
// would drive them.
//
//   node scripts/proactive.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

// GURT_ROOT must be set before the store module loads (read at import time).
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-proactive-'))
process.env.GURT_ROOT = GURT_ROOT
const outfile = path.join(os.tmpdir(), `gurt-proactive-${process.pid}.mjs`)

await bundle({
  stdin: {
    contents: [
      `export { createKernel } from ${S('src/main/kernel.ts')}`,
      `export { createTask, getTask, readProactiveState } from ${S('src/main/store.ts')}`,
      `export { assertRoleFitsRepos, nudgePromptFor, postTurnDecision } from ${S('src/main/sessions.ts')}`,
      `export { buildGurtHttpServer } from ${S('src/main/mcp/gurtServer.ts')}`,
      `export * from ${S('src/shared/proactive.ts')}`,
      `export { roleHasTurnContract, roleLocksClone, roleNeedsRepo, roleForbidsRepo, roleAllowsMultiRepo, USER_SESSION_ROLES } from ${S('src/shared/types.ts')}`
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})
const m = await import(pathToFileURL(outfile).href)

after(() => {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

const ws = 'w'
fs.mkdirSync(path.join(GURT_ROOT, ws), { recursive: true })
fs.writeFileSync(
  path.join(GURT_ROOT, ws, 'workspace.json'),
  JSON.stringify({
    repos: [
      { name: 'alpha', url: 'https://github.com/o/alpha.git' },
      { name: 'beta', url: 'https://github.com/o/beta.git' }
    ],
    envs: [{ name: 'dev', devcontainer: '{"image":"x"}', repo: 'alpha' }],
    defaultAgent: 'a1'
  })
)
fs.writeFileSync(path.join(GURT_ROOT, 'agents.json'), JSON.stringify({}))

const kernel = m.createKernel()
await kernel.ready
// The clock is driven by hand below.
kernel.proactive.stop()

// A run's session is a draft copy of the template: nothing starts, so nothing
// ends the run behind the test's back.
kernel.sessions.spawnRun = function (templateId, title) {
  const info = this.duplicateSession(templateId)
  this.renameSession(info.id, title)
  return info
}

const view = () => kernel.proactive.views(ws).find((a) => a.name === 'triage')
const tools = (runId) => kernel.proactive.hooksFor(ws, 'triage', runId)
const executor = (prompt = 'fix it') => ({ role: 'executor', repos: ['alpha'], prompt })
const endTurn = (sessionId) =>
  kernel.bus.emit('session.turn', { sessionId, ref: { workspace: ws, task: 'triage', env: 'operator' }, phase: 'ended', final: true })

// --- pure rules ---------------------------------------------------------------
test('refs, slugs, config, schedule', () => {
  assert.deepEqual(m.normalizeRefs([' sentry:1 ', 'sentry:1', 'mail:<a@b>']), ['sentry:1', 'mail:<a@b>'])
  assert.throws(() => m.normalizeRefs(['no colon']), /not a ref/)
  assert.throws(() => m.normalizeRefs(['Sentry:1']), /not a ref/, 'the source is lowercase')
  assert.equal(m.scopeSlug('Checkout crash: NPE in Cart!'), 'checkout-crash-npe-in-cart')
  assert.equal(m.scopeSlug('???'), 'proactive')
  const c = m.sanitizeProactiveConfig({ everyMinutes: 1, maxScopesPerRun: 999, enabled: 'yes', bogus: 1 })
  assert.equal(c.everyMinutes, 5, 'clamped to the bound')
  assert.equal(c.maxScopesPerRun, 50)
  assert.equal(c.enabled, false, 'a non-boolean keeps the fallback')
  assert.equal('bogus' in c, false)
  assert.equal(m.nextRunDue(c, {}), 0, 'never ran: due now')
  assert.equal(m.nextRunDue(c, { lastRunAt: '2026-01-01T00:00:00.000Z' }), Date.parse('2026-01-01T00:05:00.000Z'))
  assert.equal(m.isPendingScope([]), false)
  assert.equal(m.isPendingScope([{ state: 'draft' }, { state: 'draft' }]), true)
  assert.equal(m.isPendingScope([{ state: 'draft' }, { state: 'started' }]), false)
})

test('the role', () => {
  assert.equal(m.roleHasTurnContract('proactive'), true)
  assert.equal(m.roleLocksClone('proactive'), false)
  assert.equal(m.roleNeedsRepo('proactive'), false)
  assert.equal(m.roleAllowsMultiRepo('proactive'), true)
  assert.equal(m.roleForbidsRepo('operator'), true)
  assert.equal(m.USER_SESSION_ROLES.includes('proactive'), false, 'never offered for an ordinary session')
  m.assertRoleFitsRepos('proactive', [])
  m.assertRoleFitsRepos('proactive', ['alpha', 'beta'])
  assert.throws(() => m.assertRoleFitsRepos('operator', ['alpha']), /holds no repository/)
  assert.match(m.nudgePromptFor('proactive'), /finish_run/)
  assert.match(m.nudgePromptFor('executor'), /`complete`/)
  assert.equal(
    m.postTurnDecision({ stopReason: 'end_turn', turnComplete: false, threw: false, isNudge: false, hasContract: true }),
    'nudge'
  )
})

// --- create -------------------------------------------------------------------
let templateId
test('create: a scope with a template that never runs', async () => {
  await kernel.proactive.create(ws, 'triage')
  const a = view()
  assert.ok(a, 'the agent is listed')
  assert.equal(a.config.enabled, false, 'created switched off')
  templateId = a.config.templateId
  const t = kernel.sessions.sessionInfo(templateId)
  assert.equal(t.role, 'proactive')
  assert.equal(t.template, true)
  assert.equal(t.env, 'operator', 'the bundled image-only env')
  assert.equal(t.agent, 'a1', "the workspace's default agent")
  assert.deepEqual(t.repos, [])
  assert.throws(() => kernel.sessions.run(templateId), /template/)
  assert.throws(() => kernel.sessions.enqueue(templateId), /template/)
  const tree = await kernel.tree()
  const w = tree.workspaces.find((x) => x.name === ws)
  assert.equal(w.tasks.some((t) => t.name === 'triage'), false, 'not among the scopes')
  assert.equal(w.proactive.some((p) => p.name === 'triage'), true, 'listed as an agent')
  assert.ok(m.getTask && (await m.getTask(ws, 'triage')).proactive, 'task.json carries the config')
  await assert.rejects(kernel.proactive.create(ws, 'triage'), /already exists/)
  await assert.rejects(kernel.renameTask(ws, 'triage', 'other'), /cannot be renamed/)
})

// --- a run's tools ------------------------------------------------------------
let run1
let crashScope
test('a run: list, propose, idempotency, attach, defer', async () => {
  run1 = await kernel.proactive.runNow(ws, 'triage')
  assert.equal(view().activeRun, run1)
  await assert.rejects(kernel.proactive.runNow(ws, 'triage'), /already running/, 'runs never overlap')
  const p = tools(run1)

  const first = await p.listOpen(['sentry:1', 'sentry:2'])
  assert.equal(first.cursor, null)
  assert.deepEqual(first.check, { 'sentry:1': { status: 'new' }, 'sentry:2': { status: 'new' } })

  const made = await p.proposeScope({
    title: 'Checkout crash',
    summary: 'NPE in cart',
    refs: ['sentry:1'],
    sessions: [executor()]
  })
  assert.equal(made.created, true)
  assert.equal(made.scope, 'checkout-crash')
  const file = await m.getTask(ws, 'checkout-crash')
  assert.deepEqual(file.origin.refs, ['sentry:1'], 'the refs are written with the scope')
  assert.equal(file.origin.agent, 'triage')
  assert.equal(file.origin.run, run1)
  const drafts = kernel.sessions.listForTask(ws, 'checkout-crash')
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0].state, 'draft', 'what a run raises is a draft')
  assert.equal(drafts[0].env, 'dev', "the repo's own default env")
  assert.equal(drafts[0].agent, 'a1')

  // The same ref again: nothing new, the existing scope answers.
  const again = await p.proposeScope({ title: 'Checkout crash again', summary: 'x', refs: ['sentry:9', 'sentry:1'], sessions: [executor()] })
  assert.equal(again.created, false)
  assert.equal(again.scope, 'checkout-crash')
  assert.equal(kernel.sessions.listForTask(ws, 'checkout-crash').length, 1, 'no second draft')

  // A scope is created whole or not at all: an unresolvable session refuses it.
  await assert.rejects(
    p.proposeScope({ title: 'Beta thing', summary: 'x', refs: ['sentry:3'], sessions: [executor(), { role: 'executor', repos: ['beta'], prompt: 'y' }] }),
    /not the default repo of any environment/
  )
  assert.equal(fs.existsSync(path.join(GURT_ROOT, ws, 'beta-thing')), false, 'nothing landed')
  assert.equal((await p.listOpen(['sentry:3'])).check['sentry:3'].status, 'new', 'the ref stays unbound')
  await assert.rejects(
    p.proposeScope({ title: 'x', summary: 'x', refs: ['bad ref'], sessions: [executor()] }),
    /not a ref/
  )

  // attach: more items and a note on the same problem.
  const att = await p.attach({ scope: 'checkout-crash', refs: ['mail:<m1@x>'], note: 'reported by a customer too' })
  assert.deepEqual(att.attached, ['mail:<m1@x>'])
  const after = await m.getTask(ws, 'checkout-crash')
  assert.deepEqual(after.origin.refs, ['sentry:1', 'mail:<m1@x>'])
  assert.equal(after.origin.notes.length, 1)
  await assert.rejects(p.attach({ scope: 'nope', refs: ['sentry:5'] }), /not a scope raised/)

  // defer: hidden until its time; a raised ref is skipped, not deferred.
  const d = await p.defer({ refs: ['sentry:2', 'sentry:1'], forHours: 24, reason: 'low impact' })
  assert.equal(d.deferred, 1)
  assert.match(d.skipped['sentry:1'], /already raised/)
  const checked = (await p.listOpen(['sentry:1', 'sentry:2', 'mail:<m1@x>'])).check
  assert.equal(checked['sentry:1'].status, 'open')
  assert.equal(checked['sentry:2'].status, 'deferred')
  assert.equal(checked['sentry:2'].reason, 'low impact')
  assert.equal(checked['mail:<m1@x>'].status, 'open')

  // Raising a deferred ref after all clears its deferral.
  const later = await p.proposeScope({ title: 'Slow search', summary: 'x', refs: ['sentry:2'], sessions: [executor()] })
  assert.equal(later.created, true)
  assert.equal(view().state.deferrals.some((x) => x.ref === 'sentry:2'), false)
  crashScope = later.scope
})

test('concurrent proposals of one ref create one scope', async () => {
  const p = tools(run1)
  const req = (title) => ({ title, summary: 'x', refs: ['gh:o/alpha#7'], sessions: [executor()] })
  const results = await Promise.all([p.proposeScope(req('Race one')), p.proposeScope(req('Race two'))])
  assert.equal(results.filter((r) => r.created).length, 1, 'exactly one created')
  assert.equal(results[0].scope, results[1].scope, 'both answer with the same scope')
})

test('limits: per run, then waiting scopes', async () => {
  // Three proposed so far in this run.
  await kernel.proactive.update(ws, 'triage', { maxScopesPerRun: 3 })
  await assert.rejects(
    tools(run1).proposeScope({ title: 'Fourth', summary: 'x', refs: ['sentry:4'], sessions: [executor()] }),
    /this run already proposed 3 scopes/
  )
})

test('the end of a run', async () => {
  const r = await tools(run1).finishRun({ summary: 'raised 3, deferred 1', cursor: '2026-11-03T10:00:00Z' })
  assert.equal(r.ok, true)
  endTurn(run1)
  const a = view()
  assert.equal(a.activeRun, undefined)
  const rec = a.state.runs.find((x) => x.id === run1)
  assert.equal(rec.outcome, 'finished')
  assert.equal(rec.summary, 'raised 3, deferred 1')
  assert.equal(rec.proposed.length, 3)
  assert.equal(rec.deferred, 1)
  await assert.rejects(tools(run1).listOpen(), /run has ended/, "an ended run's tools are closed")
  await new Promise((r) => setTimeout(r, 50))
  const disk = await m.readProactiveState(ws, 'triage')
  assert.equal(disk.cursor, '2026-11-03T10:00:00Z', 'the cursor is on disk')

  // The next run reads it back, and the waiting-scope cap applies.
  const run2 = await kernel.proactive.runNow(ws, 'triage')
  assert.equal((await tools(run2).listOpen()).cursor, '2026-11-03T10:00:00Z')
  await kernel.proactive.update(ws, 'triage', { maxPendingScopes: 3 })
  await assert.rejects(
    tools(run2).proposeScope({ title: 'Fourth', summary: 'x', refs: ['sentry:4'], sessions: [executor()] }),
    /3 scopes are waiting for the user/
  )
  // A run that ends without finish_run is incomplete.
  endTurn(run2)
  assert.equal(view().state.runs.find((x) => x.id === run2).outcome, 'incomplete')
})

test('a deleted scope leaves its refs dismissed', async () => {
  await kernel.deleteTask(ws, 'checkout-crash')
  const run3 = await kernel.proactive.runNow(ws, 'triage')
  const p = tools(run3)
  const checked = (await p.listOpen(['sentry:1', 'mail:<m1@x>'])).check
  assert.deepEqual(checked['sentry:1'], { status: 'dismissed', scope: 'checkout-crash' })
  assert.equal(checked['mail:<m1@x>'].status, 'dismissed')
  await kernel.proactive.update(ws, 'triage', { maxPendingScopes: 50 })
  await assert.rejects(
    p.proposeScope({ title: 'Checkout crash', summary: 'x', refs: ['sentry:1'], sessions: [executor()] }),
    /which the user deleted/
  )
  // The user may let it come back.
  await kernel.proactive.forget(ws, 'triage', 'sentry:1')
  assert.equal((await p.listOpen(['sentry:1'])).check['sentry:1'].status, 'new')
  endTurn(run3)
})

test('crash recovery: a scope whose drafts never landed is finished', async () => {
  // The app died between the scope's write and its drafts' persist.
  const origin = { agent: 'triage', run: 'gone', refs: ['sentry:77'], title: 'Orphan', summary: 'x', createdAt: new Date().toISOString() }
  await m.createTask(ws, 'orphan', { origin })
  await kernel.proactive.load({ workspaces: [{ name: ws, tasks: [{ name: 'orphan', origin }], proactive: [] }] })
  const run4 = await kernel.proactive.runNow(ws, 'triage')
  const r = await tools(run4).proposeScope({ title: 'Orphan', summary: 'x', refs: ['sentry:77'], sessions: [executor()] })
  assert.equal(r.created, false)
  assert.equal(r.scope, 'orphan')
  assert.equal(r.drafted.length, 1)
  assert.equal(kernel.sessions.listForTask(ws, 'orphan').length, 1)
  endTurn(run4)
})

test('the clock: due, overlap, timeout, run collection', async () => {
  await kernel.proactive.update(ws, 'triage', { enabled: true, everyMinutes: 5, keepRuns: 2 })
  // `update` ticks: the last run started moments ago, so nothing is due.
  assert.equal(view().activeRun, undefined, 'not due yet')
  view().state.lastRunAt = new Date(Date.now() - 6 * 60_000).toISOString()
  kernel.proactive.tick()
  const scheduled = view().activeRun
  assert.ok(scheduled, 'due: a run started')
  kernel.proactive.tick()
  assert.equal(view().activeRun, scheduled, 'a tick during a run starts nothing')
  // Overdue: cancelled, and (never started) deleted.
  view().state.runs.find((x) => x.id === scheduled).startedAt = new Date(Date.now() - 31 * 60_000).toISOString()
  kernel.proactive.tick()
  const rec = view().state.runs.find((x) => x.id === scheduled)
  assert.equal(rec.outcome, 'timeout')
  assert.equal(kernel.sessions.sessionInfo(scheduled), undefined, 'the stuck run session is gone')
  // Only `keepRuns` run sessions stay, beside the template.
  const kept = view().sessions.filter((s) => !s.template)
  assert.ok(kept.length <= 2, `kept ${kept.length} run sessions`)
  assert.ok(view().sessions.some((s) => s.template), 'the template is never collected')
  await kernel.proactive.update(ws, 'triage', { enabled: false })
})

test('a run from a previous app life is not offered for recovery', () => {
  const info = {
    id: 'old-run',
    env: 'operator',
    role: 'proactive',
    repos: [],
    task: 'triage',
    workspace: ws,
    title: 'run old',
    agent: 'a1',
    state: 'started',
    startPrompt: 'x',
    limitedUntil: new Date(Date.now() + 3_600_000).toISOString()
  }
  kernel.sessions.restore([{ info, interrupted: true, pending: [{ id: 'p', text: 'continue', auto: true }], log: [] }])
  assert.equal(kernel.sessions.interruptedSessions().some((s) => s.id === 'old-run'), false)
  assert.equal(kernel.sessions.sessionInfo('old-run').limitedUntil, undefined, 'no automatic continue after a limit')
  kernel.sessions.deleteSession('old-run')
})

test('deleting the agent', async () => {
  await kernel.deleteTask(ws, 'triage')
  assert.equal(view(), undefined)
  assert.equal(kernel.sessions.sessionInfo(templateId), undefined)
  // What it raised stays.
  assert.ok((await m.getTask(ws, crashScope)).origin)
})

// --- the `gurt` tool set of the role -------------------------------------------
test('the proactive tool set', async () => {
  const calls = []
  const hook = (name) => async (input) => {
    calls.push([name, input])
    return { ok: name }
  }
  const server = m.buildGurtHttpServer('t', {
    role: 'proactive',
    onComplete: () => {},
    onCreateSession: async () => ({ sessionId: 'x', title: 'x' }),
    proactive: {
      listOpen: hook('listOpen'),
      proposeScope: hook('proposeScope'),
      attach: hook('attach'),
      defer: hook('defer'),
      finishRun: hook('finishRun')
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    let id = 0
    const post = async (method, params) => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/mcp/t`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })
      })
      return (await res.json()).result
    }
    const listed = (await post('tools/list', {})).tools.map((t) => t.name).sort()
    assert.deepEqual(listed, ['attach', 'defer', 'finish_run', 'list_open', 'propose_scope'], 'no complete, no create_session')
    const ok = await post('tools/call', {
      name: 'propose_scope',
      arguments: { title: 't', summary: 's', refs: ['sentry:1'], sessions: [{ role: 'executor', repos: ['alpha'], prompt: 'p' }] }
    })
    assert.equal(ok.isError, undefined)
    assert.equal(calls.at(-1)[0], 'proposeScope')
    const bad = await post('tools/call', {
      name: 'propose_scope',
      arguments: { title: 't', summary: 's', refs: ['sentry:1'], sessions: [{ role: 'operator', repos: [], prompt: 'p' }] }
    })
    assert.equal(bad.isError, true, 'a proactive run proposes only executor / researcher / reviewer')
    const done = await post('tools/call', { name: 'finish_run', arguments: { summary: 'done' } })
    assert.equal(done.isError, undefined)
  } finally {
    server.close()
  }
})
