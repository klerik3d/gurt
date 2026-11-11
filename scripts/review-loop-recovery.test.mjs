// The review loop after a crash (src/main/reviewLoop.ts `load` / `recover`,
// docs/requirements-review-loop.md §8; acceptance §12 item 8). A kernel is run
// to a chosen instant, the data root is copied exactly as the disk holds it at
// that instant (`h.image()` — what a crash leaves behind), and a SECOND kernel
// is booted on the copy. The first one is the dead process: it keeps running in
// its own root and is never looked at again, except for the effects that are
// shared on purpose (the bare origins) and are therefore gated by a post-receive hook and a `git` shim.
//
// Pinned here, around every intent — before it is written (the settle that
// decides it), before its effect, before its outcome — and between a settle and
// its consumption:
//   - `message`   : once, whether it was never enqueued, waits in the queue, or
//                   was already taken off it (the in-flight marker) — in which
//                   case the interrupted turn resumes with the restart prompt;
//   - `reviewer`  : adopted by `reviewOf.intent`, never created twice; a reviewer
//                   that was `starting` (restored as a draft) is enqueued again
//                   with its start bound restarted; a finished reviewer is not
//                   waited on again;
//   - `check`     : the executor's container is stopped (§5.3), then the check reruns;
//   - `deliver`   : commit / push found done by looking (HEAD, the remote); a
//                   remote that advanced after our push is reported, not pushed to;
//   - `end`       : notified once per life; an unmarked emission reappears after restart;
//   - the deadline counts the time the app was down;
//   - the holds are in place before the scheduler's first pass;
//   - a resume that fails ends the loop `executor-error`.
//
//   node scripts/review-loop-recovery.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loopHarness } from './lib/loop-harness.mjs'
import { installGitGate } from './lib/git-gate.mjs'

Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test'
})
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-loop-rec-'))
const origins = path.join(scratch, 'origins')
fs.mkdirSync(origins)
const gates = []
installGitGate(scratch) // `GATE_COMMIT=pre|post` holds a host `git commit` (no clone hook runs, §6)
after(async () => {
  // The dead kernel's loops are still running in their own roots: end them, which
  // also stops (kills) a check still sleeping in the background.
  for (const id of started) await A.kernel.reviewLoop.stopLoop(id).catch(() => {})
})
after(() => {
  // Release whatever the dead kernel still has blocked in a hook.
  for (const g of gates) fs.writeFileSync(path.join(g, 'go'), '')
})

let nowMs = Date.now()
const h = await loopHarness('review-loop-recovery', {
  agents: {
    a1: { kind: 'claude-code', label: 'executor' },
    a2: { kind: 'claude-code', label: 'reviewer', credentialId: 'c2' }
  },
  workspace: {
    repos: [
      { name: 'alpha', url: 'https://github.com/o/alpha.git', check: 'grep -q good status.txt' },
      { name: 'slow', url: 'https://github.com/o/slow.git', check: 'echo x >> runs.log; sleep 60' }
    ],
    envs: [{ name: 'dev', image: 'x', repo: 'alpha' }]
  },
  credentials: [{ id: 'h', label: 'host auth', kind: 'git-host', hosts: ['github.com'], data: {} }],
  kernel: { reviewLoop: { clock: { now: () => nowMs, tickMs: 3_600_000, keepAliveMs: 3_600_000 } } }
})
const { ws } = h
after(() => {
  h.cleanup()
  fs.rmSync(scratch, { recursive: true, force: true })
})

const until = async (fn, what) => {
  const end = Date.now() + 30_000
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await h.tick(15)
  }
  throw new Error(`never: ${what}`)
}

// --- fixtures ----------------------------------------------------------------------
const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), text)
}
const GATE = `#!/bin/sh
[ -n "$GATE_DIR" ] || exit 0
touch "$GATE_DIR/reached-$(basename "$0")"
n=0
while [ ! -f "$GATE_DIR/go" ] && [ $n -lt 1200 ]; do sleep 0.05; n=$((n+1)); done
exit 1
`
let seq = 0
/** A task with a clone per repo on branch `<task>` and its own bare origin. `gated`
 *  installs what the delivery scenarios freeze the dead kernel with (a held
 *  `git commit` through the PATH shim, post-receive in the origin) and a counter of
 *  pushes the origin received. */
function fixture(repos, gated = []) {
  const task = `t${++seq}`
  const base = path.join(h.GURT_ROOT, ws, task)
  fs.mkdirSync(base, { recursive: true })
  fs.writeFileSync(path.join(base, 'task.json'), '{}')
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
    remotes[name] = remote
    // The origin's hook still runs (a push is received by the origin); the clone's
    // never do, so a commit is held by the `git` shim (`GATE_COMMIT`, in `start`).
    if (gated.includes('post-receive')) fs.writeFileSync(path.join(remote, 'hooks', 'post-receive'), GATE, { mode: 0o755 })
    // Every origin counts the pushes it receives.
    fs.writeFileSync(path.join(remote, 'hooks/pre-receive'), `#!/bin/sh\necho push >> ${JSON.stringify(path.join(remote, 'received.log'))}\n`, { mode: 0o755 })
  }
  return { task, remotes, bases: Object.fromEntries(repos.map((r) => [r, git(path.join(base, r), 'rev-parse', 'HEAD')])) }
}
const received = (remote) => {
  const f = path.join(remote, 'received.log')
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0
}

