// Tests for the logging core (src/main/log.ts) — no electron, no docker.
// Bundles the module with esbuild, then runs each scenario in its own child
// process (the log module is a singleton bound to one GURT_ROOT).
//
//   node scripts/log.test.mjs
//
// Covers the acceptance list of docs/logging.md: value-based redaction (1),
// ANSI + newline sanitization (3), drop accounting under a flood (4), rotation
// and the 6-file cap (5), and an unwritable log dir leaving the app usable (6).
import { test, after } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-log-test-'))
const bundle = path.join(tmp, 'log.mjs')
const runner = path.join(tmp, 'run.mjs')
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await build({
  stdin: {
    contents: `export * from ${S('src/main/log.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  mainFields: ['module', 'main'],
  outfile: bundle,
  logLevel: 'silent'
})

const ESC = '\u001b'

// Each scenario runs in a child: `node run.mjs <scenario>` with GURT_ROOT set.
fs.writeFileSync(
  runner,
  `
import fs from 'node:fs'
import path from 'node:path'
import * as L from ${JSON.stringify(bundle)}

const dir = path.join(process.env.GURT_ROOT, 'logs')
const appLog = path.join(dir, 'gurt.log')
// A sleep is only correct where the assertion is about something *not*
// happening (an unwritable sink, a paced flood). Everywhere else the records
// reach disk through an async queue with a single write in flight, so "the
// record landed" is a condition, not a duration — a fixed sleep is a race that
// a loaded machine loses, and the scenario then reads an empty file.
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms))
// Poll cond() until it returns something truthy, or give up at the deadline
// and let the caller's own assertion report what is actually on disk. Returns
// fast in the common case, so this costs nothing when the machine is idle.
const until = async (cond, timeout = 15000) => {
  const deadline = Date.now() + timeout
  for (;;) {
    const v = cond()
    if (v || Date.now() >= deadline) return v
    await new Promise((r) => setTimeout(r, 5))
  }
}
const read = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }
// The two shapes almost every scenario needs: wait for markers to show up in
// the app log, and wait for at least n records to be on disk.
const appHas = (...needles) => until(() => { const a = read(appLog); return needles.every((s) => a.includes(s)) ? a : '' })
const appLines = (n) => until(() => { const a = read(appLog); return a.split('\\n').filter(Boolean).length >= n ? a : '' })
const ESC = '\\u001b'
// fileId() appends a short hash of the raw key, so the exact file name isn't
// known ahead of time — find it by prefix instead of hardcoding it.
// The dir itself only appears when the first sink opens, so polling helpers
// must tolerate it not being there yet.
const ls = () => { try { return fs.readdirSync(dir) } catch { return [] } }
const findLog = (prefix) => ls().find((f) => f.startsWith(prefix) && f.endsWith('.log'))
const readLog = (prefix) => { const f = findLog(prefix); return f ? read(path.join(dir, f)) : '' }
const countLogs = (prefix) => ls().filter((f) => f.startsWith(prefix)).length

