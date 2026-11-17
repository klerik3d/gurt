// Unit test for mapping paths in agent prose onto the file view's scope paths
// (src/shared/fileLinks.ts): what counts as a path, and which scope paths it
// may mean.
//
//   node scripts/file-links.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-file-links-${process.pid}.mjs`)
await bundle({
  stdin: {
    contents: `export { parsePathRef, scopeCandidates } from ${JSON.stringify(path.join(ROOT, 'src/shared/fileLinks.ts'))}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})
const { parsePathRef, scopeCandidates } = await import(pathToFileURL(outfile).href)
after(() => fs.rmSync(outfile, { force: true }))

test('paths with their line and column, in the forms agents write them', () => {
  assert.deepEqual(parsePathRef('src/a.ts'), { path: 'src/a.ts' })
  assert.deepEqual(parsePathRef('src/a.ts:12'), { path: 'src/a.ts', line: 12 })
  assert.deepEqual(parsePathRef('src/a.ts:12:3'), { path: 'src/a.ts', line: 12, column: 3 })
  assert.deepEqual(parsePathRef('a.ts:7'), { path: 'a.ts', line: 7 })
  assert.deepEqual(parsePathRef('src/a.ts#L40'), { path: 'src/a.ts', line: 40 })
  assert.deepEqual(parsePathRef('src/a.ts#L40-L52'), { path: 'src/a.ts', line: 40 })
  assert.deepEqual(parsePathRef('./README.md'), { path: './README.md' })
  assert.deepEqual(parsePathRef('/workspaces/gurt/src/main/files.ts:42'), { path: '/workspaces/gurt/src/main/files.ts', line: 42 })
  assert.deepEqual(parsePathRef('file:///workspaces/gurt/a%20b.md'), { path: '/workspaces/gurt/a b.md' })
  assert.deepEqual(parsePathRef('Dockerfile/'), null)
  assert.deepEqual(parsePathRef('.gitignore'), { path: '.gitignore' })
})

test('not paths: URLs, words, versions, prose', () => {
  for (const text of ['https://example.com/a.ts', 'mailto:x@y.z', 'npm', 'v1.2', '1.2.3', 'localhost:3000', 'two words.ts', '', '  ', 'src/'])
    assert.equal(parsePathRef(text), null, text)
})

test('container paths map onto their root; others outside the scope map to nothing', () => {
  assert.deepEqual(scopeCandidates('/workspaces/gurt/src/a.ts', ['gurt']), ['gurt/src/a.ts'])
  assert.deepEqual(scopeCandidates('/workspaces/artifacts/r.md', ['gurt']), ['artifacts/r.md'])
  assert.deepEqual(scopeCandidates('/workspaces/other/a.ts', ['gurt']), [], 'a repo this session does not have')
  assert.deepEqual(scopeCandidates('/etc/passwd', ['gurt']), [])
  assert.deepEqual(scopeCandidates('/workspaces/gurt/../../etc/passwd', ['gurt']), [])
})

test('relative paths: rooted at a repo, or relative to each repo root', () => {
  assert.deepEqual(scopeCandidates('src/a.ts', ['api']), ['api/src/a.ts'])
  assert.deepEqual(scopeCandidates('./src/a.ts', ['api', 'web']), ['api/src/a.ts', 'web/src/a.ts'])
  assert.deepEqual(scopeCandidates('web/src/a.ts', ['api', 'web']), ['web/src/a.ts', 'api/web/src/a.ts', 'web/web/src/a.ts'])
  assert.deepEqual(scopeCandidates('artifacts/r.md', ['api']), ['artifacts/r.md', 'api/artifacts/r.md'])
  assert.deepEqual(scopeCandidates('../x.ts', ['api']), [])
})

test('with a base (a Markdown file\'s directory), relative targets resolve against it', () => {
  assert.deepEqual(scopeCandidates('img/a.png', ['api'], 'api/docs'), ['api/docs/img/a.png'])
  assert.deepEqual(scopeCandidates('../src/a.ts', ['api'], 'api/docs'), ['api/src/a.ts'])
  assert.deepEqual(scopeCandidates('../../web/a.ts', ['api'], 'api/docs'), ['web/a.ts'], 'into a sibling root')
  assert.deepEqual(scopeCandidates('../../sessions.json', ['api'], 'api/docs'), [], 'scope metadata is no root')
  assert.deepEqual(scopeCandidates('../../../x', ['api'], 'api/docs'), [], 'climbing out of the scope')
})