// --- a kernel life: the stubs every life needs -----------------------------------------
/** executor id -> (round, prompt, L, reviewerId) => the scripted reviewer. */
const reviewerScript = {}

/**
 * Wire one kernel instance: the scheduler stubbed (unless `realSchedule`), the
 * reviewer's start simulated, the check's exec run as the login shell under host
 * node in this life's clone, recorders — and the hook points the scenarios take
 * their images at (`L.hooks[executorId].<name>`).
 */
function life(inst, tag, { realSchedule = false } = {}) {
  const { kernel } = inst
  const L = { inst, tag, kernel, hooks: {}, enq: [], execs: [], notices: [], notifs: [], prompts: {}, startMode: 'run' }
  const exOf = (sid) => kernel.sessions.sessionInfo(sid)?.reviewOf?.executor ?? sid
  const hook = (sid, name, ...a) => L.hooks[exOf(sid)]?.[name]?.(L, ...a)
  // The stub keeps the real pass's drain half: since main's FIFO by clone
  // (d1fb01e) a started session's queue is drained in the scheduler's walk, and
  // a queued message restored without an interrupted turn is not `recovering`,
  // so the boot's first pass — not the controller's resume — is what sends it.
  // Only the starts are simulated.
  if (!realSchedule)
    kernel.sessions.schedule = () => {
      for (const s of kernel.sessions['queuedSessions']()) if (s.info.state === 'started') void kernel.sessions['drainPending'](s)
    }

  const realEnqueue = kernel.sessions.enqueue.bind(kernel.sessions)
  kernel.sessions.enqueue = (rid) => {
    const s = kernel.sessions['sessions'].get(rid)
    if (!s.info.reviewOf) return realEnqueue(rid)
    const ex = s.info.reviewOf.executor
    hook(rid, 'beforeEnqueue', rid)
    realEnqueue(rid)
    L.enq.push(rid)
    if (L.startMode === 'never') return
    setImmediate(() => {
      s.info.state = 'started'
      s.info.queuedAt = undefined
      inst.container(rid, 'running')
      kernel.bus.emit('session.state', { sessionId: rid, ref: s.ref, state: 'started', reason: 'scheduler' })
      inst.agent(rid, async (n, text) => {
        ;(L.prompts[rid] ??= []).push(text)
        return (await reviewerScript[ex]?.(s.info.reviewOf.round, text, L, rid)) ?? {}
      })
      void kernel.sessions['runPrompt'](s, s.info.startPrompt)
    })
  }
  const createReviewer = kernel.sessions.createReviewer.bind(kernel.sessions)
  kernel.sessions.createReviewer = (ex, req) => (hook(ex, 'beforeCreate'), createReviewer(ex, req))
  const hostPrompt = kernel.sessions.hostPrompt.bind(kernel.sessions)
  kernel.sessions.hostPrompt = async (sid, text, intent) => {
    hook(sid, 'beforeMessage', intent)
    await hostPrompt(sid, text, intent)
    hook(sid, 'afterMessage', intent)
  }
  const dropHostPrompts = kernel.sessions.dropHostPrompts.bind(kernel.sessions)
  kernel.sessions.dropHostPrompts = (sid) => (hook(sid, 'atEnd'), dropHostPrompts(sid))
  kernel.sessions.ensureContainerUp = async (sid) => inst.container(sid, 'running')

  kernel.containers.spawnExec = (sid, argv, cwd) => {
    const info = kernel.sessions.sessionInfo(sid)
    L.execs.push(sid)
    hook(sid, 'onExec')
    const child = inst.inContainer(sid, spawn(argv[0], argv.slice(1), {
      cwd: path.join(inst.GURT_ROOT, ws, info.task, path.basename(cwd)), detached: true, stdio: ['ignore', 'pipe', 'pipe']
    }))
    child.once('exit', () => hook(sid, 'onExecExit'))
    return child
  }
  kernel.bus.on('session.settled', ({ sessionId, turn }) => hook(sessionId, 'onSettled', sessionId, turn))
  kernel.bus.on('review.loop', (e) => (L.notices.push(e), hook(e.sessionId, 'onNotice', e)))
  kernel.bus.on('notification.created', (n) => L.notifs.push(n))
  return L
}

const A = life(h, 'A')

// --- the scripted agents ------------------------------------------------------------------
const dirOf = (L, c, repo = c.repos[0]) => path.join(L.inst.GURT_ROOT, ws, c.task, repo)
const proposal = (subject, extra = {}) => ({ version: 1, outcome: 'changes', commit: { subject, body: `${subject} body` }, ...extra })

/** The executor: the start prompt writes v1; any later prompt (a findings message,
 *  the restart prompt) is a fix that answers every open finding. Keyed by the
 *  text, so it serves a rebooted life whose prompt counter starts again. */
