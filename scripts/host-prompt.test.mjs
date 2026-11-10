// The review loop's host messages and the human-act events
// (docs/requirements-review-loop.md §5.5, §5.6):
//
//   - `hostPrompt` queues an `auto` prompt carrying the intent id, persisted like
//     a typed one, run by `drainPending` and shown as a `system` entry that
//     carries the id — not as a `user` message;
//   - a typed message or a stop drops it; it never clears `recovering`;
//   - `session.human` comes from `prompt`, `cancel` and the queue cancels — never
//     from `hostPrompt`, the nudge or a host-side cancel;
//   - the delivery gate holds a typed message while the loop delivers;
//   - the loop's own sessions are left out of the Resume modal and the update
//     deferral; with no hooks registered nothing changes.
//
//   node scripts/host-prompt.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loopHarness, gate } from './lib/loop-harness.mjs'

const h = await loopHarness('host-prompt')
const { kernel, agent, tick, until } = h
// `session.human` and `session.settled` belong to loop sessions only (fix 1,
// scripts/ordinary-session-unchanged.test.mjs). These sessions carry `reviewOf`
// naming an executor that has no loop — a loop session as far as the session
// manager is concerned, inert for the controller (a real Review block would
// start a loop that reacts to the very acts under test).
const LOOP_MARK = { executor: 'nobody', round: 1, intent: 'nobody.1' }
const started = (id, repos, extra = {}, opts) => h.started(id, repos, { reviewOf: LOOP_MARK, ...extra }, opts)
after(() => h.cleanup())

const humans = []
const settled = []
kernel.bus.on('session.human', (e) => humans.push(`${e.sessionId}:${e.did}`))
kernel.bus.on('session.settled', (e) => settled.push(e.sessionId))
const sm = kernel.sessions
const entries = (id) => sm.snapshot(id).entries
const diskRow = (id) =>
  JSON.parse(fs.readFileSync(path.join(h.GURT_ROOT, 'w', 't', 'sessions.json'), 'utf8')).find((r) => r.info.id === id)
const done = (id, n) => until(() => settled.filter((x) => x === id).length >= n, `${id} settled x${n}`)

/** A session whose first turn waits on a gate; every turn completes. */
function slowAgent(id) {
  const g = { in: gate(), out: gate(), texts: [] }
  agent(id, async (n, text) => {
    g.texts.push(text)
    if (n === 1) {
      g.in.open()
      await g.out
    }
    sm['onComplete'](id, { version: 1, outcome: 'no_changes' })
    return {}
  })
  return g
}

test('a host message runs as a system entry carrying the intent id, not as a user message', async () => {
  started('a', ['alpha'])
  const g = slowAgent('a')
  g.out.open()
  await sm.hostPrompt('a', 'red check: exit 1', 'a.4')
  await done('a', 1)
  assert.deepEqual(g.texts, ['red check: exit 1'], 'the agent got the text')
  const e = entries('a').filter((x) => x.kind === 'system' || x.kind === 'user')
  assert.equal(e[0].kind, 'system')
  assert.equal(e[0].text, 'red check: exit 1')
  assert.equal(e[0].loop, 'a.4', 'the entry carries the intent id')
  assert.ok(!entries('a').some((x) => x.kind === 'user'), 'no user message')
  assert.deepEqual(sm.snapshot('a').pending, undefined, 'and nothing is left waiting')
  assert.deepEqual(humans, [], 'a host message is not a human act')
  assert.equal(diskRow('a').pending.length, 0)
})

test('queued behind a turn it is persisted as an auto prompt with its origin, and shown so', async () => {
  started('b', ['alpha'])
  const g = slowAgent('b')
  await sm.prompt('b', 'work')
  await g.in
  humans.length = 0
  await sm.hostPrompt('b', 'findings', 'b.7')
  const row = diskRow('b').pending
  assert.equal(row.length, 1)
  assert.equal(row[0].auto, true)
  assert.deepEqual(row[0].origin, { loop: 'b.7' })
  assert.deepEqual(sm.snapshot('b').pending.map((p) => [p.text, p.auto, p.loop]), [['findings', true, 'b.7']])
  await sm.hostPrompt('b', 'findings again', 'b.7')
  assert.equal(sm.snapshot('b').pending.length, 1, 'the same intent id is queued once')
  // A restart gives it back, origin intact.
  kernel.sessions.restore([
    { ...diskRow('b'), info: { ...diskRow('b').info, id: 'b2' }, log: [] }
  ])
  assert.deepEqual(sm.snapshot('b2').pending.map((p) => p.loop), ['b.7'])
  sm.deleteSession('b2')
  g.out.open()
  await done('b', 2)
  assert.deepEqual(g.texts, ['work', 'findings'], 'it ran after the turn, once')
  assert.deepEqual(humans, [], 'still no human event')
})

test('a typed message drops a queued host message — and says so with session.human', async () => {
  started('c', ['alpha'])
  const g = slowAgent('c')
  await sm.prompt('c', 'work')
  await g.in
  await sm.hostPrompt('c', 'loop message', 'c.1')
  humans.length = 0
  await sm.prompt('c', 'the user steps in')
  assert.deepEqual(humans, ['c:prompt'])
  assert.deepEqual(sm.snapshot('c').pending.map((p) => p.text), ['the user steps in'], 'the loop’s message is gone')
  g.out.open()
  await done('c', 2)
  assert.deepEqual(g.texts, ['work', 'the user steps in'])
})

