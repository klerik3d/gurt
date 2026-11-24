// rpm/core: the finding machine, the fold and "what next" (t3v2 §2.2, t1v6 §1–4, §7).
//
//   - move(): the transition table of t1v6 §2, by exhaustive sweep
//     (state × actor × act × attempts × back) against a table restated here;
//   - fold(): ignored moves, verdicts at once, counters since your last entry,
//     F-numbering;
//   - next(): runs а–ж of t1v6 §7 written as journals — at every step boundary
//     `next` gives the step of the run.
//
//   node scripts/rpm-core.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bundle } from './lib/bundle.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-rpm-core-${process.pid}.mjs`)
await bundle({ entryPoints: [path.join(ROOT, 'src/rpm/core/index.ts')], outfile })
after(() => fs.rmSync(outfile, { force: true }))
const m = await import(pathToFileURL(outfile).href)

// --- move: the table, by sweep ---------------------------------------------------

const STATES = ['open', 'must', 'defer', 'fixed', 'contested', 'documented', 'disputed', 'cant', 'closed', 'rejected', 'deferred']
const ACTORS = ['you', 'rpm', 'executor', 'reviewer', 'check']
const ACTS = ['fixed', 'contested', 'cant', 'documented', { verify: true }, { verify: false }, { verdict: 'must' }, { verdict: 'reject' }, { verdict: 'defer' }]
const N = 2

/** t1v6 §2, restated: the finding after the move, or 'not-allowed'. */
function expected(f, by, act) {
  const refuse = (to) => (f.attempts + 1 >= N ? { ...f, state: 'disputed', attempts: f.attempts + 1 } : { ...f, state: to, attempts: f.attempts + 1 })
  if (by === 'executor' && typeof act === 'string') {
    const allowed = { open: ['fixed', 'contested', 'cant'], must: ['fixed', 'cant'], defer: ['documented'] }[f.state] ?? []
    return allowed.includes(act) ? { ...f, state: act } : 'not-allowed'
  }
  if (by === 'reviewer' && typeof act === 'object' && 'verify' in act) {
    if (f.state === 'fixed') return act.verify ? { ...f, state: 'closed' } : refuse(f.back)
    if (f.state === 'contested') return { ...f, state: act.verify ? 'rejected' : 'disputed' }
    if (f.state === 'documented') return act.verify ? { ...f, state: 'deferred' } : refuse('defer')
    return 'not-allowed'
  }
  if (by === 'you' && typeof act === 'object' && 'verdict' in act) {
    if (act.verdict === 'must') return { ...f, state: 'must', back: 'must', attempts: 0 }
    if (act.verdict === 'reject') return { ...f, state: 'rejected', attempts: 0 }
    return { ...f, state: 'defer', attempts: 0 }
  }
  return 'not-allowed'
}

test('move: the transition table, state × actor × act × attempts × back', () => {
  let allowed = 0
  let cases = 0
  for (const state of STATES)
    for (const by of ACTORS)
      for (const act of ACTS)
        for (const attempts of [0, N - 1])
          for (const back of ['open', 'must']) {
            const f = { id: 'F1', severity: 'major', claim: 'c', scenario: 's', state, back, attempts, raisedIn: 1 }
            const want = expected(f, by, act)
            assert.deepEqual(m.move(f, by, act, { attempts: N }), want, `${state} × ${by} × ${JSON.stringify(act)} × attempts ${attempts} × back ${back}`)
            cases++
            if (want !== 'not-allowed') allowed++
          }
  assert.equal(cases, 11 * 5 * 9 * 2 * 2)
  // executor 6 + reviewer 3×2 + you 11×3, each × 4 (attempts × back)
  assert.equal(allowed, (6 + 6 + 33) * 4)
})

test('move: the N-th refusal goes to dispute, your verdict zeroes attempts', () => {
  const f = { id: 'F1', severity: 'major', claim: 'c', scenario: 's', state: 'fixed', back: 'must', attempts: 0, raisedIn: 1 }
  const once = m.move(f, 'reviewer', { verify: false }, { attempts: 3 })
  assert.deepEqual([once.state, once.attempts], ['must', 1])
  const twice = m.move({ ...once, state: 'fixed' }, 'reviewer', { verify: false }, { attempts: 3 })
  const third = m.move({ ...twice, state: 'fixed' }, 'reviewer', { verify: false }, { attempts: 3 })
  assert.deepEqual([third.state, third.attempts], ['disputed', 3])
  const v = m.move(third, 'you', { verdict: 'must' }, { attempts: 3 })
  assert.deepEqual([v.state, v.attempts], ['must', 0])
})

