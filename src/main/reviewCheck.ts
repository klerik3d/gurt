// The review loop's check runner (docs/requirements-review-loop.md §5.3, §12
// item 5): runs one repo's `check` command in the executor's container, as the
// container user, from /workspaces/<repo>, through the login shell like the
// env's `setup` script (`runScript`, provision.ts) — but not through
// `dockerExec`: that accumulates all stdout in memory, and its timeout kills
// only the host's docker CLI, which stops nothing inside the container.
//
// Three things make the run safe to wait on unattended:
//
//  1. A process group. A small wrapper (WRAPPER_SOURCE) runs on gurt's own node
//     inside the container, starts the shell `detached` (its own group), writes
//     the group id to `/tmp/gurt-check-<intent>.pid`, relays the output and
//     exits with the shell's code. The wrapper is *not* in the group, so
//     killing the docker client or the wrapper leaves the check running — and
//     findable by the pid file (boot scan).
//  2. Bounded capture. The host keeps a ring of the last 60 lines (≤ 500 chars
//     each, ≤ 8 KB) and nothing else, however much the command prints.
//  3. Confirmed termination. SIGTERM to the group, a grace, SIGKILL, then a
//     separate exec confirms nothing of the group is left; only then does the
//     promise resolve as stopped. Unconfirmable resolves a distinct status
//     (`unconfirmed`) — the controller turns that into "stop the executor's
//     container, end `failed`"; this module does not do that end.
//
// Everything that touches a container is injected (`CheckDeps`), so the tests
// run the very same wrapper under plain host node with a fake exec. Both
// scripts are delivered as `node -e <source>` — nothing is written into the
// repo, the clone or the image.
import { StringDecoder } from 'node:string_decoder'
import { REVIEW_LOOP, type CheckResult } from '../shared/reviewLoop'
import { NODE_MOUNT, loginShell } from './provision'

// --- bounded capture (§5.3) -------------------------------------------------

export const CHECK_TAIL = { lines: 60, lineChars: 500, bytes: 8 * 1024 } as const

// CSI sequences and the C0 controls a test runner's colours and spinners leave.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

/** The last {@link CHECK_TAIL} lines of a byte stream, and nothing else: the
 *  partial line is capped as it grows (a megabyte line without a newline costs
 *  500 chars), the ring drops its oldest line past 60 lines or 8 KB. A lone
 *  `\r` (a progress bar redrawing itself) keeps the last redraw. */
export class LineRing {
  private ring: string[] = []
  private size = 0
  private partial = ''
  private readonly dec = new StringDecoder('utf8')

  push(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : this.dec.write(chunk)
    let from = 0
    for (;;) {
      const nl = text.indexOf('\n', from)
      if (nl < 0) {
        this.append(text.slice(from))
        return
      }
      this.append(text.slice(from, nl))
      this.endLine()
      from = nl + 1
    }
  }

  /** Flush the unterminated last line; call once, when the stream has closed. */
  end(): void {
    this.append(this.dec.end())
    if (this.partial !== '') this.endLine()
  }

  lines(): string[] {
    return [...this.ring]
  }

  /** UTF-8 bytes held — never more than {@link CHECK_TAIL}.bytes. */
  bytes(): number {
    return this.size
  }

  private append(s: string): void {
    if (s === '') return
    // A `\r` with text after it is a redraw: what came before is gone. (`s`
    // never holds a `\n`; a trailing `\r` is the `\r\n` of the line's end.)
    const cr = s.lastIndexOf('\r')
    if (cr >= 0 && cr < s.length - 1) {
      this.partial = ''
      s = s.slice(cr + 1)
    }
    if (this.partial.length < CHECK_TAIL.lineChars) this.partial = (this.partial + s).slice(0, CHECK_TAIL.lineChars)
  }

  private endLine(): void {
    const line = this.partial.replace(/\r+$/, '').replace(ANSI, '').replace(CONTROL, '')
    this.partial = ''
    this.ring.push(line)
    this.size += Buffer.byteLength(line)
    while (this.ring.length > CHECK_TAIL.lines || this.size > CHECK_TAIL.bytes) {
      const old = this.ring.shift()
      if (old === undefined) break
      this.size -= Buffer.byteLength(old)
    }
  }
}

