// rpm/main without the engine (t4v1 task 8; t3v2 §3.1, §5, §8.1): the journal
// on disk, your entries through the API, the model tools' checks.
//
//   - the journal survives a re-read (a new createRpm on the same dir), a torn
//     last line is dropped and the next append lands on a clean line; a broken
//     middle line ends the run;
//   - a verdict through the API changes `state`; the §3.1 errors;
//   - config/setConfig, for a draft too, durable in config.json;
//   - reply_findings with an act not allowed now refuses with a text;
//   - submit_review without one item refuses; with them all it is accepted.
//
//   node scripts/rpm-main.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bundle } from './lib/bundle.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-rpm-main-${process.pid}.mjs`)
const entry = path.join(os.tmpdir(), `gurt-rpm-main-entry-${process.pid}.ts`)
const S = (p) => JSON.stringify(path.join(ROOT, p))
fs.writeFileSync(entry, `export * from ${S('src/rpm/main/index.ts')}\nexport { DEFAULT_CONFIG } from ${S('src/rpm/core/index.ts')}\n`)
await bundle({ entryPoints: [entry], outfile })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-rpm-main-'))
after(() => {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(entry, { force: true })
  fs.rmSync(tmp, { recursive: true, force: true })
})
const m = await import(pathToFileURL(outfile).href)

const CFG = { ...m.DEFAULT_CONFIG, enabled: true, reviewer: { agent: 'codex', options: {} } }

/** Fake ports: sessions e1 (executor, write repo app), d1 (a draft executor), r2 (the reviewer of step 4). */
function ports(root) {
  const facts = {
    e1: { id: 'e1', ws: 'w', task: 't', title: 'E', role: 'executor', agent: 'claude', writeRepos: ['app'], state: 'started' },
    d1: { id: 'd1', ws: 'w', task: 't', title: 'D', role: 'executor', agent: 'claude', writeRepos: ['app'], state: 'draft' },
    r2: { id: 'r2', ws: 'w', task: 't', title: 'review R2 — E', role: 'reviewer', agent: 'codex', writeRepos: [], state: 'started', reviewerOf: { executor: 'e1', key: 'e1:1:4' } },
    x1: { id: 'x1', ws: 'w', task: 't', title: 'X', role: 'executor', agent: 'claude', writeRepos: ['app'], state: 'started' }
  }
  const trees = [{ repo: 'app', head: 'h1', tree: 't1' }]
  return {
    trees,
    sessions: {
      info: (id) => facts[id],
      list: () => Object.keys(facts),
      // The engine's side of the port (task 9): no-ops here, the engine has its own test.
      hold() {}, release() {}, keepAlive() {}, chatLine() {}, stopContainer: async () => {},
      sent: () => 'unknown', lastSettled: () => undefined
    },
    git: { trees: async () => trees, diff: async () => ({ text: '', truncated: false, files: [] }) },
    check: { run: () => { throw new Error('no') }, commands: () => [] },
    notify: { notify: () => {} },
    store: { dir: (ws, task) => path.join(root, ws, task, 'rpm') }
  }
}

const at = (i) => `2026-11-24T10:${String(i).padStart(2, '0')}:00Z`
/** Run 1 of e1 up to a running review R2 that verifies F1 (fixed) and F2 (contested). */
function seed(root) {
  const bodies = [
    ['rpm', { kind: 'start', executor: 'e1', run: 1, turnId: 'e1:1', base: [{ repo: 'app', commit: 'c0' }], config: CFG }],
    ['rpm', { kind: 'step', step: 1, what: 'check', rule: '2', tree: 'T0', key: 'e1:1:1' }],
    ['check', { kind: 'check', step: 1, tree: 'T0', ok: true, runs: [{ repo: 'app', command: 'npm test', code: 0, ms: 5, tail: [] }] }],
    ['rpm', { kind: 'step', step: 2, what: 'review', rule: '6', tree: 'T0', full: true, items: [], key: 'e1:1:2', session: 'r1' }],
    ['reviewer', { kind: 'review', step: 2, tree: 'T0', full: true, verify: [], findings: [
      { id: 'F1', severity: 'major', file: 'app/a.ts', line: 3, claim: 'a', scenario: 's' },
      { id: 'F2', severity: 'major', claim: 'b', scenario: 's' }
    ] }],
    ['rpm', { kind: 'step', step: 3, what: 'executor', rule: '9', tree: 'T0', items: ['F1', 'F2'], key: 'e1:1:3' }],
    ['executor', { kind: 'turn', step: 3, turnId: 'e1:2', origin: 'rpm', tree: 'T1', outcome: 'changes', replies: [
      { id: 'F1', act: 'fixed', comment: 'done' }, { id: 'F2', act: 'contested', comment: 'no' }
    ] }],
    ['rpm', { kind: 'step', step: 4, what: 'review', rule: '6', tree: 'T1', full: true, items: ['F1', 'F2'], key: 'e1:1:4' }]
  ]
  const lines = bodies.map(([by, b], i) => JSON.stringify(Object.assign({ seq: i + 1, at: at(i), by }, b)) + '\n')
  const dir = path.join(root, 'w', 't', 'rpm', 'e1', 'runs')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '1.jsonl'), lines.join(''))
  return path.join(dir, '1.jsonl')
}

