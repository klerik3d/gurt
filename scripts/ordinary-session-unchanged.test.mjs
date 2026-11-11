// Fix 1 of the review loop's execute-review round (docs/requirements-review-
// loop.md §13, "Fixes"): a session WITHOUT a loop (`info.review` and
// `info.reviewOf` both absent) behaves exactly as it did on main — same awaits,
// same bus events in the same order, same number of persistence writes, no
// `session.settled`, no `session.human`. The loop's machinery is for loop
// sessions only; this file pins the ordinary side, and the three loop-side rules
// that came with it:
//
//   1. a scripted ordinary session (normal turn, nudge, plan-hold limit, thrown
//      turn, incomplete) emits the explicit pre-loop event lists and writes
//      sessions.json the explicit pre-loop number of times;
//   2. `session.human` — prompt, clearPending, cancelPending, user cancel — is
//      silent for it, and still the loop sessions' (scripts/host-prompt.test.mjs);
//   3. the delivery gate holds the delivering executor and sessions whose clone
//      claims overlap its own, nobody else of the task;
//   4. a contract tool call is filed into a loop turn only inside a busy
//      round-trip: not while the next prompt is being masked, not between a turn
//      and its nudge — and the logical turn survives the nudge.
//
//   node scripts/ordinary-session-unchanged.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loopHarness, gate } from './lib/loop-harness.mjs'

const h = await loopHarness('ordinary-unchanged')
const { kernel, started, agent, tick, until } = h
after(() => h.cleanup())
const sm = kernel.sessions
const rowOf = (id) =>
  JSON.parse(fs.readFileSync(path.join(h.GURT_ROOT, 'w', 't', 'sessions.json'), 'utf8')).find((r) => r.info.id === id)

/** Every bus event, in order, as a compact label; each persistence write of
 *  sessions.json is `persist` in the same list. */
const trace = []
const label = (type, p) =>
  type === 'session.turn' ? `${type}:${p.phase}${p.final === undefined ? '' : p.final ? ':final' : ':nonfinal'}` : type
const emit = kernel.bus.emit
kernel.bus.emit = (type, payload) => {
  trace.push(label(type, payload))
  return emit(type, payload)
}
const persist = sm['events'].persist
sm['events'].persist = (...args) => {
  trace.push('persist')
  return persist(...args)
}
/** Run `go`, wait for the session to be fully idle and the debounced write to
 *  have fired, and return what the bus and the store saw. */
async function traced(id, go) {
  trace.length = 0
  await go()
  const live = sm['sessions'].get(id)
  await until(() => !live.promptRunning && !live.draining && !live.busy, `${id} idle`)
  await tick(450) // the 300ms debounced write
  return [...trace]
}

// A loop session to the session manager (`isLoopSession`), inert for the
// controller: a `reviewOf` naming an executor that has no loop.
const LOOP_MARK = { executor: 'nobody', round: 1, intent: 'nobody.1' }
const ordinary = (id, extra = {}) => started(id, ['alpha'], { repoModes: { alpha: 'read' }, ...extra })
const changes = { version: 1, outcome: 'changes', commit: { subject: 'fix' } }

// The lists below were captured from main's `sessions.ts` (HEAD of the work
// order, in a worktree) and must stay exactly that: `persist` is one write of
// sessions.json — the one `prompt` makes, the pair every round-trip makes
// around its prompt, the debounced one at the end. A loop session's extra write
// and `session.settled` are not among them. Recaptured on the rebase onto main
// 98ac9fa (d1fb01e's scheduler): the plan-held n3's queue now reports its wait
// once (`noteQueued`, the extra `session.changed` in its own list) instead of
// emitting from a drain on every later pass (the `session.changed` that n4's
// and n5's lists no longer have before their final turn end).
const RT_START = ['session.activity', 'session.log', 'session.changed', 'session.changed', 'session.turn:started', 'persist']

test('a normal turn: the pre-loop events and writes, nothing more', async () => {
  ordinary('n1')
  agent('n1', async () => (sm['onComplete']('n1', changes), {}))
  const t = await traced('n1', () => sm.prompt('n1', 'go'))
  assert.deepEqual(t, [
    'persist',
    ...RT_START,
    'session.log', 'session.changed', 'session.proposal', 'notification.created', 'persist',
    'session.changed', 'agent.turn', 'usage.changed', 'session.turn:ended:final',
    'session.changed', 'persist'
  ])
  // Nothing durable about the turn either.
  assert.equal(sm.lastSettledOf('n1'), undefined)
  assert.equal(rowOf('n1').lastSettled, undefined)
})