// --- a run as a journal ------------------------------------------------------------

const CFG = { ...m.DEFAULT_CONFIG, enabled: true, reviewer: { agent: 'codex', options: {} } }
const APP = [{ repo: 'app', command: 'npm test' }]
const nit = (claim) => ({ severity: 'nit', claim, scenario: 'x' })
const major = (claim) => ({ severity: 'major', claim, scenario: 'x' })
const blocker = (claim) => ({ severity: 'blocker', claim, scenario: 'x' })

/**
 * Drives one run: `step(want, result)` asserts that `next` says `want`, writes
 * the step entry that would follow, asserts `wait step-running`, then writes
 * the result. The tree changes when a result says `change`.
 */
function sim({ checks = APP, config = CFG } = {}) {
  const j = []
  let tree = 'T0'
  let trees = 0
  let checksNow = checks
  const push = (by, body, comment) => j.push({ seq: j.length + 1, at: `t${j.length + 1}`, by, ...(comment ? { comment } : {}), ...body })
  push('rpm', { kind: 'start', executor: 'e1', run: 1, turnId: 'u0', base: [{ repo: 'app', commit: 'c0' }], config })
  const fold = () => m.fold(j)
  const now = () => m.next(fold(), { tree, checks: checksNow })
  const change = () => (tree = `T${++trees}`)
  const s = {
    j,
    fold,
    get tree() { return tree },
    setChecks(c) { checksNow = c },
    change,
    expect(want, msg) { assert.deepEqual(now(), want, msg ?? `at seq ${j.length}`) },
    step(want, result = {}) {
      s.expect(want)
      const run = fold()
      const n = run.lastStep + 1
      const key = `e1:1:${n}`
      const what = want.do === 'fix-check' ? 'executor' : want.do
      const rule = result.rule ?? { check: '2', 'fix-check': '3в', review: '6', executor: '9' }[want.do]
      push('rpm', {
        kind: 'step', step: n, what, rule, tree, key,
        ...(want.do === 'review' ? { full: want.full, items: want.verify, session: `r${n}` } : {}),
        ...(want.do === 'executor' ? { items: want.items } : {})
      })
      s.expect({ do: 'wait', why: 'step-running' }, `step ${n} running`)
      if (result.during) result.during()
      if (what === 'check') {
        if (result.change) change()
        push('check', { kind: 'check', step: n, tree, ok: result.ok ?? true, runs: checksNow.map((c) => ({ ...c, code: result.ok === false ? 1 : 0, ms: 1, tail: [] })) })
      } else if (what === 'review') {
        const first = fold().findings.length + 1
        assert.equal(m.nextFindingId(fold()), `F${first}`)
        const findings = (result.findings ?? []).map((f, i) => ({ ...f, id: `F${first + i}` }))
        const verify = Object.entries(result.verify ?? {}).map(([fid, accept]) => ({ id: fid, accept, comment: accept ? 'yes' : 'no' }))
        push('reviewer', { kind: 'review', step: n, tree, full: want.full, findings, verify })
      } else {
        if (result.change) change()
        const replies = Object.entries(result.replies ?? {}).map(([fid, act]) => ({ id: fid, act, comment: act }))
        push('executor', { kind: 'turn', step: n, turnId: `t${n}`, origin: 'rpm', tree, outcome: result.outcome ?? (result.change ? 'changes' : 'no_changes'), replies })
      }
    },
    call(why) {
      s.expect({ do: 'call', why })
      push('rpm', { kind: 'call', why })
      s.expect({ do: 'wait', why: 'called' }, `called (${why})`)
    },
    you(body, comment) { push('you', body, comment) },
    userTurn(replies = {}, { change: c = true } = {}) {
      if (c) change()
      push('executor', { kind: 'turn', turnId: `u${j.length}`, origin: 'user', tree, outcome: c ? 'changes' : 'no_changes', replies: Object.entries(replies).map(([id, act]) => ({ id, act, comment: act })) })
    },
    mark() {
      s.expect({ do: 'mark' })
      push('rpm', { kind: 'mark', mark: { executor: 'e1', run: 1, at: 'x', tree, repos: [], reviews: fold().reviews, findings: { closed: 0, rejected: 0, deferred: 0, below: 0 } } })
      assert.equal(fold().ended, 'passed')
    }
  }
  return s
}

const stateOf = (s, id) => s.fold().findings.find((f) => f.id === id)?.state

// --- runs а–ж (t1v6 §7) ----------------------------------------------------------------

