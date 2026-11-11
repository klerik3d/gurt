// Review loop slice 5 — delivery and the tree hash
// (docs/requirements-review-loop.md §6, "diff hash" under Terms, §8's `deliver`
// rows, §12 item 7). Real git on local bare origins, a recording `gh` shim for
// the PR, no docker, no network, no electron:
//   - diffHash: tracked-but-ignored files count, untracked ignored ones do not,
//     the real index is never touched, stable across calls, moves on an edit;
//   - ladderFor per repo kind;
//   - each rung (commit / push / pr / merge) and the order of the steps;
//   - nothing committed when a precondition fails;
//   - a second repo's failing pre-commit hook -> a typed failure listing the
//     first repo's commit; rejected push; failing gh;
//   - every step repeats safely after a crash between effect and record (the
//     recovery probes of §8), a remote advanced by someone else is reported,
//     a diverged one is a non-fast-forward failure;
//   - the github MCP tool `create_pull_request` still behaves, and refuses a
//     local repo.
//
//   node scripts/review-loop-delivery.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bundle } from './lib/bundle.mjs'
import { makeEvil } from './lib/evil-clone.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const S = (rel) => JSON.stringify(path.join(ROOT, rel))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-delivery-'))
const outfile = path.join(root, 'delivery.mjs')
after(() => fs.rmSync(root, { recursive: true, force: true }))

// store.ts reads GURT_ROOT at module load.
process.env.GURT_ROOT = path.join(root, 'store')
const WS = 'ws'
// Host commits take the ambient identity (a git-host / local repo adds none).
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test'
})

// --- the workspace: two forge repos (explicit host credential -> ambient git
// and gh), one local repo --------------------------------------------------
const origins = path.join(root, 'origins')
fs.mkdirSync(origins, { recursive: true })
fs.mkdirSync(path.join(process.env.GURT_ROOT, WS), { recursive: true })
fs.writeFileSync(
  path.join(process.env.GURT_ROOT, WS, 'workspace.json'),
  JSON.stringify({
    repos: [
      { name: 'api', url: 'https://github.com/octo/api.git' },
      { name: 'web', url: 'https://github.com/octo/web.git' },
      { name: 'lib', url: path.join(origins, 'lib-registered.git'), local: true },
      { name: 'gl', url: 'https://gitlab.com/octo/gl.git' }
    ],
    envs: []
  })
)
fs.writeFileSync(
  path.join(process.env.GURT_ROOT, 'credentials.json'),
  JSON.stringify({
    version: 2,
    credentials: [
      { id: 'h', label: 'host auth', kind: 'git-host', hosts: ['github.com'], data: {} },
      { id: 'g', label: 'gitlab host auth', kind: 'git-host', hosts: ['gitlab.com'], data: {} }
    ]
  })
)

// --- the recording gh shim -------------------------------------------------
const shimDir = path.join(root, 'bin')
const ghLog = path.join(root, 'gh.log')
const ghState = path.join(root, 'gh-state.json')
fs.mkdirSync(shimDir)
fs.writeFileSync(
  path.join(shimDir, 'gh'),
  `#!${process.execPath}
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const args = process.argv.slice(2)
const branch = () => execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
const repo = require('node:path').basename(process.cwd())
// What the real gh does in the clone before it opens or looks for a PR (it asks git for the work tree's state).
try { execFileSync('git', ['status', '--porcelain'], { stdio: 'ignore', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }) } catch {}
fs.appendFileSync(process.env.GH_SHIM_LOG, JSON.stringify({ args, repo, ghHost: process.env.GH_HOST ?? null }) + '\\n')
const state = fs.existsSync(process.env.GH_SHIM_STATE) ? JSON.parse(fs.readFileSync(process.env.GH_SHIM_STATE, 'utf8')) : {}
if (args[0] === 'pr' && args[1] === 'view') {
  const pr = state[repo + ':' + args[2]]
  if (!pr) { console.error('no pull requests found for branch "' + args[2] + '"'); process.exit(1) }
  console.log(JSON.stringify(pr)); process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'create') {
  if (process.env.GH_SHIM_FAIL) { console.error('GraphQL: rate limited (the shim says so)'); process.exit(1) }
  const key = repo + ':' + branch()
  if (state[key]) { console.error('a pull request for branch already exists'); process.exit(1) }
  state[key] = { url: 'https://github.com/octo/' + repo + '/pull/' + (Object.keys(state).length + 1), state: 'OPEN' }
  fs.writeFileSync(process.env.GH_SHIM_STATE, JSON.stringify(state))
  console.log(state[key].url); process.exit(0)
}
console.error('unexpected gh call: ' + args.join(' ')); process.exit(2)
`,
  { mode: 0o755 }
)
Object.assign(process.env, {
  PATH: `${shimDir}:${process.env.PATH}`,
  GH_SHIM_LOG: ghLog,
  GH_SHIM_STATE: ghState
})
const ghCalls = () =>
  fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
const ghCreates = () => ghCalls().filter((c) => c.args[1] === 'create')

