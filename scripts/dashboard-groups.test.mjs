// Layout rules for the dashboard's per-workspace board (src/renderer/src/
// components/Dashboard.tsx). Pure functions only — nothing is rendered.
//
// These are worth pinning because they fail silently: a wrong comparator still
// draws a plausible list, just one where the session waiting on you is not the
// one you see first.
//
//   node scripts/dashboard-groups.test.mjs
import { test } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-dash-groups-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await bundle({
  stdin: {
    contents: `export { boardByWorkspace, summarize, COLUMNS } from ${S('src/renderer/src/components/Dashboard.tsx')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})

const { boardByWorkspace, summarize, COLUMNS } = await import(pathToFileURL(outfile).href)

/** A row as `allSessions` builds them. */
const row = (id, status, workspace, task, extra = {}) => ({
  status,
  info: { id, title: extra.title ?? id, workspace, task, incomplete: extra.incomplete },
  finishedAt: extra.finishedAt
})

const QUEUE = COLUMNS.findIndex((c) => c.id === 'queue')
const ACTIVE = COLUMNS.findIndex((c) => c.id === 'active')
const DONE = COLUMNS.findIndex((c) => c.id === 'done')
const ids = (rows) => rows.map((r) => r.info.id)

// --- every status lands in exactly one column --------------------------------
test('every status lands in exactly one column', () => {
  const rows = [
    row('d', 'draft', 'w', 't'),
    row('q', 'queued', 'w', 't'),
    row('r', 'running', 'w', 't'),
    row('a', 'waiting', 'w', 't'),
    row('s', 'starting', 'w', 't'),
    row('f', 'idle', 'w', 't', { finishedAt: '2026-08-19T10:00:00Z' })
  ]
  const [b] = boardByWorkspace(rows, {})
  assert.equal(b.key, 'w')
  assert.equal(b.total, 6)
  assert.deepEqual(ids(b.columns[QUEUE]), ['q', 'd'], 'queued sits above draft — it is next to run')
  assert.deepEqual(ids(b.columns[ACTIVE]), ['a', 'r', 's'], 'waiting → running → starting')
  assert.deepEqual(ids(b.columns[DONE]), ['f'])
  assert.equal(
    b.columns.flat().length,
    rows.length,
    'no row is dropped and none is counted twice'
  )
})

test('urgency ranks across the whole workspace, not per task', () => {
  // Urgency ranks across the whole workspace: a task boundary must not push the
  // session that needs you below one that does not.
  const [b] = boardByWorkspace(
    [row('r', 'running', 'w', 'alpha'), row('a', 'waiting', 'w', 'zeta')],
    {}
  )
  assert.deepEqual(ids(b.columns[ACTIVE]), ['a', 'r'], 'sorted by status, not bucketed by task')
})

test('queue order is real order, not alphabetical', () => {
  // Queue order is real order, not alphabetical.
  const [b] = boardByWorkspace(
    [row('z', 'queued', 'w', 't'), row('a', 'queued', 'w', 't')],
    { z: 1, a: 2 }
  )
  assert.deepEqual(ids(b.columns[QUEUE]), ['z', 'a'], 'a queued session keeps its queue position')
})

test('same rank, no queue position: task then title', () => {
  // Same rank, no queue position: task then title, so re-renders can't shuffle
  // rows and one task's sessions stay adjacent.
  const [b] = boardByWorkspace(
    [
      row('2', 'draft', 'w', 'b', { title: 'beta' }),
      row('1', 'draft', 'w', 'a', { title: 'alpha' }),
      row('3', 'draft', 'w', 'a', { title: 'zulu' })
    ],
    {}
  )
  assert.deepEqual(ids(b.columns[QUEUE]), ['1', '3', '2'])
})

test('DONE reads newest-first', () => {
  // DONE reads newest-first, regardless of what the rows arrived in.
  const [b] = boardByWorkspace(
    [
      row('old', 'idle', 'w', 't', { finishedAt: '2026-08-19T08:00:00Z' }),
      row('new', 'idle', 'w', 't', { finishedAt: '2026-08-19T12:00:00Z' }),
      row('mid', 'idle', 'w', 't', { finishedAt: '2026-08-19T10:00:00Z' })
    ],
    {}
  )
  assert.deepEqual(ids(b.columns[DONE]), ['new', 'mid', 'old'])
})

// --- boards: most urgent workspace first, regardless of size ------------------
test('boards: most urgent workspace first, regardless of size', () => {
  const rows = [
    row('d1', 'draft', 'drafty', 't'),
    row('d2', 'draft', 'drafty', 't'),
    row('d3', 'draft', 'drafty', 't'),
    row('w1', 'waiting', 'blocked', 't'),
    row('r1', 'running', 'busy', 't')
  ]
  assert.deepEqual(
    boardByWorkspace(rows, {}).map((b) => b.key),
    ['blocked', 'busy', 'drafty'],
    'one session needing you outranks a workspace holding three drafts'
  )
})

test('a workspace whose only rows are finished sorts last', () => {
  // A workspace whose only rows are finished sorts last — nothing there is moving.
  assert.deepEqual(
    boardByWorkspace(
      [
        row('f', 'idle', 'aaa', 't', { finishedAt: '2026-08-19T10:00:00Z' }),
        row('q', 'queued', 'zzz', 't')
      ],
      {}
    ).map((b) => b.key),
    ['zzz', 'aaa']
  )
})

test('workspaces that tie on urgency are ordered by name', () => {
  // Workspaces that tie on urgency are ordered by name, so the board is stable.
  assert.deepEqual(
    boardByWorkspace(
      [row('a', 'running', 'zeta', 't'), row('b', 'running', 'alpha', 't')],
      {}
    ).map((b) => b.key),
    ['alpha', 'zeta']
  )
})

test('same task name in two workspaces stays in two boards', () => {
  // Same task name in two workspaces stays in two boards, never merged.
  const boards = boardByWorkspace(
    [row('a', 'running', 'work', 'api'), row('b', 'running', 'personal', 'api')],
    {}
  )
  assert.deepEqual(
    boards.map((b) => b.key),
    ['personal', 'work']
  )
  assert.equal(boards[0].total, 1)
})

test('no rows, no boards', () => {
  assert.deepEqual(boardByWorkspace([], {}), [])
})

// --- the folded summary ------------------------------------------------------
test('the folded summary', () => {
  assert.equal(summarize([]), '')
  assert.equal(summarize([row('a', 'waiting', 'w', 't')]), '1 needs you')
  assert.equal(
    summarize([row('a', 'running', 'w', 't'), row('b', 'starting', 'w', 't')]),
    '2 running',
    'starting counts as running — both mean the thing is moving'
  )
  assert.equal(summarize([row('a', 'draft', 'w', 't')]), '1 draft')
  assert.equal(summarize([row('a', 'draft', 'w', 't'), row('b', 'draft', 'w', 't')]), '2 drafts')
  assert.equal(
    summarize([
      row('a', 'draft', 'w', 't'),
      row('b', 'waiting', 'w', 't'),
      row('c', 'queued', 'w', 't'),
      row('d', 'running', 'w', 't'),
      row('e', 'idle', 'w', 't')
    ]),
    '1 needs you · 1 running · 1 queued · 1 draft · 1 to review',
    'summary reads left-to-right the way the board does'
  )
})