test('run а · clean: check ✓ → R1: 2 nits below threshold → mark (7)', () => {
  const s = sim()
  s.step({ do: 'check' })
  s.step({ do: 'review', full: true, verify: [] }, { findings: [nit('a'), nit('b')] })
  s.mark()
  assert.deepEqual(s.fold().findings.map((f) => [f.id, f.state]), [['F1', 'open'], ['F2', 'open']])
})

test('run б · a fix accepted on the second try', () => {
  const s = sim()
  s.step({ do: 'check' })
  s.step({ do: 'review', full: true, verify: [] }, { findings: [major('a'), major('b')] })
  s.step({ do: 'executor', items: ['F1', 'F2'] }, { replies: { F1: 'fixed', F2: 'fixed' }, change: true })
  s.step({ do: 'check' })
  s.step({ do: 'review', full: true, verify: ['F1', 'F2'] }, { verify: { F1: true, F2: false } })
  assert.deepEqual(s.fold().findings.find((f) => f.id === 'F2'), { ...s.fold().findings[1], state: 'open', attempts: 1 })
  s.step({ do: 'executor', items: ['F2'] }, { replies: { F2: 'fixed' }, change: true })
  s.step({ do: 'check' })
  s.step({ do: 'review', full: true, verify: ['F2'] }, { verify: { F2: true } })
  s.mark()
})

test('run в · "can\'t" calls you at once; F2 waits', () => {
  const s = sim()
  s.step({ do: 'check' })
  s.step({ do: 'review', full: true, verify: [] }, { findings: [major('a'), major('b')] })
  s.step({ do: 'executor', items: ['F1', 'F2'] }, { replies: { F1: 'cant', F2: 'fixed' }, change: true })
  s.step({ do: 'check' })
  s.call('findings')
  s.you({ kind: 'verdict', id: 'F1', to: 'defer' }, 'в docs/todo.md')
  assert.equal(stateOf(s, 'F1'), 'defer')
  s.step({ do: 'executor', items: ['F1'] }, { replies: { F1: 'documented' }, change: true })
  s.step({ do: 'check' })
  s.step({ do: 'review', full: true, verify: ['F1', 'F2'] }, { verify: { F1: true, F2: true } })
  assert.deepEqual([stateOf(s, 'F1'), stateOf(s, 'F2')], ['deferred', 'closed'])
  s.mark()
})

test('run в · with a red check between your verdict and F1 reaching the executor: F2 still waits', () => {
  const s = sim()
  s.step({ do: 'check' })
  s.step({ do: 'review', full: true, verify: [] }, { findings: [major('a'), major('b')] })
  s.step({ do: 'executor', items: ['F1', 'F2'] }, { replies: { F1: 'cant', F2: 'fixed' }, change: true })
  s.step({ do: 'check' })
  s.call('findings')
  s.you({ kind: 'verdict', id: 'F1', to: 'defer' }, 'в docs/todo.md')
  s.setChecks([{ repo: 'app', command: 'npm run ci' }])
  s.step({ do: 'check' }, { ok: false })
  s.step({ do: 'fix-check' }, { change: true })
  assert.deepEqual(s.fold().fresh, ['F1'])
  s.step({ do: 'check' })
  s.step({ do: 'executor', items: ['F1'] }, { replies: { F1: 'documented' }, change: true })
  assert.deepEqual(s.fold().fresh, [])
  s.step({ do: 'check' })
  s.step({ do: 'review', full: true, verify: ['F1', 'F2'] }, { verify: { F1: true, F2: true } })
  s.mark()
})

test('run г · dispute: verify-only review says no → call (4) → reject → mark (7)', () => {
  const s = sim()
  s.step({ do: 'check' })
  s.step({ do: 'review', full: true, verify: [] }, { findings: [major('a')] })
  s.step({ do: 'executor', items: ['F1'] }, { replies: { F1: 'contested' } }) // code the same: no check
  s.step({ do: 'review', full: false, verify: ['F1'] }, { verify: { F1: false } })
  assert.equal(stateOf(s, 'F1'), 'disputed')
  s.call('findings')
  s.you({ kind: 'verdict', id: 'F1', to: 'reject' })
  s.mark()
})

test('run д · the check will not go green: 3 red → stop (3б) → new command → check ✓ (2) → R1', () => {
  const s = sim()
  s.step({ do: 'check' }, { ok: false })
  s.step({ do: 'fix-check' }, { change: true })
  s.step({ do: 'check' }, { ok: false })
  s.step({ do: 'fix-check' }, { change: true })
  s.step({ do: 'check' }, { ok: false })
  s.call('check-red')
  s.setChecks([{ repo: 'app', command: 'npm run test:unit' }])
  s.step({ do: 'check' })
  s.step({ do: 'review', full: true, verify: [] })
})

