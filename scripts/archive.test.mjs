import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { bundle } from './lib/bundle.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-archive-test-'))
process.env.GURT_ROOT = path.join(root, 'gurt')
const project = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'bundle.mjs')
const source = (name) => JSON.stringify(path.join(project, name))
await bundle({ stdin: { contents: `
  export { packScope, unpackScope } from ${source('src/main/archiveFormat.ts')}
  export { createKernel } from ${source('src/main/kernel.ts')}
  export * as store from ${source('src/main/store.ts')}
  export { canAutoArchive, normalizeArchiveSettings } from ${source('src/shared/archive.ts')}
`, resolveDir: project, loader: 'ts' }, outfile })
const { packScope, unpackScope, createKernel, store, canAutoArchive, normalizeArchiveSettings } = await import(pathToFileURL(outfile).href)
fs.mkdirSync(path.join(process.env.GURT_ROOT, 'work'), { recursive: true })
fs.writeFileSync(path.join(process.env.GURT_ROOT, 'work', 'workspace.json'), JSON.stringify({ repos: [], envs: [] }))
const kernel = createKernel()
await kernel.ready
const removals = []
kernel.containers.teardownTask = async (ws, task) => { removals.push([ws, task]) }
kernel.containers.release = async () => {}
const old = new Date(Date.now() - 10 * 86400000).toISOString()
const seen = new Date(Date.now() - 9 * 86400000).toISOString()

async function scope(task, state = 'started') {
  await store.createTask('work', task)
  const info = kernel.sessions.createSession({ workspace: 'work', task }, [], 'agent', 'Hello', 'draft', [], true, {}, 'operator')
  info.state = state
  info.lastActivityAt = old
  info.archiveSeenAt = seen
  await kernel.sessions.flushTask('work', task)
  return info
}

after(async () => {
  for (const task of await store.listTasks('work')) kernel.sessions.dropTaskSessions('work', task)
  fs.rmSync(root, { recursive: true, force: true })
})

test('streamed format preserves binary data, executable bits, symlinks and opaque history; prunes generated mounts', async () => {
  const input = path.join(root, 'format-input')
  const output = path.join(root, 'format-output')
  fs.mkdirSync(path.join(input, '.multirepo', 'session', 'history'), { recursive: true })
  fs.mkdirSync(path.join(input, '.multirepo', 'session', 'skills'), { recursive: true })
  fs.writeFileSync(path.join(input, '.multirepo', 'session', 'skills', 'copy'), 'regenerated')
  fs.writeFileSync(path.join(input, '.multirepo', 'session', 'history', 'private.jsonl'), 'history')
  const bytes = Buffer.alloc(200000, 113)
  fs.writeFileSync(path.join(input, 'run'), bytes, { mode: 0o755 })
  fs.symlinkSync('run', path.join(input, 'link'))
  const archive = path.join(root, 'format.gz')
  await packScope(input, archive)
  assert.ok(fs.statSync(archive).size < bytes.length / 10)
  assert.deepEqual(await unpackScope(archive, undefined, 'run'), bytes)
  fs.mkdirSync(output)
  await unpackScope(archive, output)
  assert.deepEqual(fs.readFileSync(path.join(output, 'run')), bytes)
  assert.equal(fs.statSync(path.join(output, 'run')).mode & 0o777, 0o755)
  assert.equal(fs.readlinkSync(path.join(output, 'link')), 'run')
  assert.equal(fs.readFileSync(path.join(output, '.multirepo', 'session', 'history', 'private.jsonl'), 'utf8'), 'history')
  assert.equal(fs.existsSync(path.join(output, '.multirepo', 'session', 'skills')), false)
})