await bundle({
  stdin: {
    contents: `
export * as delivery from ${S('src/main/delivery.ts')}
export * as treeHash from ${S('src/main/treeHash.ts')}
export * as loop from ${S('src/shared/reviewLoop.ts')}
export * as changes from ${S('src/main/changes.ts')}
export { hardenGit } from ${S('src/main/git/harden.ts')}
export { unattendedGitAccessForRepo } from ${S('src/main/git/env.ts')}
export { buildGithubHttpServer } from ${S('src/main/mcp/githubServer.ts')}
`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})
const m = await import(pathToFileURL(outfile).href)
const { delivery: D, treeHash: T, loop, changes: C, hardenGit, unattendedGitAccessForRepo } = m

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), text)
}
const hook = (dir, name, script) =>
  fs.writeFileSync(path.join(dir, '.git', 'hooks', name), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
/** A hook of the bare ORIGIN: the push's receiving side, which the loop's hook-less git does not switch off. */
const originHook = (remote, name, script) =>
  fs.writeFileSync(path.join(remote, 'hooks', name), `#!/bin/sh\n${script}\n`, { mode: 0o755 })

let seq = 0
/** A task with clones of `names`, each on branch `<task>` with one base commit
 *  pushed to its own bare origin's `main`. */
function fixture(names = ['api', 'web']) {
  const task = `t${++seq}`
  const clones = {}
  const remotes = {}
  for (const name of names) {
    const dir = path.join(process.env.GURT_ROOT, WS, task, name)
    const remote = path.join(origins, `${task}-${name}.git`)
    fs.mkdirSync(dir, { recursive: true })
    git(root, 'init', '-q', '--bare', '-b', 'main', remote)
    git(dir, 'init', '-q', '-b', task)
    write(dir, '.gitignore', 'ignored.log\nbuild/\n')
    write(dir, 'file.txt', 'base\n')
    write(dir, 'build/keep.txt', 'tracked but ignored\n')
    git(dir, 'add', '-A', '-f')
    git(dir, 'commit', '-q', '-m', 'base')
    git(dir, 'remote', 'add', 'origin', remote)
    git(dir, 'push', '-q', 'origin', 'HEAD:main')
    git(dir, 'fetch', '-q', 'origin')
    clones[name] = dir
    remotes[name] = remote
  }
  return { task, clones, remotes }
}
const PROPOSALS = {
  api: { commit: { subject: 'api: add feature', body: 'Longer API body.' }, pr: { title: 'API feature', body: 'API PR body' } },
  web: { commit: { subject: 'web: wire feature' } },
  lib: { commit: { subject: 'lib: change', body: 'lib body' } }
}
const ctxOf = (task, reviewedHash, extra = {}) => ({
  ws: WS, task, reviewedHash, draftPr: true, notes: [],
  proposalFor: (repo) => PROPOSALS[repo],
  ...extra
})
const hash = (task, repos) => T.diffHash(WS, task, repos)
const headOf = (dir) => git(dir, 'rev-parse', 'HEAD')

// ============================================================ ladderFor ====
test('ladderFor: the rungs per repo kind (§3 When clean)', () => {
  const forge = { name: 'a' }
  const local = { name: 'b', local: true }
  assert.deepEqual(loop.ladderFor([forge, forge]), ['notify', 'commit', 'push', 'pr'])
  assert.deepEqual(loop.ladderFor([local]), ['notify', 'commit', 'merge'])
  assert.deepEqual(loop.ladderFor([local, local]), ['notify', 'commit', 'merge'])
  assert.deepEqual(loop.ladderFor([forge, local]), ['notify', 'commit'])
  assert.deepEqual(loop.ladderFor([]), ['notify'])
})

// ============================================================= diffHash ====
test('diffHash: ignored files — a tracked one counts, an untracked one does not', async () => {
  const { task, clones } = fixture(['api'])
  const dir = clones.api
  const h0 = await hash(task, ['api'])
  write(dir, 'ignored.log', 'noise\n') // untracked + ignored
  write(dir, 'build/other.o', 'noise\n') // untracked, inside an ignored dir
  assert.equal(await hash(task, ['api']), h0, 'untracked ignored files are invisible')
  write(dir, 'build/keep.txt', 'edited\n') // tracked + matches .gitignore
  const h1 = await hash(task, ['api'])
  assert.notEqual(h1, h0, 'a tracked file matching .gitignore counts')
  write(dir, 'new.txt', 'x\n') // untracked, not ignored
  assert.notEqual(await hash(task, ['api']), h1)
})

test('diffHash: stable across calls, the real index and the clone are untouched, no scratch left', async () => {
  const { task, clones } = fixture(['api'])
  const dir = clones.api
  write(dir, 'file.txt', 'staged edit\n')
  git(dir, 'add', 'file.txt') // staged in the REAL index
  write(dir, 'file.txt', 'staged edit\nplus an unstaged one\n')
  write(dir, 'untracked.txt', 'u\n')
  const indexBefore = fs.readFileSync(path.join(dir, '.git', 'index'))
  const lsBefore = git(dir, 'ls-files', '-s')
  const statusBefore = git(dir, 'status', '--porcelain')
  const gitDirBefore = fs.readdirSync(path.join(dir, '.git')).sort()
  const a = await hash(task, ['api'])
  const b = await hash(task, ['api'])
  assert.equal(a, b)
  assert.deepEqual(fs.readFileSync(path.join(dir, '.git', 'index')), indexBefore, 'the real index file is byte-identical')
  assert.equal(git(dir, 'ls-files', '-s'), lsBefore)
  assert.equal(git(dir, 'status', '--porcelain'), statusBefore, 'untracked stays untracked, unstaged stays unstaged')
  assert.deepEqual(fs.readdirSync(path.join(dir, '.git')).sort(), gitDirBefore, 'nothing written into .git')
  const parsed = T.parseDiffHash(a)
  assert.deepEqual(Object.keys(parsed), ['api'])
  assert.equal(parsed.api.head, headOf(dir))
  // It is the tree a commit would record — including the unstaged edit and the untracked file.
  git(dir, 'add', '-A')
  assert.equal(parsed.api.tree, git(dir, 'write-tree'))
})

test('diffHash: moves with a content edit and with a new HEAD; multi-repo and order-independent', async () => {
  const { task, clones } = fixture(['api', 'web'])
  const both = await hash(task, ['api', 'web'])
  assert.equal(await hash(task, ['web', 'api']), both)
  assert.deepEqual(Object.keys(T.parseDiffHash(both)), ['api', 'web'])
  write(clones.web, 'file.txt', 'changed\n')
  const edited = await hash(task, ['api', 'web'])
  assert.notEqual(edited, both)
  assert.equal(T.parseDiffHash(edited).api.tree, T.parseDiffHash(both).api.tree, 'only the edited repo moved')
  git(clones.web, 'add', '-A')
  git(clones.web, 'commit', '-q', '-m', 'commit it')
  const committed = T.parseDiffHash(await hash(task, ['api', 'web']))
  assert.equal(committed.web.tree, T.parseDiffHash(edited).web.tree, 'committing the same content keeps the tree')
  assert.notEqual(committed.web.head, T.parseDiffHash(edited).web.head, 'but HEAD moved, so the hash did')
  assert.equal(T.parseDiffHash('not json'), undefined)
})

// ===================================================== the rungs, in order ====

test('commit rung: commit text from the proposal (subject, blank line, body); a clean repo is skipped', async () => {
  const { task, clones, remotes } = fixture(['api', 'web'])
  write(clones.api, 'file.txt', 'api change\n')
  write(clones.api, 'build/keep.txt', 'ignored-but-tracked change\n')
  write(clones.api, 'brand-new.txt', 'new\n')
  const reviewed = await hash(task, ['api', 'web'])
  const out = await D.deliverAll(ctxOf(task, reviewed), 'commit', ['api', 'web'])
  assert.deepEqual(out.map((s) => [s.repo, s.step]), [['api', 'commit']], 'web is clean: no step at all')
  assert.equal(out[0].ref, headOf(clones.api))
  assert.equal(git(clones.api, 'log', '-1', '--format=%B').trim(), 'api: add feature\n\nLonger API body.')
  assert.equal(git(clones.api, 'status', '--porcelain'), '')
  assert.equal(git(clones.api, 'rev-parse', 'HEAD^{tree}'), T.parseDiffHash(reviewed).api.tree, 'the commit is exactly the reviewed tree')
  assert.equal(git(clones.api, 'show', 'HEAD:build/keep.txt'), 'ignored-but-tracked change')
  assert.equal(git(remotes.api, 'branch', '--list', task), '', 'nothing was pushed')
  // The step itself, on a clean repo: skipped, with a note, ref = HEAD.
  const skipped = await D.deliverStep(ctxOf(task, await hash(task, ['api', 'web'])), { repo: 'web', step: 'commit', head: headOf(clones.web) })
  assert.deepEqual([skipped.step, skipped.ref, skipped.note], ['commit', headOf(clones.web), 'nothing to commit'])
  assert.equal(git(clones.web, 'rev-list', '--count', 'HEAD'), '1')
})

test('push rung: all commits first, then the pushes; branches land on the origins', async () => {
  const { task, clones, remotes } = fixture(['api', 'web'])
  write(clones.api, 'file.txt', 'api\n')
  write(clones.web, 'file.txt', 'web\n')
  const out = await D.deliverAll(ctxOf(task, await hash(task, ['api', 'web'])), 'push', ['api', 'web'])
  assert.deepEqual(out.map((s) => `${s.step}:${s.repo}`), ['commit:api', 'commit:web', 'push:api', 'push:web'])
  assert.equal(out[2].ref, task)
  for (const r of ['api', 'web']) assert.equal(git(remotes[r], 'rev-parse', task), headOf(clones[r]))
  assert.equal(git(remotes.api, 'rev-parse', 'main'), git(clones.api, 'rev-parse', 'HEAD~1'), 'main untouched: nothing merged')
  assert.equal(ghCalls().filter((c) => c.repo === 'api' && c.args[0] === 'pr').length, 0, 'no PR at the push rung')
})

test('pr rung: draft PR per repo with title/body from the proposal, review notes only for their repo; the PR is never merged', async () => {
  const { task, clones, remotes } = fixture(['api', 'web'])
  write(clones.api, 'file.txt', 'api\n')
  write(clones.web, 'file.txt', 'web\n')
  const notes = [
    { id: 'F1', file: 'api/src/a.ts', line: 7, severity: 'minor', claim: 'rename   this\nvariable', },
    { id: 'F2', file: 'web/x.ts', severity: 'nit', claim: 'spacing' }
  ]
  const before = ghCreates().length
  const out = await D.deliverAll(ctxOf(task, await hash(task, ['api', 'web']), { notes }), 'pr', ['api', 'web'])
  assert.deepEqual(out.map((s) => `${s.step}:${s.repo}`), ['commit:api', 'commit:web', 'push:api', 'push:web', 'pr:api', 'pr:web'])
  assert.match(out[4].ref, /^https:\/\/github\.com\/octo\/api\/pull\/\d+$/)
  const created = ghCreates().slice(before)
  assert.equal(created.length, 2)
  const arg = (c, flag) => c.args[c.args.indexOf(flag) + 1]
  const api = created.find((c) => c.repo === 'api')
  const web = created.find((c) => c.repo === 'web')
  assert.ok(api.args.includes('--draft') && web.args.includes('--draft'))
  assert.equal(arg(api, '--title'), 'API feature')
  assert.equal(arg(api, '--body'), 'API PR body\n\n## Review notes\n- [minor] `api/src/a.ts:7` — rename this variable')
  assert.equal(arg(web, '--title'), 'web: wire feature', 'no `pr` in the proposal: the commit subject')
  assert.equal(arg(web, '--body'), '## Review notes\n- [nit] `web/x.ts` — spacing')
  assert.ok(ghCalls().every((c) => !c.args.includes('merge')), 'nothing on a forge is merged')
  assert.equal(git(remotes.api, 'rev-parse', 'main'), git(clones.api, 'rev-parse', 'HEAD~1'))
})

test('pr rung with draftPr off opens a ready PR', async () => {
  const { task, clones } = fixture(['web'])
  write(clones.web, 'file.txt', 'web\n')
  const before = ghCreates().length
  await D.deliverAll(ctxOf(task, await hash(task, ['web']), { draftPr: false }), 'pr', ['web'])
  const [c] = ghCreates().slice(before)
  assert.ok(!c.args.includes('--draft'))
})

test('merge rung on a local repo: commit, then a fast-forward of the origin default branch', async () => {
  const { task, clones, remotes } = fixture(['lib'])
  write(clones.lib, 'file.txt', 'lib\n')
  const out = await D.deliverAll(ctxOf(task, await hash(task, ['lib'])), 'merge', ['lib'])
  assert.deepEqual(out.map((s) => `${s.step}:${s.repo}`), ['commit:lib', 'merge:lib'])
  assert.equal(out[1].ref, 'main')
  assert.equal(git(remotes.lib, 'rev-parse', 'main'), headOf(clones.lib))
  assert.equal(git(remotes.lib, 'branch', '--list', task), '', 'the task branch is not pushed — the default branch is')
})

test('pr on a local repo, or on a non-GitHub origin, is a typed failure with nothing opened', async () => {
  const { task, clones } = fixture(['lib'])
  write(clones.lib, 'file.txt', 'lib\n')
  const reviewed = await hash(task, ['lib'])
  const before = ghCalls().length
  await assert.rejects(
    D.deliverStep(ctxOf(task, reviewed), { repo: 'lib', step: 'pr', head: headOf(clones.lib) }),
    (/** @type {any} */ e) => e.kind === 'pr-failed' && /local to gurt/.test(e.tail) && e.repo === 'lib' && e.step === 'pr'
  )
  assert.equal(ghCalls().length, before)
  // GitHub only today: another forge's repo is refused before gh is asked anything.
  const gl = fixture(['gl'])
  write(gl.clones.gl, 'file.txt', 'gl\n')
  await assert.rejects(
    D.deliverStep(ctxOf(gl.task, await hash(gl.task, ['gl'])), { repo: 'gl', step: 'pr', head: headOf(gl.clones.gl) }),
    (/** @type {any} */ e) => e.kind === 'pr-failed' && /GitHub only \(origin host: gitlab\.com\)/.test(e.tail)
  )
  assert.equal(ghCalls().length, before)
})

// ============================================================ preconditions ====
test('nothing is committed when the tree moved after the review', async () => {
  const { task, clones } = fixture(['api', 'web'])
  write(clones.api, 'file.txt', 'api\n')
  write(clones.web, 'file.txt', 'web\n')
  const reviewed = await hash(task, ['api', 'web'])
  write(clones.web, 'file.txt', 'web, edited after the review\n')
  const heads = { api: headOf(clones.api), web: headOf(clones.web) }
  await assert.rejects(D.deliverAll(ctxOf(task, reviewed), 'pr', ['api', 'web']), (/** @type {any} */ e) => {
    assert.ok(e instanceof D.DeliveryError)
    assert.equal(e.kind, 'tree-moved')
    assert.deepEqual(e.delivered, [])
    assert.match(e.message, /completed before it: nothing/)
    return true
  })
  assert.deepEqual({ api: headOf(clones.api), web: headOf(clones.web) }, heads, 'no commit anywhere')
  assert.ok(git(clones.api, 'status', '--porcelain').includes('file.txt'), 'the work is still uncommitted')
})

test('nothing is committed when a changed repo has no commit text', async () => {
  const { task, clones } = fixture(['api', 'web'])
  write(clones.api, 'file.txt', 'api\n')
  write(clones.web, 'file.txt', 'web\n')
  const reviewed = await hash(task, ['api', 'web'])
  const heads = [headOf(clones.api), headOf(clones.web)]
  const ctx = ctxOf(task, reviewed, { proposalFor: (r) => (r === 'api' ? PROPOSALS.api : undefined) })
  await assert.rejects(D.deliverAll(ctx, 'commit', ['api', 'web']), (/** @type {any} */ e) => {
    assert.equal(e.kind, 'no-commit-text')
    assert.match(e.tail, /web/)
    assert.doesNotMatch(e.tail, /api/)
    return true
  })
  assert.deepEqual([headOf(clones.api), headOf(clones.web)], heads, 'api was not committed either')
  // The precondition helper alone — the controller calls it first.
  await assert.rejects(D.checkDeliveryPreconditions(ctx, ['api', 'web']), /no commit text for web/)
  await D.checkDeliveryPreconditions(ctxOf(task, reviewed), ['api', 'web'])
  // A repo with no change needs no text.
  const clean = fixture(['api', 'web'])
  write(clean.clones.api, 'file.txt', 'api\n')
  await D.checkDeliveryPreconditions(
    ctxOf(clean.task, await hash(clean.task, ['api', 'web']), { proposalFor: (r) => (r === 'api' ? PROPOSALS.api : undefined) }),
    ['api', 'web']
  )
})

// ================================================================ failures ====
test('a second repo’s failing commit: a typed failure listing the first repo’s commit; nothing rolled back, nothing pushed', async () => {
  const { task, clones, remotes } = fixture(['api', 'web'])
  write(clones.api, 'file.txt', 'api\n')
  write(clones.web, 'file.txt', 'web\n')
  // Hooks are off for the loop's delivery (§6), so the failure is git's own: a stale index lock.
  const lock = path.join(clones.web, '.git', 'index.lock')
  fs.writeFileSync(lock, '')
  const reviewed = await hash(task, ['api', 'web'])
  const webHead = headOf(clones.web)
  await assert.rejects(D.deliverAll(ctxOf(task, reviewed), 'pr', ['api', 'web']), (/** @type {any} */ e) => {
    assert.ok(e instanceof D.DeliveryError)
    assert.deepEqual([e.kind, e.repo, e.step], ['commit-failed', 'web', 'commit'])
    assert.match(e.tail, /remove the file manually/, 'git’s own output is the tail (the last 3 lines)')
    assert.deepEqual(e.delivered, [{ repo: 'api', step: 'commit', ref: headOf(clones.api) }])
    assert.match(e.message, new RegExp(`commit api ${headOf(clones.api)}`))
    assert.match(e.message, /commit of web/)
    return true
  })
  assert.notEqual(headOf(clones.api), git(clones.api, 'rev-parse', 'HEAD~1'), 'api stays committed')
  assert.equal(headOf(clones.web), webHead)
  fs.rmSync(lock)
  assert.ok(git(clones.web, 'status', '--porcelain').includes('file.txt'), 'web’s work is intact')
  assert.equal(git(remotes.api, 'branch', '--list', task), '', 'no push followed')
  // Recovery of that very delivery, step by step: api's commit is found, web's goes through once the lock is gone.
  const heads = T.parseDiffHash(reviewed)
  const a = await D.deliverStep(ctxOf(task, reviewed), { repo: 'api', step: 'commit', head: heads.api.head })
  assert.equal(a.found, true)
  assert.equal(a.ref, headOf(clones.api))
  const w = await D.deliverStep(ctxOf(task, reviewed), { repo: 'web', step: 'commit', head: heads.web.head })
  assert.equal(w.ref, headOf(clones.web))
})

test('a rejected push stops delivery after the commits, with the rejection as the tail', async () => {
  const { task, clones, remotes } = fixture(['api', 'web'])
  write(clones.api, 'file.txt', 'api\n')
  write(clones.web, 'file.txt', 'web\n')
  originHook(remotes.api, 'pre-receive', 'echo "push policy says no" >&2\nexit 1')
  await assert.rejects(D.deliverAll(ctxOf(task, await hash(task, ['api', 'web'])), 'pr', ['api', 'web']), (/** @type {any} */ e) => {
    assert.deepEqual([e.kind, e.repo, e.step], ['push-failed', 'api', 'push'])
    assert.match(e.tail, /pre-receive hook declined/)
    assert.deepEqual(e.delivered.map((d) => `${d.step}:${d.repo}`), ['commit:api', 'commit:web'])
    return true
  })
  assert.equal(git(remotes.web, 'branch', '--list', task), '', 'web was not pushed after api failed')
})

test('a failing gh stops after the pushes: the failure lists commits and branches, quotes gh', async () => {
  const { task, clones } = fixture(['api'])
  write(clones.api, 'file.txt', 'api\n')
  process.env.GH_SHIM_FAIL = '1'
  try {
    await assert.rejects(D.deliverAll(ctxOf(task, await hash(task, ['api'])), 'pr', ['api']), (/** @type {any} */ e) => {
      assert.deepEqual([e.kind, e.repo, e.step], ['pr-failed', 'api', 'pr'])
      assert.match(e.tail, /rate limited/)
      assert.deepEqual(e.delivered.map((d) => `${d.step}:${d.ref === task ? 'branch' : 'sha'}`), ['commit:sha', 'push:branch'])
      return true
    })
  } finally {
    delete process.env.GH_SHIM_FAIL
  }
})

// ================================================ crash recovery, per step ====
/** A delivery stopped after `commit`; returns what a controller would hold. */
async function committed(names = ['api']) {
  const fx = fixture(names)
  for (const n of names) write(fx.clones[n], 'file.txt', `${n} change\n`)
  const reviewed = await hash(fx.task, names)
  const base = T.parseDiffHash(reviewed)
  const ctx = ctxOf(fx.task, reviewed)
  const steps = {}
  for (const n of names) steps[n] = await D.deliverStep(ctx, { repo: n, step: 'commit', head: base[n].head })
  return { ...fx, reviewed, base, ctx, steps }
}

test('commit repeats safely: the same SHA, no second commit; a moved HEAD with another tree is refused', async () => {
  const { task, clones, base, ctx, steps } = await committed(['api'])
  const again = await D.deliverStep(ctx, { repo: 'api', step: 'commit', head: base.api.head })
  assert.equal(again.ref, steps.api.ref)
  assert.equal(again.found, true)
  assert.equal(git(clones.api, 'rev-list', '--count', 'HEAD'), '2')
  // Someone commits something else on top: HEAD moved, but not to the reviewed tree.
  write(clones.api, 'file.txt', 'somebody else\n')
  git(clones.api, 'commit', '-q', '-am', 'meanwhile')
  await assert.rejects(D.deliverStep(ctx, { repo: 'api', step: 'commit', head: base.api.head }), (/** @type {any} */ e) => e.kind === 'tree-moved')
  assert.equal(git(clones.api, 'rev-list', '--count', 'HEAD'), '3', 'and nothing was committed on top of it')
  void task
})

test('push repeats safely: found at boot, the origin does not receive a second push', async () => {
  const { task, remotes, ctx, steps } = await committed(['api'])
  const pushes = path.join(root, `pushes-${task}`)
  originHook(remotes.api, 'pre-receive', `echo x >> ${pushes}`)
  const s = { repo: 'api', step: 'push', head: steps.api.ref }
  const first = await D.deliverStep(ctx, s)
  assert.deepEqual([first.ref, first.found], [task, undefined])
  assert.equal(fs.readFileSync(pushes, 'utf8').split('\n').filter(Boolean).length, 1)
  // Crash between the push and its record: the same intent runs again.
  const again = await D.deliverStep(ctx, s)
  assert.deepEqual([again.ref, again.found, again.note], [task, true, undefined])
  assert.equal(fs.readFileSync(pushes, 'utf8').split('\n').filter(Boolean).length, 1, 'not pushed twice')
  assert.equal(git(remotes.api, 'rev-parse', task), steps.api.ref)
})

test('push: a remote advanced by someone else is reported, not pushed over; a diverged one is a non-fast-forward failure', async () => {
  const { task, clones, remotes, ctx, steps } = await committed(['api'])
  const s = { repo: 'api', step: 'push', head: steps.api.ref }
  await D.deliverStep(ctx, s)
  const other = path.join(root, `other-${task}`)
  git(root, 'clone', '-q', '--branch', task, remotes.api, other)
  write(other, 'other.txt', 'someone else\n')
  git(other, 'add', '-A')
  git(other, 'commit', '-q', '-m', 'someone else')
  git(other, 'push', '-q', 'origin', task)
  const advanced = git(remotes.api, 'rev-parse', task)
  const again = await D.deliverStep(ctx, s)
  assert.equal(again.found, true)
  assert.match(again.note, new RegExp(`origin/${task} advanced to ${advanced.slice(0, 12)}`))
  assert.equal(git(remotes.api, 'rev-parse', task), advanced, 'nothing was pushed over it')
  void clones

  // Diverged: a fresh delivery whose branch already exists remotely with other history.
  const d = await committed(['web'])
  const dOther = path.join(root, `other-${d.task}`)
  git(root, 'clone', '-q', d.remotes.web, dOther)
  git(dOther, 'checkout', '-q', '-b', d.task)
  write(dOther, 'file.txt', 'diverging history\n')
  git(dOther, 'commit', '-q', '-am', 'diverge')
  git(dOther, 'push', '-q', 'origin', d.task)
  const remote = git(d.remotes.web, 'rev-parse', d.task)
  await assert.rejects(
    D.deliverStep(d.ctx, { repo: 'web', step: 'push', head: d.steps.web.ref }),
    (/** @type {any} */ e) => e.kind === 'non-fast-forward' && e.repo === 'web' && /diverged/.test(e.tail)
  )
  assert.equal(git(d.remotes.web, 'rev-parse', d.task), remote, 'never forced')
})

test('merge repeats safely; an advanced default branch is reported; a diverged one is a non-fast-forward failure', async () => {
  const { task, clones, remotes, ctx, steps } = await committed(['lib'])
  const s = { repo: 'lib', step: 'merge', head: steps.lib.ref }
  const first = await D.deliverStep(ctx, s)
  assert.deepEqual([first.ref, first.found], ['main', undefined])
  assert.equal(git(remotes.lib, 'rev-parse', 'main'), headOf(clones.lib))
  const again = await D.deliverStep(ctx, s)
  assert.deepEqual([again.ref, again.found, again.note], ['main', true, undefined])
  // Somebody lands more on main afterwards.
  const other = path.join(root, `other-${task}`)
  git(root, 'clone', '-q', remotes.lib, other)
  write(other, 'later.txt', 'later\n')
  git(other, 'add', '-A')
  git(other, 'commit', '-q', '-m', 'later')
  git(other, 'push', '-q', 'origin', 'main')
  const reported = await D.deliverStep(ctx, s)
  assert.equal(reported.found, true)
  assert.match(reported.note, /origin\/main advanced to/)

  // Diverged: main moved on without our commit.
  const d = await committed(['lib'])
  const dOther = path.join(root, `other-${d.task}`)
  git(root, 'clone', '-q', d.remotes.lib, dOther)
  write(dOther, 'file.txt', 'main moved on\n')
  git(dOther, 'commit', '-q', '-am', 'main moved')
  git(dOther, 'push', '-q', 'origin', 'main')
  const main = git(d.remotes.lib, 'rev-parse', 'main')
  await assert.rejects(
    D.deliverStep(d.ctx, { repo: 'lib', step: 'merge', head: d.steps.lib.ref }),
    (/** @type {any} */ e) => e.kind === 'non-fast-forward' && /behind main/.test(e.tail)
  )
  assert.equal(git(d.remotes.lib, 'rev-parse', 'main'), main)
})

test('pr repeats safely: an open PR for the branch is found, a second one is never created', async () => {
  const { task, clones, ctx, steps } = await committed(['api'])
  await D.deliverStep(ctx, { repo: 'api', step: 'push', head: steps.api.ref })
  const s = { repo: 'api', step: 'pr', head: steps.api.ref }
  const before = ghCreates().length
  const first = await D.deliverStep(ctx, s)
  assert.equal(first.found, undefined)
  assert.equal(ghCreates().length, before + 1)
  const view = ghCalls().filter((c) => c.args[1] === 'view').pop()
  assert.deepEqual(view.args, ['pr', 'view', task, '--json', 'url,state'])
  // Crash between `gh pr create` and the record.
  const again = await D.deliverStep(ctx, s)
  assert.deepEqual([again.ref, again.found], [first.ref, true])
  assert.equal(ghCreates().length, before + 1, 'no second gh pr create')
  void clones
})

test('a whole delivery run again after a crash after its last step: every step found, nothing repeated', async () => {
  const { task, clones, remotes, base, ctx } = await committed(['api'])
  const plan = loop.deliveryPlan('pr', ['api'])
  const sha = headOf(clones.api)
  const headFor = (p) => (p.step === 'commit' ? base.api.head : sha)
  const first = []
  for (const p of plan) first.push(await D.deliverStep(ctx, { ...p, head: headFor(p) }))
  const creates = ghCreates().length
  const second = []
  for (const p of plan) second.push(await D.deliverStep(ctx, { ...p, head: headFor(p) }))
  assert.deepEqual(second.map((s) => [s.step, s.ref, s.found]), first.map((s) => [s.step, s.ref, true]))
  assert.equal(ghCreates().length, creates)
  assert.equal(git(remotes.api, 'rev-parse', task), sha)
  assert.equal(git(clones.api, 'rev-list', '--count', 'HEAD'), '2')
})

// ======================================================== texts, pure ====
test('commit and PR texts', () => {
  assert.equal(D.commitMessage({ commit: { subject: ' s ', body: ' b ' } }), 's\n\nb')
  assert.equal(D.commitMessage({ commit: { subject: 's' } }), 's')
  assert.equal(D.commitMessage({ commit: { subject: '  ' } }), undefined)
  assert.equal(D.commitMessage(undefined), undefined)
  const f = (n, sev) => ({ id: `F${n}`, file: `r/${n}.ts`, severity: sev, claim: `claim ${n}` })
  const many = Array.from({ length: 12 }, (_, i) => f(i, 'nit'))
  const section = D.reviewNotesSection('r', many)
  assert.equal(section.split('\n').length, 12, 'heading + 10 findings + the “and 2 more” line')
  assert.match(section, /… and 2 more$/)
  assert.equal(D.reviewNotesSection('other', many), '')
  assert.deepEqual(D.prTexts('r', { commit: { subject: 'S', body: 'B' } }, []), { title: 'S', body: 'B' })
  assert.deepEqual(D.prTexts('r', { commit: { subject: 'S', body: 'B' }, pr: { title: 'T' } }, []), { title: 'T', body: '' })
})

// ====================================================== the github MCP tool ====
async function callTool(server, name, args) {
  const { port } = server.address()
  const res = await fetch(`http://127.0.0.1:${port}/mcp/tok`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  })
  return (await res.json()).result
}

