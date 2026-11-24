// RPM task 7 (t4v1): the rest of RPM's ports — GitPort on a temp git repo,
// CheckPort over CheckRunner with a fake container, NotifyPort over
// notifications.ts (with `open`, quieted by `setQuiets`), StorePort. t3v2 §4.2, §7, §11.
//
//   node --test scripts/rpm-ports.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { bundle } from './lib/bundle.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const S = (rel) => JSON.stringify(path.join(ROOT, rel))
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-rpm-ports-'))
process.env.GURT_ROOT = GURT_ROOT
const outfile = path.join(os.tmpdir(), `gurt-rpm-ports-${process.pid}.mjs`)
await bundle({
  stdin: {
    contents: [
      `export * from ${S('src/main/rpmPorts/index.ts')}`,
      `export { createNotifications } from ${S('src/main/notifications.ts')}`,
      `export { createBus } from ${S('src/main/bus.ts')}`,
      `export { validateName } from ${S('src/main/store.ts')}`,
      `export { NOTIFICATION_DEFAULTS } from ${S('src/shared/notifications.ts')}`
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})
const m = await import(pathToFileURL(outfile).href)
after(() => {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

const ws = 'w'
const task = 't'
const repoDir = path.join(GURT_ROOT, ws, task, 'alpha')
const g = (...args) =>
  execFileSync('git', ['-C', repoDir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim()

test('GitPort: trees change after an edit; diff against a commit includes untracked files', async () => {
  fs.mkdirSync(repoDir, { recursive: true })
  fs.writeFileSync(path.join(GURT_ROOT, ws, 'workspace.json'), JSON.stringify({ repos: [], envs: [] }))
  execFileSync('git', ['init', '-q', '-b', 'main', repoDir])
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'one\n')
  fs.writeFileSync(path.join(repoDir, 'gone.txt'), 'bye\n')
  g('add', '-A')
  g('commit', '-q', '-m', 'base')
  const base = g('rev-parse', 'HEAD')
  const git = m.createGitPort()

  const [t1] = await git.trees(ws, task, ['alpha'])
  assert.equal(t1.repo, 'alpha')
  assert.equal(t1.head, base)
  assert.equal(t1.tree, g('rev-parse', 'HEAD^{tree}'), 'clean tree = HEAD tree')
  const again = await git.trees(ws, task, ['alpha'])
  assert.deepEqual(again, [t1], 'stable while nothing changes')

  const empty = await git.diff(ws, task, 'alpha', base, 10_000)
  assert.deepEqual(empty, { text: '', truncated: false, files: [] })

  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'two\n')
  fs.writeFileSync(path.join(repoDir, 'new.txt'), 'fresh\n')
  fs.rmSync(path.join(repoDir, 'gone.txt'))
  const [t2] = await git.trees(ws, task, ['alpha'])
  assert.equal(t2.head, base)
  assert.notEqual(t2.tree, t1.tree, 'an edit changes the tree')
  assert.equal(g('status', '--porcelain'), ' M a.txt\n D gone.txt\n?? new.txt'.trim(), 'the real index untouched')

  const d = await git.diff(ws, task, 'alpha', base, 10_000)
  assert.equal(d.truncated, false)
  assert.match(d.text, /\+two/)
  assert.match(d.text, /\+fresh/)
  assert.deepEqual(
    d.files.sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: 'a.txt', status: 'M' },
      { path: 'gone.txt', status: 'D' },
      { path: 'new.txt', status: 'A' }
    ]
  )

  const cut = await git.diff(ws, task, 'alpha', base, 20)
  assert.equal(cut.truncated, true)
  assert.equal(cut.text.length, 20)
  assert.equal(cut.files.length, 3, 'the file list is whole even when the text is cut')

  // A commit after the base: still diffed against the base, and HEAD moves.
  g('add', '-A')
  g('commit', '-q', '-m', 'work')
  const [t3] = await git.trees(ws, task, ['alpha'])
  assert.notEqual(t3.head, base)
  assert.equal(t3.tree, t2.tree, 'same content, same tree')
  assert.equal((await git.diff(ws, task, 'alpha', base, 10_000)).files.length, 3)
})

test('GitPort: the clone\'s git metadata is never read — its filter, diff.external, textconv, fsmonitor never run on the host', async () => {
  const dir = path.join(GURT_ROOT, ws, task, 'beta')
  const marks = path.join(GURT_ROOT, 'marks')
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(marks, { recursive: true })
  const b = (...args) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim()
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n')
  b('add', '-A')
  b('commit', '-q', '-m', 'base')
  const base = b('rev-parse', 'HEAD')
  // What an agent with the clone's .git in its bind can write.
  const prog = (name) => {
    const f = path.join(marks, `${name}.sh`)
    fs.writeFileSync(f, `#!/bin/sh\ntouch ${JSON.stringify(path.join(marks, name + '.ran'))}\nexec cat "$@"\n`, { mode: 0o755 })
    return f
  }
  b('config', 'filter.evil.clean', prog('clean'))
  b('config', 'diff.external', prog('external'))
  b('config', 'diff.evil.textconv', prog('textconv'))
  b('config', 'core.fsmonitor', prog('fsmonitor'))
  fs.writeFileSync(path.join(dir, '.gitattributes'), '* filter=evil diff=evil\n')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n')
  const ran = () => fs.readdirSync(marks).filter((f) => f.endsWith('.ran')).sort()

  const git = m.createGitPort()
  const [t] = await git.trees(ws, task, ['beta'])
  assert.ok(t.tree)
  const d = await git.diff(ws, task, 'beta', base, 10_000)
  assert.match(d.text, /\+two/)
  assert.deepEqual(ran(), [], 'no clone-configured program ran')

  // The plant is live: plain host git does run the filter.
  b('add', '-A')
  assert.ok(ran().includes('clean.ran'), 'sanity: plain git runs the clean filter')
  b('commit', '-q', '-m', 'planted')

  // The clone's metadata is never read by git at all — so a config the agent
  // rewrites while a call runs cannot reach it. A config git cannot parse would
  // make any git that reads it die ("bad config line"); packed refs and the
  // clone's exclude list are still honoured (read by hand / copied as data).
  b('pack-refs', '--all')
  const headSha = b('rev-parse', 'HEAD')
  fs.writeFileSync(path.join(dir, '.git', 'info', 'exclude'), 'secret.txt\n')
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'x\n')
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n')
  fs.appendFileSync(path.join(dir, '.git', 'config'), '\n[broken\n')
  assert.throws(() => b('status'), /bad config/, 'sanity: a git that reads the clone config dies')
  for (const f of ran()) fs.rmSync(path.join(marks, f))
  const [t2] = await git.trees(ws, task, ['beta'])
  assert.equal(t2.head, headSha, 'HEAD from packed-refs')
  assert.notEqual(t2.tree, t.tree)
  const d2 = await git.diff(ws, task, 'beta', base, 10_000)
  assert.deepEqual(d2.files.map((f) => f.path).sort(), ['.gitattributes', 'a.txt', 'b.txt'], 'excluded file left out')
  assert.deepEqual(ran(), [])
})

test('GitPort: a relative core.hooksPath in the host\'s global config does not reach hooks in the work tree', async () => {
  const dir = path.join(GURT_ROOT, ws, task, 'epsilon')
  const home = path.join(GURT_ROOT, 'home')
  const mark = path.join(GURT_ROOT, 'hook.ran')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, '.gitconfig'), '[core]\n\thooksPath = agent-hooks\n')
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n')
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'])
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base'])
  // What the agent can write in its work tree.
  fs.mkdirSync(path.join(dir, 'agent-hooks'))
  fs.writeFileSync(path.join(dir, 'agent-hooks', 'post-index-change'), `#!/bin/sh\ntouch ${JSON.stringify(mark)}\n`, { mode: 0o755 })
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
  process.env.HOME = home
  delete process.env.XDG_CONFIG_HOME
  try {
    await m.createGitPort().trees(ws, task, ['epsilon'])
    assert.equal(fs.existsSync(mark), false, 'the work tree hook did not run')
    // The plant is live: plain git with that global config runs it.
    execFileSync('git', ['-C', dir, 'add', '-A'], { env: { ...process.env } })
    assert.equal(fs.existsSync(mark), true, 'sanity: plain git runs the hook')
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
})