test('run д · or: red check, the executor leaves the code → stop (3а)', () => {
  const s = sim()
  s.step({ do: 'check' }, { ok: false })
  s.step({ do: 'fix-check' })
  s.call('check-unchanged')
  // your comment: counters start again, the executor gets another try
  s.you({ kind: 'note', text: 'look at the snapshot' })
  s.step({ do: 'fix-check' }, { change: true })
  s.step({ do: 'check' })
})

test('run е · calibration: F1 → minor, the executor gets only F2', () => {
  const s = sim()
  s.step({ do: 'check' })
  s.step({ do: 'review', full: true, verify: [] }, { findings: [blocker('a'), major('b')] })
  s.you({ kind: 'severity', id: 'F1', to: 'minor' }, 'это стиль')
  s.step({ do: 'executor', items: ['F2'] }, { replies: { F2: 'fixed' }, change: true })
  s.step({ do: 'check' })
  s.step({ do: 'review', full: true, verify: ['F2'] }, { verify: { F2: true } })
  s.mark()
  assert.equal(stateOf(s, 'F1'), 'open')
})

test('run ж · something new every round → budget (8) → you decide', () => {
  const round = () => {
    const s = sim()
    s.step({ do: 'check' })
    s.step({ do: 'review', full: true, verify: [] }, { findings: [major('a')] })
    s.step({ do: 'executor', items: ['F1'] }, { replies: { F1: 'fixed' }, change: true })
    s.step({ do: 'check' })
    s.step({ do: 'review', full: true, verify: ['F1'] }, { verify: { F1: true }, findings: [major('b')] })
    s.step({ do: 'executor', items: ['F2'] }, { replies: { F2: 'fixed' }, change: true })
    s.step({ do: 'check' })
    s.step({ do: 'review', full: true, verify: ['F2'] }, { verify: { F2: true }, findings: [major('c')] })
    s.call('budget')
    return s
  }
  const minor = round()
  minor.you({ kind: 'severity', id: 'F3', to: 'minor' })
  minor.mark()

  const defer = round()
  defer.you({ kind: 'verdict', id: 'F3', to: 'defer' })
  defer.step({ do: 'executor', items: ['F3'] }, { replies: { F3: 'documented' }, change: true })

  const resume = round()
  resume.you({ kind: 'command', cmd: 'resume' })
  resume.step({ do: 'executor', items: ['F3'] }, { replies: { F3: 'fixed' }, change: true })
})

// --- fold details -------------------------------------------------------------------------

test('fold: a move not allowed is kept, marked ignored, and changes nothing', () => {
  const s = sim()
  s.step({ do: 'check' })
  s.step({ do: 'review', full: true, verify: [] }, { findings: [major('a'), major('b')] })
  s.you({ kind: 'verdict', id: 'F1', to: 'reject' })
  const verdictSeq = s.j.length
  s.step({ do: 'executor', items: ['F2'] }, { replies: { F1: 'fixed', F2: 'fixed' }, change: true })
  const run = s.fold()
  assert.deepEqual([stateOf(s, 'F1'), stateOf(s, 'F2')], ['rejected', 'fixed'])
  assert.deepEqual(run.ignored, [s.j.length])
  assert.deepEqual(run.ignoredMoves, [{ seq: s.j.length, id: 'F1' }])
  assert.deepEqual(run.decided, ['F1'])
  assert.ok(verdictSeq < s.j.length)
})

test('fold: your verdict applies at once, even mid-step; next waits for the boundary', () => {
  const s = sim()
  s.step({ do: 'check' })
  s.step({ do: 'review', full: true, verify: [] }, { findings: [nit('a'), major('b')] })
  s.step({ do: 'executor', items: ['F2'] }, {
    during: () => {
      s.you({ kind: 'verdict', id: 'F1', to: 'must' })
      assert.equal(stateOf(s, 'F1'), 'must')
      s.expect({ do: 'wait', why: 'step-running' })
    },
    replies: { F2: 'fixed' },
    change: true
  })
  // F1 is a nit but has your verdict: tracked. It was not stuck with you, so
  // it does not jump the review: rule 6 first reviews the changed code and
  // verifies F2, then the executor gets F1.
  s.step({ do: 'check' })
  s.step({ do: 'review', full: true, verify: ['F2'] }, { verify: { F2: true } })
  s.step({ do: 'executor', items: ['F1'] }, { replies: { F1: 'fixed' }, change: true })
})

