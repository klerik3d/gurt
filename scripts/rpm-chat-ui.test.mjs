// rpm/ui: chat lines, the finding popup, links (t4v1 task 12; t2v3 C, D; t3v2 §3.3, §10.2).
//
//   - a handoff line reads who → whom → findings with what; ▾ is there when the
//     agent got a text; a red check is red; a note is "<text> queued"; "review
//     passed" links "marked N files";
//   - F-numbers are links (to Review) with a hover popup; without a host (an
//     archived chat) they are plain text;
//   - the popup body: id, severity, state and whose move, claim, file:line, the
//     last comment;
//   - the Review tab opens on the row / filter a link asked for.
//
//   node scripts/rpm-chat-ui.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bundle } from './lib/bundle.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-rpm-chat-ui-'))
const outfile = path.join(dir, 'ui.mjs')
const src = (p) => JSON.stringify(path.join(ROOT, p))
await bundle({
  stdin: {
    contents: `
      export * from ${src('src/rpm/ui/index.ts')}
      export { ReviewTabView, History, resolveFocus } from ${src('src/rpm/ui/ReviewTab.tsx')}
      export { actorTarget } from ${src('src/rpm/ui/ChatLine.tsx')}
      export { fold, view, chatLines, DEFAULT_CONFIG } from ${src('src/rpm/core/index.ts')}
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

const CFG = { ...m.DEFAULT_CONFIG, enabled: true, reviewer: { agent: 'codex', options: {} } }

const host = {
  api: {
    rpmRuns: async () => [], rpmState: async () => undefined, rpmConfig: async () => CFG,
    rpmSetConfig: async () => {}, rpmVerdict: async () => {}, rpmSeverity: async () => {},
    rpmNote: async () => {}, rpmCommand: async () => {}, onRpm: () => () => {}
  },
  openFile: () => {}, openChat: () => {}, openChatLine: () => {}, openReview: () => {}, openDiff: () => {}, scopeOf: () => ({ ws: 'w', task: 't' }), confirm: async () => true,
  reviewerProblem: () => undefined,
  InfoDot: () => null,
  ReviewerFields: () => null
}
const render = (el) => m.renderToStaticMarkup(h(m.RpmHostProvider, { host }, el))
const bare = (el) => m.renderToStaticMarkup(el)
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()

/** Run в of t1v6 §7 up to the call: F1 can't (yours), F2 fixed. */
function journal() {
  const j = []
  const push = (by, body) => j.push({ seq: j.length + 1, at: `2026-11-24T10:${String(j.length).padStart(2, '0')}:00Z`, by, ...body })
  push('rpm', { kind: 'start', executor: 'e1', run: 1, turnId: 'u0', base: [{ repo: 'app', commit: 'c0' }], config: CFG })
  push('rpm', { kind: 'step', step: 1, what: 'review', rule: '6', tree: 'T0', full: true, items: [], key: 'e1:1:1' })
  push('reviewer', { kind: 'review', step: 1, tree: 'T0', full: true, verify: [], findings: [
    { id: 'F1', severity: 'major', file: 'app/src/store.ts', line: 17, claim: 'Two saves in a row race', scenario: 'save twice within 50 ms' },
    { id: 'F2', severity: 'major', claim: 'No test for the fix', scenario: 'revert keeps the suite green' }
  ] })
  push('rpm', { kind: 'step', step: 2, what: 'executor', rule: '9', tree: 'T0', items: ['F1', 'F2'], key: 'e1:1:2' })
  push('executor', { kind: 'turn', step: 2, turnId: 't2', origin: 'rpm', tree: 'T1', outcome: 'changes', replies: [
    { id: 'F1', act: 'cant', comment: 'Needs a schema migration.' },
    { id: 'F2', act: 'fixed', comment: 'Done.' }
  ] })
  push('rpm', { kind: 'call', why: 'findings' })
  return j
}
const upTo = (j, seq) => m.fold(j.slice(0, seq))

test('handoff lines: who → whom → findings, ▾ with the full text', () => {
  const j = journal()
  const step = m.chatLines.executorStep(upTo(j, 4), j[3], 'Fix these:\nF1 …\nF2 …')
  let html = render(h(m.RpmChatLine, { line: step }))
  assert.equal(text(html).replace(' ▾', ''), 'reviewer R1 → executor F1 F2')
  assert.match(html, /class="btn-link rpm-link rpm-fid mono">F1</)
  assert.match(html, /aria-expanded="false"[^>]*>▾</)
  // Both participants link to their chat message (t2v3 D).
  assert.match(html, /rpm-actor">reviewer R1<\/button>/)
  assert.match(html, /rpm-actor">executor<\/button>/)

  const [toReviewer, toYou] = m.chatLines.turn(upTo(j, 5), j[4])
  html = render(h(m.RpmChatLine, { line: toReviewer }))
  assert.match(text(html), /^executor → reviewer F2 fixed/)
  html = render(h(m.RpmChatLine, { line: toYou }))
  assert.match(text(html), /^executor → you F1 can't/)

  // A review: "reviewer R1 → gurt … · new F8", F8 a link too.
  html = render(h(m.RpmChatLine, { line: { executor: 'e1', run: 1, seq: 9, from: 'reviewer', review: 2, to: 'gurt',
    items: [{ id: 'F1', label: 'F1 yes' }], more: 'new F8', text: 'F1 yes: ok', kind: 'handoff' } }))
  assert.match(text(html), /^reviewer R2 → gurt F1 yes · new F8/)
  assert.match(html, /rpm-fid mono">F8</)
})

test('a red check is red; a note is queued; passed links the marked files', () => {
  let html = render(h(m.RpmChatLine, { line: { executor: 'e1', run: 1, seq: 7, from: 'check', to: 'executor', items: [],
    more: 'npm test failed', text: 'npm test → exit 1', kind: 'check-red' } }))
  assert.match(html, /class="rpm-line rpm-line-red"/)
  assert.match(text(html), /^check → executor npm test failed/)

  html = render(h(m.RpmChatLine, { line: { executor: 'e1', run: 1, seq: 8, from: 'you', to: 'executor', items: [],
    more: 'queued', text: 'also rename exportCsv', kind: 'note-queued' } }))
  assert.equal(text(html), 'also rename exportCsv queued')

  html = render(h(m.RpmChatLine, { line: { executor: 'e1', run: 1, seq: 9, from: 'rpm', to: 'you', items: [],
    more: 'marked 4 files', kind: 'passed' } }))
  assert.equal(text(html), "review passed marked 4 files")
  assert.match(html, /<button type="button" class="btn-link rpm-link">marked 4 files<\/button>/)
})

test('without a host (an archived chat) the line is plain text', () => {
  const j = journal()
  const html = bare(h(m.RpmChatLine, { line: m.chatLines.executorStep(upTo(j, 4), j[3], 'x') }))
  assert.equal(text(html).replace(' ▾', ''), 'reviewer R1 → executor F1 F2')
  assert.doesNotMatch(html, /rpm-link/)
})

test('the popup: id, severity, state and whose move, claim, file:line, last comment', () => {
  const j = journal()
  const state = m.view(m.fold(j), j)
  const f1 = state.findings.find((f) => f.id === 'F1')
  const html = render(h(m.FindingPopup, { id: 'F1', finding: f1, onOpenFile: () => {} }))
  const t = text(html)
  assert.match(t, /^F1 major can't · waiting for you/)
  assert.match(t, /Two saves in a row race/)
  assert.match(t, /app\/src\/store\.ts:17/)
  assert.match(t, /executor: Needs a schema migration\./)
  assert.match(text(render(h(m.FindingPopup, { id: 'F9', finding: null }))), /F9 · not in this run/)
})

test('F-numbers in plain text become links', () => {
  const html = render(h(m.FindingText, { executor: 'e1', run: 1, text: 'R1 · F1 no · new F3 F4' }))
  assert.equal((html.match(/rpm-fid/g) ?? []).length, 3)
  assert.equal(text(html), 'R1 · F1 no · new F3 F4')
})

test('the Review tab opens on the row or filter a link asked for', () => {
  const j = journal()
  const state = m.view(m.fold(j), j)
  const runs = [{ run: 1, startedAt: '2026-11-24T10:00:00Z', result: 'live', findings: 2, reviews: 1 }]
  const tab = (focus) => render(h(m.ReviewTabView, {
    executor: 'e1', data: { loaded: true, state, runs, config: CFG, error: undefined }, onRun: () => {}, focus
  }))
  // F2 (fixed, the reviewer's move) is not in "waiting for you": the filter goes to "all", the row is open.
  let html = tab({ run: 1, finding: 'F2' })
  assert.match(html, /chip-btn on">all</)
  assert.match(html, /class="rpm-row open" data-fid="F2"/)
  // The badge / a notification: "waiting for you".
  html = tab({ filter: 'you' })
  assert.match(html, /chip-btn on">waiting for you</)
  assert.doesNotMatch(html, /rpm-row open/)
})

test('markFiles: <repo>/<path> of every marked file', () => {
  assert.deepEqual(m.markFiles({ repos: [
    { repo: 'api', files: [{ path: 'a.ts', status: 'M' }] },
    { repo: 'web', files: [{ path: 'src/b.ts', status: 'A' }, { path: 'c.ts', status: 'D' }] }
  ] }), ['api/a.ts', 'web/src/b.ts', 'web/c.ts'])
})

test('actorTarget: the sender is its own message, the addressee the handoff it got — also while it works', () => {
  const ref = (sessionId, entryId) => ({ sessionId, entryId })
  const at = (seq) => ({ executor: 'e1', run: 1, seq })
  const journal = [
    { seq: 2, kind: 'step', what: 'review', step: 1 },
    { seq: 3, kind: 'review', step: 1 },
    { seq: 4, kind: 'step', what: 'executor', step: 2 },
    { seq: 5, kind: 'turn', step: 2 },
    { seq: 6, kind: 'step', what: 'check', step: 3 },
    { seq: 8, kind: 'step', what: 'review', step: 4 }
  ]
  const findings = [
    { id: 'F1', history: [
      { seq: 3, by: 'reviewer', review: 1, chat: ref('rv1', 4) },
      { seq: 5, by: 'executor', chat: ref('e1', 9) }
    ] }
  ]
  // R2 is at work: its review is not recorded, there is no history ref for it yet.
  const working = { journal, findings, status: { phase: 'review', review: 2, full: false, items: 1, session: 'rv2', reviewsSinceYou: 1 } }
  // In the executor's chat: "executor → reviewer F1 fixed" (the turn, seq 5).
  const turn = { executor: 'e1', run: 1, seq: 5, from: 'executor', to: 'reviewer', items: [{ id: 'F1', label: 'F1 fixed' }], kind: 'handoff' }
  assert.deepEqual(m.actorTarget(working, turn, 'reviewer', 'to'), { sessionId: 'rv2', line: at(8) })
  assert.deepEqual(m.actorTarget(working, turn, 'executor', 'from'), ref('e1', 9))
  // "reviewer R1 → executor F1" (step at seq 4): R1's own message; the executor's incoming line.
  const step = { executor: 'e1', run: 1, seq: 4, from: 'reviewer', review: 1, to: 'executor', items: [{ id: 'F1', label: 'F1' }], kind: 'handoff' }
  assert.deepEqual(m.actorTarget(working, step, 'reviewer', 'from'), ref('rv1', 4))
  assert.deepEqual(m.actorTarget(working, step, 'executor', 'to'), { sessionId: 'e1', line: at(4) })
  // After R1 recorded: a line before step 1 goes to R1's session, found by its review's ref.
  const early = { ...turn, seq: 1 }
  assert.deepEqual(m.actorTarget({ ...working, status: { phase: 'executor', items: 1, reviewsSinceYou: 0 } }, early, 'reviewer', 'to'), { sessionId: 'rv1', line: at(2) })
  // R2's session unknown once the review is over without a record: no target.
  assert.equal(m.actorTarget({ ...working, status: { phase: 'paused', reviewsSinceYou: 1 } }, turn, 'reviewer', 'to'), undefined)
  assert.equal(m.actorTarget(undefined, turn, 'executor', 'from'), undefined)
})

test('History: a failed check has its output on the spot', () => {
  const j = journal()
  j.splice(5, 0, { seq: 0, at: '2026-11-24T10:30:00Z', by: 'check', kind: 'check', step: 3, tree: 'T1', ok: false,
    runs: [{ repo: 'app', command: 'npm test', code: 1, ms: 9, tail: ['1 failing'] }] })
  j.forEach((e, i) => { e.seq = i + 1 })
  const html = render(h(m.History, { executor: 'e1', run: 1, journal: j }))
  assert.match(html, /aria-expanded="false">output ▸<\/button>/)
})

test('a focus without a run is for the last run: an older run on screen does not take it', () => {
  assert.deepEqual(m.resolveFocus({ filter: 'you', finding: 'F1' }, 2), { filter: 'you', finding: 'F1', run: 2 })
  assert.deepEqual(m.resolveFocus({ run: 1, finding: 'F1' }, 2), { run: 1, finding: 'F1' })
  // The last run not known yet: nothing is applied until it is.
  assert.equal(m.resolveFocus({ finding: 'F1' }, undefined), undefined)
  // Run 1 on screen, the focus (a notification for F1) is for run 2: run 1 neither opens the row nor
  // takes the filter — the focus waits for run 2.
  const j = journal()
  const state = m.view(m.fold(j), j)
  const runs = [{ run: 1, startedAt: '2026-11-24T10:00:00Z', result: 'ended', findings: 2, reviews: 1 },
    { run: 2, startedAt: '2026-11-24T11:00:00Z', result: 'live', findings: 1, reviews: 1 }]
  let focused = 0
  const html = render(h(m.ReviewTabView, { executor: 'e1', data: { loaded: true, state, runs, config: CFG, error: undefined },
    onRun: () => {}, focus: { run: 2, filter: 'all', finding: 'F2' }, onFocused: () => focused++ }))
  assert.doesNotMatch(html, /rpm-row open/)
  assert.match(html, /chip-btn on">waiting for you</)
  assert.equal(focused, 0)
})
