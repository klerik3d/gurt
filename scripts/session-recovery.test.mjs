import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const outfile = path.join(os.tmpdir(), `gurt-recovery-${process.pid}.mjs`)
await bundle({ stdin: { contents: "export { SessionManager } from './src/main/sessions.ts'", resolveDir: process.cwd(), loader: 'ts' }, outfile })
const { SessionManager } = await import(pathToFileURL(outfile).href)
after(() => fs.rmSync(outfile, { force: true }))
const record = (extra = {}) => ({ info: { id: 's', title: 'Work', state: 'started', workspace: 'w', task: 't', env: 'e', repos: [] }, acpSessionId: 'agent-session', log: [], ...extra })
/** @param {(ws: string, task: string, records: any[]) => void | Promise<void>} [persist] */
function manager(persist = () => {}) {
  return new SessionManager({ persist }, { emit() {} }, {})
}
test('interrupted turns and queued payloads survive restart and remain paused', async () => {
  const m = manager()
  const image = { mimeType: 'image/png', data: 'payload' }
  m.restore([record({ interrupted: true, pending: [{ id: 'old', text: 'next', images: [image] }] })])
  assert.deepEqual(m.interruptedSessions(), [{ id: 's', title: 'Work', workspace: 'w', task: 't' }])
  assert.equal(m.hasUnfinishedWork(), true)
  const s = m.sessions.get('s')
  await m.drainPending(s)
  assert.equal(s.pending.length, 1)
  const saved = m.recordsFor('w', 't')
  assert.deepEqual(saved[0].pending[0].images, [image])
  s.pending.pop()
  assert.equal(saved[0].pending.length, 1, 'persisted snapshots cannot mutate while disk writes wait')
  const reboot = manager()
  reboot.restore(saved.map((r) => ({ ...r, log: [] })))
  assert.equal(reboot.interruptedSessions().length, 1)
})
test('resume persists continuation before draining and does not duplicate concurrent clicks', async () => {
  let release
  const saved = []
  const m = manager((w, t, records) => { saved.push(records); return new Promise((resolve) => { release = resolve }) })
  m.restore([record({ interrupted: true, pending: [{ id: 'p', text: 'next' }] })])
  let drains = 0
  m.drainPending = async () => { drains++ }
  const first = m.resumeInterrupted('s')
  await m.resumeInterrupted('s')
  assert.equal(drains, 0)
  assert.equal(saved[0][0].pending.length, 2)
  assert.match(saved[0][0].pending[0].text, /Do not repeat completed actions/)
  release()
  await first
  assert.equal(drains, 1)
  assert.equal(m.interruptedSessions().length, 0)
})
test('failed persistence keeps recovery available for retry', async () => {
  const m = manager(() => Promise.reject(new Error('disk full')))
  m.restore([record({ interrupted: true })])
  await assert.rejects(m.resumeInterrupted('s'), /disk full/)
  assert.equal(m.interruptedSessions().length, 1)
  assert.equal(m.sessions.get('s').pending.length, 0)
})
test('idle sessions allow update; queued work and permission waits do not', () => {
  const m = manager()
  m.restore([record()])
  assert.equal(m.hasUnfinishedWork(), false)
  const s = m.sessions.get('s')
  for (const field of ['busy', 'draining', 'loading', 'recovering', 'promptRunning']) {
    s[field] = true
    assert.equal(m.hasUnfinishedWork(), true, field)
    s[field] = false
  }
  s.pendingPermissions.set(1, () => {})
  assert.equal(m.hasUnfinishedWork(), true)
  s.pendingPermissions.clear()
  s.info.limitedUntil = Date.now() + 10000
  assert.equal(m.hasUnfinishedWork(), true)
})

test('queued messages restore without a recovery prompt or an extra continue', async () => {
  const m = manager()
  const r = record({ pending: [{ id: 'p', text: 'my next step', queuedAt: '2026-01-01T00:00:00Z' }] })
  r.info.limitedUntil = new Date(Date.now() + 3600000).toISOString()
  m.restore([r])
  assert.deepEqual(m.interruptedSessions(), [])
  assert.deepEqual(m.snapshot('s').pending.map((p) => p.text), ['my next step'])
  assert.deepEqual(m.snapshot('s').info.pending, m.snapshot('s').pending)
  assert.match(m.snapshot('s').info.queueWaiting, /limit/)
  let runs = 0
  m.runPrompt = async () => { runs++ }
  await m.resumeInterrupted('s')
  m.schedule()
  assert.equal(runs, 0, 'restart and resume cannot bypass the limit')
  m.sessions.get('s').info.limitedUntil = undefined
  m.schedule()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(runs, 1, 'queued work resumes normally when its hold ends')
  clearTimeout(m.limitTimer)
})

test('a held message keeps its FIFO place ahead of a draft on the same clone', async () => {
  const m = manager()
  const message = record({ pending: [{ id: 'p', text: 'first', queuedAt: '2026-01-01T00:00:00Z' }] })
  Object.assign(message.info, { repos: ['repo'], repoModes: { repo: 'write' }, limitedUntil: new Date(Date.now() + 3600000).toISOString() })
  const draft = record({ info: { ...message.info, id: 'draft', title: 'Next', state: 'queued', queuedAt: '2026-01-02T00:00:00Z', limitedUntil: undefined } })
  const independent = record({ info: { ...draft.info, id: 'other', repos: ['other'], repoModes: { other: 'write' } } })
  m.restore([message, draft, independent])
  const starts = []
  m.startSession = async (id) => { starts.push(id); m.sessions.get(id).info.state = 'started' }
  m.runPrompt = async (s, text) => { starts.push(text) }
  assert.equal(m.snapshot('s').queuePosition, 1)
  assert.equal(m.snapshot('draft').queuePosition, 2)
  m.schedule()
  assert.deepEqual(starts, ['other'], 'only independent work can overtake the hold')
  m.sessions.get('s').info.limitedUntil = undefined
  m.schedule()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(starts, ['other', 'first', 'draft'])
  clearTimeout(m.limitTimer)
})

test('cancelling a waiting message releases the next queued session', () => {
  const m = manager()
  const message = record({ pending: [{ id: 'p', text: 'first' }] })
  Object.assign(message.info, { repos: ['repo'], repoModes: { repo: 'write' }, limitedUntil: new Date(Date.now() + 3600000).toISOString() })
  m.restore([message, record({ info: { ...message.info, id: 'next', state: 'queued', limitedUntil: undefined, queuedAt: '2026-01-01T00:00:00Z' } })])
  const starts = []
  m.startSession = async (id) => { starts.push(id); m.sessions.get(id).info.state = 'started' }
  m.schedule()
  assert.deepEqual(starts, [])
  m.cancelPending('s', m.snapshot('s').pending[0].id)
  assert.deepEqual(starts, ['next'])
})