test('StorePort: <gurtRoot>/<ws>/<task>/rpm, and rpm is a reserved repo name', () => {
  assert.equal(m.createStorePort().dir(ws, task), path.join(GURT_ROOT, ws, task, 'rpm'))
  assert.throws(() => m.validateName('repo', 'rpm'), /reserved/)
})

function notifySetup(roles = {}) {
  const bus = m.createBus()
  const prefs = JSON.parse(JSON.stringify(m.NOTIFICATION_DEFAULTS))
  for (const t of Object.keys(prefs)) prefs[t] = { inApp: true, external: false }
  const info = (id) => ({ title: `title-${id}`, workspace: ws, task, env: 'e', role: roles[id] ?? 'executor' })
  const notifications = m.createNotifications(bus, prefs, info)
  const created = []
  bus.on('notification.created', (r) => created.push(r))
  return { bus, notifications, created }
}
const ref = { workspace: ws, task, env: 'e' }

test('NotifyPort: called → awaiting, passed → proposal, both with an open target', () => {
  const { notifications, created } = notifySetup()
  const notify = m.createNotifyPort(notifications)
  notify.notify({ sessionId: 'ex', kind: 'called', text: 'Review waits for you · 2 findings', open: { filter: 'you' } })
  notify.notify({ sessionId: 'ex', kind: 'passed', text: 'Review passed · marked 4 files', open: {} })
  assert.equal(created.length, 2)
  assert.equal(created[0].type, 'awaiting')
  assert.equal(created[0].detail, 'Review waits for you · 2 findings')
  assert.deepEqual(created[0].open, { sessionId: 'ex', tab: 'review', filter: 'you' })
  assert.equal(created[1].type, 'proposal')
  assert.deepEqual(created[1].open, { sessionId: 'ex', tab: 'review' })
  assert.deepEqual(notifications.list().map((r) => r.type), ['awaiting', 'proposal'])
})

