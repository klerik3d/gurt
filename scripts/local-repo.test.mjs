// Integration test for local repos (docs/requirements-new-projects.md §2, §4):
// real git, no electron, no docker, no network. A repo gurt creates itself is
// clonable by a task, takes the task's commits, lands them on its default
// branch through "merge into main" — and the next task starts from there. The
// store keeps the `local` flag its own.
//
//   node scripts/local-repo.test.mjs
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
const outfile = path.join(os.tmpdir(), `gurt-local-repo-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-local-repo-'))
// store.ts reads GURT_ROOT at module load — set it before importing the bundle.
process.env.GURT_ROOT = path.join(root, 'gurt')

// Publishing (§6) without a network: the forge API is a stubbed fetch, and the
// https url it hands back is rewritten by git onto a local bare repo — the
// same `insteadOf` mechanism the managed transport itself rides on.
const FORGE = path.join(root, 'forge')
fs.mkdirSync(FORGE)
Object.assign(process.env, {
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: `url.${FORGE}/.insteadOf`,
  GIT_CONFIG_VALUE_0: 'https://github.com/octo/'
})
fs.mkdirSync(process.env.GURT_ROOT, { recursive: true })
fs.writeFileSync(
  path.join(process.env.GURT_ROOT, 'credentials.json'),
  JSON.stringify({
    version: 2,
    credentials: [
      {
        id: 'gh',
        label: 'github pat',
        kind: 'git-token',
        hosts: ['github.com'],
        data: { secret: 'ghp-test', gitName: 'Octo', gitEmail: 'octo@users.noreply.github.com' }
      }
    ]
  })
)
const forgeCalls = []
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body)
  forgeCalls.push({ url: String(url), body, auth: init.headers.Authorization })
  await pexecFile('git', ['init', '-q', '--bare', path.join(FORGE, `${body.name}.git`)])
  return new Response(
    JSON.stringify({
      clone_url: `https://github.com/octo/${body.name}.git`,
      html_url: `https://github.com/octo/${body.name}`
    }),
    { status: 201 }
  )
}
// A local repo resolves no credential, so host commits take the ambient git
// identity — give the test one that does not depend on the machine's config.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t.test',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t.test'
})

await bundle({
  stdin: {
    contents: `
export { createLocalRepo, publishLocalRepo } from ${S('src/main/localRepo.ts')}
export { ensureClone } from ${S('src/main/provision.ts')}
export { hostGitAccessForRepo } from ${S('src/main/git/env.ts')}
export { getTaskChanges, commit, push, mergeToMain } from ${S('src/main/changes.ts')}
export { createWorkspace, createTask, getWorkspace, addRepo, updateRepo, removeRepo, localRepoDir } from ${S('src/main/store.ts')}
`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})

const m = await import(pathToFileURL(outfile).href)

const WS = 'ws'
const ref = (task) => ({ workspace: WS, task, env: 'starter' })
const git = (dir, ...args) => pexecFile('git', ['-C', dir, ...args]).then((r) => r.stdout.trim())

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outfile, { force: true })
})

// Publishing starts the host credential broker, a process-lifetime singleton
// with no teardown, whose listener would keep this process alive — and a root
// `after` only runs once the loop drains, so it is unref'd right where it
// starts (the host-cred-broker.test.mjs approach, moved earlier).
const unrefBroker = () => {
  const handles = /** @type {any} */ (process)._getActiveHandles?.() ?? []
  for (const h of handles) if (h?.constructor?.name === 'Server') h.unref()
}

await m.createWorkspace(WS)

test('createLocalRepo: a bare repo with one empty commit, registered as local', async () => {
  const repo = await m.createLocalRepo(WS, 'proj')
  assert.deepEqual(repo, { name: 'proj', url: m.localRepoDir(WS, 'proj'), local: true })
  assert.deepEqual((await m.getWorkspace(WS)).repos, [repo])
  assert.equal(await git(repo.url, 'rev-parse', '--is-bare-repository'), 'true')
  assert.equal(await git(repo.url, 'rev-list', '--count', 'main'), '1')
  assert.equal((await m.hostGitAccessForRepo(WS, 'proj')).mode, 'local')
})

test('createLocalRepo refuses a taken name and an unsafe one, leaving nothing behind', async () => {
  await assert.rejects(m.createLocalRepo(WS, 'proj'), /already exists/)
  await assert.rejects(m.createLocalRepo(WS, '../escape'), /must not contain/)
  assert.equal(fs.existsSync(path.join(process.env.GURT_ROOT, WS, 'escape.git')), false)
})

test('the local flag is the store’s: no forging it, no losing it on edit', async () => {
  await assert.rejects(
    m.addRepo(WS, { name: 'fake', url: '/tmp/elsewhere.git', local: true }),
    /only gurt creates local repos/
  )
  // An edit from the form carries neither the flag nor a meaningful url.
  await m.updateRepo(WS, { name: 'proj', url: 'https://example.com/x.git' })
  const after = (await m.getWorkspace(WS)).repos.find((r) => r.name === 'proj')
  assert.deepEqual(after, { name: 'proj', url: m.localRepoDir(WS, 'proj'), local: true })
})