async function fresh(name) {
  const root = path.join(tmp, name)
  const file = seed(root)
  const p = ports(root)
  const rpm = m.createRpm(p)
  await rpm.load()
  return { root, file, p, rpm }
}

test('the journal survives a re-read; a verdict through the API changes state', async () => {
  const { file, p, rpm } = await fresh('reread')
  const changes = []
  rpm.onChange((e) => changes.push(e))
  assert.equal(rpm.state('e1').findings.find((f) => f.id === 'F2').state, 'contested')

  await rpm.verdict('e1', 'F2', 'reject', 'out of scope')
  const s = rpm.state('e1')
  assert.equal(s.findings.find((f) => f.id === 'F2').state, 'rejected')
  assert.equal(s.journal.at(-1).by, 'you')
  assert.deepEqual(changes, [{ executor: 'e1', run: 1 }])
  await rpm.severity('e1', 'F1', 'blocker')
  await rpm.note('e1', 'mind the docs')
  await rpm.command('e1', 'pause')

  // A torn last line from a crash mid-append.
  fs.appendFileSync(file, '{"seq":13,"at":"x","by":"you","kind":"no')
  const again = m.createRpm(p)
  await again.load()
  const s2 = again.state('e1')
  assert.deepEqual(s2.journal, rpm.state('e1').journal)
  assert.equal(s2.findings.find((f) => f.id === 'F1').severity, 'blocker')
  assert.equal(s2.status.phase, 'review') // the step is still running; pause waits for the boundary
  assert.deepEqual(again.runs('e1'), [{ run: 1, startedAt: at(0), result: 'live', findings: 2, reviews: 1 }])
  // The torn line is gone from the file: the next append is a clean line.
  await again.command('e1', 'resume')
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n')
  assert.equal(lines.length, 13)
  assert.ok(lines.every((l) => JSON.parse(l).kind))
  assert.equal(JSON.parse(lines[12]).cmd, 'resume')

  // A broken line in the middle: the run shows up to it and is over.
  const broken = [...lines.slice(0, 5), '{oops', ...lines.slice(5)].join('\n') + '\n'
  fs.writeFileSync(file, broken)
  const third = m.createRpm(p)
  await third.load()
  const s3 = third.state('e1')
  assert.equal(s3.live, false)
  assert.equal(s3.journal.filter((e) => e.kind !== 'end').length, 5)
})

test('your entries: the §3.1 errors', async () => {
  const { rpm } = await fresh('errors')
  await assert.rejects(rpm.verdict('e1', 'F9', 'must'), /No such finding: F9/)
  await rpm.verdict('e1', 'F1', 'must')
  await assert.rejects(rpm.verdict('e1', 'F1', 'must'), /does not change/)
  await assert.rejects(rpm.severity('e1', 'F1', 'major'), /does not change/)
  await assert.rejects(rpm.note('e1', '   '), /empty/)
  await assert.rejects(rpm.command('e1', 'resume'), /not paused/)
  await assert.rejects(rpm.verdict('x1', 'F1', 'must'), /no review run/)
})

test('config: defaults, a draft, durable, a patch on a live run is journaled', async () => {
  const { root, p, rpm } = await fresh('config')
  assert.deepEqual(rpm.config('d1'), m.DEFAULT_CONFIG)
  await rpm.setConfig('d1', { enabled: true, threshold: 'minor' })
  assert.equal(rpm.config('d1').threshold, 'minor')
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'w', 't', 'rpm', 'd1', 'config.json'), 'utf8'))
  assert.equal(onDisk.enabled, true)
  const again = m.createRpm(p)
  assert.equal(again.config('d1').threshold, 'minor')
  await assert.rejects(rpm.setConfig('d1', { attempts: 9 }), /attempts/)
  await assert.rejects(rpm.setConfig('d1', { bogus: 1 }), /Unknown config field/)

  await rpm.setConfig('e1', { threshold: 'nit' })
  const s = rpm.state('e1')
  assert.equal(s.config.threshold, 'nit')
  assert.deepEqual(s.journal.at(-1), { ...s.journal.at(-1), by: 'you', kind: 'config', patch: { threshold: 'nit' } })
})

