// Host-git delivery-thread logic (docs/requirements-changes-thread.md), tested
// offline against the exported surface of src/main/changes.ts: local bare repos
// as origins, clones created directly in GURT_ROOT/<ws>/<task>/<repo>/ — no
// docker, no agent, host git only (the panel must work with containers
// stopped). Mirrors the acceptance flows of archive/smokes/smoke7.mjs.
// With no registered repos/credentials the host git access resolves to
// `blocked`, under which local git and file-path remotes still work — the
// containers-stopped contract by construction.
import { afterAll, it } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

// GURT_ROOT must be set before the store module loads (read at import time).
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-changes-'))
process.env.GURT_ROOT = GURT_ROOT
const { getTaskChanges, getFileDiff, getCommitDiff, commit, push, prUrl } = await import(
  '../src/main/changes'
)

// Origins live outside GURT_ROOT so getTaskChanges never sees them as clones.
const REPO_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-changes-origins-'))

const ws = 'w'

afterAll(() => {
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
  fs.rmSync(REPO_ROOT, { recursive: true, force: true })
})

/** Fixture git: identity via -c — CI has no global git identity. */
const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    encoding: 'utf8'
  })

/** Bare origin seeded with one commit on main. */
function makeBare(
  name: string,
  files: Record<string, string> = { 'README.md': `# ${name}\n` }
): string {
  const seed = path.join(REPO_ROOT, `${name}-seed`)
  const bare = path.join(REPO_ROOT, `${name}.git`)
  fs.mkdirSync(seed, { recursive: true })
  git(seed, 'init', '-q')
  git(seed, 'checkout', '-q', '-b', 'main')
  for (const [p, content] of Object.entries(files)) fs.writeFileSync(path.join(seed, p), content)
  git(seed, 'add', '-A')
  git(seed, 'commit', '-q', '-m', 'initial')
  git(REPO_ROOT, 'clone', '-q', '--bare', seed, bare)
  return bare
}

function mkTask(task: string): void {
  fs.mkdirSync(path.join(GURT_ROOT, ws, task), { recursive: true })
  fs.writeFileSync(path.join(GURT_ROOT, ws, task, 'task.json'), JSON.stringify({ envs: [] }))
}

/** Clone an origin into the task dir on branch gurt/<task> — what provisioning does. */
function makeClone(bare: string, task: string, repo: string): string {
  const dir = path.join(GURT_ROOT, ws, task, repo)
  git(REPO_ROOT, 'clone', '-q', bare, dir)
  // changes.commit() runs plain `git commit`; a local identity keeps it working
  // on hosts (CI) with no global git config.
  git(dir, 'config', 'user.email', 't@t')
  git(dir, 'config', 'user.name', 't')
  git(dir, 'checkout', '-q', '-b', `gurt/${task}`)
  return dir
}

/** The one RepoChanges of a single-clone task. */
async function one(task: string, fetch = false) {
  const out = await getTaskChanges(ws, task, { fetch })
  assert.equal(out.length, 1, `${task}: expected exactly one clone`)
  return out[0]
}

fs.mkdirSync(path.join(GURT_ROOT, ws), { recursive: true })
fs.writeFileSync(path.join(GURT_ROOT, ws, 'workspace.json'), JSON.stringify({ repos: [] }))

// t1: the main thread lifecycle — uncommitted → local → pushed.
mkTask('t1')
const bareAlpha = makeBare('alpha')
const alphaDir = makeClone(bareAlpha, 't1', 'alpha')
fs.appendFileSync(path.join(alphaDir, 'README.md'), 'changed by agent\n')
fs.writeFileSync(path.join(alphaDir, 'hello.txt'), 'hello\nworld\n')
fs.mkdirSync(path.join(alphaDir, 'newdir'))
fs.writeFileSync(path.join(alphaDir, 'newdir', 'inner.txt'), 'inner\n')

// t2: forge matching for prUrl.
mkTask('t2')
const bareGh = makeBare('gh')
const ghDir = makeClone(bareGh, 't2', 'gh')

