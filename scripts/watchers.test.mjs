// Watchers (docs/requirements-watchers.md), phase 1, without docker or an
// agent: the pure rules (§2.1, §3, §5.2, §7), the scope and its guards (§2, §4),
// the tools over the manager's hooks (§4.1), the timed automatic prompt (§5) —
// a wake falls due through the scheduler pass and is queued only when it could
// be sent now, one final wake at the cap or the deadline — Pause / Stop /
// Re-arm (§3), and the boot sort by origin (§10).
//
// A watcher's session is staged as `started` through the session manager's own
// map, and its drain is replaced by a recorder, so nothing ever runs: the
// assertions are about what the scheduler queues and what the state becomes.
//
//   node scripts/watchers.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-watchers-'))
process.env.GURT_ROOT = GURT_ROOT
const outfile = path.join(os.tmpdir(), `gurt-watchers-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await bundle({
  stdin: {
    contents:
      `export { createKernel } from ${S('src/main/kernel.ts')}\n` +
      `export * from ${S('src/shared/watchers.ts')}\n` +
      `export { nudgePromptFor, contractToolFor, postTurnDecision } from ${S('src/main/sessions.ts')}\n` +
      `export { buildGurtHttpServer, instructionsFor } from ${S('src/main/mcp/gurtServer.ts')}\n` +
      `export { roleForcesRead, roleNeedsRepo, roleHasTurnContract, USER_SESSION_ROLES, repoMode } from ${S('src/shared/types.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})
const m = await import(pathToFileURL(outfile).href)

after(() => {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

const MIN = 60_000

// --- the kernel (before any test: the file's own `after` removes the root) ------
const ws = 'w'
fs.mkdirSync(path.join(GURT_ROOT, ws), { recursive: true })
fs.writeFileSync(
  path.join(GURT_ROOT, ws, 'workspace.json'),
  JSON.stringify({
    repos: [{ name: 'alpha', url: 'https://github.com/o/alpha.git' }],
    envs: [{ name: 'dev', image: 'x', repo: 'alpha' }]
  })
)
fs.writeFileSync(path.join(GURT_ROOT, ws, 'agents.json'), JSON.stringify({}))

const kernel = m.createKernel()
await kernel.ready
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
const events = []
kernel.bus.on('watcher.notify', (e) => events.push(e))


// --- the pure rules ------------------------------------------------------------
test('sanitizeWatcherConfig: bounds, unknown keys, min ≤ max', () => {
  const c = m.sanitizeWatcherConfig({ maxWakeups: 9999, maxHours: 0, minDelayMinutes: 30, maxDelayMinutes: 10, bogus: 1 })
  assert.equal(c.maxWakeups, 500)
  assert.equal(c.maxHours, 0.25)
  assert.ok(c.minDelayMinutes <= c.maxDelayMinutes, 'min never passes max')
  assert.ok(!('bogus' in c), 'unknown keys are dropped')
  assert.deepEqual(m.sanitizeWatcherConfig({}), m.WATCHER_DEFAULTS)
  assert.equal(m.sanitizeWatcherConfig({ wakeups: 'x', maxWakeups: 'y' }).maxWakeups, 50, 'garbage keeps the fallback')
  assert.equal(m.sanitizeWatcherConfig({ minDelayMinutes: 300 }).maxDelayMinutes >= 5, true)
})

test('wakeAtFor: clamped to the minimum, the maximum and the deadline — and says so', () => {
  const cfg = { minDelayMinutes: 2, maxDelayMinutes: 240 }
  const now = Date.parse('2026-01-01T10:00:00Z')
  const far = new Date(now + 10 * 3_600_000).toISOString()
  const ok = m.wakeAtFor(10, cfg, far, now)
  assert.equal(Date.parse(ok.at), now + 10 * MIN)
  assert.equal(ok.clamped, false)
  const low = m.wakeAtFor(0.5, cfg, far, now)
  assert.equal(Date.parse(low.at), now + 2 * MIN)
  assert.match(low.text, /clamped to 2 min \(this watcher's minimum\)/)
  const high = m.wakeAtFor(1000, cfg, far, now)
  assert.equal(Date.parse(high.at), now + 240 * MIN)
  assert.match(high.text, /maximum/)
  const dl = new Date(now + 5 * MIN).toISOString()
  const capped = m.wakeAtFor(60, cfg, dl, now)
  assert.equal(capped.at, dl, 'never past the deadline')
  assert.match(capped.text, /the deadline/)
})

test('wakeText: on time, late (restart / hold), the last wakeup', () => {
  const now = Date.parse('2026-01-01T14:31:00')
  const wake = { at: new Date(Date.parse('2026-01-01T14:30:00')).toISOString(), setAt: new Date(Date.parse('2026-01-01T14:05:00')).toISOString(), note: 'check #412' }
  const base = { wake, wakeups: 7, maxWakeups: 50, deadlineAt: new Date(Date.parse('2026-01-01T18:00:00')).toISOString(), now }
  const t = m.wakeText(base)
  assert.match(t, /Wakeup 8\/50/)
  assert.match(t, /check #412/)
  assert.match(t, /Deadline 18:00/)
  assert.doesNotMatch(t, /late/, 'a minute is on time')
  assert.match(m.wakeText({ ...base, now: now + 90 * MIN, late: 'restart' }), /late: Gurt was not running/)
  assert.match(m.wakeText({ ...base, now: now + 90 * MIN, late: { hold: '16:00' } }), /late: waited for the plan limit reset \(16:00\)/)
  assert.match(m.wakeText({ ...base, wakeups: 49 }), /This is your last wakeup: report and call `finish_watch`/)
  const tomorrow = Date.parse('2026-01-02T09:00:00')
  assert.match(m.clockText(new Date(tomorrow).toISOString(), now), /2026-01-02 09:00/, 'a date when not today')
})

test('wakeTaken: a plain wake and the last one count, the deadline does not', () => {
  const st = { startedAt: 'a', deadlineAt: 'b', wakeups: 49 }
  assert.deepEqual(m.wakeTaken(st, { wake: 'x' }), { ...st, wakeups: 50 })
  assert.deepEqual(m.wakeTaken(st, { wake: 'x', final: 'max-wakeups' }), { ...st, wakeups: 50, final: 'max-wakeups' })
  const after50 = m.wakeTaken({ ...st, wakeups: 50, final: 'max-wakeups' }, { wake: 'y', final: 'deadline' })
  assert.equal(after50.wakeups, 50, 'the counter shows 50/50, never 51/50')
  assert.equal(after50.final, 'deadline')
})

test('watcherTurnSatisfied: wakeup, finish, the deadline; never after `final`', () => {
  const now = Date.now()
  const live = { startedAt: 'a', deadlineAt: new Date(now + 60 * MIN).toISOString(), wakeups: 1 }
  const wake = { at: 'x', note: 'n', setAt: 'y' }
  assert.equal(m.watcherTurnSatisfied({ watcher: live }, now), false, 'nothing scheduled')
  assert.equal(m.watcherTurnSatisfied({ watcher: live, wake }, now), true, 'a pending wakeup')
  assert.equal(m.watcherTurnSatisfied({ watcher: { ...live, end: { outcome: 'success', summary: 's', at: 'a', by: 'agent' } } }, now), true, 'finish_watch')
  assert.equal(m.watcherTurnSatisfied({ watcher: { ...live, deadlineAt: new Date(now - 1).toISOString() } }, now), true, 'a deadline due satisfies it; the final wake follows')
  assert.equal(m.watcherTurnSatisfied({ watcher: { ...live, final: 'deadline' }, wake }, now), false, 'after the final wake only finish_watch')
  assert.equal(m.watcherTurnSatisfied({}, now), true, 'no watcher state: no contract')
})

test('watcherStatus: every row, in order — a paused watcher reads "paused", not "sleeping"', () => {
  const now = Date.now()
  const st = { startedAt: 'a', deadlineAt: new Date(now + 60 * MIN).toISOString(), wakeups: 0 }
  const wake = { at: new Date(now + 5 * MIN).toISOString(), note: 'n', setAt: 'y' }
  const base = { state: 'started', busy: false, recovering: false, incomplete: false, wakeups: true, watcher: st }
  const s = (o) => m.watcherStatus({ ...base, ...o }, now).status
  assert.equal(s({ error: 'boom' }), 'failed')
  assert.equal(s({ watcher: { ...st, attention: { level: 'error', text: 't', at: 'a' } }, busy: true }), 'attention')
  assert.equal(s({ incomplete: true }), 'attention')
  assert.equal(s({ busy: true }), 'working')
  assert.equal(s({ recovering: true }), 'recovering')
  assert.equal(s({ wakeups: false, wake }), 'paused')
  assert.equal(s({ held: 'waits for the limit reset', wake }), 'waiting')
  assert.equal(s({ wake }), 'sleeping')
  assert.equal(s({}), 'idle')
  assert.equal(s({ watcher: { ...st, end: { outcome: 'failure', summary: 's', at: 'a', by: 'agent' } } }), 'finished')
  assert.equal(s({ state: 'draft', watcher: undefined }), 'draft')
})

test('wakeRefusal: finished, final, no wakeups left, deadline passed', () => {
  const now = Date.now()
  const st = { startedAt: 'a', deadlineAt: new Date(now + 60 * MIN).toISOString(), wakeups: 1 }
  const cfg = { maxWakeups: 5 }
  assert.equal(m.wakeRefusal(st, cfg, now), undefined)
  assert.match(m.wakeRefusal({ ...st, end: { outcome: 'success', summary: 's', at: 'a', by: 'agent' } }, cfg, now).text, /Re-arm/)
  assert.match(m.wakeRefusal({ ...st, final: 'max-wakeups' }, cfg, now).text, /only finish_watch is left/)
  assert.match(m.wakeRefusal({ ...st, wakeups: 5 }, cfg, now).text, /no wakeups are left/)
  const late = m.wakeRefusal({ ...st, deadlineAt: new Date(now - 1).toISOString() }, cfg, now)
  assert.equal(late.kind, 'deadline', 'not an error: the final wake follows')
})

test('the contract and the role table', () => {
  assert.equal(m.contractToolFor('watcher'), 'wake_me / watch / finish_watch')
  assert.match(m.nudgePromptFor('watcher'), /`wake_me`/)
  assert.doesNotMatch(m.nudgePromptFor('watcher', true), /wake_me/, 'the final nudge does not offer wake_me')
  assert.match(m.nudgePromptFor('watcher', true), /finish_watch/)
  assert.equal(m.roleForcesRead('watcher'), true)
  assert.equal(m.roleHasTurnContract('watcher'), true)
  assert.equal(m.roleNeedsRepo('watcher'), false)
  assert.ok(!m.USER_SESSION_ROLES.includes('watcher'), 'never offered as an ordinary role')
  assert.match(m.instructionsFor('watcher'), /WATCHER/)
})

/** A watcher staged as started; its drain only records what it was asked to run. */
async function stage(name, patch = {}) {
  await kernel.watchers.create(ws, name)
  const id = kernel.sessions.listForTask(ws, name)[0].id
  const live = kernel.sessions['sessions'].get(id)
  live.info.state = 'started'
  const now = Date.now()
  live.info.watcher = {
    startedAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + 8 * 3_600_000).toISOString(),
    wakeups: 0,
    ...patch
  }
  return { id, live, name }
}
const info = (id) => kernel.sessions.sessionInfo(id)
// Nothing runs: the drain is replaced by a recorder.
kernel.sessions['drainPending'] = async () => {}

test('a watcher is a scope of its own: listed under watchers, one session, read-only', async () => {
  await kernel.watchers.create(ws, 'rel')
  const tree = await kernel.tree()
  const w = tree.workspaces[0]
  assert.deepEqual(w.watchers.map((x) => x.name), ['rel'])
  assert.ok(!w.tasks.some((t) => t.name === 'rel'), 'not among the scopes')
  assert.ok(!w.proactive.some((t) => t.name === 'rel'), 'nor under proactive')
  const sessions = kernel.sessions.listForTask(ws, 'rel')
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].role, 'watcher')
  assert.equal(sessions[0].autoAllow, true, 'auto-allow on: an unattended turn stuck on a permission watches nothing')
  assert.equal(w.watchers[0].sessionId, sessions[0].id)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(GURT_ROOT, ws, 'rel', 'task.json'), 'utf8')).watcher, m.WATCHER_DEFAULTS)
  assert.equal(m.repoMode({ role: 'watcher', repos: ['alpha'], repoModes: { alpha: 'write' } }, 'alpha'), 'read')
})

test('only the watcher manager creates a watcher, and it holds the only session', async () => {
  const id = kernel.sessions.listForTask(ws, 'rel')[0].id
  await assert.rejects(() => kernel.editDraft(id, { role: 'executor' }), /keeps its role/)
  const other = kernel.sessions.createSession({ workspace: ws, task: 'rel', env: 'dev' }, ['alpha'], 'a1', 'x', 'none', [], true, {}, 'researcher')
  await assert.rejects(() => kernel.editDraft(other.id, { role: 'watcher' }), /only by the Watchers mode/)
  kernel.sessions.deleteSession(other.id)
  assert.throws(() => kernel.sessions.duplicateSession(id), /only the Watchers mode creates one/)
  assert.ok(kernel.watchers.isWatcher(ws, 'rel'))
  assert.ok(!kernel.watchers.isWatcher(ws, 'nope'))
})

test('settings: bounded, and a cap cannot be set where no final wake would come', async () => {
  const { id } = await stage('caps', { wakeups: 7 })
  await kernel.watchers.update(ws, 'caps', { maxWakeups: 3, minDelayMinutes: 5 })
  assert.equal(kernel.watchers.views(ws).find((v) => v.name === 'caps').config.maxWakeups, 8, 'at least wakeups + 1')
  await kernel.watchers.update(ws, 'caps', { maxWakeups: 9999 })
  assert.equal(kernel.watchers.views(ws).find((v) => v.name === 'caps').config.maxWakeups, 500)
  // An edit clears only the `final` its own cap caused.
  kernel.sessions['sessions'].get(id).info.watcher = { ...info(id).watcher, wakeups: 8, final: 'max-wakeups' }
  await kernel.watchers.update(ws, 'caps', { maxWakeups: 20 })
  assert.equal(info(id).watcher.final, undefined, 'raising maxWakeups clears the max-wakeups final')
  kernel.sessions['sessions'].get(id).info.watcher = { ...info(id).watcher, final: 'deadline' }
  await kernel.watchers.update(ws, 'caps', { maxWakeups: 30 })
  assert.equal(info(id).watcher.final, 'deadline', 'but not the deadline\'s')
})

// --- the tools -------------------------------------------------------------------
test('the tools: wake_me clamps and replaces; notify_user once per turn; finish_watch ends', async () => {
  const { id } = await stage('tools')
  const hooks = kernel.watchers.hooksFor(ws, 'tools', id)
  const a = await hooks.wakeMe({ in_minutes: 0.1, note: 'first' })
  assert.equal(a.scheduled, true)
  assert.match(a.note, /clamped to 2 min/, 'clamping answers with a result, not an error')
  assert.equal(info(id).wake.note, 'first')
  const b = await hooks.wakeMe({ in_minutes: 10, note: 'second' })
  assert.equal(b.replaced.note, 'first', 'a new wake_me replaces the old one')
  assert.equal(info(id).wake.note, 'second')
  assert.equal((await hooks.cancelWakeup()).cancelled, true)
  assert.equal(info(id).wake, undefined)

  events.length = 0
  await hooks.notifyUser({ text: 'tests failed', level: 'error' })
  await assert.rejects(() => hooks.notifyUser({ text: 'again', level: 'info' }), /already notified this turn/)
  assert.equal(events.length, 1)
  assert.equal(events[0].level, 'error')
  assert.equal(info(id).watcher.attention.level, 'error', 'error sets "needs attention"')
  kernel.bus.emit('session.turn', { sessionId: id, ref: { workspace: ws, task: 'tools', env: 'dev' }, phase: 'started' })
  await hooks.notifyUser({ text: 'info', level: 'info' })
  assert.equal(info(id).watcher.attention.text, 'tests failed', 'info does not set attention')

  events.length = 0
  kernel.bus.emit('session.turn', { sessionId: id, ref: { workspace: ws, task: 'tools', env: 'dev' }, phase: 'started' })
  await hooks.wakeMe({ in_minutes: 5, note: 'x' })
  await hooks.finishWatch({ summary: 'green', outcome: 'success' })
  assert.equal(info(id).watcher.end.outcome, 'success')
  assert.equal(info(id).watcher.end.by, 'agent')
  assert.equal(info(id).wake, undefined, 'finish drops the wakeup')
  assert.equal(events.at(-1).reason, 'finish')
  assert.equal(events.at(-1).level, 'info')
  for (const call of [() => hooks.wakeMe({ in_minutes: 5, note: 'x' }), () => hooks.cancelWakeup(), () => hooks.notifyUser({ text: 'x', level: 'info' }), () => hooks.finishWatch({ summary: 's', outcome: 'failure' })])
    await assert.rejects(call, /has finished — the user can Re-arm it/, 'a finished watcher: no tool works, the agent cannot re-arm')
})

test('wake_me after the deadline in a running turn is a non-error and schedules nothing', async () => {
  const { id } = await stage('late', { deadlineAt: new Date(Date.now() - 1000).toISOString() })
  const r = await kernel.watchers.hooksFor(ws, 'late', id).wakeMe({ in_minutes: 5, note: 'x' })
  assert.equal(r.scheduled, false)
  assert.match(r.note, /final wake follows/)
  assert.equal(info(id).wake, undefined)
})

test('the role\'s tool set over real HTTP: five tools, no complete, no create_session', async () => {
  const calls = []
  const hooks = {
    role: 'watcher',
    onComplete() {}, onSubmitReview() {}, onCreateSession: async () => ({}),
    watcher: {
      wakeMe: async (a) => (calls.push(['wake_me', a]), { ok: true }),
      cancelWakeup: async () => ({}),
      watch: async (a) => (calls.push(['watch', a]), { ok: true }),
      notifyUser: async () => ({}),
      finishWatch: async () => ({})
    }
  }
  const server = m.buildGurtHttpServer('tok', hooks)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/mcp/tok`
  const rpc = async (method, params, id = 1) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
    })
    const text = await res.text()
    const line = text.split('\n').find((l) => l.startsWith('data:')) ?? text
    return JSON.parse(line.replace(/^data:\s*/, ''))
  }
  try {
    const list = await rpc('tools/list', {})
    assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ['cancel_wakeup', 'finish_watch', 'notify_user', 'wake_me', 'watch'])
    const bad = await rpc('tools/call', { name: 'wake_me', arguments: { in_minutes: 5, note: 'n', extra: 1 } }, 2)
    assert.ok(bad.error || bad.result?.isError, 'strict schemas: unknown keys are rejected')
    const ok = await rpc('tools/call', { name: 'wake_me', arguments: { in_minutes: 5, note: 'n' } }, 3)
    assert.ok(!ok.result.isError)
    assert.deepEqual(calls, [['wake_me', { in_minutes: 5, note: 'n' }]])
  } finally {
    server.close()
    server.closeAllConnections()
  }
})

// --- the timed automatic prompt --------------------------------------------------
const queued = (id) => kernel.sessions['sessions'].get(id).pending

test('a due wakeup is queued once, with wake cleared in the same step; the counter moves only when it is taken', async () => {
  const { id, live } = await stage('due')
  live.info.wake = { at: new Date(Date.now() - 2 * MIN).toISOString(), setAt: new Date(Date.now() - 12 * MIN).toISOString(), note: 'look at #412' }
  kernel.sessions.schedule()
  await tick()
  assert.equal(queued(id).length, 1)
  assert.equal(info(id).wake, undefined)
  assert.equal(info(id).watcher.wakeups, 0, 'counted when the drain takes it, not when it is queued')
  assert.match(queued(id)[0].text, /Wakeup 1\/50.*look at #412/s)
  assert.equal(queued(id)[0].auto, true)
  assert.equal(queued(id)[0].origin.wake, live.pending[0].origin.wake)
  kernel.sessions.schedule()
  assert.equal(queued(id).length, 1, 'never queued twice')
})

test('a due wake waits while a turn runs, while recovering, while paused — and goes at the next pass', async () => {
  const { id, live } = await stage('held')
  const due = () => { live.info.wake = { at: new Date(Date.now() - MIN).toISOString(), setAt: new Date().toISOString(), note: 'n' } }
  due(); live.busy = true
  kernel.sessions.schedule()
  assert.equal(queued(id).length, 0, 'a turn is running')
  assert.ok(info(id).wake, 'it stays in `wake`')
  live.busy = false; live.recovering = true
  kernel.sessions.schedule()
  assert.equal(queued(id).length, 0, 'recovering: waits for the checklist')
  live.recovering = false
  await kernel.watchers.update(ws, 'held', { wakeups: false })
  kernel.sessions.schedule()
  assert.equal(queued(id).length, 0, 'paused: no unattended turn')
  await kernel.watchers.update(ws, 'held', { wakeups: true })
  assert.equal(queued(id).length, 1, 'Resume sends an overdue wakeup, once')
  assert.match(queued(id)[0].text, /Wakeup 1/)
})

test('a typed message behind the queue holds the wake back', async () => {
  const { id, live } = await stage('typed')
  live.pending.push({ id: 'pt', text: 'how far are the tests?' })
  live.info.wake = { at: new Date(Date.now() - MIN).toISOString(), setAt: new Date().toISOString(), note: 'n' }
  kernel.sessions.schedule()
  assert.equal(queued(id).length, 1, 'only the typed message')
  assert.ok(info(id).wake)
})

test('a typed message leaves a not-due wakeup alone, replaces a queued wake (uncounted) and carries its note', async () => {
  const { id, live } = await stage('typed2')
  live.info.wake = { at: new Date(Date.now() + 30 * MIN).toISOString(), setAt: new Date().toISOString(), note: 'check the env build' }
  await kernel.sessions.prompt(id, 'how far are the tests?')
  assert.ok(info(id).wake, 'the pending wakeup stays')
  assert.match(live.preface, /still pending: "check the env build"/)
  live.preface = undefined
  live.pending = []
  // a queued wake, replaced by the typed message
  live.info.wake = undefined
  live.pending.push({ id: 'pw', text: 'wake', auto: true, origin: { wake: 'S', at: new Date(Date.now() - MIN).toISOString(), note: 'queued note' } })
  await kernel.sessions.prompt(id, 'question')
  assert.deepEqual(queued(id).map((p) => p.text), ['question'])
  assert.equal(info(id).watcher.wakeups, 0, 'a dropped wake is not counted')
  assert.equal(info(id).wake.note, 'queued note', 'it goes back to `wake`: still pending')
  assert.match(live.preface, /queued note/)
  // a final wake is never replaced
  live.pending = [{ id: 'pf', text: 'final', auto: true, origin: { wake: 'D', final: 'deadline' } }]
  await kernel.sessions.prompt(id, 'another')
  assert.deepEqual(queued(id).map((p) => p.text), ['final', 'another'], 'the final wake runs first')
})

test('the last allowed wakeup is the final wake; the deadline\'s is uncounted and queued once, winning over a wakeup', async () => {
  const { id, live } = await stage('caps2', { wakeups: 49 })
  live.info.wake = { at: new Date(Date.now() - MIN).toISOString(), setAt: new Date().toISOString(), note: 'n' }
  kernel.sessions.schedule()
  assert.equal(queued(id)[0].origin.final, 'max-wakeups')
  assert.match(queued(id)[0].text, /last wakeup/)

  const d = await stage('deadline', { deadlineAt: new Date(Date.now() - MIN).toISOString() })
  d.live.info.wake = { at: new Date(Date.now() - MIN).toISOString(), setAt: new Date().toISOString(), note: 'n' }
  kernel.sessions.schedule()
  kernel.sessions.schedule()
  assert.equal(queued(d.id).length, 1, 'a deadline and a wakeup due in one pass yield one final wake')
  assert.equal(queued(d.id)[0].origin.final, 'deadline')
  assert.match(queued(d.id)[0].text, /The deadline .* has come/)
  assert.equal(info(d.id).wake, undefined, 'the wakeup is dropped')
})

test('the deadline fires from the timer alone, with nothing pending', async () => {
  const { id, live } = await stage('dl', { deadlineAt: new Date(Date.now() + 1_500).toISOString() })
  kernel.sessions.schedule()
  assert.ok(kernel.sessions['limitTimer'], 'a timer is armed for the deadline with nothing pending')
  assert.equal(queued(id).length, 0)
  await tick(3_000) // the timer's own one-second slack included
  assert.equal(queued(id).length, 1, 'the final wake came on time')
  assert.equal(queued(id)[0].origin.final, 'deadline')
  void live
})

test('the timer never spins on a held item: due-but-held instants are not handed to it', async () => {
  const { id, live } = await stage('spin')
  live.info.wake = { at: new Date(Date.now() - MIN).toISOString(), setAt: new Date().toISOString(), note: 'n' }
  live.busy = true
  let passes = 0
  const orig = kernel.sessions['scheduleSync'].bind(kernel.sessions)
  kernel.sessions['scheduleSync'] = () => { passes++; orig() }
  kernel.sessions.schedule()
  const armed = kernel.sessions['limitTimer']
  // The only instant left is the (far) deadline: the timer sleeps long, not 1 s.
  assert.ok(armed, 'the deadline keeps one timer')
  await tick(1_500)
  assert.ok(passes <= 2, `no one-second spin while held (passes: ${passes})`)
  kernel.sessions['scheduleSync'] = orig
  live.busy = false
  void id
})

test('Esc and Cancel withdraw the wakeup; at the end they end the watcher as stopped', async () => {
  const { id, live } = await stage('esc')
  live.info.wake = { at: new Date(Date.now() + 30 * MIN).toISOString(), setAt: new Date().toISOString(), note: 'n' }
  kernel.sessions.clearPending(id)
  assert.equal(info(id).wake, undefined, 'Esc on a sleeping watcher acts as Cancel, with an empty queue')
  assert.equal(info(id).watcher.end, undefined)

  live.info.wake = { at: new Date(Date.now() + 30 * MIN).toISOString(), setAt: new Date().toISOString(), note: 'n' }
  kernel.sessions.cancelWake(id)
  assert.equal(info(id).wake, undefined)

  live.info.watcher = { ...info(id).watcher, final: 'deadline' }
  kernel.sessions.clearPending(id)
  assert.equal(info(id).watcher.end.outcome, 'stopped', 'withdrawing the last report ends it')
  assert.equal(info(id).watcher.end.by, 'user')
})

test('Wake now: due this instant, gated like any wake; not while paused or after final', async () => {
  const { id, live } = await stage('now')
  kernel.sessions.wakeNow(id)
  assert.equal(queued(id).length, 1, 'with no wakeup pending it wakes with "(woken by you)"')
  assert.match(queued(id)[0].text, /woken by you/)
  live.pending = []
  await kernel.watchers.update(ws, 'now', { wakeups: false })
  assert.throws(() => kernel.sessions.wakeNow(id), /paused/)
  await kernel.watchers.update(ws, 'now', { wakeups: true })
  live.pending = []
  live.info.watcher = { ...info(id).watcher, final: 'deadline' }
  assert.throws(() => kernel.sessions.wakeNow(id), /only finish_watch/)
})

test('Pause puts a queued wake back (uncounted), drops a deadline wake and holds a wake-origin continue', async () => {
  const { id, live } = await stage('pause')
  live.pending = [
    { id: 'a', text: 'w', auto: true, origin: { wake: 'S', at: new Date(Date.now() - MIN).toISOString(), note: 'kept note' } },
    { id: 'b', text: 'd', auto: true, origin: { wake: 'D', final: 'deadline' } },
    { id: 'c', text: 'continue', auto: true, origin: { limit: true, of: 'wake' } }
  ]
  await kernel.watchers.update(ws, 'pause', { wakeups: false })
  assert.deepEqual(queued(id).map((p) => p.id), ['c'])
  assert.equal(info(id).wake.note, 'kept note')
  assert.equal(info(id).watcher.wakeups, 0)
})

test('Stop ends the watcher, drops everything; Re-arm needs a future deadline and wakeups left', async () => {
  const { id, live } = await stage('stop')
  live.info.wake = { at: new Date(Date.now() + 30 * MIN).toISOString(), setAt: new Date().toISOString(), note: 'n' }
  live.pending = [{ id: 'x', text: 'w', auto: true, origin: { wake: 'S' } }]
  await kernel.watchers.stop(ws, 'stop')
  assert.equal(info(id).watcher.end.outcome, 'stopped')
  assert.equal(info(id).watcher.end.by, 'user')
  assert.equal(info(id).wake, undefined)
  assert.equal(queued(id).length, 0)
  await assert.rejects(() => kernel.watchers.stop(ws, 'stop'), /not active/)
  // the agent cannot restore it; the user's Re-arm does
  await assert.rejects(() => kernel.watchers.hooksFor(ws, 'stop', id).wakeMe({ in_minutes: 5, note: 'n' }), /Re-arm/)
  live.info.watcher = { ...info(id).watcher, deadlineAt: new Date(Date.now() - MIN).toISOString(), wakeups: 50 }
  await assert.rejects(() => kernel.watchers.rearm(ws, 'stop'), /no wakeups are left/)
  await assert.rejects(() => kernel.watchers.rearm(ws, 'stop', { maxWakeups: 60 }), /deadline has passed/)
  await kernel.watchers.rearm(ws, 'stop', { maxWakeups: 60, maxHours: 2 })
  assert.equal(info(id).watcher.end, undefined)
  assert.equal(kernel.watchers.views(ws).find((v) => v.name === 'stop').config.wakeups, true)
  assert.equal(info(id).watcher.wakeups, 50, 'the counter keeps counting')
  assert.ok(Date.parse(info(id).watcher.deadlineAt) > Date.now())
  const r = await kernel.watchers.hooksFor(ws, 'stop', id).wakeMe({ in_minutes: 5, note: 'n' })
  assert.equal(r.scheduled, true, 'after Re-arm the tools work again')
})

// --- the turn's end ---------------------------------------------------------------
test('post-turn: a watcher turn is satisfied by its state; a finished watcher is never nudged', async () => {
  const { live } = await stage('contract')
  const decide = (isNudge = false) => kernel.sessions['decideTurn'](live, { stopReason: 'end_turn', threw: false }, isNudge)
  assert.equal(decide(), 'nudge', 'nothing scheduled → one nudge')
  assert.equal(decide(true), 'incomplete', 'the nudge turn with nothing → incomplete')
  live.info.wake = { at: new Date(Date.now() + MIN).toISOString(), setAt: 'x', note: 'n' }
  assert.equal(decide(), 'none', 'a standing wakeup satisfies a typed turn')
  live.info.wake = undefined
  live.info.watcher = { ...live.info.watcher, final: 'deadline' }
  live.info.wake = { at: new Date(Date.now() + MIN).toISOString(), setAt: 'x', note: 'n' }
  assert.equal(decide(), 'nudge', 'after the final wake only finish_watch satisfies')
  live.info.watcher = { ...live.info.watcher, end: { outcome: 'success', summary: 's', at: 'a', by: 'agent' } }
  live.info.wake = undefined
  assert.equal(decide(), 'none', 'a finished watcher has no contract')
})

test('the nudge turn with nothing: attention + one notification; after the final wake the host ends it expired', async () => {
  const a = await stage('blind')
  events.length = 0
  kernel.sessions['onWatcherIncomplete'](a.live)
  assert.equal(info(a.id).watcher.attention.level, 'warning')
  assert.equal(events.at(-1).reason, 'blind')
  const b = await stage('expired', { final: 'deadline' })
  kernel.sessions['push'](b.live, { kind: 'agent', text: 'the tests are still running' })
  events.length = 0
  kernel.sessions['onWatcherIncomplete'](b.live)
  assert.equal(info(b.id).watcher.end.outcome, 'expired')
  assert.equal(info(b.id).watcher.end.by, 'host')
  assert.match(info(b.id).watcher.end.summary, /still running/)
  assert.equal(events.at(-1).reason, 'expired')
})

test('a failed wake turn: one retry wake at the minimum delay, then attention; after final → expired', async () => {
  const a = await stage('failing')
  a.live.wakeNote = 'look again'
  kernel.sessions['onWakeFailed'](a.live, 'stopped: max_tokens')
  assert.match(info(a.id).wake.note, /retrying after a failed turn: stopped: max_tokens\) look again/)
  const wait = Date.parse(info(a.id).wake.at) - Date.now()
  assert.ok(wait > 1.5 * MIN && wait <= 2 * MIN + 1000, 'at minDelayMinutes')
  events.length = 0
  kernel.sessions['onWakeFailed'](a.live, 'the turn failed')
  assert.equal(info(a.id).watcher.attention.level, 'error')
  assert.equal(events.at(-1).reason, 'blind')
  const b = await stage('failing-final', { final: 'max-wakeups' })
  kernel.sessions['onWakeFailed'](b.live, 'the turn failed')
  assert.equal(info(b.id).watcher.end.outcome, 'expired')
})

test('opening a watcher clears its attention', async () => {
  const { id } = await stage('seen', { attention: { level: 'error', text: 'x', at: 'a' } })
  kernel.watchers.seen(id)
  assert.equal(info(id).watcher.attention, undefined)
})

test('update deferral: a sleeping watcher does not defer an update, a running turn does; the scope is pending work', async () => {
  const { live } = await stage('defer')
  const others = () => [...kernel.sessions['sessions'].values()].filter((s) => s !== live)
  const saved = others().map((s) => [s, s.info.watcher])
  // The sessions earlier tests staged carry queues and flags of their own.
  for (const s of others()) Object.assign(s, { pending: [], busy: false, draining: false, promptRunning: false, recovering: false })
  // only this watcher counts: end the others for the check
  for (const s of others()) if (s.info.watcher) s.info.watcher = { ...s.info.watcher, end: { outcome: 'stopped', summary: '', at: 'a', by: 'user' } }
  live.info.wake = { at: new Date(Date.now() + 30 * MIN).toISOString(), setAt: 'x', note: 'n' }
  assert.equal(kernel.sessions.hasUnfinishedWork(), false, 'asleep: an update costs it nothing')
  live.busy = true
  assert.equal(kernel.sessions.hasUnfinishedWork(), true, 'a running turn defers it')
  live.busy = false
  assert.equal(kernel.sessions.taskHasPendingWork(ws, 'defer'), true, 'an active watcher is pending work: its scope is not archived')
  for (const [s, w] of saved) s.info.watcher = w
})

// --- the boot sort by origin (§10) -----------------------------------------------
test('recovery sorts by origin: wake work goes on by itself, attended work waits in the checklist', async () => {
  const mkRestored = async (name, { pending = [], interrupted = false, ranOrigin = undefined, wakeups = true }) => {
    const s = await stage(name)
    const live = s.live
    live.pending = pending
    live.interrupted = interrupted
    live.ranOrigin = ranOrigin
    live.recovering = interrupted
    if (!wakeups) await kernel.watchers.update(ws, name, { wakeups: false })
    return s
  }
  const wake = { id: 'w', text: 'w', auto: true, origin: { wake: 'S' } }
  const cont = (of) => ({ id: 'c', text: 'continue', auto: true, origin: { limit: true, of } })
  const typed = { id: 't', text: 'typed' }

  const a = await mkRestored('r-wake', { pending: [wake], interrupted: true, ranOrigin: 'wake' })
  assert.equal(kernel.sessions.recoverWatcher(a.id, false), true, 'an interrupted wake turn is resumed by the manager')
  assert.ok(!kernel.sessions.interruptedSessions().some((x) => x.id === a.id), 'and is not in the checklist')

  const b = await mkRestored('r-cont-wake', { pending: [cont('wake')] })
  assert.equal(kernel.sessions.recoverWatcher(b.id, false), false)
  assert.ok(!b.live.recovering, 'a queued wake-origin continue drains by itself')

  /** @type {[string, {pending?: object[], interrupted?: boolean, ranOrigin?: string}][]} */
  const attendedCases = [
    ['r-typed', { pending: [typed] }],
    ['r-cont-user', { pending: [cont('user')] }],
    ['r-turn-user', { interrupted: true, ranOrigin: 'user' }],
    ['r-turn-legacy', { interrupted: true }]
  ]
  for (const [name, o] of attendedCases) {
    const s = await mkRestored(name, o)
    kernel.sessions.recoverWatcher(s.id, false)
    assert.equal(s.live.recovering, true, `${name}: attended work waits`)
    // Not a queued wake that drains first: nothing runs and no wake is sent.
    s.live.info.wake = { at: new Date(Date.now() - MIN).toISOString(), setAt: 'x', note: 'n' }
    const before = s.live.pending.length
    kernel.sessions.schedule()
    assert.equal(s.live.pending.length, before, `${name}: no wake while recovering`)
  }

  const p = await mkRestored('r-paused', { interrupted: true, ranOrigin: 'wake', wakeups: false })
  assert.equal(kernel.sessions.recoverWatcher(p.id, true), false)
  assert.equal(p.live.recovering, true, 'paused: even a wake turn waits for a person')
})

test('boot: the kernel recreated on the same root restores the watcher and lists it', async () => {
  const { id } = await stage('reboot')
  await kernel.sessions.flushForRestart()
  const second = m.createKernel()
  await second.ready
  const tree = await second.tree()
  const w = tree.workspaces[0].watchers.find((x) => x.name === 'reboot')
  assert.ok(w, 'tree() fills ws.watchers after a restart')
  assert.equal(w.sessionId, id, 'its session is restored')
  assert.equal(second.sessions.sessionInfo(id).watcher.wakeups, 0)
  assert.ok(!tree.workspaces[0].tasks.some((t) => t.name === 'reboot'))
})

// --- delivery waits for the write (the real drain) --------------------------------
test('a wake is delivered only after its write lands; a failed write restores it; a typed prompt cannot overtake it', async () => {
  const sm = kernel.sessions
  const realDrain = Object.getPrototypeOf(sm).drainPending
  const ran = []
  const { id, live } = await stage('write')
  sm['drainPending'] = realDrain.bind(sm)
  sm['runPrompt'] = async (s, text) => { if (s.info.id === id) ran.push(text) }
  const realPersist = sm['persistNow'].bind(sm)
  const dueAt = new Date(Date.now() - MIN).toISOString()
  const wake = { at: dueAt, setAt: new Date().toISOString(), note: 'n' }
  try {
    // a delayed write: a final wake queued, a typed prompt arriving meanwhile
    const releases = []
    sm['persistNow'] = () => new Promise((resolve) => { releases.push(resolve) })
    const release = () => releases.splice(0).forEach((r) => r())
    live.info.watcher = { ...info(id).watcher, wakeups: 49 }
    live.info.wake = wake
    sm.schedule()
    assert.equal(live.pending.length, 1)
    const typed = sm.prompt(id, 'typed meanwhile')
    await tick()
    assert.deepEqual(ran, [], 'nothing runs before the write lands — the typed prompt does not drain the final wake')
    release()
    await tick(50)
    release()
    await typed
    await tick(50)
    assert.equal(ran.length, 2, 'then both run, the wake first')
    assert.match(ran[0], /last wakeup/)
    assert.equal(ran[1], 'typed meanwhile')

    // a failing write: the ordinary wake is restored and retried, nothing runs
    ran.length = 0
    live.pending = []
    const fresh = { ...info(id).watcher }
    delete fresh.final
    live.info.watcher = { ...fresh, wakeups: 0 }
    live.info.wake = wake
    sm['persistNow'] = () => Promise.reject(new Error('disk full'))
    sm.schedule()
    assert.equal(live.pending.length, 1, 'the wake was queued before its write failed')
    await tick(50)
    assert.deepEqual(ran, [], 'a failed write delivers nothing')
    assert.equal(live.pending.length, 0, 'the prompt is withdrawn')
    assert.equal(info(id).wake.note, 'n', 'the ordinary wake is back, to be retried')

    // Cancel during the write, then the write fails: the wake stays withdrawn
    live.pending = []
    live.info.wake = wake
    let fail
    sm['persistNow'] = () => new Promise((_resolve, reject) => { fail = reject })
    sm.schedule()
    assert.equal(live.pending.length, 1)
    sm.cancelWake(id)
    assert.equal(live.pending.length, 0, 'Cancel withdrew the prompt')
    fail(new Error('disk full'))
    await tick(50)
    assert.equal(info(id).wake, undefined, 'a cancelled wake is not resurrected by the failed write')
  } finally {
    sm['persistNow'] = realPersist
    sm['drainPending'] = async () => {}
    delete sm['runPrompt']
  }
})

test('an old write finishing cannot lift the barrier of a newer wake (Cancel → Wake now, delayed writes)', async () => {
  const sm = kernel.sessions
  const { id, live } = await stage('barrier')
  const ran = []
  sm['drainPending'] = Object.getPrototypeOf(sm).drainPending.bind(sm)
  sm['runPrompt'] = async (s, text) => { if (s.info.id === id) ran.push(text) }
  const realPersist = sm['persistNow'].bind(sm)
  const releases = []
  sm['persistNow'] = () => new Promise((resolve) => { releases.push(resolve) })
  try {
    live.info.wake = { at: new Date(Date.now() - MIN).toISOString(), setAt: new Date().toISOString(), note: 'A' }
    sm.schedule() // write A in flight
    sm.cancelWake(id) // Cancel withdraws A
    sm.wakeNow(id) // Wake now: B, its own write in flight
    assert.equal(live.pending.length, 1)
    const [releaseA] = releases.splice(0, 1)
    releaseA() // A's write lands first
    await tick(30)
    assert.deepEqual(ran, [], "B's barrier stays: it is not on disk yet")
    releases.splice(0).forEach((r) => r())
    await tick(30)
    assert.equal(ran.length, 1, 'B runs once its own write landed')
  } finally {
    sm['persistNow'] = realPersist
    sm['drainPending'] = async () => {}
    delete sm['runPrompt']
  }
})

test('a failing nudge turn after a wake counts as a failed wake turn; after the final wake it expires', async () => {
  const sm = kernel.sessions
  const { id, live } = await stage('nudgefail', { final: 'deadline' })
  live.ranOrigin = 'wake'
  let n = 0
  sm['sendTurn'] = async () => (++n === 1 ? { stopReason: 'end_turn', threw: false } : { stopReason: 'max_tokens', threw: false })
  try {
    await sm['runPrompt'](live, 'wake')
  } finally {
    delete sm['sendTurn']
  }
  assert.equal(info(id).watcher.end.outcome, 'expired', 'no report: the host ends it, it does not hang')
})

test('finish_watch stops the container only after the turn has ended', async () => {
  const stops = []
  const k2 = kernel
  const orig = k2.containers.stop
  k2.containers.stop = async (sid) => { stops.push(sid) }
  try {
    const { id } = await stage('finstop')
    await kernel.watchers.hooksFor(ws, 'finstop', id).finishWatch({ summary: 's', outcome: 'success' })
    assert.deepEqual(stops, [], 'not while the tool result is still on its way')
    kernel.bus.emit('session.turn', { sessionId: id, ref: { workspace: ws, task: 'finstop', env: 'dev' }, phase: 'ended' })
    await tick()
    assert.deepEqual(stops, [id])
  } finally {
    k2.containers.stop = orig
  }
})

test('a finished watcher archives whole and restores as a watcher; an active one cannot be archived', async () => {
  const { id } = await stage('arch')
  await assert.rejects(() => kernel.archive.archive(ws, 'arch'), /once it has finished/)
  kernel.sessions.endWatcher(id, { outcome: 'success', summary: 'done', at: new Date().toISOString(), by: 'agent' })
  await assert.rejects(() => kernel.archive.archiveSession(id), /cannot be archived/, 'a single session of it still cannot')
  const meta = await kernel.archive.archive(ws, 'arch')
  assert.ok(!kernel.watchers.isWatcher(ws, 'arch'), 'gone from the manager')
  assert.ok(!(await kernel.tree()).workspaces[0].watchers.some((x) => x.name === 'arch'))
  await kernel.archive.restore(meta.id)
  assert.ok(kernel.watchers.isWatcher(ws, 'arch'), 'registered again after the restore')
  const w = (await kernel.tree()).workspaces[0].watchers.find((x) => x.name === 'arch')
  assert.ok(w?.sessionId, 'with its session')
  assert.equal(kernel.sessions.sessionInfo(w.sessionId).watcher.end.outcome, 'success')
})

test('a refused settings write changes nothing in memory (Pause that fails can be repeated)', async () => {
  const { id, live } = await stage('cfgfail')
  live.info.wake = { at: new Date(Date.now() + 30 * MIN).toISOString(), setAt: 'x', note: 'n' }
  const dir = path.join(GURT_ROOT, ws, 'cfgfail')
  const moved = `${dir}.moved`
  fs.renameSync(dir, moved)
  fs.writeFileSync(dir, 'x') // a file where the scope directory goes: the write fails
  await assert.rejects(() => kernel.watchers.update(ws, 'cfgfail', { wakeups: false }))
  fs.rmSync(dir); fs.renameSync(moved, dir)
  assert.equal(kernel.watchers.views(ws).find((v) => v.name === 'cfgfail').config.wakeups, true, 'the manager still has the old settings')
  await kernel.watchers.update(ws, 'cfgfail', { wakeups: false })
  assert.equal(kernel.watchers.views(ws).find((v) => v.name === 'cfgfail').config.wakeups, false, 'the repeat goes through')
  void id
})

test('two wakes in a row whose nudge turn fails: attention after the second, not a retry loop', async () => {
  const sm = kernel.sessions
  const { id, live } = await stage('streak')
  live.ranOrigin = 'wake'
  live.wakeNote = 'n'
  const run = async () => {
    let n = 0
    sm['sendTurn'] = async () => (++n === 1 ? { stopReason: 'end_turn', threw: false } : { stopReason: 'max_tokens', threw: false })
    try { await sm['runPrompt'](live, 'wake') } finally { delete sm['sendTurn'] }
  }
  await run()
  assert.ok(info(id).wake, 'first failure: a retry wake is set')
  assert.equal(info(id).watcher.attention, undefined)
  live.info.wake = undefined
  await run()
  assert.equal(info(id).watcher.attention.level, 'error', 'second failure in a row: attention, no retry')
  assert.equal(info(id).wake, undefined)
})

test('a watcher session cannot be deleted on its own through the API', async () => {
  const { id } = await stage('nodelete')
  // the IPC handler's rule: the manager knows the session as a watcher's
  assert.ok(kernel.watchers.ofSession(id))
})

test('a watcher cannot be branched, run or enqueued through the general paths', async () => {
  const { id, live } = await stage('onesession')
  live.entries.push({ id: 99, kind: 'user', text: 'hi', at: Date.now() })
  assert.throws(() => kernel.sessions.branchSession(id, 99), /watcher/)
  assert.equal(kernel.sessions.listForTask(ws, 'onesession').length, 1, 'still exactly one session')
})

test('Stop while queued or starting: the watcher never starts and sends no start prompt', async () => {
  const sm = kernel.sessions
  const { id, live } = await stage('stopq')
  live.info.state = 'queued'
  live.info.queuedAt = new Date().toISOString()
  await kernel.watchers.stop(ws, 'stopq')
  assert.equal(info(id).state, 'draft', 'the queued start is cancelled')
  assert.equal(info(id).watcher.end.outcome, 'stopped')
  // the race: the scheduler had already picked it
  live.info.state = 'queued'
  let prompts = 0
  sm['runPrompt'] = async () => { prompts++ }
  try {
    await sm['startSession'](id, 'scheduler')
  } finally {
    delete sm['runPrompt']
  }
  assert.equal(prompts, 0)
  assert.equal(info(id).state, 'draft', 'a stopped watcher never leaves the queue into a start')
})

test('Stop between taking a wake and its session/prompt: the prompt is never sent', async () => {
  const sm = kernel.sessions
  const { id, live } = await stage('stoprace')
  live.ranOrigin = 'wake'
  let sent = 0
  sm['attach'] = async () => {
    // the Stop lands while the attach is in flight
    kernel.sessions.endWatcher(id, { outcome: 'stopped', summary: 'stopped by the user', at: new Date().toISOString(), by: 'user' })
    return { peer: { request: async () => { sent++; return { stopReason: 'end_turn' } } } }
  }
  try {
    await sm['runPrompt'](live, 'wake')
  } finally {
    delete sm['attach']
  }
  assert.equal(sent, 0, 'session/prompt was not sent after the Stop')
})

test('a typed turn of a finished watcher is still sent', async () => {
  const sm = kernel.sessions
  const { id, live } = await stage('typedfinished')
  kernel.sessions.endWatcher(id, { outcome: 'success', summary: 's', at: new Date().toISOString(), by: 'agent' })
  live.ranOrigin = 'user'
  let sent = 0
  sm['attach'] = async () => ({ peer: { request: async () => { sent++; return { stopReason: 'end_turn' } } } })
  try {
    await sm['runPrompt'](live, 'question')
  } finally {
    delete sm['attach']
  }
  assert.equal(sent, 1)
})

test('after a restart, what was typed to a finished watcher waits in the checklist', async () => {
  const { id, live } = await stage('finq')
  kernel.sessions.endWatcher(id, { outcome: 'success', summary: 's', at: new Date().toISOString(), by: 'agent' })
  live.pending = [{ id: 'q', text: 'typed before the restart' }]
  live.recovering = false
  kernel.sessions.recoverWatcher(id, false)
  assert.equal(live.recovering, true)
  kernel.sessions.schedule()
  assert.equal(live.pending.length, 1, 'nothing was sent by the first pass')
})

test('a limited result after Stop leaves no automatic continue', async () => {
  const sm = kernel.sessions
  const { id, live } = await stage('stoplimit')
  live.ranOrigin = 'wake'
  sm['sendTurn'] = async () => {
    kernel.sessions.endWatcher(id, { outcome: 'stopped', summary: 'stopped by the user', at: new Date().toISOString(), by: 'user' })
    return { threw: false, limit: { resetAt: new Date(Date.now() + 60 * MIN).toISOString() } }
  }
  try {
    await sm['runPrompt'](live, 'wake')
  } finally {
    delete sm['sendTurn']
  }
  assert.equal(info(id).limitedUntil, undefined)
  assert.equal(live.pending.length, 0, 'no continue queued')
})
