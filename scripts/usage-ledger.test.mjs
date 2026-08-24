// Ledger test for src/main/usage.ts: drives `createUsageLedger` over a real
// bus and a throwaway GURT_ROOT — append, reload from disk, retention prune,
// and the merge that keeps a turn filed mid-load from being lost or doubled.
// No docker, no electron. Harness style of scripts/notifications.test.mjs.
//
//   node scripts/usage-ledger.test.mjs
import { test, after } from 'node:test'
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-usage-ledger-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

// The store resolves gurtRoot at module load — set it before the bundle imports.
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-usage-'))
process.env.GURT_ROOT = GURT_ROOT
process.env.GURT_LOG_LEVEL = 'error'

await build({
  stdin: {
    contents: [
      `export { createUsageLedger, USAGE_RETENTION_MS } from ${S('src/main/usage.ts')}`,
      `export { createBus } from ${S('src/main/bus.ts')}`
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

const { createUsageLedger, USAGE_RETENTION_MS, createBus } = await import(
  pathToFileURL(outfile).href
)

const LEDGER = path.join(GURT_ROOT, 'usage.jsonl')
const turn = (ts, extra = {}) => ({
  ts,
  agent: 'work',
  kind: 'claude-code',
  sessionId: 's1',
  workspace: 'w',
  task: 't',
  ms: 1000,
  outcome: 'ok',
  ...extra
})
const readFile = () =>
  fs
    .readFileSync(LEDGER, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))

/** Poll until `check` holds — the ledger's disk writes are fire-and-forget. */
async function until(check, what) {
  for (let i = 0; i < 100; i++) {
    try {
      if (check()) return
    } catch {
      // file not there yet
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.fail(`timed out waiting for: ${what}`)
}

after(() => fsp.rm(GURT_ROOT, { recursive: true, force: true }))

// --- append ----------------------------------------------------------------
test('append', async () => {
  const bus = createBus()
  const ledger = createUsageLedger(bus)
  await ledger.ready
  assert.deepEqual(ledger.list(), [], 'a fresh install starts empty')

  let changed = 0
  bus.on('usage.changed', () => changed++)
  bus.emit('agent.turn', turn('2026-08-19T09:00:00.000Z'))
  bus.emit('agent.turn', turn('2026-08-19T09:05:00.000Z', { sessionId: 's2' }))
  assert.equal(ledger.list().length, 2, 'in memory immediately — the UI does not wait on disk')
  assert.equal(changed, 2, 'every filed turn wakes the dashboard')
  await until(() => readFile().length === 2, 'both turns on disk')
  assert.equal(readFile()[1].sessionId, 's2', 'append order is turn order')
})

// --- reload ----------------------------------------------------------------
test('reload', async () => {
  const ledger = createUsageLedger(createBus())
  await ledger.ready
  assert.equal(ledger.list().length, 2, 'a relaunch reads the ledger back')
  assert.equal(ledger.list()[0].ts, '2026-08-19T09:00:00.000Z')
})

// --- merge: a turn filed while the load is still in flight ------------------
test('merge: a turn filed while the load is still in flight', async () => {
  const bus = createBus()
  const ledger = createUsageLedger(bus)
  // Synchronous — lands in memory before `readUsage` resolves.
  bus.emit('agent.turn', turn('2026-08-19T09:09:00.000Z', { sessionId: 's3' }))
  await ledger.ready
  const ids = ledger.list().map((r) => r.sessionId)
  assert.deepEqual(ids, ['s1', 's2', 's3'], 'kept, ordered by ts, and not doubled')
  await until(() => readFile().length === 3, 'the mid-load turn reached disk too')
})

// --- retention prune -------------------------------------------------------
test('retention prune', async () => {
  const now = Date.now()
  const old = new Date(now - USAGE_RETENTION_MS - 5 * 86_400_000).toISOString()
  const fresh = new Date(now - 3600_000).toISOString()
  await fsp.writeFile(
    LEDGER,
    [turn(old, { sessionId: 'ancient' }), turn(fresh, { sessionId: 'recent' })]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n'
  )
  const ledger = createUsageLedger(createBus())
  await ledger.ready
  assert.deepEqual(
    ledger.list().map((r) => r.sessionId),
    ['recent'],
    'anything past retention is dropped at load'
  )
  await until(
    () => readFile().length === 1 && readFile()[0].sessionId === 'recent',
    'the prune rewrote the file'
  )
})

// --- torn line -------------------------------------------------------------
test('torn line', async () => {
  await fsp.appendFile(LEDGER, '{"ts":"2026-08-19T10:00:00.000Z","ms":1,"age')
  const ledger = createUsageLedger(createBus())
  await ledger.ready
  assert.equal(ledger.list().length, 1, 'a crash mid-append costs that line, not the ledger')
})