const execLogic = (c, L) => (n, text) => {
  const seen = (L.prompts[c.id] ??= [])
  seen.push(text)
  L.hooks[c.id]?.onPrompt?.(L, text)
  const dir = dirOf(L, c)
  if (text === c.startPrompt) {
    write(dir, 'status.txt', 'good\nv1\n')
    L.kernel.sessions['onComplete'](c.id, proposal('feat: first'))
    return
  }
  write(dir, 'status.txt', `good\nfix ${seen.length} in ${L.tag}\n`)
  const refs = L.kernel.reviewLoop.openFindings(c.id)
  L.kernel.sessions['onComplete'](c.id, proposal('feat: fixed', refs.length
    ? { replies: refs.map((findingId) => ({ findingId, resolution: 'fixed', note: 'done' })) }
    : {}))
}
/** The reviewer: `request_changes` with one blocker for the first `c.needFix` rounds, then approve. */
const reviewerLogic = (c) => (round, text, L, rid) => {
  const verdict = round <= c.needFix ? 'request_changes' : 'approve'
  L.kernel.sessions['onSubmitReview'](rid, {
    version: 1, verdict, summary: `round ${round}`,
    findings: verdict === 'approve' ? [] : [{ id: 'F1', file: 'alpha/status.txt', severity: 'blocker', claim: `wrong in round ${round}` }]
  })
}

/** Start a loop in life A. */
const started = []
function start({ repos = ['alpha'], needFix = 0, whenClean = 'notify', gated = [], startMode = 'run' } = {}) {
  const fx = fixture(repos, gated)
  const id = `r${process.pid}x${++seq}`
  const c = { id, repos, task: fx.task, startPrompt: `implement ${id}`, needFix, fx }
  started.push(id)
  const review = { agent: 'a2', maxRounds: 3, whenClean, draftPr: true }
  h.started(id, repos, { task: fx.task, review, title: `Exec ${id}`, startPrompt: c.startPrompt })
  h.agent(id, execLogic(c, A))
  reviewerScript[id] = reviewerLogic(c)
  A.startMode = startMode
  A.hooks[id] = {}
  if (gated.length) {
    c.gate = fs.mkdtempSync(path.join(scratch, 'gate-'))
    gates.push(c.gate)
    process.env.GATE_DIR = c.gate
    if (gated.includes('pre-commit')) process.env.GATE_COMMIT = 'pre'
    if (gated.includes('post-commit')) process.env.GATE_COMMIT = 'post'
  }
  c.begin = () => void A.kernel.sessions['runPrompt'](A.kernel.sessions['sessions'].get(id), c.startPrompt)
  return c
}

/** Crash life `from` at the image `image` and boot the next life on it. */
async function reboot(c, image, /** @type {{ tag?: string, realSchedule?: boolean, prepare?: (L: any) => void }} */ { tag = 'B', realSchedule = false, prepare } = {}) {
  delete process.env.GATE_DIR // the second life's git hooks do not block
  delete process.env.GATE_COMMIT
  // The dead kernel's executor says nothing more (its loop would otherwise carry
  // on in its own root, re-running checks and holding the event loop open).
  h.agent(c.id, () => new Promise(() => {}))
  // An image holds every scenario the dead kernel has run so far; this boot is
  // about one of them.
  for (const f of fs.readdirSync(path.join(image, ws)))
    if (f !== c.task && fs.statSync(path.join(image, ws, f)).isDirectory()) fs.rmSync(path.join(image, ws, f), { recursive: true })
  let L
  await h.boot(image, (inst) => {
    L = life(inst, tag, { realSchedule })
    inst.agent(c.id, execLogic(c, L))
    prepare?.(L)
  })
  return L
}
const stateOf = (L, c) => L.kernel.reviewLoop.state(c.id)
const ended = async (L, c) => {
  await until(() => stateOf(L, c)?.phase === 'ended' && stateOf(L, c)?.notified, `${tag(L)} ${c.id} ended and notified`)
  await L.kernel.reviewLoop.idle()
  return stateOf(L, c).end
}
const tag = (L) => L.tag
const endNotices = (L, c) => L.notices.filter((n) => n.sessionId === c.id && n.notice.kind === 'end')
const notifsOf = (L, c) => L.notifs.filter((n) => n.sessionId === c.id)
const reviewersIn = (L, c) => L.kernel.sessions.listForTask(ws, c.task).filter((i) => i.reviewOf?.executor === c.id)
const findingsMessages = (L, c) => (L.prompts[c.id] ?? []).filter((t) => t.startsWith('gurt review loop — round'))
/** Take the image the first time hook `name` fires on this executor (and `when`,
 *  given the hook's arguments after `L`, holds). */
const imageAt = (c, name, when) => {
  const got = { image: undefined, notices: 0 }
  A.hooks[c.id][name] = (L, ...a) => {
    if (got.image || (when && !when(...a))) return
    got.notices = endNotices(L, c).length
    got.image = h.image()
  }
  return got
}
const isReviewer = (sid) => A.kernel.sessions.sessionInfo(sid)?.reviewOf !== undefined

