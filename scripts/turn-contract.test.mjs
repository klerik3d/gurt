// Pure-logic test for the turn-contract enforcement decision (§7.2 of
// docs/requirements-turn-contract.md). No docker, no electron: it bundles the
// pure `postTurnDecision` out of the session manager and checks the matrix.
//
//   node scripts/turn-contract.test.mjs
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
    contents: `export { postTurnDecision, NUDGE_PROMPT } from ${S('src/main/sessions.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  logLevel: 'silent'
})

const { postTurnDecision, NUDGE_PROMPT } = await import(pathToFileURL(outfile).href)

const decide = (o) =>
  postTurnDecision({ threw: false, isNudge: false, stopReason: 'end_turn', turnComplete: false, ...o })

try {
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

  assert.match(NUDGE_PROMPT, /complete/, 'nudge prompt asks for `complete`')

  console.log('turn-contract.test: PASS')
} finally {
  fs.rmSync(outfile, { force: true })
}
