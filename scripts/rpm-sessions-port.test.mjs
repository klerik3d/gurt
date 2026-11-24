// RPM task 6 (t4v1): `SessionsPort` over the session manager — host messages
// (`send` / `sent`), reviewers (`createReviewer`), clone holds, chat lines,
// the user's prompts and checkpoints, and the bus-backed subscriptions.
// t3v2 §4.1, §6.2, §6.4, §10.2.
//
// A headless kernel on a temp GURT_ROOT with a fake agent (as in
// rpm-session-turns.test.mjs): `sessions.attach` returns a connection whose
// `session/prompt` runs a script, so the real queue and `runPrompt` run.
//
//   node --test scripts/rpm-sessions-port.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { bundle } from './lib/bundle.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const S = (rel) => JSON.stringify(path.join(ROOT, rel))
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-rpm-port-'))
process.env.GURT_ROOT = GURT_ROOT
const outfile = path.join(os.tmpdir(), `gurt-rpm-port-${process.pid}.mjs`)
await bundle({
  stdin: {
    contents:
      `export { createKernel } from ${S('src/main/kernel.ts')}\n` +
      `export { createSessionsPort } from ${S('src/main/rpmPorts/index.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})
const { createKernel, createSessionsPort } = await import(pathToFileURL(outfile).href)

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
    envs: [{ name: 'dev', image: 'x', repo: 'alpha' }]
  })
)
for (const repo of ['alpha', 'beta']) execFileSync('git', ['init', '-q', path.join(GURT_ROOT, ws, task, repo)], { stdio: 'ignore' })
fs.writeFileSync(path.join(GURT_ROOT, ws, task, 'task.json'), JSON.stringify({}))
fs.writeFileSync(path.join(GURT_ROOT, 'agents.json'), JSON.stringify({}))

after(() => {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
async function until(fn, what) {
  for (let i = 0; i < 300; i++) {
    const v = fn()
    if (v) return v
    await tick(15)
  }
  throw new Error(`never: ${what}`)
}

const kernel = createKernel()
kernel.containers.reconcile = async () => {}
kernel.containers.resolveLaunch = async () => {
  throw new Error('no containers in this test')
}
kernel.containers.stop = async () => {}
kernel.containers.isRunning = async () => true
const scripts = {}
const notified = []
kernel.sessions.attach = async (s) => ({
  promptCapabilities: undefined,
  peer: {
    request: async (method, params) => {
      if (method !== 'session/prompt') return {}
      const sc = scripts[s.info.id]
      sc.n = (sc.n ?? 0) + 1
      sc.texts.push(params.prompt[0].text)
      return { stopReason: 'end_turn', ...(await sc.run(sc.n)) }
    },
    notify: (method, params) => notified.push({ method, params })
  }
})
const agent = (id, run) => (scripts[id] = { run, texts: [] })
await kernel.ready

const stopped = []
const port = createSessionsPort(kernel.sessions, {
  bus: kernel.bus,
  stopContainer: async (id) => void stopped.push(id),
  keepAliveMs: 30
})
const settled = []
port.onSettled((t) => settled.push(t))

const mgr = kernel.sessions
const live = (id) => mgr['sessions'].get(id)
const complete = (id, outcome = 'no_changes') => mgr['onComplete'](id, { version: 1, outcome })

function started(id, repos, extra = {}) {
  mgr.restore([
    {
      info: {
        id, env: 'dev', role: 'executor', repos,
        repoModes: Object.fromEntries(repos.map((r) => [r, 'write'])),
        task, workspace: ws, title: id, agent: 'a1', state: 'started', mcp: [], startPrompt: 'x',
        ...extra
      },
      acpSessionId: `acp-${id}`,
      log: []
    }
  ])
}
/** Let any earlier executor's container go: one writer per clone. */
const down = (id) => mgr.patchContainer(id, undefined)

const LINE = (seq, text) => ({
  executor: 'e1', run: 1, seq, from: 'reviewer', review: 1, to: 'executor',
  items: [{ id: 'F1', label: 'F1' }], kind: 'handoff', ...(text ? { text } : {})
})

test('send twice with one key queues one message; after its turn sent is taken and settled carries the key', async () => {
  started('e1', ['alpha'])
  mgr.patchContainer('e1', { status: 'running', id: 'c-e1', remoteWorkspaceFolder: '/app', repos: ['alpha'] })
  let open
  const gate = new Promise((r) => (open = r))
  agent('e1', async (n) => {
    if (n === 1) await gate
    complete('e1', n === 1 ? 'changes' : 'no_changes')
    return {}
  })
  await mgr.prompt('e1', 'fix the bug')
  await until(() => live('e1').busy, 'the typed turn runs')

  const m = { key: 'k1', text: 'F1: the null check is still missing', line: LINE(3, 'F1: the null check is still missing') }
  await port.send('e1', m)
  await port.send('e1', m)
  const rpmQueued = live('e1').pending.filter((p) => p.origin?.rpm === 'k1')
  assert.equal(rpmQueued.length, 1, 'one message in the queue')
  assert.equal(rpmQueued[0].auto, true)
  assert.equal(port.sent('e1', 'k1'), 'queued')
  assert.equal(port.sent('e1', 'nope'), 'unknown')

  open()
  const t = await until(() => settled.find((x) => x.sessionId === 'e1' && x.key === 'k1'), 'the RPM turn settles')
  assert.equal(t.origin, 'rpm')
  assert.equal(port.sent('e1', 'k1'), 'taken')
  await port.send('e1', m)
  assert.equal(live('e1').pending.length, 0, 'a taken key is not sent again')
  assert.equal(scripts.e1.texts[1], m.text, 'the agent got the full text')

  // In the chat: a system line with `rpm`, not a user message; the typed prompt is a user entry with its turn.
  const entries = mgr.snapshot('e1').entries
  const line = entries.find((e) => e.kind === 'system' && e.rpm)
  assert.deepEqual(line.rpm, m.line)
  assert.equal(line.text, m.text)
  assert.deepEqual(entries.filter((e) => e.kind === 'user').map((e) => [e.text, e.turn]), [['fix the bug', 'e1:1']])
  assert.deepEqual(port.userPrompts('e1'), ['fix the bug'])
  assert.deepEqual(port.userPrompts('e1', 'e1:1'), [])
})

test('checkpointBefore gives the commit snapshotted before the user message of the turn', async () => {
  const first = settled.find((x) => x.sessionId === 'e1' && x.origin === 'user')
  const cp = port.checkpointBefore('e1', first.turnId)
  assert.equal(cp.length, 1)
  assert.equal(cp[0].repo, 'alpha')
  const entry = mgr.snapshot('e1').entries.find((e) => e.kind === 'user')
  const ref = execFileSync('git', ['-C', path.join(GURT_ROOT, ws, task, 'alpha'), 'rev-parse', `refs/gurt/checkpoints/e1/${entry.id}`], { encoding: 'utf8' }).trim()
  assert.equal(cp[0].commit, ref)
  const rpmTurn = settled.find((x) => x.sessionId === 'e1' && x.key === 'k1')
  assert.equal(port.checkpointBefore('e1', rpmTurn.turnId), undefined, 'an RPM turn has no user message')
})

test('info and chatLine', () => {
  assert.deepEqual(port.info('e1'), {
    id: 'e1', ws, task, title: 'e1', role: 'executor', agent: 'a1', writeRepos: ['alpha'], state: 'started'
  })
  assert.equal(port.info('nope'), undefined)
  const id = port.chatLine('e1', LINE(9))
  const e = mgr.snapshot('e1').entries.find((x) => x.id === id)
  assert.equal(e.kind, 'system')
  assert.deepEqual(e.rpm, LINE(9))
  assert.equal(port.chatLine('nope', LINE(9)), undefined)
  // chatRefs: the RPM lines of the log with their entry ids (HistoryItem.chat).
  const l = LINE(9)
  assert.ok(port.chatRefs('e1').some((r) => r.entryId === id && r.seq === l.seq && r.run === l.run && r.executor === l.executor &&
    JSON.stringify(r.items) === JSON.stringify(l.items.map((x) => x.id))))
  assert.deepEqual(port.chatRefs('nope'), [])
})

test('a key stays taken after later keys complete, and after a restart', async () => {
  agent('e1', async () => (complete('e1'), {}))
  await port.send('e1', { key: 'k2', text: 'second step', line: LINE(6) })
  await until(() => settled.find((x) => x.sessionId === 'e1' && x.key === 'k2'), 'k2 settles')
  assert.equal(port.sent('e1', 'k1'), 'taken', 'k1 is still known after k2')
  const runs = scripts.e1.n
  await port.send('e1', { key: 'k1', text: 'F1: the null check is still missing', line: LINE(3) })
  assert.equal(live('e1').pending.length, 0, 'k1 is not queued again')
  await tick(50)
  assert.equal(scripts.e1.n, runs, 'and not run again')

  await mgr.flushTask(ws, task)
  const row = JSON.parse(fs.readFileSync(path.join(GURT_ROOT, ws, task, 'sessions.json'), 'utf8')).find((r) => r.info.id === 'e1')
  assert.deepEqual(row.rpmTaken, ['k1', 'k2'])
  // A restart: the record comes back from disk.
  const kept = live('e1')
  mgr['sessions'].delete('e1')
  mgr.restore([{ ...row, log: kept.records }])
  assert.equal(port.sent('e1', 'k1'), 'taken')
  assert.equal(port.sent('e1', 'k2'), 'taken')
  await port.send('e1', { key: 'k1', text: 'again', line: LINE(3) })
  assert.equal(live('e1').pending.length, 0, 'not queued after the restart either')
})

test('createReviewer twice gives one session, every repo read, started at once despite the cap', async () => {
  started('e2', ['alpha', 'beta'], { mcp: [{ id: 'github', mode: 'full' }], autoAllow: false })
  mgr.patchContainer('e2', { status: 'running', id: 'c-e2', remoteWorkspaceFolder: '/app', repos: ['alpha', 'beta'] })
  mgr.setTaskCap(ws, task, 1)
  const starts = []
  mgr['startSession'] = async (id, by) => void starts.push([id, by])
  const req = {
    key: 'rv-1', executor: 'e2', agent: 'a2', options: { model: 'm' }, title: 'review R1 — e2',
    prompt: 'review this', line: { ...LINE(4), from: 'executor', to: 'reviewer', executor: 'e2' }
  }
  const [a, b] = await Promise.all([port.createReviewer(req), port.createReviewer(req)])
  const c = await port.createReviewer(req)
  assert.equal(a, b)
  assert.equal(a, c)
  const reviewers = mgr.allSessions().filter((s) => s.reviewerOf?.key === 'rv-1')
  assert.equal(reviewers.length, 1, 'one session')
  const r = reviewers[0]
  assert.equal(r.role, 'reviewer')
  assert.deepEqual(r.repoModes, { alpha: 'read', beta: 'read' })
  assert.deepEqual(r.reviewerOf, { executor: 'e2', key: 'rv-1' })
  assert.equal(r.title, 'review R1 — e2')
  assert.equal(r.agent, 'a2')
  assert.deepEqual(r.configValues, { model: 'm' })
  assert.equal(r.autoAllow, false, 'inherits from the executor')
  assert.equal(r.startPrompt, 'review this')
  assert.ok(r.mcp.every((m) => m.id !== 'github' || m.mode === 'read-only'), 'built-ins read-only')
  assert.deepEqual(starts, [[a, 'user']], 'started at once, not queued behind the cap')
  assert.deepEqual(live(a).startLine, req.line)
  delete mgr['startSession']
  mgr.setTaskCap(ws, task, undefined)
})

test('a reviewer start prompt shows as RPM line and settles with the key', async () => {
  const id = mgr.allSessions().find((s) => s.reviewerOf?.key === 'rv-1').id
  const s = live(id)
  s.info.state = 'started'
  s.acpSessionId = `acp-${id}`
  agent(id, async () => ({}))
  // What start.ts does with the start prompt of a reviewer.
  const line = s.startLine
  void mgr['runPrompt'](s, s.info.startPrompt, undefined, undefined, { origin: 'rpm', key: 'rv-1', line })
  const t = await until(() => settled.find((x) => x.sessionId === id), 'the reviewer settles')
  assert.equal(t.key, 'rv-1')
  const first = mgr.snapshot(id).entries[0]
  assert.equal(first.kind, 'system')
  assert.deepEqual(first.rpm, line)
})

test('hold keeps the clone from another session, even with the container down; release lets it go', async () => {
  down('e1')
  down('e2')
  started('e3', ['alpha'])
  port.hold('e3')
  started('o1', ['alpha'], { state: 'draft' })
  const starts = []
  mgr['startSession'] = async (id, by) => void starts.push([id, by])
  mgr.enqueue('o1')
  assert.deepEqual(starts, [], 'not started')
  assert.equal(mgr.snapshot('o1').info.state, 'queued')
  assert.equal(mgr.snapshot('o1').waiting, 'review of "e3" holds alpha')
  assert.equal(mgr.repoHolderFor(ws, task, 'alpha')?.id, 'e3')

  // The held executor's own message is not stuck behind the session waiting for its hold.
  agent('e3', async () => (complete('e3'), {}))
  await port.send('e3', { key: 'k3', text: 'go on', line: LINE(5) })
  await until(() => settled.find((x) => x.sessionId === 'e3' && x.key === 'k3'), 'the held executor runs its step')

  port.release('e3')
  await until(() => starts.length, 'o1 starts once released')
  assert.deepEqual(starts, [['o1', 'scheduler']])
  delete mgr['startSession']
})

test('cancelTurn, stopContainer, keepAlive', async () => {
  mgr['connections'].set('e1', { peer: { notify: (method, params) => notified.push({ method, params }) } })
  await port.cancelTurn('e1')
  mgr['connections'].delete('e1')
  assert.deepEqual(notified.at(-1), { method: 'session/cancel', params: { sessionId: 'acp-e1' } })
  await port.stopContainer('e1')
  assert.deepEqual(stopped, ['e1'])
  let pings = 0
  const off = kernel.bus.on('session.activity', ({ sessionId }) => sessionId === 'e1' && pings++)
  port.keepAlive('e1', true)
  port.keepAlive('e1', true)
  await tick(100)
  port.keepAlive('e1', false)
  const n = pings
  assert.ok(n >= 3, `pinged (${n})`)
  await tick(80)
  assert.equal(pings, n, 'no pings once off')
  off()
})

test('onCopied on Duplicate and Recreate, onDeleted on delete', () => {
  const copied = []
  const deleted = []
  const u1 = port.onCopied((from, to) => copied.push([from, to]))
  const u2 = port.onDeleted((id) => deleted.push(id))
  const dup = mgr.duplicateSession('e1')
  const rec = mgr.recreateSession('e3')
  assert.deepEqual(copied, [['e1', dup.id], ['e3', rec.id]])
  assert.deepEqual(deleted, ['e3'])
  u1()
  u2()
})

