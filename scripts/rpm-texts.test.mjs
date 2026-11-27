// rpm/core: the view, the texts the models see, the tool schemas, the chat
// lines (t4v1 task 4; t3v2 §3.2, §5, §10; t1v6 §6).
//
//   - snapshots of every text on one journal (run б of t1v6 §7, with a nit
//     below the threshold); the snapshot file is rewritten with
//     UPDATE_SNAPSHOTS=1;
//   - what the models must not see (threshold, budget, round, attempts); the
//     executor gets every finding of its move, below the threshold too;
//   - view on run в: called with F1, counts.you = 1;
//   - the zod schemas accept the §5 shapes and refuse the bad ones.
//
//   node scripts/rpm-texts.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bundle } from './lib/bundle.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SNAP = path.join(ROOT, 'scripts/snapshots/rpm-texts.snap.txt')
const outfile = path.join(os.tmpdir(), `gurt-rpm-texts-${process.pid}.mjs`)
await bundle({ entryPoints: [path.join(ROOT, 'src/rpm/core/index.ts')], outfile })
after(() => fs.rmSync(outfile, { force: true }))
const m = await import(pathToFileURL(outfile).href)

const CFG = { ...m.DEFAULT_CONFIG, enabled: true, reviewer: { agent: 'codex', options: {} } }
const APP = [{ repo: 'app', command: 'npm test' }]

/** A journal builder: `push(by, body, comment)`; `fold()` of what is there. */
function journal() {
  const j = []
  const push = (by, body, comment) => {
    j.push({ seq: j.length + 1, at: `2026-11-24T10:${String(j.length).padStart(2, '0')}:00Z`, by, ...(comment ? { comment } : {}), ...body })
    return j[j.length - 1]
  }
  push('rpm', { kind: 'start', executor: 'e1', run: 1, turnId: 'u0', base: [{ repo: 'app', commit: 'c0' }], config: CFG })
  return { j, push, fold: () => m.fold(j) }
}

const DIFF = { repo: 'app', text: '--- a/src/sum.ts\n+++ b/src/sum.ts\n@@ -1 +1 @@\n-export const sum = (a, b) => a - b\n+export const sum = (a, b) => a + b', truncated: false, files: [{ path: 'src/sum.ts', status: 'M' }] }
const green = (step, tree) => ({ kind: 'check', step, tree, ok: true, runs: APP.map((c) => ({ ...c, code: 0, ms: 900, tail: ['ok'] })) })

