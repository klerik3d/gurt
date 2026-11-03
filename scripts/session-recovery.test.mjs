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
  assert.deepEqual(m.interruptedSessions(), [{ id: 's', title: 'Work' }])
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