// --- the two scripts that run inside the container ---------------------------

// Both run as `node -e <source> <json>`: plain CommonJS, node builtins only, so
// the same text runs under the container's /opt/gurt/node and the host's node
// in tests. The pid file holds `<pgid> <init start>`: /proc/1's start time
// changes with every container start, so a file left by an earlier container
// instance (whose pids may since have been reused by something unrelated) is
// recognised as stale and never signalled.
const PROC_HELPERS = `
const fs = require('fs')
function initStart() {
  try {
    const s = fs.readFileSync('/proc/1/stat', 'utf8')
    return s.slice(s.lastIndexOf(')') + 2).split(' ')[19] || ''
  } catch { return '' }
}
`

/** The wrapper (§5.3). argv[1] = JSON `{ file, cwd, argv }`. Exit code = the
 *  shell's (128 + n when a signal ended it; 127 when it cannot start). */
export const WRAPPER_SOURCE =
  PROC_HELPERS +
  `
const cp = require('child_process')
const os = require('os')
const p = JSON.parse(process.argv[1])
const c = cp.spawn(p.argv[0], p.argv.slice(1), { cwd: p.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
let done = false
function finish(code) {
  if (done) return
  done = true
  process.stdout.write('', () => process.exit(code))
}
c.on('error', (e) => {
  process.stderr.write('gurt-check: cannot start the shell: ' + e.message + '\\n')
  finish(127)
})
if (c.pid) fs.writeFileSync(p.file, c.pid + ' ' + initStart() + '\\n')
c.stdout.pipe(process.stdout, { end: false })
c.stderr.pipe(process.stdout, { end: false })
c.on('exit', (code, signal) => {
  const exit = code !== null ? code : 128 + (os.constants.signals[signal] || 0)
  // A backgrounded child can hold the pipes open past the shell: take what has
  // arrived, don't wait for it.
  let closed = 0
  const one = () => { if (++closed === 2) finish(exit) }
  c.stdout.on('close', one)
  c.stderr.on('close', one)
  setTimeout(() => finish(exit), 200)
})
`

/** The group control script. argv[1] = JSON `{ dir, file?, mode }`;
 *  modes `probe` → none|alive|gone, `term`/`kill` → sent|none|gone|denied,
 *  `list` → the leftover pid files' names, one per line. Liveness counts the
 *  group's non-zombie members from /proc (a zombie is dead; `kill(-pgid, 0)`
 *  still answers for it), falling back to `kill(-pgid, 0)` without /proc. */
export const CTL_SOURCE =
  PROC_HELPERS +
  `
const q = JSON.parse(process.argv[1])
function members(pgid) {
  let names
  try { names = fs.readdirSync('/proc') } catch { return null }
  let n = 0
  for (const name of names) {
    if (!/^\\d+$/.test(name)) continue
    try {
      const s = fs.readFileSync('/proc/' + name + '/stat', 'utf8')
      const r = s.slice(s.lastIndexOf(')') + 2).split(' ')
      if (Number(r[2]) === pgid && r[0] !== 'Z') n++
    } catch {}
  }
  return n
}
function alive(pgid) {
  const m = members(pgid)
  if (m !== null) return m > 0
  try { process.kill(-pgid, 0); return true } catch (e) { return e.code === 'EPERM' }
}
function drop() { try { fs.unlinkSync(q.file) } catch {} }
if (q.mode === 'list') {
  let names = []
  try { names = fs.readdirSync(q.dir) } catch {}
  process.stdout.write(names.filter((n) => /^gurt-check-.+\\.pid$/.test(n)).join('\\n') + '\\n')
} else {
  let raw
  try { raw = fs.readFileSync(q.file, 'utf8') } catch { process.stdout.write('none\\n'); process.exit(0) }
  const [g, start] = raw.trim().split(' ')
  const pgid = Number(g)
  if (!(pgid > 1) || (start && start !== initStart())) { drop(); process.stdout.write('gone\\n'); process.exit(0) }
  if (q.mode === 'probe') {
    if (alive(pgid)) process.stdout.write('alive\\n')
    else { drop(); process.stdout.write('gone\\n') }
  } else {
    try { process.kill(-pgid, q.mode === 'term' ? 'SIGTERM' : 'SIGKILL'); process.stdout.write('sent\\n') }
    catch (e) { process.stdout.write((e.code === 'ESRCH' ? 'gone' : 'denied') + '\\n') }
  }
}
`

