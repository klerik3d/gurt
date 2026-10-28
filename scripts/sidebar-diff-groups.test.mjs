import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'

const root = fileURLToPath(new URL('..', import.meta.url))
const outfile = path.join(os.tmpdir(), `gurt-diff-groups-${process.pid}.mjs`)
await bundle({
  stdin: {
    contents: `export { diffRows, diffRowKey } from ${JSON.stringify(path.join(root, 'src/renderer/src/components/DiffSidebar.tsx'))}`,
    resolveDir: root, loader: 'tsx', sourcefile: 'entry.tsx'
  }, outfile
})
const { diffRows, diffRowKey } = await import(pathToFileURL(outfile).href)
const files = [{ path: 'src/app.ts', status: 'M' }]
const repo = { repo: 'app', files, integrated: false, commits: [
  { sha: 'abc', subject: 'Latest', pushed: false },
  { sha: 'def', subject: 'Earlier', pushed: true }
] }
const folding = { repoOpen: () => true, groupOpen: () => false, folderOpen: () => true, groupFiles: () => ({ files }) }

test('repository initially exposes groups, with commits in supplied order', () => {
  const rows = diffRows([repo], 'list', folding)
  assert.deepEqual(rows.map((r) => r.kind), ['repo', 'group', 'group', 'group'])
  assert.deepEqual(rows.slice(1).map((r) => r.label), ['Uncommitted', 'Latest', 'Earlier'])
  assert.deepEqual(diffRows([repo], 'list', { ...folding, repoOpen: () => false }).map((r) => r.kind), ['repo'])
})

test('identical file paths in different revisions retain distinct selection keys', () => {
  const rows = diffRows([repo], 'list', { ...folding, groupOpen: () => true })
  const changed = rows.filter((r) => r.kind === 'file')
  assert.equal(changed.length, 3)
  assert.equal(new Set(changed.map(diffRowKey)).size, 3)
  assert.deepEqual(changed.map((r) => r.target), [{ kind: 'uncommitted' }, { kind: 'commit', sha: 'abc' }, { kind: 'commit', sha: 'def' }])
})

test('folder folding is independent for each revision; integrated commits disappear', () => {
  const rows = diffRows([repo], 'tree', { ...folding, groupOpen: () => true, folderOpen: (_repo, _path, target) => target.kind === 'commit' })
  assert.equal(rows.filter((r) => r.kind === 'folder').length, 3)
  assert.deepEqual(rows.filter((r) => r.kind === 'file').map((r) => r.target.sha), ['abc', 'def'])
  assert.deepEqual(diffRows([{ ...repo, integrated: true }], 'list', folding).map((r) => r.kind), ['repo', 'group'])
})
