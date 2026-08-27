// Pure-logic test for shared/hotkeys.ts — the default map, sanitizing
// untrusted input, matching a live keydown, and conflict detection for the
// settings editor's remap flow. No docker, no electron. Harness style of
// scripts/notifications.test.mjs.
//
//   node scripts/hotkeys.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-hotkeys-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await bundle({
  stdin: {
    contents: [`export * from ${S('src/shared/hotkeys.ts')}`].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})

const {
  HOTKEY_DEFAULTS,
  HOTKEY_DEFS,
  sanitizeHotkeys,
  bindingEquals,
  conflictsFor,
  bindingLabel,
  codeLabel,
  bindingMatchesEvent,
  bindingFromEvent,
  isRecordable
} = await import(pathToFileURL(outfile).href)

const evt = (over) => ({ code: 'KeyK', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over })

// --- defaults: every action has one, and none collide out of the box -----
test('every default action has a binding, and no two collide', () => {
  for (const def of HOTKEY_DEFS) assert.ok(HOTKEY_DEFAULTS[def.id], `${def.id} has a default`)
  for (const def of HOTKEY_DEFS)
    assert.deepEqual(
      conflictsFor(def.id, HOTKEY_DEFAULTS[def.id], HOTKEY_DEFAULTS),
      [],
      `${def.id}'s default does not collide with another action's default`
    )
})

// --- bindingMatchesEvent: mod is either meta or ctrl, exactly -------------
test('bindingMatchesEvent: meta or ctrl both satisfy mod, shift/alt must match exactly', () => {
  const b = HOTKEY_DEFAULTS.palette // KeyK, mod
  assert.ok(bindingMatchesEvent(b, evt({ metaKey: true })))
  assert.ok(bindingMatchesEvent(b, evt({ ctrlKey: true })), 'ctrl stands in for meta cross-platform')
  assert.ok(!bindingMatchesEvent(b, evt({})), 'no modifier at all does not match')
  assert.ok(!bindingMatchesEvent(b, evt({ metaKey: true, shiftKey: true })), 'an extra held shift breaks the match')
  assert.ok(!bindingMatchesEvent(b, evt({ metaKey: true, code: 'KeyJ' })), 'wrong physical key does not match')
})

// --- bindingFromEvent / isRecordable: modifier-only keydowns don't count -
test('isRecordable rejects bare modifier codes, bindingFromEvent captures the rest', () => {
  assert.ok(!isRecordable('ShiftLeft'))
  assert.ok(!isRecordable('MetaRight'))
  assert.ok(isRecordable('KeyN'))
  assert.ok(isRecordable('Backquote'))
  const b = bindingFromEvent(evt({ metaKey: true, shiftKey: true, code: 'Backquote' }))
  assert.deepEqual(b, { code: 'Backquote', mod: true, shift: true, alt: false })
  const c = bindingFromEvent(evt({ ctrlKey: true, code: 'KeyN' }))
  assert.equal(c.mod, true, 'ctrl alone still sets mod')
})

// --- conflictsFor: finds every other action sharing a combination --------
test('conflictsFor finds the collision and only the collision', () => {
  const map = { ...HOTKEY_DEFAULTS }
  // Force a collision: newTask now shares newSession's combination.
  map.newTask = map.newSession
  assert.deepEqual(conflictsFor('newSession', map.newSession, map), ['newTask'])
  assert.deepEqual(conflictsFor('newTask', map.newTask, map), ['newSession'])
  assert.deepEqual(conflictsFor('palette', map.palette, map), [], 'an unrelated action reports no conflict')
})

// --- bindingLabel / codeLabel: the app's existing ⌘⇧N-style convention ---
test('bindingLabel renders the app convention, codeLabel strips Key/Digit prefixes', () => {
  assert.equal(bindingLabel(HOTKEY_DEFAULTS.palette), '⌘K')
  assert.equal(bindingLabel(HOTKEY_DEFAULTS.newTask), '⌘⇧N')
  assert.equal(bindingLabel(HOTKEY_DEFAULTS.workspacePrev), '⌘⇧`')
  assert.equal(codeLabel('KeyN'), 'N')
  assert.equal(codeLabel('Digit1'), '1')
  assert.equal(codeLabel('Backquote'), '`')
  assert.equal(codeLabel('F5'), 'F5', 'an unmapped code falls back to itself rather than vanishing')
})

// --- sanitizeHotkeys: untrusted input never crashes/corrupts -------------
test('sanitizeHotkeys: untrusted input never crashes/corrupts', () => {
  assert.deepEqual(sanitizeHotkeys({ bogus: 'nope' }), HOTKEY_DEFAULTS, 'garbage input falls back to defaults per action')
  assert.deepEqual(sanitizeHotkeys(null), HOTKEY_DEFAULTS)
  assert.deepEqual(sanitizeHotkeys('nonsense'), HOTKEY_DEFAULTS)
  const partial = sanitizeHotkeys({ palette: { code: 'KeyJ', mod: true, shift: false, alt: false } })
  assert.deepEqual(partial.palette, { code: 'KeyJ', mod: true, shift: false, alt: false })
  assert.deepEqual(partial.newSession, HOTKEY_DEFAULTS.newSession, 'an action missing from the payload keeps its fallback')
  // A malshaped single entry degrades to that action's fallback, not to
  // discarding every other action's already-persisted remap.
  const persisted = { ...HOTKEY_DEFAULTS, newTask: { code: 'KeyJ', mod: true, shift: true, alt: false } }
  const recovered = sanitizeHotkeys({ palette: 'not a binding' }, persisted)
  assert.deepEqual(recovered.palette, persisted.palette, 'the bad field recovers to the persisted value, not the hardcoded default')
  assert.deepEqual(recovered.newTask, persisted.newTask, 'an untouched action is carried through unchanged')
})

// --- bindingEquals ---------------------------------------------------------
test('bindingEquals compares every field', () => {
  const a = { code: 'KeyK', mod: true, shift: false, alt: false }
  assert.ok(bindingEquals(a, { ...a }))
  assert.ok(!bindingEquals(a, { ...a, shift: true }))
  assert.ok(!bindingEquals(a, { ...a, code: 'KeyJ' }))
})

after(async () => {
  await import('node:fs').then((fs) => fs.promises.rm(outfile, { force: true }))
})