test('a nudged turn: two round-trips, no settle in between or after', async () => {
  ordinary('n2')
  agent('n2', async (n) => (n === 2 ? (sm['onComplete']('n2', { version: 1, outcome: 'no_changes' }), {}) : {}))
  const t = await traced('n2', () => sm.prompt('n2', 'go'))
  assert.deepEqual(t, [
    'persist',
    ...RT_START, 'persist',
    'session.changed', 'agent.turn', 'usage.changed', 'session.turn:ended:nonfinal',
    ...RT_START.slice(0, 5), 'persist',
    'session.log', 'session.changed', 'persist',
    'session.changed', 'agent.turn', 'usage.changed', 'session.turn:ended:final',
    'session.changed', 'persist'
  ])
})

test('a plan-hold limit', async () => {
  ordinary('n3', { agent: 'a9' })
  agent('n3', async () => {
    throw new Error('429 too many requests — limit will reset in 2 hours')
  })
  const t = await traced('n3', () => sm.prompt('n3', 'go'))
  assert.deepEqual(t, [
    'persist',
    ...RT_START,
    'session.log', 'session.changed', 'persist',
    'session.changed', 'agent.turn', 'usage.changed', 'session.turn:ended:final',
    'agent.limited', 'usage.changed', 'session.log', 'session.changed', 'session.changed', 'session.changed', 'persist'
  ])
})

test('a thrown turn', async () => {
  ordinary('n4')
  agent('n4', async () => {
    throw new Error('adapter crashed')
  })
  const t = await traced('n4', () => sm.prompt('n4', 'go'))
  assert.deepEqual(t, [
    'persist',
    ...RT_START,
    'session.log', 'session.changed', 'persist',
    'session.changed', 'agent.turn', 'usage.changed', 'session.turn:ended:final',
    'session.changed', 'persist'
  ])
})

test('an incomplete turn (no contract tool even after the nudge)', async () => {
  ordinary('n5')
  agent('n5', async () => ({}))
  const t = await traced('n5', () => sm.prompt('n5', 'go'))
  assert.deepEqual(t, [
    'persist',
    ...RT_START, 'persist',
    'session.changed', 'agent.turn', 'usage.changed', 'session.turn:ended:nonfinal',
    ...RT_START.slice(0, 5), 'persist', 'persist',
    'session.changed', 'agent.turn', 'usage.changed', 'session.turn:ended:final',
    'session.log', 'session.changed', 'session.changed', 'session.changed', 'persist'
  ])
})

// A turn whose first prompt is in flight, to stop a queue and a turn under.
test('prompt, clearPending, cancelPending and a user cancel are silent for an ordinary session', async () => {
  ordinary('n6')
  const g = gate()
  const inFlight = gate()
  agent('n6', async (n) => {
    if (n === 1) {
      inFlight.open()
      await g
    }
    sm['onComplete']('n6', { version: 1, outcome: 'no_changes' })
    return {}
  })
  const humans = []
  const off = kernel.bus.on('session.human', (e) => humans.push(e))
  await sm.prompt('n6', 'work')
  await inFlight
  await sm.prompt('n6', 'queued one')
  await sm.prompt('n6', 'queued two')
  const [first] = sm.snapshot('n6').pending
  sm.cancelPending('n6', first.id)
  sm.cancel('n6')
  sm.clearPending('n6')
  g.open()
  await until(() => !sm['sessions'].get('n6').promptRunning, 'n6 idle')
  off()
  assert.deepEqual(humans, [], 'no session.human for a session without a loop')
  // A loop session's acts are announced (the loop reads them as a takeover) —
  // the same calls, in the same order relative to their other effects.
  started('l1', ['alpha'], { reviewOf: LOOP_MARK, repoModes: { alpha: 'read' } })
  const lg = gate()
  const lin = gate()
  agent('l1', async (n) => {
    if (n === 1) {
      lin.open()
      await lg
    }
    sm['onComplete']('l1', { version: 1, outcome: 'no_changes' })
    return {}
  })
  const seen = []
  const off2 = kernel.bus.on('session.human', (e) => seen.push(`${e.sessionId}:${e.did}`))
  await sm.prompt('l1', 'work')
  await lin
  await sm.prompt('l1', 'queued')
  sm.cancel('l1')
  sm.clearPending('l1')
  lg.open()
  await until(() => !sm['sessions'].get('l1').promptRunning, 'l1 idle')
  off2()
  assert.deepEqual(seen, ['l1:prompt', 'l1:prompt', 'l1:cancel', 'l1:cancel'])
})