// =========================================================== settle -> consume ===
test('between the executor’s arming settle and its consumption: replayed, one reviewer, one `proposal`', async () => {
  const c = start()
  const got = imageAt(c, 'onSettled', (sid) => sid === c.id)
  c.begin()
  await until(() => got.image, 'the arming settle')
  const L = await reboot(c, got.image)
  const end = await ended(L, c)
  assert.equal(end.outcome, 'ready', JSON.stringify(end))
  assert.equal(reviewersIn(L, c).length, 1, 'one reviewer')
  assert.equal(L.enq.length, 1)
  assert.equal(stateOf(L, c).consumed[c.id], `${c.id}:1`)
  assert.equal(endNotices(L, c).length, 1)
  assert.deepEqual(notifsOf(L, c).map((n) => n.type), ['proposal'], 'exactly one proposal, at ready')
  assert.deepEqual(stateOf(L, c).intents, [])
})

test('a loop whose file never landed (the app went down right after the first turn): created at boot and the settle replayed', async () => {
  const c = start()
  const got = imageAt(c, 'onSettled', (sid) => sid === c.id)
  c.begin()
  await until(() => got.image, 'the arming settle')
  fs.rmSync(path.join(got.image, ws, c.task, 'review-loop.json'))
  const L = await reboot(c, got.image)
  const end = await ended(L, c)
  assert.equal(end.outcome, 'ready', JSON.stringify(end))
  assert.equal(L.enq.length, 1)
})

test('a reviewer that finished before the crash is not waited on again', async () => {
  const c = start()
  const got = imageAt(c, 'onSettled', (sid) => sid !== c.id)
  c.begin()
  const reviewerId = await until(() => got.image && stateOf(A, c)?.reviewer, 'the reviewer settled')
  const L = await reboot(c, got.image)
  const end = await ended(L, c)
  assert.equal(end.outcome, 'ready', JSON.stringify(end))
  assert.equal(L.enq.length, 0, 'no second reviewer')
  assert.equal(L.prompts[reviewerId], undefined, 'the finished reviewer was not run again')
  assert.ok(L.inst.stops.some((x) => x.id === reviewerId && x.reason === 'idle'), 'its stop-reviewer intent was carried out')
  assert.equal(stateOf(L, c).rounds[0].verdict.verdict, 'approve')
  assert.equal(endNotices(L, c).length, 1)
})

// ================================================================= message ===
/** A request_changes round whose findings message is the effect under test; the
 *  loop then runs to `ready` on round 2 in the second life. */
async function messageScenario(hookName, when) {
  const c = start({ needFix: 1 })
  const got = imageAt(c, hookName, when)
  c.begin()
  await until(() => got.image, `${hookName}`)
  const L = await reboot(c, got.image)
  const end = await ended(L, c)
  assert.equal(end.outcome, 'ready', JSON.stringify(end))
  assert.equal(stateOf(L, c).round, 2)
  assert.equal(reviewersIn(L, c).length, 2)
  assert.equal(L.enq.length, 1, 'only round 2’s reviewer was created in the second life')
  assert.deepEqual(stateOf(L, c).intents, [])
  assert.equal(endNotices(L, c).length, 1)
  return { c, L }
}

test('message — before it is written (the verdict settled, nothing decided): sent once', async () => {
  const { c, L } = await messageScenario('onSettled', isReviewer)
  assert.equal(findingsMessages(L, c).length, 1)
})

test('message — before its effect (the intent on disk, nothing enqueued): sent once', async () => {
  const { c, L } = await messageScenario('beforeMessage')
  assert.equal(findingsMessages(L, c).length, 1)
})

test('message — before its outcome (queued and persisted): found in the queue, sent once', async () => {
  const { c, L } = await messageScenario('afterMessage')
  assert.equal(findingsMessages(L, c).length, 1)
  // Main's restart rules (d1fb01e): only an interrupted turn gets the restart
  // prompt, and a restored queue adds no automatic continuation of its own.
  assert.equal((L.prompts[c.id] ?? []).filter((t) => /The application restarted/.test(t)).length, 0, 'no restart prompt: no turn was interrupted')
  assert.ok(!(L.prompts[c.id] ?? []).includes('continue'), 'and no extra continuation')
})

test('message — already taken off the queue (the in-flight marker): not sent again; the interrupted turn resumes with the restart prompt', async () => {
  const c = start({ needFix: 1 })
  const got = imageAt(c, 'onPrompt', (text) => text.startsWith('gurt review loop — round'))
  c.begin()
  await until(() => got.image, 'the findings message reached the agent')
  // The marker and the interrupted flag are what the disk holds for it.
  const rec = JSON.parse(fs.readFileSync(path.join(got.image, ws, c.task, 'sessions.json'), 'utf8')).find((r) => r.info.id === c.id)
  assert.equal(rec.interrupted, true)
  assert.match(rec.loopRan, new RegExp(`^${c.id}\\.`))
  assert.deepEqual(rec.pending ?? [], [])
  const L = await reboot(c, got.image)
  const end = await ended(L, c)
  assert.equal(end.outcome, 'ready', JSON.stringify(end))
  assert.equal(findingsMessages(L, c).length, 0, 'the message that may have reached the agent is not resent')
  assert.equal((L.prompts[c.id] ?? []).filter((t) => /The application restarted/.test(t)).length, 1, 'resumed by the controller, no human')
  assert.equal(L.kernel.sessions.interruptedSessions().length, 0, 'and left out of the Resume-sessions modal')
})

