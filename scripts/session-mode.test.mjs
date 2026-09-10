// Which ACP mode a session runs in — the pick, not a bool.
//
// A session's auto/manual chip is one boolean, and modes are agent-defined
// lists. Deriving one from the other by name match is how "Auto" became
// unreachable on claude-code: its list is `default, acceptEdits, plan, auto,
// bypassPermissions`, so the first entry matching /accept|auto/ is always
// acceptEdits — and because the derivation re-ran on every `session/new` and
// `session/load`, a user who switched to Auto was put back into Accept edits
// at every start and every wake.
//
// So two properties are pinned here: the derivation asks for the *auto-review*
// mode first (by `_meta.kind`, the one label that means the same thing across
// adapters), and a mode the user picked outranks the derivation entirely for
// as long as the agent still offers it.
//
//   node scripts/session-mode.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-session-mode-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await bundle({
  stdin: {
    contents: `export { desiredModeId, nextModeId, normalizeModes } from ${S('src/main/sessions.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})

const { desiredModeId, nextModeId, normalizeModes } = await import(pathToFileURL(outfile).href)

after(() => fs.rmSync(outfile, { force: true }))

/** claude-code's `session/new` mode report, in the order the adapter sends it:
 *  accept-edits *before* auto, which is the whole trap. */
const claudeModes = (currentModeId = 'default') =>
  normalizeModes({
    currentModeId,
    availableModes: [
      { id: 'default', name: 'Manual' },
      { id: 'acceptEdits', name: 'Accept edits' },
      { id: 'plan', name: 'Plan' },
      { id: 'auto', name: 'Auto', _meta: { kind: 'auto_review' } },
      { id: 'bypassPermissions', name: 'Bypass permissions' }
    ]
  })

/** opencode/gemini: no auto-review mode at all, and "autoEdit" is the closest
 *  thing to one. */
const openCodeModes = (currentModeId = 'default') =>
  normalizeModes({
    currentModeId,
    availableModes: [
      { id: 'default', name: 'Default' },
      { id: 'autoEdit', name: 'Auto edit' },
      { id: 'yolo', name: 'Yolo' },
      { id: 'plan', name: 'Plan' }
    ]
  })

test('the mode normalizer lifts _meta.kind out of the envelope', () => {
  const modes = claudeModes()
  assert.equal(modes.availableModes.find((m) => m.id === 'auto').kind, 'auto_review')
  // Absent, not undefined — these records ride IPC and get persisted.
  assert.equal('kind' in modes.availableModes.find((m) => m.id === 'acceptEdits'), false)
  assert.equal(normalizeModes(undefined), undefined)
})

test('claude-code: auto wins over the acceptEdits listed before it', () => {
  assert.equal(desiredModeId(true, claudeModes()), 'auto')
})

test('an auto-review mode is found by kind whatever it is called', () => {
  // codex-shaped: the auto-review mode is neither named nor id-ed "auto".
  const modes = normalizeModes({
    currentModeId: 'read-only',
    availableModes: [
      { id: 'read-only', name: 'Read only' },
      { id: 'agent', name: 'Approve for me', _meta: { kind: 'auto_review' } },
      { id: 'agent-full-access', name: 'Full access' }
    ]
  })
  assert.equal(desiredModeId(true, modes), 'agent')
})

test('agents with no auto-review mode fall back to accept/auto-edit, then to bypass', () => {
  assert.equal(desiredModeId(true, openCodeModes()), 'autoEdit')
  const bypassOnly = normalizeModes({
    currentModeId: 'default',
    availableModes: [
      { id: 'default', name: 'Default' },
      { id: 'bypassPermissions', name: 'Bypass permissions' }
    ]
  })
  assert.equal(desiredModeId(true, bypassOnly), 'bypassPermissions')
})

test('manual still resolves to the default mode, and a no-op returns undefined', () => {
  assert.equal(desiredModeId(false, claudeModes('auto')), 'default')
  assert.equal(desiredModeId(false, claudeModes('default')), undefined)
  assert.equal(desiredModeId(true, claudeModes('auto')), undefined)
  assert.equal(desiredModeId(true, undefined), undefined)
  assert.equal(desiredModeId(true, normalizeModes({ currentModeId: 'x', availableModes: [] })), undefined)
})

test('a saved pick is restored on reattach instead of re-derived', () => {
  // The user chose "Plan" (setMode wrote both fields: the id, and the bool the
  // auto/manual tag reads). The adapter comes back on `default` after a wake.
  const info = { modeId: 'plan', autoAllow: false }
  assert.equal(nextModeId(info, claudeModes('default')), 'plan')
  // And the bug this whole field exists for: "Auto" survives a restart even
  // though the derivation from `autoAllow` alone would once have said
  // acceptEdits — and still says nothing more specific than the derivation.
  assert.equal(nextModeId({ modeId: 'acceptEdits', autoAllow: true }, claudeModes('default')), 'acceptEdits')
  // Already there: no redundant session/set_mode.
  assert.equal(nextModeId(info, claudeModes('plan')), undefined)
})

test('the derivation is the fallback: no pick, or a pick this agent does not offer', () => {
  // A fresh session — first start, nothing ever picked — lands in auto.
  assert.equal(nextModeId({ autoAllow: true }, claudeModes()), 'auto')
  assert.equal(nextModeId({}, claudeModes()), 'auto')
  assert.equal(nextModeId({ autoAllow: false }, claudeModes('auto')), 'default')
  // Picked on claude-code, then the session's agent was a different one all
  // along (or the adapter dropped the mode): fall back, never send an id the
  // agent would reject.
  assert.equal(nextModeId({ modeId: 'acceptEdits', autoAllow: true }, openCodeModes()), 'autoEdit')
})