test('setQuiets: a live run silences proposal and turn-ended, not RPM, awaiting or error; reviewers never notify', () => {
  const { bus, notifications, created } = notifySetup({ rev: 'reviewer' })
  let live = true
  notifications.setQuiets((id) => id === 'ex' && live)
  const notify = m.createNotifyPort(notifications)

  bus.emit('session.turn', { sessionId: 'ex', ref, phase: 'started' })
  bus.emit('session.proposal', { sessionId: 'ex', ref, proposal: { outcome: 'changes' } })
  bus.emit('session.turn', { sessionId: 'ex', ref, phase: 'ended' })
  bus.emit('session.turn', { sessionId: 'ex', ref, phase: 'started' })
  bus.emit('session.turn', { sessionId: 'ex', ref, phase: 'ended' })
  assert.deepEqual(created, [], 'proposal and turn-ended are quiet')

  notify.notify({ sessionId: 'ex', kind: 'passed', text: 'Review passed', open: {} })
  notify.notify({ sessionId: 'ex', kind: 'called', text: 'Review waits for you', open: { filter: 'you' } })
  bus.emit('session.awaiting', { sessionId: 'ex', ref, awaiting: true })
  bus.emit('container.status', { sessionId: 'ex', ref, status: 'error', reason: 'error' })
  assert.deepEqual(created.map((r) => r.type), ['proposal', 'awaiting', 'awaiting', 'error'])
  // The permission request closes: its own record is read, RPM's call is not.
  bus.emit('session.awaiting', { sessionId: 'ex', ref, awaiting: false })
  const awaiting = notifications.list().filter((r) => r.type === 'awaiting')
  assert.deepEqual(awaiting.map((r) => [r.detail, r.read]), [['Review waits for you', false], ['waiting on a permission request', true]])

  // A reviewer: nothing, ever.
  bus.emit('session.turn', { sessionId: 'rev', ref, phase: 'started' })
  bus.emit('session.turn', { sessionId: 'rev', ref, phase: 'ended' })
  bus.emit('session.awaiting', { sessionId: 'rev', ref, awaiting: true })
  assert.equal(created.length, 4)

  // The run ended: the executor's proposals speak again.
  live = false
  bus.emit('session.turn', { sessionId: 'ex', ref, phase: 'started' })
  bus.emit('session.proposal', { sessionId: 'ex', ref, proposal: { outcome: 'changes' } })
  assert.equal(created.at(-1).type, 'proposal')
  assert.equal(created.at(-1).open, undefined)
})

