// The operator may not write a repo's review-loop fields
// (docs/requirements-review-loop.md §10 open question, settled in §13 "Slice 8"
// following docs/requirements-session-operator.md §4.1 conservatively): `check`
// is a shell command run in the session container and `review` arms unattended
// commit / push / PR. Neither is held for confirmation — they are refused, with
// a sentence naming Settings, and workspace.json untouched. A write that leaves
// them as they are still lands.
//
//   node --test scripts/review-block-operator.test.mjs
import { test, after } from 'node:test'
import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { operatorHarness } from './lib/operator-harness.mjs'

const REVIEW = { enabled: true, maxRounds: 3, whenClean: 'push' }
const h = await operatorHarness('rvblock-op', (root) => {
  fs.mkdirSync(path.join(root, 'w', 't'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'w', 'workspace.json'),
    JSON.stringify({
      repos: [
        { name: 'with', url: 'https://github.com/o/with.git', check: 'npm test', review: REVIEW },
        { name: 'bare', url: 'https://github.com/o/bare.git' }
      ],
      envs: []
    })
  )
  fs.writeFileSync(path.join(root, 'w', 't', 'task.json'), JSON.stringify({}))
  fs.writeFileSync(path.join(root, 'agents.json'), JSON.stringify({ a1: { kind: 'claude-code', label: 'Claude' } }))
})
after(() => h.close())

const wsFile = () => fs.readFileSync(path.join(h.GURT_ROOT, 'w', 'workspace.json'), 'utf8')

async function refused(tool, args, entity, what) {
  const before = wsFile()
  const r = await h.call(tool, { ...args, rev: await h.rev(entity) })
  assert.ok(r.isError, `${tool} refused: ${r.text}`)
  assert.match(r.text, /may not be written by the operator/)
  assert.match(r.text, /refused, not held/)
  assert.match(r.text, /Settings → Repos/)
  assert.match(r.text, what)
  assert.equal(wsFile(), before, 'workspace.json untouched')
  assert.equal(h.admin.writes.pending('w', entity), undefined, 'nothing held either')
}

test('update_repo setting or changing a check command is refused', async () => {
  await refused('update_repo', { repo: { name: 'bare', url: 'https://github.com/o/bare.git', check: 'rm -rf /' } }, 'repo:bare', /check command/)
  await refused('update_repo', { repo: { name: 'with', url: 'https://github.com/o/with.git', check: 'true', review: REVIEW } }, 'repo:with', /check command/)
})

test('update_repo clearing a check command is refused too', () =>
  refused('update_repo', { repo: { name: 'with', url: 'https://github.com/o/with.git', review: REVIEW } }, 'repo:with', /check command/))

test('update_repo arming or changing the review defaults is refused', async () => {
  await refused('update_repo', { repo: { name: 'bare', url: 'https://github.com/o/bare.git', review: { enabled: true, whenClean: 'pr' } } }, 'repo:bare', /review defaults/)
  await refused(
    'update_repo',
    { repo: { name: 'with', url: 'https://github.com/o/with.git', check: 'npm test', review: { ...REVIEW, whenClean: 'pr' } } },
    'repo:with',
    /review defaults/
  )
})

test('add_repo carrying either field is refused', async () => {
  await refused('add_repo', { repo: { name: 'new', url: 'https://github.com/o/new.git', check: 'x' } }, 'repo:new', /check command/)
  await refused('add_repo', { repo: { name: 'new', url: 'https://github.com/o/new.git', review: { enabled: true } } }, 'repo:new', /review defaults/)
})

test('a write that leaves both as they are lands', async () => {
  const r = await h.call('update_repo', {
    repo: { name: 'with', url: 'https://github.com/o/with.git', check: 'npm test', review: REVIEW },
    rev: await h.rev('repo:with')
  })
  assert.ok(!r.isError, r.text)
  const added = await h.call('add_repo', { repo: { name: 'plain', url: 'https://github.com/o/plain.git' }, rev: await h.rev('repo:plain') })
  assert.ok(!added.isError, added.text)
  const repos = JSON.parse(wsFile()).repos
  assert.equal(repos.find((x) => x.name === 'with').check, 'npm test')
  assert.deepEqual(repos.find((x) => x.name === 'with').review, REVIEW)
  assert.ok(repos.some((x) => x.name === 'plain'))
})
