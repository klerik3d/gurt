// Live smoke test of the logging wiring: launches the real app under Xvfb and
// checks what actually lands in ~/.gurt/logs/gurt.log — the startup banner, the
// IPC wrapper, the renderer transport (sanitization, redaction, rate limiting)
// and the crash/quit records.
//
//   SCRATCH=/tmp/gurt-log-smoke node scripts/smoke-logging.mjs
//
// Requires a display (DISPLAY=:99 by default), like the other smoke scripts.
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SCRATCH = process.env.SCRATCH ?? '/tmp/gurt-log-smoke'
const GURT_ROOT = path.join(SCRATCH, 'gurt-root')
fs.rmSync(SCRATCH, { recursive: true, force: true })
fs.mkdirSync(GURT_ROOT, { recursive: true })

// A credential the app loads at startup: every appearance of this value (raw or
// base64) must be redacted out of the log, wherever it later shows up.
const TOKEN = 'gurt-fake-token-A1B2C3D4E5F6'
const TOKEN_B64 = Buffer.from(TOKEN, 'utf8').toString('base64')
fs.writeFileSync(
  path.join(GURT_ROOT, 'credentials.json'),
  JSON.stringify(
    { credentials: [{ id: 'c1', label: 'smoke', kind: 'agent-token', hosts: [], data: { secret: TOKEN } }] },
    null,
    2
  )
)

const require = createRequire(path.join(APP_DIR, 'package.json'))
const { _electron } = require('playwright-core')
const electronPath = require('electron')

const env = { ...process.env, GURT_ROOT, DISPLAY: process.env.DISPLAY ?? ':99' }
delete env.ELECTRON_RUN_AS_NODE

const app = await _electron.launch({
  executablePath: electronPath,
  args: [APP_DIR, '--no-sandbox'],
  env,
  timeout: 30000
})
const page = await app.firstWindow()
await page.waitForSelector('.sidebar', { timeout: 15000 })

const ESC = '\u001b'
await page.evaluate(
  ([token, b64, esc]) => {
    // 3. a message with newlines and ANSI, plus 1. the secret in three shapes
    window.gurt.log('info', 'Smoke Pane!', `smoke.line\nsecond line ${esc}[31mred${esc}[0m`, {
      raw: token,
      b64,
      url: `https://user:${token}@example.com/repo.git`,
      token: 'deny-listed key',
      nested: { note: `inline ${token} inside` }
    })
    // an uncaught renderer error and an unhandled rejection
    setTimeout(() => {
      throw new Error('smoke renderer boom')
    }, 0)
    void Promise.reject(new Error('smoke renderer rejection'))
  },
  [TOKEN, TOKEN_B64, ESC]
)

// 4. flood the channel well past the 200/s budget — after the records above, so
// the rate limit drops the flood rather than them.
await new Promise((r) => setTimeout(r, 1200))
await page.evaluate(() => {
  for (let i = 0; i < 1200; i++) window.gurt.log('info', 'flood', 'ui.flood', { i })
})
await new Promise((r) => setTimeout(r, 1200))

// A failing IPC call — the wrapper records it as ipc.fail and rethrows.
const rejected = await page.evaluate(() =>
  window.gurt
    .createTask('no-such-workspace-here', '')
    .then(() => 'resolved')
    .catch((e) => String(e.message ?? e))
)
assert.ok(rejected !== 'resolved', 'createTask with an empty name must reject')

// ⌘K → "Open logs folder": the row is in the palette and the method is bridged.
const hasOpenLogs = await page.evaluate(() => typeof window.gurt.openLogsFolder === 'function')
assert.equal(hasOpenLogs, true, 'openLogsFolder is exposed on the bridge')
await page.keyboard.press('Control+k')
await page.waitForSelector('.palette', { timeout: 5000 })
const palette = await page.textContent('.pal-list')
assert.ok(palette.includes('Open logs folder'), 'the palette offers "Open logs folder"')
await page.keyboard.press('Escape')