test('message in flight at the crash, a writer queued on the clone before it: the interrupted turn resumes, not behind that writer; the writer starts when the loop ends', async () => {
  const c = start({ needFix: 1 })
  const got = imageAt(c, 'onPrompt', (text) => text.startsWith('gurt review loop — round'))
  c.begin()
  await until(() => got.image, 'the findings message reached the agent')
  // Queued before the crash, so FIFO by clone (d1fb01e) puts it ahead of the
  // restart prompt the controller queues at boot; only the loop hold (§5.5)
  // keeps it from starting.
  const file = path.join(got.image, ws, c.task, 'sessions.json')
  const recs = JSON.parse(fs.readFileSync(file, 'utf8'))
  const rival = `q${process.pid}`
  recs.push({
    info: {
      id: rival, env: 'dev', role: 'executor', repos: ['alpha'], repoModes: { alpha: 'write' }, task: c.task, workspace: ws,
      title: 'rival', agent: 'a1', state: 'queued', queuedAt: new Date(Date.now() - 60_000).toISOString(), mcp: [], startPrompt: 'x'
    },
    acpSessionId: 'acp-rival'
  })
  fs.writeFileSync(file, JSON.stringify(recs))
  const L = await reboot(c, got.image, {
    realSchedule: true,
    prepare: (L) => {
      // The resumed fix answers the finding and leaves the tree as reviewed: the
      // loop ends `no-progress`, with no second reviewer to start.
      L.inst.agent(c.id, (n, text) => {
        ;(L.prompts[c.id] ??= []).push(text)
        const replies = L.kernel.reviewLoop.openFindings(c.id).map((findingId) => ({ findingId, resolution: 'declined', note: 'as is' }))
        L.kernel.sessions['onComplete'](c.id, proposal('feat: first', { replies }))
      })
    }
  })
  await until(() => (L.prompts[c.id] ?? []).some((t) => /The application restarted/.test(t)), 'the interrupted turn resumed')
  const end = await ended(L, c)
  assert.equal(end.reason, 'no-progress', JSON.stringify(end))
  assert.equal(findingsMessages(L, c).length, 0, 'the message in flight is not resent')
  assert.equal((L.prompts[c.id] ?? []).length, 1, 'one restart prompt, nothing else')
  await until(() => L.kernel.sessions.sessionInfo(rival)?.state !== 'queued', 'the writer starts once the loop let go')
})

// ================================================================= reviewer ===
test('reviewer — before it is created (intent only): created once', async () => {
  const c = start()
  const got = imageAt(c, 'beforeCreate')
  c.begin()
  await until(() => got.image, 'beforeCreate')
  const L = await reboot(c, got.image)
  const end = await ended(L, c)
  assert.equal(end.outcome, 'ready', JSON.stringify(end))
  assert.equal(reviewersIn(L, c).length, 1)
  assert.equal(L.enq.length, 1)
})

test('reviewer — created and persisted, not enqueued (restored as a draft): adopted and enqueued again, not duplicated', async () => {
  const c = start()
  const got = imageAt(c, 'beforeEnqueue')
  c.begin()
  await until(() => got.image, 'beforeEnqueue')
  const L = await reboot(c, got.image)
  const end = await ended(L, c)
  assert.equal(end.outcome, 'ready', JSON.stringify(end))
  const made = reviewersIn(L, c)
  assert.equal(made.length, 1, 'adopted by reviewOf.intent, not created twice')
  assert.deepEqual(L.enq, [made[0].id])
  assert.match(made[0].reviewOf.intent, new RegExp(`^${c.id}\\.`))
})

test('reviewer — the start bound restarts at boot; the down time does not count against it', async () => {
  const c = start({ startMode: 'never' })
  const got = imageAt(c, 'beforeEnqueue')
  c.begin()
  await until(() => got.image, 'beforeEnqueue')
  nowMs += 60 * 60_000 // the app was down for an hour: inside the 120 min deadline
  const L = await reboot(c, got.image, { prepare: (L) => (L.startMode = 'never') })
  await L.kernel.reviewLoop.idle()
  L.kernel.reviewLoop.tick()
  assert.equal(stateOf(L, c).phase, 'reviewing', 'an hour after it was created, but the bound starts at the boot')
  nowMs += 16 * 60_000
  L.kernel.reviewLoop.tick()
  const end = await ended(L, c)
  assert.equal(end.reason, 'reviewer-unavailable')
  assert.equal(reviewersIn(L, c).length, 0, 'deleted')
})

// ==================================================================== check ===
for (const [point, hookName] of [['before its effect', 'onExec'], ['before its outcome', 'onExecExit']]) {
  test(`check — ${point}: reruns, once more, and the loop goes on`, async () => {
    const c = start()
    const got = imageAt(c, hookName)
    c.begin()
    await until(() => got.image, hookName)
    const L = await reboot(c, got.image)
    const end = await ended(L, c)
    assert.equal(end.outcome, 'ready', JSON.stringify(end))
    assert.equal(L.execs.filter((s) => s === c.id).length, 1, 'rerun in the second life')
    assert.equal(reviewersIn(L, c).length, 1)
  })
}

