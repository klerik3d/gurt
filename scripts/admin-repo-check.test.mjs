// A repo's `check` command is written through the operator's admin tools
// (t3v2 §13.3): `add_repo` sets it, `update_repo` changes and clears it, and it
// lands in workspace.json like every other repo field.
//
//   node scripts/admin-repo-check.test.mjs
import { test, after } from 'node:test'
import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { operatorHarness } from './lib/operator-harness.mjs'

const h = await operatorHarness('repocheck', (root) => {
  fs.mkdirSync(path.join(root, 'w', 't'), { recursive: true })
  fs.writeFileSync(path.join(root, 'w', 'workspace.json'), JSON.stringify({ repos: [], envs: [] }))
  fs.writeFileSync(path.join(root, 'w', 't', 'task.json'), JSON.stringify({}))
})
after(() => h.close())

const stored = () =>
  JSON.parse(fs.readFileSync(path.join(h.GURT_ROOT, 'w', 'workspace.json'), 'utf8')).repos.find((r) => r.name === 'api')

test('add_repo sets check; update_repo changes and clears it', async () => {
  const url = 'https://github.com/o/api.git'
  const added = await h.call('add_repo', { repo: { name: 'api', url, check: 'npm test' }, rev: await h.rev('repo:api') })
  assert.ok(!added.isError, added.text)
  assert.equal(stored().check, 'npm test', 'set on add')

  const changed = await h.call('update_repo', { repo: { name: 'api', url, check: 'npm run lint && npm test' }, rev: await h.rev('repo:api') })
  assert.ok(!changed.isError, changed.text)
  assert.equal(stored().check, 'npm run lint && npm test', 'changed on update')

  const cleared = await h.call('update_repo', { repo: { name: 'api', url }, rev: await h.rev('repo:api') })
  assert.ok(!cleared.isError, cleared.text)
  assert.equal(stored().check, undefined, 'cleared on update')
})
