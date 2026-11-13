// The review loop's controller (src/main/reviewLoop.ts, docs/requirements-review-loop.md
// §5.1–§5.6, §6, §8; acceptance §12 item 3): real bus events, a real kernel, real
// host git on local bare origins, the check's login shell under host node — and a
// scripted fake agent (scripts/lib/loop-harness.mjs) in place of every agent
// process, so no docker and no network. Pinned here:
//   - the happy path at rung notify: check -> reviewer -> approve -> `ready`,
//     nothing committed; the reviewer is created fresh with a prompt built from
//     typed data only and is never `read-locked`;
//   - request_changes -> the findings message as a `system` entry that carries
//     the intent id and none of the reviewer's chat -> the fix must answer every
//     finding -> a second, fresh reviewer that sees the earlier round -> approve;
//   - a red check -> the red message, no round consumed, three reds end `check-red`;
//   - every stop of §5.2 this slice owns: exhausted, no-progress, executor
//     blocked / incomplete, missing-proposal (the one repair), tree-moved,
//     reviewer-unavailable (never starts, start failure, no verdict);
//   - the intent is on disk BEFORE its effect (message, check, reviewer);
//   - the hold: taken before the first turn can end, kept by pings, released at
//     the end and by a dormant `no_changes`; the queue handoff never fires;
//   - delivery at each rung only on a clean result with a matching hash;
//     `tree-moved` otherwise; a failing hook -> `delivery-failed`;
//   - "stop loop" ends `cancelled` and stops the executor's container (the check dies with it).
//   - takeover (§5.6): every human act of the table, the delivery boundary (what
//     waits behind the first step: a typed message, Esc, a container stop, a
//     delete), "stop loop" refused while delivering; the scope is not archived
//     while the loop is live;
//   - the deadline (§5.2): from the start prompt, cleared by a dormant
//     `no_changes`, extended by a plan hold, ends cancelling the turn and
//     deleting the reviewer; a permission request open 15 minutes;
//   crash recovery is scripts/review-loop-recovery.test.mjs.
//
// The reviewer's start is simulated (the scheduler would provision a container):
// `enqueue` and `schedule` are replaced, everything above them is real.
//
//   node scripts/review-loop-controller.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loopHarness, gate } from './lib/loop-harness.mjs'
import { installGitGate, gateCommit } from './lib/git-gate.mjs'
import { makeEvil } from './lib/evil-clone.mjs'

// Host commits take the ambient identity (a git-host credential adds none).
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test'
})
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-loop-ctl-'))
installGitGate(scratch) // holds a host `git commit` where a test asks (hooks never run, §6)
const origins = path.join(scratch, 'origins')
fs.mkdirSync(origins)

// --- the recording gh shim (as in review-loop-delivery.test.mjs) -----------
const shimDir = path.join(scratch, 'bin')
const ghLog = path.join(scratch, 'gh.log')
fs.mkdirSync(shimDir)
fs.writeFileSync(
  path.join(shimDir, 'gh'),
  `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.GH_SHIM_LOG, JSON.stringify({ args, repo: require('node:path').basename(process.cwd()) }) + '\\n')
if (args[0] === 'pr' && args[1] === 'create') { console.log('https://github.com/o/pr/1'); process.exit(0) }
if (args[0] === 'pr' && args[1] === 'view') { console.error('no pull requests found'); process.exit(1) }
console.error('unexpected gh call: ' + args.join(' ')); process.exit(2)
`,
  { mode: 0o755 }
)
Object.assign(process.env, { PATH: `${shimDir}:${process.env.PATH}`, GH_SHIM_LOG: ghLog })
const ghCreates = () =>
  fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.args[1] === 'create') : []

// A fake clock: the loop reads time only through it.
let nowMs = Date.now()

const h = await loopHarness('review-loop-controller', {
  agents: {
    a1: { kind: 'claude-code', label: 'executor' },
    a2: { kind: 'claude-code', label: 'reviewer', credentialId: 'c2' }
  },
  workspace: {
    repos: [
      // `status.txt` decides the check: green when it says `good`.
      { name: 'alpha', url: 'https://github.com/o/alpha.git', check: 'grep -q good status.txt' },
      { name: 'beta', url: 'https://github.com/o/beta.git' },
      { name: 'slow', url: 'https://github.com/o/slow.git', check: 'touch started.flag; sleep 30; touch finished.flag' },
      { name: 'lib', url: path.join(origins, 'lib-registered.git'), local: true }
    ],
    envs: [{ name: 'dev', image: 'x', repo: 'alpha' }]
  },
  credentials: [{ id: 'h', label: 'host auth', kind: 'git-host', hosts: ['github.com'], data: {} }],
  kernel: { reviewLoop: { clock: { now: () => nowMs, tickMs: 3_600_000, keepAliveMs: 40 } } }
})
const { kernel, ws, stops, started, container, agent, tick, until: harnessUntil } = h
after(() => {
  h.cleanup()
  fs.rmSync(scratch, { recursive: true, force: true })
})
const until = async (fn, what) => {
  const end = Date.now() + 30_000
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await tick(15)
  }
  throw new Error(`never: ${what}`)
}
void harnessUntil

// --- the scheduler's reviewer start, simulated ---------------------------------
/** executor id -> how its reviewers start: 'run' (default) | 'never' | 'fail'. */
const reviewerStart = {}
/** executor id -> (round, prompt text, c, reviewerId) => scripted reviewer. */
const reviewerScript = {}
/** What the file held when each effect began (the intent is written first). */
const onDisk = { enqueue: [], message: [], exec: [] }
const loopFile = (sessionId) => {
  const info = kernel.sessions.sessionInfo(sessionId)
  return JSON.parse(fs.readFileSync(path.join(h.GURT_ROOT, ws, info.task, 'review-loop.json'), 'utf8'))
}
kernel.sessions.schedule = () => {}
const realEnqueue = kernel.sessions.enqueue.bind(kernel.sessions)
kernel.sessions.enqueue = (rid) => {
  const s = kernel.sessions['sessions'].get(rid)
  if (!s.info.reviewOf) return realEnqueue(rid)
  const ex = s.info.reviewOf.executor
  onDisk.enqueue.push({ ex, intent: s.info.reviewOf.intent, file: loopFile(ex)[ex] })
  realEnqueue(rid) // state -> queued (schedule is stubbed: nothing starts it)
  const mode = reviewerStart[ex] ?? 'run'
  const c = contexts.get(ex)
  c.reviewers.push({ id: rid, round: s.info.reviewOf.round, prompt: s.info.startPrompt, texts: [], mode })
  if (mode === 'never') return
  setImmediate(() => {
    if (mode === 'fail') {
      s.info.state = 'draft'
      kernel.bus.emit('session.state', {
        sessionId: rid, ref: s.ref, state: 'draft', reason: 'start-failed', err: { name: 'Error', message: 'docker is down' }
      })
      return
    }
    s.info.state = 'started'
    s.info.queuedAt = undefined
    container(rid, 'running')
    kernel.bus.emit('session.state', { sessionId: rid, ref: s.ref, state: 'started', reason: 'scheduler' })
    agent(rid, async (n, text) => {
      c.reviewers.find((r) => r.id === rid).texts.push(text)
      return (await reviewerScript[ex]?.(s.info.reviewOf.round, text, c, rid)) ?? {}
    })
    void kernel.sessions['runPrompt'](s, s.info.startPrompt)
  })
}
const hostPrompt = kernel.sessions.hostPrompt.bind(kernel.sessions)
kernel.sessions.hostPrompt = (sid, text, intent) => {
  onDisk.message.push({ sid, intent, file: loopFile(sid)[sid] })
  return hostPrompt(sid, text, intent)
}

// --- the check's exec: the login shell under host node, in the host clone -----------
// `docker exec` is the real argv minus docker: the shell runs detached (its own
// group) so a stopped "container" can kill the whole tree (`inContainer`).
kernel.containers.spawnExec = (sid, argv, cwd) => {
  const info = kernel.sessions.sessionInfo(sid)
  onDisk.exec.push({ sid, file: loopFile(sid)[sid] })
  return h.inContainer(sid, spawn(argv[0], argv.slice(1), {
    cwd: path.join(h.GURT_ROOT, ws, info.task, path.basename(cwd)), detached: true, stdio: ['ignore', 'pipe', 'pipe']
  }))
}

// --- recorders --------------------------------------------------------------------------
const notices = []
const turnLog = []
const activity = []
kernel.bus.on('review.loop', (e) => notices.push(e))
kernel.bus.on('session.turn', (e) => turnLog.push({ ...e, held: kernel.sessions.isLoopHeld(e.sessionId) }))
kernel.bus.on('session.activity', (e) => activity.push(e.sessionId))