test('check — a leftover check (intent `check` at boot) stops the executor\'s container, then the check reruns', async () => {
  const c = start({ repos: ['slow'] })
  const got = imageAt(c, 'onExec')
  c.begin()
  await until(() => got.image && fs.existsSync(path.join(dirOf(A, c), 'runs.log')), 'the first check is running')
  // What was stopped when the second life's check started: its container, first (§5.3).
  const stopsAtRerun = []
  const L = await reboot(c, got.image, {
    prepare: (L) => (L.hooks[c.id] = { onExec: (L) => stopsAtRerun.push(L.inst.stops.map((x) => x.id)) })
  })
  await until(() => fs.existsSync(path.join(dirOf(L, c), 'runs.log')), 'the rerun started')
  assert.deepEqual(stopsAtRerun, [[c.id]], 'the executor\'s container was stopped before the rerun, once')
  assert.equal(fs.readFileSync(path.join(dirOf(L, c), 'runs.log'), 'utf8').split('\n').filter(Boolean).length, 1, 'one run in the second life’s clone')
  assert.equal(stateOf(L, c).phase, 'checking')
  await L.kernel.reviewLoop.stopLoop(c.id)
  const end = await ended(L, c)
  assert.equal(end.reason, 'cancelled')
})

// ==================================================================== delivery ===
/** Wait until a gated hook has been reached in the dead kernel, then take the image. */
async function frozenAt(c, hookFile) {
  await until(() => fs.existsSync(path.join(c.gate, `reached-${hookFile}`)), `the ${hookFile} hook was reached`)
  return h.image()
}
/** Let the dead kernel's blocked hook go (it exits 1, so it commits and pushes nothing more
 *  of consequence) — the runner does not end the file while a child still runs. */
const release = (c) => {
  fs.writeFileSync(path.join(c.gate, 'go'), '')
  delete process.env.GATE_COMMIT
}
const commitsOver = (L, c) => Number(git(dirOf(L, c), 'rev-list', '--count', `${c.fx.bases.alpha}..HEAD`))

test('deliver commit — before its effect (the commit is held before it runs): committed once, then pushed once', async () => {
  const c = start({ whenClean: 'push', gated: ['pre-commit'] })
  c.begin()
  try {
    const image = await frozenAt(c, 'pre-commit')
    const L = await reboot(c, image)
    const end = await ended(L, c)
    assert.equal(end.outcome, 'ready', JSON.stringify(end))
    assert.deepEqual(end.delivered.map((d) => d.step), ['commit', 'push'])
    assert.equal(commitsOver(L, c), 1)
    assert.equal(received(c.fx.remotes.alpha), 1)
  } finally {
    release(c)
  }
})

test('deliver commit — before its outcome (committed, not recorded): found by HEAD, not committed twice', async () => {
  const c = start({ whenClean: 'push', gated: ['post-commit'] })
  c.begin()
  try {
    const image = await frozenAt(c, 'post-commit')
    const L = await reboot(c, image)
    const end = await ended(L, c)
    assert.equal(end.outcome, 'ready', JSON.stringify(end))
    assert.equal(end.delivered[0].note, 'already committed')
    assert.equal(commitsOver(L, c), 1, 'one commit, not two')
    assert.equal(received(c.fx.remotes.alpha), 1)
    assert.equal(git(c.fx.remotes.alpha, 'rev-parse', c.task), git(dirOf(L, c), 'rev-parse', 'HEAD'))
  } finally {
    release(c)
  }
})

test('deliver push — pushed, and the remote advanced before the boot: reported, not pushed again', async () => {
  const c = start({ whenClean: 'push', gated: ['post-receive'] })
  c.begin()
  try {
    const image = await frozenAt(c, 'post-receive') // the origin has our commit; the pusher has not heard
    assert.equal(received(c.fx.remotes.alpha), 1)
    const other = path.join(scratch, `other-${c.id}`)
    const quiet = { ...process.env, GATE_DIR: '' }
    execFileSync('git', ['clone', '-q', c.fx.remotes.alpha, other], { env: quiet })
    git(other, 'checkout', '-q', c.task)
    write(other, 'someone.txt', 'else\n')
    git(other, 'add', '-A')
    execFileSync('git', ['-C', other, 'commit', '-q', '-m', 'someone else'], { env: quiet })
    execFileSync('git', ['-C', other, 'push', '-q', 'origin', c.task], { env: quiet })
    const advanced = git(c.fx.remotes.alpha, 'rev-parse', c.task)
    const L = await reboot(c, image)
    const end = await ended(L, c)
    assert.equal(end.outcome, 'ready', JSON.stringify(end))
    assert.match(end.delivered[1].note, /advanced/)
    assert.equal(received(c.fx.remotes.alpha), 2, 'our push and the other one — never a third')
    assert.equal(git(c.fx.remotes.alpha, 'rev-parse', c.task), advanced)
    assert.match(L.notifs.find((n) => n.sessionId === c.id).detail, /advanced/)
  } finally {
    release(c)
  }
})

