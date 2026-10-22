import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'

const outfile = path.join(os.tmpdir(), `gurt-ui-preferences-${process.pid}.mjs`)
await bundle({ entryPoints: ['src/renderer/src/persisted.ts'], outfile })
const { readPreference, selectionSchema, diffFileSchema, z } = await import(pathToFileURL(outfile).href)

test('UI restore validates saved selections and rejects obsolete or corrupted shapes', () => {
  let stored = null
  globalThis.localStorage = { length: 0, clear() {}, key: () => null, removeItem() {}, setItem() {}, getItem: () => stored }
  assert.equal(readPreference('selection', null, selectionSchema), null)
  for (const selection of [{ type: 'session', id: 'session-1' }, { type: 'task', ws: 'work', task: 'fix' }]) {
    stored = JSON.stringify(selection)
    assert.deepEqual(readPreference('selection', null, selectionSchema), selection)
  }
  for (const invalid of ['{', '{"type":"session"}', '{"type":"unknown","id":"x"}', '42']) {
    stored = invalid
    assert.equal(readPreference('selection', null, selectionSchema), null)
  }
  stored = JSON.stringify({ ws: 'work', task: 'fix', repo: 'app', path: 'src/index.ts' })
  assert.equal(readPreference('diffFile', null, diffFileSchema).path, 'src/index.ts')
  stored = '"removed-view"'
  assert.equal(readPreference('view', 'work', z.enum(['work', 'dashboard', 'settings'])), 'work')
})

test('UI restore remains usable when storage is unavailable', () => {
  globalThis.localStorage = { length: 0, clear() {}, key: () => null, removeItem() {}, setItem() {}, getItem: () => { throw new Error('blocked') } }
  assert.equal(readPreference('view', 'work', z.string()), 'work')
})
