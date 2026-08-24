// Pure-logic test for the notifications subscriber (docs/requirements-notifications.md
// §7): drives `createNotifications` over a fake bus with synthetic domain events —
// no docker, no electron, no real sessions. Harness style of
// scripts/turn-contract.test.mjs.
//
//   node scripts/notifications.test.mjs
import { test, after } from 'node:test'
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-notifications-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await build({
  stdin: {
    contents: [
      `export { createNotifications } from ${S('src/main/notifications.ts')}`,
      `export { createBus } from ${S('src/main/bus.ts')}`,
      `export { NOTIFICATION_DEFAULTS, normalizeNotificationPrefs } from ${S('src/shared/notifications.ts')}`
    ].join('\n'),
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

const { createNotifications, createBus, NOTIFICATION_DEFAULTS, normalizeNotificationPrefs } =
  await import(pathToFileURL(outfile).href)

const ref = { workspace: 'ws', task: 'task', env: 'env' }
const sessionInfo = (id) => (id === 'gone' ? undefined : { title: `title-${id}` })

/** Fresh bus + subscriber pair, prefs defaulted unless overridden. */
function setup(prefs) {
  const bus = createBus()
  const notifications = createNotifications(
    bus,
    prefs ?? JSON.parse(JSON.stringify(NOTIFICATION_DEFAULTS)),
    sessionInfo
  )
  return { bus, notifications }
}

const allOn = () => {
  const p = JSON.parse(JSON.stringify(NOTIFICATION_DEFAULTS))
  for (const t of Object.keys(p)) p[t] = { inApp: true, external: false }
  return p
}

// --- §2 priority: error supersedes proposal and turn-ended -------------
test('§2 priority: error supersedes proposal and turn-ended', () => {
  const { bus, notifications } = setup(allOn())
  bus.emit('session.turn', { sessionId: 's1', ref, phase: 'started' })
  bus.emit('container.status', { sessionId: 's1', ref, status: 'error', reason: 'error' })
  bus.emit('session.proposal', { sessionId: 's1', ref, proposal: { outcome: 'changes' } })
  bus.emit('session.turn', { sessionId: 's1', ref, phase: 'ended', final: true })
  const types = notifications.list().map((n) => n.type)
  assert.deepEqual(types, ['error'], 'error suppresses both proposal and turn-ended for the same turn')
})

// --- §2 priority: proposal supersedes turn-ended ------------------------
test('§2 priority: proposal supersedes turn-ended', () => {
  const { bus, notifications } = setup(allOn())
  bus.emit('session.turn', { sessionId: 's1', ref, phase: 'started' })
  bus.emit('session.proposal', { sessionId: 's1', ref, proposal: { outcome: 'changes' } })
  bus.emit('session.turn', { sessionId: 's1', ref, phase: 'ended', final: true })
  const types = notifications.list().map((n) => n.type)
  assert.deepEqual(types, ['proposal'], 'proposal suppresses turn-ended for the same turn')
})

// --- turn-ended fires when nothing else claimed the turn ---------------
test('turn-ended fires when nothing else claimed the turn', () => {
  const { bus, notifications } = setup(allOn())
  bus.emit('session.turn', { sessionId: 's1', ref, phase: 'started' })
  bus.emit('session.turn', { sessionId: 's1', ref, phase: 'ended', final: true })
  assert.deepEqual(notifications.list().map((n) => n.type), ['turn-ended'])
})

// --- nudge boundary (final:false) must not fire turn-ended --------------
test('nudge boundary (final:false) must not fire turn-ended', () => {
  const { bus, notifications } = setup(allOn())
  bus.emit('session.turn', { sessionId: 's1', ref, phase: 'started' })
  bus.emit('session.turn', { sessionId: 's1', ref, phase: 'ended', final: false }) // nudge boundary
  bus.emit('session.turn', { sessionId: 's1', ref, phase: 'started' }) // the nudge turn itself
  bus.emit('session.turn', { sessionId: 's1', ref, phase: 'ended', final: true })
  const turnEnded = notifications.list().filter((n) => n.type === 'turn-ended')
  assert.equal(turnEnded.length, 1, 'exactly one turn-ended per user-visible turn, not per sendTurn call')
})

// --- awaiting: fires once per false->true edge, clears on false --------
test('awaiting: fires once per false->true edge, clears on false', () => {
  const { bus, notifications } = setup()
  bus.emit('session.awaiting', { sessionId: 's1', ref, awaiting: true })
  bus.emit('session.awaiting', { sessionId: 's1', ref, awaiting: true }) // replay, not a fresh edge
  assert.equal(notifications.list().filter((n) => n.type === 'awaiting').length, 1)
  const reads = []
  bus.on('notification.read', (e) => reads.push(e))
  bus.emit('session.awaiting', { sessionId: 's1', ref, awaiting: false })
  assert.equal(notifications.list()[0].read, true, 'stopping awaiting clears its own notification')
  assert.deepEqual(reads, [{ sessionId: 's1' }], 'clearing pushes notification.read for other windows')
  bus.emit('session.awaiting', { sessionId: 's1', ref, awaiting: true }) // a fresh edge fires again
  assert.equal(notifications.list().filter((n) => n.type === 'awaiting').length, 2)
})

// --- defaults merge / live pref swap ------------------------------------
test('defaults merge / live pref swap', () => {
  const prefs = JSON.parse(JSON.stringify(NOTIFICATION_DEFAULTS))
  prefs.proposal = { inApp: false, external: false }
  const { bus, notifications } = setup(prefs)
  bus.emit('session.proposal', { sessionId: 's1', ref, proposal: { outcome: 'changes' } })
  assert.equal(notifications.list().length, 0, 'pref off at construction — nothing recorded')
  notifications.setPrefs(allOn())
  bus.emit('session.proposal', { sessionId: 's1', ref, proposal: { outcome: 'changes' } })
  assert.equal(notifications.list().length, 1, 'live pref swap takes effect for the next event')
})

// --- adapterExited: expected and !wasLive both suppress error ----------
test('adapterExited: expected and !wasLive both suppress error', () => {
  const { bus, notifications } = setup(allOn())
  bus.emit('session.adapterExited', { sessionId: 's1', expected: true, wasLive: true })
  assert.equal(notifications.list().length, 0, 'a host-initiated detach is never an error')
  bus.emit('session.adapterExited', { sessionId: 's1', expected: false, wasLive: false })
  assert.equal(notifications.list().length, 0, 'an idle session dying is not "while running/waiting"')
  bus.emit('session.adapterExited', { sessionId: 's1', expected: false, wasLive: true })
  assert.equal(notifications.list().length, 1, 'unexpected exit while busy/awaiting is an error')
})

// --- a late complete() outside any turn must not poison the next turn --
test('a late complete() outside any turn must not poison the next turn', () => {
  const { bus, notifications } = setup(allOn())
  bus.emit('session.turn', { sessionId: 's1', ref, phase: 'started' })
  bus.emit('session.turn', { sessionId: 's1', ref, phase: 'ended', final: true }) // ends clean, no complete
  assert.equal(notifications.list().filter((n) => n.type === 'turn-ended').length, 1)
  // A benign late POST — no turn open right now.
  bus.emit('session.proposal', { sessionId: 's1', ref, proposal: { outcome: 'changes' } })
  assert.equal(
    notifications.list().filter((n) => n.type === 'proposal').length,
    1,
    'the late proposal is still surfaced'
  )
  // The next real turn must still get its own turn-ended — not suppressed
  // by the stale outcome marker the late proposal would have left behind.
  bus.emit('session.turn', { sessionId: 's1', ref, phase: 'started' })
  bus.emit('session.turn', { sessionId: 's1', ref, phase: 'ended', final: true })
  assert.equal(
    notifications.list().filter((n) => n.type === 'turn-ended').length,
    2,
    'a late complete from a previous turn must not suppress the next turn-ended'
  )
})

// --- session.deleted prunes ring entries and bookkeeping ----------------
test('session.deleted prunes ring entries and bookkeeping', () => {
  const { bus, notifications } = setup(allOn())
  bus.emit('session.awaiting', { sessionId: 's1', ref, awaiting: true })
  bus.emit('session.awaiting', { sessionId: 's2', ref, awaiting: true })
  assert.equal(notifications.list().length, 2)
  bus.emit('session.deleted', { sessionId: 's1' })
  const remaining = notifications.list()
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0].sessionId, 's2')
  // Bookkeeping forgotten too: the same session can raise a fresh awaiting
  // notification immediately (no lingering awaitingOpen guard).
  bus.emit('session.awaiting', { sessionId: 's1', ref, awaiting: true })
  assert.equal(notifications.list().filter((n) => n.sessionId === 's1').length, 1)
})

// --- dismiss removes the record (distinct from markRead) ---------------
test('dismiss removes the record (distinct from markRead)', () => {
  const { bus, notifications } = setup(allOn())
  bus.emit('session.awaiting', { sessionId: 's1', ref, awaiting: true })
  const [rec] = notifications.list()
  notifications.dismiss(rec.id)
  assert.equal(notifications.list().length, 0)
})

// --- normalizeNotificationPrefs: untrusted input never crashes/corrupts -
test('normalizeNotificationPrefs: untrusted input never crashes/corrupts', () => {
  const garbage = normalizeNotificationPrefs({ bogus: 'nope' })
  assert.deepEqual(garbage, NOTIFICATION_DEFAULTS, 'garbage input falls back to defaults per type')
  const partial = normalizeNotificationPrefs({ awaiting: { inApp: false } })
  assert.equal(partial.awaiting.inApp, false)
  assert.equal(partial.awaiting.external, NOTIFICATION_DEFAULTS.awaiting.external, 'missing field falls back to default, not false')
  assert.deepEqual(partial.proposal, NOTIFICATION_DEFAULTS.proposal)
  const nonsense = normalizeNotificationPrefs(null)
  assert.deepEqual(nonsense, NOTIFICATION_DEFAULTS)
  for (const type of Object.keys(NOTIFICATION_DEFAULTS)) {
    const v = normalizeNotificationPrefs({ [type]: { inApp: 'yes', external: 1 } })[type]
    assert.equal(typeof v.inApp, 'boolean')
    assert.equal(typeof v.external, 'boolean')
  }
  // A custom fallback (the currently-persisted prefs) is preferred over the
  // hardcoded defaults for anything the payload doesn't supply — a garbage
  // write must not silently discard a prior legitimate toggle.
  const persisted = JSON.parse(JSON.stringify(NOTIFICATION_DEFAULTS))
  persisted['turn-ended'] = { inApp: true, external: false }
  const recovered = normalizeNotificationPrefs({ bogus: 'nope' }, persisted)
  assert.deepEqual(recovered, persisted, 'garbage payload recovers to the prior persisted state, not hardcoded defaults')
})

after(async () => {
  await import('node:fs').then((fs) => fs.promises.rm(outfile, { force: true }))
})