const scenarios = {
  async format() {
    // '>>>' / '???' force '+' and '/' into the base64 form, so its base64url
    // variant ('-' / '_') is a genuinely distinct string worth asserting on.
    const urlSecret = 'b64url>>>???secret99'
    L.addSecrets(['sup3r-secret-token-value', urlSecret])
    const l = L.createLogger('Sessions!')
    const b64 = Buffer.from('sup3r-secret-token-value', 'utf8').toString('base64')
    l.info('agent.spawn', {
      s: 'abc123',
      pid: 4242,
      multi: 'first\\nsecond\\ttab',
      colored: ESC + '[31mred' + ESC + '[0m',
      raw: 'x sup3r-secret-token-value y',
      b64: 'y ' + b64 + ' z',
      b64url: 'p ' + Buffer.from(urlSecret, 'utf8').toString('base64url') + ' q',
      url: 'https://user:hunter2@example.com/repo.git',
      token: 'never-shown',
      Authorization: 'Bearer nope',
      nested: { my_password: 'nope', ok: 1 }
    })
    l.warn('line\\nbreak ' + ESC + '[1mbold' + ESC + '[0m in message')
    l.debug('debug is below the default threshold')
    l.error('boom', { err: Object.assign(new Error('kaput'), { code: 'EACCES' }) })
    L.sessionLogLine('env-build:ws/env', 'building ' + ESC + '[32mok' + ESC + '[0m')
    L.sessionLogLine('sess-1', 'hello')
    await appLines(3)
    await until(() => readLog('session-sess-1-').includes('hello') && readLog('session-env-build') !== '')
    return {
      app: read(appLog),
      files: fs.readdirSync(dir).sort(),
      session: readLog('session-sess-1-')
    }
  },

  // 1. a secret used as the *scope* (only reachable via the untrusted
  // logRenderer IPC channel, or a main-process createLogger call) must be
  // redacted the same as a secret in msg/ctx — scopeName()'s char filter
  // only shapes the format, it was never a redaction step.
  async scopeSecret() {
    const secret = 'abc123secretvaluezzz9988'
    L.addSecrets([secret])
    L.logRenderer('info', secret, 'renderer.msg')
    L.createLogger(secret).info('main.msg')
    await appHas('renderer.msg', 'main.msg')
    return { app: read(appLog) }
  },

  async dropSession() {
    L.sessionLogLine('sess-1', 'hello')
    await until(() => findLog('session-sess-1-'))
    const before = Boolean(findLog('session-sess-1-'))
    L.dropSessionLog('sess-1')
    await until(() => !findLog('session-sess-1-'))
    return { before, after: Boolean(findLog('session-sess-1-')) }
  },

  // 8. distinct raw keys that collapse to the same sanitized id must not
  // share a file — the hash suffix in fileId() keeps them apart, and
  // dropSessionLog for one must not delete the other's file.
  async fileIdCollision() {
    L.sessionLogLine('env-build:ws/env', 'first')
    L.sessionLogLine('env-build-ws-env', 'second')
    await until(() => countLogs('session-env-build-ws-env') >= 2)
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('session-env-build-ws-env')).sort()
    L.dropSessionLog('env-build:ws/env')
    await until(() => countLogs('session-env-build-ws-env') < files.length)
    const after = fs.readdirSync(dir).filter((f) => f.startsWith('session-env-build-ws-env')).sort()
    return { files, after }
  },

  // Rotation at open: a file already over the limit is rotated before the first
  // append, and the .5 generation is dropped rather than growing to .6.
  async rotateAtOpen() {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(appLog, '')
    fs.truncateSync(appLog, 10 * 1024 * 1024 + 1)
    for (let i = 1; i <= 5; i++) fs.writeFileSync(appLog + '.' + i, 'gen' + i + '\\n')
    L.createLogger('app').info('app.start')
    await appHas('[app] app.start')
    return {
      files: fs.readdirSync(dir).sort(),
      fresh: read(appLog),
      gen: [1, 2, 3, 4, 5].map((i) => read(appLog + '.' + i).replace(/\\u0000/g, '').trim())
    }
  },

  // Rotation from writes: ~11 MB of records in bounded batches (the queue holds
  // 1000, so the writer has to keep up between them).
  async rotateOnWrite() {
    const l = L.createLogger('bulk')
    const pad = 'x'.repeat(500)
    const ctx = {}
    for (let i = 0; i < 15; i++) ctx['k' + i] = pad
    for (let round = 0; round < 40; round++) {
      for (let i = 0; i < 40; i++) l.info('bulk.record', ctx)
      await settle(20)
    }
    await until(() => fs.existsSync(appLog + '.1'))
    const size = fs.statSync(appLog).size
    return { rotated: fs.existsSync(appLog + '.1'), size, files: fs.readdirSync(dir).sort() }
  },

  // Bounded queue: a synchronous flood cannot be drained between calls, so the
  // overflow is dropped and reported as one log.dropped record.
  async queueFlood() {
    const l = L.createLogger('flood')
    for (let i = 0; i < 5000; i++) l.info('flood.record', { i })
    // The drop record is written by a later drain cycle than the batch it
    // reports, so its presence means the accepted records are already on disk.
    await appHas('log.dropped')
    const app = read(appLog)
    const m = app.match(/log\\.dropped \\{"n":(\\d+)\\}/)
    return { dropped: m ? Number(m[1]) : 0, lines: app.split('\\n').filter(Boolean).length }
  },

  // Renderer rate limit: >200 records in one window are dropped and counted.
  async rendererFlood() {
    L.logRenderer('nonsense', 'x', 'should be ignored')
    L.logRenderer('info', '', 'scope falls back')
    for (let i = 0; i < 1000; i++) L.logRenderer('info', 'Chat Pane', 'ui.click', { i })
    await appHas('log.dropped', '[renderer] scope falls back')
    const app = read(appLog)
    return {
      accepted: (app.match(/ui\\.click/g) ?? []).length,
      dropped: Number((app.match(/log\\.dropped \\{"n":(\\d+)\\}/) ?? [])[1] ?? 0),
      ignored: app.includes('should be ignored'),
      fallback: app.includes('[renderer] scope falls back'),
      renderTag: app.includes(' INF r [chat-pane] ui.click')
    }
  },

  // An unwritable log file must cost nothing but the log itself.
  async unwritable() {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(appLog, '')
    fs.chmodSync(appLog, 0o400)
    const l = L.createLogger('app')
    l.info('app.start')
    l.error('boom', { err: new Error('x') })
    await settle(150)
    l.info('still running')
    L.flushSync()
    await settle(50)
    return { alive: 2 + 2 === 4, size: fs.statSync(appLog).size }
  },

  async flushSync() {
    L.createLogger('app').info('app.quit')
    L.flushSync()
    return { app: read(appLog) }
  },

  async truncate() {
    L.createLogger('app').info('huge', { blob: 'y'.repeat(600), ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => ['k' + i, 'z'.repeat(500)])) })
    await appHas('[app] huge')
    const line = read(appLog).split('\\n')[0]
    return { len: line.length, oneLine: read(appLog).trim().split('\\n').length }
  },

  // 2. 'in RANK' walks the prototype chain — a level name that happens to be
  // an inherited Object property must be rejected, not treated as valid.
  async protoLevel() {
    L.logRenderer('constructor', 'x', 'renderer should not appear')
    L.logRenderer('__proto__', 'x', 'renderer should not appear either')
    L.logRenderer('toString', 'x', 'renderer should not appear toString')
    const l = L.createLogger('proto')
    l.info('control.record')
    await appHas('control.record')
    return { app: read(appLog) }
  },

  // 2. same bug, other call site: GURT_LOG resolving through the prototype
  // chain must not silently poison the level threshold.
  async envLevelPoison() {
    const l = L.createLogger('poison')
    l.info('control.record')
    await appHas('control.record')
    return { app: read(appLog), logLevel: L.logLevel }
  },

  // 3. ctx keys must go through the same sanitize/redact pass as values —
  // a secret used as a key, or a long/control-char key, must not ride
  // through untouched into JSON.stringify.
  async keyRedaction() {
    const secretKey = 'xk-supersecretkeyname1234567890'
    L.addSecrets([secretKey])
    const longKey = 'weird\\nkey\\t' + 'x'.repeat(100)
    const l = L.createLogger('keys')
    l.info('key.test', { [secretKey]: 1, [longKey]: 2 })
    await appHas('key.test')
    return { app: read(appLog) }
  },

  // 1. a secret positioned right at the pre-sanitize truncation boundary
  // must still be redacted whole, not sliced in half by the size guard.
  // ctx string values truncate to 512 (headroom cutoff 1536): a's pad puts
  // the secret's end well past 512 but well inside 1536, so it is fully
  // captured pre-sanitize and its [redacted] marker survives the final
  // 512-char slice (it lands before position 512).
  async recordBoundary() {
    const secret = 'xk-recordboundarysecretvalue0987654321' // 38 chars
    L.addSecrets([secret])
    const a = 'a'.repeat(480)
    const b = 'b'.repeat(1500) // total 480+38+1500=2018 > 1536 headroom cutoff
    const l = L.createLogger('rb')
    l.info('boundary.test', { v: a + secret + b })
    await appHas('[rb]')
    const app = read(appLog)
    const line = app.split('\\n').find((x) => x.includes('[rb]')) ?? ''
    return {
      hasSecret: app.includes(secret),
      hasRedacted: line.includes('[redacted]'),
      lineBytes: Buffer.byteLength(line, 'utf8')
    }
  },

  // 1. sanitize() must stay roughly linear — the old URL-creds regex
  // backtracked quadratically over a long match-free string.
  async perfSanitize() {
    const big = 'a'.repeat(1024 * 1024)
    const t0 = Date.now()
    L.sanitize(big)
    const ms = Date.now() - t0
    return { ms }
  },

  // A ctx object fanned out across levels (not just wide at one level) must
  // not multiply MAX_OBJECT_KEYS/MAX_ARRAY into exponential work: 64 keys of
  // 64 keys of 64 keys of ~500-char strings is ~262k leaf sanitize() calls
  // without a cross-level budget — measured at ~25s of synchronous main-
  // process time for a single record before the fix.
  async perfCtxBudget() {
    const leaf = () => 'x'.repeat(500)
    const level = (n, mk) => {
      const o = {}
      for (let i = 0; i < 64; i++) o['k' + i] = mk ? mk() : n
      return o
    }
    const ctx = level(null, () => level(null, () => level(null, leaf)))
    const t0 = Date.now()
    L.logRenderer('error', 'x', 'msg', ctx, Date.now())
    const ms = Date.now() - t0
    await appHas('[x] msg')
    const line = read(appLog).split('\\n').find((x) => x.includes('[x] msg')) ?? ''
    return { ms, recordBytes: Buffer.byteLength(line, 'utf8') }
  },

  // 6. RECORD_MAX is a byte budget, not a UTF-16 code-unit budget — a run of
  // multi-byte characters must not blow past it, and truncation must not
  // split a surrogate pair into a lone one.
  async byteTruncate() {
    const l = L.createLogger('bt')
    l.info('\\u4e2d'.repeat(3000)) // 3000 code units, 9000 UTF-8 bytes
    l.info('\\ud83d\\ude00'.repeat(3000)) // 6000 code units, 12000 UTF-8 bytes
    await until(() => read(appLog).split('\\n').filter((x) => x.includes('[bt]')).length >= 2)
    const lines = read(appLog).split('\\n').filter((x) => x.includes('[bt]'))
    const loneSurrogate = /[\\ud800-\\udbff](?![\\udc00-\\udfff])|(?:^|[^\\ud800-\\udbff])[\\udc00-\\udfff]/
    return {
      byteLens: lines.map((x) => Buffer.byteLength(x, 'utf8')),
      hasLoneSurrogate: lines.some((x) => loneSurrogate.test(x))
    }
  },

  // 7. openSync's mode only applies at creation — a pre-existing file with a
  // looser mode must be tightened on open, not left as-is forever.
  async fixMode() {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(appLog, '')
    fs.chmodSync(appLog, 0o644)
    L.createLogger('app').info('app.start')
    await appHas('[app] app.start')
    return { mode: fs.statSync(appLog).mode & 0o777 }
  },

  // 9. open session sinks must be capped — a long-lived process logging many
  // sessions over time must not accumulate one fd per session forever.
  async fdCap() {
    if (!fs.existsSync('/proc/self/fd')) return { skipped: true }
    const before = fs.readdirSync('/proc/self/fd').length
    for (let i = 0; i < 200; i++) L.sessionLogLine('fd-test-' + i, 'line ' + i)
    await until(() => countLogs('session-fd-test-') >= 200)
    const after = fs.readdirSync('/proc/self/fd').length
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('session-fd-test-')).length
    return { skipped: false, before, after, files }
  }
}

