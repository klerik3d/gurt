// The end-to-end start phase (docs/logging.md `provision.phase`,
// `start-to-first-update`): from "start requested" to the first
// `session/update` the agent sends for the start prompt. An update before the
// prompt went out (the adapter's own announcements after `session/new`) must
// not end it, and it ends exactly once.
//
//   node scripts/start-phases.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const S = (rel) => JSON.stringify(path.join(ROOT, rel))
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-start-phases-'))
process.env.GURT_ROOT = GURT_ROOT
const outfile = path.join(GURT_ROOT, 'entry.mjs')
await bundle({
  stdin: {
    contents: `
      export { onSessionUpdate } from ${S('src/main/sessions/agentEvents.ts')}
      export { flushSync } from ${S('src/main/log.ts')}
    `,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  external: ['electron'],
  outfile
})
const m = await import(pathToFileURL(outfile).href)
after(() => {
  m.flushSync()
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

const phases = () => {
  m.flushSync()
  const f = path.join(GURT_ROOT, 'logs', 'gurt.log')
  return (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')
    .split('\n')
    .filter((l) => l.includes('start-to-first-update'))
}

test('the first update after the start prompt ends the phase, once; earlier ones do not', () => {
  const s = { info: { id: 'sp1' }, startTiming: { since: Date.now() - 50, promptSent: false } }
  const mgr = { bySessionId: () => s }
  const update = { sessionId: 'a', update: { sessionUpdate: 'some_future_update' } }
  m.onSessionUpdate(mgr, update)
  assert.ok(s.startTiming, 'an update before the prompt does not end it')
  assert.equal(phases().length, 0)
  s.startTiming.promptSent = true
  m.onSessionUpdate(mgr, update)
  assert.equal(s.startTiming, undefined)
  const lines = phases()
  assert.equal(lines.length, 1)
  assert.match(lines[0], /sp1/)
  m.onSessionUpdate(mgr, update)
  assert.equal(phases().length, 1, 'logged once')
})
