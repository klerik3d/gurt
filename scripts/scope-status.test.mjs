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

const { sessionState, sessionsSlot, reviewSlot, reviewTone, CALL_TONE, deliverySlot, repoDelivery, scopeStatus, scopeWantsUser, DELIVERY_TONE, URGENCY, turnFailed } =
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

test('green: running or starting', () => {
  assert.equal(tone({ busy: true }), 'green')
  assert.equal(tone({ state: 'starting' }), 'green')
})

test('an idle executor whose RPM run works around it is gray here — the review slot shows the work', () => {
  for (const flow of ['check', 'review', 'queued']) {
    assert.equal(tone({ seen: false, flow }), 'faint', `flow ${flow}: unseen, but the run comes back by itself — no yellow`)
    assert.equal(tone({ seen: true, flow }), 'faint', `flow ${flow}`)
  }
  // A flow is only read for an idle session: a working one is still green.
  assert.equal(tone({ busy: true, flow: 'review' }), 'green')
  // A message that waits outranks the quiet flow: it moves on by itself, later.
  assert.equal(tone({ seen: false, flow: 'review', queueWaiting: 'clone in use' }), 'accent')
})

test('blue: queued, a plan-limit wait, a waiting message', () => {
  assert.equal(tone({ state: 'queued' }), 'accent')
  assert.equal(tone({ seen: false, limitedUntil: '2026-11-27T18:00:00Z' }, { lastTurn: { outcome: 'limited' } }), 'accent',
    'a limit cut that continues by itself is not broken')
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

test('the strip: review only with RPM on, name raised by any yellow or red slot', () => {
  const quiet = scopeStatus([input()], [repo({ dirty: true })])
  assert.equal(quiet.review, undefined, 'no executor with RPM on')
  assert.equal(quiet.delivery?.tone, 'faint')
  assert.equal(scopeWantsUser(quiet), false)
  assert.equal(scopeWantsUser(scopeStatus([running()], [])), false, 'work going on does not call the user')
  assert.equal(scopeWantsUser(scopeStatus([queued()], [])), false)
  assert.equal(scopeWantsUser(scopeStatus([waiting()], [])), true)
  assert.equal(scopeWantsUser(scopeStatus([errored()], [])), true)
})

// ---- slot 2: review (RPM) ----------------------------------------------------

/** An executor's `RpmBrief`; `status` is a `RunStatus`, phase plus its fields. */
const brief = (status, over = {}) => ({ executor: 'x', enabled: true, live: !!status && !['passed', 'ended'].includes(status.phase), ...(status && { status: { reviewsSinceYou: 0, ...status } }), ...over })
const executor = (status, over = {}, info = {}) => input({ role: 'executor', ...info }, { rpm: brief(status, over) })
const called = (why) => ({ phase: 'called', why, items: [] })
const review = (over = {}) => ({ phase: 'review', review: 1, full: true, items: 0, session: 'r1', ...over })

test('review tone per RunStatus', () => {
  assert.equal(reviewTone(undefined), 'faint', 'enabled, no run yet')
  assert.equal(reviewTone({ phase: 'check', repos: ['app'] }), 'green')
  assert.equal(reviewTone({ phase: 'fix-check', try: 1, of: 3 }), 'green')
  assert.equal(reviewTone(review()), 'green')
  assert.equal(reviewTone(review({ waitingPlan: '2026-11-27T18:00:00Z' })), 'accent', 'the reviewer waits for its plan limit')
  assert.equal(reviewTone({ phase: 'executor', items: 2 }), 'accent', 'the cycle waits for the executor')
  assert.equal(reviewTone({ phase: 'paused' }), 'faint')
  assert.equal(reviewTone({ phase: 'passed', files: 3 }), 'faint')
  assert.equal(reviewTone({ phase: 'ended', why: 'stopped' }), 'faint')
})

test('a call is red when something broke, yellow when it waits for your word', () => {
  for (const why of ['check-red', 'check-error', 'reviewer-failed', 'executor-failed'])
    assert.equal(reviewTone(called(why)), 'red', why)
  for (const why of ['findings', 'idle-executor', 'budget', 'check-unchanged', 'executor-blocked'])
    assert.equal(reviewTone(called(why)), 'yellow', why)
  assert.equal(Object.keys(CALL_TONE).length, 9, 'every CallReason has a tone')
})

test('review slot: present only when an executor of the scope has RPM on', () => {
  assert.equal(reviewSlot([]), undefined)
  assert.equal(reviewSlot([running(), input({ seen: false })]), undefined, 'no RPM brief at all')
  assert.equal(reviewSlot([executor(undefined, { enabled: false })]), undefined, 'RPM off, no run')
  assert.equal(reviewSlot([executor({ phase: 'passed', files: 2 }, { enabled: false })]), undefined, 'RPM off, last run over')
  assert.equal(reviewSlot([executor(review(), { enabled: false, live: true })]), undefined, 'turned off: absent, even while the run lasts to its boundary')
  assert.equal(reviewSlot([executor(called('check-red'), { enabled: false, live: true }), executor(undefined)])?.tone, 'faint',
    'a turned-off executor does not colour the slot another one keeps')
  assert.equal(reviewSlot([executor(undefined)])?.tone, 'faint', 'on, no run yet: gray presence')
  assert.equal(scopeStatus([executor(undefined)], []).review?.tone, 'faint')
})

test('review slot: the most urgent executor wins', () => {
  assert.equal(reviewSlot([executor(review()), executor(called('check-red'))]).tone, 'red', 'a red call outranks an active review')
  assert.equal(reviewSlot([executor(review()), executor(called('findings'))]).tone, 'yellow')
  assert.equal(reviewSlot([executor({ phase: 'executor', items: 1 }), executor(review())]).tone, 'green', 'working outranks waiting')
  assert.equal(reviewSlot([executor(review({ waitingPlan: '2026-11-27T18:00:00Z' })), executor(undefined)]).tone, 'accent')
  assert.equal(reviewSlot([executor({ phase: 'passed', files: 1 }), executor(undefined, { enabled: false })]).tone, 'faint')
})

test('review tooltip names each executor with its status line, most urgent first', () => {
  const slot = reviewSlot([
    executor({ phase: 'passed', files: 2 }, {}, { title: 'docs' }),
    executor(undefined, {}, { title: 'fresh' }),
    executor(review({ items: 2 }), {}, { title: 'api' }),
    executor(called('reviewer-failed'), {}, { title: 'auth' }),
    running()
  ])
  assert.equal(slot.title, [
    'Review — broken',
    'auth: Waiting for you · reviewer failed',
    'api: Reviewer R1 is reviewing the change and checking 2 findings',
    'docs: Passed',
    'fresh: review on — no run yet'
  ].join('\n'))
})

test('the mockup\'s rows: sessions and review read together', () => {
  // An executor has settled and RPM is reviewing its changes.
  const reviewing = scopeStatus([executor(review(), {}, { seen: false, flow: 'review' })], [repo({ dirty: true })])
  assert.deepEqual([reviewing.sessions.tone, reviewing.review?.tone, reviewing.delivery?.tone], ['faint', 'green', 'faint'])
  assert.equal(scopeWantsUser(reviewing), false, 'an unseen result while the run goes on does not call the user')
  // An executor is fixing findings and RPM is waiting for it.
  const fixing = scopeStatus([executor({ phase: 'executor', items: 1 }, {}, { busy: true })], [repo({ dirty: true })])
  assert.deepEqual([fixing.sessions.tone, fixing.review?.tone], ['green', 'accent'])
  // A session and a reviewer wait for plan limits.
  const limits = scopeStatus([
    executor(review({ waitingPlan: '2026-11-27T18:00:00Z' }), {}, { flow: 'queued' }),
    input({ state: 'queued' })
  ], [])
  assert.deepEqual([limits.sessions.tone, limits.review?.tone, limits.delivery], ['accent', 'accent', undefined])
  // RPM called the user: the name is raised.
  assert.equal(scopeWantsUser(scopeStatus([executor(called('findings'))], [])), true)
  assert.equal(scopeWantsUser(scopeStatus([executor(called('check-error'))], [])), true)
})
