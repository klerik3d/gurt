// Shared ordering and filtering of the scope list in all work modes.
// Pure comparator only — nothing is rendered.
//
// Worth pinning for the same reason as the dashboard's: a wrong comparator
// still draws a plausible list, and the tree it orders is also what the arrow
// keys walk, so a mismatch shows up as navigation jumping around.
//
//   node scripts/sidebar-task-sort.test.mjs
import { test } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-sidebar-sort-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await bundle({
  stdin: {
    contents: `export { nestReviews, sortTasks, scopeFilter, SORT_DIR_LABEL, SORT_KEY_LABEL } from ${S('src/renderer/src/useScopeList.ts')}`,
    resolveDir: ROOT,
    loader: 'tsx',
    sourcefile: 'entry.tsx'
  },
  outfile
})

const { sortTasks, scopeFilter, SORT_DIR_LABEL, SORT_KEY_LABEL } = await import(pathToFileURL(outfile).href)

const task = (name, createdAt) => ({ name, createdAt })
const names = (rows) => rows.map((t) => t.name)

test('scope filtering supports regex, ignores case and accepts an empty filter', () => {
  const tasks = [task('api-2'), task('API-10'), task('frontend'), task('my-api')]
  const filter = scopeFilter('^api-\\d+$')
  assert.equal(filter.error, '')
  assert.deepEqual(names(tasks.filter((t) => filter.pattern.test(t.name))), ['api-2', 'API-10'])
  assert.equal(scopeFilter('').pattern, null)
  assert.equal(scopeFilter('').error, '')
  assert.ok(scopeFilter('[').error, 'invalid regex produces a visible error without crashing')
  assert.equal(scopeFilter('[').pattern, null, 'invalid regex keeps scopes visible')
})

// --- by name -----------------------------------------------------------------
test('name sorts case-insensitively and numerically, both directions', () => {
  const tasks = [task('beta'), task('Alpha'), task('task-10'), task('task-2')]
  assert.deepEqual(
    names(sortTasks(tasks, { key: 'name', dir: 'asc' })),
    ['Alpha', 'beta', 'task-2', 'task-10'],
    'case is ignored and 10 sorts after 2, not before it'
  )
  assert.deepEqual(names(sortTasks(tasks, { key: 'name', dir: 'desc' })), [
    'task-10',
    'task-2',
    'beta',
    'Alpha'
  ])
})

test('names differing only in case get a stable, exact tiebreak', () => {
  const one = names(sortTasks([task('API'), task('api')], { key: 'name', dir: 'asc' }))
  const other = names(sortTasks([task('api'), task('API')], { key: 'name', dir: 'asc' }))
  assert.deepEqual(one, other, 'input order must not decide it — readdir order is not stable')
})

// --- by creation time --------------------------------------------------------
test('created sorts oldest-first ascending, newest-first descending', () => {
  const tasks = [
    task('mid', '2026-05-01T00:00:00.000Z'),
    task('new', '2026-08-01T00:00:00.000Z'),
    task('old', '2026-01-01T00:00:00.000Z')
  ]
  assert.deepEqual(names(sortTasks(tasks, { key: 'created', dir: 'asc' })), ['old', 'mid', 'new'])
  assert.deepEqual(names(sortTasks(tasks, { key: 'created', dir: 'desc' })), ['new', 'mid', 'old'])
})

test('tasks created in the same instant fall back to the name', () => {
  const t = '2026-05-01T00:00:00.000Z'
  const tasks = [task('zeta', t), task('alpha', t), task('mid', t)]
  assert.deepEqual(names(sortTasks(tasks, { key: 'created', dir: 'asc' })), [
    'alpha',
    'mid',
    'zeta'
  ])
})

test('a task with no creation time sorts oldest, not last', () => {
  const tasks = [task('dated', '2026-01-01T00:00:00.000Z'), task('undated', undefined)]
  assert.deepEqual(names(sortTasks(tasks, { key: 'created', dir: 'asc' })), ['undated', 'dated'])
})

// --- the caller's array is never touched -------------------------------------
test('sortTasks does not reorder its input', () => {
  const tasks = [task('b'), task('a')]
  sortTasks(tasks, { key: 'name', dir: 'desc' })
  assert.deepEqual(names(tasks), ['b', 'a'], 'the tree snapshot is shared — it must not be sorted in place')
})

// --- labels ------------------------------------------------------------------
test('every key/direction pair has a label to show', () => {
  for (const key of ['name', 'created']) {
    assert.ok(SORT_KEY_LABEL[key], `${key} has a menu label`)
    for (const dir of ['asc', 'desc']) assert.ok(SORT_DIR_LABEL[key][dir], `${key}/${dir} labelled`)
  }
  assert.notEqual(
    SORT_DIR_LABEL.name.asc,
    SORT_DIR_LABEL.created.asc,
    'the same direction reads differently per key — that is the point of the table'
  )
})

// Loop reviewers hang under their executor: the sidebar shows (and the arrow
// keys walk) the nested order, so a wrong grouping misplaces rows quietly.
const { nestReviews } = await import(pathToFileURL(outfile).href)

test('nestReviews files reviewers under their executor in round order', () => {
  const s = (id, reviewOf) => ({ id, ...(reviewOf ? { reviewOf: { intent: 'i', ...reviewOf } } : {}) })
  const out = nestReviews([s('r2', { executor: 'e', round: 2 }), s('e'), s('x'), s('r1', { executor: 'e', round: 1 })])
  assert.deepEqual(
    out.map((n) => [n.session.id, n.reviews.map((r) => r.id)]),
    [['e', ['r1', 'r2']], ['x', []]]
  )
})

test('nestReviews keeps a reviewer whose executor is gone at the top level', () => {
  const out = nestReviews([{ id: 'r', reviewOf: { executor: 'gone', round: 1, intent: 'i' } }])
  assert.deepEqual(out.map((n) => n.session.id), ['r'])
})