// --- the runner --------------------------------------------------------------

/** The slice of a `child_process` child the runner uses — `spawnDockerExec`'s
 *  return value satisfies it. */
export interface ExecChild {
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'close', cb: (code: number | null) => void): unknown
  on(event: 'error', cb: (e: Error) => void): unknown
}

/**
 * What the runner needs from its host (slice 6 wires the real ones; tests pass
 * a fake that runs the argv under host node).
 *
 *  - `exec(argv)`: spawn `argv` in the session's container as the container
 *    user, without a tty, no stdin, and return the child. Real wiring:
 *    `spawnDockerExec(target, argv, {}, { interactive: false })` with
 *    `target` = the container's current exec target (the record's id, user and
 *    PATH — `ContainerManager.execTarget` is private today and needs a public
 *    accessor). Resolve the target *per call*: the container may have been
 *    recreated since the runner was built. It may throw (no such container).
 *  - `ensureContainerUp()`: wake the executor's container before a check, without
 *    attaching the agent. Real wiring: a `SessionManager` method that applies
 *    the same `repoConflict` gate a resume does (the loop hold makes the
 *    executor its own clone's holder) and then calls
 *    `ContainerManager.resolveLaunch(id)` — see "As built" for why not the bare
 *    `containers.ensure(id)`. Rejecting = the check cannot run.
 *  - `isContainerUp()` (optional): whether the container is running *now*,
 *    without waking it. Terminating or scanning a container that is down needs
 *    no exec: stopping it ended every process in it. Without it, a down
 *    container surfaces as failing execs → `unconfirmed`.
 */
export interface CheckDeps {
  exec(argv: string[]): ExecChild
  ensureContainerUp(): Promise<void>
  isContainerUp?(): Promise<boolean>
  /** Test seams; the defaults are the spec's numbers. */
  options?: Partial<CheckOptions>
}

export interface CheckOptions {
  /** The gurt node in the container; `NODE_MOUNT/bin/node`. */
  nodeBin: string
  /** Where the pid files live (the container's /tmp). */
  tmpDir: string
  /** One check, then its group is terminated. */
  timeoutMs: number
  /** SIGTERM → SIGKILL. */
  graceMs: number
  /** How often the group is probed during the grace and the confirmation. */
  pollMs: number
  /** How long the confirmation after SIGKILL keeps probing. */
  confirmMs: number
  /** A stop requested before the wrapper has written its pid file waits this
   *  long for it (or for the wrapper to exit) before concluding there is no group. */
  startWaitMs: number
  /** A control exec (probe / signal / list) is killed after this. */
  ctlTimeoutMs: number
  /** After the group is confirmed gone, how long the wrapper's own exec may
   *  take to close before the host kills it. */
  exitWaitMs: number
  now: () => number
}

const DEFAULTS: CheckOptions = {
  nodeBin: `${NODE_MOUNT}/bin/node`,
  tmpDir: '/tmp',
  timeoutMs: REVIEW_LOOP.checkTimeoutMs,
  graceMs: 10_000,
  pollMs: 500,
  confirmMs: 10_000,
  startWaitMs: 3_000,
  ctlTimeoutMs: 15_000,
  exitWaitMs: 2_000,
  now: Date.now
}

export interface CheckRequest {
  /** The `check` intent's id (`<executor>.<n>`): names the pid file. */
  intent: string
  /** The repo's name: the check runs in /workspaces/<repo>. */
  repo: string
  command: string
}

/**
 * How a run ended. `finished` and `stopped` mean the group is confirmed gone:
 *  - `finished`: the shell exited by itself (`result.code` is its code; a
 *    leftover background process was found and terminated → `leftover`).
 *  - `stopped`: gurt ended it — `reason` `timeout` (`result.timedOut`, code -1)
 *    or `cancel` (via {@link CheckRunner.terminate}).
 * `unconfirmed`: the group could not be confirmed gone — something may still be
 * running in the container: the controller stops the container and ends
 * `failed`. `failed-to-run`: nothing started (container would not come up,
 * invalid request, exec could not spawn).
 */
