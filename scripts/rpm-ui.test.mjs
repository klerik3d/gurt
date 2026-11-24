// rpm/ui: the Review tab (t4v1 task 11; t2v3 A, B; t3v2 §3.2, §3.3).
//
//   - before the first run the tab is the settings (A): every field with its
//     text behind the "i", the reviewer through the app's ReviewerFields;
//   - on a run that calls you (run в of t1v6 §7): the status line and its
//     buttons, the run picker, the quick filters with counts and "waiting for
//     you" on, the table, the folds, the badge;
//   - the status line of t2v3 B for every phase; filters and column sort.
//
//   node scripts/rpm-ui.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bundle } from './lib/bundle.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-rpm-ui-'))
const outfile = path.join(dir, 'ui.mjs')
const src = (p) => JSON.stringify(path.join(ROOT, p))
await bundle({
  stdin: {
    contents: `
      export * from ${src('src/rpm/ui/index.ts')}
      export { ReviewTabView } from ${src('src/rpm/ui/ReviewTab.tsx')}
      export { inFilter, sortFindings, STATUS_BUTTON } from ${src('src/rpm/ui/labels.ts')}
      export { fold, view, DEFAULT_CONFIG } from ${src('src/rpm/core/index.ts')}
      export { createElement } from 'react'
      export { renderToStaticMarkup } from 'react-dom/server'
    `,
    resolveDir: ROOT,
    loader: 'tsx'
  },
  jsx: 'automatic',
  banner: { js: "import { createRequire as __gurtRequire } from 'node:module'; const require = __gurtRequire(import.meta.url);" },
  outfile
})
const m = await import(pathToFileURL(outfile).href)
after(() => fs.rmSync(dir, { recursive: true, force: true }))
const h = m.createElement

const CFG = { ...m.DEFAULT_CONFIG, enabled: true, reviewer: { agent: 'codex', options: { model: 'sol-6.1' } } }

function fakeHost() {
  const calls = []
  const rec = (name) => async (...args) => { calls.push([name, ...args]) }
  return {
    calls,
    host: {
      api: {
        rpmRuns: async () => [], rpmState: async () => undefined, rpmConfig: async () => CFG,
        rpmSetConfig: rec('rpmSetConfig'), rpmVerdict: rec('rpmVerdict'), rpmSeverity: rec('rpmSeverity'),
        rpmNote: rec('rpmNote'), rpmCommand: rec('rpmCommand'), onRpm: () => () => {}
      },
      openFile: () => {}, openChat: () => {}, confirm: async () => true,
      reviewerProblem: (agent) => (agent === 'pi' ? "Pi does not receive gurt's tools" : agent ? undefined : 'Pick a reviewer client first.'),
      InfoDot: ({ text }) => h('span', { className: 'info-dot', 'data-info': text }),
      ReviewerFields: ({ value, info, problem }) => h('div', { className: 'reviewer-fields', 'data-info': info, 'data-problem': problem ?? '' }, `reviewer ${value.agent}`)
    }
  }
}

const render = (el, host = fakeHost().host) => m.renderToStaticMarkup(h(m.RpmHostProvider, { host }, el))
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ')

/** Run в of t1v6 §7 up to the call: F1 can't (yours), F2 fixed (the reviewer's). */
function runV() {
  const j = []
  const push = (by, body) => j.push({ seq: j.length + 1, at: `2026-11-24T10:${String(j.length).padStart(2, '0')}:00Z`, by, ...body })
  const green = (step, tree) => ({ kind: 'check', step, tree, ok: true, runs: [{ repo: 'app', command: 'npm test', code: 0, ms: 9, tail: ['ok'] }] })
  push('rpm', { kind: 'start', executor: 'e1', run: 1, turnId: 'u0', base: [{ repo: 'app', commit: 'c0' }], config: CFG })
  push('rpm', { kind: 'step', step: 1, what: 'check', rule: '2', tree: 'T0', key: 'e1:1:1' })
  push('check', green(1, 'T0'))
  push('rpm', { kind: 'step', step: 2, what: 'review', rule: '6', tree: 'T0', full: true, items: [], key: 'e1:1:2' })
  push('reviewer', { kind: 'review', step: 2, tree: 'T0', full: true, verify: [], findings: [
    { id: 'F1', severity: 'major', file: 'app/src/store.ts', line: 17, claim: 'Two saves in a row race', scenario: 'save twice within 50 ms' },
    { id: 'F2', severity: 'major', claim: 'No test for the fix', scenario: 'revert keeps the suite green' }
  ] })
  push('rpm', { kind: 'step', step: 3, what: 'executor', rule: '9', tree: 'T0', items: ['F1', 'F2'], key: 'e1:1:3' })
  push('executor', { kind: 'turn', step: 3, turnId: 't3', origin: 'rpm', tree: 'T1', outcome: 'changes', replies: [
    { id: 'F1', act: 'cant', comment: 'Needs a schema migration.' },
    { id: 'F2', act: 'fixed', comment: 'Done.' }
  ] })
  push('rpm', { kind: 'step', step: 4, what: 'check', rule: '2', tree: 'T1', key: 'e1:1:4' })
  push('check', green(4, 'T1'))
  push('rpm', { kind: 'call', why: 'findings' })
  return m.view(m.fold(j), j)
}

