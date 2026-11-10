// The review loop's hold on its executor, and the reviewer's cap exemption
// (docs/requirements-review-loop.md §5.4, §5.5, §12 item 4) — the session
// manager's side only, driven through the hold API directly; the controller that
// will call it is a later slice.
//
//   - the hold is in place before `session.turn` `ended`, so the queue handoff
//     never stops the container of a turn the loop has not classified — the
//     nudge turn's own boundary included;
//   - a held executor keeps its clone with its container down, and costs no cap
//     slot while it is down;
//   - the reviewer starts while the executor holds `write`, under a scope cap of
//     1, and never makes the handoff reap its executor for a slot;
//   - after the release the idle timer is re-armed and the writer starts.
//
// No docker and no agent process: a fake `session/prompt` runs the turns; every
// real start fails fast at provisioning, which is the proof it got past the gate.
//
//   node scripts/review-loop-queue.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loopHarness, gate } from './lib/loop-harness.mjs'

const h = await loopHarness('review-loop-queue', {
  agents: {
    a1: { kind: 'claude-code', label: 'executor' },
    a2: { kind: 'claude-code', label: 'reviewer', credentialId: 'c2' }
  }
})
const { kernel, ref, stops, started, container, agent, tick, until } = h
after(() => h.cleanup())

const block = { agent: 'a2', maxRounds: 2, whenClean: 'notify', draftPr: true }
const state = (id) => kernel.sessions.snapshot(id).info.state
const queueWriter = (repo) =>
  kernel.sessions.createSession(ref, [repo], 'a1', 'w', 'queue', [], true, {}, 'executor', undefined, undefined, {
    [repo]: 'write'
  })
const turnEvents = []
kernel.bus.on('session.turn', (e) => turnEvents.push(e))
const ended = (id, final) => turnEvents.some((e) => e.sessionId === id && e.phase === 'ended' && e.final === final)

/** A two-turn script: the first ends without `complete` (→ nudge), the second
 *  completes. The gates let a test act while a turn is in flight. */
function nudgedAgent(id) {
  const g = { first: gate(), second: gate(), inFirst: gate(), inSecond: gate() }
  agent(id, async (n) => {
    if (n === 1) {
      g.inFirst.open()
      await g.first
    } else {
      g.inSecond.open()
      await g.second
      kernel.sessions['onComplete'](id, { version: 1, outcome: 'no_changes' })
    }
    return {}
  })
  return g
}

// --- control: without the hold the same scenario IS handed off ---------------
test('control: an unheld executor is reaped for a writer queued during its turn', async () => {
  started('e0', ['beta'])
  const g = nudgedAgent('e0')
  await kernel.sessions.prompt('e0', 'go')
  await g.inFirst
  queueWriter('beta')
  await tick()
  assert.deepEqual(stops, [], 'a busy executor is never reaped')
  g.first.open()
  await g.inSecond
  g.second.open()
  await until(() => ended('e0', true), 'e0 final turn end')
  await tick()
  assert.deepEqual(stops, [{ id: 'e0', reason: 'queue' }], 'the handoff stops it')
  stops.length = 0
})

// --- the hold is placed at `started`, ahead of every `ended` ----------------
test('a held executor is not handed off at the turn end, nor at its nudge’s', async () => {
  // No `review` yet: the real controller (a bus subscriber of every kernel) would
  // otherwise take this executor into a loop of its own; the block is set where the
  // reviewer is created, below.
  started('e1', ['alpha'], { title: 'E1' })
  // What the controller does: take the hold when the executor's turn starts.
  const off = kernel.bus.on('session.turn', ({ sessionId, phase }) => {
    if (sessionId === 'e1' && phase === 'started') kernel.sessions.holdForLoop('e1')
  })
  const g = nudgedAgent('e1')
  await kernel.sessions.prompt('e1', 'go')
  await g.inFirst
  assert.equal(kernel.sessions.isLoopHeld('e1'), true, 'held before the first turn can end')
  const w = queueWriter('alpha')
  await tick()
  assert.equal(state(w.id), 'queued')
  assert.deepEqual(stops, [])

  g.first.open() // turn 1 ends without `complete` → emits ended{final:false}, then the nudge
  await g.inSecond
  assert.ok(ended('e1', false), 'the nudge’s boundary was emitted')
  await tick()
  assert.deepEqual(stops, [], 'no handoff at the nudge turn’s boundary')
  g.second.open()
  await until(() => ended('e1', true), 'e1 final turn end')
  await tick()
  assert.deepEqual(stops, [], 'none at the user-visible end either')
  assert.equal(kernel.sessions.snapshot('e1').info.container.status, 'running')
  assert.equal(state(w.id), 'queued', 'and the writer waits')
  assert.deepEqual(kernel.sessions.holdersBlockingQueue(), [], 'a held executor is never listed')
  off()
})