test('the MCP tool create_pull_request: pushes HEAD, runs gh pr create (no --draft), and shares the loop’s function', async () => {
  const { task, clones, remotes } = fixture(['api'])
  write(clones.api, 'file.txt', 'api\n')
  git(clones.api, 'commit', '-q', '-am', 'mcp commit')
  const server = m.buildGithubHttpServer({ workspace: WS, task, env: 'e' }, 'api', clones.api, 'full', 'tok')
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    const before = ghCreates().length
    const ok = await callTool(server, 'create_pull_request', { title: 'From MCP', body: 'mcp body' })
    assert.ok(!ok.isError, JSON.stringify(ok))
    assert.match(ok.content[0].text, /^https:\/\/github\.com\/octo\/api\/pull\/\d+$/)
    assert.equal(git(remotes.api, 'rev-parse', task), headOf(clones.api), 'pushed first')
    const [c] = ghCreates().slice(before)
    assert.deepEqual(c.args, ['pr', 'create', '--title', 'From MCP', '--body', 'mcp body'])

    // A failing push is returned as the tool's error and no gh call follows.
    write(clones.api, 'file.txt', 'more\n')
    git(clones.api, 'commit', '-q', '-am', 'more')
    hook(clones.api, 'pre-push', 'echo "mcp push refused" >&2\nexit 1')
    const calls = ghCalls().length
    const bad = await callTool(server, 'create_pull_request', { title: 'x' })
    assert.equal(bad.isError, true)
    assert.match(bad.content[0].text, /mcp push refused/)
    assert.equal(ghCalls().length, calls)
    fs.rmSync(path.join(clones.api, '.git', 'hooks', 'pre-push'))

    // gh failing is an error result too.
    process.env.GH_SHIM_FAIL = '1'
    const rate = await callTool(server, 'create_pull_request', { title: 'y' })
    delete process.env.GH_SHIM_FAIL
    assert.equal(rate.isError, true)
    assert.match(rate.content[0].text, /rate limited/)
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test('the MCP tool still refuses a local repo before pushing anything', async () => {
  const { task, clones, remotes } = fixture(['lib'])
  write(clones.lib, 'file.txt', 'lib\n')
  git(clones.lib, 'commit', '-q', '-am', 'local commit')
  const server = m.buildGithubHttpServer({ workspace: WS, task, env: 'e' }, 'lib', clones.lib, 'full', 'tok')
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    const calls = ghCalls().length
    const r = await callTool(server, 'create_pull_request', { title: 'nope' })
    assert.equal(r.isError, true)
    assert.match(r.content[0].text, /repo "lib" is local to gurt and not published to a forge yet/)
    assert.match(r.content[0].text, /use git_push/)
    assert.equal(git(remotes.lib, 'branch', '--list', task), '', 'refused before the push')
    assert.equal(ghCalls().length, calls)
  } finally {
    await new Promise((r) => server.close(r))
  }
})

// ====================== the clone is the agent's: host git runs none of it ====
// §10 (as built, Fix 5). The agent writes `.git/config` and `.git/hooks`; the
// loop's host git must run nothing they name — no hook, `core.fsmonitor`,
// filter driver, external diff / textconv, ssh command, credential helper,
// `remote.<n>.uploadpack`, gpg program — and delivery must still succeed.
let evilSeq = 0
const scratchFor = () => fs.mkdtempSync(path.join(root, `evil${++evilSeq}-`))

test('positive control: the same clone DOES run its hooks, filters and fsmonitor under plain git', () => {
  const { clones } = fixture(['api'])
  const evil = makeEvil(clones.api, scratchFor())
  write(clones.api, 'file.txt', 'changed\n')
  // Each of these fails on purpose (the filter process exits 1, the gpg program too): what counts is what ran.
  for (const args of [['add', '-A'], ['-c', 'core.fsmonitor=false', '-c', 'filter.evil.required=false', '-c', 'filter.evil.process=', 'commit', '-q', '--allow-empty', '-m', 'x'], ['push', '-q', 'evilext', 'HEAD']])
    try { git(clones.api, ...args) } catch { /* expected */ }
  const hits = evil.hits()
  for (const h of ['filter-process', 'fsmonitor', 'hookspath-pre-commit', 'ext']) assert.ok(hits.includes(h), `${h} runs under plain git: ${hits}`)
})

for (const [rung, repo] of [['commit', 'api'], ['push', 'api'], ['pr', 'api'], ['merge', 'lib']]) {
  test(`hostile clone, rung ${rung}: the diff hash, the reviewer’s diff and status, and every step run nothing the clone names`, async () => {
    const { task, clones, remotes } = fixture([repo])
    const dir = clones[repo]
    write(dir, 'file.txt', `${repo} change\n`)
    write(dir, 'brand-new.txt', 'new\n')
    const evil = makeEvil(dir, scratchFor(), { remote: remotes[repo] })
    const base = headOf(dir)
    const reviewed = await hash(task, [repo])
    assert.deepEqual(evil.hits(), [], 'the diff hash')
    // What the reviewer's prompt gathers (reviewLoop.ts `reviewedRepo`), without the explicit flags: `changes.git` supplies them.
    const access = await unattendedGitAccessForRepo(WS, repo)
    const { tree } = await T.repoTree(WS, task, repo)
    const diff = await C.git(dir, access, ['-c', 'core.quotepath=false', 'diff', '--no-color', base, tree])
    assert.match(diff, new RegExp(`\\+${repo} change`))
    assert.match(diff, /brand-new\.txt/)
    await C.git(dir, access, ['status', '--porcelain', '-uall'])
    await C.git(dir, access, ['diff', 'HEAD', '--shortstat'])
    await C.git(dir, access, ['ls-files', '--others', '--exclude-standard'])
    assert.deepEqual(evil.hits(), [], 'the reviewer’s diff, status and file lists')
    const out = await D.deliverAll(ctxOf(task, reviewed), rung, [repo])
    assert.deepEqual(out.map((s) => s.step), { commit: ['commit'], push: ['commit', 'push'], pr: ['commit', 'push', 'pr'], merge: ['commit', 'merge'] }[rung])
    assert.deepEqual(evil.hits(), [], `the ${rung} rung`)
    // …and the delivery is the real one.
    assert.equal(git(dir, 'rev-parse', 'HEAD^{tree}'), T.parseDiffHash(reviewed)[repo].tree, 'exactly the reviewed tree')
    assert.equal(git(dir, 'show', 'HEAD:file.txt'), `${repo} change`, 'unfiltered content')
    if (rung === 'push' || rung === 'pr') assert.equal(git(remotes[repo], 'rev-parse', task), headOf(dir))
    if (rung === 'merge') assert.equal(git(remotes[repo], 'rev-parse', 'main'), headOf(dir))
    if (rung === 'pr') assert.equal(ghCreates().filter((c) => c.repo === repo).length >= 1, true)
  })
}

test('hostile clone: `core.worktree` cannot point the hash (or a commit) at other host files', async () => {
  const { task, clones } = fixture(['api'])
  write(clones.api, 'file.txt', 'api change\n')
  const before = await hash(task, ['api'])
  const outside = scratchFor()
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'host secret\n')
  git(clones.api, 'config', 'core.worktree', outside)
  assert.equal(await hash(task, ['api']), before, 'the tree is still the clone’s')
  const out = await D.deliverAll(ctxOf(task, before), 'commit', ['api'])
  assert.deepEqual(out.map((s) => s.step), ['commit'])
  assert.throws(() => git(clones.api, '--work-tree', clones.api, 'show', 'HEAD:secret.txt'), 'the host file was not committed')
})

