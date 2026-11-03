// Real Git verifies options against hooks, a rewritten published branch and a
// stale lease. No Docker, Electron, credentials or external remote is needed.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bundle } from './lib/bundle.mjs'

const project = fileURLToPath(new URL('..', import.meta.url))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-git-options-'))
process.env.GURT_ROOT = path.join(root, 'store')
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test'
})
const outfile = path.join(root, 'changes.mjs')
await bundle({
  stdin: {
    contents: `export { commit, push, getTaskChanges } from ${JSON.stringify(path.join(project, 'src/main/changes.ts'))}`,
    resolveDir: project, loader: 'ts', sourcefile: 'entry.ts'
  }, outfile
})
const changes = await import(pathToFileURL(outfile).href)
after(() => fs.rmSync(root, { recursive: true, force: true }))
const git = (dir, ...args) => execFileSync('git', [
  '-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
let sequence = 0
function fixture() {
  const task = `task-${++sequence}`
  const dir = path.join(process.env.GURT_ROOT, 'ws', task, 'repo')
  const remote = path.join(root, `${task}.git`)
  fs.mkdirSync(dir, { recursive: true })
  git(root, 'init', '--bare', '-b', 'main', remote)
  git(dir, 'init', '-b', task)
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'user.email', 'test@example.test')
  fs.writeFileSync(path.join(dir, 'file.txt'), 'base\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'base')
  git(dir, 'remote', 'add', 'origin', remote)
  git(dir, 'push', 'origin', 'HEAD:main')
  git(dir, 'fetch', 'origin')
  const commit = (message, options) => changes.commit('ws', task, 'repo', message, options)
  const push = (options) => changes.push('ws', task, 'repo', options)
  return { task, dir, remote, commit, push }
}

test('commit includes untracked files and signoff; hook failures keep work available to retry', async () => {
  const { dir, commit } = fixture()
  fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n')
  const hook = path.join(dir, '.git', 'hooks', 'pre-commit')
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  await assert.rejects(commit('blocked by hook'))
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'base')
  assert.ok(git(dir, 'status', '--porcelain').includes('new.txt'))
  await commit('signed commit', { signoff: true, noVerify: true })
  assert.match(git(dir, 'log', '-1', '--format=%B'), /Signed-off-by: Test <test@example.test>/)
  assert.equal(git(dir, 'show', 'HEAD:new.txt'), 'new')
  assert.equal(git(dir, 'status', '--porcelain'), '')
})

test('a rewritten published branch requires force-with-lease, which rejects a stale remote', async () => {
  const { dir, remote, task, commit, push } = fixture()
  fs.writeFileSync(path.join(dir, 'file.txt'), 'published\n')
  await commit('published')
  await push()
  const published = git(dir, 'rev-parse', 'HEAD')
  git(dir, 'commit', '--amend', '-m', 'rewritten')
  const rewritten = git(dir, 'rev-parse', 'HEAD')
  await assert.rejects(push())
  assert.equal(git(remote, 'rev-parse', task), published)
  await push({ forceWithLease: true })
  assert.equal(git(remote, 'rev-parse', task), rewritten)

  // Another developer pushes after our last fetch. The explicit lease must
  // refuse overwriting that change, preserving the remote's exact SHA.
  const other = path.join(root, `${task}-other`)
  git(root, 'clone', '--branch', task, remote, other)
  fs.writeFileSync(path.join(other, 'other.txt'), 'concurrent change\n')
  git(other, 'add', '-A')
  git(other, 'commit', '-m', 'someone else')
  git(other, 'push', 'origin', task)
  const concurrent = git(remote, 'rev-parse', task)
  git(dir, 'commit', '--amend', '-m', 'rewrite again')
  await assert.rejects(push({ forceWithLease: true }))
  assert.equal(git(remote, 'rev-parse', task), concurrent)
})

test('push honors hooks by default and follows annotated tags only when requested', async () => {
  const { dir, remote, task, commit, push } = fixture()
  fs.writeFileSync(path.join(dir, 'file.txt'), 'tagged\n')
  await commit('tagged')
  git(dir, 'tag', '-a', 'release', '-m', 'release')
  fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  await assert.rejects(push())
  await push({ noVerify: true })
  assert.equal(git(remote, 'rev-parse', task), git(dir, 'rev-parse', 'HEAD'))
  assert.equal(git(remote, 'tag'), '')
  await push({ noVerify: true, followTags: true })
  assert.equal(git(remote, 'tag'), 'release')
})
