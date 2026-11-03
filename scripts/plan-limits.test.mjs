// The plan-limit gate end to end, on a real kernel (src/main/sessions.ts
// `limitHold`, src/shared/planUsage.ts `planHold`):
//
//   - a queued draft on an account at its limit stays queued, says why, and
//     starts once fresh numbers lift the hold;
//   - the hold is pooled per credential, so a draft on another agent instance
//     of the same account waits too, and one on another account does not;
//   - a started session's queued messages wait the same way;
//   - a session cut off by a limit queues the automatic "continue" — which a
//     restart puts back, a typed message replaces, and a cancel withdraws.
//
// Nothing here reaches an agent: every start that the gate lets through fails
// at provisioning (no daemon), which is the proof it got *past* the gate.
//
//   node scripts/plan-limits.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

// store.ts reads GURT_ROOT at module load — set it before the import.
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-plan-limits-'))
process.env.GURT_ROOT = GURT_ROOT

const outfile = path.join(os.tmpdir(), `gurt-plan-limits-${process.pid}.mjs`)
await bundle({
  stdin: {
    contents: `export { createKernel } from ${S('src/main/kernel.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})
const { createKernel } = await import(pathToFileURL(outfile).href)

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
      { name: 'beta', url: 'https://github.com/o/beta.git' },
      { name: 'gamma', url: 'https://github.com/o/gamma.git' }
    ],
    envs: [{ name: 'dev', devcontainer: '{"image":"x"}', repo: 'alpha' }]
  })
)
fs.writeFileSync(path.join(GURT_ROOT, ws, task, 'task.json'), JSON.stringify({}))
// a1 and a2 share one account; a3 is another one.
fs.writeFileSync(
  path.join(GURT_ROOT, 'agents.json'),
  JSON.stringify({
    a1: { kind: 'claude-code', label: 'one', credentialId: 'c1' },
    a2: { kind: 'claude-code', label: 'two', credentialId: 'c1' },
    a3: { kind: 'claude-code', label: 'three', credentialId: 'c2' }
  })
)

const HOUR = 60 * 60_000
const started = (id, title, repo, extra = {}) => ({
  info: {
    id,
    env: 'dev',
    role: 'executor',
    repos: [repo],
    task,
    workspace: ws,
    title,
    agent: 'a1',
    state: 'started',
    mcp: [],
    startPrompt: 'go',
    ...extra
  },
  acpSessionId: `acp-${id}`
})
const cutOffUntil = new Date(Date.now() + HOUR).toISOString()
fs.writeFileSync(
  path.join(GURT_ROOT, ws, task, 'sessions.json'),
  JSON.stringify([
    started('sp', 'P', 'gamma'),
    // Cut off by a limit in the previous run, still waiting for the reset.
    started('sl', 'L', 'gamma', { limitedUntil: cutOffUntil }),
    started('sm', 'M', 'gamma', { limitedUntil: cutOffUntil }),
    started('sx', 'X', 'gamma', { agent: 'a3' })
  ])
)

const kernel = createKernel()
await kernel.ready
// Queueing a prompt asks the container manager to stop whatever holds the
// clone; nothing here should reach a daemon for that.
kernel.containers.stop = async () => {}

const ref = { workspace: ws, task, env: 'dev' }
const live = (agent, utilization, resetIn = HOUR) =>
  kernel.bus.emit('agent.planUsage', {
    agent,
    windows: [
      {
        id: 'five_hour',
        label: 'Current session',
        utilization,
        raw: utilization / 100,
        resetsAt: new Date(Date.now() + resetIn).toISOString()
      }
    ]
  })

/** Wait until the session is neither queued nor starting. */
async function settle(id) {
  for (let i = 0; i < 200; i++) {
    const snap = kernel.sessions.snapshot(id)
    if (snap && snap.info.state !== 'starting' && snap.info.state !== 'queued') return snap
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`session ${id} never settled`)
}
const tick = () => new Promise((r) => setTimeout(r, 50))

test('a queued draft on a held account waits, says why, and starts once the hold lifts', async () => {
  live('a1', 97)
  // a2 has no numbers of its own: it is held through a1, its account-mate.
  const d = kernel.sessions.createSession(ref, ['alpha'], 'a2', 'hi', 'queue')
  await tick()
  let snap = kernel.sessions.snapshot(d.id)
  assert.equal(snap.info.state, 'queued', 'the start would only be refused — it waits')
  assert.match(snap.waiting ?? '', /plan limit: Current session 97% — waits for the reset at/)

  // Another account is not held by this one.
  const other = kernel.sessions.createSession(ref, ['beta'], 'a3', 'hi', 'queue')
  const otherSnap = await settle(other.id)
  assert.equal(otherSnap.waiting, undefined)
  assert.doesNotMatch(otherSnap.startError ?? '', /limit/, 'it went past the gate (and failed at provisioning)')

  // Fresh numbers under the threshold lift the hold without waiting for the reset.
  live('a1', 10)
  snap = await settle(d.id)
  assert.equal(snap.waiting, undefined)
  assert.doesNotMatch(snap.startError ?? '', /limit/, 'it left the queue through the start, not the gate')
})

test('the threshold is the configured one', async () => {
  live('a1', 70)
  await kernel.setLimitSettings({ thresholdPercent: 60 })
  const d = kernel.sessions.createSession(ref, ['alpha'], 'a1', 'hi', 'queue')
  await tick()
  assert.equal(kernel.sessions.snapshot(d.id).info.state, 'queued')
  // Raising it re-decides at once.
  await kernel.setLimitSettings({ thresholdPercent: 95 })
  const snap = await settle(d.id)
  assert.notEqual(snap.info.state, 'queued')
  assert.equal(JSON.parse(fs.readFileSync(path.join(GURT_ROOT, 'limits.json'), 'utf8')).thresholdPercent, 95)
})

test('"Run now" on a held account queues instead of starting into the refusal', async () => {
  live('a1', 100)
  const d = kernel.sessions.createSession(ref, ['alpha'], 'a1', 'hi', 'draft')
  kernel.sessions.run(d.id)
  await tick()
  assert.equal(kernel.sessions.snapshot(d.id).info.state, 'queued')
  kernel.sessions.cancelQueue(d.id)
  live('a1', 0)
})

test("a started session's queued message waits for the hold", async () => {
  live('a1', 100)
  await kernel.sessions.prompt('sp', 'next step')
  const snap = kernel.sessions.snapshot('sp')
  assert.equal(snap.busy, false, 'no turn was started')
  assert.deepEqual(snap.pending.map((p) => p.text), ['next step'])
  assert.match(snap.pendingBlocked ?? '', /plan limit/)
  kernel.sessions.clearPending('sp')
  live('a1', 0)
})

test('a session cut off before a restart has its "continue" queued again', () => {
  const snap = kernel.sessions.snapshot('sl')
  assert.deepEqual(
    snap.pending.map((p) => [p.text, p.auto]),
    [['continue', true]]
  )
  assert.match(snap.pendingBlocked ?? '', /plan limit: limit reached — waits for the reset at/)
})

test('a typed message replaces the automatic "continue"', async () => {
  await kernel.sessions.prompt('sm', 'actually, do Y')
  const snap = kernel.sessions.snapshot('sm')
  assert.deepEqual(snap.pending.map((p) => p.text), ['actually, do Y'])
  assert.match(snap.pendingBlocked ?? '', /plan limit/, 'and still waits for the reset')
  kernel.sessions.clearPending('sm')
})

test('cancelling the automatic "continue" withdraws the resume', () => {
  const [auto] = kernel.sessions.snapshot('sl').pending
  assert.equal(kernel.sessions.cancelPending('sl', auto.id), undefined, 'nothing goes back to the composer')
  const snap = kernel.sessions.snapshot('sl')
  assert.equal(snap.pending, undefined)
  assert.equal(snap.info.limitedUntil, undefined)
})

test('a limit hit holds the session and its whole account, and queues the resume', async () => {
  // `onLimited` is what a turn the detector claimed ends in.
  const s = kernel.sessions.sessions.get('sx')
  const resetAt = new Date(Date.now() + 2 * HOUR).toISOString()
  kernel.sessions.onLimited(s, { resetAt })
  const snap = kernel.sessions.snapshot('sx')
  assert.equal(snap.info.limitedUntil, resetAt, 'the reset the refusal named')
  assert.deepEqual(snap.pending.map((p) => [p.text, p.auto]), [['continue', true]])
  assert.ok(
    (snap.entries ?? []).some((e) => e.kind === 'system' && /limit reached — continues on its own/.test(e.text)),
    'the timeline says what will happen'
  )
  // The account learned of it: a draft on a3 now waits instead of starting.
  const d = kernel.sessions.createSession(ref, ['beta'], 'a3', 'hi', 'queue')
  await tick()
  assert.equal(kernel.sessions.snapshot(d.id).info.state, 'queued')
  // No reset named and none known: a backoff, never "now".
  const t = kernel.sessions.sessions.get('sp')
  kernel.sessions.onLimited(t, {})
  const until = Date.parse(kernel.sessions.snapshot('sp').info.limitedUntil)
  assert.ok(until > Date.now() + 10 * 60_000, 'waits at least the first backoff step')
})
