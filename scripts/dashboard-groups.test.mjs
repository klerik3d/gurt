// Ordering rules for the dashboard's session list (src/renderer/src/components/
// Dashboard.tsx). Pure functions only — nothing is rendered.
//
// These are worth pinning because they fail silently: a wrong comparator still
// draws a plausible list, just one where the session waiting on you is not the
// one you see first.
//
//   node scripts/dashboard-groups.test.mjs
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-dash-groups-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await build({
  stdin: {
    contents: `export { groupByWorkspace, summarize } from ${S('src/renderer/src/components/Dashboard.tsx')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  mainFields: ['module', 'main'],
  outfile,
  logLevel: 'silent'
})

const { groupByWorkspace, summarize } = await import(pathToFileURL(outfile).href)

/** A row as `allSessions` builds them. */
const row = (id, status, workspace, task, title = id) => ({
  status,
  info: { id, title, workspace, task }
})

// --- rows inside a group: urgency first --------------------------------------
{
  const rows = [
    row('d', 'draft', 'w', 't'),
    row('q', 'queued', 'w', 't'),
    row('r', 'running', 'w', 't'),
    row('a', 'waiting', 'w', 't'),
    row('s', 'starting', 'w', 't')
  ]
  const [g] = groupByWorkspace(rows, {})
  assert.deepEqual(
    g.rows.map((r) => r.info.id),
    ['a', 'r', 's', 'q', 'd'],
    'waiting → running → starting → queued → draft'
  )
  assert.equal(g.key, 'w')
}

{
  // Urgency ranks across the whole workspace: a task boundary must not push the
  // session that needs you below one that doesn't.
  const rows = [
    row('d', 'draft', 'w', 'alpha'),
    row('a', 'waiting', 'w', 'zeta'),
    row('r', 'running', 'w', 'alpha')
  ]
  const [g] = groupByWorkspace(rows, {})
  assert.deepEqual(
    g.rows.map((r) => r.info.id),
    ['a', 'r', 'd'],
    'sorted by status, not bucketed by task'
  )
}

{
  // Queue order is real order, not alphabetical.
  const rows = [row('z', 'queued', 'w', 't'), row('a', 'queued', 'w', 't')]
  const [g] = groupByWorkspace(rows, { z: 1, a: 2 })
  assert.deepEqual(
    g.rows.map((r) => r.info.id),
    ['z', 'a'],
    'a queued session keeps its position in the global queue'
  )
}

{
  // Same rank, no queue position: task then title, so re-renders can't shuffle
  // rows and one task's sessions stay adjacent.
  const rows = [
    row('2', 'draft', 'w', 'b', 'beta'),
    row('1', 'draft', 'w', 'a', 'alpha'),
    row('3', 'draft', 'w', 'a', 'zulu')
  ]
  const [g] = groupByWorkspace(rows, {})
  assert.deepEqual(
    g.rows.map((r) => r.info.title),
    ['alpha', 'zulu', 'beta']
  )
}

// --- groups: most urgent workspace first, regardless of size ------------------
{
  const rows = [
    row('d1', 'draft', 'drafty', 't'),
    row('d2', 'draft', 'drafty', 't'),
    row('d3', 'draft', 'drafty', 't'),
    row('w1', 'waiting', 'blocked', 't'),
    row('r1', 'running', 'busy', 't')
  ]
  const groups = groupByWorkspace(rows, {})
  assert.deepEqual(
    groups.map((g) => g.key),
    ['blocked', 'busy', 'drafty'],
    'one session needing you outranks a workspace holding three drafts'
  )
}

{
  // Workspaces that tie on urgency are ordered by name, so the list is stable
  // and the same workspace always sits in the same place.
  const groups = groupByWorkspace(
    [row('a', 'running', 'zeta', 't'), row('b', 'running', 'alpha', 't')],
    {}
  )
  assert.deepEqual(
    groups.map((g) => g.key),
    ['alpha', 'zeta']
  )
}

{
  // Same task name in two workspaces stays in two groups, never merged.
  const groups = groupByWorkspace(
    [row('a', 'running', 'work', 'api'), row('b', 'running', 'personal', 'api')],
    {}
  )
  assert.deepEqual(
    groups.map((g) => g.key),
    ['personal', 'work']
  )
  assert.equal(groups[0].rows.length, 1)
}

assert.deepEqual(groupByWorkspace([], {}), [])

// --- the collapsed summary ---------------------------------------------------
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
    row('d', 'running', 'w', 't')
  ]),
  '1 needs you · 1 running · 1 queued · 1 draft',
  'summary reads in the same urgency order the rows do'
)

console.log('dashboard-groups: ok')
