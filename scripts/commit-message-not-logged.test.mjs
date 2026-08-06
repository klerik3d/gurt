// Regression test: `changes.commit()` must never let the commit message reach
// gurt.log. `changes.commit()` shells out to `git commit -m <message>`, and
// `provision.ts`'s `run()` traces every spawn's argv at DBG — without the
// `opaqueArgv` opt-out, the full message rode along in that trace, bypassing
// the opacity `ipc.ts`'s OPAQUE_ARGS gives `changesCommit` at the IPC boundary.
// See docs/logging.md's "Never written, anywhere: chat and prompt content".
//
//   node scripts/commit-message-not-logged.test.mjs
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const pexecFile = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-commit-msg-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-commit-msg-'))
// store.ts / log.ts read GURT_ROOT / GURT_LOG at module load — set before import.
// DBG is what proc.spawn traces at, and it must stay clean even there.
process.env.GURT_ROOT = path.join(root, 'gurt')
process.env.GURT_LOG = 'debug'

await build({
  stdin: {
    contents: `export { commit } from ${S('src/main/changes.ts')}`,
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

const m = await import(pathToFileURL(outfile).href)

const WS = 'ws'
const TASK = 'task-1'
const REPO = 'demo'
const dir = path.join(process.env.GURT_ROOT, WS, TASK, REPO)
const SECRET_MESSAGE = 'fix: THIS-MESSAGE-CONTAINS-SENSITIVE-PROSE-8f2a1c'

try {
  await fs.promises.mkdir(dir, { recursive: true })
  await pexecFile('git', ['init', '-q', dir])
  const gitDir = (...args) =>
    pexecFile('git', ['-C', dir, '-c', 'user.email=t@t.test', '-c', 'user.name=t', ...args])
  // `changes.commit()` resolves host git access itself (blocked mode here, no
  // credential registered) — its env carries no identity, so the repo needs
  // its own local config for `m.commit()`'s bare `git commit` to succeed.
  await gitDir('config', 'user.email', 't@t.test')
  await gitDir('config', 'user.name', 't')
  fs.writeFileSync(path.join(dir, 'file.txt'), 'content\n')
  await gitDir('add', '-A')

  await m.commit(WS, TASK, REPO, SECRET_MESSAGE)

  // The commit landed …
  const log = (await gitDir('log', '-1', '--format=%s')).stdout.trim()
  assert.equal(log, SECRET_MESSAGE, 'the commit itself carries the real message')

  // … but it must not be anywhere in gurt.log, including the proc.spawn
  // argv trace that runs at DBG (the level this test forces on).
  const logFile = path.join(process.env.GURT_ROOT, 'logs', 'gurt.log')
  const gurtLog = fs.readFileSync(logFile, 'utf8')
  assert.ok(!gurtLog.includes(SECRET_MESSAGE), 'commit message never appears in gurt.log')
  assert.ok(!gurtLog.includes('THIS-MESSAGE-CONTAINS-SENSITIVE-PROSE'), 'not even truncated/partial')

  // The commit's proc.spawn record must still exist, just opaque.
  const spawnLine = gurtLog
    .split('\n')
    .find((l) => l.includes('proc.spawn') && l.includes('"cmd":"git"') && l.includes('arg(s) [not logged]'))
  assert.ok(spawnLine, 'the commit spawn is still traced, with argv redacted to a count')

  console.log('commit-message-not-logged.test: PASS')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outfile, { force: true })
}
