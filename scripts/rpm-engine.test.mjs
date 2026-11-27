// The RPM engine (t4v1 task 9; t3v2 §6, §8.2, §10.2, §12) end to end on fake
// ports: a fake executor and fake reviewers answer through RPM's own model
// tools (`rpm.tools.call`), a fake check runner, a fake git whose tree changes
// when the executor edits.
//
//   - runs а–ж of t1v6 §7 from the first executor turn to the mark or the call;
//   - stop in the middle of a check;
//   - a restart in the middle of a review → a new review with a new session;
//   - a restart with a settled turn RPM did not record → replayed from lastSettled.
//
//   node scripts/rpm-engine.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bundle } from './lib/bundle.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-rpm-engine-${process.pid}.mjs`)
const entry = path.join(os.tmpdir(), `gurt-rpm-engine-entry-${process.pid}.ts`)
const S = (p) => JSON.stringify(path.join(ROOT, p))
fs.writeFileSync(entry, `export * from ${S('src/rpm/main/index.ts')}\nexport { DEFAULT_CONFIG } from ${S('src/rpm/core/index.ts')}\n`)
await bundle({ entryPoints: [entry], outfile })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-rpm-engine-'))
after(() => {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(entry, { force: true })
  fs.rmSync(tmp, { recursive: true, force: true })
})
const m = await import(pathToFileURL(outfile).href)

const CFG = { enabled: true, reviewer: { agent: 'codex', options: {} } }
const later = () => new Promise((r) => setImmediate(r))

/**
 * A fake app around RPM. `executor` and `reviewer` are scripts: one answer per
 * host message / per reviewer, in order.
 *   executor answer: { edit?, replies?: [id, act][], outcome? } | 'hang'
 *   reviewer answer: { findings?: [severity, claim][], verify?: [id, accept][] } | 'hang' | 'fail'
 *   check: one exit code per check run, or 'hang' (until stopped); green when the script runs out.
 */
