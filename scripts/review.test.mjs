// Manual review (docs/requirements-manual-review.md), without docker or an
// agent: what the review lock excludes, what it does not, how comments persist
// and get pruned, the before/after pairs the split view reads, and the fix
// session the comments seed.
//
// Container state is staged through `sessions.patchContainer` — the seam the
// container manager writes through — so a session can be made a holder of a
// clone with no daemon (same trick as session-repo-gate.test.mjs).
//
//   node scripts/review.test.mjs
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// GURT_ROOT must be set before the store module loads (read at import time).
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-review-'))
process.env.GURT_ROOT = GURT_ROOT

const outfile = path.join(os.tmpdir(), `gurt-review-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await build({
  stdin: {
    contents:
      `export { createKernel } from ${S('src/main/kernel.ts')}\n` +
      `export { fixPrompt } from ${S('src/main/review.ts')}\n` +
      `export { getDiffFiles, getDiffPair } from ${S('src/main/changes.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  mainFields: ['module', 'main'],
  outfile,
  logLevel: 'silent'
})

const { createKernel, fixPrompt, getDiffFiles, getDiffPair } = await import(
  pathToFileURL(outfile).href
)

const ws = 'w'
const task = 't'
const repo = 'alpha'
const clone = path.join(GURT_ROOT, ws, task, repo)
const reviewJson = () => JSON.parse(fs.readFileSync(path.join(GURT_ROOT, ws, task, 'review.json'), 'utf8'))

const git = (...args) =>
  execFileSync('git', ['-C', clone, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** Wait until the session leaves `starting` and report how it settled. */
async function settle(kernel, id) {
  for (let i = 0; i < 200; i++) {
    const snap = kernel.sessions.snapshot(id)
    if (snap && snap.info.state !== 'starting') return snap
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`session ${id} never left "starting"`)
}

try {
  // --- a real clone, so the diff calls have something to read ---------------
  fs.mkdirSync(clone, { recursive: true })
  fs.writeFileSync(
    path.join(GURT_ROOT, ws, 'workspace.json'),
    JSON.stringify({
      repos: [{ name: repo, url: 'https://github.com/o/alpha.git' }],
      envs: [{ name: 'dev', devcontainer: '{"image":"x"}', repo }]
    })
  )
  fs.writeFileSync(path.join(GURT_ROOT, ws, task, 'task.json'), JSON.stringify({}))
  fs.writeFileSync(path.join(GURT_ROOT, ws, 'agents.json'), JSON.stringify({ a1: { kind: 'claude-code', label: 'c' } }))

  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 'T')
  // Long enough that its untouched middle folds in the split view.
  const base = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n'
  fs.writeFileSync(path.join(clone, 'a.txt'), base)
  fs.writeFileSync(path.join(clone, 'keep.txt'), 'kept\n')
  git('add', '-A')
  git('commit', '-qm', 'base')
  const head = git('rev-parse', 'HEAD').trim()
  // One edited line, one new file — the two shapes the panel shows.
  fs.writeFileSync(path.join(clone, 'a.txt'), base.replace('line 15', 'line FIFTEEN'))
  fs.writeFileSync(path.join(clone, 'new.txt'), 'fresh\n')

  const kernel = createKernel()
  // The boot reconcile drops container records Docker does not confirm; staging
  // one before it lands would be undone mid-test.
  await kernel.ready

  // --- diff targets --------------------------------------------------------
  const un = { kind: 'uncommitted' }
  const diffFiles = await getDiffFiles(ws, task, repo, un)
  assert.deepEqual(
    diffFiles.map((f) => f.path).sort(),
    ['a.txt', 'new.txt'],
    'the uncommitted target lists the edited and the untracked file'
  )

  let pair = await getDiffPair(ws, task, repo, un, 'a.txt')
  assert.equal(pair.binary, false)
  assert.ok(pair.before.includes('line 15'), 'before is HEAD content')
  assert.ok(pair.after.includes('line FIFTEEN'), 'after is the working tree')
  assert.ok(!pair.after.includes('line 15\n'), 'the edited line is gone from after')

  pair = await getDiffPair(ws, task, repo, un, 'new.txt')
  assert.equal(pair.before, '', 'an untracked file has no before-side')
  assert.equal(pair.after, 'fresh\n')

  // A commit target reads against its parent — and the root commit has none,
  // so every file of it reads as added.
  const commitFiles = await getDiffFiles(ws, task, repo, { kind: 'commit', sha: head })
  assert.deepEqual(commitFiles.map((f) => f.path).sort(), ['a.txt', 'keep.txt'])
  pair = await getDiffPair(ws, task, repo, { kind: 'commit', sha: head }, 'keep.txt')
  assert.equal(pair.before, '', 'the root commit adds every file it has')
  assert.equal(pair.after, 'kept\n')

  // A path is not a free-form argv slot.
  await assert.rejects(
    () => getDiffPair(ws, task, repo, un, '../../../etc/passwd'),
    /escapes the repository/,
    'a traversing path is refused'
  )
  await assert.rejects(
    () => getDiffFiles(ws, task, repo, { kind: 'commit', sha: '--output=/tmp/x' }),
    /not a commit sha/,
    'a sha that is really an option is refused'
  )
  console.log('diff targets OK')

  // --- comments ------------------------------------------------------------
  const add = (target, path, line, text) =>
    kernel.review.addComment(ws, task, repo, target, { path, side: 'after', line, text })

  const c1 = await add('uncommitted', 'a.txt', 16, 'why shout?')
  await add('uncommitted', 'new.txt', 1, 'needs a test')
  assert.equal(reviewJson().comments.length, 2, 'comments land in review.json')

  let state = await kernel.reviewState(ws, task, repo, un)
  assert.equal(state.comments.length, 2)
  assert.equal(state.locked, false, 'a fresh repo is not locked')

  await kernel.review.resolveComment(ws, task, c1.id, true)
  state = await kernel.reviewState(ws, task, repo, un)
  assert.equal(state.comments.find((c) => c.id === c1.id).resolved, true, 'resolve persists')

  // A note on a commit is scoped to that commit: reading the working tree must
  // not see it, and — since the file is clean there — must not prune it either.
  const onCommit = await add(`commit:${head}`, 'keep.txt', 1, 'why keep this?')
  state = await kernel.reviewState(ws, task, repo, un)
  assert.ok(
    !state.comments.some((c) => c.id === onCommit.id),
    "the working tree does not show a commit's comments"
  )
  assert.equal(reviewJson().comments.length, 3, 'and does not prune them either')
  state = await kernel.reviewState(ws, task, repo, { kind: 'commit', sha: head })
  assert.deepEqual(state.comments.map((c) => c.id), [onCommit.id], 'the commit sees its own')
  await kernel.review.deleteComment(ws, task, onCommit.id)

  // A comment whose file leaves its own diff is pruned on the next read — not
  // archived, not left dangling.
  fs.rmSync(path.join(clone, 'new.txt'))
  state = await kernel.reviewState(ws, task, repo, un)
  assert.deepEqual(state.comments.map((c) => c.path), ['a.txt'], 'the orphaned comment is gone')
  assert.equal(reviewJson().comments.length, 1, 'the prune reached disk')

  await kernel.review.deleteComment(ws, task, c1.id)
  assert.equal(reviewJson().comments.length, 0, 'delete removes it')
  console.log('comments OK')

  // --- the lock ------------------------------------------------------------
  const ref = { workspace: ws, task, env: 'dev' }
  const mk = (role, title) => {
    const info = kernel.sessions.createSession(ref, [repo], 'a1', 'hi', 'draft', [], true, false, {}, role)
    kernel.sessions.renameSession(info.id, title)
    return info.id
  }

  await kernel.setReviewLock(ws, task, repo, true)
  assert.ok(reviewJson().locked[repo], 'the lock is on disk, with its timestamp')

  // "Run now" is refused outright — it cannot confirm its way past a review.
  const exec = mk('executor', 'E')
  kernel.sessions.run(exec)
  let snap = await settle(kernel, exec)
  assert.equal(snap.info.state, 'draft', 'a blocked start falls back to draft')
  assert.match(snap.startError ?? '', /locked for review/, 'and says why')

  // A queued one waits rather than failing.
  const queued = mk('executor', 'Q')
  kernel.sessions.enqueue(queued)
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(kernel.sessions.snapshot(queued).info.state, 'queued', 'the queue waits out a lock')

  // A researcher is read-only and claims no clone — a review is not about it.
  const res = mk('researcher', 'R')
  kernel.sessions.run(res)
  snap = await settle(kernel, res)
  assert.doesNotMatch(
    snap.startError ?? '',
    /locked for review/,
    'a read-only researcher is not gated by the review lock'
  )

  // A reviewer agent holds the same clone exclusively, so it *is* gated.
  const rev = mk('reviewer', 'V')
  kernel.sessions.run(rev)
  snap = await settle(kernel, rev)
  assert.match(snap.startError ?? '', /locked for review/, 'an agent reviewer is gated too')

  // Unlocking releases what was waiting on it.
  await kernel.setReviewLock(ws, task, repo, false)
  snap = await settle(kernel, queued)
  assert.doesNotMatch(snap.startError ?? '', /locked for review/, 'unlocking lets the queue through')
  console.log('lock gates starts OK')

  // --- the lock and a live session are the same exclusion ------------------
  const holder = mk('executor', 'H')
  kernel.sessions.patchContainer(holder, {
    status: 'running',
    id: 'c-h',
    remoteWorkspaceFolder: '/app',
    repos: [repo]
  })
  await assert.rejects(
    () => kernel.setReviewLock(ws, task, repo, true),
    /session "H" is running against "alpha"/,
    'the lock cannot be taken from under a live session'
  )
  kernel.sessions.patchContainer(holder, undefined)
  await kernel.setReviewLock(ws, task, repo, true)
  console.log('lock vs. live session OK')

  // --- launch fix ----------------------------------------------------------
  await add('uncommitted', 'a.txt', 16, 'why shout?')
  const done = await add('uncommitted', 'a.txt', 3, 'already handled')
  await kernel.review.resolveComment(ws, task, done.id, true)
  // Scoped to the target being reviewed: a note on a commit is a different
  // conversation and must not ride along.
  await add(`commit:${head}`, 'keep.txt', 1, 'unrelated commit note')

  const { sessionId } = await kernel.launchReviewFix(ws, task, repo, un, 'keep it small')
  const fix = kernel.sessions.snapshot(sessionId).info
  assert.equal(fix.state, 'draft', 'the fix session is a draft — the user approves it')
  assert.equal(fix.role, 'executor')
  assert.deepEqual(fix.repos, [repo])
  assert.match(fix.startPrompt, /^Review comments on alpha:/, 'the prompt leads with the comments')
  assert.match(fix.startPrompt, /a\.txt:16\n {2}why shout\?/, 'each comment is anchored at file:line')
  assert.doesNotMatch(fix.startPrompt, /already handled/, 'a resolved comment is not sent')
  assert.doesNotMatch(fix.startPrompt, /unrelated commit note/, "another target's note is not sent")
  assert.match(fix.startPrompt, /keep it small$/, 'the free-text prompt comes last')

  // Neither the lock nor the comments move when a fix is launched.
  const after = await kernel.reviewState(ws, task, repo, un)
  assert.equal(after.locked, true, 'launching does not unlock')
  assert.equal(after.comments.length, 2, 'launching does not resolve anything')

  await assert.rejects(
    () => kernel.launchReviewFix(ws, task, 'nope', un, ''),
    /nothing to send/,
    'a fix with neither comments nor a prompt is refused'
  )
  console.log('launch fix OK')

  // --- fixPrompt shape (grouping and ordering) -----------------------------
  const at = '2026-01-01T00:00:00.000Z'
  const c = (p, line, text) => ({
    id: p + line,
    repo,
    target: 'uncommitted',
    path: p,
    side: 'after',
    line,
    text,
    createdAt: at
  })
  assert.equal(
    fixPrompt('r', [c('b.ts', 2, 'two'), c('a.ts', 9, 'nine'), c('a.ts', 1, 'one')], 'go'),
    'Review comments on r:\n\na.ts:1\n  one\n\na.ts:9\n  nine\n\nb.ts:2\n  two\n\ngo',
    'grouped by file in path order, by line within a file, prompt last'
  )
  assert.equal(fixPrompt('r', [], 'just this'), 'just this', 'no comments — the prompt stands alone')
  assert.equal(fixPrompt('r', [], '   '), '', 'nothing to send reads as empty')
  console.log('fixPrompt OK')

  // --- the lock survives a restart -----------------------------------------
  const kernel2 = createKernel()
  await kernel2.ready
  const restored = await kernel2.reviewState(ws, task, repo, un)
  assert.equal(restored.locked, true, 'a lock taken in a previous run still holds')
  const late = kernel2.sessions.createSession(ref, [repo], 'a1', 'hi', 'draft').id
  kernel2.sessions.run(late)
  snap = await settle(kernel2, late)
  assert.match(snap.startError ?? '', /locked for review/, 'and still gates starts after boot')
  console.log('lock survives restart OK')

  console.log('review.test: PASS')
} catch (e) {
  console.error('review.test: FAIL')
  console.error(e)
  process.exitCode = 1
} finally {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
}