test('a held executor keeps its clone with its container down; the cap does not count it', async () => {
  const w = [...kernel.sessions.allSessions()].find((i) => i.state === 'queued')
  container('e1', 'stopped')
  kernel.sessions.schedule()
  await tick()
  assert.equal(state(w.id), 'queued', 'the writer cannot take a held clone')
  assert.equal(kernel.sessions.repoHolderFor('w', 't', 'alpha')?.id, 'e1', 'it is the holder')
  const ghost = started('g1', ['beta'], {}, { up: false })
  assert.equal(kernel.sessions.repoHolderFor('w', 't', 'beta'), undefined, 'an unheld stopped one holds nothing')
  void ghost
  // Cap 1: the held, stopped executor takes no slot, so a reader runs.
  kernel.sessions.setTaskCap('w', 't', 1)
  const r = kernel.sessions.createSession(ref, ['beta'], 'a1', 'r', 'queue', [], true, {}, 'researcher', undefined, undefined, {
    beta: 'read'
  })
  await until(() => state(r.id) !== 'queued', 'reader past the cap')
  kernel.sessions.setTaskCap('w', 't', undefined)
  container('e1', 'running')
})

// --- the reviewer ------------------------------------------------------------
test('the reviewer starts while the executor holds write, under a cap of 1', async () => {
  kernel.sessions.setTaskCap('w', 't', 1)
  // The reader above and the executor are not running: e1 alone is active.
  const plain = kernel.sessions.createSession(ref, ['beta'], 'a1', 'p', 'queue', [], true, {}, 'researcher', undefined, undefined, {
    beta: 'read'
  })
  await tick()
  assert.equal(state(plain.id), 'queued', 'an ordinary session waits for the slot (control)')

  const ex = kernel.sessions.sessionInfo('e1')
  ex.review = block
  ex.mcp = [
    { id: 'github', mode: 'full' },
    { id: 'registry-entry', mode: 'full' }
  ]
  // "Persisted before it is enqueued": the file already names the intent when
  // `enqueue` runs.
  let seenAtEnqueue
  const enqueue = kernel.sessions.enqueue.bind(kernel.sessions)
  kernel.sessions.enqueue = (id) => {
    const rows = JSON.parse(fs.readFileSync(path.join(h.GURT_ROOT, 'w', 't', 'sessions.json'), 'utf8'))
    seenAtEnqueue = rows.find((r) => r.info.id === id)?.info.reviewOf
    return enqueue(id)
  }
  const rv = await kernel.sessions.createReviewer('e1', { round: 1, intent: 'e1.3', prompt: 'review this' })
  kernel.sessions.enqueue = enqueue
  assert.deepEqual(seenAtEnqueue, { executor: 'e1', round: 1, intent: 'e1.3' })
  await until(() => state(rv.id) !== 'queued', 'reviewer past the cap')
  const info = kernel.sessions.sessionInfo(rv.id)
  assert.doesNotMatch(kernel.sessions.snapshot(rv.id).startError ?? '', /in use by session/, 'and past the clone gate')
  assert.equal(info.role, 'reviewer')
  assert.equal(info.title, 'review 1 — E1')
  assert.equal(info.agent, 'a2', 'the block’s agent')
  assert.deepEqual(info.repos, ['alpha'])
  assert.deepEqual(info.repoModes, { alpha: 'read' }, 'the executor’s repos, all read')
  assert.deepEqual(
    info.mcp,
    [
      { id: 'github', mode: 'read-only' },
      { id: 'registry-entry', mode: 'full' }
    ],
    'every built-in capped at read-only'
  )
  assert.equal(info.startPrompt, 'review this')
  assert.equal(state(plain.id), 'queued', 'the exemption is the reviewer’s alone')
  assert.deepEqual(stops, [], 'and the executor was not reaped for it')
  await assert.rejects(kernel.sessions.createReviewer('nope', { round: 1, intent: 'x', prompt: 'p' }), /unknown session/)
  await assert.rejects(kernel.sessions.createReviewer('g1', { round: 1, intent: 'x', prompt: 'p' }), /not in a review loop/)
  kernel.sessions.deleteSession(plain.id)
  kernel.sessions.setTaskCap('w', 't', undefined)
})

