// Per-repo mount modes (docs/requirements-repo-mounts.md), without docker or an
// agent: the clone claims each mode takes (§2.1 — shared readers, exclusive
// writers, all-or-nothing starts, FIFO by clone, the queue handoff), how modes
// are normalized and edited (§2, §5), and the per-repo `complete` (§3).
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
      `export { assertProposalFits, proposalForRepo } from ${S('src/main/sessions.ts')}\n` +
      `export { anchorRepo, normalizeRepoModes, repoMode } from ${S('src/shared/types.ts')}`,
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