test('a task clones it, commits, pushes and merges into main; the next task starts there', async () => {
  const repo = (await m.getWorkspace(WS)).repos[0]
  await m.createTask(WS, 't1')
  const dir = await m.ensureClone(ref('t1'), repo, () => {})
  assert.equal(await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 't1')

  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hi\n')
  await m.commit(WS, 't1', 'proj', 'add hello')
  let [ch] = await m.getTaskChanges(WS, 't1')
  assert.equal(ch.local, true)
  assert.equal(ch.prUrl, undefined)
  assert.equal(ch.commits.length, 1)
  assert.equal(ch.integrated, false)

  await m.push(WS, 't1', 'proj')
  await m.mergeToMain(WS, 't1', 'proj')
  ;[ch] = await m.getTaskChanges(WS, 't1', { fetch: true })
  assert.equal(ch.commits.length, 0)
  assert.equal(ch.integrated, true)

  await m.createTask(WS, 't2')
  const dir2 = await m.ensureClone(ref('t2'), repo, () => {})
  assert.equal(fs.readFileSync(path.join(dir2, 'hello.txt'), 'utf8'), 'hi\n')
})

test('mergeToMain refuses a branch behind main', async () => {
  const repo = (await m.getWorkspace(WS)).repos[0]
  await m.createTask(WS, 't3')
  const dir3 = await m.ensureClone(ref('t3'), repo, () => {})
  // t2 lands a commit on main after t3 forked.
  const dir2 = path.join(process.env.GURT_ROOT, WS, 't2', 'proj')
  fs.writeFileSync(path.join(dir2, 'two.txt'), '2\n')
  await m.commit(WS, 't2', 'proj', 'two')
  await m.mergeToMain(WS, 't2', 'proj')

  fs.writeFileSync(path.join(dir3, 'three.txt'), '3\n')
  await m.commit(WS, 't3', 'proj', 'three')
  await assert.rejects(m.mergeToMain(WS, 't3', 'proj'), /behind main — update from main first/)
})

test('createTask refuses the name of the local repo storage', async () => {
  await assert.rejects(m.createTask(WS, 'repos'), /reserved/)
})

test('removeRepo deletes a local repo’s storage once no task holds a clone', async () => {
  await m.createLocalRepo(WS, 'gone')
  const dir = m.localRepoDir(WS, 'gone')
  assert.ok(fs.existsSync(dir))
  await m.removeRepo(WS, 'gone')
  assert.equal(fs.existsSync(dir), false)
  // …and refuses while a clone exists, keeping the storage.
  await assert.rejects(m.removeRepo(WS, 'proj'), /has a clone/)
  assert.ok(fs.existsSync(m.localRepoDir(WS, 'proj')))
})

test('publish: forge repo created, history pushed, clones re-pointed, env adopted, storage gone', async () => {
  // Give the project a devcontainer on main, the way an agent would.
  const dir = path.join(process.env.GURT_ROOT, WS, 't1', 'proj')
  await git(dir, 'pull', '-q', '--ff-only', 'origin', 'main')
  fs.mkdirSync(path.join(dir, '.devcontainer'))
  fs.writeFileSync(path.join(dir, '.devcontainer', 'devcontainer.json'), '{ "image": "python:3" }\n')
  await m.commit(WS, 't1', 'proj', 'devcontainer')
  await m.mergeToMain(WS, 't1', 'proj')

  const res = await m.publishLocalRepo(WS, 'proj', {
    credentialId: 'gh',
    private: true,
    adoptEnv: true
  })
  unrefBroker()
  assert.deepEqual(forgeCalls, [
    {
      url: 'https://api.github.com/user/repos',
      body: { name: 'proj', private: true, auto_init: false },
      auth: 'Bearer ghp-test'
    }
  ])
  assert.equal(res.url, 'https://github.com/octo/proj.git')
  assert.equal(res.env, 'proj')

  const ws = await m.getWorkspace(WS)
  assert.deepEqual(ws.repos.find((r) => r.name === 'proj'), {
    name: 'proj',
    url: 'https://github.com/octo/proj.git',
    credentialId: 'gh'
  })
  assert.deepEqual(ws.envs, [{ name: 'proj', devcontainer: '{ "image": "python:3" }\n', repo: 'proj' }])
  assert.equal(fs.existsSync(m.localRepoDir(WS, 'proj')), false, 'local storage removed')

  // The forge holds the whole history, and every task's clone follows it.
  const forge = path.join(FORGE, 'proj.git')
  assert.equal(await git(forge, 'rev-parse', 'main'), await git(dir, 'rev-parse', 'origin/main'))
  for (const task of ['t1', 't2', 't3'])
    assert.equal(
      await git(path.join(process.env.GURT_ROOT, WS, task, 'proj'), 'config', 'remote.origin.url'),
      'https://github.com/octo/proj.git'
    )
  assert.equal((await m.hostGitAccessForRepo(WS, 'proj')).mode, 'managed')
  const [ch] = await m.getTaskChanges(WS, 't3', { fetch: true })
  assert.equal(ch.local, undefined)
})

test('publish refuses a repo that is not local', async () => {
  await assert.rejects(
    m.publishLocalRepo(WS, 'proj', { credentialId: 'gh', private: true, adoptEnv: false }),
    /already on a forge/
  )
})