test('a queued reviewer never makes the handoff reap for a slot; it still reads a plan hold', async () => {
  // An unheld idle executor on a capped scope, a reviewer queued behind its
  // account’s plan hold: nothing waits for a slot, so nothing is reaped.
  kernel.sessions.releaseLoopHold('e1') // (API only: no idle handling, no schedule)
  for (const i of kernel.sessions.allSessions()) if (i.state === 'queued') kernel.sessions.deleteSession(i.id)
  stops.length = 0
  container('e1', 'running')
  kernel.sessions.setTaskCap('w', 't', 1)
  kernel.bus.emit('agent.planUsage', {
    agent: 'a2',
    windows: [
      { id: 'five_hour', label: 'Current session', utilization: 97, raw: 0.97, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }
    ]
  })
  const rv = await kernel.sessions.createReviewer('e1', { round: 2, intent: 'e1.9', prompt: 'again' })
  await tick()
  assert.equal(state(rv.id), 'queued', 'held by the plan, not by the cap')
  assert.ok(kernel.sessions.planHoldOf(rv.id)?.until, 'planHoldOf reads the hold')
  assert.equal(kernel.sessions.planHoldOf('nope'), undefined)
  assert.deepEqual(kernel.sessions.holdersBlockingQueue(), [], 'a reviewer’s slot is nobody’s to hand off')
  assert.deepEqual(stops, [])
  // Control: an ordinary session queued behind the same cap does reap it.
  kernel.sessions.createSession(ref, ['beta'], 'a1', 'p', 'queue', [], true, {}, 'researcher', undefined, undefined, { beta: 'read' })
  await tick()
  assert.deepEqual(stops, [{ id: 'e1', reason: 'queue' }])
  kernel.sessions.setTaskCap('w', 't', undefined)
})

// --- release -------------------------------------------------------------------
test('releasing the hold re-arms the idle timer and lets the writer start', async () => {
  for (const i of kernel.sessions.allSessions()) if (i.state === 'queued') kernel.sessions.deleteSession(i.id)
  stops.length = 0
  started('e2', ['alpha'], { review: block })
  kernel.sessions.holdForLoop('e2')
  const w = queueWriter('alpha')
  await tick()
  assert.equal(state(w.id), 'queued')
  assert.deepEqual(stops, [], 'held: the handoff leaves it be')
  // The controller’s keep-alive pings cancelled the idle timer; the release must
  // arm it again, before the queue handoff.
  const calls = []
  const noteIdle = kernel.containers.noteIdle.bind(kernel.containers)
  kernel.containers.noteIdle = (id) => (calls.push(['noteIdle', id]), noteIdle(id))
  const stop = kernel.containers.stop
  kernel.containers.stop = async (id, reason) => (calls.push(['stop', id, reason]), stop(id, reason))
  assert.equal(kernel.releaseLoopHold('e2'), true)
  assert.equal(kernel.sessions.isLoopHeld('e2'), false)
  await until(() => state(w.id) !== 'queued', 'writer start')
  assert.deepEqual(calls[0], ['noteIdle', 'e2'], 'the idle timer is re-armed first')
  assert.deepEqual(calls[1], ['stop', 'e2', 'queue'], 'then the queue handoff frees the clone')
  assert.equal(kernel.releaseLoopHold('e2'), false, 'a second release is a no-op')
})

test('a deleted executor retains its reservation until the controller releases it', async () => {
  started('e3', ['beta'])
  kernel.sessions.holdForLoop('e3')
  const w = queueWriter('beta')
  kernel.sessions.deleteSession('e3')
  await tick()
  assert.equal(kernel.sessions.isLoopHeld('e3'), true)
  assert.equal(state(w.id), 'queued')
  kernel.releaseLoopHold('e3')
  await until(() => state(w.id) !== 'queued', 'writer after controller release')
})
