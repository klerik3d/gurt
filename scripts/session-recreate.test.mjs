// Recreating a session turns a launched one back into a draft with the same
// configuration — "I ran it, then saw it was set up wrong".
//
// What matters: the run is gone whole (the old record, its container, its chat
// log, its mount scratch) and what is left is indistinguishable from a freshly
// created draft carrying the same user choices, under the same title and in
// the same slot of the task. A draft is refused — there is no run to discard.
//
// Docker is a shim on PATH (as in session-delete-container.test.mjs): `ps`
// fails, so the boot reconcile reads the daemon as unreachable; everything else
// succeeds and is recorded, which is how the container `rm` is observed. No
// agent ever runs: a session leaves draft by being enqueued, which starts it
// (`starting`) — the state a misconfigured session is usually caught in.
//
//   node scripts/session-recreate.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// GURT_ROOT must be set before the store module loads (read at import time).
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-recreate-'))
process.env.GURT_ROOT = GURT_ROOT

const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-recreate-bin-'))
const CALLS = path.join(BIN, 'calls.log')
fs.writeFileSync(
  path.join(BIN, 'docker'),
  `#!/bin/sh
echo "$@" >> "$DOCKER_CALLS"
case "$1" in
  ps) exit 1 ;;
  *) exit 0 ;;
esac
`,
  { mode: 0o755 }
)
process.env.DOCKER_CALLS = CALLS
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`

const outfile = path.join(os.tmpdir(), `gurt-recreate-${process.pid}.mjs`)
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Poll until `fn()` is truthy (or give up after ~5s). */
async function until(fn) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return true
    await sleep(25)
  }
  return false
}

const dockerCalled = (re) =>
  fs.existsSync(CALLS) && fs.readFileSync(CALLS, 'utf8').split('\n').some((l) => re.test(l.trim()))

after(() => {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(BIN, { recursive: true, force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

const ws = 'w'
const task = 't'
const taskDir = path.join(GURT_ROOT, ws, task)
fs.mkdirSync(taskDir, { recursive: true })
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
fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({}))
fs.writeFileSync(path.join(GURT_ROOT, ws, 'agents.json'), JSON.stringify({}))

const kernel = createKernel()
const ref = { workspace: ws, task, env: 'dev' }
const taskIds = () =>
  kernel.sessions
    .allSessions()
    .filter((i) => i.workspace === ws && i.task === task)
    .map((i) => i.id)

let before
let target
let afterIt
let draft

test('a launched session comes back as a draft with the same configuration', async () => {
  before = kernel.sessions.createSession(ref, ['beta'], 'a1', 'first', 'draft')
  target = kernel.sessions.createSession(
    ref,
    ['alpha'],
    'a1',
    'fix the login bug',
    'draft',
    [{ id: 'github', mode: 'read-only' }],
    false,
    { model: 'opus' },
    'executor',
    [{ name: 'tdd' }],
    { internal: true }
  )
  kernel.sessions.renameSession(target.id, 'login')
  afterIt = kernel.sessions.createSession(ref, ['beta'], 'a1', 'last', 'draft')

  // Stage a live container the way the container manager would, and a mount
  // scratch / history dir, then launch.
  kernel.sessions.patchContainer(target.id, {
    status: 'running',
    id: 'container-r',
    remoteWorkspaceFolder: '/app',
    repos: ['alpha']
  })
  const scratchRoot = path.join(taskDir, '.multirepo', target.id)
  fs.mkdirSync(path.join(scratchRoot, 'history', 'claude-projects'), { recursive: true })
  kernel.sessions.enqueue(target.id)
  assert.notEqual(kernel.sessions.snapshot(target.id).info.state, 'draft', 'the session has left draft')

  draft = kernel.sessions.recreateSession(target.id)

  assert.equal(kernel.sessions.snapshot(target.id), undefined, 'the launched session is gone')
  assert.notEqual(draft.id, target.id, 'the draft is a new session')
  const info = kernel.sessions.snapshot(draft.id).info
  assert.equal(info.state, 'draft')
  assert.equal(info.title, 'login', 'the title is kept, not "(copy)"')
  assert.equal(info.startPrompt, 'fix the login bug')
  assert.equal(info.env, 'dev')
  assert.deepEqual(info.repos, ['alpha'])
  assert.equal(info.agent, 'a1')
  assert.equal(info.role, 'executor')
  assert.equal(info.autoAllow, false)
  assert.deepEqual(info.mcp, [{ id: 'github', mode: 'read-only' }])
  assert.deepEqual(info.configValues, { model: 'opus' })
  assert.deepEqual(info.skills, [{ name: 'tdd' }])
  assert.deepEqual(info.network, { internal: true })
  assert.equal(info.container, undefined, 'the draft owns no container')
  assert.equal(info.queuedAt, undefined, 'the draft takes no queue slot')
  const snap = kernel.sessions.snapshot(draft.id)
  assert.deepEqual(snap.entries, [], 'the chat starts empty')
  assert.equal(snap.startError, undefined)
  assert.equal(snap.pending, undefined)

  assert.deepEqual(taskIds(), [before.id, draft.id, afterIt.id], 'the draft keeps the original slot')

  assert.ok(
    await until(() => dockerCalled(/^rm -fv container-r$/)),
    "the run's container is removed"
  )
  assert.ok(await until(() => !fs.existsSync(scratchRoot)), "the run's scratch/history goes with it")
})

test('on disk the result is just a draft, in order, with no old log', async () => {
  const file = path.join(taskDir, 'sessions.json')
  let ids = []
  await until(() => {
    if (!fs.existsSync(file)) return false
    ids = JSON.parse(fs.readFileSync(file, 'utf8')).map((r) => r.info.id)
    return !ids.includes(target.id) && ids.includes(draft.id)
  })
  assert.deepEqual(ids, [before.id, draft.id, afterIt.id])
  const rec = JSON.parse(fs.readFileSync(file, 'utf8')).find((r) => r.info.id === draft.id)
  assert.equal(rec.info.state, 'draft')
  assert.equal(rec.acpSessionId, undefined)
  assert.equal(rec.info.container, undefined)
  assert.ok(
    await until(() => !fs.existsSync(path.join(taskDir, 'sessions', `${target.id}.jsonl`))),
    "the old run's chat log is removed"
  )
})

test('an operator (no repo) recreates too', () => {
  const op = kernel.sessions.createSession(ref, [], 'a1', 'look around', 'draft', [], true, {}, 'operator')
  kernel.sessions.enqueue(op.id)
  assert.notEqual(kernel.sessions.snapshot(op.id).info.state, 'draft')
  const back = kernel.sessions.recreateSession(op.id)
  const info = kernel.sessions.snapshot(back.id).info
  assert.equal(info.state, 'draft')
  assert.equal(info.role, 'operator')
  assert.deepEqual(info.repos, [])
  assert.equal(kernel.sessions.snapshot(op.id), undefined)
})

test('a draft or an unknown id is refused, and nothing changes', () => {
  const ids = taskIds()
  assert.throws(() => kernel.sessions.recreateSession(draft.id), /already a draft/)
  assert.throws(() => kernel.sessions.recreateSession('nope'), /unknown session/)
  assert.deepEqual(taskIds(), ids)
})

test('duplicate still works alongside', () => {
  const copy = kernel.sessions.duplicateSession(draft.id)
  assert.equal(copy.title, 'login (copy)')
  assert.equal(copy.state, 'draft')
})
