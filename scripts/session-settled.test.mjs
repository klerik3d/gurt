// `session.settled` (docs/requirements-review-loop.md §5.1, §8): one event per
// logical turn — a prompt plus its nudge — emitted from `runPrompt` after gurt
// has classified how the turn ended, and only after `PersistedSession.lastSettled`
// is on disk. `session.turn` `ended` cannot carry this: it fires before the plan
// hold and the `incomplete` mark.
//
// A fake `session/prompt` (scripts/lib/loop-harness.mjs) drives real turns; the
// contract tools are called the way the per-session gurt server calls them.
//
//   node scripts/session-settled.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loopHarness } from './lib/loop-harness.mjs'

const h = await loopHarness('session-settled')
const { kernel, reviewLoop, ref, agent, tick, until } = h
// Only a loop session settles durably (fix 1): one with `review` or `reviewOf`.
// A session with neither is covered by scripts/ordinary-session-unchanged.test.mjs.
// These carry a `reviewOf` naming an executor that has no loop — a loop session
// to the session manager, inert for the controller (a real Review block would
// start a loop that reacts to the turns under test).
const LOOP_MARK = { executor: 'nobody', round: 1, intent: 'nobody.1' }
const started = (id, repos, extra = {}, opts) => h.started(id, repos, { reviewOf: LOOP_MARK, ...extra }, opts)
after(() => h.cleanup())

const settled = []
const turnEnds = []
/** What sessions.json held for the session at the instant each event fired. */
const onDisk = []
const rowOf = (id) =>
  JSON.parse(fs.readFileSync(path.join(h.GURT_ROOT, 'w', 't', 'sessions.json'), 'utf8')).find((r) => r.info.id === id)
kernel.bus.on('session.settled', (e) => {
  settled.push(e)
  onDisk.push(rowOf(e.sessionId)?.lastSettled)
})
kernel.bus.on('session.turn', (e) => e.phase === 'ended' && turnEnds.push(e))

const changes = (subject = 'fix') => ({ version: 1, outcome: 'changes', commit: { subject } })
const verdict = (over = {}) => ({ version: 1, verdict: 'approve', summary: 'ok', findings: [], ...over })
const complete = (id, p) => kernel.sessions['onComplete'](id, p)

/** Send a typed prompt and wait for its logical turn to settle. */
async function turn(id, text = 'go') {
  const before = settled.filter((e) => e.sessionId === id).length
  await kernel.sessions.prompt(id, text)
  await until(() => settled.filter((e) => e.sessionId === id).length > before, `${id} settles`)
  return settled.filter((e) => e.sessionId === id).at(-1)
}

test('a turn that completes settles once, with its complete, after lastSettled is on disk', async () => {
  started('s1', ['alpha'])
  agent('s1', async () => complete('s1', changes()) ?? {})
  const e = await turn('s1')
  assert.equal(e.turn.turnId, 's1:1')
  assert.equal(e.turn.complete.outcome, 'changes')
  assert.equal(e.turn.complete.commit.subject, 'fix')
  assert.ok(e.turn.complete.at, 'the stored proposal, with its receipt time')
  assert.equal(e.turn.incomplete, false)
  assert.equal(e.turn.limited, undefined)
  assert.equal(e.turn.cancelled, undefined)
  assert.equal(e.turn.failed, undefined)
  assert.deepEqual(e.ref, ref)
  const i = settled.indexOf(e)
  assert.deepEqual(onDisk[i], e.turn, 'persisted before it was emitted')
  assert.deepEqual(reviewLoop.settledOutcome('executor', e.turn).kind, 'complete')
  await tick()
  assert.equal(settled.filter((x) => x.sessionId === 's1').length, 1, 'exactly one event')
})

test('a nudge that heals the turn settles once, as the one logical turn', async () => {
  started('s2', ['alpha'])
  agent('s2', async (n) => (n === 2 ? (complete('s2', changes('late')), {}) : {}))
  const ends = turnEnds.length
  const e = await turn('s2')
  assert.equal(e.turn.turnId, 's2:1', 'prompt and nudge are one turn')
  assert.equal(e.turn.complete.commit.subject, 'late', 'the nudge turn’s complete is the turn’s')
  assert.equal(e.turn.incomplete, false)
  assert.deepEqual(turnEnds.slice(ends).map((x) => x.final), [false, true], 'two round-trips, one settle')
  assert.equal(settled.filter((x) => x.sessionId === 's2').length, 1)
})

