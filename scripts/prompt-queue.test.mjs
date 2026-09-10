// The composer's prompt queue: what happens to a message sent to a session that
// cannot run it yet (src/main/sessions.ts, `drainPending`).
//
// The composer no longer refuses those sends — it accepts them and shows what
// is waiting, so the queue is now the thing that must not lose a message. Two
// waits put a prompt there, and only the second is reachable without an agent:
//
//   1. a turn already running — the drain loop takes the next one when it ends;
//   2. the session's clone is somebody else's. A started session whose
//      container was stopped (the queue handoff does exactly that) cannot
//      attach while another session is on the working tree, so its prompt waits
//      for the repo instead of failing against it.
//
// What is asserted here is (2) plus the two ways out of the queue, because both
// are how a queued message avoids being silently eaten: `clearPending` (Esc)
// and `cancelPending` (a row's own cancel) hand the prompt back to the caller,
// which is what lets the composer put the text where it was typed.
//
// Sessions are restored from disk already `started`: that is the one way to
// reach `prompt()` with no docker and no agent, and it is a real state (it is
// how every session comes back after a restart).
//
//   node scripts/prompt-queue.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

// store.ts reads GURT_ROOT at module load — set it before the import.
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-prompt-queue-'))
process.env.GURT_ROOT = GURT_ROOT

const outfile = path.join(os.tmpdir(), `gurt-prompt-queue-${process.pid}.mjs`)
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
    repos: [
      { name: 'alpha', url: 'https://github.com/o/alpha.git' },
      { name: 'beta', url: 'https://github.com/o/beta.git' }
    ],
    envs: [{ name: 'dev', devcontainer: '{"image":"x"}', repo: 'alpha' }]
  })
)
fs.writeFileSync(path.join(GURT_ROOT, ws, task, 'task.json'), JSON.stringify({}))
fs.writeFileSync(path.join(GURT_ROOT, ws, 'agents.json'), JSON.stringify({}))

const started = (id, title, repo = 'alpha') => ({
  info: {
    id,
    env: 'dev',
    role: 'executor',
    repos: [repo],
    task,
    workspace: ws,
    title,
    agent: 'a1',
    state: 'started',
    mcp: [],
    startPrompt: 'go'
  },
  acpSessionId: `acp-${id}`
})
fs.writeFileSync(
  path.join(GURT_ROOT, ws, task, 'sessions.json'),
  JSON.stringify([
    started('sa', 'A'),
    started('sb', 'B'),
    // A second pair on their own clone, untouched by every test below: the
    // handoff trigger is asserted against sessions whose state no earlier test
    // can have moved.
    started('sc', 'C', 'beta'),
    started('sd', 'D', 'beta')
  ])
)

const kernel = createKernel()
// The boot reconcile drops every container record docker does not confirm, so
// the holder below is staged after it (see session-repo-gate.test.mjs).
await kernel.ready
kernel.sessions.patchContainer('sa', {
  status: 'running',
  id: 'container-a',
  remoteWorkspaceFolder: '/app',
  repos: ['alpha']
})

// Queueing a prompt is itself a queue-handoff trigger, so every prompt in this
// file now asks the container manager to stop the holder — stub it before the
// first one, or the tests reach for a daemon that may or may not be there.
// Recording only: a stub that also freed the clone would move the very queue
// these tests are watching.
const stops = []
kernel.containers.stop = async (id, reason) => {
  stops.push({ id, reason })
}

test('a prompt to a session whose clone is held waits instead of failing', async () => {
  await kernel.sessions.prompt('sb', 'rebase onto main')
  const snap = kernel.sessions.snapshot('sb')
  assert.equal(snap.busy, false, 'no turn was started')
  assert.deepEqual(
    snap.pending.map((p) => p.text),
    ['rebase onto main'],
    'the message is in the queue, not lost and not run'
  )
  assert.match(
    snap.pendingBlocked ?? '',
    /session "A" has "alpha"/,
    'the pane is told which session it is waiting for, by name'
  )
  // Nothing was written to the timeline: a wait is not an error.
  assert.equal(
    (kernel.sessions.snapshot('sb').entries ?? []).filter((e) => /error/.test(e.text ?? '')).length,
    0,
    'waiting for a repo never surfaces as a failed turn'
  )
})