function world(name, { executor = [], reviewer = [], check = [], checks = [{ repo: 'app', command: 'npm test' }] } = {}) {
  const w = {
    root: path.join(tmp, name),
    facts: { e1: { id: 'e1', ws: 'w', task: 't', title: 'Feature', role: 'executor', agent: 'claude', writeRepos: ['app'], state: 'started' } },
    tree: 0,
    checks,
    executor: [...executor],
    reviewer: [...reviewer],
    check: [...check],
    calls: [],
    errors: [],
    notes: [],
    lines: [],
    sentKeys: new Map(),
    last: {},
    listeners: { settled: new Set(), deleted: new Set(), copied: new Set() },
    ticks: new Set(),
    turns: 0,
    reviewers: 0,
    pending: undefined,
    rpm: undefined
  }
  const log = (op, x) => w.calls.push({ op, ...x })
  const on = (set) => (fn) => {
    set.add(fn)
    return () => set.delete(fn)
  }
  w.settle = (t) => {
    w.last[t.sessionId] = t
    for (const fn of w.listeners.settled) fn(t)
  }
  const tool = (id, name, input) => {
    try {
      return [{ name, payload: w.rpm.tools.call(id, name, input).payload }]
    } catch (err) {
      w.errors.push(`${name}: ${err.message}`)
      return []
    }
  }
  w.answerExecutor = (id, key, a) => {
    if (a.edit) w.tree++
    const tools = a.replies?.length ? tool(id, 'reply_findings', { replies: a.replies.map(([fid, act]) => ({ id: fid, act, comment: `${act} ${fid}` })) }) : []
    w.settle({ sessionId: id, turnId: `${id}:${++w.turns}`, origin: 'rpm', key, outcome: a.outcome ?? (a.edit ? 'changes' : 'no_changes'), tools })
  }
  w.ports = {
    sessions: {
      info: (id) => w.facts[id],
      ranOn: (id) => w.facts[id] && { agent: w.facts[id].agent, model: `model of ${id}`, ...(id === 'e1' && { effort: 'high' }) },
      list: () => Object.keys(w.facts),
      userPrompts: () => ['Add the feature.'],
      checkpointBefore: () => [{ repo: 'app', commit: 'c0ffee' }],
      onSettled: on(w.listeners.settled),
      lastSettled: (id) => w.last[id],
      onDeleted: on(w.listeners.deleted),
      onCopied: on(w.listeners.copied),
      async send(id, msg) {
        log('send', { id, key: msg.key, kind: msg.line.kind, text: msg.text })
        w.lines.push({ id, line: msg.line })
        if (w.sentKeys.has(msg.key)) return
        w.sentKeys.set(msg.key, 'taken')
        const a = w.executor.shift() ?? { replies: [] }
        await later()
        if (a === 'hang') w.pending = () => w.answerExecutor(id, msg.key, { edit: true, replies: [['F1', 'fixed']] })
        else w.answerExecutor(id, msg.key, a)
      },
      sent: (id, key) => w.sentKeys.get(key) ?? 'unknown',
      cancelTurn: async (id) => log('cancelTurn', { id }),
      async createReviewer(r) {
        const id = `r${++w.reviewers}`
        log('createReviewer', { id, key: r.key, title: r.title })
        w.lines.push({ id, line: r.line })
        w.facts[id] = { id, ws: 'w', task: 't', title: r.title, role: 'reviewer', agent: r.agent, writeRepos: [], state: 'started', reviewerOf: { executor: r.executor, key: r.key } }
        const a = w.reviewer.shift() ?? {}
        setImmediate(() => {
          if (a === 'hang') return
          const tools =
            a === 'fail'
              ? []
              : tool(id, 'submit_review', {
                  findings: (a.findings ?? []).map(([severity, claim]) => ({ severity, file: 'app/src/a.ts', line: 1, claim, scenario: `when ${claim}` })),
                  verify: (a.verify ?? []).map(([fid, accept]) => ({ id: fid, accept, comment: accept ? 'ok' : 'not yet' }))
                })
          w.settle({ sessionId: id, turnId: `${id}:1`, origin: 'rpm', key: r.key, outcome: tools.length ? 'no_changes' : 'incomplete', tools })
        })
        return id
      },
      stopContainer: async (id) => log('stopContainer', { id }),
      hold: (id) => log('hold', { id }),
      release: (id) => log('release', { id }),
      keepAlive: (id, on) => log('keepAlive', { id, on }),
      chatLine(id, line) {
        w.lines.push({ id, line })
        return w.lines.length
      },
      // Entry id = position in w.lines + 1, as chatLine returns it.
      chatRefs: (id) => w.lines.flatMap((l, i) => (l.id === id ? [{ executor: l.line.executor, run: l.line.run, seq: l.line.seq, items: l.line.items.map((x) => x.id), entryId: i + 1 }] : []))
    },
    git: {
      trees: async (_ws, _task, repos) => repos.map((repo) => ({ repo, head: 'c0ffee', tree: `tree${w.tree}` })),
      async diff(_ws, _task, _repo, _base, maxChars) {
        if (w.editDuringDiff && maxChars === 0) {
          w.editDuringDiff = false
          w.tree++ // someone edits in the Files view while the mark is being built
        }
        return { text: '+ change', truncated: false, files: [{ path: 'src/a.ts', status: 'M' }] }
      }
    },
    check: {
      run(executor, repo, command) {
        log('check', { repo, command })
        const code = w.check.shift() ?? 0
        let stop
        const done = new Promise((resolve, reject) => {
          stop = async () => {
            log('check.stop', {})
            if (w.stopFails) {
              // The real port: done rejects and stop reports no confirmation (§7).
              reject(new Error('docker inspect: still running'))
              return { ok: false, detail: 'docker inspect: still running' }
            }
            resolve({ repo, command, code: -1, ms: 1, tail: ['stopped'] })
            return { ok: true }
          }
          w.finishCheck = () => resolve({ repo, command, code: 0, ms: 1, tail: [] })
          if (code === 'timeout-unconfirmed') {
            // CheckRunner's `unconfirmed` after a timeout, as the adapter rejects it.
            setImmediate(() => reject(Object.assign(new Error('timed out; the container is still running after docker stop'), { unconfirmed: true })))
          } else if (code !== 'hang') setImmediate(() => resolve({ repo, command, code, ms: 1, tail: code ? ['1 test failed'] : [] }))
        })
        return { done, stop: () => stop() }
      },
      commands: () => w.checks,
      async stopContainer(id) {
        log('check.stopContainer', { id })
        return w.stopFails ? { ok: false, detail: 'docker inspect: still running' } : { ok: true }
      }
    },
    notify: { notify: (n) => w.notes.push(n) },
    store: { dir: (ws, task) => path.join(w.root, ws, task, 'rpm') }
  }
  w.clock = {
    now: () => Date.now(),
    every(_ms, fn) {
      w.ticks.add(fn)
      return () => w.ticks.delete(fn)
    }
  }
  /** A fresh RPM over the same disk: load → recover → start, as the kernel does. */
  w.boot = async () => {
    w.rpm = m.createRpm(w.ports, { clock: w.clock })
    await w.rpm.load()
    await w.rpm.recover()
    w.rpm.start()
    return w.rpm
  }
  /** The user's own turn with changes (starts a run, §6.1). */
  w.userTurn = () => {
    w.tree++
    w.settle({ sessionId: 'e1', turnId: `e1:${++w.turns}`, origin: 'user', outcome: 'changes', tools: [] })
  }
  w.state = () => w.rpm.state('e1')
  w.kinds = () => w.state().journal.map((e) => (e.kind === 'step' ? `step:${e.what}` : e.kind))
  w.until = async (pred, what) => {
    for (let i = 0; i < 2000; i++) {
      const s = w.rpm && w.state()
      if (s && pred(s)) return s
      await new Promise((r) => setTimeout(r, 2))
    }
    assert.fail(`timed out waiting for ${what}; journal: ${w.rpm && w.state() ? w.kinds().join(' ') : '(none)'}`)
  }
  w.phase = (s) => s.status.phase
  /** Wait until RPM rests: passed, ended, called, or paused with no step running. */
  w.rest = (what = 'rest') => w.until((s) => ['passed', 'ended', 'called', 'paused'].includes(s.status.phase), what)
  w.finding = (id) => w.state().findings.find((f) => f.id === id)
  w.ops = (op) => w.calls.filter((c) => c.op === op)
  return w
}