export type CheckRun =
  | { status: 'finished'; result: CheckResult; leftover?: boolean }
  | { status: 'stopped'; reason: 'timeout' | 'cancel'; result: CheckResult }
  | { status: 'unconfirmed'; detail: string; result: CheckResult }
  | { status: 'failed-to-run'; error: string }

export type Terminated = { ok: true } | { ok: false; detail: string }

/** {@link CheckRunner.scanLeftovers}'s report: pid files found at boot. */
export interface LeftoverScan {
  /** Intent ids of the pid files found (their groups may be long gone). */
  found: string[]
  /** …of which the group was confirmed gone (terminated or already dead). */
  cleared: string[]
  unconfirmed: { intent: string; detail: string }[]
}

const INTENT_RE = /^[A-Za-z0-9._-]{1,128}$/
const REPO_RE = /^[A-Za-z0-9._-]{1,128}$/
const PID_NAME_RE = /^gurt-check-(.+)\.pid$/

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Active {
  /** Unset until the exec has been spawned (a cancel can land before that). */
  child?: ExecChild
  exited: boolean
  /** Resolves when the wrapper's exec has closed. */
  closed: Promise<void>
  /** Set once a stop has begun; later stop requests share it. */
  stop?: { reason: 'timeout' | 'cancel'; done: Promise<Terminated> }
  onStop: () => void
}

export class CheckRunner {
  private readonly o: CheckOptions
  private readonly active = new Map<string, Active>()

  constructor(private readonly deps: CheckDeps) {
    this.o = { ...DEFAULTS, ...deps.options }
  }

  private pidFile(intent: string): string {
    return `${this.o.tmpDir}/gurt-check-${intent}.pid`
  }

  /** Run one repo's check to the end (§5.3). Never rejects. */
  async run(req: CheckRequest): Promise<CheckRun> {
    if (!INTENT_RE.test(req.intent)) return { status: 'failed-to-run', error: `invalid check intent id "${req.intent}"` }
    if (!REPO_RE.test(req.repo) || req.repo === '.' || req.repo === '..')
      return { status: 'failed-to-run', error: `invalid repo name "${req.repo}"` }
    if (this.active.has(req.intent)) return { status: 'failed-to-run', error: `check ${req.intent} is already running` }
    // Registered before the first await: a cancel that lands while the
    // container is still waking must win, not be lost to "nothing running".
    let closeIt!: () => void
    const closed = new Promise<void>((r) => (closeIt = r))
    const a: Active = { exited: false, closed, onStop: () => {} }
    const stopRequested = new Promise<void>((r) => (a.onStop = r))
    this.active.set(req.intent, a)
    try {
      return await this.runRegistered(req, a, closeIt, stopRequested)
    } finally {
      this.active.delete(req.intent)
    }
  }