// ======================================================================= end ===
test('end — before the notification: notified once in the second life, hold released', async () => {
  const c = start()
  const got = imageAt(c, 'atEnd')
  c.begin()
  await until(() => got.image, 'atEnd')
  const disk = JSON.parse(fs.readFileSync(path.join(got.image, ws, c.task, 'review-loop.json'), 'utf8'))[c.id]
  assert.equal(disk.phase, 'ended')
  assert.equal(disk.notified, undefined)
  assert.equal(disk.intents.at(-1).kind, 'end')
  const L = await reboot(c, got.image)
  await ended(L, c)
  assert.equal(got.notices + endNotices(L, c).length, 1, 'exactly one observed end across the crash boundary')
  assert.deepEqual(notifsOf(L, c).map((n) => n.type), ['proposal'])
  assert.equal(L.kernel.sessions.isLoopHeld(c.id), false)
  assert.deepEqual(stateOf(L, c).intents, [])
})

test('end — crash after emission before its mark: re-announced into the fresh ring', async () => {
  const c = start()
  const got = imageAt(c, 'onNotice')
  c.begin()
  await until(() => got.image, 'onNotice')
  const disk = JSON.parse(fs.readFileSync(path.join(got.image, ws, c.task, 'review-loop.json'), 'utf8'))[c.id]
  assert.ok(!disk.notified, 'emission precedes the durable mark')
  assert.equal(got.notices, 1, 'the old ring observed the emission before the crash')
  const L = await reboot(c, got.image)
  await ended(L, c)
  assert.equal(endNotices(L, c).length, 1)
  assert.equal(notifsOf(L, c).length, 1, 'only one visible entry in the fresh in-memory ring')
  assert.equal(L.kernel.sessions.isLoopHeld(c.id), false, 'the hold is released all the same')
  assert.deepEqual(stateOf(L, c).intents, [])
})

test('end — long finished: nothing at boot, and the session notifies as any other', async () => {
  const c = start()
  c.begin()
  await ended(A, c)
  await h.tick(100)
  const L = await reboot(c, h.image())
  assert.equal(stateOf(L, c).phase, 'ended')
  assert.equal(L.notices.length, 0)
  assert.equal(L.kernel.reviewLoop.notifiesThrough(c.id), false)
  assert.equal(L.kernel.reviewLoop.owns(c.id), false)
  L.kernel.bus.emit('session.turn', { sessionId: c.id, ref: h.ref, phase: 'started' })
  L.kernel.bus.emit('session.turn', { sessionId: c.id, ref: h.ref, phase: 'ended', final: true })
  assert.deepEqual(notifsOf(L, c).map((n) => n.type), [], 'turn-ended is off by default, but no longer swallowed: nothing is pending for the loop')
})

// ================================================================== deadline ===
test('the deadline counts the time the app was down: time-cap at boot, once, nothing started', async () => {
  const c = start()
  const got = imageAt(c, 'onSettled', (sid) => sid === c.id)
  c.begin()
  await until(() => got.image, 'the arming settle')
  nowMs += 121 * 60_000
  const L = await reboot(c, got.image)
  const end = await ended(L, c)
  assert.equal(end.outcome, 'needs-you')
  assert.equal(end.reason, 'time-cap')
  assert.equal(L.enq.length, 0, 'no reviewer for a loop past its deadline')
  assert.equal(endNotices(L, c).length, 1)
  assert.deepEqual(notifsOf(L, c).map((n) => n.type), ['awaiting'])
  nowMs -= 121 * 60_000
})

test('a reviewer of a loop that expired while down is deleted at boot', async () => {
  const c = start({ startMode: 'never' })
  const got = imageAt(c, 'beforeEnqueue')
  c.begin()
  await until(() => got.image, 'beforeEnqueue')
  nowMs += 121 * 60_000
  const L = await reboot(c, got.image, { prepare: (L) => (L.startMode = 'never') })
  const end = await ended(L, c)
  assert.equal(end.reason, 'time-cap')
  assert.equal(reviewersIn(L, c).length, 0)
  assert.equal(L.enq.length, 0)
  nowMs -= 121 * 60_000
})

// ================================================================== holds ===
test('the hold is in place before the scheduler’s first pass: a queued writer does not take the clone', async () => {
  const c = start({ repos: ['slow'] })
  const got = imageAt(c, 'onExec')
  c.begin()
  await until(() => got.image, 'the check started')
  // The executor's container is down in the image, and a writer of the same
  // clone waits in the queue: only the hold keeps it from starting.
  const file = path.join(got.image, ws, c.task, 'sessions.json')
  const recs = JSON.parse(fs.readFileSync(file, 'utf8'))
  recs.find((r) => r.info.id === c.id).info.container.status = 'stopped'
  recs.push({
    info: {
      id: `w${process.pid}`, env: 'dev', role: 'executor', repos: ['slow'], repoModes: { slow: 'write' }, task: c.task, workspace: ws,
      title: 'rival', agent: 'a1', state: 'queued', queuedAt: new Date().toISOString(), mcp: [], startPrompt: 'x'
    },
    acpSessionId: 'acp-rival'
  })
  fs.writeFileSync(file, JSON.stringify(recs))
  const L = await reboot(c, got.image, { realSchedule: true })
  await h.tick(300)
  assert.equal(L.kernel.sessions.isLoopHeld(c.id), true)
  assert.equal(L.kernel.sessions.sessionInfo(`w${process.pid}`).state, 'queued', 'the clone is the loop’s')
  await L.kernel.reviewLoop.stopLoop(c.id)
  await ended(L, c)
})