async function started(w) {
  await w.boot()
  await w.rpm.setConfig('e1', CFG)
  w.userTurn()
}

test('run а · clean: check ✓ → R1: 2 nits below threshold → the executor gets them once → mark', async () => {
  const w = world('a', { reviewer: [{ findings: [['nit', 'naming'], ['nit', 'typo']] }] })
  await started(w)
  const s = await w.rest()
  assert.equal(w.phase(s), 'passed')
  assert.deepEqual(w.kinds(), ['start', 'step:check', 'check', 'step:review', 'review', 'step:executor', 'turn', 'mark'])
  assert.deepEqual(s.journal.find((e) => e.kind === 'step' && e.what === 'executor').items, ['F1', 'F2'])
  assert.equal(s.journal[1].key, 'e1:1:1')
  assert.equal(s.journal[0].base[0].commit, 'c0ffee')
  assert.deepEqual(s.mark.findings, { closed: 0, rejected: 0, deferred: 0, below: 2 })
  assert.deepEqual(w.notes, [{ sessionId: 'e1', kind: 'passed', text: 'Review passed · marked 1 file', open: {} }])
  assert.deepEqual(w.ops('hold'), [{ op: 'hold', id: 'e1' }])
  assert.ok(w.ops('release').length >= 1)
  assert.equal(w.ops('createReviewer')[0].title, 'review R1 — Feature')
  assert.ok(w.ops('stopContainer').some((c) => c.id === 'r1'), 'the reviewer container stops after its turn')
  // Chat lines: the reviewer's start line, its result, the nits handed to the executor, the mark in the executor's chat.
  assert.deepEqual(w.lines.map((l) => `${l.id}:${l.line.from}>${l.line.to}:${l.line.kind}`), ['r1:executor>reviewer:handoff', 'r1:reviewer>gurt:handoff', 'e1:reviewer>executor:handoff', 'e1:rpm>you:passed'])
  assert.equal(w.lines[2].line.more, '+2 below threshold')
  assert.deepEqual(w.errors, [])
  assert.equal(w.rpm.owns('e1'), false)
})

test('each review and executor turn records the client, model and effort it ran on', async () => {
  const w = world('ran', {
    reviewer: [{ findings: [['major', 'one']] }, { verify: [['F1', true]] }],
    executor: [{ edit: true, replies: [['F1', 'fixed']] }]
  })
  await started(w)
  const s = await w.rest()
  assert.equal(w.phase(s), 'passed')
  const reviews = s.journal.filter((e) => e.kind === 'review')
  assert.deepEqual(reviews.map((e) => e.ran), [{ agent: 'codex', model: 'model of r1' }, { agent: 'codex', model: 'model of r2' }])
  const turns = s.journal.filter((e) => e.kind === 'turn')
  assert.deepEqual(turns.map((e) => e.ran), [{ agent: 'claude', model: 'model of e1', effort: 'high' }])
})