/** A fake exec child: prints `out`, exits with `code` on the next tick. */
function child(out, code) {
  const c = /** @type {any} */ (new EventEmitter())
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  c.kill = () => true
  setImmediate(() => {
    c.stdout.emit('data', Buffer.from(out))
    c.emit('close', code)
  })
  return c
}

test('CheckPort: commands from RepoConfig.check; run in the executor container maps to CheckRun', async () => {
  fs.writeFileSync(
    path.join(GURT_ROOT, ws, 'workspace.json'),
    JSON.stringify({ repos: [{ name: 'alpha', url: 'x', check: '  npm test ' }, { name: 'beta', url: 'y' }], envs: [] })
  )
  const calls = []
  const containers = {
    status: () => 'running',
    spawnExec: (id, argv, cwd) => {
      calls.push({ id, cwd, cmd: argv.at(-1) })
      return child('line1\nline2\n', argv.at(-1).includes('fail') ? 2 : 0)
    },
    stop: async () => {},
    isRunning: async () => false
  }
  const check = m.createCheckPort(containers, { ensureContainerUp: async () => {} })
  assert.deepEqual(check.commands(ws, ['alpha', 'beta']), [{ repo: 'alpha', command: 'npm test' }])

  const ok = await check.run('ex', 'alpha', 'npm test').done
  assert.equal(ok.repo, 'alpha')
  assert.equal(ok.command, 'npm test')
  assert.equal(ok.code, 0)
  assert.deepEqual(ok.tail, ['line1', 'line2'])
  assert.equal(calls[0].id, 'ex')
  assert.equal(calls[0].cwd, '/workspaces/alpha')
  assert.match(calls[0].cmd, /npm test/)

  const red = await check.run('ex', 'alpha', 'npm run fail').done
  assert.equal(red.code, 2)

  // The container would not come up: `done` rejects (the engine writes check-error).
  const down = m.createCheckPort({ ...containers, status: () => 'stopped' }, {
    ensureContainerUp: async () => {
      throw new Error('no docker')
    }
  })
  await assert.rejects(down.run('ex', 'alpha', 'npm test').done, /no docker/)
})

test('CheckPort: a stop docker cannot confirm rejects `done` with unconfirmed: true; stopContainer confirms through inspect', async () => {
  let running = true
  const hanging = () => {
    const c = /** @type {any} */ (new EventEmitter())
    c.stdout = new EventEmitter()
    c.stderr = new EventEmitter()
    c.kill = () => {
      setImmediate(() => c.emit('close', null))
      return true
    }
    return c
  }
  const containers = { status: () => 'running', spawnExec: () => hanging(), stop: async () => {}, isRunning: async () => running }
  const check = m.createCheckPort(containers, { ensureContainerUp: async () => {} })
  const h = check.run('ex', 'alpha', 'sleep 1000')
  const caught = h.done.catch((e) => e)
  await new Promise((r) => setImmediate(r))
  assert.equal((await h.stop()).ok, false)
  const err = await caught
  assert.ok(err instanceof Error)
  assert.equal(/** @type {{ unconfirmed?: boolean }} */ (err).unconfirmed, true)
  assert.equal((await check.stopContainer('ex')).ok, false)
  running = false
  assert.deepEqual(await check.stopContainer('ex'), { ok: true })
})