  private async runRegistered(
    req: CheckRequest,
    a: Active,
    closeIt: () => void,
    stopRequested: Promise<void>
  ): Promise<CheckRun> {
    const started = this.o.now()
    const ring = new LineRing()
    const cancelled = (): CheckRun => ({
      status: 'stopped',
      reason: 'cancel',
      result: { repo: req.repo, command: req.command, code: -1, ms: this.o.now() - started, tail: [] }
    })
    try {
      await this.deps.ensureContainerUp()
    } catch (e) {
      return a.stop ? cancelled() : { status: 'failed-to-run', error: `container would not come up: ${errText(e)}` }
    }
    if (a.stop) return cancelled()

    let child: ExecChild
    try {
      child = this.deps.exec([
        this.o.nodeBin,
        '-e',
        WRAPPER_SOURCE,
        JSON.stringify({ file: this.pidFile(req.intent), cwd: `/workspaces/${req.repo}`, argv: loginShell(req.command) })
      ])
    } catch (e) {
      return { status: 'failed-to-run', error: `could not start the check: ${errText(e)}` }
    }
    let code: number | null = null
    let spawnError: string | undefined
    a.child = child
    child.stdout?.on('data', (d: Buffer) => ring.push(d))
    child.stderr?.on('data', (d: Buffer) => ring.push(d))
    child.on('error', (e) => {
      spawnError ??= e.message
      a.exited = true
      closeIt()
    })
    child.on('close', (c) => {
      code = c
      a.exited = true
      closeIt()
    })
    const timer = setTimeout(() => void this.beginStop(req.intent, 'timeout'), this.o.timeoutMs)
    try {
      await Promise.race([a.closed, stopRequested])
      clearTimeout(timer)
      const build = (extra: Partial<CheckResult> = {}): CheckResult => {
        ring.end()
        return {
          repo: req.repo,
          command: req.command,
          code: code ?? -1,
          ms: this.o.now() - started,
          tail: ring.lines(),
          ...extra
        }
      }
      const stop = stopOf(a) // (re-read: TS cannot see `onStop` set it during the awaits)
      if (stop) {
        const t = await stop.done
        // The group is gone (or not confirmable); the wrapper has nothing left
        // to relay. Let its exec close, else kill the docker client.
        await this.reap(a)
        const timedOut = stop.reason === 'timeout'
        const result = build(timedOut ? { code: -1, timedOut: true } : {})
        return t.ok
          ? { status: 'stopped', reason: stop.reason, result }
          : { status: 'unconfirmed', detail: t.detail, result }
      }
      if (spawnError !== undefined) {
        return { status: 'failed-to-run', error: `could not start the check: ${spawnError}` }
      }
      // The shell exited by itself. A separate exec confirms nothing of its
      // group is left (a backgrounded server would outlive the check and the
      // loop's hold), terminating what it finds.
      const probe = await this.ctl(req.intent, 'probe')
      let leftover = false
      if (probe === 'alive' || probe === 'error') {
        leftover = probe === 'alive'
        const t = await this.terminateGroup(req.intent, false)
        if (!t.ok) return { status: 'unconfirmed', detail: t.detail, result: build() }
      }
      return { status: 'finished', result: build(), ...(leftover ? { leftover } : {}) }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Cancel a running check, or terminate a leftover group of that intent
   *  (a check from before a restart), and confirm it (§5.3). A running
   *  {@link run} resolves `stopped`/`cancel` once this does. */
  async terminate(intent: string): Promise<Terminated> {
    if (!INTENT_RE.test(intent)) return { ok: false, detail: `invalid check intent id "${intent}"` }
    if (this.active.has(intent)) return this.beginStop(intent, 'cancel')
    return this.terminateGroup(intent, false)
  }

  /** Boot scan: list the container's `/tmp/gurt-check-*.pid` files and
   *  terminate each leftover group (§5.3, §8). A pid file from an earlier
   *  container start, or whose group is dead, is just cleared. */
  async scanLeftovers(): Promise<LeftoverScan> {
    const scan: LeftoverScan = { found: [], cleared: [], unconfirmed: [] }
    if (this.deps.isContainerUp && !(await this.deps.isContainerUp().catch(() => false))) return scan
    const names = await this.runCtl({ dir: this.o.tmpDir, mode: 'list' })
    if (names === null) {
      scan.unconfirmed.push({ intent: '*', detail: 'could not list the leftover check files' })
      return scan
    }
    for (const name of names.split('\n')) {
      const intent = PID_NAME_RE.exec(name)?.[1]
      if (!intent || !INTENT_RE.test(intent) || this.active.has(intent)) continue
      scan.found.push(intent)
      const t = await this.terminateGroup(intent, false)
      if (t.ok) scan.cleared.push(intent)
      else scan.unconfirmed.push({ intent, detail: t.detail })
    }
    return scan
  }

  // --- internals ---

  private beginStop(intent: string, reason: 'timeout' | 'cancel'): Promise<Terminated> {
    const a = this.active.get(intent)
    if (!a) return Promise.resolve({ ok: true })
    if (!a.stop) {
      // Before the exec exists there is no group: the run sees `stop` and ends.
      a.stop = { reason, done: a.child ? this.terminateGroup(intent, true) : Promise.resolve({ ok: true }) }
      a.onStop()
    }
    return a.stop.done
  }

  private async reap(a: Active): Promise<void> {
    if (!a.exited) await Promise.race([a.closed, sleep(this.o.exitWaitMs)])
    if (!a.exited) {
      a.child?.kill('SIGKILL')
      await Promise.race([a.closed, sleep(this.o.exitWaitMs)])
    }
  }

  /** SIGTERM → grace → SIGKILL → a separate confirming probe (§5.3). `waiting`:
   *  a run of this process is live, so a missing pid file may only mean the
   *  wrapper has not written it yet. */
  private async terminateGroup(intent: string, waiting: boolean): Promise<Terminated> {
    if (this.deps.isContainerUp && !(await this.deps.isContainerUp().catch(() => false))) return { ok: true }
    const o = this.o
    let state = await this.ctl(intent, 'probe')
    if (state === 'none' && waiting) {
      const a = this.active.get(intent)
      for (const until = o.now() + o.startWaitMs; state === 'none' && !a?.exited && o.now() < until; ) {
        await sleep(Math.min(o.pollMs, 25))
        state = await this.ctl(intent, 'probe')
      }
    }
    if (state === 'error') {
      // One more try; two execs that cannot run say nothing about the group, and
      // signalling through the same dead path would only burn the windows below.
      await sleep(o.pollMs)
      state = await this.ctl(intent, 'probe')
      if (state === 'error') return { ok: false, detail: 'could not reach the container to look for the check\'s process group' }
    }
    if (state === 'none' || state === 'gone') return { ok: true }
    await this.ctl(intent, 'term')
    if ((await this.pollGone(intent, o.graceMs)) === 'gone') return { ok: true }
    await this.ctl(intent, 'kill')
    const last = await this.pollGone(intent, o.confirmMs)
    return last === 'gone'
      ? { ok: true }
      : { ok: false, detail: `the check's process group is still ${last === 'alive' ? 'running' : 'unverifiable'} after SIGKILL` }
  }

  /** Probe until the group is gone or `ms` have passed; the last answer. */
  private async pollGone(intent: string, ms: number): Promise<'alive' | 'gone' | 'error'> {
    const until = this.o.now() + ms
    for (;;) {
      await sleep(Math.max(0, Math.min(this.o.pollMs, until - this.o.now())))
      const r = await this.ctl(intent, 'probe')
      const s = r === 'none' || r === 'gone' ? 'gone' : r === 'alive' ? 'alive' : 'error'
      if (s === 'gone' || this.o.now() >= until) return s
    }
  }

  private async ctl(intent: string, mode: 'probe' | 'term' | 'kill'): Promise<'none' | 'alive' | 'gone' | 'sent' | 'denied' | 'error'> {
    const out = await this.runCtl({ dir: this.o.tmpDir, file: this.pidFile(intent), mode })
    const w = out?.trim()
    return w === 'none' || w === 'alive' || w === 'gone' || w === 'sent' || w === 'denied' ? w : 'error'
  }

  /** One control exec to completion: its trimmed-down stdout, or null when it
   *  could not run, failed or timed out. Output is capped (a few KB at most). */
  private runCtl(payload: { dir: string; file?: string; mode: string }): Promise<string | null> {
    return new Promise((resolve) => {
      let child: ExecChild
      try {
        child = this.deps.exec([this.o.nodeBin, '-e', CTL_SOURCE, JSON.stringify(payload)])
      } catch {
        resolve(null)
        return
      }
      let out = ''
      let settled = false
      const end = (v: string | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(v)
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        end(null)
      }, this.o.ctlTimeoutMs)
      child.stdout?.on('data', (d: Buffer) => {
        if (out.length < 64 * 1024) out += d.toString()
      })
      child.stderr?.on('data', () => {})
      child.on('error', () => end(null))
      child.on('close', (c) => end(c === 0 ? out : null))
    })
  }
}

const stopOf = (a: Active): Active['stop'] => a.stop
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The runner's module-level shape in the spec's words (§5.3): bind a runner
 *  to one container, call `terminateCheck` by intent. */
export function createCheckRunner(deps: CheckDeps): CheckRunner {
  return new CheckRunner(deps)
}

export const terminateCheck = (runner: CheckRunner, intentId: string): Promise<Terminated> => runner.terminate(intentId)
