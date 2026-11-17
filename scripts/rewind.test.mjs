// Pure-logic tests for rewind: the `truncate` log record and the transcript
// handed to an agent that cannot fork natively. No docker, no electron.
//
//   node scripts/rewind.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-rewind-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await bundle({
  stdin: {
    contents: `
export { applyLog } from ${S('src/shared/types.ts')}
export { transcriptOf, rewindPreface, branchPrompt } from ${S('src/shared/transcript.ts')}
`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})
const { applyLog, transcriptOf, rewindPreface, branchPrompt } = await import(pathToFileURL(outfile).href)
after(() => fs.rmSync(outfile, { force: true }))

const e = (id, kind, text, extra = {}) => ({ seq: 0, type: 'entry', entry: { id, kind, text, ...extra } })
const seqd = (records) => records.map((r, i) => ({ ...r, seq: i + 1 }))

test('truncate drops every entry above afterId', () => {
  const log = seqd([e(1, 'user', 'a'), e(2, 'agent', 'b'), e(3, 'user', 'c'), e(4, 'agent', 'd'), { type: 'truncate', afterId: 2 }])
  assert.deepEqual(applyLog([], log).map((x) => x.id), [1, 2])
})

test('ids above the cut can be reused afterwards, and late records for the old ones are ignored', () => {
  const log = seqd([
    e(1, 'user', 'a'),
    e(2, 'agent', 'b'),
    e(3, 'user', 'old'),
    { type: 'truncate', afterId: 2 },
    e(3, 'user', 'new'),
    { type: 'append', id: 4, text: 'stray' }
  ])
  const out = applyLog([], log)
  assert.deepEqual(out.map((x) => [x.id, x.text]), [[1, 'a'], [2, 'b'], [3, 'new']])
})

test('appends after a truncate reach the entries that survived it', () => {
  const log = seqd([e(1, 'user', 'a'), e(2, 'agent', 'b'), e(3, 'user', 'c'), { type: 'truncate', afterId: 2 }, { type: 'append', id: 2, text: '!' }])
  assert.equal(applyLog([], log)[1].text, 'b!')
})

test('folding in one go equals folding record by record', () => {
  const log = seqd([e(1, 'user', 'a'), e(2, 'agent', 'b'), e(3, 'user', 'c'), { type: 'truncate', afterId: 1 }, e(2, 'agent', 'z')])
  let inc = []
  for (const r of log) inc = applyLog(inc, [r])
  assert.deepEqual(inc, applyLog([], log))
})

test('transcript keeps what was said and tool calls, not thoughts or system lines', () => {
  const t = transcriptOf([
    { id: 1, kind: 'user', text: 'fix it' },
    { id: 2, kind: 'thought', text: 'hmm' },
    { id: 3, kind: 'tool', toolCallId: 'x', title: 'Edit a.ts', status: 'completed' },
    { id: 4, kind: 'agent', text: 'done' },
    { id: 5, kind: 'system', text: 'complete: no_changes' }
  ])
  assert.equal(t, 'User: fix it\n\n[tool: Edit a.ts (completed)]\n\nAssistant: done')
})

test('an over-long transcript loses its oldest turns, not its newest', () => {
  const entries = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, kind: 'user', text: `m${i}-${'x'.repeat(100)}` }))
  const t = transcriptOf(entries, 1000)
  assert.ok(t.startsWith('[earlier part of the conversation omitted]'))
  assert.ok(t.includes('m49-'))
  assert.ok(!t.includes('m0-'))
})

test('preface and branch prompt wrap the transcript and warn that files were not reverted', () => {
  const entries = [{ id: 1, kind: 'user', text: 'hi' }]
  assert.match(rewindPreface(entries), /NOT reverted[\s\S]*<conversation>\nUser: hi\n<\/conversation>/)
  assert.match(branchPrompt(entries), /<conversation>\nUser: hi\n<\/conversation>[\s\S]*Now continue with: $/)
})

test('successful file rewind preface describes restored trees and external effects', () => {
  const text = rewindPreface([], true)
  assert.doesNotMatch(text, /NOT reverted/)
  assert.match(text, /Working trees were restored/)
  assert.match(text, /External effects were not reverted/)
})