const out = await scenarios[process.argv[2]]()
process.stdout.write('\\u0001' + JSON.stringify(out))
`
)

let n = 0
function scenario(name, envOverrides = {}) {
  const root = path.join(tmp, `root-${++n}-${name}`)
  fs.mkdirSync(root)
  const res = spawnSync(process.execPath, [runner, name], {
    env: { ...process.env, GURT_ROOT: root, GURT_LOG: '', ...envOverrides },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })
  const out = res.stdout ?? ''
  const i = out.indexOf('\u0001')
  assert.ok(i >= 0, `${name} failed (${res.status}): ${out}\n${res.stderr}`)
  return { ...JSON.parse(out.slice(i + 1)), root, stdout: out.slice(0, i), stderr: res.stderr ?? '' }
}

after(() => fs.rmSync(tmp, { recursive: true, force: true }))

// --- 1. record format, sanitization, redaction ----------------------------
test('format · sanitization · redaction · modes', () => {
  const r = scenario('format')
  const lines = r.app.split('\n').filter(Boolean)
  assert.equal(lines.length, 3, 'one record per call, and debug is filtered')

  const [spawn, warn, err] = lines
  assert.match(
    spawn,
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z INF m \[sessions\] agent\.spawn \{/,
    'ts · level · process · [scope] · message · ctx'
  )
  // 3. a message carrying \n and ANSI stays one sanitized line
  assert.ok(!r.app.includes(ESC), 'ANSI escapes stripped everywhere')
  assert.match(warn, /WRN m \[sessions\] line\\nbreak bold in message$/)
  assert.ok(spawn.includes('"multi":"first\\\\nsecond\\\\ttab"'), 'ctx newlines escaped')

  // 1. value-based redaction: raw secret, its base64, and URL credentials
  assert.ok(!r.app.includes('sup3r-secret-token-value'), 'raw secret redacted')
  assert.ok(!r.app.includes(Buffer.from('sup3r-secret-token-value', 'utf8').toString('base64')))
  assert.ok(
    !r.app.includes(Buffer.from('b64url>>>???secret99', 'utf8').toString('base64url')),
    'base64url form redacted too'
  )
  assert.ok(!r.app.includes('hunter2'), 'URL credentials scrubbed')
  assert.ok(spawn.includes('https://[redacted]@example.com'))
  // key deny-list, at any depth, case-insensitive and by substring
  assert.ok(!r.app.includes('never-shown') && !r.app.includes('Bearer nope'))
  assert.ok(spawn.includes('"token":"[redacted]"') && spawn.includes('"Authorization":"[redacted]"'))
  assert.ok(spawn.includes('"nested":{"my_password":"[redacted]","ok":1}'))
  // err at ERR level carries name/message/code + stack
  assert.match(err, /ERR m \[sessions\] boom \{"err":\{"name":"Error","message":"kaput","code":"EACCES","stack":"/)

  // per-session files, named from the sanitized key plus a hash suffix (8),
  // never in the app log
  assert.equal(r.files.length, 3)
  assert.ok(r.files.includes('gurt.log'))
  assert.ok(r.files.some((f) => /^session-env-build-ws-env-[0-9a-f]{8}\.log$/.test(f)))
  assert.ok(r.files.some((f) => /^session-sess-1-[0-9a-f]{8}\.log$/.test(f)))
  assert.match(r.session, /^\d{4}-\d\d-\d\dT.*Z hello\n$/)
  assert.ok(!r.app.includes('building'), 'provisioning output never reaches the app log')
  assert.equal(fs.statSync(path.join(r.root, 'logs')).mode & 0o777, 0o700, 'dir mode 0700')
  assert.equal(fs.statSync(path.join(r.root, 'logs/gurt.log')).mode & 0o777, 0o600, 'file mode 0600')
})

// --- 1. a secret used as the scope is redacted, not just msg/ctx -----------
test('a secret used as the scope is redacted (logRenderer and createLogger)', () => {
  const r = scenario('scopeSecret')
  assert.ok(!r.app.includes('abc123secretvaluezzz9988'), 'the raw secret never appears via scope')
  assert.ok(r.app.includes('[redacted] renderer.msg'), 'logRenderer scope is redacted')
  assert.ok(r.app.includes('[redacted] main.msg'), 'createLogger scope is redacted too')
})

// --- session log deletion --------------------------------------------------
test('session log deleted with its session', () => {
  const r = scenario('dropSession')
  assert.equal(r.before, true)
  assert.equal(r.after, false, 'dropSessionLog removes the file')
})

// --- 8. fileId collision -----------------------------------------------
test('fileId collision (distinct hash suffix per raw key)', () => {
  const r = scenario('fileIdCollision')
  assert.equal(r.files.length, 2, 'distinct keys that sanitize to the same id get distinct files')
  assert.equal(r.after.length, 1, 'dropping one session file leaves the other in place')
})

// --- 5. rotation -----------------------------------------------------------
test('rotation at open · 6-file cap', () => {
  const r = scenario('rotateAtOpen')
  assert.deepEqual(
    r.files,
    ['gurt.log', 'gurt.log.1', 'gurt.log.2', 'gurt.log.3', 'gurt.log.4', 'gurt.log.5'],
    'at most 6 files — the oldest generation is dropped'
  )
  assert.deepEqual(r.gen, ['', 'gen1', 'gen2', 'gen3', 'gen4'], 'generations shift by one')
  assert.match(r.fresh, /INF m \[app\] app\.start\n$/, 'gurt.log is fresh')
})

test('rotation on write', () => {
  const r = scenario('rotateOnWrite')
  assert.equal(r.rotated, true, 'crossing 10 MB rotates')
  assert.ok(r.size < 10 * 1024 * 1024, 'gurt.log restarts small')
  assert.ok(fs.statSync(path.join(r.root, 'logs/gurt.log.1')).size >= 8 * 1024 * 1024)
  console.log(`rotation on write (gurt.log ${r.size} B after rotate)`)
})

// --- 4. drop accounting ----------------------------------------------------
test('bounded queue', () => {
  const r = scenario('queueFlood')
  assert.ok(r.dropped > 0, 'overflow is dropped')
  assert.ok(r.lines > 900 && r.lines < 5000, `bounded queue kept ${r.lines} records`)
  console.log(`bounded queue (${r.lines} written, log.dropped n=${r.dropped})`)
})

test('renderer transport', () => {
  const r = scenario('rendererFlood')
  assert.ok(r.accepted <= 200 && r.accepted > 0, `rate limit held at ${r.accepted}/s`)
  assert.ok(r.dropped >= 700, 'the rest is counted into log.dropped')
  assert.equal(r.ignored, false, 'an invalid level is dropped')
  assert.equal(r.renderTag, true, 'renderer records are tagged `r` with a sanitized scope')
  assert.equal(r.fallback, true, 'an empty scope falls back to [renderer]')
  console.log(`renderer transport (accepted ${r.accepted}, dropped ${r.dropped})`)
})

// --- 6. unwritable log directory ------------------------------------------
test('EACCES on the log file · app unaffected · one console report', {
  skip: process.getuid?.() === 0 ? 'running as root' : false
}, () => {
  const r = scenario('unwritable')
  assert.equal(r.alive, true, 'the app keeps running')
  assert.equal(r.size, 0, 'nothing was written')
  assert.match(r.stderr, /gurt: logging to .*gurt\.log disabled/, 'reported on the console')
  assert.equal((r.stderr.match(/logging to/g) ?? []).length, 1, 'reported exactly once')
})

// --- flushSync + record truncation ----------------------------------------
test('flushSync', () => {
  const r = scenario('flushSync')
  assert.match(r.app, /INF m \[app\] app\.quit\n$/, 'flushSync lands the queue synchronously')
})

test('8 KB record cap', () => {
  const r = scenario('truncate')
  assert.ok(r.len <= 8 * 1024, `record truncated to ${r.len} B`)
  assert.equal(r.oneLine, 1, 'still one line')
})

// --- 2. level checks use hasOwnProperty, not `in` -------------------------
test('logRenderer rejects prototype-chain level names', () => {
  const r = scenario('protoLevel')
  assert.ok(!r.app.includes('should not appear'), 'a prototype-chain level name is rejected, not treated as valid')
  assert.ok(!r.app.includes('[native code]'), 'no garbage level tag leaks into the record')
  assert.ok(r.app.includes('control.record'), 'normal logging still works')
})

test('envLevel() rejects prototype-chain level names too', () => {
  const r = scenario('envLevelPoison', { GURT_LOG: 'constructor' })
  assert.equal(r.logLevel, 'info', 'GURT_LOG=constructor (a prototype property name) falls back to the default level')
  assert.ok(r.app.includes('control.record'), 'logging still works at the fallback level')
})

// --- 3. ctx keys are sanitized and length-limited --------------------------
test('ctx keys go through the same sanitize/redact pipeline as values', () => {
  const r = scenario('keyRedaction')
  assert.ok(!r.app.includes('xk-supersecretkeyname1234567890'), 'a secret used as a ctx key is redacted, not just its value')
  assert.ok(r.app.includes('[redacted]'), 'the redacted key still appears as [redacted]')
  assert.ok(!r.app.includes('x'.repeat(100)), 'a very long ctx key is length-limited, not written in full')
})

// --- 1. secret at the pre-sanitize truncation boundary ----------------------
test('secret at the truncation boundary is not sliced in half', () => {
  const r = scenario('recordBoundary')
  assert.equal(r.hasSecret, false, 'a secret near the record-size truncation boundary is not sliced in half')
  assert.ok(r.hasRedacted, 'redaction still fires for a secret positioned right before the record limit')
  assert.ok(r.lineBytes > 0 && r.lineBytes <= 8 * 1024, 'the final record still respects the 8 KB byte cap')
})

// --- 1. sanitize() stays roughly linear -------------------------------------
test('sanitize() stays linear', () => {
  const r = scenario('perfSanitize')
  // What this guards is a complexity class, not a latency budget: the old
  // URL-creds regex backtracked quadratically and took >100 s on 1 MB, while
  // the linear scan lands in ~100 ms. There is no counter to assert on (the
  // work happens inside one regex), so this stays a wall-clock check — with a
  // threshold set far above any plausible shared-runner stall and far below
  // the bug, instead of a tight one that a loaded CI box trips on its own.
  assert.ok(r.ms < 30000, `sanitize() of a 1 MB string took ${r.ms} ms — the old backtracking regex took >100 s at this size`)
  console.log(`sanitize() stays linear (1 MB in ${r.ms} ms)`)
})

// --- a ctx fanned out across levels cannot blow up the walk -----------------
test('a fanned-out ctx is bounded by a shared budget', () => {
  const r = scenario('perfCtxBudget')
  // Same reasoning as perfSanitize: ~262k leaf sanitize() calls without a
  // cross-level budget measured at ~25 s, the budgeted walk at a few ms. The
  // threshold is deliberately three orders of magnitude above the healthy
  // value so that runner contention can never be mistaken for the bug.
  assert.ok(
    r.ms < 10000,
    `a ctx nested 3 levels deep (64x64x64) took ${r.ms} ms to serialize — a shared cross-level budget should bound this to a few ms, not the ~25 s a per-level-only cap allows`
  )
  assert.ok(r.recordBytes > 0 && r.recordBytes <= 8 * 1024, 'the record still respects the 8 KB byte cap')
  console.log(`a fanned-out ctx is bounded by a shared budget (${r.ms} ms, ${r.recordBytes} B)`)
})

// --- 6. byte-accurate record truncation -------------------------------------
test('multi-byte records are capped by bytes, not UTF-16 code units', () => {
  const r = scenario('byteTruncate')
  assert.ok(
    r.byteLens.length === 2 && r.byteLens.every((n) => n <= 8 * 1024),
    `every record respects the 8 KB byte cap even with multi-byte content: ${r.byteLens}`
  )
  assert.equal(r.hasLoneSurrogate, false, 'byte-accurate truncation never splits a surrogate pair into a lone one')
})

// --- 7. a pre-existing log file's mode is tightened on open -----------------
test('fchmodSync corrects a pre-existing log file mode', () => {
  const r = scenario('fixMode')
  assert.equal(r.mode, 0o600, 'a pre-existing gurt.log with a looser mode is tightened to 0600 on open')
})

// --- 9. open session sinks are capped ---------------------------------------
test('session sinks past the cap release their fd', (t) => {
  const r = scenario('fdCap')
  if (r.skipped) return t.skip('no /proc/self/fd on this platform')
  assert.equal(r.files, 200, 'every session still gets its file even once the open-sink cap evicts idle fds')
  assert.ok(r.after - r.before < 100, `open fd count stays bounded past 64 concurrent sessions (+${r.after - r.before})`)
  console.log(`session sinks past the cap release their fd (open fds +${r.after - r.before})`)
})