test('rejects traversal, writes through symlinks, truncated streams and bad checksums', async () => {
  const file = path.join(root, 'invalid.gz')
  const encode = (records) => fs.writeFileSync(file, gzipSync(records.map((r) => JSON.stringify(r)).join('\n') + '\n'))
  const header = { type: 'header', version: 1 }
  const complete = { type: 'complete' }
  for (const name of ['../escape', '/absolute', 'a/../../escape', 'a\\escape', 'C:escape']) {
    encode([header, { type: 'file', path: name, mode: 0o600, size: 0 }, complete])
    await assert.rejects(unpackScope(file), /Unsafe path/)
  }
  encode([header, { type: 'link', path: 'a', target: '/tmp' }, { type: 'file', path: 'a/escape', mode: 0o600, size: 0 }, complete])
  await assert.rejects(unpackScope(file), /hierarchy/)
  encode([header])
  await assert.rejects(unpackScope(file), /Incomplete/)
  encode([header, { type: 'file', path: 'a', mode: 0o600, size: 1 }, { type: 'chunk', data: 'YQ==' }, { type: 'end', sha256: 'bad' }, complete])
  await assert.rejects(unpackScope(file), /checksum/)
  fs.writeFileSync(file, fs.readFileSync(file).subarray(0, 20))
  await assert.rejects(unpackScope(file))
})

test('scope archive hides live scope, previews chat without extracting and restores repos and agent history', async () => {
  const info = await scope('feature/archived')
  const dir = store.taskDir('work', info.task)
  const log = [{ seq: 1, type: 'entry', entry: { id: 1, kind: 'user', text: 'Important chat' } },
    { seq: 2, type: 'entry', entry: { id: 2, kind: 'agent', text: 'Saved answer' } }]
  await store.appendSessionLog('work', info.task, info.id, log)
  await kernel.pii.restoreTable(info.id, { v: 1, tokens: { email: { '1': 'saved@example.test' } } })
  await store.appendSessionLog('work', info.task, info.id, [{ seq: 3, type: 'entry', entry: { id: 3, kind: 'agent', text: '[email:1]' } }])
  fs.mkdirSync(path.join(dir, 'repo', '.git'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'repo', '.git', 'local-ref'), 'unpushed commit')
  fs.writeFileSync(path.join(dir, 'repo', '.env'), 'local ignored data')
  const history = store.sessionHistoryDir('work', info.task, info.id)
  fs.mkdirSync(history, { recursive: true })
  fs.writeFileSync(path.join(history, 'native.jsonl'), 'agent state')
  const archive = await kernel.archive.archive('work', info.task)
  assert.equal(archive.kind, 'scope')
  assert.equal(store.taskExists('work', info.task), false)
  assert.equal(kernel.sessions.sessionInfo(info.id), undefined)
  assert.ok(removals.some(([ws, task]) => ws === 'work' && task === info.task))
  assert.equal((await kernel.archive.list()).some((a) => a.id === archive.id), true)
  assert.equal((await kernel.archive.readSession(archive.id, info.id))[1].text, 'Saved answer')
  assert.equal((await kernel.archive.readSession(archive.id, info.id))[2].text, 'saved@example.test')
  assert.equal(store.taskExists('work', info.task), false, 'preview never restores the scope')
  await kernel.archive.restore(archive.id)
  assert.equal(fs.readFileSync(path.join(dir, 'repo', '.env'), 'utf8'), 'local ignored data')
  assert.equal(fs.readFileSync(path.join(dir, 'repo', '.git', 'local-ref'), 'utf8'), 'unpushed commit')
  assert.equal(fs.readFileSync(path.join(history, 'native.jsonl'), 'utf8'), 'agent state')
  assert.equal(kernel.sessions.snapshot(info.id).entries[1].text, 'Saved answer')
  assert.equal(kernel.pii.decode(info.id, '[email:1]'), 'saved@example.test')
  assert.equal((await kernel.archive.list()).some((a) => a.id === archive.id), false)
})

test('empty scopes and draft chats can be archived and restored', async () => {
  await store.createTask('work', 'empty')
  const empty = await kernel.archive.archive('work', 'empty')
  await kernel.archive.restore(empty.id)
  assert.ok(store.taskExists('work', 'empty'))
  const info = await scope('draft-chat', 'draft')
  const archive = await kernel.archive.archive('work', info.task)
  assert.deepEqual(await kernel.archive.readSession(archive.id, info.id), [])
  await kernel.archive.restore(archive.id)
  assert.equal(kernel.sessions.sessionInfo(info.id).state, 'draft')
})