test('run б: snapshots of every text and chat line; what the models do not see', () => {
  const { j, push, fold } = journal()
  const snap = []
  const section = (title, body) => snap.push(`=== ${title} ===\n${body}\n`)
  const line = (l) => section(`chat line · seq ${l.seq} · ${m.chatLineSummary(l)}`, JSON.stringify(l, null, 2))
  const facts = (tree) => ({ tree, checks: APP })
  const task = ['Fix sum(): it subtracts.']
  const prompts = []

  // check ✓
  assert.deepEqual(m.next(fold(), facts('T0')), { do: 'check' })
  push('rpm', { kind: 'step', step: 1, what: 'check', rule: '2', tree: 'T0', key: 'e1:1:1' })
  push('check', green(1, 'T0'))

  // R1: F1, F2 major, F3 nit (below the threshold)
  assert.deepEqual(m.next(fold(), facts('T0')), { do: 'review', full: true, verify: [] })
  let s = push('rpm', { kind: 'step', step: 2, what: 'review', rule: '6', tree: 'T0', full: true, items: [], key: 'e1:1:2', session: 'r1' })
  let p = m.reviewerPrompt(fold(), { task, diffs: [DIFF], check: { ok: true, runs: green(1, 'T0').runs }, verify: [], full: true })
  prompts.push(p)
  section('reviewerPrompt · R1', p)
  line(m.chatLines.reviewStep(fold(), s, p))
  let r = push('reviewer', {
    kind: 'review', step: 2, tree: 'T0', full: true, verify: [],
    findings: [
      { id: 'F1', severity: 'major', file: 'app/src/sum.ts', line: 1, claim: 'sum() of negatives overflows the int range check', scenario: 'sum(-2**31, -1) returns a positive number' },
      { id: 'F2', severity: 'major', file: 'app/src/sum.test.ts', claim: 'No test for the fix', scenario: 'reverting the fix keeps the suite green' },
      { id: 'F3', severity: 'nit', file: 'app/src/sum.ts', line: 1, claim: 'Name the parameters x and y', scenario: 'a reader confuses a/b with arrays' }
    ]
  })
  line(m.chatLines.review(fold(), r))

  // executor: F1, F2 and F3 (below the threshold — sent too, it just does not hold the mark)
  assert.deepEqual(m.next(fold(), facts('T0')), { do: 'executor', items: ['F1', 'F2', 'F3'] })
  push('you', { kind: 'note', text: 'Keep the public signature.' })
  line(m.chatLines.note(fold(), j[j.length - 1]))
  s = push('rpm', { kind: 'step', step: 3, what: 'executor', rule: '9', tree: 'T0', items: ['F1', 'F2', 'F3'], key: 'e1:1:3' })
  let msg = m.executorMessage(fold(), ['F1', 'F2', 'F3'], ['Keep the public signature.'])
  section('executorMessage · step 3', msg)
  assert.match(msg, /F3 · nit/, 'the executor gets the finding below the threshold too')
  assert.doesNotMatch(msg, /threshold/i, 'the executor never sees the threshold')
  line(m.chatLines.executorStep(fold(), s, msg))
  let t = push('executor', { kind: 'turn', step: 3, turnId: 't3', origin: 'rpm', tree: 'T1', outcome: 'changes', replies: [
    { id: 'F1', act: 'fixed', comment: 'Clamped with Number.isSafeInteger.' },
    { id: 'F2', act: 'fixed', comment: 'Added sum.test.ts.' }
  ] })
  for (const l of m.chatLines.turn(fold(), t)) line(l)

  // check ✓ → R2: F1 yes · F2 no
  push('rpm', { kind: 'step', step: 4, what: 'check', rule: '2', tree: 'T1', key: 'e1:1:4' })
  push('check', green(4, 'T1'))
  assert.deepEqual(m.next(fold(), facts('T1')), { do: 'review', full: true, verify: ['F1', 'F2'] })
  s = push('rpm', { kind: 'step', step: 5, what: 'review', rule: '6', tree: 'T1', full: true, items: ['F1', 'F2'], key: 'e1:1:5', session: 'r2' })
  p = m.reviewerPrompt(fold(), { task, diffs: [{ ...DIFF, truncated: true }], check: { ok: true, runs: green(4, 'T1').runs }, verify: ['F1', 'F2'], full: true })
  prompts.push(p)
  section('reviewerPrompt · R2', p)
  line(m.chatLines.reviewStep(fold(), s, p))
  r = push('reviewer', { kind: 'review', step: 5, tree: 'T1', full: true, findings: [], verify: [
    { id: 'F1', accept: true, comment: 'Clamped.' },
    { id: 'F2', accept: false, comment: 'The test does not cover negatives.' }
  ] })
  line(m.chatLines.review(fold(), r))
  assert.equal(fold().findings[1].attempts, 1)

  // you calibrate F3 (stays below), executor gets F2 again and the unanswered F3
  push('you', { kind: 'severity', id: 'F3', to: 'minor' }, 'style, not a bug')
  assert.deepEqual(m.next(fold(), facts('T1')), { do: 'executor', items: ['F2', 'F3'] })
  s = push('rpm', { kind: 'step', step: 6, what: 'executor', rule: '9', tree: 'T1', items: ['F2', 'F3'], key: 'e1:1:6' })
  msg = m.executorMessage(fold(), ['F2', 'F3'], [])
  section('executorMessage · step 6', msg)
  assert.match(msg, /The test does not cover negatives\./, 'the last reviewer comment reaches the executor')
  assert.doesNotMatch(msg, /F1/)
  line(m.chatLines.executorStep(fold(), s, msg))
  t = push('executor', { kind: 'turn', step: 6, turnId: 't6', origin: 'rpm', tree: 'T2', outcome: 'changes', replies: [{ id: 'F2', act: 'fixed', comment: 'Negative cases added.' }] })
  for (const l of m.chatLines.turn(fold(), t)) line(l)

  // check ✓ → R3: F2 yes → mark
  push('rpm', { kind: 'step', step: 7, what: 'check', rule: '2', tree: 'T2', key: 'e1:1:7' })
  push('check', green(7, 'T2'))
  s = push('rpm', { kind: 'step', step: 8, what: 'review', rule: '6', tree: 'T2', full: true, items: ['F2'], key: 'e1:1:8', session: 'r3' })
  p = m.reviewerPrompt(fold(), { task, diffs: [DIFF], check: 'not-configured', verify: ['F2'], full: true })
  prompts.push(p)
  section('reviewerPrompt · R3', p)
  line(m.chatLines.reviewStep(fold(), s, p))
  r = push('reviewer', { kind: 'review', step: 8, tree: 'T2', full: true, findings: [], verify: [{ id: 'F2', accept: true, comment: 'Covered.' }] })
  line(m.chatLines.review(fold(), r))
  assert.deepEqual(m.next(fold(), facts('T2')), { do: 'mark' })
  const mk = push('rpm', { kind: 'mark', mark: { executor: 'e1', run: 1, at: 'x', tree: 'T2', repos: [{ repo: 'app', base: 'c0', head: 'h2', tree: 't2', files: [{ path: 'src/sum.ts', status: 'M' }, { path: 'src/sum.test.ts', status: 'A' }] }], reviews: 3, findings: { closed: 2, rejected: 0, deferred: 0, below: 1 } } })
  line(m.chatLines.mark(fold(), mk))

  // a red check and the call lines (outside run б, same fold shape)
  const red = [{ repo: 'app', command: 'npm test', code: 1, ms: 1200, tail: ['FAIL sum.test.ts', '  expected 3, got -1'] }]
  section('checkMessage', m.checkMessage(red))

  // the view at the end
  const v = m.view(fold(), j)
  section('view · status and counts', JSON.stringify({ status: v.status, counts: v.counts, live: v.live }, null, 2))
  section('view · F2 history', JSON.stringify(v.findings[1].history, null, 2))
  assert.deepEqual(v.status, { phase: 'passed', files: 2, reviewsSinceYou: 1, lastCheck: { ok: true, redStreak: 0 } })
  assert.deepEqual(v.counts, { you: 0, executor: 0, reviewer: 0, final: 2, below: 1, all: 3 })
  assert.deepEqual(v.findings.map((f) => [f.id, f.tracked, f.owner]), [['F1', true, 'none'], ['F2', true, 'none'], ['F3', false, 'executor']])
  assert.deepEqual(v.findings[1].history.map((h) => [h.by, h.from ?? null, h.to, h.review ?? null]), [
    ['reviewer', null, 'open', 1], ['executor', 'open', 'fixed', null], ['reviewer', 'fixed', 'open', 2],
    ['executor', 'open', 'fixed', null], ['reviewer', 'fixed', 'closed', 3]
  ])
  assert.deepEqual(v.findings[2].history.at(-1).severity, { from: 'nit', to: 'minor' })

  // the reviewer never sees the threshold, the budget, the round, the attempts
  for (const p of prompts) {
    assert.doesNotMatch(p, /threshold|budget|attempt|\bround\b|\bR[0-9]/i)
    assert.match(p, /blocker —/)
    assert.match(p, /scenario/i)
    assert.match(p, /submit_review/)
  }
  // …but sees the history and your severity change
  assert.match(prompts[2], /severity nit → minor — "style, not a bug"/)
  assert.match(prompts[2], /reviewer: not accepted — "The test does not cover negatives\."/)
  assert.match(prompts[1], /The diff is cut short/)
  assert.match(prompts[2], /No check is configured/)

  const got = snap.join('\n')
  if (process.env.UPDATE_SNAPSHOTS || !fs.existsSync(SNAP)) {
    fs.mkdirSync(path.dirname(SNAP), { recursive: true })
    fs.writeFileSync(SNAP, got)
  }
  assert.equal(got, fs.readFileSync(SNAP, 'utf8'), 'texts differ from the snapshot (UPDATE_SNAPSHOTS=1 to accept)')
})