test('run б · a fix accepted on the second try', async () => {
  const w = world('b', {
    reviewer: [{ findings: [['major', 'one'], ['major', 'two']] }, { verify: [['F1', true], ['F2', false]] }, { verify: [['F2', true]] }],
    executor: [{ edit: true, replies: [['F1', 'fixed'], ['F2', 'fixed']] }, { edit: true, replies: [['F2', 'fixed']] }]
  })
  await started(w)
  const s = await w.rest()
  assert.equal(w.phase(s), 'passed')
  assert.deepEqual(w.kinds(), [
    'start', 'step:check', 'check', 'step:review', 'review',
    'step:executor', 'turn', 'step:check', 'check', 'step:review', 'review',
    'step:executor', 'turn', 'step:check', 'check', 'step:review', 'review', 'mark'
  ])
  assert.equal(w.finding('F1').state, 'closed')
  assert.equal(w.finding('F2').state, 'closed')
  assert.equal(w.finding('F2').attempts, 1)
  // The host messages: the second one carries only F2.
  const sends = w.ops('send')
  assert.equal(sends.length, 2)
  assert.match(sends[0].text, /F1[\s\S]*F2/)
  assert.doesNotMatch(sends[1].text, /^F1 ·/m)
  assert.equal(s.journal.find((e) => e.kind === 'turn').step, 3)
  // `executor → reviewer F1 fixed F2 fixed` in the executor's chat.
  assert.ok(w.lines.some((l) => l.id === 'e1' && l.line.from === 'executor' && l.line.to === 'reviewer' && l.line.items.length === 2))
  assert.deepEqual(w.errors, [])
})

test('run в · "can\'t" calls you at once; F2 waits; defer → documented → R2 → mark', async () => {
  const w = world('v', {
    reviewer: [{ findings: [['major', 'one'], ['major', 'two']] }, { verify: [['F1', true], ['F2', true]] }],
    executor: [{ edit: true, replies: [['F1', 'cant'], ['F2', 'fixed']] }, { edit: true, replies: [['F1', 'documented']] }]
  })
  await started(w)
  let s = await w.rest()
  assert.equal(w.phase(s), 'called')
  assert.equal(s.status.why, 'findings')
  assert.deepEqual(s.status.items, ['F1'])
  assert.equal(w.notes[0].kind, 'called')
  assert.equal(w.notes[0].text, 'Review waits for you · 1 finding')
  assert.deepEqual(w.notes[0].open, { filter: 'you', finding: 'F1' })
  assert.ok(w.lines.some((l) => l.id === 'e1' && l.line.to === 'you' && l.line.items[0]?.id === 'F1'))
  // The history links each move to its message: R1's review in r1's chat, the executor's turn in e1's.
  const [created, cant] = s.findings.find((f) => f.id === 'F1').history
  const at = (ref) => w.lines[ref.entryId - 1]
  assert.equal(created.chat.sessionId, 'r1')
  assert.equal(at(created.chat).line.from, 'reviewer')
  assert.equal(at(created.chat).line.seq, created.seq)
  assert.equal(cant.chat.sessionId, 'e1')
  assert.equal(at(cant.chat).line.from, 'executor')
  assert.equal(at(cant.chat).line.seq, cant.seq)
  // One turn, two lines with its seq: F1 (can't) opens the line to you, F2 (fixed) the line to the reviewer.
  assert.equal(at(cant.chat).line.to, 'you')
  assert.deepEqual(at(cant.chat).line.items.map((x) => x.id), ['F1'])
  const fixed = s.findings.find((f) => f.id === 'F2').history.find((x) => x.by === 'executor')
  assert.equal(fixed.seq, cant.seq)
  assert.equal(at(fixed.chat).line.to, 'reviewer')
  assert.deepEqual(at(fixed.chat).line.items.map((x) => x.id), ['F2'])

  await w.rpm.verdict('e1', 'F1', 'defer', 'in docs/todo.md')
  s = await w.rest()
  assert.equal(w.phase(s), 'passed')
  assert.equal(w.finding('F1').state, 'deferred')
  assert.equal(w.finding('F2').state, 'closed')
  assert.deepEqual(w.ops('send')[1].text.includes('docs/todo.md'), true)
  assert.deepEqual(w.errors, [])
})

test('run г · dispute: verify-only review says no → call → reject → mark', async () => {
  const w = world('g', {
    reviewer: [{ findings: [['major', 'one']] }, { verify: [['F1', false]] }],
    executor: [{ replies: [['F1', 'contested']] }]
  })
  await started(w)
  let s = await w.rest()
  assert.equal(w.phase(s), 'called')
  const reviews = s.journal.filter((e) => e.kind === 'step' && e.what === 'review')
  assert.equal(reviews[1].full, false, 'the code did not change: R2 only verifies')
  assert.equal(s.journal.filter((e) => e.kind === 'step' && e.what === 'check').length, 1, 'same tree: no second check')
  assert.equal(w.finding('F1').state, 'disputed')
  await w.rpm.verdict('e1', 'F1', 'reject', 'out of scope')
  s = await w.rest()
  assert.equal(w.phase(s), 'passed')
  assert.deepEqual(w.errors, [])
})