test('fold: a turn you start counts as your entry — it lifts `called` and resets the counters', () => {
  const s = sim()
  s.step({ do: 'check' }, { ok: false })
  s.step({ do: 'fix-check' }, { change: true })
  s.step({ do: 'check' }, { ok: false })
  s.step({ do: 'fix-check' }, { change: true })
  s.step({ do: 'check' }, { ok: false })
  s.call('check-red')
  assert.equal(s.fold().sinceYou.redChecks, 3)
  s.userTurn()
  const run = s.fold()
  assert.equal(run.called, undefined)
  assert.deepEqual(run.sinceYou, { reviews: 0, redChecks: 0 })
  assert.equal(run.lastYou, s.j.length)
  s.step({ do: 'check' })
})

test('fold: F-numbers go in order across reviews; notes wait for the next executor step', () => {
  const s = sim({ checks: [] })
  s.step({ do: 'review', full: true, verify: [] }, { findings: [major('a'), nit('b')] })
  s.you({ kind: 'note', text: 'mind the tests' })
  assert.deepEqual(s.fold().pendingNotes, ['mind the tests'])
  s.step({ do: 'executor', items: ['F1'] }, { replies: { F1: 'fixed' }, change: true })
  assert.deepEqual(s.fold().pendingNotes, [])
  s.step({ do: 'review', full: true, verify: ['F1'] }, { verify: { F1: true }, findings: [major('c')] })
  assert.deepEqual(s.fold().findings.map((f) => [f.id, f.raisedIn]), [['F1', 1], ['F2', 1], ['F3', 2]])
})

// --- next details ---------------------------------------------------------------------------

test('next: pause, rerun, failures, idle executor', () => {
  const s = sim()
  s.step({ do: 'check' })
  s.you({ kind: 'command', cmd: 'pause' })
  s.expect({ do: 'wait', why: 'paused' })
  // a rerun asked for while paused runs at this boundary; the run stays paused after it
  s.you({ kind: 'command', cmd: 'rerun-check' })
  s.step({ do: 'check' }, { rule: 'rerun' })
  s.expect({ do: 'wait', why: 'paused' })
  s.you({ kind: 'command', cmd: 'resume' })
  s.step({ do: 'review', full: true, verify: [] }, { findings: [major('a')] })
  // idle executor: no reply, code the same (5)
  s.step({ do: 'executor', items: ['F1'] })
  s.call('idle-executor')
  s.you({ kind: 'command', cmd: 'rerun-review' })
  s.step({ do: 'review', full: true, verify: [] }, { rule: 'rerun' })
  // a failed RPM turn calls you; your entry re-decides
  s.step({ do: 'executor', items: ['F1'] }, { outcome: 'failed' })
  s.call('executor-failed')
  s.you({ kind: 'command', cmd: 'resume' })
  s.step({ do: 'executor', items: ['F1'] }, { replies: { F1: 'fixed' }, change: true })
  s.expect({ do: 'check' })
})

test('next: an ordinary partial fix that changed the tree → check, then a full review (6) before the executor again', () => {
  const s = sim()
  s.step({ do: 'check' })
  s.step({ do: 'review', full: true, verify: [] }, { findings: [major('a'), major('b')] })
  s.step({ do: 'executor', items: ['F1', 'F2'] }, { replies: { F1: 'fixed' }, change: true })
  s.step({ do: 'check' })
  s.step({ do: 'review', full: true, verify: ['F1'] }, { verify: { F1: true } })
  s.step({ do: 'executor', items: ['F2'] }, { replies: { F2: 'fixed' }, change: true })
})

test('next: a rerun review asked for while paused runs at this boundary', () => {
  const s = sim({ checks: [] })
  s.step({ do: 'review', full: true, verify: [] }, { findings: [major('a')] })
  s.you({ kind: 'command', cmd: 'pause' })
  s.you({ kind: 'command', cmd: 'rerun-review' })
  s.step({ do: 'review', full: true, verify: [] }, { rule: 'rerun' })
  s.expect({ do: 'wait', why: 'paused' })
})

test('next: no check configured → no check steps', () => {
  const s = sim({ checks: [] })
  s.step({ do: 'review', full: true, verify: [] })
  s.mark()
})

test('next: a changed check command runs the check on the same tree (2)', () => {
  const s = sim()
  s.step({ do: 'check' })
  s.setChecks([{ repo: 'app', command: 'npm run ci' }])
  s.expect({ do: 'check' })
})