const RUNS = [
  { run: 1, startedAt: '2026-11-24T10:00:00Z', result: 'live', findings: 2, reviews: 1 }
]

test('before the first run the tab is the settings of t2v3 A', () => {
  const html = render(h(m.ReviewTabView, {
    executor: 'e1',
    data: { loaded: true, state: undefined, runs: [], config: { ...m.DEFAULT_CONFIG }, error: undefined },
    onRun: () => {}
  }))
  const t = text(html)
  for (const label of ['Review', 'Threshold', 'Attempts', 'Reviews']) assert.match(t, new RegExp(label))
  // off is on by default; major, 2, 3 are the defaults.
  assert.match(html, /chip-btn on">off</)
  assert.match(html, /chip-btn on">major</)
  assert.match(html, /chip-btn on">2</)
  assert.match(html, /chip-btn on">3</)
  // The reviewer is the app's two-step picker; the explanations sit behind the "i".
  assert.match(html, /class="reviewer-fields"/)
  assert.match(html, /data-info="After each executor turn that changes code/)
  assert.match(html, /data-info="The client the reviewer runs on/)
  assert.match(html, /data-info="How many fixes of one finding/)
  assert.doesNotMatch(html, /class="dot/)
})

test('off: the switch says so and every other setting is disabled', () => {
  const html = render(h(m.ReviewTabView, {
    executor: 'e1',
    data: { loaded: true, state: undefined, runs: [], config: { ...CFG, enabled: false }, error: undefined },
    onRun: () => {}
  }))
  assert.match(text(html), /Review is off/)
  // The switch stays live; what it governs sits in disabled fieldsets.
  const [before, reviewer, rest] = html.split('<fieldset')
  assert.match(before, /chip-btn on">off</)
  assert.match(reviewer, /^ class="rpm-fields" disabled=""/)
  assert.match(reviewer, /class="reviewer-fields"/)
  assert.match(rest, /^ class="rpm-fields" disabled=""/)
  assert.match(rest, /chip-btn on">major</)
  // No reviewer at all is a problem too: the picker stays open for the first pick.
  const none = render(h(m.ReviewTabView, {
    executor: 'e1',
    data: { loaded: true, state: undefined, runs: [], config: { ...m.DEFAULT_CONFIG }, error: undefined },
    onRun: () => {}
  }))
  assert.match(none.split('<fieldset')[1], /^ class="rpm-fields">/)
  // Off with a reviewer that refuses "on": the reviewer stays pickable — it is
  // the only way to turn the review on — the rest stays off.
  const stuck = render(h(m.ReviewTabView, {
    executor: 'e1',
    data: { loaded: true, state: undefined, runs: [], config: { ...m.DEFAULT_CONFIG, reviewer: { agent: 'pi', options: {} } }, error: undefined },
    onRun: () => {}
  }))
  const [, rev, others] = stuck.split('<fieldset')
  assert.match(rev, /^ class="rpm-fields">/)
  assert.match(rev, /data-problem="Pi does not receive/)
  assert.match(others, /^ class="rpm-fields" disabled=""/)
  const on = render(h(m.ReviewTabView, {
    executor: 'e1',
    data: { loaded: true, state: undefined, runs: [], config: CFG, error: undefined },
    onRun: () => {}
  }))
  assert.doesNotMatch(on, /disabled=""/)
  assert.doesNotMatch(text(on), /Review is off/)
})

test('review cannot be turned on without a reviewer that can submit a review', () => {
  const settings = (reviewer) => render(h(m.ReviewTabView, {
    executor: 'e1',
    data: { loaded: true, state: undefined, runs: [], config: { ...m.DEFAULT_CONFIG, reviewer }, error: undefined },
    onRun: () => {}
  }))
  // A client without gurt's tools (Pi): "on" is disabled and the field says why.
  let html = settings({ agent: 'pi', options: {} })
  assert.match(html, /<button type="button" class="chip-btn " disabled="" title="Pi does not receive gurt&#x27;s tools">on</)
  assert.match(html, /data-problem="Pi does not receive gurt&#x27;s tools"/)
  // None chosen yet: the same.
  assert.match(settings({ agent: '', options: {} }), /disabled="" title="Pick a reviewer client first.">on</)
  // A usable one: "on" can be pressed.
  html = settings({ agent: 'codex', options: {} })
  assert.match(html, /<button type="button" class="chip-btn ">on</)
  assert.match(html, /data-problem=""/)
})

test('a run that calls you: status, run picker, filters with counts, table, folds, badge', () => {
  const state = runV()
  assert.equal(state.status.phase, 'called')
  const html = render(h(m.ReviewTabView, {
    executor: 'e1',
    data: { loaded: true, state, runs: RUNS, config: CFG, error: undefined },
    onRun: () => {}
  }))
  const t = text(html)
  assert.match(t, /Waiting for you · 1 finding/)
  assert.match(t, /run 1 ▾/)
  assert.match(t, /reviews 1 of 3/)
  assert.match(t, /check passed/)
  // Waiting for findings: Stop only (t2v3 B).
  assert.match(html, />Stop</)
  assert.doesNotMatch(html, />Pause<|>Continue</)
  // Quick filters with counts; "waiting for you" stands by itself.
  assert.match(html, /chip-btn on">waiting for you<span class="rpm-n">1</)
  assert.match(html, />reviewer<span class="rpm-n">1</)
  assert.match(html, />all<span class="rpm-n">2</)
  // The table shows what waits for you: F1 with where, claim, state, tries.
  assert.match(t, /F1/)
  assert.match(t, /app\/src\/store\.ts:17/)
  assert.match(t, /Two saves in a row race/)
  assert.match(t, /can't/)
  assert.match(t, /0\/2/)
  assert.doesNotMatch(t, /No test for the fix/)
  assert.match(html, /class="sorted"[^>]*>severity ▾/)
  // History and Settings fold under the table.
  assert.match(t, /History .*entries/)
  assert.match(t, /Settings sol-6\.1 · major · 2 · 3/)
  assert.equal(m.badgeCount(state), 1)
})

test('the badge counts only a live call', () => {
  const state = runV()
  assert.equal(m.badgeCount(undefined), 0)
  assert.equal(m.badgeCount({ ...state, live: false }), 0)
  assert.equal(m.badgeCount({ ...state, status: { ...state.status, phase: 'paused' } }), 0)
})

test('the status line of t2v3 B, phase by phase', () => {
  const base = { live: true, config: CFG, findings: [], journal: [] }
  const line = (status) => m.statusLine({ ...base, status: { reviewsSinceYou: 0, ...status } })
  assert.deepEqual(line({ phase: 'review', review: 2, full: false, items: 3, session: 'r' }), { text: 'Reviewer R2 is checking 3 findings', buttons: ['pause', 'stop'] })
  assert.equal(line({ phase: 'executor', items: 2 }).text, 'Executor is fixing 2 findings')
  assert.equal(line({ phase: 'fix-check', try: 2, of: 3 }).text, 'Executor is fixing the check · try 2 of 3')
  assert.equal(line({ phase: 'check', repos: ['api', 'web'] }).text, 'Running check · api, web')
  assert.equal(line({ phase: 'review', review: 2, full: false, items: 3, session: 'r', waitingPlan: '2026-11-24T15:40:00' }).text, 'Reviewer R2 waits for its plan limit · 15:40')
  const red = line({ phase: 'called', why: 'check-red', items: [] })
  assert.equal(red.text, 'Stopped · check failed 3 times in a row')
  assert.equal(red.output, true)
  assert.deepEqual(red.buttons, ['continue', 'stop'])
  assert.deepEqual(line({ phase: 'called', why: 'budget', items: [], reviewsSinceYou: 3 }), { text: 'Waiting for you · 3 reviews without you', buttons: ['continue', 'stop'] })
  assert.deepEqual(line({ phase: 'passed', files: 4 }), { text: 'Passed', marked: 4, buttons: [] })
  assert.deepEqual(line({ phase: 'paused' }).buttons, ['resume', 'stop'])
  // Continue sends `resume`, which rpm/main accepts on a called run (rpm-engine.test.mjs, "Continue on a call").
  assert.equal(m.STATUS_BUTTON.continue.cmd, 'resume')
  assert.equal(m.STATUS_BUTTON.continue.label, 'Continue')
})

test('filters and column sort', () => {
  const state = runV()
  const ids = (xs) => xs.map((f) => f.id)
  assert.deepEqual(ids(state.findings.filter((f) => m.inFilter(f, 'you'))), ['F1'])
  assert.deepEqual(ids(state.findings.filter((f) => m.inFilter(f, 'reviewer'))), ['F2'])
  assert.deepEqual(ids(state.findings.filter((f) => m.inFilter(f, 'final'))), [])
  const nit = { ...state.findings[1], id: 'F3', severity: 'nit', tracked: false }
  const all = [nit, ...state.findings]
  assert.deepEqual(ids(m.sortFindings(all, 'severity', true)), ['F1', 'F2', 'F3'])
  assert.deepEqual(ids(m.sortFindings(all, 'severity', false)), ['F3', 'F1', 'F2'])
  assert.deepEqual(ids(m.sortFindings(all, 'id', true)), ['F3', 'F2', 'F1'])
  // "state": yours first.
  assert.deepEqual(ids(m.sortFindings(state.findings, 'state', true)), ['F1', 'F2'])
})