test('run д · the check will not go green: 3 red → stop (3б) → new command → check ✓ → R1 → mark', async () => {
  const w = world('d', {
    check: [1, 1, 1],
    executor: [{ edit: true }, { edit: true }],
    reviewer: [{}]
  })
  await started(w)
  let s = await w.rest()
  assert.equal(w.phase(s), 'called')
  assert.equal(s.status.why, 'check-red')
  assert.equal(w.ops('check').length, 3)
  const fix = s.journal.filter((e) => e.kind === 'step' && e.what === 'executor')
  assert.deepEqual(fix.map((e) => e.rule), ['3в', '3в'])
  assert.ok(w.lines.filter((l) => l.line.kind === 'check-red').length === 2)
  assert.match(w.ops('send')[0].text, /1 test failed/)
  assert.equal(w.notes[0].text, 'Review waits for you · check failed 3 times')

  // A new command in Settings → Repos: the poll notices and runs it on the same tree.
  w.checks = [{ repo: 'app', command: 'npm run test:unit' }]
  for (const fn of w.ticks) fn()
  await w.until((x) => x.status.phase === 'passed', 'passed after the new command')
  assert.equal(w.ops('check').at(-1).command, 'npm run test:unit')
  assert.deepEqual(w.errors, [])
})

test('run д · or: red check, the executor leaves the code → stop (3а)', async () => {
  const w = world('d2', { check: [1], executor: [{}] })
  await started(w)
  const s = await w.rest()
  assert.equal(s.status.why, 'check-unchanged')
  assert.equal(w.ops('check').length, 1)
})

test('run е · calibration: F1 → minor, the executor gets only F2', async () => {
  const w = world('e', {
    reviewer: ['hang'],
    executor: [{ edit: true, replies: [['F2', 'fixed']] }]
  })
  await started(w)
  await w.until((s) => s.status.phase === 'review' && s.status.session === 'r1', 'R1 running')
  // Pause during R1 so the severity lands before the executor's step.
  await w.rpm.command('e1', 'pause')
  w.settle({
    sessionId: 'r1', turnId: 'r1:1', origin: 'rpm', key: 'e1:1:2', outcome: 'no_changes',
    tools: [{ name: 'submit_review', payload: w.rpm.tools.call('r1', 'submit_review', {
      findings: [{ severity: 'blocker', claim: 'one', scenario: 'x' }, { severity: 'major', claim: 'two', scenario: 'y' }], verify: []
    }).payload }]
  })
  let s = await w.until((x) => x.findings.length === 2, 'R1 recorded')
  assert.equal(w.phase(s), 'paused')
  await w.rpm.severity('e1', 'F1', 'minor', 'это стиль')
  w.reviewer.push({ verify: [['F2', true]] })
  await w.rpm.command('e1', 'resume')
  s = await w.rest()
  assert.equal(w.phase(s), 'passed')
  const step = s.journal.find((e) => e.kind === 'step' && e.what === 'executor')
  assert.deepEqual(step.items, ['F1', 'F2'])
  assert.equal(w.finding('F1').state, 'open')
  assert.equal(s.mark.findings.below, 1)
  assert.deepEqual(w.errors, [])
})

test('run ж · something new every round → budget → F3 to minor → mark', async () => {
  const w = world('zh', {
    reviewer: [{ findings: [['major', 'one']] }, { verify: [['F1', true]], findings: [['major', 'two']] }, { verify: [['F2', true]], findings: [['major', 'three']] }],
    executor: [{ edit: true, replies: [['F1', 'fixed']] }, { edit: true, replies: [['F2', 'fixed']] }]
  })
  await started(w)
  let s = await w.rest()
  assert.equal(w.phase(s), 'called')
  assert.equal(s.status.why, 'budget')
  assert.equal(w.notes[0].text, 'Review waits for you · 3 reviews without you')
  assert.ok(w.lines.some((l) => l.line.from === 'rpm' && l.line.to === 'you' && /3 reviews/.test(l.line.more ?? '')))
  await w.rpm.severity('e1', 'F3', 'minor')
  s = await w.rest()
  assert.equal(w.phase(s), 'passed')
  assert.deepEqual(w.errors, [])
})

test('Continue on a call (resume while not paused): budget → go on; reviewer failed → a new review', async () => {
  const w = world('continue', {
    reviewer: [{ findings: [['major', 'one']] }, { verify: [['F1', true]], findings: [['major', 'two']] }, { verify: [['F2', true]], findings: [['major', 'three']] }, 'fail', { verify: [['F3', true]] }],
    executor: [{ edit: true, replies: [['F1', 'fixed']] }, { edit: true, replies: [['F2', 'fixed']] }, { edit: true, replies: [['F3', 'fixed']] }]
  })
  await started(w)
  let s = await w.rest()
  assert.equal(s.status.why, 'budget')
  assert.equal(s.config.reviews, 3)
  // The Review tab's Continue: the run is called, not paused.
  await w.rpm.command('e1', 'resume')
  s = await w.rest()
  assert.equal(w.phase(s), 'called')
  assert.equal(s.status.why, 'reviewer-failed')
  await w.rpm.command('e1', 'resume')
  s = await w.rest()
  assert.equal(w.phase(s), 'passed')
  assert.equal(w.ops('createReviewer').length, 5)
  // Neither paused nor called: nothing to resume.
  await assert.rejects(w.rpm.command('e1', 'resume'), /The run is over/)
})

