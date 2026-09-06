// The config journal (docs/requirements-session-operator.md §7, acceptance
// §12 item 7): ~/.gurt is a git repository allow-listed by .gitignore, every
// config mutation auto-commits with the actor in the author and the op in a
// trailer, and a journal failure never fails the user's edit.
//
//   node scripts/config-journal.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-journal-'))
process.env.GURT_ROOT = GURT_ROOT

const outfile = path.join(os.tmpdir(), `gurt-journal-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await bundle({
  stdin: {
    contents:
      `export { addEnv, addRepo, addSkill, createTask, createWorkspace, setAgents, updateEnv, withJournalActor } from ${S('src/main/store.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  external: ['electron'],
  outfile
})

const m = await import(pathToFileURL(outfile).href)

const git = (...args) =>
  execFileSync('git', ['-C', GURT_ROOT, ...args], { encoding: 'utf8' }).trim()
const commitCount = () => Number(git('rev-list', '--count', 'HEAD'))

after(() => {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

// Plant everything the ignore file must keep out BEFORE the first mutation,
// so the first `git add -A` has every chance to get it wrong.
fs.mkdirSync(GURT_ROOT, { recursive: true })
fs.writeFileSync(
  path.join(GURT_ROOT, 'credentials.json'),
  JSON.stringify({ credentials: [{ id: 'c', kind: 'mcp-token', hosts: [], data: { secret: 'planted-secret-value' } }] })
)
fs.mkdirSync(path.join(GURT_ROOT, 'logs'), { recursive: true })
fs.writeFileSync(path.join(GURT_ROOT, 'logs', 'gurt.log'), 'log line\n')
fs.writeFileSync(path.join(GURT_ROOT, 'usage.jsonl'), '{}\n')

test('mutations journal into an allow-listed git repository', async () => {
  await m.createWorkspace('acme')
  // Runtime state inside the workspace: a task with sessions, chat logs and a
  // clone — none of it may ever enter the journal (§7).
  await m.createTask('acme', 'feature')
  const taskDir = path.join(GURT_ROOT, 'acme', 'feature')
  fs.writeFileSync(path.join(taskDir, 'sessions.json'), '[]\n')
  fs.mkdirSync(path.join(taskDir, 'repo', '.git'), { recursive: true })
  fs.writeFileSync(path.join(taskDir, 'repo', '.git', 'HEAD'), 'ref: refs/heads/main\n')
  fs.writeFileSync(path.join(taskDir, 'repo', 'work.txt'), 'uncommitted user work\n')

  await m.setAgents({ a1: { kind: 'claude-code', label: 'claude' } })
  await m.addRepo('acme', { name: 'alpha', url: 'https://github.com/o/alpha.git' })
  await m.addEnv('acme', { name: 'node20', devcontainer: '{"image":"node:20"}' })
  await m.addSkill('acme', 'greet', '---\nname: greet\ndescription: says hi\n---\nhi\n')

  const tracked = git('ls-files').split('\n').sort()
  assert.deepEqual(
    tracked,
    ['.gitignore', 'acme/skills/greet/SKILL.md', 'acme/workspace.json', 'agents.json'],
    'in: agents.json, workspace.json, the skills tree, the ignore file itself — nothing else'
  )
  assert.ok(!tracked.some((f) => f.includes('credentials')), 'credentials.json never enters history')
  assert.ok(!tracked.some((f) => f.includes('sessions')), 'sessions.json stays out')
  assert.ok(!tracked.some((f) => f.startsWith('acme/feature/')), 'the clone and the task stay out')
})

test('the reservation the ignore file depends on: a task named `skills` is refused', async () => {
  await assert.rejects(m.createTask('acme', 'skills'), /reserved/, '§7: skills is a reserved task name')
})

test('one commit per mutation, the op in the trailer, the actor in the author', async () => {
  const before = commitCount()
  await m.updateEnv('acme', { name: 'node20', devcontainer: '{"image":"node:22"}' })
  assert.equal(commitCount(), before + 1, 'exactly one commit for one mutation')
  const body = git('log', '-1', '--format=%s%n%b')
  assert.match(body, /env "node20": updated/, 'the subject names the entity')
  assert.match(body, /Op: updateEnv/, 'the op rides as a trailer')
  assert.match(body, /Entity: acme\/env\/node20/, 'the entity rides as a trailer')
  assert.equal(git('log', '-1', '--format=%an <%ae>'), 'gurt-ui <user@gurt.local>', 'UI is the default actor')

  // A same-value save changes no tracked bytes and commits nothing.
  await m.updateEnv('acme', { name: 'node20', devcontainer: '{"image":"node:22"}' })
  assert.equal(commitCount(), before + 1, 'a no-op save adds no commit')
})

test('a UI change and an operator change are distinguishable by --author', async () => {
  await m.withJournalActor({ kind: 'operator', id: '4f3c' }, () =>
    m.updateEnv('acme', { name: 'node20', devcontainer: '{"image":"node:23"}' })
  )
  assert.equal(
    git('log', '-1', '--format=%an <%ae>'),
    'gurt-operator <4f3c@gurt.local>',
    'the operator actor carries the session id in the address'
  )
  const operatorCommits = git('log', '--author=operator', '--format=%s')
    .split('\n')
    .filter(Boolean)
  assert.deepEqual(operatorCommits, ['env "node20": updated'], '`git log --author=operator` answers "what has the agent done"')
})

test('a journal failure never fails the write', async () => {
  const count = commitCount()
  // A stale lock left by a terminal — §7's own example of a failure that must
  // not refuse to save an env.
  const lock = path.join(GURT_ROOT, '.git', 'index.lock')
  fs.writeFileSync(lock, '')
  await m.updateEnv('acme', { name: 'node20', devcontainer: '{"image":"node:24"}' })
  const saved = JSON.parse(fs.readFileSync(path.join(GURT_ROOT, 'acme', 'workspace.json'), 'utf8'))
  assert.match(saved.envs[0].devcontainer, /node:24/, 'the write stands')
  assert.equal(commitCount(), count, 'no commit landed — the journal failed quietly')
  fs.rmSync(lock)

  // A deleted repository: the next mutation re-inits and journals again.
  fs.rmSync(path.join(GURT_ROOT, '.git'), { recursive: true, force: true })
  await m.updateEnv('acme', { name: 'node20', devcontainer: '{"image":"node:25"}' })
  const reborn = JSON.parse(fs.readFileSync(path.join(GURT_ROOT, 'acme', 'workspace.json'), 'utf8'))
  assert.match(reborn.envs[0].devcontainer, /node:25/, 'the write stands here too')
  assert.equal(commitCount(), 1, 'a fresh journal picked the record back up')
})