test('the delivery gate holds the executor and sessions sharing its clone — nobody else of the task', async () => {
  const hooks = (executors) => ({ owns: () => false, live: () => false, delivering: () => executors })
  const texts = {}
  const run = (id) => agent(id, async (n, text) => ((texts[id] ??= []).push(text), sm['onComplete'](id, { version: 1, outcome: 'no_changes' }), {}))
  // The delivering executor writes alpha; its container is down, so no session
  // is held by the clone's plain holder rule — only by the delivery gate.
  started('g1', ['alpha'], { repoModes: { alpha: 'write' } }, { up: false })
  started('g2', [], { role: 'inspector', repoModes: {} }, { up: false }) // repo-free inspector
  started('g3', ['beta'], { repoModes: { beta: 'write' } }, { up: false }) // another repo's writer
  started('g4', ['alpha'], { repoModes: { alpha: 'read-locked' } }, { up: false }) // shares g1's clone
  started('g5', ['alpha'], { repoModes: { alpha: 'read' } }, { up: false }) // reads the live tree: no claim
  for (const id of ['g1', 'g2', 'g3', 'g4', 'g5']) run(id)
  sm.setLoopHooks(hooks(['g1']))
  try {
    for (const id of ['g1', 'g2', 'g3', 'g4', 'g5']) await sm.prompt(id, `hello ${id}`)
    await until(() => texts.g2 && texts.g3 && texts.g5, 'the unrelated sessions run')
    await tick(100)
    assert.deepEqual(Object.keys(texts).sort(), ['g2', 'g3', 'g5'], 'g1 (the executor) and g4 (its clone) wait')
    assert.match(sm.snapshot('g1').pendingBlocked ?? '', /review loop is delivering/)
    assert.match(sm.snapshot('g4').pendingBlocked ?? '', /review loop is delivering/)
    for (const id of ['g2', 'g3', 'g5']) assert.equal(sm.snapshot(id).pendingBlocked, undefined, `${id} is not blocked`)
    // The delivery ends: the controller calls `schedule()`, the held ones run.
    sm.setLoopHooks(hooks([]))
    sm.schedule()
    await until(() => texts.g1 && texts.g4, 'the held sessions run after the delivery')
  } finally {
    sm.setLoopHooks(undefined)
  }
})

// --- contract artifacts only inside a busy round-trip (§5.1) ----------------

const settled = []
kernel.bus.on('session.settled', (e) => settled.push(e))
const verdict = (v = 'approve') => ({ version: 1, verdict: v, summary: 'ok', findings: [] })
const reviewer = (id) =>
  started(id, ['alpha'], { role: 'reviewer', repoModes: { alpha: 'read' }, reviewOf: { executor: 'nobody', round: 1, intent: `${id}.1` } })
const lastSettled = (id) => settled.filter((e) => e.sessionId === id).at(-1)?.turn

/** Make the outbound masking seam an `await` the test can act inside: the n-th
 *  `encode` runs `hooks[n-1]` before it resolves. */
function maskWith(hooks) {
  sm['maskEnabled'] = () => true
  sm['mask'].encode = async (_id, text) => {
    await hooks.shift()?.()
    return text
  }
}
const unmask = () => {
  delete sm['maskEnabled']
}

