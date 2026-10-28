// Unit test for the Docker GC's pure decisions: which env images are stale, and
// how untrusted settings are coerced. No docker needed.
//
//   node scripts/gc.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-gc-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))
await bundle({
  stdin: {
    contents:
      `export { pickStaleImages } from ${S('src/main/gc.ts')}\n` +
      `export { normalizeGcSettings, GC_DEFAULTS } from ${S('src/shared/gc.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  external: ['electron'],
  outfile
})
const m = await import(pathToFileURL(outfile).href)
after(() => fs.rmSync(outfile, { force: true }))

const img = (id, created, repo, env) => ({ id, tag: `gurt-env:${id}`, created, repo, env })

test('keeps the newest labeled build per (repo, env), drops older unused ones', () => {
  const images = [img('a', 1, 'r', 'e'), img('b', 2, 'r', 'e'), img('c', 1, 'r', 'other')]
  assert.deepEqual(m.pickStaleImages(images, new Set()).map((i) => i.id), ['a'])
})

test('never picks an image a container uses', () => {
  const images = [img('a', 1, 'r', 'e'), img('b', 2, 'r', 'e')]
  assert.deepEqual(m.pickStaleImages(images, new Set(['a'])), [])
})

test('unlabeled leftovers go when unused and stay when used', () => {
  const images = [img('x', 1, undefined, undefined), img('y', 2, undefined, undefined)]
  assert.deepEqual(m.pickStaleImages(images, new Set(['y'])).map((i) => i.id), ['x'])
})

test('normalizeGcSettings coerces garbage to the fallback and clamps hours', () => {
  assert.deepEqual(m.normalizeGcSettings(null), m.GC_DEFAULTS)
  const n = m.normalizeGcSettings({ enabled: 'yes', stoppedContainerHours: 0.2, buildCacheHours: 1e9 })
  assert.equal(n.enabled, true)
  assert.equal(n.stoppedContainerHours, 1)
  assert.equal(n.buildCacheHours, 24 * 365)
  assert.equal(m.normalizeGcSettings({ diskThresholdPercent: 5 }).diskThresholdPercent, 50)
  assert.equal(m.normalizeGcSettings({ diskThresholdPercent: 'x' }).diskThresholdPercent, 80)
})