test('hostile clone: the pinned settings — the clone’s program-running config is replaced, hooks are off', async () => {
  const { clones, remotes } = fixture(['api'])
  const evil = makeEvil(clones.api, scratchFor(), { remote: remotes.api })
  const access = await unattendedGitAccessForRepo(WS, 'api')
  const a = await hardenGit(clones.api, access)
  const cfg = (key) => C.git(clones.api, access, ['config', '--get', key]).then((v) => v.trim())
  assert.equal(await cfg('core.sshCommand'), 'ssh')
  assert.equal(await cfg('core.askPass'), '')
  assert.equal(await cfg('gpg.program'), 'gpg')
  assert.equal(await cfg('commit.gpgsign'), 'false')
  assert.equal(await cfg('core.fsmonitor'), 'false')
  assert.equal(await cfg('protocol.ext.allow'), 'never')
  assert.equal(await cfg('filter.evil.clean'), 'cat')
  assert.equal(await cfg('filter.evil.required'), 'false')
  assert.equal(await cfg('core.hooksPath'), path.join(process.env.GURT_ROOT, 'git-no-hooks'))
  assert.deepEqual(fs.readdirSync(await cfg('core.hooksPath')), [], 'the hooks directory is empty')
  const helpers = (await C.git(clones.api, access, ['config', '--get-all', 'credential.helper'])).split('\n').slice(0, -1)
  assert.deepEqual(helpers.slice(helpers.lastIndexOf('') + 1), [], 'the clone’s credential helper is not in effect')
  assert.equal(a.env.GIT_PROXY_COMMAND, '', 'core.gitProxy is first-wins: its environment variable outranks it')
  assert.equal(a.env.GIT_PAGER, 'cat')
  // ext:: as a remote URL, allowed by the clone: refused, nothing runs.
  await assert.rejects(C.git(clones.api, access, ['ls-remote', 'evilext']), /ext|not allowed/i)
  assert.deepEqual(evil.hits(), [])
})