test('stop drops a host message without handing it back; cancelling its row too', async () => {
  started('d', ['alpha'])
  const g = slowAgent('d')
  await sm.prompt('d', 'work')
  await g.in
  await sm.hostPrompt('d', 'loop message', 'd.1')
  humans.length = 0
  assert.deepEqual(sm.clearPending('d'), [], 'it was never typed, so it does not go back to the composer')
  assert.equal(sm.snapshot('d').pending, undefined)
  assert.deepEqual(humans, ['d:cancel'])
  await sm.hostPrompt('d', 'second', 'd.2')
  const id = sm.snapshot('d').pending[0].id
  humans.length = 0
  assert.equal(sm.cancelPending('d', id), undefined)
  assert.deepEqual(humans, ['d:cancel'])
  assert.equal(sm.cancelPending('d', 'p-none'), undefined)
  assert.equal(sm.clearPending('d').length, 0)
  assert.deepEqual(humans, ['d:cancel'], 'nothing withdrawn, nothing announced')
  g.out.open()
  await done('d', 1)
})

test('cancel announces a human act; a host-side cancel does not', () => {
  started('e', ['alpha'])
  humans.length = 0
  sm.cancel('e')
  sm.cancel('e', 'host')
  sm.cancel('nope')
  assert.deepEqual(humans, ['e:cancel'])
})

test('a container stop (reason user) and a deleted session reach a bus subscriber', () => {
  const seen = []
  const off1 = kernel.bus.on('session.deleted', (e) => seen.push(`deleted:${e.sessionId}`))
  const off2 = kernel.bus.on('container.status', (e) => seen.push(`${e.status}/${e.reason}:${e.sessionId}`))
  started('f', ['alpha'])
  // The scope pane’s stop is `containers.stop(id)` → `setStatus(…, 'user')`; its
  // docker teardown is out of reach here, so drive the emitter it ends in.
  kernel.containers['setStatus']('f', { ...sm.snapshot('f').info.container, status: 'stopped' }, 'user')
  sm.deleteSession('f')
  off1()
  off2()
  assert.deepEqual(seen, ['stopped/user:f', 'deleted:f'])
})

test('a host message never clears recovering; a typed one does', async () => {
  sm.restore([
    {
      info: { id: 'g', env: 'dev', role: 'executor', repos: ['alpha'], repoModes: { alpha: 'write' }, task: 't', workspace: 'w', title: 'g', agent: 'a1', state: 'started', mcp: [], startPrompt: 'x', reviewOf: LOOP_MARK },
      acpSessionId: 'acp-g',
      interrupted: true,
      log: []
    }
  ])
  const g = slowAgent('g')
  g.out.open()
  const live = () => sm['sessions'].get('g')
  assert.equal(live().recovering, true)
  await sm.hostPrompt('g', 'loop message', 'g.1')
  await tick(80)
  assert.equal(live().recovering, true, 'untouched')
  assert.deepEqual(g.texts, [], 'and it waits for the resume, as everything queued on a recovering session does')
  assert.equal(sm.snapshot('g').pending.length, 1)
  await sm.prompt('g', 'typed')
  assert.equal(live().recovering, false, 'a typed message is the user’s resume')
  await done('g', 1)
  assert.deepEqual(g.texts, ['typed'])
})

test('the delivery gate holds a typed message while the loop delivers', async () => {
  started('i', ['alpha'])
  const g = slowAgent('i')
  g.out.open()
  let delivering = true
  sm.setLoopHooks({ owns: () => false, delivering: (ws, task) => (delivering && ws === 'w' && task === 't' ? ['i'] : []) })
  await sm.prompt('i', 'typed during delivery')
  await tick(80)
  assert.deepEqual(g.texts, [], 'waits')
  assert.match(sm.snapshot('i').pendingBlocked ?? '', /review loop is delivering/)
  delivering = false
  sm.schedule()
  await done('i', 1)
  assert.deepEqual(g.texts, ['typed during delivery'], 'runs once the loop has ended')
  // Another scope is not gated.
  assert.equal(sm['deliveryActive']({ ref: { workspace: 'w', task: 'other' } }), false)
  sm.setLoopHooks(undefined)
})

test('without hooks a typed message is never gated', async () => {
  started('j', ['alpha'])
  const g = slowAgent('j')
  g.out.open()
  await sm.prompt('j', 'plain')
  await done('j', 1)
  assert.deepEqual(g.texts, ['plain'])
})

test('a loop’s own sessions stay out of the Resume modal and the update deferral', () => {
  sm.restore([
    {
      info: { id: 'k', env: 'dev', role: 'executor', repos: ['alpha'], repoModes: { alpha: 'write' }, task: 't', workspace: 'w', title: 'k', agent: 'a1', state: 'started', mcp: [], startPrompt: 'x' },
      interrupted: true,
      log: []
    }
  ])
  assert.ok(sm.interruptedSessions().some((x) => x.id === 'k'), 'listed by default')
  assert.equal(sm.hasUnfinishedWork(), true)
  sm.setLoopHooks({ owns: (id) => id === 'k', delivering: () => [] })
  assert.ok(!sm.interruptedSessions().some((x) => x.id === 'k'), 'left out once the loop owns it')
  sm.setLoopHooks({ owns: () => true, delivering: () => [] })
  assert.equal(sm.hasUnfinishedWork(), false, 'nothing of the loop’s defers an update')
  sm.setLoopHooks(undefined)
  assert.equal(sm.hasUnfinishedWork(), true)
})
