// Integration test for `ensureClone` (real git, no electron, no docker, no
// network — origin is a local bare repo): the task branch `<task>` is
// created once and switched to afterwards, and two sessions of the same task
// starting at once share the clone instead of racing over it.
//
//   node scripts/clone-branch.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const pexecFile = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-clone-branch-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-clone-branch-'))
// store.ts reads GURT_ROOT at module load — set it before importing the bundle.
process.env.GURT_ROOT = path.join(root, 'gurt')

await bundle({
  stdin: {
    contents: `export { ensureClone } from ${S('src/main/provision.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})

const m = await import(pathToFileURL(outfile).href)

const origin = path.join(root, 'origin.git')
const seed = path.join(root, 'seed')
const REPO = { name: 'demo', url: origin }
const TASK = 'task-1'
const refFor = (env) => ({ workspace: 'ws', task: TASK, env })
const branchOf = (dir) =>
  pexecFile('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']).then((r) => r.stdout.trim())

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outfile, { force: true })
})

await pexecFile('git', ['init', '-q', '--bare', origin])
// The default HEAD of a bare init may be `master`; point it at what we push,
// so the clone checks out a real commit instead of landing unborn.
await pexecFile('git', ['-C', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
await pexecFile('git', ['init', '-q', seed])
fs.writeFileSync(path.join(seed, 'README.md'), 'hi\n')
const gitSeed = (...args) =>
  pexecFile('git', ['-C', seed, '-c', 'user.email=t@t.test', '-c', 'user.name=t', ...args])
await gitSeed('add', '-A')
await gitSeed('commit', '-q', '-m', 'init')
await gitSeed('push', '-q', origin, 'HEAD:refs/heads/main')

// The clone the first test creates; every test after it works on the same one.
let dir
const gitClone = (...args) =>
  pexecFile('git', ['-C', dir, '-c', 'user.email=t@t.test', '-c', 'user.name=t', ...args])

// --- first session: clones and creates the task branch ---
test('clone + branch creation', async () => {
  const lines = []
  dir = await m.ensureClone(refFor('env-a'), REPO, (l) => lines.push(l))
  assert.equal(dir, path.join(process.env.GURT_ROOT, 'ws', TASK, 'demo'))
  assert.ok(lines.some((l) => l.includes('cloning')), 'first call clones')
  assert.equal(await branchOf(dir), TASK, 'task branch is checked out')
})

// --- second session on the same task: reuses clone and branch ---
test('sequential second session', async () => {
  const again = await m.ensureClone(refFor('env-b'), REPO, () => {})
  assert.equal(again, dir)
  assert.equal(await branchOf(dir), TASK, 'existing branch is switched to, not recreated')
})

// --- a commit on the task branch survives the next session's checkout ---
test('existing work preserved', async () => {
  fs.writeFileSync(path.join(dir, 'work.txt'), 'agent output\n')
  await gitClone('add', '-A')
  await gitClone('commit', '-q', '-m', 'agent work')
  const head = (await gitClone('rev-parse', 'HEAD')).stdout.trim()
  await m.ensureClone(refFor('env-c'), REPO, () => {})
  assert.equal((await gitClone('rev-parse', 'HEAD')).stdout.trim(), head, 'branch is not reset')
})

// --- a clone left conflicted by "update from main" is still provisionable ---
test('conflicted clone', async () => {
  // Git refuses even a same-branch checkout while the index has unmerged entries,
  // so provisioning must skip it — otherwise no agent could be started to resolve
  // the conflict.
  fs.writeFileSync(path.join(dir, 'README.md'), 'ours\n')
  await gitClone('commit', '-qam', 'ours')
  fs.writeFileSync(path.join(seed, 'README.md'), 'theirs\n')
  await gitSeed('commit', '-qam', 'theirs')
  await gitSeed('push', '-q', origin, 'HEAD:refs/heads/main')
  await gitClone('fetch', '-q', 'origin')
  await gitClone('merge', 'origin/main', '--no-edit').then(
    () => assert.fail('merge should have conflicted'),
    () => {}
  )
  const merging = path.join(dir, '.git', 'MERGE_HEAD')
  assert.ok(fs.existsSync(merging), 'clone is mid-merge with conflicts')
  await m.ensureClone(refFor('env-d'), REPO, () => {})
  assert.equal(await branchOf(dir), TASK, 'still on the task branch')
  assert.ok(fs.existsSync(merging), 'conflict state is left for the agent to resolve')

  await gitClone('merge', '--abort')
})

// --- same for a rebase stopped on conflicts, which also detaches HEAD ---
test('mid-rebase clone', async () => {
  await gitClone('rebase', 'origin/main').then(
    () => assert.fail('rebase should have conflicted'),
    () => {}
  )
  assert.equal(await branchOf(dir), 'HEAD', 'mid-rebase HEAD is detached')
  await m.ensureClone(refFor('env-e'), REPO, () => {})
  assert.equal(await branchOf(dir), 'HEAD', 'rebase is not clobbered by a checkout')

  // Resolve, so the following assertions start from a clean tree.
  await gitClone('rebase', '--abort')
  await gitClone('merge', 'origin/main', '--no-edit').catch(() => {})
  fs.writeFileSync(path.join(dir, 'README.md'), 'resolved\n')
  await gitClone('add', '-A')
  await gitClone('commit', '-qm', 'resolve')
})

// --- concurrent start of two sessions on a fresh task: no branch-exists race ---
test('concurrent sessions', async () => {
  const hot = { workspace: 'ws', task: 'task-2', env: 'env-a' }
  const results = await Promise.all([
    m.ensureClone(hot, REPO, () => {}),
    m.ensureClone({ ...hot, env: 'env-b' }, REPO, () => {}),
    m.ensureClone({ ...hot, env: 'env-c' }, REPO, () => {})
  ])
  assert.equal(new Set(results).size, 1, 'all sessions get the same clone')
  assert.equal(await branchOf(results[0]), 'task-2')
})
