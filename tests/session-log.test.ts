// Pure-logic tests for the append-only session log (no docker, no electron):
// applyLog unit cases, and the legacy sessions.json -> JSONL migration through
// the real electron-free kernel.
import { afterAll, it } from 'vitest'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

// GURT_ROOT must be set before the store module loads (read at import time).
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-session-log-'))
process.env.GURT_ROOT = GURT_ROOT
const { applyLog } = await import('../src/shared/types')
const { createKernel } = await import('../src/main/kernel')

afterAll(() => {
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

const e1 = { seq: 1, type: 'entry', entry: { id: 1, kind: 'user', text: 'hi' } } as any
const e2 = { seq: 2, type: 'entry', entry: { id: 2, kind: 'agent', text: 'he' } } as any
const a3 = { seq: 3, type: 'append', id: 2, text: 'llo' } as any
const t4 = {
  seq: 4,
  type: 'entry',
  entry: { id: 3, kind: 'tool', toolCallId: 't1', title: 'run tests', status: 'pending' }
} as any
const p5 = { seq: 5, type: 'patch', id: 3, patch: { status: 'completed', detail: 'ok' } } as any
const perm6 = {
  seq: 6,
  type: 'entry',
  entry: { id: 4, kind: 'permission', title: 'allow?', options: [] }
} as any
const p7 = { seq: 7, type: 'patch', id: 4, patch: { chosen: 'yes' } } as any
const all = [e1, e2, a3, t4, p5, perm6, p7]
const folded = applyLog([], all)

it('applyLog: entry / append / patch', () => {
  assert.equal(folded.length, 4)
  assert.deepEqual(folded[0], { id: 1, kind: 'user', text: 'hi' })
  assert.deepEqual(folded[1], { id: 2, kind: 'agent', text: 'hello' })
  assert.equal((folded[2] as any).status, 'completed')
  assert.equal((folded[2] as any).detail, 'ok')
  assert.equal((folded[2] as any).title, 'run tests')
  assert.equal((folded[3] as any).chosen, 'yes')
})

it('fold(all records) == incremental application, one record at a time', () => {
  let inc: any[] = []
  for (const r of all) inc = applyLog(inc, [r])
  assert.deepEqual(inc, folded)
})

it('pure: returns a new array, never mutates the input', () => {
  const base = applyLog([], [e1])
  const before = structuredClone(base)
  const next = applyLog(base, [e2, a3])
  assert.notEqual(next, base)
  assert.deepEqual(base, before)
})

it('unknown ids (out-of-order deltas) and unknown record types are ignored', () => {
  const ignored = applyLog(folded, [
    { seq: 8, type: 'append', id: 99, text: 'x' } as any,
    { seq: 9, type: 'patch', id: 99, patch: { status: 'x' } } as any,
    { seq: 10, type: 'compact' } as any
  ])
  assert.deepEqual(ignored, folded)
})

it('a re-delivered entry record replaces instead of duplicating (snapshot/delta race)', () => {
  const redelivered = applyLog(folded, [
    { seq: 2, type: 'entry', entry: { id: 2, kind: 'agent', text: 'hello' } } as any
  ])
  assert.deepEqual(redelivered, folded)
})

it('migration: legacy sessions.json (with entries) restores identically', async () => {
  const info = {
    id: 'sess-1',
    envRepo: 'hello',
    task: 't',
    workspace: 'p',
    title: 'session 1',
    agent: 'claude-code',
    state: 'started',
    startPrompt: 'hi'
  }
  const entries = [
    { id: 1, kind: 'user', text: 'hi' },
    { id: 2, kind: 'agent', text: 'hello' },
    { id: 3, kind: 'system', text: 'error: Authentication required' }
  ]
  fs.mkdirSync(path.join(GURT_ROOT, 'p', 't'), { recursive: true })
  fs.writeFileSync(path.join(GURT_ROOT, 'p', 'workspace.json'), JSON.stringify({ repos: [] }))
  fs.writeFileSync(path.join(GURT_ROOT, 'p', 't', 'task.json'), JSON.stringify({ envs: [] }))
  fs.writeFileSync(
    path.join(GURT_ROOT, 'p', 't', 'sessions.json'),
    JSON.stringify([{ info, acpSessionId: 'acp-1', entries }])
  )

  const kernel = createKernel()
  // restore runs fire-and-forget — poll until the session shows up
  let snap
  for (let i = 0; i < 100 && !snap; i++) {
    await new Promise((r) => setTimeout(r, 50))
    snap = kernel.sessions.snapshot('sess-1')
  }
  assert.ok(snap, 'restored session must be visible')
  assert.deepEqual(snap.entries, entries)

  const jsonlFile = path.join(GURT_ROOT, 'p', 't', 'sessions', 'sess-1.jsonl')
  const records = fs
    .readFileSync(jsonlFile, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  assert.deepEqual(records.map((r) => r.seq), [1, 2, 3])
  assert.ok(records.every((r) => r.type === 'entry'))
  assert.deepEqual(applyLog([], records), entries as any)
})
