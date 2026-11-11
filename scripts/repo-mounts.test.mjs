// Per-repo mount modes (docs/requirements-repo-mounts.md), without docker or an
// agent: the clone claims each mode takes (§2.1 — shared readers, exclusive
// writers, all-or-nothing starts, FIFO by clone, the queue handoff), how modes
// are normalized and edited (§2, §5), and the per-repo `complete` (§3). Plus
// the review loop's reviewer (docs/requirements-review-loop.md §4): `read`
// whatever its record says, and its `submit_review` / the executor's
// `replies` as the session manager records and refuses them (§4.1–4.2).
//
// Holders are staged through `sessions.patchContainer`, the seam the container
// manager writes through (session-repo-gate.test.mjs's trick). Every real start
// dies fast on "unknown agent" (agents.json is empty), past every repo gate.
//
//   node scripts/repo-mounts.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// GURT_ROOT must be set before the store module loads (read at import time).
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-repo-mounts-'))
process.env.GURT_ROOT = GURT_ROOT

const outfile = path.join(os.tmpdir(), `gurt-repo-mounts-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await bundle({
  stdin: {
    contents:
      `export { createKernel } from ${S('src/main/kernel.ts')}\n` +
      `export { assertProposalFits, proposalForRepo, assertRepliesAnswer, assertVerdictFits } from ${S('src/main/sessions.ts')}\n` +
      `export { anchorRepo, normalizeRepoModes, repoMode, writeRepos, findingRef } from ${S('src/shared/types.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})

const m = await import(pathToFileURL(outfile).href)

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms))

/** Wait until the session leaves `starting` and report how it settled. */
async function settle(kernel, id) {
  for (let i = 0; i < 200; i++) {
    const snap = kernel.sessions.snapshot(id)
    if (snap && snap.info.state !== 'starting' && snap.info.state !== 'queued') return snap
    await tick(25)
  }
  throw new Error(`session ${id} never settled`)
}

after(() => {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

const ws = 'w'
const task = 't'
fs.mkdirSync(path.join(GURT_ROOT, ws, task), { recursive: true })
fs.writeFileSync(
  path.join(GURT_ROOT, ws, 'workspace.json'),
  JSON.stringify({
    repos: [
      { name: 'alpha', url: 'https://github.com/o/alpha.git' },
      { name: 'beta', url: 'https://github.com/o/beta.git' }
    ],
    envs: [
      { name: 'dev', image: 'x', repo: 'alpha' },
      { name: 'bdev', image: 'x', repo: 'beta' }
    ]
  })
)
fs.writeFileSync(path.join(GURT_ROOT, ws, task, 'task.json'), JSON.stringify({}))
fs.writeFileSync(path.join(GURT_ROOT, ws, 'agents.json'), JSON.stringify({}))

const kernel = m.createKernel()
await kernel.ready
// The queue handoff would stop idle holders through docker; record instead, and
// leave the staged container up so each test decides when a holder lets go.
const stops = []
kernel.containers.stop = async (id, reason) => {
  stops.push({ id, reason })
}
const ref = { workspace: ws, task, env: 'dev' }

let n = 0
const mk = (modes, role = 'executor') => {
  const repos = Object.keys(modes)
  const info = kernel.sessions.createSession(ref, repos, 'a1', 'hi', 'none', [], true, {}, role, undefined, undefined, modes)
  kernel.sessions.renameSession(info.id, `S${++n}`)
  return kernel.sessions.snapshot(info.id).info
}
const hold = (s) =>
  kernel.sessions.patchContainer(s.id, {
    status: 'running',
    id: `container-${s.id}`,
    remoteWorkspaceFolder: '/app',
    repos: s.repos
  })
const release = (s) => kernel.sessions.patchContainer(s.id, undefined)
const state = (s) => kernel.sessions.snapshot(s.id).info.state
const inUse = /is in use by session/

// --- modes: defaults, normalization, the anchor --------------------------------

test('a picked repo defaults to read-locked; modes are normalized to the repo list', () => {
  const s = kernel.sessions.createSession(ref, ['alpha', 'beta'], 'a1', 'hi', 'none', [], true, {}, 'executor')
  assert.deepEqual(s.repoModes, { alpha: 'read-locked', beta: 'read-locked' }, 'the role sets no default')
  assert.deepEqual(
    m.normalizeRepoModes(['alpha'], { alpha: 'write', gone: 'write', beta: 'bogus' }),
    { alpha: 'write' },
    'exactly the repos, a stale key dropped'
  )
  assert.deepEqual(m.normalizeRepoModes(['beta'], { beta: 'bogus' }), { beta: 'read-locked' }, 'an invalid mode takes the default')
  // The anchor builds the image: the first write repo, else the first repo.
  assert.equal(m.anchorRepo({ role: 'executor', repos: ['alpha', 'beta'], repoModes: { alpha: 'read', beta: 'write' } }), 'beta')
  assert.equal(m.anchorRepo({ role: 'researcher', repos: ['alpha', 'beta'], repoModes: { alpha: 'read', beta: 'read' } }), 'alpha')
  assert.equal(m.anchorRepo({ role: 'operator', repos: [], repoModes: {} }), undefined)
  // A record with no map at all predates modes: the role's old mounts.
  assert.equal(m.repoMode({ role: 'executor', repos: ['alpha'] }, 'alpha'), 'write')
  assert.equal(m.repoMode({ role: 'researcher', repos: ['alpha'] }, 'alpha'), 'read')
  kernel.sessions.deleteSession(s.id)
})

test('draft edits: a kept repo keeps its mode, a new one takes the default, a mode edit lands', async () => {
  const d = mk({ alpha: 'write' })
  await kernel.editDraft(d.id, { repos: ['alpha', 'beta'] })
  assert.deepEqual(kernel.sessions.snapshot(d.id).info.repoModes, { alpha: 'write', beta: 'read-locked' })
  await kernel.editDraft(d.id, { repoModes: { beta: 'read' } })
  assert.deepEqual(kernel.sessions.snapshot(d.id).info.repoModes, { alpha: 'write', beta: 'read' })
  await kernel.editDraft(d.id, { repos: ['beta'] })
  assert.deepEqual(kernel.sessions.snapshot(d.id).info.repoModes, { beta: 'read' }, 'a removed repo takes its mode along')
  await assert.rejects(
    kernel.editDraft(d.id, { repoModes: { beta: 'rw' } }),
    /unknown mode "rw"/,
    'an unknown mode is refused at the boundary, not defaulted'
  )
  kernel.sessions.deleteSession(d.id)
})

// --- the reviewer: `read`, whatever the record says ------------------------------

test('a reviewer mounts every repo read and claims no clone', async () => {
  const rec = { role: 'reviewer', repos: ['alpha', 'beta'], repoModes: { alpha: 'write', beta: 'read-locked' } }
  assert.equal(m.repoMode(rec, 'alpha'), 'read', 'a write pick reads as read')
  assert.equal(m.repoMode(rec, 'beta'), 'read', 'and so does read-locked — never a shared claim (§4: a deadlock)')
  assert.deepEqual(m.writeRepos(rec), [], 'it writes nothing')
  assert.equal(m.repoMode({ role: 'reviewer', repos: ['alpha'] }, 'alpha'), 'read', 'a record without modes too')

  // A running reviewer whose record says `write` blocks no writer.
  const rv = mk({ alpha: 'write' }, 'reviewer')
  hold(rv)
  assert.equal(kernel.sessions.repoHolderFor(ws, task, 'alpha'), undefined, 'it holds nothing')
  const w = mk({ alpha: 'write' })
  kernel.sessions.run(w.id)
  assert.doesNotMatch((await settle(kernel, w.id)).startError ?? '', inUse, 'a writer starts beside it')
  // And it starts beside a writer: the loop's executor keeps its claim.
  hold(w)
  const rv2 = mk({ alpha: 'read-locked' }, 'reviewer')
  kernel.sessions.run(rv2.id)
  assert.doesNotMatch((await settle(kernel, rv2.id)).startError ?? '', inUse, 'a reviewer never waits on the writer')
  release(w)
  release(rv)
  for (const s of [rv, rv2, w]) kernel.sessions.deleteSession(s.id)
})

// --- claims: readers share, writers exclude --------------------------------------

test('read-locked readers share a clone; a writer excludes both ways', async () => {
  const r1 = mk({ alpha: 'read-locked' }, 'researcher')
  hold(r1)
  const r2 = mk({ alpha: 'read-locked' }, 'researcher')
  kernel.sessions.run(r2.id)
  assert.doesNotMatch((await settle(kernel, r2.id)).startError ?? '', inUse, 'two read-locked readers coexist')

  const w = mk({ alpha: 'write' })
  kernel.sessions.run(w.id)
  assert.match(
    (await settle(kernel, w.id)).startError ?? '',
    new RegExp(`repository "alpha" is in use by session "${r1.title}"`),
    'a reader excludes a writer'
  )
  release(r1)

  hold(w)
  const r3 = mk({ alpha: 'read-locked' }, 'researcher')
  kernel.sessions.run(r3.id)
  assert.match((await settle(kernel, r3.id)).startError ?? '', inUse, 'a writer excludes a read-locked reader')
  const live = mk({ alpha: 'read' }, 'researcher')
  kernel.sessions.run(live.id)
  assert.doesNotMatch((await settle(kernel, live.id)).startError ?? '', inUse, 'a plain reader is never excluded')
  hold(live)
  assert.equal(kernel.sessions.repoHolderFor(ws, task, 'alpha')?.id, w.id, 'the writer is the holder; the plain reader holds nothing')
  release(w)
  release(live)
  assert.equal(kernel.sessions.repoHolderFor(ws, task, 'alpha'), undefined)
})

// --- all-or-nothing, and FIFO by clone -------------------------------------------

test('a multi-repo start takes every claim or none, and nobody overtakes it', async () => {
  const hb = mk({ beta: 'write' })
  hold(hb)
  const both = mk({ alpha: 'write', beta: 'write' })
  kernel.sessions.enqueue(both.id)
  await tick()
  assert.equal(state(both), 'queued', 'beta is held, so alpha is not taken either')
  const onlyAlpha = mk({ alpha: 'write' })
  kernel.sessions.enqueue(onlyAlpha.id)
  await tick()
  assert.equal(state(onlyAlpha), 'queued', 'a later session cannot take alpha out from under the one waiting for it')
  const wait = kernel.sessions.snapshot(both.id)
  assert.equal(wait.info.state, 'queued')
  release(hb)
  kernel.sessions.schedule()
  assert.doesNotMatch((await settle(kernel, both.id)).startError ?? '', inUse, 'freed, the first in line goes first')
  kernel.sessions.schedule()
  assert.doesNotMatch((await settle(kernel, onlyAlpha.id)).startError ?? '', inUse, 'and the next one after it')
})

test('a stream of readers cannot starve a waiting writer', async () => {
  const r = mk({ alpha: 'read-locked' }, 'researcher')
  hold(r)
  const w = mk({ alpha: 'write' })
  kernel.sessions.enqueue(w.id)
  await tick()
  assert.equal(state(w), 'queued', 'the writer waits for the reader')
  const late = mk({ alpha: 'read-locked' }, 'researcher')
  kernel.sessions.enqueue(late.id)
  await tick()
  assert.equal(state(late), 'queued', 'a later reader queues behind the writer instead of joining the first reader')
  release(r)
  kernel.sessions.schedule()
  await settle(kernel, w.id)
  kernel.sessions.schedule()
  await settle(kernel, late.id)
})

// --- the queue handoff reaps only a holder that actually blocks -----------------

test('the handoff lists a holder only when its claim conflicts with a wanted one', async () => {
  const wa = mk({ alpha: 'write' })
  hold(wa)
  const rb = mk({ beta: 'read-locked' }, 'researcher')
  hold(rb)
  const q = mk({ alpha: 'write', beta: 'read-locked' })
  kernel.sessions.enqueue(q.id)
  await tick()
  assert.equal(state(q), 'queued')
  const listed = kernel.sessions.holdersBlockingQueue()
  assert.ok(listed.includes(wa.id), 'the writer on alpha blocks the queued writer')
  assert.ok(!listed.includes(rb.id), 'a reader on beta does not block a queued reader of beta')
  kernel.sessions.cancelQueue(q.id)
  release(wa)
  release(rb)
})

// --- per-repo `complete` (§3) -----------------------------------------------------

test('complete: per-repo entries must name write repos, at most once', () => {
  const p = (repos) => ({ version: 1, outcome: 'changes', repos })
  const entry = (repo) => ({ repo, commit: { subject: `${repo}: s` } })
  m.assertProposalFits(['alpha', 'beta'], p([entry('alpha'), entry('beta')]))
  assert.throws(() => m.assertProposalFits(['alpha'], p([entry('beta')])), /"beta" is not mounted for write .* only for: alpha/)
  assert.throws(() => m.assertProposalFits([], p([entry('beta')])), /writes no repository/)
  assert.throws(() => m.assertProposalFits(['alpha'], p([entry('alpha'), entry('alpha')])), /named twice/)
  m.assertProposalFits([], { version: 1, outcome: 'no_changes' })

  const stored = {
    version: 1,
    outcome: 'changes',
    commit: { subject: 'shared' },
    repos: [{ repo: 'beta', commit: { subject: 'beta own' }, pr: { title: 'beta pr' } }],
    at: 'x'
  }
  assert.deepEqual(m.proposalForRepo(stored, 'beta').commit, { subject: 'beta own' }, 'its own entry first')
  assert.deepEqual(m.proposalForRepo(stored, 'beta').pr, { title: 'beta pr' })
  assert.equal(m.proposalForRepo(stored, 'beta').repos, undefined, 'resolved to one repo')
  assert.deepEqual(m.proposalForRepo(stored, 'alpha').commit, { subject: 'shared' }, 'else the shared one')
  assert.equal(m.proposalForRepo({ ...stored, commit: undefined }, 'alpha'), undefined, 'neither: nothing')
})

test('latestProposal resolves per repo, from sessions that write it', () => {
  const writer = mk({ alpha: 'write', beta: 'write' })
  const reader = mk({ alpha: 'read' }, 'researcher')
  // The `gurt` server's callback, as the session manager wires it.
  const complete = (s, p) => kernel.sessions['onComplete'](s.id, p)
  complete(writer, {
    version: 1,
    outcome: 'changes',
    repos: [
      { repo: 'alpha', commit: { subject: 'alpha change' } },
      { repo: 'beta', commit: { subject: 'beta change' } }
    ]
  })
  assert.equal(kernel.sessions.latestProposal(ws, task, 'alpha')?.commit?.subject, 'alpha change')
  assert.equal(kernel.sessions.latestProposal(ws, task, 'beta')?.commit?.subject, 'beta change')
  assert.ok(
    kernel.sessions
      .snapshot(writer.id)
      .entries.some((e) => e.kind === 'system' && /alpha: alpha change; beta: beta change/.test(e.text)),
    'the timeline line names each repo'
  )
  assert.throws(
    () => complete(writer, { version: 1, outcome: 'changes', repos: [{ repo: 'gamma', commit: { subject: 's' } }] }),
    /not mounted for write/,
    'a refused call throws — the tool layer turns it into isError'
  )
  assert.equal(kernel.sessions.latestProposal(ws, task, 'alpha')?.commit?.subject, 'alpha change', 'and records nothing')
  // A session that only reads alpha never prefills alpha's commit, whatever it
  // reports (a researcher has no `complete`, but a stale proposal must not count).
  kernel.sessions['sessions'].get(reader.id).proposal = {
    version: 1,
    outcome: 'changes',
    commit: { subject: 'from a reader' },
    at: '9999-01-01T00:00:00.000Z'
  }
  assert.equal(kernel.sessions.latestProposal(ws, task, 'alpha')?.commit?.subject, 'alpha change')
})

// --- review loop: the open set and the verdict's host rule (review-loop §4) -------

test('replies answer the open set exactly once, naming nothing else', () => {
  const r = (findingId, resolution = 'fixed') => ({ findingId, resolution, note: 'n' })
  const open = [m.findingRef(1, 'F1'), m.findingRef(1, 'F2')]
  assert.deepEqual(open, ['R1.F1', 'R1.F2'], 'a finding is named by round and id')
  m.assertRepliesAnswer(open, [r('R1.F1'), r('R1.F2', 'refuted')])
  m.assertRepliesAnswer(open, [r('R1.F2', 'declined'), r('R1.F1')]) // any order
  assert.throws(() => m.assertRepliesAnswer(open, undefined), /not answered: R1\.F1, R1\.F2/, 'no replies at all')
  assert.throws(() => m.assertRepliesAnswer(open, [r('R1.F1')]), /not answered: R1\.F2/, 'a missing answer')
  assert.throws(
    () => m.assertRepliesAnswer(open, [r('R1.F1'), r('R1.F2'), r('R1.F9')]),
    /not open: R1\.F9/,
    'an unknown id'
  )
  assert.throws(
    () => m.assertRepliesAnswer(open, [r('R1.F1'), r('R1.F1', 'declined'), r('R1.F2')]),
    /answered more than once: R1\.F1/,
    'an answer given twice'
  )
  assert.throws(
    () => m.assertRepliesAnswer(open, [r('R0.F1'), r('R1.F1')]),
    /not answered: R1\.F2; not open: R0\.F1/,
    'every problem named at once'
  )
  // No open set: anything goes, nothing is checked.
  m.assertRepliesAnswer([], undefined)
  m.assertRepliesAnswer([], [r('R7.whatever')])
})

test('a finding names one of the session’s repos', () => {
  const v = (...files) => ({
    version: 1,
    verdict: 'request_changes',
    summary: 's',
    findings: files.map((file, i) => ({ id: `F${i}`, file, severity: 'major', claim: 'c' }))
  })
  m.assertVerdictFits(['alpha', 'beta'], v('alpha/src/a.ts', 'beta/README.md', 'alpha'))
  m.assertVerdictFits(['alpha'], { ...v(), verdict: 'approve' })
  assert.throws(() => m.assertVerdictFits(['alpha'], v('gamma/x.ts')), /"F0": file "gamma\/x\.ts" names no repository .* one of: alpha/)
  assert.throws(() => m.assertVerdictFits(['alpha'], v('/workspaces/alpha/x.ts')), /names no repository/, 'not an absolute path')
  assert.throws(() => m.assertVerdictFits(['alpha'], v('alpha/../beta/x')), /names no repository/, 'not out of the repo')
  assert.throws(() => m.assertVerdictFits(['alpha'], v('alpha/ok', 'src/a.ts')), /"F1"/, 'the offending finding is named')
})

test('submit_review: the session manager stores the verdict; the last call of a turn wins', () => {
  const rv = mk({ alpha: 'read', beta: 'read' }, 'reviewer')
  const live = kernel.sessions['sessions'].get(rv.id)
  live.info.reviewOf = { executor: 'exec-1', round: 2, intent: 'i-7' }
  live.turnSeq = 3
  const submit = (v) => kernel.sessions['onSubmitReview'](rv.id, v)
  const verdict = (over) => ({ version: 1, verdict: 'approve', summary: 'ok', findings: [], ...over })
  const changes = verdict({
    verdict: 'request_changes',
    summary: 'two problems',
    findings: [
      { id: 'F1', file: 'alpha/a.ts', severity: 'major', claim: 'c' },
      { id: 'F2', file: 'beta/b.ts', severity: 'nit', claim: 'c' }
    ]
  })
  live.turnComplete = false
  submit(changes)
  assert.equal(live.turnComplete, true, 'the turn is complete — no nudge follows')
  assert.equal(live.verdict.verdict, 'request_changes')
  assert.equal(live.verdict.round, 2, 'filed under the round the reviewer is')
  assert.equal(live.verdict.turnId, `${rv.id}:3`, 'and the turn it came in')
  assert.ok(Date.parse(live.verdict.at), 'with its receipt time')
  assert.deepEqual(live.verdict.findings, changes.findings)
  submit(verdict({ summary: 'on reflection, fine' }))
  assert.equal(live.verdict.verdict, 'approve', 'a second call replaces the first')
  assert.equal(live.verdict.summary, 'on reflection, fine')
  const lines = kernel.sessions
    .snapshot(rv.id)
    .entries.filter((e) => e.kind === 'system' && e.text.startsWith('submit_review'))
    .map((e) => e.text)
  assert.deepEqual(lines, ['submit_review: request_changes — 2 findings', 'submit_review: approve'], 'each call on the timeline')

  live.turnComplete = false
  assert.throws(
    () => submit({ ...changes, findings: [{ id: 'F1', file: 'gamma/x', severity: 'major', claim: 'c' }] }),
    /names no repository/,
    'a refused call throws — the tool layer turns it into isError'
  )
  assert.equal(live.turnComplete, false, 'and completes nothing')
  assert.equal(live.verdict.summary, 'on reflection, fine', 'and records nothing')
  kernel.sessions.deleteSession(rv.id)
})

test('complete: the open set, when the loop has one, is answered before anything is recorded', () => {
  const e = mk({ alpha: 'write' })
  const live = kernel.sessions['sessions'].get(e.id)
  const complete = (p) => kernel.sessions['onComplete'](e.id, p)
  const changes = (replies) => ({ version: 1, outcome: 'changes', commit: { subject: 'fix' }, ...(replies ? { replies } : {}) })
  const reply = (findingId) => ({ findingId, resolution: 'fixed', note: 'n' })

  // No loop wired (the kernel provides no open set yet): replies pass unchecked.
  complete(changes([reply('R9.F9')]))
  assert.equal(live.proposal.commit.subject, 'fix', 'accepted')
  complete(changes())
  assert.equal(live.turnComplete, true)

  const events = kernel.sessions['events']
  let asked
  events.openFindings = (id) => {
    asked = id
    return ['R1.F1', 'R1.F2']
  }
  try {
    live.turnComplete = false
    live.proposal = undefined
    assert.throws(() => complete(changes([reply('R1.F1')])), /not answered: R1\.F2/, 'an unanswered finding refuses the call')
    assert.equal(asked, e.id, 'the hook is asked for this session’s set')
    assert.equal(live.turnComplete, false, 'nothing completed')
    assert.equal(live.proposal, undefined, 'nothing recorded')
    complete(changes([reply('R1.F2'), reply('R1.F1')]))
    assert.equal(live.turnComplete, true, 'every finding answered once: accepted')
    assert.deepEqual(live.proposal.replies.map((r) => r.findingId), ['R1.F2', 'R1.F1'], 'the replies ride the proposal')
    // Only a `complete` with changes answers the set (§4.2).
    live.turnComplete = false
    complete({ version: 1, outcome: 'blocked', reason: 'stuck' })
    assert.equal(live.turnComplete, true, 'blocked needs no replies')
  } finally {
    delete events.openFindings
  }
  kernel.sessions.deleteSession(e.id)
})