test('owns, quiets, stepRunning, marks', async () => {
  const { p, rpm } = await fresh('owns')
  assert.equal(rpm.owns('e1'), true)
  assert.equal(rpm.owns('r2'), true)
  assert.equal(rpm.owns('x1'), false)
  assert.equal(rpm.quiets('e1'), true)
  assert.equal(rpm.quiets('x1'), false)
  assert.equal(rpm.stepRunning('w', 't'), true)
  assert.equal(rpm.stepRunning('w', 'other'), false)
  assert.deepEqual(rpm.marks('e1'), [])
  const mark = { executor: 'e1', run: 1, at: at(1), tree: m.treeId(p.trees), repos: [{ repo: 'app', base: 'c0', head: 'h1', tree: 't1', files: [] }], reviews: 1, findings: { closed: 0, rejected: 0, deferred: 0, below: 0 } }
  assert.equal(await rpm.markHolds(mark), true)
  p.trees[0] = { repo: 'app', head: 'h1', tree: 't2' }
  assert.equal(await rpm.markHolds(mark), false)
})

test('tools: reply_findings refuses an act not allowed now, with a text', async () => {
  const { rpm } = await fresh('reply')
  assert.deepEqual(rpm.tools.for('executor').map((t) => t.name), ['reply_findings'])
  assert.deepEqual(rpm.tools.for('reviewer').map((t) => t.name), ['submit_review'])
  assert.match(rpm.tools.instructions('executor'), /reply_findings/)

  assert.throws(() => rpm.tools.call('x1', 'reply_findings', { replies: [{ id: 'F1', act: 'fixed', comment: 'x' }] }), /gurt sent you no findings/)
  assert.throws(() => rpm.tools.call('e1', 'reply_findings', { replies: [{ id: 'F1', act: 'fixed', comment: 'x' }] }), /F1.*waits for the reviewer/)
  await rpm.verdict('e1', 'F2', 'reject')
  assert.throws(() => rpm.tools.call('e1', 'reply_findings', { replies: [{ id: 'F2', act: 'fixed', comment: 'x' }] }), /the user rejected F2/)
  assert.throws(() => rpm.tools.call('e1', 'reply_findings', { replies: [{ id: 'F7', act: 'fixed', comment: 'x' }] }), /F7 is not a finding/)
  assert.throws(() => rpm.tools.call('e1', 'reply_findings', { replies: [] }), /replies/)

  await rpm.verdict('e1', 'F1', 'must')
  const ok = rpm.tools.call('e1', 'reply_findings', { replies: [{ id: 'F1', act: 'fixed', comment: ' again ' }] })
  assert.deepEqual(ok.payload, { replies: [{ id: 'F1', act: 'fixed', comment: 'again' }] })
  assert.match(ok.text, /F1 fixed/)
})

test('tools: submit_review must verify exactly the step items', async () => {
  const { rpm } = await fresh('review')
  const v = (id, accept = true) => ({ id, accept, comment: 'ok' })
  assert.throws(() => rpm.tools.call('r2', 'submit_review', { findings: [], verify: [v('F1')] }), /missing: F2/)
  assert.throws(() => rpm.tools.call('r2', 'submit_review', { findings: [], verify: [v('F1'), v('F2'), v('F3')] }), /not given: F3/)
  assert.throws(
    () => rpm.tools.call('r2', 'submit_review', { findings: [{ severity: 'minor', file: 'lib/x.ts', claim: 'c', scenario: 's' }], verify: [v('F1'), v('F2')] }),
    /must be <repo>\/<path> in one of: app/
  )
  assert.throws(() => rpm.tools.call('e1', 'submit_review', { findings: [], verify: [] }), /not running/)

  const ok = rpm.tools.call('r2', 'submit_review', {
    findings: [{ severity: 'minor', file: 'app/x.ts', line: 2, claim: 'c', scenario: 's' }],
    verify: [v('F2', false), v('F1')]
  })
  assert.deepEqual(ok.payload.verify.map((x) => x.id), ['F1', 'F2'])
  assert.equal(ok.payload.findings.length, 1)
  assert.match(ok.text, /accepted/)
})
