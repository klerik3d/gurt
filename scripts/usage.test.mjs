// Pure-logic test for the turn-ledger model (src/shared/usage.ts): the limit
// detector, outcome folding, and the shared formatters. No docker, no
// electron. Harness style of scripts/turn-contract.test.mjs.
//
// Plan windows and utilization are the provider's own numbers and live in
// planUsage.ts — tested in scripts/plan-usage.test.mjs.
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

const { HOUR, formatDuration, isLimitMessage, limitResetAt, turnOutcome } = await import(
  pathToFileURL(outfile).href
)

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

// --- formatting ------------------------------------------------------------
assert.equal(formatDuration(0), '—')
assert.equal(formatDuration(48_000), '48s')
assert.equal(formatDuration(12 * 60_000), '12m')
assert.equal(formatDuration(4 * HOUR + 12 * 60_000), '4h 12m')
assert.equal(formatDuration(26 * HOUR), '1d 2h')

console.log('usage: ok')
