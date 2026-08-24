// Pure-logic test for the turn-contract enforcement decision (§7.2 of
// docs/requirements-turn-contract.md). No docker, no electron: it bundles the
// pure `postTurnDecision` out of the session manager and checks the matrix.
//
//   node scripts/turn-contract.test.mjs
import { test, after } from 'node:test'
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-turn-contract-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await build({
  stdin: {
    contents: `export { postTurnDecision, NUDGE_PROMPT, adapterExitCode } from ${S('src/main/sessions.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  // jsonc-parser's `main` is a UMD build esbuild can't wrap into ESM output —
  // prefer each package's ESM entry, like vite does.
  mainFields: ['module', 'main'],
  outfile,
  logLevel: 'silent'
})

const { postTurnDecision, NUDGE_PROMPT, adapterExitCode } = await import(pathToFileURL(outfile).href)

after(() => fs.rmSync(outfile, { force: true }))

const decide = (o) =>
  postTurnDecision({
    threw: false,
    isNudge: false,
    stopReason: 'end_turn',
    turnComplete: false,
    // The executor default; the roles without the contract are asserted below.
    hasContract: true,
    ...o
  })

// --- post-turn decision ----------------------------------------------------
test('post-turn decision', () => {
  // end_turn + complete → nothing
  assert.equal(decide({ turnComplete: true }), 'none', 'end_turn with complete → none')

  // end_turn without complete → exactly one nudge
  assert.equal(decide({ turnComplete: false }), 'nudge', 'end_turn without complete → nudge')

  // the nudge turn without complete → incomplete, no second nudge
  assert.equal(
    decide({ turnComplete: false, isNudge: true }),
    'incomplete',
    'nudge turn without complete → incomplete'
  )

  // complete arriving during the nudge turn → clean, no incomplete
  assert.equal(
    decide({ turnComplete: true, isNudge: true }),
    'none',
    'complete during nudge turn → none'
  )

  // a non-end_turn stop (cancel) never nudges, complete or not
  assert.equal(decide({ stopReason: 'cancelled', turnComplete: false }), 'none', 'cancelled → none')
  assert.equal(decide({ stopReason: 'max_tokens', turnComplete: false }), 'none', 'other stop → none')
  assert.equal(decide({ stopReason: undefined, turnComplete: false }), 'none', 'no stopReason → none')

  // a thrown prompt never nudges (the error line is already surfaced)
  assert.equal(decide({ threw: true, turnComplete: false }), 'none', 'thrown prompt → none')

  // a thrown *nudge* turn does not mark incomplete either
  assert.equal(
    decide({ threw: true, turnComplete: false, isNudge: true }),
    'none',
    'thrown nudge → none'
  )

  // A role without the turn contract (researcher / reviewer) is never offered
  // `complete` at all — nudging it would demand a tool that isn't there, so its
  // turns just end, nudge-turn bookkeeping included.
  assert.equal(
    decide({ hasContract: false, turnComplete: false }),
    'none',
    'no contract: end_turn without complete → none'
  )
  assert.equal(
    decide({ hasContract: false, turnComplete: false, isNudge: true }),
    'none',
    'no contract: never marks incomplete either'
  )

  assert.match(NUDGE_PROMPT, /complete/, 'nudge prompt asks for `complete`')
})

// --- adapter exit code -----------------------------------------------------
test('adapter exit code', () => {
  // kill -9 mid-turn → 137, the exact case docs/logging.md's acceptance #2 relies on
  assert.equal(adapterExitCode(null, 'SIGKILL'), 137, 'SIGKILL → 128 + 9')

  // SIGTERM → 143, the other commonly-hit signal
  assert.equal(adapterExitCode(null, 'SIGTERM'), 143, 'SIGTERM → 128 + 15')

  // clean exits pass their code through untouched, including a clean 0
  assert.equal(adapterExitCode(0, null), 0, 'clean exit 0 → 0')
  assert.equal(adapterExitCode(3, null), 3, 'nonzero exit code passes through')

  // neither a code nor a signal → sentinel -1, never a missing/undefined field
  assert.equal(adapterExitCode(null, null), -1, 'no code, no signal → -1')

  // a signal outside the SIGNUM table still reads as "died", not "clean"
  assert.equal(adapterExitCode(null, 'SIGWINCH'), 128, 'unlisted signal → 128')
})