test('the queue handoff frees a waiting prompt, not just a queued draft', () => {
  assert.deepEqual(
    kernel.sessions.holdersBlockingQueue(),
    ['sa'],
    'the idle holder is reaped for B, which has a prompt on that clone'
  )
})

test('a second prompt queues behind the first, in order', async () => {
  await kernel.sessions.prompt('sb', 'and push it')
  assert.deepEqual(
    kernel.sessions.snapshot('sb').pending.map((p) => p.text),
    ['rebase onto main', 'and push it'],
    'oldest first'
  )
})

test('one prompt can be taken back out of the queue, by id', async () => {
  const [, second] = kernel.sessions.snapshot('sb').pending
  const gone = kernel.sessions.cancelPending('sb', second.id)
  assert.equal(gone.text, 'and push it', 'the cancelled prompt is handed back, not just dropped')
  assert.deepEqual(
    kernel.sessions.snapshot('sb').pending.map((p) => p.text),
    ['rebase onto main'],
    'and only that one leaves'
  )
  assert.equal(
    kernel.sessions.cancelPending('sb', second.id),
    undefined,
    'cancelling it twice is a no-op, not a mistake with the neighbour'
  )
})

test('stopping hands the whole queue back with its context', async () => {
  await kernel.sessions.prompt('sb', 'also update the docs', [{ name: 'r.md', path: 'r.md' }])
  const dropped = kernel.sessions.clearPending('sb')
  assert.deepEqual(
    dropped.map((p) => p.text),
    ['rebase onto main', 'also update the docs'],
    'everything comes back, in order, so the composer can restore it'
  )
  assert.deepEqual(dropped[1].context, [{ name: 'r.md', path: 'r.md' }], 'chips ride along')
  assert.equal(kernel.sessions.snapshot('sb').pending, undefined, 'and the queue is empty')
  assert.equal(kernel.sessions.snapshot('sb').pendingBlocked, undefined, 'with nothing left to explain')
})

test('a released clone lets the queue move again', async () => {
  await kernel.sessions.prompt('sb', 'go on then')
  assert.equal(kernel.sessions.snapshot('sb').pending.length, 1, 'queued while A holds alpha')
  // A goes away; the scheduler's pass is what drains prompts that were waiting
  // on a repo. With no docker the turn cannot actually run — what is asserted
  // is that the prompt *left the queue*, i.e. that the drain reached it.
  kernel.sessions.patchContainer('sa', undefined)
  kernel.sessions.schedule()
  for (let i = 0; i < 100 && kernel.sessions.snapshot('sb').pending; i++)
    await new Promise((r) => setTimeout(r, 25))
  assert.equal(
    kernel.sessions.snapshot('sb').pending,
    undefined,
    'freeing the repo takes the prompt out of the queue and runs it'
  )
})

// The queue only ever moves when a container comes down, and the holder's own
// turn ended before this message was typed — so queueing it has to be a trigger
// of its own. Without one the prompt waits out the ten-minute grace period.
//
// C and D are used here and nowhere else: the assertion is about what queueing
// a prompt does, and reusing B would make it about whatever B's last turn left
// behind (with a real docker on the machine, a turn that is still running).
test('queueing a prompt reaps the idle holder that is blocking it', () => {
  kernel.sessions.patchContainer('sc', {
    status: 'running',
    id: 'container-c',
    remoteWorkspaceFolder: '/app',
    repos: ['beta']
  })
  // Read synchronously, with no tick in between: the point is that queueing the
  // prompt *is* the trigger, so the stop is already recorded when `prompt`
  // returns. A window here would also let an earlier test's turn end land its
  // own handoff pass in the middle of the assertion.
  const before = stops.length
  const sent = kernel.sessions.prompt('sd', 'one more thing')
  assert.deepEqual(
    stops.slice(before),
    [{ id: 'sc', reason: 'queue' }],
    'the message waiting on beta stops the idle session sitting on it, at once'
  )
  return sent
})