test('session archives keep their parent scope, restore alongside siblings, and refuse duplicate sessions', async () => {
  const info = await scope('session-parent')
  const sibling = kernel.sessions.createSession({ workspace: 'work', task: info.task }, [], 'agent', '', 'draft')
  await store.appendSessionLog('work', info.task, info.id, [{ seq: 1, type: 'entry', entry: { id: 1, kind: 'user', text: 'one session' } }])
  const archive = await kernel.archive.archiveSession(info.id)
  assert.equal(archive.kind, 'session')
  assert.ok(store.taskExists('work', info.task))
  assert.equal(kernel.sessions.sessionInfo(info.id), undefined)
  assert.ok(kernel.sessions.sessionInfo(sibling.id))
  assert.equal((await kernel.archive.readSession(archive.id, info.id))[0].text, 'one session')
  await kernel.archive.restore(archive.id)
  assert.ok(kernel.sessions.sessionInfo(info.id))
  assert.ok(kernel.sessions.sessionInfo(sibling.id))
  assert.equal((await store.readSessions('work', info.task)).length, 2)
})

test('busy/queued scopes are refused and conflicts never overwrite existing scopes', async () => {
  const info = await scope('queued-scope', 'queued')
  await assert.rejects(kernel.archive.archive('work', info.task), /Finish or cancel/)
  assert.ok(store.taskExists('work', info.task))
  info.state = 'started'
  const archive = await kernel.archive.archive('work', info.task)
  await store.createTask('work', info.task)
  await assert.rejects(kernel.archive.restore(archive.id), /already exists|conflict|scope/i)
  assert.ok((await kernel.archive.list()).some((a) => a.id === archive.id))
})

test('automatic policy archives only read, idle, clean scopes; retention respects pins including manual deletion', async () => {
  const eligible = await scope('eligible')
  const unread = await scope('unread')
  unread.archiveSeenAt = undefined
  const broken = await scope('broken-repo')
  fs.mkdirSync(path.join(store.taskDir('work', broken.task), 'repo', '.git'), { recursive: true })
  await kernel.archive.setSettings({ autoArchive: true, inactiveHours: 24, autoDelete: false, retentionDays: 1 })
  await kernel.archive.runPolicy()
  assert.equal(store.taskExists('work', eligible.task), false)
  assert.equal(store.taskExists('work', unread.task), true)
  assert.equal(store.taskExists('work', broken.task), true, 'uninspectable repo is never treated as clean')
  const archives = await kernel.archive.list()
  const pinned = archives.find((a) => a.task === eligible.task)
  await kernel.archive.pin(pinned.id, true)
  await assert.rejects(kernel.archive.delete(pinned.id), /Unpin/)
  for (const archive of archives) {
    const file = path.join(process.env.GURT_ROOT, '.archives', `${archive.id}.json`)
    const meta = JSON.parse(fs.readFileSync(file, 'utf8'))
    meta.archivedAt = old
    fs.writeFileSync(file, JSON.stringify(meta))
  }
  await kernel.archive.setSettings({ autoArchive: false, inactiveHours: 24, autoDelete: true, retentionDays: 1 })
  await kernel.archive.runPolicy()
  assert.deepEqual((await kernel.archive.list()).map((a) => a.id), [pinned.id])
  await kernel.archive.pin(pinned.id, false)
  await kernel.archive.delete(pinned.id)
  assert.equal((await kernel.archive.list()).length, 0)
})

test('policy settings and eligibility fail closed for unknown read state', () => {
  assert.deepEqual(normalizeArchiveSettings(null), { autoArchive: false, inactiveHours: 72, autoDelete: false, retentionDays: 90 })
  assert.equal(normalizeArchiveSettings({ inactiveHours: -10 }).inactiveHours, 1)
  assert.equal(canAutoArchive([], Date.now()), false)
  assert.equal(canAutoArchive([{ state: 'started', lastActivityAt: old }], Date.now()), false)
  assert.equal(canAutoArchive([{ state: 'started', lastActivityAt: old, archiveSeenAt: seen }], Date.now()), true)
})

