// Per-task cap on concurrently running sessions (`TaskFile.maxConcurrentSessions`,
// docs/requirements-session-queue.md §3's "future conditions... slot in without
// reshaping the scheduler" extension point).
//
// The cap is task-wide, not per-repo — unlike the clone lock (session-repo-gate.
// test.mjs), two sessions on *different* repos of the same task still contend
// for the same slot once a cap is set. "Currently running" reuses the clone
// lock's own definition of active (mid-start, or owning a live container): an
// idle session holding nothing does not count against the cap, same as it does
// not hold a clone.
//
// Each test uses its own task name so cap state from one test can never leak
// into the next — `setTaskMaxConcurrentSessions`/`saveTask` create the task
// directory on demand, so nothing needs pre-creating on disk.
//
//   node scripts/task-concurrency-cap.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// GURT_ROOT must be set before the store module loads (read at import time).
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-task-cap-'))
process.env.GURT_ROOT = GURT_ROOT

const outfile = path.join(os.tmpdir(), `gurt-task-cap-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await bundle({
  stdin: {
    contents: `export { createKernel } from ${S('src/main/kernel.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})

const { createKernel } = await import(pathToFileURL(outfile).href)

/** Wait until the session leaves `starting` and report how it settled. */
async function settle(kernel, id) {
  for (let i = 0; i < 200; i++) {
    const snap = kernel.sessions.snapshot(id)
    if (snap && snap.info.state !== 'starting') return snap
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`session ${id} never left "starting"`)
}

after(() => {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

const ws = 'w'
fs.mkdirSync(path.join(GURT_ROOT, ws), { recursive: true })
fs.writeFileSync(
  path.join(GURT_ROOT, ws, 'workspace.json'),
  JSON.stringify({
    repos: [
      { name: 'alpha', url: 'https://github.com/o/alpha.git' },
      { name: 'beta', url: 'https://github.com/o/beta.git' }
    ],
    envs: [{ name: 'dev', devcontainer: '{"image":"x"}', repo: 'alpha' }]
  })
)
fs.writeFileSync(path.join(GURT_ROOT, ws, 'agents.json'), JSON.stringify({}))

const kernel = createKernel()
// Same reason as session-repo-gate.test.mjs: let the boot reconcile finish
// before staging container records of our own.
await kernel.ready

let nextTask = 0
/** A fresh, isolated (workspace, task) ref — nothing from a prior test's
 *  active/queued sessions can count against this one's cap. */
function newRef() {
  const task = `t${nextTask++}`
  fs.mkdirSync(path.join(GURT_ROOT, ws, task), { recursive: true })
  fs.writeFileSync(path.join(GURT_ROOT, ws, task, 'task.json'), JSON.stringify({}))
  return { workspace: ws, task, env: 'dev' }
}

const mk = (ref, repo, title) => {
  const info = kernel.sessions.createSession(ref, [repo], 'a1', 'hi', 'draft')
  kernel.sessions.renameSession(info.id, title)
  return info.id
}
/** Simulate a session actively occupying its container, without a daemon —
 *  same technique as session-repo-gate.test.mjs: `isActive`/`repoHolder` key
 *  off the container record, not off actually having started. */
const markActive = (id, repo) =>
  kernel.sessions.patchContainer(id, {
    status: 'running',
    id: `container-${id}`,
    remoteWorkspaceFolder: '/app',
    repos: [repo]
  })
const markIdle = (id) => kernel.sessions.patchContainer(id, undefined)

test('unset cap: run() starts immediately regardless of what else is active', async () => {
  const ref = newRef()
  const a = mk(ref, 'alpha', 'A')
  const b = mk(ref, 'beta', 'B')
  markActive(a, 'alpha')
  kernel.sessions.run(b)
  const snap = await settle(kernel, b)
  assert.notEqual(snap.info.state, 'queued', 'no cap set — run() must not fall back to the queue')
})

test('cap of 1: run() on a second session of the same task falls back to the queue', async () => {
  const ref = newRef()
  const a = mk(ref, 'alpha', 'A')
  const b = mk(ref, 'beta', 'B')
  markActive(a, 'alpha')
  await kernel.setTaskMaxConcurrentSessions(ref.workspace, ref.task, 1)

  kernel.sessions.run(b)
  const queued = kernel.sessions.snapshot(b)
  assert.equal(queued.info.state, 'queued', '"Run now" queues instead of jumping ahead of a full task')
  assert.ok(queued.info.queuedAt, 'queued session carries a FIFO timestamp')

  // Freeing the slot lets the scheduler take it from the queue on the next pass.
  markIdle(a)
  kernel.sessions.schedule()
  const settled = await settle(kernel, b)
  assert.notEqual(settled.info.state, 'queued', 'freeing the cap lets the queued session start')
})

test('cap is task-wide: it gates across repos, unlike the per-repo clone lock', async () => {
  const ref = newRef()
  await kernel.setTaskMaxConcurrentSessions(ref.workspace, ref.task, 1)
  const a = mk(ref, 'alpha', 'A')
  const b = mk(ref, 'beta', 'B')
  markActive(a, 'alpha')

  kernel.sessions.enqueue(b)
  kernel.sessions.schedule()
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(
    kernel.sessions.snapshot(b).info.state,
    'queued',
    "a different repo does not exempt it from the same task's cap"
  )

  markIdle(a)
  kernel.sessions.schedule()
  const settled = await settle(kernel, b)
  assert.notEqual(settled.info.state, 'queued')
})

test('cap of 1: the scheduler starts only the earlier queued item per pass', async () => {
  const ref = newRef()
  await kernel.setTaskMaxConcurrentSessions(ref.workspace, ref.task, 1)
  const a = mk(ref, 'alpha', 'A')
  const b = mk(ref, 'beta', 'B')
  // `enqueue` runs the scheduler synchronously, and `startSession` flips state
  // to "starting" synchronously too, before its first `await` — so right after
  // these two calls (nothing awaited yet), A's start is under way and B's is
  // gated by it. Checked before either settles: a real start attempt fails
  // near-instantly with no daemon here, which would otherwise free the slot
  // for B before we get to look.
  kernel.sessions.enqueue(a)
  kernel.sessions.enqueue(b)
  assert.equal(kernel.sessions.snapshot(a).info.state, 'starting', 'earlier item takes the slot')
  assert.equal(kernel.sessions.snapshot(b).info.state, 'queued', 'later item waits its turn')

  await settle(kernel, a)
})

test('clearing the cap (undefined) restores unlimited concurrency', async () => {
  const ref = newRef()
  await kernel.setTaskMaxConcurrentSessions(ref.workspace, ref.task, 1)
  const a = mk(ref, 'alpha', 'A')
  const b = mk(ref, 'beta', 'B')
  markActive(a, 'alpha')
  kernel.sessions.enqueue(b)
  kernel.sessions.schedule()
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(kernel.sessions.snapshot(b).info.state, 'queued', 'still capped')

  await kernel.setTaskMaxConcurrentSessions(ref.workspace, ref.task, undefined)
  const settled = await settle(kernel, b)
  assert.notEqual(settled.info.state, 'queued', 'clearing the cap lets it through with A still active')
})

test('createSession(..., "run") respects the cap the same way run() does', async () => {
  const ref = newRef()
  const a = mk(ref, 'alpha', 'A')
  markActive(a, 'alpha')
  await kernel.setTaskMaxConcurrentSessions(ref.workspace, ref.task, 1)

  const info = kernel.sessions.createSession(ref, ['beta'], 'a1', 'hi', 'run')
  const queued = kernel.sessions.snapshot(info.id)
  assert.equal(queued.info.state, 'queued', 'action "run" queues too once the task is at its cap')
})