test('stop in the middle of a check: the check is stopped, end stopped, clones released', async () => {
  // Two repos: stopping the first check must not start the second one.
  const w = world('stop', { check: ['hang', 0], checks: [{ repo: 'app', command: 'npm test' }, { repo: 'web', command: 'npm test' }] })
  w.facts.e1.writeRepos = ['app', 'web']
  await started(w)
  await w.until((s) => s.status.phase === 'check' && w.ops('check').length === 1, 'check running')
  await w.rpm.command('e1', 'stop')
  const s = await w.rest()
  assert.deepEqual(s.status.phase === 'ended' && s.status.why, 'stopped')
  assert.equal(w.ops('check.stop').length, 1)
  await later()
  assert.equal(w.state().journal.filter((e) => e.kind === 'check').length, 0, 'the stopped check is not recorded')
  assert.equal(w.ops('check').length, 1, 'the second repo\'s check never starts')
  assert.ok(w.ops('release').length >= 1)
  assert.equal(w.ops('keepAlive').at(-1).on, false)
  // The next executor turn with changes opens run 2.
  w.userTurn()
  await w.until((x) => x.run === 2, 'run 2')
})

test('restart in the middle of a review: the reviewer stops, fail interrupted, a new review with a new session', async () => {
  const w = world('restart-review', { reviewer: ['hang', {}] })
  await started(w)
  await w.until((s) => s.status.phase === 'review' && s.status.session === 'r1', 'R1 running')
  w.rpm.stop()
  await w.boot()
  const s = await w.rest()
  assert.equal(w.phase(s), 'passed')
  assert.ok(w.ops('stopContainer').some((c) => c.id === 'r1'))
  const fail = s.journal.find((e) => e.kind === 'fail')
  assert.equal(fail.reason, 'interrupted')
  const reviews = s.journal.filter((e) => e.kind === 'step' && e.what === 'review')
  assert.equal(reviews.length, 2)
  assert.notEqual(reviews[0].key, reviews[1].key)
  assert.deepEqual(w.ops('createReviewer').map((c) => c.id), ['r1', 'r2'])
  assert.ok(w.ops('hold').length >= 2, 'load holds the live run again')
})

test('restart with a settled turn RPM did not record: replayed from lastSettled', async () => {
  const w = world('restart-turn', {
    reviewer: [{ findings: [['major', 'one']] }, { verify: [['F1', true]] }],
    executor: ['hang']
  })
  await started(w)
  await w.until((s) => s.status.phase === 'executor' && w.pending, 'executor step sent')
  w.rpm.stop() // RPM goes down…
  w.pending() // …and the turn settles while nobody listens: only lastSettled has it.
  const settled = w.last.e1
  await w.boot()
  const s = await w.rest()
  assert.equal(w.phase(s), 'passed')
  const turn = s.journal.find((e) => e.kind === 'turn' && e.origin === 'rpm')
  assert.equal(turn.turnId, settled.turnId)
  assert.equal(s.journal.find((e) => e.kind === 'step' && e.key === settled.key).step, turn.step)
  assert.equal(w.ops('send').length, 1, 'the message is not sent again')
})

test('disabling review on a live run ends it at the next boundary, not mid-step', async () => {
  const w = world('user', { reviewer: [{ findings: [['major', 'one']] }], executor: ['hang'] })
  await started(w)
  await w.until((s) => s.status.phase === 'executor' && w.pending, 'executor step sent')
  await w.rpm.setConfig('e1', { enabled: false })
  assert.equal(w.state().live, true, 'a running step is not interrupted')
  w.pending()
  const s = await w.rest()
  assert.deepEqual(s.status.phase === 'ended' && s.status.why, 'disabled')
})

test('stop while the reviewer prompt is being prepared: no reviewer is created after the end', async () => {
  const w = world('stop-review')
  let release
  const gate = new Promise((r) => (release = r))
  const diff = w.ports.git.diff
  w.ports.git.diff = async (...a) => (await gate, diff(...a))
  await started(w)
  await w.until((s) => s.status.phase === 'review', 'review step written')
  await w.rpm.command('e1', 'stop')
  release()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(w.state().status.phase, 'ended')
  assert.equal(w.ops('createReviewer').length, 0)
})