// t3: ancestry merge on the remote. t4: squash + branch deletion. t5: offline.
mkTask('t3')
const bareM = makeBare('m')
const mDir = makeClone(bareM, 't3', 'm')
mkTask('t4')
const bareS = makeBare('s')
const sDir = makeClone(bareS, 't4', 's')
mkTask('t5')
const bareO = makeBare('o')
const oDir = makeClone(bareO, 't5', 'o')

// t6: clone discovery + status-letter parsing.
mkTask('t6')
const bareAA = makeBare('aa', { 'README.md': '# aa\n', 'second.txt': 'gone\n' })
const bareBB = makeBare('bb')
const aaDir = makeClone(bareAA, 't6', 'aa')
const bbDir = makeClone(bareBB, 't6', 'bb')
git(aaDir, 'mv', 'README.md', 'docs.md') // staged rename → R, panel shows the new path
fs.rmSync(path.join(aaDir, 'second.txt')) // unstaged delete → D
fs.writeFileSync(path.join(aaDir, 'a b.txt'), 'x\n') // untracked, space in the path → A
git(bbDir, 'remote', 'set-head', 'origin', '-d') // no origin/HEAD → defaultBranch falls back
fs.mkdirSync(path.join(GURT_ROOT, ws, 't6', 'notes')) // no .git → not a clone
fs.mkdirSync(path.join(GURT_ROOT, ws, 't6', 'broken'))
fs.writeFileSync(path.join(GURT_ROOT, ws, 't6', 'broken', '.git'), 'not a gitfile\n') // git fails → skipped

it('uncommitted work lands in the Uncommitted block', { timeout: 60_000 }, async () => {
  const rc = await one('t1')
  assert.equal(rc.repo, 'alpha')
  assert.equal(rc.dirty, true)
  const by = Object.fromEntries(rc.files.map((f) => [f.path, f.status]))
  assert.equal(by['README.md'], 'M', 'tracked edit listed as M')
  assert.equal(by['hello.txt'], 'A', 'untracked file listed as A')
  assert.equal(by['newdir/inner.txt'], 'A', '-uall lists untracked dir contents individually')
  assert.equal(rc.files.length, 3)
  // Untracked files count toward the file count only, not the shortstat.
  assert.equal(rc.insertions, 1)
  assert.equal(rc.deletions, 0)
  assert.equal(rc.defaultBranch, 'main')
  assert.deepEqual(rc.commits, [], 'no thread commits yet')
  assert.equal(rc.integrated, true, 'an empty thread reads integrated')
  assert.ok(!('prUrl' in rc), 'no prUrl without a pushed commit')
})

it('getFileDiff: tracked diff vs whole-file-added untracked', { timeout: 60_000 }, async () => {
  const tracked = await getFileDiff(ws, 't1', 'alpha', 'README.md')
  assert.ok(tracked.includes('+changed by agent'), `tracked diff has the added line: ${tracked}`)
  assert.ok(!tracked.includes('+hello'), 'tracked diff is scoped to the one file')
  const untracked = await getFileDiff(ws, 't1', 'alpha', 'hello.txt')
  assert.ok(
    untracked.includes('+hello') && untracked.includes('+world'),
    `untracked file diffs as whole-file-added: ${untracked}`
  )
})

it('commit() moves the change into the thread as local — nothing vanishes', { timeout: 60_000 }, async () => {
  await commit(ws, 't1', 'alpha', 'gurt: t1')
  const rc = await one('t1')
  assert.equal(rc.dirty, false)
  assert.deepEqual(rc.files, [], 'Uncommitted block empties')
  assert.equal(rc.commits.length, 1, 'the change re-appears as a thread commit')
  assert.equal(rc.commits[0].subject, 'gurt: t1')
  assert.equal(rc.commits[0].pushed, false, 'commit starts local')
  assert.match(rc.commits[0].sha, /^[0-9a-f]{40}$/, 'full SHA in the payload')
  assert.equal(rc.integrated, false, 'a local commit keeps the thread open')
})

it('getCommitDiff shows the committed change', { timeout: 60_000 }, async () => {
  const rc = await one('t1')
  const show = await getCommitDiff(ws, 't1', 'alpha', rc.commits[0].sha)
  assert.ok(show.includes('gurt: t1'), 'subject in the show output')
  assert.ok(show.includes('+changed by agent') && show.includes('+hello'), 'diff in the show output')
})