test('the last complete of a turn wins', async () => {
  started('s3', ['alpha'])
  agent('s3', async () => (complete('s3', changes('first')), complete('s3', { version: 1, outcome: 'no_changes' }), {}))
  const e = await turn('s3')
  assert.equal(e.turn.complete.outcome, 'no_changes')
})

test('incomplete: no contract tool even after the nudge is set before the event', async () => {
  started('s4', ['alpha'])
  agent('s4', async () => ({}))
  let marked
  const off = kernel.bus.on('session.settled', (ev) => {
    if (ev.sessionId === 's4') marked = kernel.sessions.snapshot('s4').info.incomplete
  })
  const e = await turn('s4')
  off()
  assert.equal(e.turn.incomplete, true)
  assert.equal(e.turn.complete, undefined)
  assert.equal(marked, true, 'the session’s own incomplete mark is already set when the event fires')
  assert.deepEqual(reviewLoop.settledOutcome('executor', e.turn), { kind: 'incomplete' })
  const texts = kernel.sessions.snapshot('s4').entries.filter((x) => x.kind === 'system').map((x) => x.text)
  assert.ok(texts.includes('turn ended without complete'))
})

test('a plan hold settles limited — after the hold is recorded, with its end', async () => {
  // Its own agent: the limit holds the whole account. And its own clone: its
  // queued continuation keeps its FIFO place on it through the hold (main's
  // d1fb01e), so on `alpha` every later session here would wait behind it.
  started('s5', ['beta'], { agent: 'a9' })
  agent('s5', async () => {
    throw new Error('429 too many requests — limit will reset in 2 hours')
  })
  let seenLimit
  const off = kernel.bus.on('session.settled', (ev) => {
    if (ev.sessionId === 's5') seenLimit = kernel.sessions.sessionInfo('s5').limitedUntil
  })
  const e = await turn('s5')
  off()
  assert.ok(e.turn.limited?.until, 'limited, with the reset')
  assert.equal(e.turn.limited.until, seenLimit, 'the same instant the session persisted')
  assert.ok(Date.parse(e.turn.limited.until) > Date.now())
  assert.equal(e.turn.incomplete, false, 'a cut-off turn is not incomplete')
  assert.equal(e.turn.failed, undefined, 'and the throw is the limit’s, not a failure')
  assert.deepEqual(reviewLoop.settledOutcome('executor', e.turn).kind, 'limited')
  // The continuation is queued, and the session is not re-nudged on the way.
  assert.deepEqual(kernel.sessions.snapshot('s5').pending.map((p) => p.text), ['continue'])
})

test('a thrown turn settles failed; an artifact does not redeem it', async () => {
  started('s6', ['alpha'])
  agent('s6', async () => {
    complete('s6', changes('half done'))
    throw new Error('adapter crashed')
  })
  const e = await turn('s6')
  assert.deepEqual(e.turn.failed, { stopReason: 'error' })
  assert.equal(e.turn.complete.commit.subject, 'half done', 'the artifact is kept as data…')
  assert.equal(reviewLoop.settledOutcome('executor', e.turn).kind, 'failed', '…and loses on precedence')
  assert.equal(e.turn.incomplete, false)
})

test('cancelled and other non-end_turn stops are told apart', async () => {
  started('s7', ['alpha'])
  agent('s7', async (n) => (complete('s7', changes()), { stopReason: n === 1 ? 'cancelled' : 'max_tokens' }))
  const c = await turn('s7')
  assert.equal(c.turn.cancelled, true)
  assert.equal(c.turn.failed, undefined)
  assert.equal(reviewLoop.settledOutcome('executor', c.turn).kind, 'cancelled', 'Esc outranks the artifact')
  const f = await turn('s7')
  assert.deepEqual(f.turn.failed, { stopReason: 'max_tokens' })
  assert.equal(f.turn.cancelled, undefined)
  assert.equal(f.turn.turnId, 's7:2', 'ids count up per logical turn')
})