test('restart during a check whose container will not stop: check-error, you are called', async () => {
  const w = world('restart-check', { check: ['hang'] })
  await started(w)
  await w.until((s) => s.status.phase === 'check' && w.ops('check').length === 1, 'check running')
  w.rpm.stop()
  w.stopFails = true // docker stop "succeeds", but inspect still sees it running
  await w.boot()
  let s = await w.rest()
  assert.equal(s.status.phase, 'called')
  assert.equal(s.status.why, 'check-error')
  assert.ok(w.ops('check.stopContainer').length >= 1, 'recovery stops through the confirming check stop')
  // Your entry does not start a check while the old one is unconfirmed.
  await w.rpm.note('e1', 'try again')
  s = await w.rest()
  assert.equal(s.status.phase, 'called')
  assert.equal(w.ops('check').length, 1)
  s = w.state()
  assert.equal(s.journal.find((e) => e.kind === 'fail').reason, 'check-error')
  assert.equal(w.ops('check').length, 1, 'no new check without a confirmed stop')
})

test('restart during a rerun-review asked for while paused: the rerun is still asked for', async () => {
  const w = world('restart-rerun', { reviewer: [{ findings: [['major', 'one']] }, 'hang', { verify: [['F1', true]] }], executor: ['hang'] })
  await started(w)
  await w.until((s) => s.status.phase === 'executor' && w.pending, 'executor step sent')
  await w.rpm.command('e1', 'pause')
  w.pending()
  await w.until((s) => s.journal.some((e) => e.kind === 'turn'), 'turn recorded')
  await w.rpm.command('e1', 'rerun-review')
  await w.until((s) => s.status.phase === 'review' && s.status.session === 'r2', 'rerun review running')
  w.rpm.stop()
  await w.boot()
  const s = await w.until((x) => x.journal.filter((e) => e.kind === 'review').length === 2, 'the rerun ran again')
  const steps = s.journal.filter((e) => e.kind === 'step' && e.what === 'review')
  assert.deepEqual(steps.map((e) => e.rule), ['6', 'rerun', 'rerun'])
  assert.equal(s.journal.find((e) => e.kind === 'fail').reason, 'interrupted')
  assert.equal(w.finding('F1').state, 'closed')
})

test('stop whose check is not confirmed stopped: fail check-error, you are called, the clones stay held', async () => {
  const w = world('stop-unconfirmed', { check: ['hang'] })
  await started(w)
  await w.until((s) => s.status.phase === 'check' && w.ops('check').length === 1, 'check running')
  w.stopFails = true
  await w.rpm.command('e1', 'stop')
  let s = await w.rest()
  assert.equal(s.status.phase, 'called')
  assert.equal(s.status.why, 'check-error')
  assert.equal(w.ops('release').length, 0, 'the clones stay held')
  assert.equal(w.notes.at(-1).text, 'Review waits for you · check could not run')
  assert.equal(s.journal.filter((e) => e.kind === 'fail').length, 1)
  // A second stop while the container still cannot be confirmed down: still called, clones still held, no new check.
  await w.rpm.command('e1', 'stop')
  s = await w.rest()
  assert.equal(s.status.phase, 'called')
  assert.equal(w.ops('release').length, 0)
  // Once docker confirms the container is down, stop ends the run and releases the clones.
  w.stopFails = false
  await w.rpm.command('e1', 'stop')
  s = await w.rest()
  assert.deepEqual(s.status.phase === 'ended' && s.status.why, 'stopped')
  assert.equal(w.ops('release').length, 1)
  assert.equal(w.ops('check').length, 1, 'no check ever started on top of the unconfirmed one')
})

test('stop racing a green check result: the result does not start the next step', async () => {
  const w = world('stop-race', { check: ['hang'] })
  await started(w)
  await w.until((s) => s.status.phase === 'check' && w.ops('check').length === 1, 'check running')
  const p = w.rpm.command('e1', 'stop')
  w.finishCheck() // the result is queued while the stop entry is being written
  await p
  await new Promise((r) => setTimeout(r, 20))
  const s = w.state()
  assert.deepEqual(s.status.phase === 'ended' && s.status.why, 'stopped')
  assert.equal(s.journal.filter((e) => e.kind === 'step').length, 1)
  assert.equal(w.ops('createReviewer').length, 0)
})

