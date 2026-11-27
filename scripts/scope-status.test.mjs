// The scope row's status strip: which slots are drawn, in which colour, and
// what wins inside a slot (docs/requirements-scope-row-status.md).
// Pure mapping only — nothing is rendered.
//
// Worth pinning because a wrong mapping still draws a plausible row: a
// failed turn shown green, or a queued session outranking a running one, looks
// like a calm scope rather than like a bug.
//
//   node scripts/scope-status.test.mjs
import { test } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-scope-status-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await bundle({
  stdin: {
    contents: `export * from ${S('src/renderer/src/scopeStatus.ts')}
export { URGENCY, turnFailed } from ${S('src/renderer/src/status.ts')}`,
    resolveDir: ROOT,
    loader: 'tsx',
    sourcefile: 'entry.tsx'
  },
  outfile
})

const { sessionState, sessionsSlot, deliverySlot, repoDelivery, scopeStatus, scopeWantsUser, DELIVERY_TONE, URGENCY, turnFailed } =
  await import(pathToFileURL(outfile).href)

let n = 0
/** A session as the renderer holds it: record plus live overlay. */
const info = (over = {}) => ({ id: `s${++n}`, env: 'dev', repos: ['app'], workspace: 'w', task: 't', title: `session ${n}`, state: 'started', startPrompt: '', seen: true, ...over })
const input = (over = {}, extra = {}) => ({ info: info(over), ...extra })
const tone = (over, extra) => sessionState(input(over, extra)).tone

const running = () => input({ busy: true })
const waiting = () => input({ awaitingInput: true })
const queued = () => input({ state: 'queued' })
const errored = () => input({}, { lastTurn: { outcome: 'error', detail: 'adapter crashed' } })

test('urgency order is red > yellow > green > blue > gray', () => {
  assert.deepEqual([...URGENCY], ['red', 'yellow', 'green', 'accent', 'faint'])
})

test('red: a failed turn, a failed start, a broken container, an incomplete turn', () => {
  assert.equal(tone({}, { lastTurn: { outcome: 'error' } }), 'red')
  assert.equal(tone({ seen: false }, { lastTurn: { outcome: 'limited' } }), 'red', 'a limit cut with no reset to wait for')
  assert.equal(tone({ state: 'draft' }, { startError: 'image build failed' }), 'red')
  assert.equal(tone({ container: { status: 'error', repos: ['app'] } }), 'red')
  assert.equal(tone({ incomplete: true }), 'red')
  assert.equal(turnFailed({ outcome: 'cancelled' }), false)
  assert.equal(tone({}, { lastTurn: { outcome: 'cancelled' } }), 'faint', 'a cancelled turn is not broken')
  assert.equal(tone({}, { lastTurn: { outcome: 'ok' } }), 'faint')
})

test('yellow: needs the user — permission, an unread result, an agent draft', () => {
  assert.equal(tone({ awaitingInput: true }), 'yellow')
  assert.equal(tone({ seen: false }), 'yellow', 'idle and unseen')
  assert.equal(tone({ state: 'draft', draftedBy: 'parent' }), 'yellow', 'drafted by an agent, waiting for launch')
})

test('green: running, starting, or an idle executor whose check or review runs', () => {
  assert.equal(tone({ busy: true }), 'green')
  assert.equal(tone({ state: 'starting' }), 'green')
  assert.equal(tone({ seen: false, flow: 'check' }), 'green', 'unseen but the flow continues: no yellow')
  assert.equal(tone({ seen: true, flow: 'review' }), 'green')
})

test('blue: queued, a plan-limit wait, a held-back review, a waiting message', () => {
  assert.equal(tone({ state: 'queued' }), 'accent')
  assert.equal(tone({ seen: false, limitedUntil: '2026-11-27T18:00:00Z' }, { lastTurn: { outcome: 'limited' } }), 'accent',
    'a limit cut that continues by itself is not broken')
  assert.equal(tone({ seen: false, flow: 'queued' }), 'accent')
  assert.equal(tone({ seen: false, queueWaiting: 'clone is in use by another session' }), 'accent')
})

test('gray: the user\'s own draft, a read result, an agent draft already handed off', () => {
  assert.equal(tone({ state: 'draft' }), 'faint')
  assert.equal(tone({ seen: true }), 'faint')
  assert.equal(tone({ state: 'draft', draftedBy: 'parent', handedOff: true }), 'faint')
})

test('a failed last turn is red for a session at rest, whatever runs around it', () => {
  // Red sources on the record still win over a live permission prompt.
  assert.equal(tone({ awaitingInput: true, incomplete: true }), 'red')
  // At rest, the ledger's last record is the session's last turn: red, even
  // while RPM checks or reviews around the executor.
  for (const flow of ['check', 'review', 'queued'])
    assert.equal(tone({ seen: false, flow }, { lastTurn: { outcome: 'error' } }), 'red', `flow ${flow}`)
  assert.equal(tone({ seen: true, queueWaiting: 'clone in use' }, { lastTurn: { outcome: 'limited' } }), 'red')
  // A turn in flight (or a retry the agent is running) supersedes the ledger's
  // last record — that is an earlier turn's, which the Dashboard ignores too.
  assert.equal(tone({ busy: true }, { lastTurn: { outcome: 'error' } }), 'green')
  assert.equal(tone({ awaitingInput: true }, { lastTurn: { outcome: 'error' } }), 'yellow')
})

