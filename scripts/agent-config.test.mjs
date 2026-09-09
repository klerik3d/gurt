// Pure-logic test for shared/agentConfig.ts — which model chip reads as active.
// No docker, no electron. Harness style of scripts/hotkeys.test.mjs.
//
// The property under test: a session runs the model it was told to run, and the
// UI says so. claude-code answers `session/set_config_option` and then keeps
// reporting `currentValue: "default"` — an entry whose description names the
// *account* fallback, not the session's model. Reading that report alone is how
// a session started on Fable comes to be shown as Sonnet, so the session's own
// pick has to win wherever the agent echoes nothing concrete (`withPickedValues`),
// while an agent that does echo a choice stays authoritative.
//
//   node scripts/agent-config.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-agent-config-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await bundle({
  stdin: {
    contents: `export * from ${S('src/shared/agentConfig.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})

const { agentOptionView, withFable, withPickedValues } = await import(pathToFileURL(outfile).href)

after(() => fs.rmSync(outfile, { force: true }))

/** claude-code's model row as the adapter reports it: a literal `default`
 *  entry that names the account fallback, and no `fable` (the accounts that
 *  drop it are why `withFable` exists). */
const modelOption = (currentValue = 'default') => ({
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue,
  options: withFable([
    { value: 'default', name: 'Default', description: 'Use the default model (currently Sonnet 5) · resets daily' },
    { value: 'opus', name: 'Opus', description: 'Opus 5' },
    { value: 'sonnet', name: 'Sonnet', description: 'Sonnet 5' }
  ])
})

const active = (opts, values, kind) =>
  agentOptionView(kind).activeValue(withPickedValues(opts, values, kind)[0])

test('the session pick wins over a "default" the agent never rewrites', () => {
  // Without the overlay the default's description decides, and that is Sonnet.
  assert.equal(active([modelOption()], undefined, 'claude-code'), 'sonnet')
  assert.equal(active([modelOption()], { model: 'fable' }, 'claude-code'), 'fable')
  assert.equal(active([modelOption()], { model: 'opus' }, 'claude-code'), 'opus')
})

test('an agent that echoes a concrete choice stays authoritative', () => {
  // The report names a visible chip: it is the truth, stale picks do not override it.
  assert.equal(active([modelOption('opus')], { model: 'fable' }, 'claude-code'), 'opus')
})

test('a pick no chip offers is ignored, not asserted', () => {
  assert.equal(active([modelOption()], { model: 'gpt-9' }, 'claude-code'), 'sonnet')
})

test('booleans and unpicked options pass through untouched', () => {
  const fast = { id: 'fast', name: 'Fast mode', type: 'boolean', currentValue: false }
  const out = withPickedValues([fast, modelOption()], { fast: true }, 'claude-code')
  assert.equal(out[0].currentValue, false, 'the agent owns a boolean it reports')
  assert.equal(out[1].currentValue, 'default', 'no pick for model — report untouched')
})

test('a kind with no registered view keeps the agent report verbatim', () => {
  const opt = { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gpt-5', options: [{ value: 'gpt-5', name: 'GPT-5' }, { value: 'o3', name: 'o3' }] }
  assert.equal(active([opt], { model: 'o3' }, 'codex'), 'gpt-5')
})