test('restart after a stop was journaled but not carried out: the run is stopped on recovery', async () => {
  const w = world('stop-crash', { check: ['hang'] })
  await started(w)
  await w.until((s) => s.status.phase === 'check' && w.ops('check').length === 1, 'check running')
  w.rpm.stop()
  // The crash: `command stop` is on disk, `end` is not.
  const file = path.join(w.root, 'w', 't', 'rpm', 'e1', 'runs', '1.jsonl')
  const seq = w.state().journal.at(-1).seq + 1
  fs.appendFileSync(file, JSON.stringify({ seq, at: new Date().toISOString(), by: 'you', kind: 'command', cmd: 'stop' }) + '\n')
  await w.boot()
  const s = await w.rest()
  assert.deepEqual(s.status.phase === 'ended' && s.status.why, 'stopped')
  assert.ok(w.ops('check.stopContainer').some((c) => c.id === 'e1'), 'the check is stopped through the container, with confirmation')
  assert.equal(w.ops('check').length, 1)
})

test('recover listens before it launches effects: a new review settles before start()', async () => {
  const w = world('recover-listen', { reviewer: ['hang', {}] })
  await started(w)
  await w.until((s) => s.status.phase === 'review' && s.status.session === 'r1', 'R1 running')
  w.rpm.stop()
  w.rpm = m.createRpm(w.ports, { clock: w.clock })
  await w.rpm.load()
  await w.rpm.recover() // no start(): the kernel calls it only after recover returns
  const s = await w.rest()
  assert.equal(s.status.phase, 'passed')
})

test('a late RPM turn with changes after stop does not open a new run', async () => {
  const w = world('stop-late', { reviewer: [{ findings: [['major', 'one']] }], executor: ['hang'] })
  await started(w)
  await w.until((s) => s.status.phase === 'executor' && w.pending, 'executor step sent')
  await w.rpm.command('e1', 'stop')
  assert.equal(w.ops('cancelTurn').length, 1)
  w.pending() // the cancelled turn still settles with changes, origin rpm, the old step's key
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(w.rpm.runs('e1').length, 1)
  assert.deepEqual(w.state().status.phase === 'ended' && w.state().status.why, 'stopped')
  // Your own next turn with changes does open run 2.
  w.userTurn()
  await w.until((x) => x.run === 2, 'run 2')
})

test('the tree changes while the mark is being built: no mark on a stale tree, check and review again', async () => {
  const w = world('mark-race', { reviewer: [{}, {}] })
  // The first `mark` attempt (its diff) meets an edit: it must go back to the boundary.
  w.editDuringDiff = true
  await started(w)
  const s = await w.rest()
  assert.equal(s.status.phase, 'passed')
  assert.equal(s.journal.filter((e) => e.kind === 'review').length, 2, 'the new tree is checked and reviewed before the mark')
  const tree = s.mark.tree
  assert.equal(s.journal.filter((e) => e.kind === 'check').at(-1).tree, tree)
  assert.equal(s.journal.filter((e) => e.kind === 'review').at(-1).tree, tree)
})

test('a copied executor inherits the config and announces it (rpmOverview re-reads on the event)', async () => {
  const w = world('copied')
  await w.boot()
  await w.rpm.setConfig('e1', CFG)
  w.facts.e2 = { ...w.facts.e1, id: 'e2' }
  const events = []
  const off = w.rpm.onChange((e) => events.push(e))
  for (const fn of w.listeners.copied) fn('e1', 'e2')
  for (let i = 0; i < 500 && !events.length; i++) await new Promise((r) => setTimeout(r, 2))
  off()
  assert.deepEqual(events, [{ executor: 'e2', run: 0 }])
  assert.equal(w.rpm.config('e2').enabled, true)
  assert.deepEqual(w.rpm.overview().find((b) => b.executor === 'e2'), { executor: 'e2', enabled: true, live: false })
})

test('a check that timed out and could not be confirmed stopped: clones held until a confirmed stop', async () => {
  const w = world('timeout-unconfirmed', { check: ['timeout-unconfirmed'] })
  w.stopFails = true
  await started(w)
  let s = await w.rest()
  assert.equal(s.status.phase, 'called')
  assert.equal(s.status.why, 'check-error')
  assert.match(s.journal.find((e) => e.kind === 'fail').detail, /not confirmed stopped/)
  // Your entry does not start another check on top of it; Stop does not let the clones go.
  await w.rpm.note('e1', 'again')
  await w.rpm.command('e1', 'stop')
  s = await w.rest()
  assert.equal(s.status.phase, 'called')
  assert.equal(w.ops('release').length, 0)
  assert.equal(w.ops('check').length, 1)
  // Docker confirms the container is down: Stop ends the run and releases.
  w.stopFails = false
  await w.rpm.command('e1', 'stop')
  s = await w.rest()
  assert.deepEqual(s.status.phase === 'ended' && s.status.why, 'stopped')
  assert.equal(w.ops('release').length, 1)
})