test('real Git: dirty and unpushed work survives auto policy; clean pushed scopes qualify', async () => {
  const configFile = path.join(process.env.GURT_ROOT, 'work', 'workspace.json')
  fs.writeFileSync(configFile, JSON.stringify({ repos: [{ name: 'repo', url: 'https://example.test/repo.git' }], envs: [] }))
  const setups = []
  for (const task of ['git-clean', 'git-dirty', 'git-unpushed']) {
    const info = await scope(task)
    const dir = path.join(store.taskDir('work', task), 'repo')
    fs.mkdirSync(dir)
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@example.test')
    git('config', 'user.name', 'Archive Test')
    fs.writeFileSync(path.join(dir, 'file.txt'), 'original\n')
    git('add', '.')
    git('commit', '-qm', 'initial')
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    git('checkout', '-qb', task)
    fs.writeFileSync(path.join(dir, 'file.txt'), 'feature\n')
    git('commit', '-qam', 'feature')
    if (task !== 'git-unpushed') git('update-ref', `refs/remotes/origin/${task}`, 'HEAD')
    if (task === 'git-dirty') fs.writeFileSync(path.join(dir, 'untracked.txt'), 'uncommitted')
    setups.push(info)
  }
  await kernel.archive.setSettings({ autoArchive: true, inactiveHours: 24, autoDelete: false, retentionDays: 90 })
  await kernel.archive.runPolicy()
  assert.equal(store.taskExists('work', setups[0].task), false)
  assert.equal(store.taskExists('work', setups[1].task), true)
  assert.equal(store.taskExists('work', setups[2].task), true)
})

test('failed compression keeps the live scope and removes uncommitted archive files', async () => {
  const info = await scope('archive-failure')
  const file = path.join(store.taskDir('work', info.task), 'C:unsafe')
  fs.writeFileSync(file, 'must survive')
  const before = (await kernel.archive.list()).map((a) => a.id)
  await assert.rejects(kernel.archive.archive('work', info.task), /Unsafe path/)
  assert.equal(fs.readFileSync(file, 'utf8'), 'must survive')
  assert.ok(kernel.sessions.sessionInfo(info.id))
  assert.deepEqual((await kernel.archive.list()).map((a) => a.id), before)
  assert.equal(fs.readdirSync(path.join(process.env.GURT_ROOT, '.archives')).some((name) => name.endsWith('.tmp')), false)
})

test('archiving blocks writes to its scope while other scopes remain accessible', async () => {
  const info = await scope('locked-scope')
  const other = await scope('other-scope')
  const original = kernel.containers.teardownTask
  let release
  let entered
  const waiting = new Promise((resolve) => { entered = resolve })
  kernel.containers.teardownTask = async () => {
    entered()
    await new Promise((resolve) => { release = resolve })
  }
  const pending = kernel.archive.archive('work', info.task)
  await waiting
  assert.equal(kernel.archive.blocksCall('writeTaskFile', ['work', info.task, 'file']), true)
  assert.equal(kernel.archive.blocksCall('writeTaskFile', ['work', other.task, 'file']), false)
  assert.throws(() => kernel.sessions.renameSession(info.id, 'renamed'), /being archived/)
  await assert.rejects(kernel.sessions.prompt(info.id, 'new prompt'), /being archived/)
  assert.throws(() => kernel.sessions.createSession({ workspace: 'work', task: info.task }, [], 'a', '', 'draft'), /being archived/)
  kernel.sessions.renameSession(other.id, 'still accessible')
  release()
  await pending
  kernel.containers.teardownTask = original
})

test('corrupt archives never publish a partial restored scope, while chat preview remains available', async () => {
  const info = await scope('corrupt-restore')
  await store.appendSessionLog('work', info.task, info.id, [{ seq: 1, type: 'entry', entry: { id: 1, kind: 'user', text: 'saved preview' } }])
  const archive = await kernel.archive.archive('work', info.task)
  const file = path.join(process.env.GURT_ROOT, '.archives', `${archive.id}.jsonl.gz`)
  fs.writeFileSync(file, fs.readFileSync(file).subarray(0, 30))
  await assert.rejects(kernel.archive.restore(archive.id))
  assert.equal(store.taskExists('work', info.task), false)
  assert.equal((await kernel.archive.readSession(archive.id, info.id))[0].text, 'saved preview')
  assert.ok((await kernel.archive.list()).some((a) => a.id === archive.id))
})