test('the host’s own filter, ssh command and credential helper survive the pinning; the clone’s overrides of them do not', async () => {
  const { clones } = fixture(['api'])
  const globalCfg = path.join(root, 'host-gitconfig')
  fs.writeFileSync(globalCfg, '[filter "lfsish"]\n\tclean = host-clean\n\trequired = true\n[core]\n\tsshCommand = host-ssh\n[credential]\n\thelper = host-helper\n')
  const prev = process.env.GIT_CONFIG_GLOBAL
  process.env.GIT_CONFIG_GLOBAL = globalCfg
  try {
    git(clones.api, 'config', 'filter.lfsish.clean', 'evil-clean')
    git(clones.api, 'config', 'core.sshCommand', 'evil-ssh')
    git(clones.api, 'config', 'credential.helper', 'evil-helper')
    const access = await unattendedGitAccessForRepo(WS, 'api')
    const cfg = (...a) => C.git(clones.api, access, ['config', ...a]).then((v) => v.trim())
    assert.equal(await cfg('--get', 'filter.lfsish.clean'), 'host-clean')
    assert.equal(await cfg('--get', 'filter.lfsish.required'), 'true')
    assert.equal(await cfg('--get', 'core.sshCommand'), 'host-ssh')
    const helpers = (await cfg('--get-all', 'credential.helper')).split('\n')
    assert.deepEqual(helpers.slice(helpers.lastIndexOf('') + 1), ['host-helper'])
  } finally {
    if (prev === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = prev
  }
})

test('a filter or remote name with "=" cannot be pinned, so host git refuses instead of running unpinned', async () => {
  const { clones } = fixture(['api'])
  git(clones.api, 'config', 'filter.a=b.clean', 'touch /tmp/never')
  const access = await unattendedGitAccessForRepo(WS, 'api')
  await assert.rejects(C.git(clones.api, access, ['status']), /cannot be pinned/)
})

// ============================================ HEAD is the task branch (§6) ====
test('HEAD must be the task branch: another branch or a detached HEAD fails `wrong-branch` before anything is committed', async () => {
  const { task, clones, remotes } = fixture(['api', 'web'])
  write(clones.api, 'file.txt', 'api\n')
  write(clones.web, 'file.txt', 'web\n')
  const reviewed = await hash(task, ['api', 'web'])
  const heads = [headOf(clones.api), headOf(clones.web)]
  git(clones.web, 'switch', '-q', '-c', 'somewhere-else')
  // The second repo is off its branch: nothing of the FIRST is committed either.
  await assert.rejects(D.deliverAll(ctxOf(task, await hash(task, ['api', 'web'])), 'push', ['api', 'web']), (/** @type {any} */ e) => {
    assert.deepEqual([e.kind, e.repo], ['wrong-branch', 'web'])
    assert.deepEqual(e.delivered, [])
    assert.match(e.message, /on somewhere-else, not on the task branch/)
    return true
  })
  assert.deepEqual([headOf(clones.api), headOf(clones.web)], heads, 'nothing committed')
  git(clones.web, 'switch', '-q', '--detach')
  await assert.rejects(D.deliverStep(ctxOf(task, reviewed), { repo: 'web', step: 'commit', head: heads[1] }), (/** @type {any} */ e) => e.kind === 'wrong-branch' && /detached/.test(e.message))
  assert.equal(headOf(clones.web), heads[1])
  assert.equal(git(remotes.api, 'branch', '--list', task), '')
})

test('HEAD must be the task branch: a push, PR or merge step on another branch is refused, never pushed', async () => {
  for (const [step, repo] of [['push', 'api'], ['pr', 'api'], ['merge', 'lib']]) {
    const { task, clones, remotes, ctx, steps } = await committed([repo])
    git(clones[repo], 'switch', '-q', '-c', 'somewhere-else')
    await assert.rejects(D.deliverStep(ctx, { repo, step, head: steps[repo].ref }), (/** @type {any} */ e) => e.kind === 'wrong-branch' && e.step === step, step)
    assert.equal(git(remotes[repo], 'branch', '--list', task), '', `${step}: not pushed`)
    assert.equal(git(remotes[repo], 'rev-parse', 'main'), git(clones[repo], 'rev-parse', 'HEAD~1'), `${step}: main untouched`)
  }
})
