// The queue handoff: while something waits in the queue, an idle container is
// blocking it, so the idle grace period is cut short — the environment is
// stopped at once and the scheduler takes the clone. With an empty queue the
// old policy stands (grace period, no immediate stop).
//
// No docker and no agent: `containers.stop` is stubbed with a recorder that
// flips the container record the way a real stop would, and every start fails
// fast on "unknown agent" (agents.json is empty) — the assertions are about the
// scheduling, not about anything coming up.
//
//   node scripts/queue-handoff.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// GURT_ROOT must be set before the store module loads (read at import time).
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-queue-handoff-'))
process.env.GURT_ROOT = GURT_ROOT

const outfile = path.join(os.tmpdir(), `gurt-queue-handoff-${process.pid}.mjs`)
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

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

/** Wait until the session leaves `queued` and report how it settled. */
async function dequeued(kernel, id) {
  for (let i = 0; i < 200; i++) {
    const snap = kernel.sessions.snapshot(id)
    if (snap && snap.info.state !== 'queued') return snap
    await tick(25)
  }
  throw new Error(`session ${id} never left the queue`)
}

after(() => {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

const ws = 'w'
const task = 't'
fs.mkdirSync(path.join(GURT_ROOT, ws, task), { recursive: true })
fs.writeFileSync(
  path.join(GURT_ROOT, ws, 'workspace.json'),
  JSON.stringify({
    repos: [{ name: 'alpha', url: 'https://github.com/o/alpha.git' }],
    envs: [{ name: 'dev', devcontainer: '{"image":"x"}', repo: 'alpha' }]
  })
)
fs.writeFileSync(path.join(GURT_ROOT, ws, task, 'task.json'), JSON.stringify({}))
fs.writeFileSync(path.join(GURT_ROOT, ws, 'agents.json'), JSON.stringify({}))

const kernel = createKernel()
// The boot reconcile asks Docker which containers exist and drops every record
// it does not confirm — including the holder staged below. It runs off the back
// of construction, so on a machine that *has* Docker it lands mid-test and looks
// like the holder's container vanished, freeing the clone the assertions expect
// it to hold. Stage after the boot, not into it.
await kernel.ready
const ref = { workspace: ws, task, env: 'dev' }

// The holder: a *started* session sitting idle on `alpha` with its container
// up — restore is the one public door into that state without an agent.
const holder = 'holder-1'
kernel.sessions.restore([
  {
    info: {
      id: holder,
      env: 'dev',
      repos: ['alpha'],
      task,
      workspace: ws,
      title: 'H',
      agent: 'a1',
      state: 'started',
      startPrompt: 'x'
    },
    log: []
  }
])
const up = () =>
  kernel.sessions.patchContainer(holder, {
    status: 'running',
    id: 'container-h',
    remoteWorkspaceFolder: '/app',
    repos: ['alpha']
  })
const containerStatus = () => kernel.sessions.snapshot(holder).info.container?.status

// Stub the one seam that would need a daemon, and record every stop.
const stops = []
kernel.containers.stop = async (id, reason) => {
  stops.push({ id, reason })
  const c = kernel.sessions.snapshot(id)?.info.container
  if (c) kernel.sessions.patchContainer(id, { ...c, status: 'stopped' })
}

// --- 1. a queue item arriving behind an idle environment frees it now ---
test('enqueue frees an idle environment and the queue advances', async () => {
  up()
  const first = kernel.sessions.createSession(ref, ['alpha'], 'a1', 'hi', 'queue')
  await tick()
  assert.deepEqual(
    stops,
    [{ id: holder, reason: 'queue' }],
    'enqueueing behind an idle container stops it, tagged as a queue handoff'
  )
  const started = await dequeued(kernel, first.id)
  assert.doesNotMatch(
    started.startError ?? '',
    /is in use by session/,
    'the freed clone lets the queued session through the gate'
  )
})

// --- 2. the same thing at the end of a turn ---
// Stage the holder as mid-provision (`post`) so it blocks the gate but is not
// reapable, enqueue behind it, then bring it to `running` and end its turn:
// the turn end alone must trigger the handoff.
test('turn end frees an idle environment and the queue advances', async () => {
  stops.length = 0
  kernel.sessions.patchContainer(holder, {
    status: 'post',
    id: 'container-h',
    remoteWorkspaceFolder: '/app',
    repos: ['alpha']
  })
  const second = kernel.sessions.createSession(ref, ['alpha'], 'a1', 'hi', 'queue')
  await tick()
  assert.equal(stops.length, 0, 'a container mid-provision is never reaped')
  assert.equal(
    kernel.sessions.snapshot(second.id).info.state,
    'queued',
    'and it still holds the clone'
  )
  up()
  kernel.bus.emit('session.turn', { sessionId: holder, ref, phase: 'ended' })
  await tick()
  assert.deepEqual(stops, [{ id: holder, reason: 'queue' }], 'a turn end frees the queue')
  const next = await dequeued(kernel, second.id)
  assert.doesNotMatch(next.startError ?? '', /is in use by session/, 'the second item runs too')
})

// --- 3. nothing queued → the old grace-period policy, untouched ---
test('empty queue keeps the old idle policy', async () => {
  stops.length = 0
  up()
  kernel.bus.emit('session.turn', { sessionId: holder, ref, phase: 'ended' })
  await tick()
  assert.deepEqual(stops, [], 'an empty queue stops nothing at turn end')
  assert.equal(containerStatus(), 'running', 'the container stays up for the grace period')
})

// --- 4. a stop that fails degrades to the grace period, it does not wedge ---
// The stop cancels the pending auto-stop before it goes to docker, so a failure
// leaves the container up with no timer left — and the queue would wait on that
// clone forever. The handoff must hand the session back to the idle policy.
test('a failed handoff falls back to the idle policy', async () => {
  stops.length = 0
  const rearmed = []
  const noteIdle = kernel.containers.noteIdle.bind(kernel.containers)
  kernel.containers.noteIdle = (id) => {
    rearmed.push(id)
    noteIdle(id)
  }
  kernel.containers.stop = async (id, reason) => {
    stops.push({ id, reason })
    throw new Error('docker daemon is not running')
  }
  up()
  const third = kernel.sessions.createSession(ref, ['alpha'], 'a1', 'hi', 'queue')
  await tick()
  assert.deepEqual(stops, [{ id: holder, reason: 'queue' }], 'the handoff tried to stop it')
  assert.equal(containerStatus(), 'running', 'a failed stop leaves the container up')
  assert.ok(rearmed.includes(holder), 'and re-arms the grace period it was cutting short')
  assert.equal(
    kernel.sessions.snapshot(third.id).info.state,
    'queued',
    'the queued session waits rather than starting on a clone that is still held'
  )
})
