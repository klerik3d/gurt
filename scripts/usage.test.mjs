// Pure-logic test for the usage model behind the dashboard's agent cards
// (src/shared/usage.ts): window anchoring, per-window aggregation, and the
// limit detector. No docker, no electron. Harness style of
// scripts/turn-contract.test.mjs.
//
//   node scripts/usage.test.mjs
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-usage-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await build({
  stdin: {
    contents: `export * from ${S('src/shared/usage.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  mainFields: ['module', 'main'],
  outfile,
  logLevel: 'silent'
})

const {
  HOUR,
  aggregate,
  agentLimits,
  agentUsage,
  formatDuration,
  isLimitMessage,
  limitResetAt,
  turnOutcome,
  windowsOf
} = await import(pathToFileURL(outfile).href)

const T0 = Date.parse('2026-08-19T09:00:00.000Z')
/** One turn `min` minutes after T0. */
const turn = (min, extra = {}) => ({
  ts: new Date(T0 + min * 60_000).toISOString(),
  agent: 'work',
  kind: 'claude-code',
  sessionId: 's1',
  workspace: 'w',
  task: 't',
  ms: 60_000,
  outcome: 'ok',
  ...extra
})

// --- window anchoring ------------------------------------------------------
{
  // A window opens with a turn and closes 5h later; the first turn past that
  // opens the next one. 0/60/299 land in the first, 300 opens the second.
  const w = windowsOf([turn(0), turn(60), turn(299), turn(300)], 5 * HOUR)
  assert.equal(w.length, 2)
  assert.equal(w[0].turns, 3)
  assert.equal(w[0].start, T0)
  assert.equal(w[0].end, T0 + 5 * HOUR)
  assert.equal(w[1].turns, 1)
  assert.equal(w[1].start, T0 + 300 * 60_000, 'the next window anchors on the turn, not on a grid')
}
{
  // Unsorted input and a garbage timestamp must not shift the anchor.
  const w = windowsOf([turn(60), turn(0), { ...turn(10), ts: 'nonsense' }], 5 * HOUR)
  assert.equal(w.length, 1)
  assert.equal(w[0].start, T0)
  assert.equal(w[0].turns, 2)
}
assert.deepEqual(windowsOf([], 5 * HOUR), [], 'no turns, no windows')

// --- aggregation -----------------------------------------------------------
{
  const w = aggregate(
    [
      turn(0, { ctx: 40_000, cost: 1.0, currency: 'USD' }),
      turn(10, { ctx: 120_000, cost: 1.6, currency: 'USD' }),
      turn(20, { sessionId: 's2', ctx: 10_000, cost: 5.0, currency: 'USD' }),
      turn(30, { outcome: 'error', detail: 'boom' }),
      turn(40, { outcome: 'limited', detail: 'usage limit reached', resetAt: '2026-08-19T14:00:00.000Z' })
    ],
    T0,
    T0 + 5 * HOUR
  )
  assert.equal(w.turns, 5)
  assert.equal(w.sessions, 2)
  assert.equal(w.errors, 1)
  assert.equal(w.limited, 1)
  assert.equal(w.resetAt, '2026-08-19T14:00:00.000Z')
  assert.equal(w.peakCtx, 120_000, 'context is a peak — it is not cumulative and cannot be summed')
  // s1 rose 1.0 -> 1.6 inside the window; s2 contributed one sample, so no rise.
  assert.ok(Math.abs(w.cost - 0.6) < 1e-9, `cost is the rise of the cumulative counter, got ${w.cost}`)
  assert.equal(w.currency, 'USD')
}
{
  const w = aggregate([turn(0), turn(1)], T0, T0 + HOUR)
  assert.equal(w.cost, undefined, 'no reported cost stays undefined, not 0')
  assert.equal(w.peakCtx, undefined)
}

// --- limit detection -------------------------------------------------------
for (const text of [
  // Claude Code's documented limit messages, verbatim.
  "You've hit your session limit",
  "You've hit your weekly limit",
  "You've hit your Opus limit",
  'Claude AI usage limit reached',
  'rate_limit_error: too many requests',
  'HTTP 429',
  'Your weekly limit has been used up',
  'quota exceeded for this organization',
  'your limit will reset shortly'
])
  assert.ok(isLimitMessage(text), `should read as a limit: ${text}`)

for (const text of [
  undefined,
  '',
  'ENOENT: no such file',
  'refusal',
  'container exited',
  // Context exhaustion is not a plan limit — it must not be filed as one.
  'model_context_window_exceeded'
])
  assert.ok(!isLimitMessage(text), `should NOT read as a limit: ${text}`)

assert.equal(limitResetAt('resets at 2026-08-19T14:00:00Z'), '2026-08-19T14:00:00.000Z')
assert.equal(limitResetAt('resetsAt: 1755612000'), new Date(1755612000_000).toISOString())
assert.equal(limitResetAt('your limit will reset at 3pm'), undefined, 'prose has no timezone — left alone')
assert.equal(limitResetAt(undefined), undefined)

// --- turn outcome ----------------------------------------------------------
assert.equal(turnOutcome({ threw: false, stopReason: 'end_turn' }), 'ok')
assert.equal(turnOutcome({ threw: false }), 'ok')
assert.equal(turnOutcome({ threw: false, stopReason: 'cancelled' }), 'cancelled')
assert.equal(turnOutcome({ threw: false, stopReason: 'refusal', detail: 'refusal' }), 'error')
assert.equal(turnOutcome({ threw: true, detail: 'socket hang up' }), 'error')
assert.equal(
  turnOutcome({ threw: true, detail: 'Claude AI usage limit reached' }),
  'limited',
  'a limit outranks the plain error it arrives as'
)

// --- per-agent view --------------------------------------------------------
{
  const now = T0 + 2 * HOUR
  const u = agentUsage([turn(0), turn(30)], 'claude-code', now)
  const five = u.limits.find((l) => l.def.id === 'session')
  assert.ok(five.open, 'the 5-hour window opened at T0 is still open two hours in')
  assert.equal(five.open.turns, 2)
  assert.equal(u.day.turns, 2)
  assert.equal(u.week.turns, 2)
  assert.equal(u.lastAt, new Date(T0 + 30 * 60_000).toISOString())

  // Six hours on, that window has closed and nothing is open.
  const later = agentUsage([turn(0), turn(30)], 'claude-code', T0 + 6 * HOUR)
  assert.equal(later.limits.find((l) => l.def.id === 'session').open, undefined)
  assert.equal(later.day.turns, 2, 'the trailing rollup still counts them')
}
{
  // A kind with no window gurt can anchor gets rollups only — never a guess.
  assert.deepEqual(agentLimits('opencode'), [])
  assert.deepEqual(agentLimits('codex'), [], 'codex windows were never verified — none asserted')
  assert.deepEqual(agentLimits('something-invented'), [])
  const u = agentUsage([turn(0)], 'opencode', T0 + HOUR)
  assert.deepEqual(u.limits, [])
  assert.equal(u.day.turns, 1)
}
{
  // The weekly limit resets at a fixed time assigned to the account, which
  // nothing gurt observes reveals — so it is NOT modelled as a window. Only the
  // session window, whose start a turn locates exactly, is.
  const ids = agentLimits('claude-code').map((l) => l.id)
  assert.deepEqual(ids, ['session'], `claude-code models only the session window, got ${ids}`)
  // The trailing 7-day rollup still reports the volume — it just isn't a window.
  const u = agentUsage([turn(0), turn(60 * 24 * 3)], 'claude-code', T0 + 4 * 24 * 60 * 60_000)
  assert.equal(u.week.turns, 2)
}

// --- formatting ------------------------------------------------------------
assert.equal(formatDuration(0), '—')
assert.equal(formatDuration(48_000), '48s')
assert.equal(formatDuration(12 * 60_000), '12m')
assert.equal(formatDuration(4 * HOUR + 12 * 60_000), '4h 12m')
assert.equal(formatDuration(26 * HOUR), '1d 2h')

console.log('usage: ok')