test('view on run в: called with F1, counts.you = 1', () => {
  const { push, fold, j } = journal()
  push('rpm', { kind: 'step', step: 1, what: 'check', rule: '2', tree: 'T0', key: 'e1:1:1' })
  push('check', green(1, 'T0'))
  push('rpm', { kind: 'step', step: 2, what: 'review', rule: '6', tree: 'T0', full: true, items: [], key: 'e1:1:2', session: 'r1' })
  push('reviewer', { kind: 'review', step: 2, tree: 'T0', full: true, verify: [], findings: [
    { id: 'F1', severity: 'major', claim: 'a', scenario: 'x' },
    { id: 'F2', severity: 'major', claim: 'b', scenario: 'y' }
  ] })
  push('rpm', { kind: 'step', step: 3, what: 'executor', rule: '9', tree: 'T0', items: ['F1', 'F2'], key: 'e1:1:3' })
  const t = push('executor', { kind: 'turn', step: 3, turnId: 't3', origin: 'rpm', tree: 'T1', outcome: 'changes', replies: [
    { id: 'F1', act: 'cant', comment: 'Needs a schema migration.' },
    { id: 'F2', act: 'fixed', comment: 'Done.' }
  ] })
  const lines = m.chatLines.turn(fold(), t)
  assert.deepEqual(lines.map(m.chatLineSummary), ['executor → reviewer F2 fixed', "executor → you F1 can't"])
  push('rpm', { kind: 'step', step: 4, what: 'check', rule: '2', tree: 'T1', key: 'e1:1:4' })
  push('check', green(4, 'T1'))
  assert.deepEqual(m.next(fold(), { tree: 'T1', checks: APP }), { do: 'call', why: 'findings' })
  const c = push('rpm', { kind: 'call', why: 'findings' })
  assert.equal(m.chatLineSummary(m.chatLines.call(fold(), c)), "executor → you F1 can't")

  const v = m.view(fold(), j)
  assert.equal(v.status.phase, 'called')
  assert.equal(v.status.why, 'findings')
  assert.deepEqual(v.status.items, ['F1'])
  assert.equal(v.counts.you, 1)
  assert.deepEqual(v.counts, { you: 1, executor: 0, reviewer: 1, final: 0, below: 0, all: 2 })
  assert.equal(v.live, true)
  assert.equal(v.journal.length, j.length)
})