it('push() flips the commit to pushed; a local-path origin gets no prUrl', { timeout: 60_000 }, async () => {
  await push(ws, 't1', 'alpha')
  const rc = await one('t1', true)
  assert.deepEqual(
    rc.commits.map((c) => [c.subject, c.pushed]),
    [['gurt: t1', true]]
  )
  assert.equal(rc.integrated, false, 'pushed but unmerged — the thread stays open')
  assert.ok(git(bareAlpha, 'log', '--format=%s', 'gurt/t1').includes('gurt: t1'), 'bare got the branch')
  assert.ok(!('prUrl' in rc), 'non-forge (file-path) origin yields no prUrl')
})

it('prUrl: only a github-style origin maps to a compare URL', { timeout: 60_000 }, async () => {
  // Local-path origin: not parseable as a forge remote.
  await assert.rejects(() => prUrl(ws, 't2', 'gh'), /not a known forge/)
  // Parseable host, but no forge entry for it.
  git(ghDir, 'remote', 'set-url', 'origin', 'git@gitlab.com:me/gh.git')
  await assert.rejects(() => prUrl(ws, 't2', 'gh'), /not a known forge/)
  // SSH host aliases count as github; owner/repo land on the canonical host.
  git(ghDir, 'remote', 'set-url', 'origin', 'git@github.com-personal:me/gh.git')
  assert.equal(await prUrl(ws, 't2', 'gh'), 'https://github.com/me/gh/compare/main...gurt/t2?expand=1')
})

it('getTaskChanges gates prUrl on a pushed commit', { timeout: 60_000 }, async () => {
  // A local-only commit on a github origin: the standalone prUrl() works
  // (previous test), but the panel payload must not carry the URL yet.
  git(ghDir, 'remote', 'set-url', 'origin', bareGh)
  fs.appendFileSync(path.join(ghDir, 'README.md'), 'gh change\n')
  await commit(ws, 't2', 'gh', 'gurt: t2')
  git(ghDir, 'remote', 'set-url', 'origin', 'https://github.com/me/gh.git')
  const local = await one('t2') // no fetch — the github URL is never contacted
  assert.equal(local.commits[0].pushed, false)
  assert.ok(!('prUrl' in local), 'no prUrl while every commit is local')
  // Push through the real (file-path) origin, then read with the github URL:
  // pushed state lives in refs/remotes/origin/gurt/t2, so no network is needed.
  git(ghDir, 'remote', 'set-url', 'origin', bareGh)
  await push(ws, 't2', 'gh')
  git(ghDir, 'remote', 'set-url', 'origin', 'https://github.com/me/gh.git')
  const pushed = await one('t2')
  assert.equal(pushed.commits[0].pushed, true)
  assert.equal(pushed.prUrl, 'https://github.com/me/gh/compare/main...gurt/t2?expand=1')
})

it('merge on the remote empties the thread by ancestry', { timeout: 60_000 }, async () => {
  fs.appendFileSync(path.join(mDir, 'README.md'), 'm change\n')
  await commit(ws, 't3', 'm', 'gurt: t3')
  await push(ws, 't3', 'm')
  // Fast-forward the remote default onto the pushed branch — a real merge.
  git(bareM, 'update-ref', 'refs/heads/main', git(bareM, 'rev-parse', 'refs/heads/gurt/t3').trim())
  const rc = await one('t3', true)
  assert.deepEqual(rc.commits, [], 'origin/main..HEAD emptied')
  assert.equal(rc.integrated, true)
  assert.equal(rc.dirty, false)
  // Ancestry integration needs no marker — the branch was not pruned.
  assert.throws(() => git(mDir, 'rev-parse', '--verify', '--quiet', 'refs/gurt/integrated'))
})

