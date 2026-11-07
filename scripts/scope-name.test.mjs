// A scope's name is its branch (src/shared/scopeName.ts): the rules git puts on
// a branch name, a `/` in it stored as one directory on disk, the clashes git
// cannot hold side by side, and a clone of such a scope landing on exactly
// that branch (real git, local bare origin — no electron, no docker).
//
//   node scripts/scope-name.test.mjs
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
const S = (rel) => JSON.stringify(path.join(ROOT, rel))
const outfile = path.join(os.tmpdir(), `gurt-scope-name-${process.pid}.mjs`)

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-scope-name-'))
// store.ts reads GURT_ROOT at module load — set it before importing the bundle.
process.env.GURT_ROOT = path.join(root, 'gurt')

await bundle({
  stdin: {
    contents: [
      `export * from ${S('src/shared/scopeName.ts')}`,
      `export { createTask, renameTask, listTasks, taskDir, cloneDir, validateNewTaskName } from ${S('src/main/store.ts')}`,
      `export { ensureClone } from ${S('src/main/provision.ts')}`
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})

const m = await import(pathToFileURL(outfile).href)

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outfile, { force: true })
})

/** What `git check-ref-format --branch` says, for comparison. */
const gitAccepts = (name) =>
  pexecFile('git', ['check-ref-format', '--branch', name]).then(
    () => true,
    () => false
  )

test('the rules are git branch rules', async () => {
  const valid = ['fix-login', 'feat/login', 'user/feat/x', 'v1.2', 'fix_#12', 'ünïcode', 'a@b', 'Release-2']
  const invalid = [
    '', 'fix login', 'a..b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b', 'a\\b', '-x', '/x', 'x/', 'a//b',
    '.x', 'a/.x', 'x.lock', 'a/x.lock/b', 'x.', '@', 'a@{b', 'HEAD', 'tab\there'
  ]
  for (const name of valid) {
    assert.equal(m.scopeNameProblem(name), null, `${name} is valid`)
    assert.ok(await gitAccepts(name), `git agrees ${name} is valid`)
  }
  for (const name of invalid) {
    assert.ok(m.scopeNameProblem(name), `${JSON.stringify(name)} is refused`)
    // git reads `@` and `HEAD` as the current branch rather than refusing them.
    if (name && name !== 'HEAD' && name !== '@') assert.equal(await gitAccepts(name), false, `git agrees ${name} is invalid`)
  }
  // gurt's own additions on top of git's.
  for (const name of ['main', 'Master', 'refs/heads/x', 'origin/x', '50%', 'x'.repeat(101)])
    assert.ok(m.scopeNameProblem(name), `${name} is refused by gurt`)
  assert.equal(m.scopeNameProblem('origin-fix'), null, 'only the prefix component counts')
})

test('input is normalized, not repaired', () => {
  assert.equal(m.normalizeScopeName('  fix   login\tnow '), 'fix-login-now')
  assert.deepEqual(m.scopeNameInput('fix login', []), { name: 'fix-login', error: null })
  assert.ok(m.scopeNameInput('fix~login', []).error, 'a bad character is explained, not dropped')
  assert.deepEqual(m.scopeNameInput('', []), { name: '', error: null }, 'nothing typed, nothing to say')
  assert.deepEqual(
    m.scopeNameInput('old name', ['old name'], 'old name'),
    { name: 'old name', error: null },
    'an untouched rename of a legacy name stays as it is'
  )
})

test('clashes git cannot hold', () => {
  assert.ok(m.scopeNameConflict('fix', ['Fix']), 'case-insensitive duplicate')
  assert.ok(m.scopeNameConflict('feat', ['feat/login']), 'a prefix of an existing branch')
  assert.ok(m.scopeNameConflict('feat/login/x', ['feat/login']), 'under an existing branch')
  assert.equal(m.scopeNameConflict('feat-x', ['feat']), null)
  assert.equal(m.scopeNameConflict('fix', ['Fix'], 'Fix'), null, 'a rename does not clash with itself')
})

test('a "/" is one directory on disk and round-trips', async () => {
  assert.equal(m.scopeDirName('feat/login'), 'feat%2Flogin')
  assert.equal(m.scopeFromDirName(m.scopeDirName('a/b/c')), 'a/b/c')
  await pexecFile('git', ['init', '-q', path.join(root, 'noop')]) // git is present
  fs.mkdirSync(path.join(process.env.GURT_ROOT, 'ws'), { recursive: true })
  await m.createTask('ws', 'feat/login')
  assert.equal(m.taskDir('ws', 'feat/login'), path.join(process.env.GURT_ROOT, 'ws', 'feat%2Flogin'))
  assert.ok(fs.existsSync(path.join(process.env.GURT_ROOT, 'ws', 'feat%2Flogin', 'task.json')))
  assert.deepEqual(await m.listTasks('ws'), ['feat/login'])

  await assert.rejects(m.createTask('ws', 'feat'), /cannot both be branches/)
  await assert.rejects(m.createTask('ws', 'FEAT/LOGIN'), /already exists/)
  await assert.rejects(m.createTask('ws', 'fix login'), /spaces/)
  await assert.rejects(m.createTask('ws', 'skills'), /reserved/)

  await m.renameTask('ws', 'feat/login', 'feat/sign-in')
  assert.deepEqual(await m.listTasks('ws'), ['feat/sign-in'])
  await m.createTask('ws', 'other')
  await assert.rejects(m.renameTask('ws', 'other', 'feat/sign-in/x'), /cannot both be branches/)
  await assert.rejects(m.renameTask('ws', 'other', 'a..b'), /\.\./)
})

test('a legacy name that is no branch still lists and resolves', async () => {
  const dir = path.join(process.env.GURT_ROOT, 'ws', 'old name')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'task.json'), '{}')
  assert.ok((await m.listTasks('ws')).includes('old name'))
  assert.equal(m.taskDir('ws', 'old name'), dir)
})

// --- clones: the branch is the scope name, `/` included ---
const origin = path.join(root, 'origin.git')
const seed = path.join(root, 'seed')
const REPO = { name: 'demo', url: origin }
const branchOf = (dir) =>
  pexecFile('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']).then((r) => r.stdout.trim())

test('a clone of a scope with "/" works on that branch', async () => {
  await pexecFile('git', ['init', '-q', '--bare', origin])
  await pexecFile('git', ['-C', origin, 'symbolic-ref', 'HEAD', 'refs/heads/develop'])
  await pexecFile('git', ['init', '-q', seed])
  fs.writeFileSync(path.join(seed, 'README.md'), 'hi\n')
  const gitSeed = (...args) =>
    pexecFile('git', ['-C', seed, '-c', 'user.email=t@t.test', '-c', 'user.name=t', ...args])
  await gitSeed('add', '-A')
  await gitSeed('commit', '-q', '-m', 'init')
  await gitSeed('push', '-q', origin, 'HEAD:refs/heads/develop')

  const dir = await m.ensureClone({ workspace: 'ws', task: 'feat/sign-in', env: 'e' }, REPO, () => {})
  assert.equal(dir, path.join(process.env.GURT_ROOT, 'ws', 'feat%2Fsign-in', 'demo'))
  assert.equal(await branchOf(dir), 'feat/sign-in')
})

test("a scope named after a repo's default branch is refused at provisioning", async () => {
  // `develop` passes as a name — only provisioning knows it is this repo's default.
  assert.equal(m.scopeNameProblem('develop'), null)
  await assert.rejects(
    m.ensureClone({ workspace: 'ws', task: 'develop', env: 'e' }, REPO, () => {}),
    /default branch/
  )
})