test('view: running steps map to their phases', () => {
  const { push, fold, j } = journal()
  push('rpm', { kind: 'step', step: 1, what: 'check', rule: '2', tree: 'T0', key: 'e1:1:1' })
  assert.deepEqual(m.view(fold(), j).status, { phase: 'check', repos: ['app'], reviewsSinceYou: 0 })
  push('check', { kind: 'check', step: 1, tree: 'T0', ok: false, runs: [{ repo: 'app', command: 'npm test', code: 1, ms: 1, tail: [] }] })
  push('rpm', { kind: 'step', step: 2, what: 'executor', rule: '3в', tree: 'T0', key: 'e1:1:2' })
  assert.deepEqual(m.view(fold(), j).status, { phase: 'fix-check', try: 1, of: 3, reviewsSinceYou: 0, lastCheck: { ok: false, redStreak: 1 } })
  push('executor', { kind: 'turn', step: 2, turnId: 't2', origin: 'rpm', tree: 'T1', outcome: 'changes', replies: [] })
  push('you', { kind: 'command', cmd: 'pause' })
  assert.equal(m.view(fold(), j).status.phase, 'paused')
  push('rpm', { kind: 'end', why: 'stopped' })
  const v = m.view(fold(), j)
  assert.deepEqual([v.status.phase, v.status.why, v.live], ['ended', 'stopped', false])
})

test('tools: the §5 schemas, the tools per role, the instructions', () => {
  const { reply_findings: reply, submit_review: submit } = m.rpmToolSchemas
  assert.equal(reply.name, 'reply_findings')
  assert.ok(reply.description && submit.description)
  assert.ok(reply.schema.safeParse({ replies: [{ id: 'F1', act: 'fixed', comment: 'done' }] }).success)
  assert.ok(!reply.schema.safeParse({ replies: [] }).success, '1..50 replies')
  assert.ok(!reply.schema.safeParse({ replies: [{ id: 'F1', act: 'approve', comment: 'x' }] }).success)
  assert.ok(!reply.schema.safeParse({ replies: [{ id: 'F1', act: 'fixed', comment: '' }] }).success, 'comment 1..2000')
  assert.ok(!reply.schema.safeParse({ replies: [{ id: 'F1', act: 'fixed', comment: 'x'.repeat(2001) }] }).success)
  assert.ok(!reply.schema.safeParse({ replies: [{ id: 'F1', act: 'fixed', comment: 'a' }, { id: 'F1', act: 'cant', comment: 'b' }] }).success, 'ids unique')

  assert.ok(submit.schema.safeParse({ findings: [], verify: [] }).success)
  assert.ok(submit.schema.safeParse({ findings: [{ severity: 'major', file: 'app/a.ts', line: 3, claim: 'c', scenario: 's' }], verify: [{ id: 'F1', accept: false, comment: 'no' }] }).success)
  assert.ok(!submit.schema.safeParse({ findings: [{ severity: 'major', claim: 'c' }], verify: [] }).success, 'scenario required')
  assert.ok(!submit.schema.safeParse({ findings: Array.from({ length: 51 }, () => ({ severity: 'nit', claim: 'c', scenario: 's' })), verify: [] }).success, '≤ 50')
  assert.ok(!submit.schema.safeParse({ findings: [], verify: [{ id: 'F1', accept: true, comment: 'a' }, { id: 'F1', accept: false, comment: 'b' }] }).success)
  assert.ok(submit.schema.safeParse({ findings: [], verify: [], approve: true }).success, 'unknown keys are stripped, not refused')

  assert.deepEqual(m.rpmToolsFor('executor').map((t) => t.name), ['reply_findings'])
  assert.deepEqual(m.rpmToolsFor('reviewer').map((t) => t.name), ['submit_review'])
  assert.deepEqual(m.rpmToolsFor('researcher'), [])
  assert.match(m.rpmInstructions('executor'), /reply_findings[\s\S]*before you call `complete`/)
  assert.match(m.rpmInstructions('reviewer'), /read-only[\s\S]*submit_review[\s\S]*last action/)
  assert.equal(m.rpmInstructions('operator'), undefined)
})