// --- fixtures ------------------------------------------------------------------------------
const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), text)
}
let seq = 0
/** A task with a clone per repo on branch `<task>`, one base commit pushed to its own bare origin. */
function fixture(repos) {
  const task = `t${++seq}`
  const base = path.join(h.GURT_ROOT, ws, task)
  fs.mkdirSync(base, { recursive: true })
  fs.writeFileSync(path.join(base, 'task.json'), '{}')
  const clones = {}
  const remotes = {}
  for (const name of repos) {
    const dir = path.join(base, name)
    const remote = path.join(origins, `${task}-${name}.git`)
    fs.mkdirSync(dir)
    git(scratch, 'init', '-q', '--bare', '-b', 'main', remote)
    git(dir, 'init', '-q', '-b', task)
    write(dir, 'README.md', 'base\n')
    write(dir, 'status.txt', 'good\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'base')
    git(dir, 'remote', 'add', 'origin', remote)
    git(dir, 'push', '-q', 'origin', 'HEAD:main')
    git(dir, 'fetch', '-q', 'origin')
    clones[name] = dir
    remotes[name] = remote
  }
  return { task, clones, remotes, bases: Object.fromEntries(repos.map((r) => [r, git(clones[r], 'rev-parse', 'HEAD')])) }
}

/** executor id -> the scenario context (the enqueue override finds its script here). */
const contexts = new Map()
const proposal = (subject, extra = {}) => ({ version: 1, outcome: 'changes', commit: { subject, body: `${subject} body` }, ...extra })

/**
 * Run one loop to its end. `exec(n, text, c)` scripts the executor's n-th
 * session/prompt (1 = the start prompt, then the host messages and nudges);
 * `rev(round, text, c, rid)` scripts a reviewer. Resolves once the end has
 * been notified and nothing is in flight.
 */
async function run({ repos = ['alpha'], block = {}, exec, rev, reviewer = 'run', startPrompt = 'implement the thing', wait = true } = /** @type {any} */ ({})) {
  const fx = fixture(repos)
  const id = `c${process.pid}x${++seq}`
  const review = { agent: 'a2', maxRounds: 2, whenClean: 'notify', draftPr: true, ...block }
  started(id, repos, { task: fx.task, review, title: `Exec ${id}`, startPrompt })
  const c = {
    id, ...fx, review, reviewers: [], prompts: [],
    dir: (r = repos[0]) => fx.clones[r],
    st: () => kernel.reviewLoop.state(id),
    complete: (p) => kernel.sessions['onComplete'](id, p),
    changes: (subject = 'feat', extra = {}) => kernel.sessions['onComplete'](id, proposal(subject, extra)),
    submit: (rid, v) => kernel.sessions['onSubmitReview'](rid, { version: 1, summary: 'summary', findings: [], ...v }),
    entries: () => kernel.sessions.snapshot(id).entries.filter((e) => e.kind === 'system'),
    head: (r = repos[0]) => git(fx.clones[r], 'rev-parse', 'HEAD')
  }
  contexts.set(id, c)
  reviewerStart[id] = reviewer
  if (rev) reviewerScript[id] = rev
  agent(id, async (n, text) => {
    c.prompts.push(text)
    return (await exec?.(n, text, c)) ?? {}
  })
  void kernel.sessions['runPrompt'](kernel.sessions['sessions'].get(id), startPrompt)
  if (wait) await finished(c)
  return c
}
const finished = async (c) => {
  await until(() => c.st()?.phase === 'ended' && c.st()?.notified, `${c.id} ended and notified`)
  await kernel.reviewLoop.idle()
  return c
}
const endOf = (c) => c.st().end
const endNotices = (c) => notices.filter((n) => n.sessionId === c.id && n.notice.kind === 'end')
const needsYou = (c, reason) => {
  const e = endOf(c)
  assert.equal(e.outcome, 'needs-you', JSON.stringify(e))
  assert.equal(e.reason, reason, JSON.stringify(e))
  return e
}
const approve = (c, rid, extra = {}) => c.submit(rid, { verdict: 'approve', ...extra })
const blocker = (id = 'F1', claim = 'status.txt is wrong') => ({
  id, file: 'alpha/status.txt', severity: 'blocker', claim, evidence: 'it says bad', suggestion: 'say good'
})

// =============================================================== happy path ===
test('clean approve on round 1 at rung notify: check, one reviewer, `ready`, nothing committed', async () => {
  const c = await run({
    exec: (n, text, c) => {
      if (n !== 1) return
      // The hold is in place while the first turn is still running (§5.5).
      assert.equal(kernel.sessions.isLoopHeld(c.id), true, 'held before the first turn can end')
      assert.equal(kernel.reviewLoop.owns(c.id), true)
      write(c.dir(), 'status.txt', 'good — changed\n')
      write(c.dir(), 'tests/new.test.js', 'test\n')
      c.changes('feat: change status')
    },
    rev: (round, text, c, rid) => {
      assert.equal(round, 1)
      approve(c, rid, { summary: 'fine', findings: [{ id: 'F1', file: 'alpha/status.txt', severity: 'nit', claim: 'wording' }] })
    }
  })
  const s = c.st()
  assert.equal(s.phase, 'ended')
  assert.deepEqual(endOf(c).outcome, 'ready')
  assert.deepEqual(endOf(c).delivered, [])
  assert.deepEqual(endOf(c).notes.map((f) => f.id), ['F1'], 'minor/nit findings ride the end')
  assert.equal(s.round, 1)
  assert.equal(c.reviewers.length, 1)
  assert.deepEqual(Object.keys(s.base), ['alpha'])
  assert.equal(s.base.alpha, c.bases.alpha, 'armed at HEAD')
  assert.equal(c.head(), c.bases.alpha, 'nothing was committed')
  assert.equal(git(c.dir(), 'status', '--porcelain').split('\n').length, 2, 'the work is still in the tree')
  assert.equal(s.checks[0].code, 0)
  assert.equal(s.checks[0].command, 'grep -q good status.txt')
  assert.equal(s.deadline !== undefined, true)
  assert.deepEqual(s.intents, [], 'every intent confirmed')
  // One notice, one end.
  const ends = endNotices(c)
  assert.equal(ends.length, 1)
  assert.equal(ends[0].notice.rounds, 1)
  assert.equal(ends[0].notice.subject, 'feat: change status')
  // The persisted file mirrors memory.
  assert.deepEqual(loopFile(c.id)[c.id], s)
  // The hold: kept through every turn end (the nudge's included), gone now.
  const mine = turnLog.filter((e) => e.sessionId === c.id)
  assert.ok(mine.length >= 2)
  assert.ok(mine.every((e) => e.held), 'held at every started/ended of the executor')
  assert.equal(kernel.sessions.isLoopHeld(c.id), false, 'released at the end')
  assert.equal(kernel.reviewLoop.owns(c.id), false)
  assert.ok(!stops.some((x) => x.id === c.id), 'the handoff never stopped the executor')
  // The reviewer: settled, so its container was stopped; the session stays.
  assert.ok(stops.some((x) => x.id === c.reviewers[0].id && x.reason === 'idle'))
  assert.ok(kernel.sessions.sessionInfo(c.reviewers[0].id), 'the session stays as the record of the review')
})

test('the reviewer is a fresh read-only session whose prompt is built from typed host data', async () => {
  const c = await run({
    exec: (n, text, c) => {
      if (n !== 1) return
      write(c.dir(), 'status.txt', 'good\nsecond line\n')
      write(c.dir(), 'tests/new.test.js', 'assert(1)\n')
      write(c.dir(), 'package.json', '{"scripts":{}}\n')
      c.changes('feat: x')
    },
    rev: (round, text, c, rid) => approve(c, rid)
  })
  const [r] = c.reviewers
  const info = kernel.sessions.sessionInfo(r.id)
  assert.equal(info.role, 'reviewer')
  assert.deepEqual(info.reviewOf, { executor: c.id, round: 1, intent: info.reviewOf.intent })
  assert.deepEqual(info.repoModes, { alpha: 'read' }, 'a tool set, never read-locked')
  assert.ok(!Object.values(info.repoModes).includes('read-locked'))
  assert.equal(info.agent, 'a2', 'the Review block’s agent')
  const p = r.prompt
  assert.match(p, /review round 1 of 2/)
  assert.match(p, /## 1\. The task[\s\S]*implement the thing/, 'the executor’s start prompt')
  assert.match(p, /\+second line/, 'the diff against the base')
  assert.match(p, /tests\/new\.test\.js/, 'an untracked file is in the diff')
  assert.match(p, /`grep -q good status\.txt`: exit 0/, 'the check result')
  assert.match(p, /## 4\. Mandatory items[\s\S]*alpha\/tests\/new\.test\.js — added, untracked/)
  assert.match(p, /alpha\/package\.json — added, untracked/)
  assert.match(p, /\(none — this is the first review\)/)
  assert.ok(!p.includes('feat: x'), 'the executor’s commit text is not the reviewer’s input')
})

test('every intent is on disk before its effect: the check, the reviewer, the message', async () => {
  const before = { exec: onDisk.exec.length, enq: onDisk.enqueue.length, msg: onDisk.message.length }
  const c = await run({
    exec: (n, text, c) => {
      if (n === 1) {
        write(c.dir(), 'status.txt', 'bad\n')
        return c.changes('feat: bad')
      }
      write(c.dir(), 'status.txt', 'good\n')
      write(c.dir(), 'more.txt', 'x\n')
      c.changes('feat: good')
    },
    rev: (round, text, c, rid) => approve(c, rid)
  })
  const exec1 = onDisk.exec.slice(before.exec).filter((x) => x.sid === c.id)[0]
  assert.equal(exec1.file.phase, 'checking')
  assert.ok(exec1.file.intents.some((i) => i.kind === 'check'), 'the check intent was written before the exec')
  const enq = onDisk.enqueue.slice(before.enq).find((x) => x.ex === c.id)
  assert.equal(enq.file.phase, 'reviewing')
  assert.ok(enq.file.intents.some((i) => i.kind === 'reviewer' && i.id === enq.intent), 'the reviewer intent preceded the enqueue')
  const msg = onDisk.message.slice(before.msg).find((x) => x.sid === c.id)
  assert.ok(msg.file.intents.some((i) => i.kind === 'message' && i.id === msg.intent), 'the message intent preceded hostPrompt')
})

// ===================================================== request_changes loop ===
test('request_changes -> findings as a system entry (no reviewer chat) -> fix must reply -> fresh reviewer -> approve', async () => {
  const LEAK = 'REVIEWER-CHAT-LEAK-7731'
  const c = await run({
    exec: (n, text, c) => {
      if (n === 1) {
        write(c.dir(), 'status.txt', 'good v1\n')
        return c.changes('feat: v1')
      }
      assert.match(text, /^gurt review loop — round 1 of 2: the reviewer requested changes\./)
      assert.match(text, /R1\.F1 \[blocker\] alpha\/status\.txt/)
      assert.match(text, /claim: status\.txt is wrong/)
      assert.ok(!text.includes(LEAK), 'the reviewer’s chat never reaches the executor')
      assert.throws(() => c.changes('feat: v2'), /R1\.F1/, 'a complete that skips a finding is refused (the open set)')
      write(c.dir(), 'status.txt', 'good v2\n')
      c.changes('feat: v2', { replies: [{ findingId: 'R1.F1', resolution: 'fixed', note: 'reworded it' }] })
    },
    rev: (round, text, c, rid) => {
      if (round === 1) {
        const s = kernel.sessions['sessions'].get(rid)
        kernel.sessions['push'](s, { kind: 'agent', text: LEAK })
        return c.submit(rid, { verdict: 'request_changes', summary: 'needs work', findings: [blocker()] })
      }
      approve(c, rid)
    }
  })
  assert.equal(endOf(c).outcome, 'ready')
  assert.equal(c.st().round, 2)
  assert.equal(c.reviewers.length, 2)
  assert.notEqual(c.reviewers[0].id, c.reviewers[1].id, 'a fresh reviewer every round')
  // The findings message is a `system` entry carrying the intent id.
  const sys = c.entries().find((e) => e.text.startsWith('gurt review loop — round 1 of 2'))
  assert.ok(sys, 'shown as a system entry')
  assert.ok(sys.loop && c.st().intents.every((i) => i.id !== sys.loop), 'it carries its intent id')
  assert.equal(kernel.sessions.snapshot(c.id).entries.filter((e) => e.kind === 'user').length, 1, 'only the start prompt is a user entry')
  // Round 2's prompt: the earlier round and the executor's reply, labelled.
  const p2 = c.reviewers[1].prompt
  assert.match(p2, /review round 2 of 2/)
  assert.match(p2, /### Round 1 — changes requested[\s\S]*R1\.F1 \[blocker\]/)
  assert.match(p2, /the executor's reply — fixed; its claim, to verify against the diff:\s+reworded it/)
  assert.ok(!p2.includes(LEAK), 'nor to the next reviewer')
  assert.ok(!p2.includes('feat: v2'))
  assert.deepEqual(c.st().rounds.map((r) => [r.round, r.verdict?.verdict, r.replies?.length]), [[1, 'request_changes', 1], [2, 'approve', undefined]])
  assert.equal(c.head(), c.bases.alpha, 'still nothing committed at rung notify')
  // Round 1's verdict is told in the chat with its findings.
  const verdict = kernel.sessions.snapshot(c.id).entries.find((e) => e.kind === 'system' && e.note?.findings)
  assert.match(verdict.text, /^Review R1: 1 finding \(1 blocker\)/)
  assert.equal(verdict.note.findings[0].ref, 'R1.F1')
})

test('a red check sends the red message and consumes no round', async () => {
  const c = await run({
    exec: (n, text, c) => {
      if (n === 1) {
        write(c.dir(), 'status.txt', 'bad\n')
        return c.changes('feat: bad')
      }
      assert.match(text, /^gurt review loop — the check failed \(red pass 1 in a row; 3 end the loop\)\./)
      assert.match(text, /alpha — `grep -q good status\.txt`: exit 1/)
      assert.match(text, /Fix the failure/)
      write(c.dir(), 'status.txt', 'good\n')
      c.changes('feat: good')
    },
    rev: (round, text, c, rid) => approve(c, rid)
  })
  assert.equal(endOf(c).outcome, 'ready')
  assert.equal(c.st().round, 1, 'the red pass consumed no round')
  assert.equal(c.reviewers.length, 1)
  assert.equal(c.st().redStreak, 0, 'a green pass resets the streak')
  assert.ok(c.entries().some((e) => /the check failed/.test(e.text) && e.loop))
  // The check shows in the chat as gurt's own console block: red, then green.
  const all = kernel.sessions.snapshot(c.id).entries
  const checks = all.filter((e) => e.kind === 'tool' && e.host?.startsWith('auto-check'))
  assert.deepEqual(checks.map((e) => [e.title, e.status, e.host]), [
    ['grep -q good status.txt', 'failed', 'auto-check · alpha'],
    ['grep -q good status.txt', 'completed', 'auto-check · alpha']
  ])
  assert.match(checks[0].detail, /\[exit 1 · /)
  const reviewer = all.find((e) => e.kind === 'tool' && e.host?.startsWith('reviewer'))
  assert.equal(reviewer?.status, 'completed', 'the reviewer block settles with its verdict')
  assert.ok(all.some((e) => e.kind === 'system' && e.note?.tone === 'ok' && /Review R1: clean/.test(e.text)))
  assert.ok(all.some((e) => e.kind === 'system' && /Review loop finished/.test(e.text)))
})

test('three red passes in a row end `check-red`; no reviewer was ever created', async () => {
  const c = await run({
    exec: (n, text, c) => {
      write(c.dir(), 'status.txt', `bad ${n}\n`)
      c.changes(`feat: bad ${n}`)
    }
  })
  needsYou(c, 'check-red')
  assert.equal(c.reviewers.length, 0)
  assert.equal(c.st().round, 0)
  assert.equal(c.prompts.filter((t) => /the check failed/.test(t)).length, 2, 'two red messages, the third pass ends it')
  assert.equal(c.head(), c.bases.alpha)
})

test('request_changes at maxRounds ends `exhausted` with the open findings; nothing is sent or committed', async () => {
  const c = await run({
    block: { maxRounds: 1, whenClean: 'commit' },
    exec: (n, text, c) => {
      write(c.dir(), 'status.txt', 'good 1\n')
      c.changes('feat: one')
    },
    rev: (round, text, c, rid) => c.submit(rid, { verdict: 'request_changes', findings: [blocker()] })
  })
  assert.equal(endOf(c).outcome, 'exhausted')
  assert.deepEqual(endOf(c).open.map((f) => f.id), ['F1'])
  assert.equal(c.prompts.length, 1, 'no findings message after the last round')
  assert.equal(c.head(), c.bases.alpha, 'a non-clean review commits nothing, whatever the rung')
})

test('a fix round that leaves the diff unchanged ends `no-progress`', async () => {
  const c = await run({
    exec: (n, text, c) => {
      if (n === 1) {
        write(c.dir(), 'status.txt', 'good 1\n')
        return c.changes('feat: one')
      }
      c.changes('feat: one', { replies: [{ findingId: 'R1.F1', resolution: 'declined', note: 'no' }] })
    },
    rev: (round, text, c, rid) => c.submit(rid, { verdict: 'request_changes', findings: [blocker()] })
  })
  needsYou(c, 'no-progress')
  assert.equal(c.reviewers.length, 1)
})

// ========================================================= executor stops ===
test('executor blocked / incomplete / failed end with their reasons; the hold is released', async () => {
  const blocked = await run({ exec: (n, t, c) => c.complete({ version: 1, outcome: 'blocked', reason: 'no access' }) })
  assert.equal(needsYou(blocked, 'executor-blocked').detail, 'no access')
  const incomplete = await run({ exec: () => ({}) })
  needsYou(incomplete, 'executor-incomplete')
  const threw = await run({ exec: () => { throw new Error('adapter crashed') } })
  needsYou(threw, 'executor-error')
  for (const c of [blocked, incomplete, threw]) {
    assert.equal(kernel.sessions.isLoopHeld(c.id), false)
    assert.equal(c.reviewers.length, 0)
  }
})

test('a dormant no_changes hands the session back: hold released, an ordinary turn-ended notice, no end', async () => {
  const c = await run({
    wait: false,
    exec: (n, t, c) => {
      assert.equal(kernel.sessions.isLoopHeld(c.id), true)
      c.complete({ version: 1, outcome: 'no_changes' })
    }
  })
  await until(() => notices.some((n) => n.sessionId === c.id && n.notice.kind === 'turn-ended'), 'turn-ended notice')
  await kernel.reviewLoop.idle()
  assert.equal(kernel.sessions.isLoopHeld(c.id), false, 'released')
  assert.equal(c.st().phase, 'dormant')
  assert.equal(c.st().deadline, undefined, 'the deadline is cleared')
  assert.equal(endNotices(c).length, 0)
})

// =========================================================== proposal repair ===
test('missing-proposal: the one repair names the repo; a complete that supplies it goes on', async () => {
  const c = await run({
    repos: ['alpha', 'beta'],
    exec: (n, text, c) => {
      if (n === 1) {
        write(c.dir('alpha'), 'status.txt', 'good a\n')
        write(c.dir('beta'), 'x.txt', 'b\n')
        return c.complete({ version: 1, outcome: 'changes', repos: [{ repo: 'alpha', commit: { subject: 'alpha only' } }] })
      }
      assert.match(text, /your changes in beta have no commit text/)
      c.complete({ version: 1, outcome: 'changes', repos: [{ repo: 'alpha', commit: { subject: 'alpha only' } }, { repo: 'beta', commit: { subject: 'beta too' } }] })
    },
    rev: (round, text, c, rid) => approve(c, rid)
  })
  assert.equal(endOf(c).outcome, 'ready')
  assert.equal(c.st().repaired, true)
  assert.equal(c.st().round, 1, 'a repair is not a round')
  assert.deepEqual(Object.keys(c.st().base).sort(), ['alpha', 'beta'])
  assert.match(c.reviewers[0].prompt, /### beta \(base/)
})

test('missing-proposal: a repair that still leaves a repo uncovered ends the loop', async () => {
  const c = await run({
    repos: ['alpha', 'beta'],
    exec: (n, text, c) => {
      write(c.dir('alpha'), 'status.txt', 'good a\n')
      write(c.dir('beta'), 'x.txt', 'b\n')
      c.complete({ version: 1, outcome: 'changes', repos: [{ repo: 'alpha', commit: { subject: 'alpha only' } }] })
    }
  })
  needsYou(c, 'missing-proposal')
  assert.equal(c.prompts.length, 2)
  assert.equal(c.reviewers.length, 0)
})

// ===================================================== reviewer-unavailable ===
const armedExec = (c, n) => {
  if (n !== 1) return
  write(c.dir(), 'status.txt', 'good\nmore\n')
  c.changes('feat: x')
}

test('reviewer-unavailable: a reviewer that never starts is deleted after the 15 minute bound', async () => {
  const c = await run({ reviewer: 'never', wait: false, exec: (n, t, c) => armedExec(c, n) })
  await until(() => c.st()?.reviewer, 'reviewer created')
  const rid = c.st().reviewer
  assert.equal(kernel.sessions.sessionInfo(rid).state, 'queued')
  kernel.reviewLoop.tick()
  assert.equal(c.st().phase, 'reviewing', 'not yet')
  nowMs += 16 * 60_000
  kernel.reviewLoop.tick()
  await finished(c)
  needsYou(c, 'reviewer-unavailable')
  assert.match(endOf(c).detail, /15 minutes/)
  assert.equal(kernel.sessions.sessionInfo(rid), undefined, 'the unstarted reviewer was deleted')
  assert.equal(c.head(), c.bases.alpha)
})

test('reviewer-unavailable: a start failure, a failed turn and a verdict never submitted', async () => {
  const fail = await run({ reviewer: 'fail', exec: (n, t, c) => armedExec(c, n) })
  needsYou(fail, 'reviewer-unavailable')
  assert.match(endOf(fail).detail, /failed to start: docker is down/)
  const threw = await run({ exec: (n, t, c) => armedExec(c, n), rev: () => { throw new Error('agent died') } })
  needsYou(threw, 'reviewer-unavailable')
  const silent = await run({ exec: (n, t, c) => armedExec(c, n), rev: () => ({}) })
  needsYou(silent, 'reviewer-unavailable')
  assert.equal(endOf(silent).detail, 'no verdict')
  assert.ok(silent.reviewers[0].texts.length === 2, 'it was nudged once for submit_review')
  for (const c of [fail, threw, silent]) assert.equal(kernel.sessions.isLoopHeld(c.id), false)
})

// ===================================================================== hold ===
test('the keep-alive pings while the loop is live and stops with it', async () => {
  const c = await run({
    wait: false,
    exec: (n, text, c) => {
      write(c.dir(), 'status.txt', 'good\nslow\n')
      c.changes('feat: x')
    },
    reviewer: 'never'
  })
  await until(() => c.st()?.phase === 'reviewing', 'reviewing')
  const n0 = activity.filter((x) => x === c.id).length
  await until(() => activity.filter((x) => x === c.id).length >= n0 + 3, 'three more pings')
  assert.equal(kernel.sessions.isLoopHeld(c.id), true)
  nowMs += 16 * 60_000
  kernel.reviewLoop.tick()
  await finished(c)
  assert.equal(kernel.sessions.isLoopHeld(c.id), false)
  const n1 = activity.filter((x) => x === c.id).length
  await tick(200)
  assert.equal(activity.filter((x) => x === c.id).length, n1, 'no pings after the release')
})

// ================================================================= delivery ===
const cleanExec = (c, n) => {
  if (n !== 1) return
  write(c.dir(), 'status.txt', 'good\ndelivered\n')
  c.changes('feat: deliver me')
}
const deliverable = (extra) => ({ exec: (n, t, c) => cleanExec(c, n), rev: (r, t, c, rid) => approve(c, rid), ...extra })

test('rung commit: committed with the proposal’s text; nothing pushed', async () => {
  const c = await run(deliverable({ block: { whenClean: 'commit' } }))
  assert.equal(endOf(c).outcome, 'ready')
  assert.deepEqual(endOf(c).delivered.map((d) => [d.repo, d.step]), [['alpha', 'commit']])
  assert.notEqual(c.head(), c.bases.alpha)
  assert.equal(git(c.dir(), 'log', '-1', '--format=%B').trim(), 'feat: deliver me\n\nfeat: deliver me body')
  assert.equal(git(c.dir(), 'rev-parse', 'origin/main'), c.bases.alpha, 'not pushed')
  assert.equal(endOf(c).delivered[0].ref, c.head())
})

test('rung push: committed and pushed to the task branch', async () => {
  const c = await run(deliverable({ block: { whenClean: 'push' } }))
  assert.deepEqual(endOf(c).delivered.map((d) => d.step), ['commit', 'push'])
  assert.equal(git(c.remotes.alpha, 'rev-parse', c.task), c.head())
})

test('rung pr: a draft PR, never merged', async () => {
  const before = ghCreates().length
  const c = await run(deliverable({ block: { whenClean: 'pr' } }))
  assert.deepEqual(endOf(c).delivered.map((d) => d.step), ['commit', 'push', 'pr'])
  const created = ghCreates().slice(before)
  assert.equal(created.length, 1)
  assert.ok(created[0].args.includes('--draft'))
  assert.equal(endOf(c).delivered[2].ref, 'https://github.com/o/pr/1')
})

test('rung merge on a local repo: commit, then the origin’s default branch moves', async () => {
  const c = await run({
    repos: ['lib'],
    block: { whenClean: 'merge' },
    exec: (n, t, c) => {
      if (n !== 1) return
      write(c.dir(), 'lib.txt', 'new\n')
      c.changes('lib: add')
    },
    rev: (r, t, c, rid) => approve(c, rid)
  })
  assert.equal(endOf(c).outcome, 'ready', JSON.stringify(endOf(c)))
  assert.deepEqual(endOf(c).delivered.map((d) => d.step), ['commit', 'merge'])
  assert.equal(git(c.remotes.lib, 'rev-parse', 'main'), c.head())
})

test('a reviewed tree that moves before the verdict ends `tree-moved`; nothing is delivered', async () => {
  const c = await run({
    block: { whenClean: 'push' },
    exec: (n, t, c) => cleanExec(c, n),
    rev: (r, t, c, rid) => {
      write(c.dir(), 'sneaky.txt', 'changed after the review began\n')
      approve(c, rid)
    }
  })
  needsYou(c, 'tree-moved')
  assert.equal(c.head(), c.bases.alpha)
  assert.throws(() => git(c.remotes.alpha, 'rev-parse', '--verify', '--quiet', `refs/heads/${c.task}`), 'nothing pushed')
})

test('a failing commit ends `delivery-failed` with nothing delivered (git’s own failure: hooks do not run, §6)', async () => {
  const c = await run({
    wait: false,
    block: { whenClean: 'commit' },
    exec: (n, t, c) => {
      cleanExec(c, n)
      if (n === 1) fs.writeFileSync(path.join(c.dir(), '.git', 'index.lock'), '') // a stale lock: `git add` refuses
    },
    rev: (r, t, c, rid) => approve(c, rid)
  })
  await finished(c)
  const e = needsYou(c, 'delivery-failed')
  assert.match(e.detail, /commit-failed/)
  assert.deepEqual(e.delivered, [])
  assert.equal(c.head(), c.bases.alpha)
})

// §10 (Fix 5): the clone's `.git` is the agent's; the loop's host git — the hash,
// the reviewer's diff, every delivery step — runs nothing it names, and the
// delivery still lands. A pre-commit hook that FAILS no longer ends delivery: no hook runs.
for (const [repo, rung] of [['alpha', 'push'], ['lib', 'merge']]) {
  test(`a hostile clone (hooks, fsmonitor, filter, diff driver, uploadpack…) runs nothing on the host through the whole loop — rung ${rung}`, async () => {
    const hostile = {}
    const c = await run({
      repos: [repo],
      block: { whenClean: rung },
      exec: (n, t, c) => {
        if (n !== 1) return
        hostile.evil = makeEvil(c.dir(), fs.mkdtempSync(path.join(scratch, 'evil-')), { remote: c.remotes[repo] })
        write(c.dir(), 'status.txt', 'good\ndelivered\n')
        c.changes('feat: deliver me')
      },
      rev: (r, t, c, rid) => approve(c, rid)
    })
    // Before any plain git of this test touches the clone.
    assert.deepEqual(hostile.evil.hits(), [])
    assert.equal(endOf(c).outcome, 'ready', JSON.stringify(endOf(c)))
    assert.deepEqual(endOf(c).delivered.map((d) => d.step), rung === 'push' ? ['commit', 'push'] : ['commit', 'merge'])
    assert.match(c.reviewers[0].prompt, /delivered/, 'the reviewer was given the diff')
    assert.equal(git(c.dir(), 'show', 'HEAD:status.txt'), 'good\ndelivered')
    assert.equal(git(c.remotes[repo], 'rev-parse', rung === 'push' ? c.task : 'main'), c.head())
  })
}

// ============================================================= stop loop ===
test('stop loop ends `cancelled`, terminates the running check’s group and cancels nothing else', async () => {
  const c = await run({
    repos: ['slow'],
    wait: false,
    exec: (n, t, c) => {
      write(c.dir(), 'a.txt', 'x\n')
      c.changes('feat: slow')
    }
  })
  await until(() => fs.existsSync(path.join(c.dir(), 'started.flag')), 'the check is running')
  assert.equal(c.st().phase, 'checking')
  await kernel.reviewLoop.stopLoop(c.id)
  assert.equal(c.st().phase, 'ended', 'written at once')
  await finished(c)
  needsYou(c, 'cancelled')
  assert.equal(kernel.sessions.isLoopHeld(c.id), false)
  await tick(300)
  assert.equal(fs.existsSync(path.join(c.dir(), 'finished.flag')), false, 'the check was terminated, not left to finish')
  assert.equal(c.reviewers.length, 0)
  await kernel.reviewLoop.stopLoop(c.id) // an ended loop: nothing to stop
  await assert.rejects(kernel.reviewLoop.stopLoop('nope'), /no review loop/)
})

test('stopping a running check = stopping the executor\'s container (§5.3)', async () => {
  const c = await run({
    repos: ['slow'],
    wait: false,
    exec: (n, t, c) => {
      write(c.dir(), 'a.txt', 'x\n')
      c.changes('feat: slow')
    }
  })
  await until(() => fs.existsSync(path.join(c.dir(), 'started.flag')), 'the check is running')
  const before = stops.filter((x) => x.id === c.id).length
  await kernel.reviewLoop.stopLoop(c.id)
  await finished(c)
  assert.equal(stops.filter((x) => x.id === c.id).length, before + 1, 'the executor\'s container was stopped, once')
  assert.equal(kernel.sessions.isLoopHeld(c.id), false)
})

// ================================================================ the rest ===
test('the container is woken for the check when it is down', async () => {
  let wakes = 0
  const real = kernel.sessions.ensureContainerUp
  kernel.sessions.ensureContainerUp = async (sid) => {
    wakes++
    container(sid, 'running')
  }
  const c = await run({
    wait: false,
    exec: (n, t, c) => {
      if (n === 1) {
        write(c.dir(), 'status.txt', 'good\nwake\n')
        container(c.id, 'stopped')
        c.changes('feat: wake')
      }
    },
    rev: (r, t, c, rid) => approve(c, rid)
  })
  await finished(c)
  kernel.sessions.ensureContainerUp = real
  assert.ok(wakes >= 1, 'woken through the gated path, without attaching the agent')
  assert.equal(endOf(c).outcome, 'ready')
})

test('review-loop.json is a reserved repo name, written like the other store files', async () => {
  const c = await run(deliverable())
  const file = path.join(h.GURT_ROOT, ws, c.task, 'review-loop.json')
  assert.ok(fs.existsSync(file))
  assert.ok(!fs.readdirSync(path.dirname(file)).some((f) => f.endsWith('.tmp')), 'no temp file left behind')
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), [c.id], 'keyed by executor id')
  assert.throws(() => h.store.validateName('repo', 'review-loop.json'), /reserved/)
})

test('the stop-loop and state methods are on the API and not offered to the operator', async () => {
  const { API_METHODS, METHOD_EXPOSURE } = h.api
  for (const m of ['reviewLoopState', 'reviewLoopStop']) {
    assert.ok(API_METHODS.includes(m))
    assert.equal(METHOD_EXPOSURE[m], 'none')
  }
})

// ==================================================================== takeover ===
/** How the host (not a person) cancelled a session: `kernel.sessions.cancel(id, by)`. */
const cancels = []
const realCancel = kernel.sessions.cancel.bind(kernel.sessions)
kernel.sessions.cancel = (sid, by) => (cancels.push({ sid, by: by ?? 'user' }), realCancel(sid, by))
const humans = []
kernel.bus.on('session.human', (e) => humans.push(e))

/** A loop parked in `reviewing` with its reviewer running (and hanging on `g`). */
async function parkedInReview({ hang = true } = {}) {
  const g = gate()
  /** @type {any} */
  const c = await run({
    wait: false,
    exec: (n, t, c) => {
      if (n === 1) {
        write(c.dir(), 'status.txt', 'good\nparked\n')
        c.changes('feat: parked')
      }
    },
    rev: async (r, t, c, rid) => {
      if (hang) await g
      approve(c, rid)
    }
  })
  await until(() => c.reviewers.length === 1 && c.reviewers[0].texts.length === 1, 'the reviewer is running')
  c.g = g
  return c
}
const reviewerOf = (c) => kernel.sessions.sessionInfo(c.reviewers[0].id)

test('takeover: typing into the executor ends `taken-over`, deletes the reviewer, and the message then runs as any other', async () => {
  const c = await parkedInReview()
  await kernel.sessions.prompt(c.id, 'actually, do it differently')
  await finished(c)
  needsYou(c, 'taken-over')
  assert.equal(reviewerOf(c), undefined, 'the running reviewer is deleted')
  assert.equal(kernel.sessions.isLoopHeld(c.id), false)
  await until(() => c.prompts.includes('actually, do it differently'), 'the typed message ran')
  assert.equal(c.st().phase, 'ended', 'no re-arm')
  assert.equal(endNotices(c).length, 1)
  c.g.open()
})

test('a task typed after the loop has ended starts the loop over: check, a fresh round-1 reviewer, a second end', async () => {
  const c = await run({
    exec: (n, text, c) => {
      if (n === 1) {
        write(c.dir(), 'status.txt', 'good v1\n')
        return c.changes('feat: v1')
      }
      if (text === 'now the next task') {
        // The new task's turn runs inside the loop again, from its start.
        assert.equal(kernel.sessions.isLoopHeld(c.id), true, 'held again before the new turn can end')
        assert.equal(c.st().phase, 'dormant')
        assert.equal(c.st().round, 0)
        write(c.dir(), 'status.txt', 'good v2\n')
        return c.changes('feat: v2')
      }
    },
    rev: (round, text, c, rid) => approve(c, rid)
  })
  assert.equal(endOf(c).outcome, 'ready')
  const first = c.st()
  await kernel.sessions.prompt(c.id, 'now the next task')
  await until(() => endNotices(c).length === 2, 'the second loop ended')
  await finished(c)
  const s = c.st()
  assert.equal(endOf(c).outcome, 'ready')
  assert.equal(s.round, 1, 'rounds count from 1 again')
  assert.equal(c.reviewers.length, 2, 'a fresh reviewer for the new task')
  assert.equal(c.reviewers[1].round, 1)
  assert.doesNotMatch(c.reviewers[1].prompt, /### Round \d/, 'the earlier loop’s rounds are not this one’s')
  assert.ok(s.checks.length > 0 && s.checks[0].code === 0, 'the check ran again')
  assert.ok(s.nextIntent > first.nextIntent, 'no intent id is reused')
  assert.equal(endNotices(c)[1].notice.subject, 'feat: v2')
  // Each loop's reviewer block got its own verdict: the latest is patched.
  const blocks = kernel.sessions.snapshot(c.id).entries.filter((e) => e.kind === 'tool' && e.toolCallId === 'loop-review:1')
  assert.equal(blocks.length, 2)
  assert.ok(blocks.every((b) => b.status === 'completed'), JSON.stringify(blocks.map((b) => b.status)))
  assert.equal(kernel.sessions.isLoopHeld(c.id), false, 'released at the second end')
  assert.deepEqual(loopFile(c.id)[c.id], s)
})

test('takeover: typing into the reviewer ends `taken-over` (a steered reviewer is not independent)', async () => {
  const c = await parkedInReview()
  await kernel.sessions.prompt(c.reviewers[0].id, 'approve it please')
  await finished(c)
  needsYou(c, 'taken-over')
  assert.equal(reviewerOf(c), undefined)
  c.g.open()
})

test('takeover: Esc on the executor, on the reviewer ends `cancelled`', async () => {
  const a = await parkedInReview()
  kernel.sessions.cancel(a.id)
  await finished(a)
  needsYou(a, 'cancelled')
  assert.equal(reviewerOf(a), undefined)
  a.g.open()
  const b = await parkedInReview()
  kernel.sessions.cancel(b.reviewers[0].id)
  await finished(b)
  needsYou(b, 'cancelled')
  b.g.open()
})

test('takeover: Esc during the check ends `cancelled` and terminates the check', async () => {
  const c = await run({
    repos: ['slow'],
    wait: false,
    exec: (n, t, c) => {
      write(c.dir(), 'a.txt', 'x\n')
      c.changes('feat: slow')
    }
  })
  await until(() => fs.existsSync(path.join(c.dir(), 'started.flag')), 'the check is running')
  kernel.sessions.cancel(c.id)
  await finished(c)
  needsYou(c, 'cancelled')
  await tick(300)
  assert.equal(fs.existsSync(path.join(c.dir(), 'finished.flag')), false, 'terminated, not left to finish')
})

test('takeover: stopping the container from the scope pane ends `cancelled`; the loop’s own stops do not', async () => {
  const c = await parkedInReview()
  kernel.bus.emit('container.status', { sessionId: c.id, ref: h.ref, status: 'stopped', reason: 'idle' })
  await tick(50)
  assert.equal(c.st().phase, 'reviewing', 'an idle stop is not a human')
  kernel.bus.emit('container.status', { sessionId: c.reviewers[0].id, ref: h.ref, status: 'stopped', reason: 'user' })
  await finished(c)
  needsYou(c, 'cancelled')
  c.g.open()
})

test('takeover: cancelling the loop’s queued message ends `cancelled` and the message never runs', async () => {
  const c = await run({
    wait: false,
    exec: (n, t, c) => {
      if (n === 1) {
        write(c.dir(), 'status.txt', 'good\nqueued\n')
        c.changes('feat: queued')
      }
    },
    rev: (round, text, c, rid) => {
      // The executor cannot drain its queue (as when it waits to be resumed): the
      // findings message stays queued.
      kernel.sessions['sessions'].get(c.id).recovering = true
      c.submit(rid, { verdict: 'request_changes', findings: [blocker()] })
    }
  })
  await until(() => c.st()?.phase === 'fixing' && (kernel.sessions.snapshot(c.id).pending ?? []).length === 1, 'the message is queued')
  const pending = kernel.sessions.snapshot(c.id).pending[0]
  assert.ok(pending.loop, 'it carries the intent id')
  kernel.sessions.cancelPending(c.id, pending.id)
  await finished(c)
  needsYou(c, 'cancelled')
  assert.equal((kernel.sessions.snapshot(c.id).pending ?? []).length, 0)
  kernel.sessions['sessions'].get(c.id).recovering = false
  assert.ok(!c.prompts.some((t) => t.startsWith('gurt review loop — round')), 'never sent')
})

test('takeover: deleting the executor, or the reviewer, ends `cancelled`', async () => {
  const a = await parkedInReview()
  kernel.sessions.deleteSession(a.id)
  await until(() => a.st()?.phase === 'ended', 'ended')
  assert.equal(a.st().end.reason, 'cancelled')
  await until(() => reviewerOf(a) === undefined, 'the reviewer is deleted with it')
  await until(() => a.st() === undefined, 'a deleted executor’s ended loop is forgotten')
  a.g.open()
  const b = await parkedInReview()
  kernel.sessions.deleteSession(b.reviewers[0].id)
  await finished(b)
  needsYou(b, 'cancelled')
  b.g.open()
})

test('takeover: the scope is not archived, and not auto-archived, while the loop is live', async () => {
  const c = await parkedInReview()
  assert.equal(kernel.reviewLoop.live(ws, c.task), true)
  assert.equal(kernel.sessions.taskHasPendingWork(ws, c.task), true)
  await assert.rejects(kernel.archive.archive(ws, c.task), /review loop is running/)
  await assert.rejects(kernel.archive.archiveSession(c.id), /review loop is running/)
  await assert.rejects(kernel.archive.archiveSession(c.reviewers[0].id), /review loop is running/)
  kernel.sessions.cancel(c.id)
  await finished(c)
  assert.equal(kernel.reviewLoop.live(ws, c.task), false)
  c.g.open()
})

// ---- the delivery boundary (§5.6, "During delivery") ----------------------------
/** Holds the first delivery step until `open()` — the step has started, so the
 *  cancellation boundary is behind us. A `git` shim on PATH (hooks do not run). */
const gateFirstCommit = () => gateCommit(scratch, 'hold')
async function deliveringOn(gated = {}) {
  const c = await run({
    wait: false,
    block: { whenClean: 'push' },
    exec: (n, t, c) => {
      if (n === 1) {
        gated.g = gateFirstCommit()
        cleanExec(c, n)
      }
    },
    rev: (r, t, c, rid) => approve(c, rid)
  })
  await until(() => c.st()?.phase === 'delivering' && gated.g?.reached(), 'the first step has started')
  return c
}

test('during delivery nothing a human does ends the loop: a typed message waits and runs after the end; Esc and a stop have nothing to interrupt', async () => {
  const gated = {}
  const c = await deliveringOn(gated)
  const realSchedule = kernel.sessions.schedule
  // The lift of the gate is the end's `schedule()`: the real one for this test.
  kernel.sessions.schedule = Object.getPrototypeOf(kernel.sessions).schedule.bind(kernel.sessions)
  try {
    await kernel.sessions.prompt(c.id, 'typed during delivery')
    kernel.sessions.cancel(c.id)
    kernel.bus.emit('container.status', { sessionId: c.id, ref: h.ref, status: 'stopped', reason: 'user' })
    await tick(150)
    assert.equal(c.st().phase, 'delivering', 'none of them applied')
    assert.ok(!c.prompts.includes('typed during delivery'), 'the message waits behind the delivery gate')
    assert.equal(kernel.sessions.snapshot(c.id).pending.length, 1)
    await assert.rejects(kernel.reviewLoop.stopLoop(c.id), /delivering/)
    gated.g.open()
    await finished(c)
    assert.equal(endOf(c).outcome, 'ready', JSON.stringify(endOf(c)))
    assert.deepEqual(endOf(c).delivered.map((d) => d.step), ['commit', 'push'])
    await until(() => c.prompts.includes('typed during delivery'), 'the typed message ran after the loop ended')
    assert.equal(c.st().phase, 'ended', 'typed before the end, it runs outside the loop: no new loop')
    assert.equal(git(c.remotes.alpha, 'rev-parse', c.task), c.head())
  } finally {
    kernel.sessions.schedule = realSchedule
  }
})

test('deleting the executor during delivery removes the session; the delivery finishes on the clone', async () => {
  const gated = {}
  const c = await deliveringOn(gated)
  const schedule = kernel.sessions.schedule
  const w = kernel.sessions.createSession({ workspace: ws, task: c.task, env: 'dev' }, ['alpha'], 'a1', 'writer', 'queue', [], true, {}, 'executor', undefined, undefined, { alpha: 'write', slow: 'write' })
  kernel.sessions.schedule = Object.getPrototypeOf(kernel.sessions).schedule.bind(kernel.sessions)
  kernel.sessions.deleteSession(c.id)
  await tick(100)
  const writerState = kernel.sessions.sessionInfo(w.id).state
  kernel.sessions.schedule = schedule
  gated.g.open()
  assert.equal(writerState, 'queued', 'reservation survives executor deletion during delivery')
  assert.equal(c.st().phase, 'delivering', 'not cut short')
  gated.g.open()
  await until(() => !c.st() && notices.some((n) => n.sessionId === c.id && n.notice.kind === 'end'), 'delivered, ended, forgotten')
  const end = notices.find((n) => n.sessionId === c.id && n.notice.kind === 'end').notice.end
  assert.equal(end.outcome, 'ready', JSON.stringify(end))
  assert.equal(git(c.dir(), 'log', '-1', '--format=%B').trim(), 'feat: deliver me\n\nfeat: deliver me body', 'the commit text outlived the session')
  assert.equal(git(c.remotes.alpha, 'rev-parse', c.task), c.head())
})

// ================================================ the loop hold vs FIFO by clone ===
// §5.5 on top of main's FIFO by clone (d1fb01e): a session the user queues on the
// executor's clone while the loop reviews waits for the loop — and the loop's own
// work (the findings message) never waits for it. When the loop ends, it starts.
for (const mode of ['write', 'read-locked'])
  test(`a ${mode} session queued on the clone while the loop reviews: the findings message runs, and that session starts when the loop ends`, async () => {
    const g = gate()
    let rival = ''
    let rivalAtFix
    const c = await run({
      wait: false,
      exec: (n, t, c) => {
        if (n === 1) {
          write(c.dir(), 'status.txt', 'good\nv1\n')
          return c.changes('feat: v1')
        }
        rivalAtFix = kernel.sessions.sessionInfo(rival).state
        // Answered, the diff left as it was: the loop ends `no-progress`
        // with no second reviewer to start (§5.2).
        c.changes('feat: v1', { replies: [{ findingId: 'R1.F1', resolution: 'declined', note: 'keeping it' }] })
      },
      rev: async (round, t, c, rid) => {
        await g
        c.submit(rid, { verdict: 'request_changes', findings: [blocker()] })
      }
    })
    await until(() => c.reviewers.length === 1 && c.reviewers[0].texts.length === 1, 'the reviewer is running')
    rival = kernel.sessions.createSession({ workspace: ws, task: c.task, env: 'dev' }, ['alpha'], 'a1', 'rival', 'queue', [], true, {},
      mode === 'write' ? 'executor' : 'researcher', undefined, undefined, { alpha: mode }).id
    // No reviewer is created from here on: the real scheduler, so that the
    // release's own `schedule()` is what starts the rival.
    const schedule = kernel.sessions.schedule
    kernel.sessions.schedule = Object.getPrototypeOf(kernel.sessions).schedule.bind(kernel.sessions)
    try {
      kernel.sessions.schedule()
      await tick(50)
      assert.equal(kernel.sessions.sessionInfo(rival).state, 'queued', 'the loop holds the clone')
      assert.equal(kernel.sessions.snapshot(rival).info.queueWaiting,
        `the review loop of session "Exec ${c.id}" holds "alpha" — this starts when the loop lets go`)
      g.open()
      await until(() => c.prompts.some((p) => p.startsWith('gurt review loop — round 1 of 2')), 'the findings message ran')
      assert.equal(rivalAtFix, 'queued', 'it ran while the rival waited for the loop')
      await finished(c)
      needsYou(c, 'no-progress')
      assert.equal(kernel.sessions.isLoopHeld(c.id), false)
      await until(() => kernel.sessions.sessionInfo(rival).state !== 'queued', 'the rival starts once the loop let go')
    } finally {
      kernel.sessions.schedule = schedule
      g.open() // a failure above must not leave the loop parked in review
    }
  })

// ==================================================================== deadline ===
test('the deadline runs 120 minutes from the start prompt; expiry cancels the turn (as the host) and ends `time-cap`', async () => {
  const g = gate()
  const t0 = nowMs
  const before = cancels.length
  const humansBefore = humans.length
  const c = await run({ wait: false, exec: async () => { await g } })
  await until(() => c.st()?.deadline, 'the deadline is set by the first turn')
  assert.equal(c.st().deadline, new Date(t0 + 120 * 60_000).toISOString())
  nowMs = t0 + 119 * 60_000
  kernel.reviewLoop.tick()
  assert.equal(c.st().phase, 'dormant', 'not yet')
  nowMs = t0 + 120 * 60_000
  kernel.reviewLoop.tick()
  assert.equal(c.st().phase, 'ended', 'written at once')
  await finished(c)
  needsYou(c, 'time-cap')
  assert.deepEqual(cancels.slice(before).filter((x) => x.sid === c.id), [{ sid: c.id, by: 'host' }])
  assert.equal(humans.length, humansBefore, 'the host’s cancel is not a human act')
  nowMs = t0
  g.open()
})

test('a dormant no_changes clears the deadline: the session is the user’s again and no tick ends anything', async () => {
  const t0 = nowMs
  const c = await run({ wait: false, exec: (n, t, c) => c.complete({ version: 1, outcome: 'no_changes' }) })
  await until(() => notices.some((n) => n.sessionId === c.id && n.notice.kind === 'turn-ended'), 'handed back')
  nowMs = t0 + 500 * 60_000
  kernel.reviewLoop.tick()
  assert.equal(c.st().phase, 'dormant')
  assert.equal(endNotices(c).length, 0)
  nowMs = t0
})

test('a plan hold on the loop’s own session extends the deadline, 24 hours at most', async () => {
  const g = gate()
  const t0 = nowMs
  const c = await run({ wait: false, exec: async () => { await g } })
  await until(() => c.st()?.deadline, 'deadline')
  const settle = (n, hours) =>
    kernel.bus.emit('session.settled', {
      sessionId: c.id, ref: h.ref,
      turn: { turnId: `${c.id}:${n}`, limited: { until: new Date(nowMs + hours * 3_600_000).toISOString() }, incomplete: false }
    })
  settle(90, 3)
  await until(() => c.st().holdExtensionMs === 3 * 3_600_000, 'extended by the hold')
  assert.equal(c.st().deadline, new Date(t0 + 120 * 60_000 + 3 * 3_600_000).toISOString())
  nowMs = t0 + 121 * 60_000
  kernel.reviewLoop.tick()
  assert.equal(c.st().phase, 'dormant', 'the original deadline no longer ends it')
  settle(91, 40)
  await until(() => c.st().holdExtensionMs === 24 * 3_600_000, 'capped at 24 h in total')
  assert.equal(c.st().deadline, new Date(t0 + 120 * 60_000 + 24 * 3_600_000).toISOString())
  nowMs = t0
  await kernel.reviewLoop.stopLoop(c.id)
  g.open()
})

test('time-cap terminates a running check and deletes a running reviewer', async () => {
  const t0 = nowMs
  const slow = await run({
    repos: ['slow'],
    wait: false,
    exec: (n, t, c) => {
      write(c.dir(), 'a.txt', 'x\n')
      c.changes('feat: slow')
    }
  })
  await until(() => fs.existsSync(path.join(slow.dir(), 'started.flag')), 'the check is running')
  nowMs = t0 + 121 * 60_000
  kernel.reviewLoop.tick()
  await finished(slow)
  needsYou(slow, 'time-cap')
  await tick(300)
  assert.equal(fs.existsSync(path.join(slow.dir(), 'finished.flag')), false, 'the check was terminated')
  nowMs = t0
  const rev = await parkedInReview()
  nowMs = t0 + 121 * 60_000
  kernel.reviewLoop.tick()
  await finished(rev)
  needsYou(rev, 'time-cap')
  assert.equal(reviewerOf(rev), undefined, 'the running reviewer is deleted')
  nowMs = t0
  rev.g.open()
})

test('a permission request open 15 minutes on either session ends `permission-wait`; one answered in time does not', async () => {
  const t0 = nowMs
  const a = await parkedInReview()
  const awaiting = (sessionId, on) => kernel.bus.emit('session.awaiting', { sessionId, ref: h.ref, awaiting: on })
  awaiting(a.id, true)
  nowMs = t0 + 14 * 60_000
  kernel.reviewLoop.tick()
  assert.equal(a.st().phase, 'reviewing')
  awaiting(a.id, false)
  nowMs = t0 + 40 * 60_000
  kernel.reviewLoop.tick()
  assert.equal(a.st().phase, 'reviewing', 'answered in time')
  awaiting(a.reviewers[0].id, true) // opened at t0 + 40 min
  nowMs = t0 + 56 * 60_000
  const before = cancels.length
  kernel.reviewLoop.tick()
  await finished(a)
  needsYou(a, 'permission-wait')
  assert.ok(cancels.slice(before).some((x) => x.sid === a.id && x.by === 'host'), 'the executor’s turn is cancelled first')
  assert.equal(reviewerOf(a), undefined)
  nowMs = t0
  a.g.open()
  await kernel.reviewLoop.idle()
  await tick(150)
})

// §5.3/§5.5: deletion and a failed stop cannot hand a check's clone to a writer.
test('deleted checking executor retains reservation through unconfirmed stop and retries cleanup', async () => {
  const c = await run({ repos: ['slow'], wait: false, exec: (n, t, c) => {
    write(c.dir(), 'a.txt', 'x\n')
    c.changes('feat: slow')
  } })
  await until(() => fs.existsSync(path.join(c.dir(), 'started.flag')), 'check running')
  const stop = kernel.containers.stop
  const inspect = kernel.containers.isRunning
  const schedule = kernel.sessions.schedule
  let attempts = 0
  kernel.containers.stop = async () => { attempts++; throw new Error('daemon unavailable') }
  kernel.containers.isRunning = async () => true
  const w = kernel.sessions.createSession({ workspace: ws, task: c.task, env: 'dev' }, ['slow'], 'a1', 'writer', 'queue', [], true, {}, 'executor', undefined, undefined, { alpha: 'write', slow: 'write' })
  kernel.sessions.schedule = Object.getPrototypeOf(kernel.sessions).schedule.bind(kernel.sessions)
  try {
    kernel.sessions.deleteSession(c.id)
    await until(() => c.st()?.phase === 'ended', 'loop ended')
    await kernel.reviewLoop.idle()
    assert.ok(c.st()?.end?.cleanupPending, 'unconfirmed stop is visibly pending')
    assert.equal(kernel.sessions.isLoopHeld(c.id), true)
    assert.equal(kernel.sessions.sessionInfo(w.id).state, 'queued')
    const before = attempts
    kernel.reviewLoop.tick()
    await tick(50)
    assert.equal(attempts, before, 'backoff prevents immediate retries')
    kernel.containers.stop = stop
    kernel.containers.isRunning = async () => false
    nowMs += 300_001
    kernel.reviewLoop.tick()
    await kernel.reviewLoop.idle()
    assert.equal(kernel.sessions.isLoopHeld(c.id), false)
    assert.equal(endNotices(c).length, 1)
    await until(() => kernel.sessions.sessionInfo(w.id).state !== 'queued', 'writer after confirmed cleanup')
  } finally {
    kernel.containers.stop = stop
    kernel.containers.isRunning = inspect
    kernel.sessions.schedule = schedule
    await stop(c.id, 'idle')
  }
})

test('end cleanup throwing retains hold and retries on tick without duplicate notification', async () => {
  const drop = kernel.sessions.dropHostPrompts
  let fail = true
  kernel.sessions.dropHostPrompts = (id) => {
    if (fail) throw new Error('cleanup unavailable')
    return drop.call(kernel.sessions, id)
  }
  try {
    const c = await run({ wait: false, exec: (n, t, c) => kernel.sessions['onComplete'](c.id, { version: 1, outcome: 'blocked', reason: 'blocked' }) })
    await until(() => c.st()?.phase === 'ended', 'loop ended')
    await kernel.reviewLoop.idle()
    assert.ok(c.st()?.end?.cleanupPending, 'cleanup failure is visibly pending')
    assert.equal(kernel.sessions.isLoopHeld(c.id), true)
    assert.equal(endNotices(c).length, 0)
    fail = false
    nowMs += 300_001
    kernel.reviewLoop.tick()
    await finished(c)
    assert.equal(c.st().end.cleanupPending, undefined)
    assert.equal(kernel.sessions.isLoopHeld(c.id), false)
    assert.equal(endNotices(c).length, 1)
  } finally { kernel.sessions.dropHostPrompts = drop }
})

test('end persistence failure keeps reservation and retries notification after storage recovers', async () => {
  const drop = kernel.sessions.dropHostPrompts
  let file
  kernel.sessions.dropHostPrompts = (id) => {
    drop.call(kernel.sessions, id)
    if (file) return
    file = path.join(h.GURT_ROOT, ws, kernel.sessions.sessionInfo(id).task, 'review-loop.json')
    fs.renameSync(file, `${file}.saved`)
    fs.mkdirSync(file)
  }
  try {
    const c = await run({ wait: false, exec: (n, t, c) => c.complete({ version: 1, outcome: 'blocked', reason: 'blocked' }) })
    await until(() => c.st()?.phase === 'ended', 'loop ended')
    await kernel.reviewLoop.idle()
    assert.ok(c.st()?.end?.cleanupPending, 'persistence failure is visibly pending')
    assert.equal(kernel.sessions.isLoopHeld(c.id), true)
    assert.equal(c.st().notified, false)
    assert.equal(endNotices(c).length, 1, 'emit before marking; retry must not duplicate in this life')
    fs.rmdirSync(file)
    fs.renameSync(`${file}.saved`, file)
    nowMs += 300_001
    kernel.reviewLoop.tick()
    await finished(c)
    assert.equal(kernel.sessions.isLoopHeld(c.id), false)
    assert.equal(endNotices(c).length, 1)
  } finally {
    kernel.sessions.dropHostPrompts = drop
    if (file && fs.existsSync(`${file}.saved`)) {
      fs.rmdirSync(file)
      fs.renameSync(`${file}.saved`, file)
    }
  }
})

for (const failures of [2, 3]) {
  test(`settled persistence fails ${failures} times: durable retry or store fault with hold`, async () => {
    const persist = kernel.sessions.persistNow
    let attempts = 0
    let target
    const settles = []
    const off = kernel.bus.on('session.settled', (e) => settles.push(e.sessionId))
    kernel.sessions.persistNow = async function (s) {
      if (s.info.id === target && s.lastSettled && attempts < failures) {
        attempts++
        throw new Error('injected settled write failure')
      }
      return persist.call(this, s)
    }
    try {
      const c = await run({
        exec: (n, t, c) => { target = c.id; c.complete({ version: 1, outcome: 'blocked', reason: 'test' }) }
      })
      assert.equal(attempts, failures)
      if (failures === 3) {
        assert.equal(c.st().end.outcome, 'failed')
        assert.equal(c.st().end.error, 'store')
        assert.equal(settles.includes(c.id), false, 'no undurable controller input')
        assert.equal(kernel.sessions.isLoopHeld(c.id), true)
        assert.equal(kernel.sessions.lastSettledOf(c.id), undefined)
      } else {
        assert.equal(c.st().end.reason, 'executor-blocked')
        assert.equal(settles.filter((id) => id === c.id).length, 1)
        assert.equal(kernel.sessions.isLoopHeld(c.id), false)
      }
      assert.equal(endNotices(c).length, 1)
    } finally { kernel.sessions.persistNow = persist; off() }
  })
}
