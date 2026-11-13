// The review loop's check runner (src/main/reviewCheck.ts,
// docs/requirements-review-loop.md §5.3; acceptance §12 item 5), plain node on
// the host behind a fake exec (the login-shell argv spawned on the host), no
// docker. Pinned: bounded capture (a flood of output, a megabyte line), the
// result's code / ms / tail / timedOut, and that killing a check is stopping
// the container — on the timeout and on a cancel, through an injected stop and
// its inspect confirmation — with a distinct `unconfirmed` outcome when the
// stop cannot be confirmed. Nothing is ever executed in the container but the
// login shell (no wrapper, no pid file).
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
await bundle({ entryPoints: [path.join(ROOT, 'src/main/reviewCheck.ts')], outfile })
const { CheckRunner, LineRing, CHECK_TAIL } = await import(pathToFileURL(outfile).href)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-review-check-'))
const repoDir = path.join(tmp, 'workspaces')
for (const r of ['api', 'web']) fs.mkdirSync(path.join(repoDir, r), { recursive: true })
const procs = new Set() // every check shell a test started; "stopping the container" kills them
const killAll = () => {
  for (const c of procs) for (const t of [-c.pid, c.pid]) try { process.kill(t, 'SIGKILL') } catch { /* gone */ }
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
const until = async (f, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await f()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return false
}

/**
 * A runner over a fake container. `exec` runs the login-shell argv on the host,
 * detached, in the repo's directory under `tmp`; `stopContainer` kills every
 * shell it started (what `docker stop` does to the container) unless
 * `opts.stopFails`; `containerRunning` answers `opts.running` (default: false
 * once stopped, true before).
 */
function harness(opts = {}) {
  const h = {
    execs: [],
    stops: 0,
    inspects: 0,
    wakes: 0,
    stopped: false,
    runner: new CheckRunner({
      ensureContainerUp: async () => {
        h.wakes++
        if (opts.wakeError) throw new Error(opts.wakeError)
      },
      exec(argv, cwd) {
        h.execs.push({ argv, cwd })
        if (opts.execThrows) throw new Error('no such container')
        const child = spawn(argv[0], argv.slice(1), {
          cwd: path.join(repoDir, path.basename(cwd)), detached: true, stdio: ['ignore', 'pipe', 'pipe']
        })
        procs.add(child)
        return child
      },
      async stopContainer() {
        h.stops++
        if (opts.stopThrows) throw new Error('docker stop failed')
        if (!opts.stopFails) (h.stopped = true), killAll()
      },
      async containerRunning() {
        h.inspects++
        return opts.running !== undefined ? opts.running : !h.stopped
      },
      options: { timeoutMs: 20_000, exitWaitMs: 1000, ...opts.options }
    })
  }
  return h
}

/** A check that starts a marker, then sleeps; resolves with the shell's pid once running. */
const sleeper = (name) => `echo $$ > ${q(path.join(tmp, name))}; sleep 30`
const shellPid = async (name) => {
  const f = path.join(tmp, name)
  assert.ok(await until(() => fs.existsSync(f) && fs.readFileSync(f, 'utf8').trim() !== ''), 'the check started')
  return Number(fs.readFileSync(f, 'utf8'))
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

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

test('a result carries code, ms, tail, repo and command; the exec is the login shell in /workspaces/<repo> and nothing else', async () => {
  const h = harness()
  const run = await h.runner.run({ intent: nextId(), repo: 'web', command: 'echo out; echo err >&2; pwd; exit 3' })
  assert.equal(run.status, 'finished')
  const r = run.result
  assert.equal(r.repo, 'web')
  assert.equal(r.command, 'echo out; echo err >&2; pwd; exit 3')
  assert.equal(r.code, 3)
  assert.equal(r.timedOut, undefined)
  assert.ok(Number.isInteger(r.ms) && r.ms >= 0 && r.ms < 5000)
  assert.deepEqual([...r.tail].sort(), ['err', 'out', path.join(repoDir, 'web')].sort())
  // One exec, the login shell (`runScript`'s argv), cwd /workspaces/<repo>: no
  // wrapper, no pid file, no node script; a finished check is not terminated.
  assert.equal(h.execs.length, 1)
  assert.equal(h.execs[0].cwd, '/workspaces/web')
  assert.equal(h.execs[0].argv[0], 'sh')
  assert.match(h.execs[0].argv[2], /exec "\$sh_" -lc "\$0"/)
  assert.equal(h.execs[0].argv[3], 'echo out; echo err >&2; pwd; exit 3')
  assert.deepEqual([h.stops, h.inspects], [0, 0])
})

test('a green check, and a command that cannot even start (the shell\'s 127)', async () => {
  const h = harness()
  assert.equal((await h.runner.run({ intent: nextId(), repo: 'api', command: 'true' })).result.code, 0)
  assert.equal((await h.runner.run({ intent: nextId(), repo: 'api', command: 'no-such-command-xyz' })).result.code, 127)
})

test('invalid requests and an exec that cannot spawn are failed-to-run, with nothing stopped', async () => {
  const h = harness({ execThrows: true })
  for (const req of [{ intent: 'a b', repo: 'api' }, { intent: nextId(), repo: '..' }, { intent: nextId(), repo: 'api' }]) {
    const run = await h.runner.run({ command: 'true', ...req })
    assert.equal(run.status, 'failed-to-run')
  }
  assert.deepEqual([h.stops, h.inspects], [0, 0])
})

test('ensureContainerUp runs first and its failure means failed-to-run, with nothing executed', async () => {
  const h = harness({ wakeError: 'docker is down' })
  const run = await h.runner.run({ intent: nextId(), repo: 'api', command: 'true' })
  assert.equal(run.status, 'failed-to-run')
  assert.match(run.error, /docker is down/)
  assert.equal(h.execs.length, 0)
})

// ---------------------------------------------------------------------------
// killing a check = stopping the container (§5.3)

test('timeout stops the container, confirms it with an inspect, and the check dies with it', async () => {
  const h = harness({ options: { timeoutMs: 300 } })
  const res = await h.runner.run({ intent: nextId(), repo: 'api', command: `echo started; ${sleeper('t.pid')}` })
  assert.equal(res.status, 'stopped')
  assert.equal(res.reason, 'timeout')
  assert.equal(res.result.timedOut, true)
  assert.equal(res.result.code, -1)
  assert.deepEqual(res.result.tail, ['started'], 'the tail up to the kill is kept')
  assert.deepEqual([h.stops, h.inspects], [1, 1])
  assert.equal(alive(await shellPid('t.pid')), false)
})

test('cancel stops the container and confirms it; the run resolves stopped/cancel', async () => {
  const h = harness()
  const id = nextId()
  const run = h.runner.run({ intent: id, repo: 'api', command: sleeper('c.pid') })
  const pid = await shellPid('c.pid')
  assert.deepEqual(await h.runner.cancel(id), { ok: true })
  const res = await run
  assert.equal(res.status, 'stopped')
  assert.equal(res.reason, 'cancel')
  assert.equal(res.result.timedOut, undefined)
  assert.deepEqual([h.stops, h.inspects], [1, 1])
  assert.equal(alive(pid), false)
})

test('a timeout and a cancel at once share one stop; cancel with nothing running is a no-op', async () => {
  // The timeout must outlast the shell's start on a slow runner: 200 ms could
  // fire before the pid file was written, and the check was then killed
  // before `shellPid` could ever see it start.
  const h = harness({ options: { timeoutMs: 1500 } })
  const id = nextId()
  const run = h.runner.run({ intent: id, repo: 'api', command: sleeper('s.pid') })
  await shellPid('s.pid')
  const [a, b] = await Promise.all([h.runner.cancel(id), new Promise((r) => setTimeout(r, 1520)).then(() => h.runner.cancel(id))])
  assert.deepEqual([a, b], [{ ok: true }, { ok: true }])
  assert.equal(h.stops, 1, 'one docker stop')
  await run
  assert.deepEqual(await h.runner.cancel('nothing.running'), { ok: true })
  assert.equal(h.stops, 1)
})

test('cancel while the container is still waking wins: nothing is executed, nothing stopped', async () => {
  let wake
  const slowWake = new CheckRunner({
    ensureContainerUp: () => new Promise((r) => (wake = r)),
    exec: () => assert.fail('exec must not run'),
    stopContainer: async () => assert.fail('nothing was started'),
    containerRunning: async () => false
  })
  const id = nextId()
  const run = slowWake.run({ intent: id, repo: 'api', command: 'true' })
  assert.deepEqual(await slowWake.cancel(id), { ok: true })
  wake()
  const res = await run
  assert.equal(res.status, 'stopped')
  assert.equal(res.reason, 'cancel')
})

test('a stop that threw but left the container down is confirmed; one that returned but left it running is not', async () => {
  const threw = harness({ stopThrows: true, options: { timeoutMs: 200 } })
  const r1 = await threw.runner.run({ intent: nextId(), repo: 'api', command: 'sleep 30' })
  // `docker stop` threw, the inspect still says running → unconfirmed, and the detail names both.
  assert.equal(r1.status, 'unconfirmed')
  assert.match(r1.detail, /still running.*docker stop failed/)
  const gone = harness({ stopThrows: true, running: false, options: { timeoutMs: 200 } })
  assert.equal((await gone.runner.run({ intent: nextId(), repo: 'api', command: 'sleep 30' })).status, 'stopped')
})

test('a container that cannot be confirmed stopped is the distinct unconfirmed outcome, with the tail and the reason', async () => {
  for (const running of [true, null]) {
    const h = harness({ stopFails: true, running, options: { timeoutMs: 200 } })
    const res = await h.runner.run({ intent: nextId(), repo: 'api', command: 'echo hi; sleep 30' })
    assert.equal(res.status, 'unconfirmed')
    assert.equal(res.reason, 'timeout')
    assert.equal(res.result.timedOut, true)
    assert.deepEqual(res.result.tail, ['hi'])
    assert.match(res.detail, running === null ? /could not be inspected/ : /is still running/)
    assert.equal(h.stops, 1)
  }
  // A cancel reports the same through `cancel` and through the run.
  const h = harness({ stopFails: true, running: true })
  const id = nextId()
  const run = h.runner.run({ intent: id, repo: 'api', command: sleeper('u.pid') })
  await shellPid('u.pid')
  assert.equal((await h.runner.cancel(id)).ok, false)
  assert.equal((await run).status, 'unconfirmed')
})

test('boot: stopContainer stops and confirms, and an unconfirmable one says so', async () => {
  const ok = harness()
  assert.deepEqual(await ok.runner.stopContainer(), { ok: true })
  assert.deepEqual([ok.stops, ok.inspects], [1, 1])
  const bad = harness({ stopFails: true, running: true })
  assert.equal((await bad.runner.stopContainer()).ok, false)
})

test('nothing is executed in the container but the login shell: no file is ever written there', async () => {
  const h = harness({ options: { timeoutMs: 300 } })
  await h.runner.run({ intent: nextId(), repo: 'api', command: 'true' })
  await h.runner.run({ intent: nextId(), repo: 'api', command: 'sleep 30' })
  assert.ok(h.execs.length === 2 && h.execs.every((e) => e.argv[0] === 'sh' && !e.argv.includes('-e')), 'only login shells')
})