it('squash + remote branch deletion → integrated marker; a new commit reopens', { timeout: 60_000 }, async () => {
  fs.appendFileSync(path.join(sDir, 'README.md'), 's change\n')
  await commit(ws, 't4', 's', 'gurt: t4')
  await push(ws, 't4', 's')
  // A squash merge: the change lands on the remote default with a fresh SHA…
  const land = path.join(REPO_ROOT, 's-land')
  git(REPO_ROOT, 'clone', '-q', bareS, land)
  fs.writeFileSync(path.join(land, 'squashed.txt'), 'squashed\n')
  git(land, 'add', '-A')
  git(land, 'commit', '-q', '-m', 'squashed: gurt/t4')
  git(land, 'push', '-q', 'origin', 'main')
  // …and the remote branch is deleted.
  git(bareS, 'update-ref', '-d', 'refs/heads/gurt/t4')
  const rc = await one('t4', true)
  assert.equal(rc.commits.length, 1, 'SHA-rewritten: the range never empties by ancestry')
  assert.equal(rc.commits[0].pushed, false, 'pruned remote branch — nothing reads pushed')
  assert.equal(rc.integrated, true, 'pruned-at-HEAD marks the thread integrated')
  assert.equal(
    git(sDir, 'rev-parse', 'refs/gurt/integrated').trim(),
    git(sDir, 'rev-parse', 'HEAD').trim(),
    'refs/gurt/integrated recorded at HEAD in the clone'
  )
  assert.ok(!('prUrl' in rc), 'integrated thread carries no prUrl')
  // A new commit reopens the thread.
  fs.appendFileSync(path.join(sDir, 'README.md'), 'after the merge\n')
  await commit(ws, 't4', 's', 'gurt: reopen')
  const reopened = await one('t4')
  assert.equal(reopened.integrated, false, 'HEAD moved off the marker')
  assert.deepEqual(
    reopened.commits.map((c) => c.subject),
    ['gurt: reopen', 'gurt: t4'],
    'newest first, old commit still in the range'
  )
})

it('unreachable origin: silent fetch failure, last-known refs, commit still works', { timeout: 60_000 }, async () => {
  fs.appendFileSync(path.join(oDir, 'README.md'), 'o change\n')
  await commit(ws, 't5', 'o', 'gurt: t5')
  await push(ws, 't5', 'o')
  fs.renameSync(bareO, `${bareO}-moved`) // the origin goes away
  fs.appendFileSync(path.join(oDir, 'README.md'), 'offline edit\n')
  const rc = await one('t5', true) // fetch fails — must not throw
  assert.equal(rc.dirty, true)
  assert.deepEqual(
    rc.commits.map((c) => [c.subject, c.pushed]),
    [['gurt: t5', true]],
    'last-known refs still render'
  )
  await commit(ws, 't5', 'o', 'gurt: offline')
  const rc2 = await one('t5', true)
  assert.equal(rc2.dirty, false)
  assert.deepEqual(
    rc2.commits.map((c) => [c.subject, c.pushed]),
    [
      ['gurt: offline', false],
      ['gurt: t5', true]
    ],
    'offline commit lands in the thread'
  )
  assert.equal(rc2.integrated, false)
  await assert.rejects(() => push(ws, 't5', 'o'), /failed/, 'push to a gone origin rejects')
})

it('discovery: sorted clones, non-clones ignored, a broken repo skipped', { timeout: 60_000 }, async () => {
  const out = await getTaskChanges(ws, 't6')
  // `notes` (no .git) and `broken` (git fails) never make it into the payload.
  assert.deepEqual(out.map((r) => r.repo), ['aa', 'bb'], 'sorted by repo name')

  const aa = out[0]
  const by = Object.fromEntries(aa.files.map((f) => [f.path, f.status]))
  assert.equal(by['docs.md'], 'R', 'staged rename shows the new path as R')
  assert.equal(by['second.txt'], 'D', 'deleted file shows as D')
  assert.equal(by['a b.txt'], 'A', 'path with a space survives parsing')
  assert.equal(aa.files.length, 3)
  assert.equal(aa.insertions, 0, 'pure rename adds nothing')
  assert.equal(aa.deletions, 1, 'the deleted file counts')

  const bb = out[1]
  assert.equal(bb.dirty, false)
  assert.deepEqual(bb.commits, [])
  assert.equal(bb.integrated, true)
  assert.equal(bb.defaultBranch, 'main', 'no origin/HEAD → fallback to main')

  assert.deepEqual(await getTaskChanges(ws, 'missing-task'), [], 'missing task dir → empty list')
})