await new Promise((r) => setTimeout(r, 1500))
await app.close()
await new Promise((r) => setTimeout(r, 500))

const logFile = path.join(GURT_ROOT, 'logs', 'gurt.log')
const log = fs.readFileSync(logFile, 'utf8')
const lines = log.split('\n').filter(Boolean)
const find = (re) => lines.filter((l) => re.test(l))

// --- startup banner -------------------------------------------------------
const start = find(/INF m \[app\] app\.start /)
assert.equal(start.length, 1, 'exactly one app.start record')
assert.match(start[0], /"gurt":"[\d.]+"/)
assert.match(start[0], /"electron":"[\d.]+"/)
assert.match(start[0], /"platform":"\w+-\w+"/)
// `dockerVersion()` is best-effort (src/main/provision.ts) — a sandbox with no
// daemon reachable is expected to report "unavailable", not fail the smoke test.
assert.match(start[0], /"docker":"(Docker version [^"]+|unavailable)"/)
assert.ok(start[0].includes(`"root":"${GURT_ROOT}"`))
console.log('ok  app.start banner:', start[0].slice(start[0].indexOf('{')))

// --- 3. one record per line, sanitized ------------------------------------
const smoke = find(/ \[smoke-pane\] smoke\.line/)
assert.equal(smoke.length, 1, 'the multi-line message is exactly one record')
assert.ok(smoke[0].includes('smoke.line\\nsecond line red'), 'newline escaped, ANSI stripped')
assert.ok(!log.includes(ESC), 'no ANSI escape survives anywhere in the log')
assert.match(smoke[0], / INF r \[smoke-pane\] /, 'tagged as a renderer record, scope sanitized')
console.log('ok  renderer record is one sanitized line')

// --- 1. redaction ---------------------------------------------------------
assert.ok(!log.includes(TOKEN), 'the raw credential never appears')
assert.ok(!log.includes(TOKEN_B64), 'nor its base64 encoding')
assert.ok(smoke[0].includes('"raw":"[redacted]"') && smoke[0].includes('"b64":"[redacted]"'))
assert.ok(smoke[0].includes('"token":"[redacted]"'), 'deny-listed key')
assert.ok(smoke[0].includes('"note":"inline [redacted] inside"'), 'redacted at depth')
console.log('ok  credential redacted (raw · base64 · in-URL · deny-listed key)')

// --- 4. flood -------------------------------------------------------------
const flood = find(/\[flood\] ui\.flood/)
const dropped = find(/\[log\] log\.dropped/)
assert.ok(flood.length <= 400, `rate limit held (${flood.length} of 1200 accepted)`)
assert.ok(dropped.length >= 1, 'the drops are reported')
console.log(`ok  renderer flood: ${flood.length} accepted, ${dropped[0].slice(dropped[0].indexOf('{'))}`)

// --- IPC wrapper + renderer error hooks -----------------------------------
const fail = find(/ERR m \[ipc\] ipc\.fail /)
assert.ok(
  fail.some((l) => l.includes('"method":"createTask"')),
  'the failing IPC call is recorded once, at the boundary'
)
assert.ok(find(/ERR r \[window\] window\.error/).length >= 1, 'window.onerror is captured')
assert.ok(
  find(/ERR r \[window\] window\.unhandledrejection/).length >= 1,
  'unhandledrejection is captured'
)
console.log('ok  ipc.fail · window.error · window.unhandledrejection')

// --- lifecycle ------------------------------------------------------------
assert.ok(find(/INF m \[app\] app\.quit/).length >= 1, 'app.quit is flushed on before-quit')
assert.equal(fs.statSync(logFile).mode & 0o777, 0o600, 'log file mode 0600')
assert.equal(fs.statSync(path.dirname(logFile)).mode & 0o777, 0o700, 'log dir mode 0700')
console.log('ok  app.quit flushed · 0700 dir · 0600 file')

console.log(`\nsmoke-logging: PASS (${lines.length} records in ${logFile})`)