test('sessions slot: the most urgent session wins, one icon', () => {
  assert.equal(sessionsSlot([running(), running(), waiting()]).tone, 'yellow')
  assert.equal(sessionsSlot([errored(), running(), running()]).tone, 'red')
  assert.equal(sessionsSlot([queued(), running()]).tone, 'green', 'running outranks queued')
  assert.equal(sessionsSlot([input({ seen: false }), running()]).tone, 'yellow', 'an unread result outranks work going on')
})

test('sessions slot: always present, reviewers left out', () => {
  assert.equal(sessionsSlot([]).tone, 'faint')
  assert.match(sessionsSlot([]).title, /none/)
  const reviewer = input({ role: 'reviewer', reviewerOf: { executor: 'x', key: 'k' }, awaitingInput: true })
  assert.equal(sessionsSlot([reviewer]).tone, 'faint', 'a reviewer belongs to the review slot')
  assert.equal(sessionsSlot([reviewer, running()]).tone, 'green')
})

test('sessions tooltip names the loud sessions, most urgent first, and counts the quiet ones', () => {
  const slot = sessionsSlot([
    input({ title: 'docs', busy: true }),
    input({ title: 'quiet one', seen: true }),
    input({ title: 'api' }, { lastTurn: { outcome: 'error', detail: 'adapter crashed' } })
  ])
  const lines = slot.title.split('\n')
  assert.equal(lines[0], 'Sessions — broken')
  assert.match(lines[1], /^api: last turn errored: adapter crashed$/)
  assert.match(lines[2], /^docs: working$/)
  assert.equal(lines[3], '+ 1 quiet session')
  assert.equal(sessionsSlot([input(), input()]).title, 'Sessions — nothing to report\n2 sessions, all quiet')
  const limited = sessionState(input({ limitedUntil: '2026-11-27T18:00:00Z' }, { formatTime: () => '18:00' }))
  assert.match(limited.reason, /continues by itself at 18:00/)
})

/** A clone's git state; defaults to "no difference from main". */
const repo = (over = {}) => ({
  repo: 'app', dirty: false, files: [], insertions: 0, deletions: 0, defaultBranch: 'main', commits: [], integrated: true,
  behind: 0, conflicted: false, ...over
})
const commit = (pushed) => ({ sha: 'a'.repeat(40), subject: 'x', pushed })

test('delivery: absent with no repos or no differences', () => {
  assert.equal(deliverySlot([]), undefined)
  assert.equal(deliverySlot([repo()]), undefined)
  assert.equal(deliverySlot([repo({ integrated: false })]), undefined, 'no commits ahead')
  assert.equal(deliverySlot([repo({ integrated: true, commits: [commit(true)] })]), undefined, 'integrated thread is history')
})

test('delivery: gray presence when any repo is dirty or holds unintegrated commits', () => {
  assert.equal(deliverySlot([repo(), repo({ repo: 'lib', dirty: true })])?.tone, 'faint')
  assert.equal(deliverySlot([repo({ integrated: false, commits: [commit(false)] })])?.tone, 'faint')
  assert.equal(deliverySlot([repo({ integrated: false, commits: [commit(true)] })])?.tone, 'faint')
  assert.equal(deliverySlot([repo({ dirty: true, conflicted: true })])?.tone, 'faint')
})

test('delivery kinds are ready for their colours: only DELIVERY_TONE changes', () => {
  assert.equal(repoDelivery(repo({ dirty: true, conflicted: true })), 'conflict')
  assert.equal(repoDelivery(repo({ dirty: true })), 'local')
  assert.equal(repoDelivery(repo({ integrated: false, commits: [commit(true), commit(false)] })), 'local')
  assert.equal(repoDelivery(repo({ integrated: false, commits: [commit(true)] })), 'pushed')
  assert.deepEqual(DELIVERY_TONE, { conflict: 'faint', local: 'faint', pushed: 'faint' }, 'phase 1: presence only')
  // The slot takes the most urgent kind's tone through the table.
  const saved = { ...DELIVERY_TONE }
  try {
    Object.assign(DELIVERY_TONE, { conflict: 'red', local: 'yellow', pushed: 'accent' })
    assert.equal(deliverySlot([repo({ integrated: false, commits: [commit(true)] }), repo({ dirty: true })])?.tone, 'yellow')
    assert.equal(deliverySlot([repo({ dirty: true, conflicted: true }), repo({ dirty: true })])?.tone, 'red')
  } finally {
    Object.assign(DELIVERY_TONE, saved)
  }
})

test('delivery tooltip names each differing repo with its commit counts', () => {
  const slot = deliverySlot([
    repo({ repo: 'app', dirty: true, integrated: false, commits: [commit(true), commit(false), commit(false)] }),
    repo({ repo: 'clean' }),
    repo({ repo: 'lib', integrated: false, commits: [commit(true)] })
  ])
  assert.equal(slot.title, [
    'Changes vs the default branch',
    'app: uncommitted changes · 3 commits not on main, 2 unpushed',
    'lib: 1 commit not on main, pushed'
  ].join('\n'))
})

test('the strip: review reserved, name raised by any yellow or red slot', () => {
  const quiet = scopeStatus([input()], [repo({ dirty: true })])
  assert.equal(quiet.review, undefined, 'phase 2')
  assert.equal(quiet.delivery?.tone, 'faint')
  assert.equal(scopeWantsUser(quiet), false)
  assert.equal(scopeWantsUser(scopeStatus([running()], [])), false, 'work going on does not call the user')
  assert.equal(scopeWantsUser(scopeStatus([queued()], [])), false)
  assert.equal(scopeWantsUser(scopeStatus([waiting()], [])), true)
  assert.equal(scopeWantsUser(scopeStatus([errored()], [])), true)
})