test('a stale submit_review landing while the next prompt is masked belongs to no turn', async () => {
  reviewer('rv1')
  agent('rv1', async (n) => (n === 1 ? (sm['onSubmitReview']('rv1', verdict()), {}) : {}))
  maskWith([])
  await sm.prompt('rv1', 'round one')
  await until(() => lastSettled('rv1'), 'turn 1 settles')
  assert.equal(lastSettled('rv1').verdict.verdict, 'approve')
  // Turn 2: the previous call's straggler arrives inside the masking await,
  // where `s.turn` already exists but no round-trip is busy. The agent then
  // omits the tool through the nudge as well.
  maskWith([() => sm['onSubmitReview']('rv1', verdict()), undefined])
  await sm.prompt('rv1', 'round two')
  await until(() => settled.filter((e) => e.sessionId === 'rv1').length === 2, 'turn 2 settles')
  unmask()
  const t = lastSettled('rv1')
  assert.equal(t.turnId, 'rv1:2')
  assert.equal(t.verdict, undefined, 'the stale approval is not this turn’s')
  assert.equal(t.incomplete, true, 'so the omission is classified, nudge included')
  assert.equal(h.reviewLoop.settledOutcome('reviewer', t).kind, 'incomplete')
})

test('a call between the first round-trip and its nudge belongs to no turn; the nudge keeps the logical turn', async () => {
  reviewer('rv2')
  agent('rv2', async () => ({}))
  // The 2nd `encode` is the nudge's: the first round-trip is over, the second not begun.
  maskWith([undefined, () => sm['onSubmitReview']('rv2', verdict())])
  await sm.prompt('rv2', 'go')
  await until(() => lastSettled('rv2'), 'rv2 settles')
  unmask()
  const t = lastSettled('rv2')
  assert.equal(t.turnId, 'rv2:1', 'prompt and nudge are one logical turn')
  assert.equal(t.verdict, undefined)
  assert.equal(t.incomplete, true)

  // …while a call inside the nudge's own round-trip is the turn's.
  reviewer('rv3')
  agent('rv3', async (n) => (n === 2 ? (sm['onSubmitReview']('rv3', verdict('request_changes')), {}) : {}))
  maskWith([])
  await sm.prompt('rv3', 'go')
  await until(() => lastSettled('rv3'), 'rv3 settles')
  unmask()
  const u = lastSettled('rv3')
  assert.equal(u.turnId, 'rv3:1')
  assert.equal(u.verdict.verdict, 'request_changes')
  assert.equal(u.verdict.turnId, 'rv3:1')
  assert.equal(u.incomplete, false)
})

test('a straggler landing after the round-trip ended does not stand in for the contract tool', async () => {
  // `busy` is already down while the round-trip's closing write is awaited:
  // a call landing there must neither be filed nor complete the turn (the
  // nudge still goes out).
  reviewer('rv4')
  const sent = []
  let armed = false
  agent('rv4', async (n, text) => ((armed = n === 1), sent.push(text), {}))
  const real = sm['events'].persist
  sm['events'].persist = (...args) => {
    if (armed && !sm['sessions'].get('rv4').busy) {
      armed = false
      sm['onSubmitReview']('rv4', verdict())
    }
    return real(...args)
  }
  await sm.prompt('rv4', 'go')
  await until(() => lastSettled('rv4'), 'rv4 settles')
  sm['events'].persist = real
  assert.equal(sent.length, 2, 'the nudge was sent: the straggler did not complete the turn')
  const t = lastSettled('rv4')
  assert.equal(t.verdict, undefined)
  assert.equal(t.incomplete, true)
})

test('a stale complete landing while the next prompt is masked is not the loop executor’s proposal', async () => {
  started('ex1', ['alpha'], { reviewOf: LOOP_MARK, repoModes: { alpha: 'read' } })
  agent('ex1', async (n) => (n === 1 ? (sm['onComplete']('ex1', changes), {}) : {}))
  maskWith([])
  await sm.prompt('ex1', 'one')
  await until(() => lastSettled('ex1'), 'turn 1 settles')
  assert.equal(lastSettled('ex1').complete.commit.subject, 'fix')
  maskWith([() => sm['onComplete']('ex1', { ...changes, commit: { subject: 'stale' } }), undefined])
  await sm.prompt('ex1', 'two')
  await until(() => settled.filter((e) => e.sessionId === 'ex1').length === 2, 'turn 2 settles')
  unmask()
  const t = lastSettled('ex1')
  assert.equal(t.complete, undefined, 'not filed into the turn that had not begun')
  assert.equal(t.incomplete, true)
})
