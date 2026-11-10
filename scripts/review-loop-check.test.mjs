// The review loop's check runner (src/main/reviewCheck.ts,
// docs/requirements-review-loop.md §5.3; acceptance §12 item 5), plain node on
// the host: the real wrapper and group-control scripts run under host node
// behind a fake exec (a spawn of the argv with gurt's node swapped for ours),
// no docker. Covers bounded capture (a flood of output, a megabyte line), the
// result's code / ms / tail / timedOut, the whole process group ending on
// timeout and on cancel — a backgrounded grandchild that ignores SIGTERM
// included, so the SIGKILL path runs and a separate probe confirms — the boot
// scan, a stale pid file never signalling a reused pid, and the distinct
// `unconfirmed` outcome.
//
//   node scripts/review-loop-check.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-review-loop-check-${process.pid}.mjs`)
await bundle({
  stdin: {
    contents: `export * from ${JSON.stringify(path.join(ROOT, 'src/main/reviewCheck.ts'))}\n` +
      `export { NODE_MOUNT } from ${JSON.stringify(path.join(ROOT, 'src/main/provision.ts'))}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})
const rc = await import(pathToFileURL(outfile).href)
const { CheckRunner, LineRing, CHECK_TAIL, WRAPPER_SOURCE, CTL_SOURCE, NODE_MOUNT } = rc

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-review-check-'))
const repoDir = path.join(tmp, 'workspaces')
const pids = new Set() // everything a test started, killed in `after`
/** SIGKILL a group and a pid; both may already be gone. */
function killAll() {
  for (const p of pids) {
    for (const target of [-p, p]) {
      try {
        process.kill(target, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }
}
after(() => {
  killAll()
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.rmSync(outfile, { force: true })
})

let seq = 0
const nextId = () => `ex.${process.pid}.${++seq}`
const NODE = process.execPath
// POSIX single-quote (a JSON string would turn a newline into a literal `\n` for the shell).
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

/** A process is alive if it exists and is not a zombie. */
function alive(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    return s.slice(s.lastIndexOf(')') + 2)[0] !== 'Z'
  } catch {
    return false
  }
}
const until = async (f, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await f()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return false
}

/**
 * A runner over a fake container. `exec` runs the argv on the host (gurt's node
 * path swapped for ours) and records each call: `wrapper` runs and the `ctl`
 * modes in order. `hook(mode)` may swallow a control exec (→ exit 0, no
 * output) or fail it.
 */
function harness(opts = {}) {
  const calls = []
  const h = {
    calls,
    up: true,
    wakes: 0,
    children: [],
    ctlModes: () => calls.filter((c) => c.kind === 'ctl').map((c) => c.mode),
    runner: new CheckRunner({
      ensureContainerUp: async () => {
        h.wakes++
        if (opts.wakeError) throw new Error(opts.wakeError)
      },
      isContainerUp: async () => h.up,
      exec(argv) {
        assert.equal(argv[0], opts.defaultNode ? NODE_MOUNT + '/bin/node' : NODE, 'the gurt node runs the scripts')
        assert.equal(argv[1], '-e', 'delivered as node -e, never as a file')
        const kind = argv[2] === WRAPPER_SOURCE ? 'wrapper' : argv[2] === CTL_SOURCE ? 'ctl' : 'other'
        assert.notEqual(kind, 'other')
        const payload = JSON.parse(argv[3])
        calls.push({ kind, mode: payload.mode, payload })
        if (kind === 'ctl' && opts.hook) {
          const r = opts.hook(payload.mode)
          if (r === 'swallow') return spawn(NODE, ['-e', ''], { stdio: ['ignore', 'pipe', 'pipe'] })
          if (r === 'fail') return spawn(NODE, ['-e', 'process.exit(1)'], { stdio: ['ignore', 'pipe', 'pipe'] })
          if (r === 'throw') throw new Error('no such container')
        }
        const wrapperPayload = kind === 'wrapper' ? { ...payload, cwd: path.join(repoDir, path.basename(payload.cwd)) } : null
        const real = wrapperPayload ? [argv[0], '-e', argv[2], JSON.stringify(wrapperPayload)] : argv
        const child = spawn(opts.defaultNode ? NODE : real[0], real.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
        if (kind === 'wrapper') h.children.push(child)
        return child
      },
      options: {
        nodeBin: opts.defaultNode ? undefined : NODE,
        tmpDir: tmp,
        timeoutMs: 20_000,
        graceMs: 600,
        pollMs: 40,
        confirmMs: 600,
        startWaitMs: 2000,
        ctlTimeoutMs: 5000,
        exitWaitMs: 1000,
        ...opts.options
      }
    })
  }
  return h
}
fs.mkdirSync(path.join(repoDir, 'api'), { recursive: true })
fs.mkdirSync(path.join(repoDir, 'web'), { recursive: true })

/** Shell snippet: a backgrounded node that ignores SIGTERM, its pid in `file`. */
const stubborn = (file) =>
  `${q(NODE)} -e ${q(`require('fs').writeFileSync(${q(file)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`)} &`
const pidOf = async (file) => {
  assert.ok(await until(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== ''), 'grandchild started')
  const pid = Number(fs.readFileSync(file, 'utf8'))
  pids.add(pid)
  return pid
}

// ---------------------------------------------------------------------------
// bounded capture

test('LineRing keeps 60 lines of at most 500 chars within 8 KB, and nothing else', () => {
  const r = new LineRing()
  for (let i = 0; i < 1000; i++) r.push(`line ${i}\n`)
  assert.equal(r.lines().length, CHECK_TAIL.lines)
  assert.equal(r.lines().at(-1), 'line 999')
  assert.equal(r.lines()[0], 'line 940')

  const wide = new LineRing()
  for (let i = 0; i < 100; i++) wide.push('x'.repeat(2000) + '\n')
  assert.ok(wide.lines().every((l) => l.length === 500), 'each line cut at 500')
  assert.ok(wide.bytes() <= CHECK_TAIL.bytes)
  assert.equal(wide.lines().length, 16, '8192 / 500')

  const multi = new LineRing() // 3-byte chars: 500 chars = 1500 bytes
  for (let i = 0; i < 50; i++) multi.push('€'.repeat(500) + '\n')
  assert.ok(multi.bytes() <= CHECK_TAIL.bytes)
  assert.ok(multi.lines().length >= 5)
})

test('LineRing: partial lines, split utf-8, CRLF, redraws, colour codes, a line with no end', () => {
  const r = new LineRing()
  const euro = Buffer.from('€')
  r.push(Buffer.concat([Buffer.from('a'), euro.subarray(0, 1)]))
  r.push(Buffer.concat([euro.subarray(1), Buffer.from('b\r\nprog 10%\rprog 50%\rprog 100%\n')]))
  r.push('\x1b[31mred\x1b[0m\n\n')
  r.push('tail without newline')
  r.end()
  assert.deepEqual(r.lines(), ['a€b', 'prog 100%', 'red', '', 'tail without newline'])

  const big = new LineRing() // 40 MB with no newline: nothing but 500 chars is held
  const chunk = Buffer.alloc(1 << 20, 'z')
  for (let i = 0; i < 40; i++) big.push(chunk)
  big.end()
  assert.deepEqual(big.lines(), ['z'.repeat(500)])
})

test('unbounded output stays bounded: a flood of lines and a giant unterminated line', async () => {
  const h = harness({ options: { timeoutMs: 60_000 } })
  // ~160 MB over 2M lines, then 32 MB with no newline, then a last line.
  const flood = `
    const line = 'out ' + 'y'.repeat(76) + '\\n'
    const block = line.repeat(1000)
    for (let i = 0; i < 2000; i++) process.stdout.write(block)
    for (let i = 0; i < 32; i++) process.stdout.write('Z'.repeat(1 << 20))
    process.stdout.write('\\nthe end\\n')`  // (no process.exit: it can drop queued pipe output)
  const before = process.memoryUsage().rss
  let peak = before
  const t = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 20)
  const run = await h.runner.run({ intent: nextId(), repo: 'api', command: `${q(NODE)} -e ${q(flood)}` })
  clearInterval(t)
  assert.equal(run.status, 'finished')
  assert.equal(run.result.code, 0)
  const tail = run.result.tail
  assert.ok(tail.length <= CHECK_TAIL.lines)
  assert.equal(tail.at(-1), 'the end')
  assert.equal(tail.at(-2), 'Z'.repeat(500), 'the 32 MB line is held as 500 chars')
  assert.ok(tail.every((l) => l.length <= CHECK_TAIL.lineChars))
  assert.ok(Buffer.byteLength(tail.join('\n')) <= CHECK_TAIL.bytes, '8 KB cap')
  assert.ok(peak - before < 96 * 1024 * 1024, `host memory grew by ${((peak - before) / 1048576) | 0} MB`)
})

// ---------------------------------------------------------------------------
// the result

test('a result carries code, ms, tail, timedOut, repo and command; the shell is the login shell in /workspaces/<repo>', async () => {
  const h = harness()
  const id = nextId()
  const run = await h.runner.run({ intent: id, repo: 'web', command: 'echo out; echo err >&2; pwd; exit 3' })
  assert.equal(run.status, 'finished')
  assert.equal(run.leftover, undefined)
  const r = run.result
  assert.equal(r.repo, 'web')
  assert.equal(r.command, 'echo out; echo err >&2; pwd; exit 3')
  assert.equal(r.code, 3)
  assert.equal(r.timedOut, undefined)
  assert.ok(Number.isInteger(r.ms) && r.ms >= 0 && r.ms < 5000)
  assert.deepEqual([...r.tail].sort(), ['err', 'out', path.join(repoDir, 'web')].sort())
  // The wrapper got a login-shell argv and /workspaces/<repo> as its cwd.
  const w = h.calls.find((c) => c.kind === 'wrapper').payload
  assert.equal(w.cwd, '/workspaces/web')
  assert.equal(w.argv[0], 'sh')
  assert.match(w.argv[2], /exec "\$sh_" -lc "\$0"/)
  assert.equal(w.argv[3], 'echo out; echo err >&2; pwd; exit 3')
  assert.equal(w.file, path.join(tmp, `gurt-check-${id}.pid`))
  // The group id was recorded; the confirming probe cleared the file.
  assert.deepEqual(h.ctlModes(), ['probe'])
  assert.equal(fs.existsSync(w.file), false)
})

test('green check, signal death (128 + n), and a command that cannot even start', async () => {
  const h = harness()
  assert.equal((await h.runner.run({ intent: nextId(), repo: 'api', command: 'true' })).result.code, 0)
  const killed = await h.runner.run({ intent: nextId(), repo: 'api', command: 'kill -9 $$' })
  assert.equal(killed.status, 'finished')
  assert.equal(killed.result.code, 137)
  const none = await h.runner.run({ intent: nextId(), repo: 'api', command: 'no-such-command-xyz' })
  assert.equal(none.result.code, 127)
})

test('the default wiring runs gurt\'s own node: /opt/gurt/node/bin/node', async () => {
  const calls = []
  const runner = new CheckRunner({
    ensureContainerUp: async () => {},
    exec(argv) {
      calls.push(argv)
      return spawn(NODE, ['-e', "process.stdout.write('none\\n')"], { stdio: ['ignore', 'pipe', 'pipe'] })
    },
    options: { pollMs: 10 }
  })
  await runner.run({ intent: nextId(), repo: 'api', command: 'true' })
  assert.equal(NODE_MOUNT, '/opt/gurt/node')
  assert.ok(calls.length >= 1 && calls.every((a) => a[0] === '/opt/gurt/node/bin/node' && a[1] === '-e'))
})

test('ensureContainerUp runs first and its failure means failed-to-run, with nothing executed', async () => {
  const h = harness({ wakeError: 'docker is not running' })
  const run = await h.runner.run({ intent: nextId(), repo: 'api', command: 'true' })
  assert.equal(run.status, 'failed-to-run')
  assert.match(run.error, /docker is not running/)
  assert.equal(h.calls.length, 0)

  const ok = harness()
  for (const bad of [{ intent: '../x', repo: 'api' }, { intent: 'a b', repo: 'api' }, { intent: nextId(), repo: '../etc' }, { intent: nextId(), repo: 'a/b' }]) {
    assert.equal((await ok.runner.run({ ...bad, command: 'true' })).status, 'failed-to-run')
  }
  assert.equal(ok.wakes, 0, 'invalid requests never wake the container')
  assert.equal(ok.calls.length, 0)

  const r2 = new CheckRunner({
    ensureContainerUp: async () => {},
    exec: () => { throw new Error('docker: not found') },
    options: { nodeBin: NODE, tmpDir: tmp }
  })
  assert.match((await r2.run({ intent: nextId(), repo: 'api', command: 'true' })).error, /docker: not found/)
})

// ---------------------------------------------------------------------------
// termination

test('timeout ends the whole group — a TERM-ignoring backgrounded grandchild included — and a separate probe confirms', async () => {
  const gc = path.join(tmp, 'gc-timeout')
  const h = harness({ options: { timeoutMs: 700 } })
  const run = h.runner.run({ intent: nextId(), repo: 'api', command: `${stubborn(gc)}\necho started\nsleep 300` })
  const res = await run
  const grandchild = Number(fs.readFileSync(gc, 'utf8'))
  pids.add(grandchild)
  assert.equal(res.status, 'stopped')
  assert.equal(res.reason, 'timeout')
  assert.equal(res.result.timedOut, true)
  assert.equal(res.result.code, -1)
  assert.ok(res.result.ms >= 700 && res.result.ms < 10_000)
  assert.deepEqual(res.result.tail, ['started'])
  assert.equal(alive(grandchild), false, 'the grandchild that ignores SIGTERM is dead')
  const modes = h.ctlModes()
  assert.ok(modes.includes('term') && modes.includes('kill'), `SIGTERM then SIGKILL: ${modes}`)
  assert.ok(modes.indexOf('term') < modes.indexOf('kill'))
  assert.equal(modes.at(-1), 'probe', 'a probe, its own exec, comes last')
  assert.ok(modes.slice(modes.indexOf('kill')).includes('probe'))
  assert.equal(fs.readdirSync(tmp).filter((f) => f.startsWith('gurt-check-')).length, 0, 'no pid file left')
})

test('a group that obeys SIGTERM is not SIGKILLed — the probe ends the grace early', async () => {
  const h = harness({ options: { timeoutMs: 500, graceMs: 5000 } })
  const t0 = Date.now()
  const res = await h.runner.run({ intent: nextId(), repo: 'api', command: 'sleep 300 & sleep 300' })
  assert.equal(res.status, 'stopped')
  assert.ok(Date.now() - t0 < 4000, 'did not sit out the 5 s grace')
  assert.ok(!h.ctlModes().includes('kill'))
})

test('cancel ends the whole group and confirms; the run resolves as stopped/cancel', async () => {
  const gc = path.join(tmp, 'gc-cancel')
  const h = harness()
  const id = nextId()
  const run = h.runner.run({ intent: id, repo: 'api', command: `${stubborn(gc)}\necho up\nsleep 300 &\nwait` })
  const grandchild = await pidOf(gc)
  assert.ok(await until(() => fs.existsSync(path.join(tmp, `gurt-check-${id}.pid`))))
  const [pgid] = fs.readFileSync(path.join(tmp, `gurt-check-${id}.pid`), 'utf8').split(' ')
  pids.add(Number(pgid))
  const t = await h.runner.terminate(id)
  assert.deepEqual(t, { ok: true })
  assert.equal(alive(grandchild), false)
  assert.equal(alive(Number(pgid)), false, 'the shell is gone too')
  const res = await run
  assert.equal(res.status, 'stopped')
  assert.equal(res.reason, 'cancel')
  assert.equal(res.result.timedOut, undefined)
  assert.ok(h.ctlModes().includes('kill'))
  assert.equal(h.ctlModes().at(-1), 'probe')
})

test('cancel while the container is still waking wins: nothing is executed', async () => {
  let wake
  const h = harness()
  h.runner.deps.ensureContainerUp = () => new Promise((r) => (wake = r))
  const id = nextId()
  const run = h.runner.run({ intent: id, repo: 'api', command: 'sleep 300' })
  assert.deepEqual(await h.runner.terminate(id), { ok: true })
  wake()
  const res = await run
  assert.equal(res.status, 'stopped')
  assert.equal(res.reason, 'cancel')
  assert.equal(h.calls.length, 0, 'the check never started')
})

test('cancel right after the exec was spawned, before the wrapper wrote its pid file, still ends the group', async () => {
  const h = harness()
  const id = nextId()
  const gc = path.join(tmp, 'gc-early')
  const run = h.runner.run({ intent: id, repo: 'api', command: `${stubborn(gc)}\nsleep 300` })
  assert.ok(await until(() => h.calls.some((c) => c.kind === 'wrapper')))
  const t = await h.runner.terminate(id)
  assert.deepEqual(t, { ok: true })
  const res = await run
  assert.equal(res.status, 'stopped')
  // Either the cancel waited for the pid file and killed the group, or the
  // wrapper never got to start the shell; in neither case is anything left.
  if (fs.existsSync(gc) && fs.readFileSync(gc, 'utf8')) assert.equal(alive(await pidOf(gc)), false)
  assert.deepEqual(fs.readdirSync(tmp).filter((f) => f.startsWith(`gurt-check-${id}`)), [])
})

test('a check that exits but leaves a background process: found by the confirming probe, terminated', async () => {
  const gc = path.join(tmp, 'gc-leftover')
  const h = harness()
  const res = await h.runner.run({ intent: nextId(), repo: 'api', command: `${stubborn(gc)}\necho done` })
  const grandchild = await pidOf(gc)
  assert.equal(res.status, 'finished')
  assert.equal(res.leftover, true)
  assert.equal(res.result.code, 0)
  assert.deepEqual(res.result.tail, ['done'])
  assert.equal(alive(grandchild), false)
  assert.ok(h.ctlModes().includes('kill'))
})

test('terminate on an intent with nothing running, and on a down container, is a no-op that succeeds', async () => {
  const h = harness()
  assert.deepEqual(await h.runner.terminate(nextId()), { ok: true })
  assert.deepEqual(h.ctlModes(), ['probe'])
  h.up = false
  const n = h.calls.length
  assert.deepEqual(await h.runner.terminate(nextId()), { ok: true })
  assert.equal(h.calls.length, n, 'a stopped container is not exec-ed into')
  assert.deepEqual((await h.runner.scanLeftovers()).found, [])
  assert.equal(h.calls.length, n)
  assert.deepEqual(await h.runner.terminate('../bad'), { ok: false, detail: 'invalid check intent id "../bad"' })
})

// ---------------------------------------------------------------------------
// the boot scan

test('boot scan lists /tmp/gurt-check-*.pid and terminates each leftover group, a TERM-ignoring one included', async () => {
  const gc = path.join(tmp, 'gc-boot')
  // The previous app run: a check started, then the host vanished (the docker
  // client — here the wrapper — died; the shell and its group live on).
  const old = harness({ hook: () => 'fail' }) // …and it cannot act on the group any more
  const id = nextId()
  const oldRun = old.runner.run({ intent: id, repo: 'api', command: `${stubborn(gc)}\nsleep 300` })
  const grandchild = await pidOf(gc)
  assert.ok(await until(() => fs.existsSync(path.join(tmp, `gurt-check-${id}.pid`))))
  const [pgid] = fs.readFileSync(path.join(tmp, `gurt-check-${id}.pid`), 'utf8').split(' ')
  pids.add(Number(pgid))
  old.children[0].kill('SIGKILL')
  assert.equal((await oldRun).status, 'unconfirmed')
  assert.equal(alive(grandchild), true, 'killing the wrapper leaves the check running')

  // A dead group's file, and a file from some other container instance whose
  // pgid now names an unrelated live process: neither may signal anything.
  const innocent = spawn(NODE, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  pids.add(innocent.pid)
  fs.writeFileSync(path.join(tmp, 'gurt-check-dead.1.pid'), '99999999 \n')
  fs.writeFileSync(path.join(tmp, 'gurt-check-stale.1.pid'), `${innocent.pid} 123456789\n`)
  fs.writeFileSync(path.join(tmp, 'not-ours.pid'), '1\n')

  const boot = harness()
  const scan = await boot.runner.scanLeftovers()
  assert.deepEqual([...scan.found].sort(), [id, 'dead.1', 'stale.1'].sort())
  assert.deepEqual([...scan.cleared].sort(), [...scan.found].sort())
  assert.deepEqual(scan.unconfirmed, [])
  assert.equal(alive(grandchild), false)
  assert.equal(alive(Number(pgid)), false)
  assert.equal(alive(innocent.pid), true, 'a stale pid file never signals a reused pid')
  assert.deepEqual(fs.readdirSync(tmp).filter((f) => f.startsWith('gurt-check-') && f.endsWith('.pid')), [])
  assert.ok(fs.existsSync(path.join(tmp, 'not-ours.pid')))
  assert.ok(boot.ctlModes().includes('kill'))
  assert.equal((await boot.runner.scanLeftovers()).found.length, 0, 'second scan finds nothing')
})

// ---------------------------------------------------------------------------
// unconfirmable

test('a group that cannot be stopped resolves unconfirmed — a distinct outcome, after the confirmation window', async () => {
  const gc = path.join(tmp, 'gc-stuck')
  // The signals never arrive (a hung exec, a container that swallows them).
  const h = harness({ options: { timeoutMs: 400, graceMs: 200, confirmMs: 300 }, hook: (m) => (m === 'term' || m === 'kill' ? 'swallow' : undefined) })
  const t0 = Date.now()
  const res = await h.runner.run({ intent: nextId(), repo: 'api', command: `${stubborn(gc)}\nsleep 300` })
  const grandchild = await pidOf(gc)
  assert.equal(res.status, 'unconfirmed')
  assert.match(res.detail, /still running after SIGKILL/)
  assert.equal(res.result.timedOut, true)
  assert.ok(Date.now() - t0 >= 400 + 200 + 300 - 50, 'waited out grace and confirmation before giving up')
  assert.equal(alive(grandchild), true, 'it really is still there')
  assert.equal(h.ctlModes().at(-1), 'probe')
  const id = /gurt-check-(.+)\.pid/.exec(h.calls.find((c) => c.kind === 'wrapper').payload.file)[1]
  assert.equal((await h.runner.terminate(id)).ok, false, 'terminate() on a leftover reports it too')
  killAll()
})

test('a probe that cannot run is not a confirmation: control execs failing or throwing → unconfirmed', async () => {
  for (const how of ['fail', 'throw']) {
    const h = harness({ options: { timeoutMs: 300, graceMs: 100, confirmMs: 150 }, hook: (m) => (m === 'probe' ? undefined : how) })
    // probe works until the stop: break it after the first probe by counting.
    let probes = 0
    const base = h.runner.deps.exec
    h.runner.deps.exec = (argv) => {
      if (argv[2] === CTL_SOURCE && JSON.parse(argv[3]).mode === 'probe' && ++probes > 1) return how === 'throw' ? (() => { throw new Error('gone') })() : spawn(NODE, ['-e', 'process.exit(1)'], { stdio: ['ignore', 'pipe', 'pipe'] })
      return base(argv)
    }
    const gc = path.join(tmp, `gc-probe-${how}`)
    const res = await h.runner.run({ intent: nextId(), repo: 'api', command: `${stubborn(gc)}\nsleep 300` })
    assert.equal(res.status, 'unconfirmed', how)
    assert.match(res.detail, /unverifiable|still running/)
    killAll()
  }
})

test('the wrapper exits with the shell even when a backgrounded child holds the output pipes open', async () => {
  const h = harness()
  const t0 = Date.now()
  const res = await h.runner.run({ intent: nextId(), repo: 'api', command: 'sleep 30 & echo fast; exit 2' })
  assert.equal(res.result.code, 2)
  assert.deepEqual(res.result.tail, ['fast'])
  assert.ok(Date.now() - t0 < 5000, 'did not wait for the background sleep')
  assert.equal(res.leftover, true)
})