test('a tool call outside a turn belongs to no turn', async () => {
  started('s8', ['alpha'])
  complete('s8', changes('stray')) // no turn running
  const before = kernel.sessions['sessions'].get('s8').lastSettled
  assert.equal(before, undefined, 'it settled nothing')
  agent('s8', async () => ({})) // never completes
  const e = await turn('s8')
  assert.equal(e.turn.complete, undefined, 'and is not in the next turn’s settle')
  assert.equal(e.turn.incomplete, true)
  complete('s8', changes('late')) // after the settle
  assert.equal(kernel.sessions['sessions'].get('s8').lastSettled.complete, undefined, 'nor in the last one’s')
})

test('the start prompt runs through runPrompt and settles too', async () => {
  started('s9', ['alpha'])
  agent('s9', async () => complete('s9', changes('start')) ?? {})
  const s = kernel.sessions['sessions'].get('s9')
  await kernel.sessions['runPrompt'](s, 'the start prompt')
  const e = settled.filter((x) => x.sessionId === 's9').at(-1)
  assert.equal(e.turn.complete.commit.subject, 'start')
})

test('a reviewer settles with its verdict, filed under the turn’s id', async () => {
  started('r1', ['alpha'], {
    role: 'reviewer',
    repoModes: { alpha: 'read' },
    reviewOf: { executor: 's1', round: 1, intent: 's1.1' }
  })
  agent('r1', async () => kernel.sessions['onSubmitReview']('r1', verdict()) ?? {})
  const e = await turn('r1')
  assert.equal(e.turn.verdict.verdict, 'approve')
  assert.equal(e.turn.verdict.turnId, e.turn.turnId, 'the verdict names the turn it came in')
  assert.equal(e.turn.verdict.round, 1)
  assert.equal(e.turn.complete, undefined)
  assert.equal(reviewLoop.settledOutcome('reviewer', e.turn).kind, 'verdict')

  started('r2', ['alpha'], { role: 'reviewer', repoModes: { alpha: 'read' }, reviewOf: { executor: 's1', round: 1, intent: 's1.2' } })
  agent('r2', async () => ({}))
  const n = await turn('r2')
  assert.equal(n.turn.incomplete, true, 'no verdict even after the nudge')
  const texts = kernel.sessions.snapshot('r2').entries.filter((x) => x.kind === 'system').map((x) => x.text)
  assert.ok(texts.includes('turn ended without submit_review'), 'the role’s own tool is named')
})

test('turn ids survive a restart: the counter resumes from lastSettled', async () => {
  kernel.sessions.restore([
    {
      info: {
        id: 'z1', env: 'dev', role: 'executor', repos: ['alpha'], repoModes: { alpha: 'write' }, task: 't',
        workspace: 'w', title: 'z', agent: 'a1', state: 'started', mcp: [], startPrompt: 'x', reviewOf: LOOP_MARK
      },
      acpSessionId: 'acp-z1',
      lastSettled: { turnId: 'z1:41', incomplete: false },
      log: []
    }
  ])
  agent('z1', async () => complete('z1', changes()) ?? {})
  assert.deepEqual(kernel.sessions['recordsFor']('w', 't').find((r) => r.info.id === 'z1').lastSettled, {
    turnId: 'z1:41',
    incomplete: false
  }, 'a restored record writes back what it was given')
  const e = await turn('z1')
  assert.equal(e.turn.turnId, 'z1:42')
  assert.equal(rowOf('z1').lastSettled.turnId, 'z1:42')
})

test('a session deleted mid-turn settles to nobody', async () => {
  started('d1', ['alpha'])
  agent('d1', async () => {
    kernel.sessions.deleteSession('d1')
    return {}
  })
  await kernel.sessions.prompt('d1', 'go')
  await until(() => !kernel.sessions['sessions'].get('d1') && !kernel.sessions['sessions'].has('d1'), 'deleted')
  await tick(150)
  assert.equal(settled.filter((x) => x.sessionId === 'd1').length, 0)
})