// ============================================================ resume failure ===
test('a resume that cannot load the agent’s session ends `executor-error` (a recreated container for a kind without history)', async () => {
  const c = start({ needFix: 1 })
  const got = imageAt(c, 'onPrompt', (text) => text.startsWith('gurt review loop — round'))
  c.begin()
  await until(() => got.image, 'the findings message was running')
  const L = await reboot(c, got.image, {
    prepare: (L) => {
      // `attachUncoalesced`: session/load fails, "could not resume" is pushed and thrown.
      L.kernel.sessions.attach = async () => {
        throw new Error('could not resume (session not found)')
      }
    }
  })
  const end = await ended(L, c)
  assert.equal(end.outcome, 'needs-you')
  assert.equal(end.reason, 'executor-error')
  assert.equal(L.enq.length, 0)
})

for (const rung of ['push', 'pr']) test(`deleted executor after commit recovers ${rung} exactly once`, async () => {
  const shim = path.join(scratch, 'bin')
  fs.mkdirSync(shim, { recursive: true })
  const prLog = path.join(scratch, `pr-${rung}.log`)
  fs.writeFileSync(path.join(shim, 'gh'), `#!/bin/sh
if [ "$2" = view ]; then echo 'no pull requests found' >&2; exit 1; fi
echo create >> '${prLog}'
echo https://github.com/o/alpha/pull/1
`, { mode: 0o755 })
  process.env.PATH = `${shim}:${process.env.PATH}`
  const c = start({ whenClean: rung, gated: ['post-commit'] })
  c.begin()
  try {
    await frozenAt(c, 'post-commit')
    A.kernel.sessions.deleteSession(c.id)
    await until(() => !JSON.parse(fs.readFileSync(path.join(h.GURT_ROOT, ws, c.task, 'sessions.json'), 'utf8')).some((r) => r.info.id === c.id), 'executor deletion persisted')
    const image = h.image()
    const file = path.join(image, ws, c.task, 'sessions.json')
    assert.ok(!JSON.parse(fs.readFileSync(file, 'utf8')).some((r) => r.info.id === c.id))
    const L = await reboot(c, image)
    await L.kernel.reviewLoop.idle()
    assert.equal(endNotices(L, c).length, 1, 'deleted executor recovery notifies')
    const end = endNotices(L, c)[0].notice.end
    assert.equal(end.outcome, 'ready', JSON.stringify(end))
    assert.deepEqual(end.delivered.map((d) => d.step), rung === 'pr' ? ['commit', 'push', 'pr'] : ['commit', 'push'])
    assert.equal(commitsOver(L, c), 1)
    assert.equal(received(c.fx.remotes.alpha), 1)
    assert.equal(endNotices(L, c).length, 1)
    if (rung === 'pr') assert.equal(fs.readFileSync(prLog, 'utf8').trim(), 'create')
  } finally { release(c) }
})

for (const damage of ['syntax', 'shape', 'nested', 'orphan-syntax']) {
  test(`unreadable loop state (${damage}) fails closed and never replays lastSettled`, async () => {
    const c = start()
    const got = imageAt(c, 'atEnd')
    c.begin()
    await until(() => got.image, 'atEnd')
    const file = path.join(got.image, ws, c.task, 'review-loop.json')
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (damage === 'nested') raw[c.id].consumed = []
    const bytes = damage.endsWith('syntax') ? '{broken' : damage === 'shape' ? JSON.stringify({ [c.id]: {} }) : JSON.stringify(raw)
    fs.writeFileSync(file, bytes)
    if (damage === 'orphan-syntax') {
      fs.writeFileSync(path.join(path.dirname(file), 'sessions.json'), '[]')
      c.id = `unreadable:${ws}:${c.task}`
    }
    const L = await reboot(c, got.image)
    await ended(L, c)
    assert.equal(stateOf(L, c).end.outcome, 'failed')
    assert.equal(stateOf(L, c).end.error, 'state-unreadable')
    assert.equal(L.kernel.sessions.isLoopHeld(c.id), true)
    assert.equal(L.enq.length, 0, 'no new reviewer or reconstructed round')
    assert.equal(endNotices(L, c).length, 1)
    const quarantined = fs.readdirSync(path.dirname(file)).find((n) => n.startsWith('review-loop.json.corrupt-'))
    assert.ok(quarantined)
    assert.equal(fs.readFileSync(path.join(path.dirname(file), quarantined), 'utf8'), bytes)
    L.kernel.reviewLoop.tick()
    await L.kernel.reviewLoop.idle()
    assert.equal(endNotices(L, c).length, 1, 'idempotent end tail')
    assert.equal(L.kernel.sessions.isLoopHeld(c.id), true)
  })
}
