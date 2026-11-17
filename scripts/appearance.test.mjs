// Unit test for Settings → Appearance's untrusted-input coercion: what the
// renderer sends and what appearance.json holds are both normalized through
// `sanitizeAppearance` before main applies them.
//
//   node scripts/appearance.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-appearance-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))
await bundle({
  stdin: {
    contents: `export { sanitizeAppearance, APPEARANCE_DEFAULT, TEXT_SIZE_ZOOM } from ${S('src/shared/appearance.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})
const m = await import(pathToFileURL(outfile).href)
after(() => fs.rmSync(outfile, { force: true }))

test('the default is today\'s look: dark, medium text at 100%', () => {
  assert.deepEqual(m.APPEARANCE_DEFAULT, { theme: 'dark', textSize: 'medium' })
  assert.equal(m.TEXT_SIZE_ZOOM.medium, 1)
})

test('a missing or non-object payload is the default', () => {
  for (const raw of [undefined, null, 'light', 42, []]) assert.deepEqual(m.sanitizeAppearance(raw), m.APPEARANCE_DEFAULT)
})

test('known values pass through', () => {
  assert.deepEqual(m.sanitizeAppearance({ theme: 'system', textSize: 'large' }), { theme: 'system', textSize: 'large' })
})

test('an unknown field value falls back per field to the fallback, not wholesale', () => {
  const fallback = { theme: 'light', textSize: 'small' }
  assert.deepEqual(m.sanitizeAppearance({ theme: 'sepia', textSize: 'large' }, fallback), { theme: 'light', textSize: 'large' })
  assert.deepEqual(m.sanitizeAppearance({ theme: 'dark', textSize: 3 }, fallback), { theme: 'dark', textSize: 'small' })
})

test('extra keys are dropped', () => {
  assert.deepEqual(Object.keys(m.sanitizeAppearance({ theme: 'dark', textSize: 'small', zoom: 4 })), ['theme', 'textSize'])
})
