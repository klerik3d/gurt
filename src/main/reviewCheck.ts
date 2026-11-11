// The review loop's check runner (docs/requirements-review-loop.md §5.3, §12
// item 5): runs one repo's `check` command in the executor's container, as the
// container user, from /workspaces/<repo>, through the login shell like the
// env's `setup` script (`runScript`, provision.ts) — but not through
// `dockerExec`: that accumulates all stdout in memory.
//
// Killing a check is stopping the container (§5.3). Nothing inside the
// container is trusted to supervise it: the agent controls that container, so a
// pid file, a process group or a probe there can be forged, raced or escaped
// (`setsid`, a detached child). What the agent cannot do is stop a container
// from inside it. So on the timeout, on a cancel and on any end of the loop
// while a check runs — and for a leftover found at boot — the runner asks the
// host to stop the container and CONFIRMS it with a separate inspect; only then
// does a run resolve `stopped`. Unconfirmable resolves the distinct
// `unconfirmed` (the controller keeps its hold and retries; this module only
// reports). The container restarts through the usual attach path when the next
// host message needs it. A check that finishes by itself needs no termination.
//
// Residual boundary (§5.3, §10): a descendant that detaches and outlives a
// NORMALLY finished check is not contained; the `tree-moved` rule (the hash at
// the verdict must equal the reviewed hash) is what catches it modifying the
// clone during a review.
//
// Everything that touches a container is injected (`CheckDeps`); the tests run
// the same module over a fake exec. Nothing is ever written in the container.
import { StringDecoder } from 'node:string_decoder'
import { REVIEW_LOOP, type CheckResult } from '../shared/reviewLoop'
import { loginShell } from './provision'

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
 * What the runner needs from its host (tests pass fakes).
 *
 *  - `exec(argv, cwd)`: spawn `argv` in the session's container as the container
 *    user, in `cwd`, without a tty, no stdin, and return the child. Real wiring:
 *    `ContainerManager.spawnExec`. Resolved *per call*: the container may have
 *    been recreated since the runner was built. It may throw (no container).
 *  - `ensureContainerUp()`: wake the executor's container before a check, without
 *    attaching the agent (the gated path a resume uses, `SessionManager.ensureContainerUp`).
 *    Rejecting = the check cannot run.
 *  - `stopContainer()`: stop the executor's container (`docker stop`), the one
 *    way a check is killed (§5.3). May reject: the confirmation decides.
 *  - `containerRunning()`: whether the container is running *now*, from the
 *    daemon (`docker inspect`), not from a record: `false` — not running (or no
 *    such container), `true` — running, `null` — the daemon could not say.
 */
export interface CheckDeps {
  exec(argv: string[], cwd: string): ExecChild
  ensureContainerUp(): Promise<void>
  stopContainer(): Promise<void>
  containerRunning(): Promise<boolean | null>
  /** Test seams; the defaults are the spec's numbers. */
  options?: Partial<CheckOptions>
}

export interface CheckOptions {
  /** One check, then the container is stopped. */
  timeoutMs: number
  /** After the container is confirmed stopped, how long the exec's own client
   *  may take to close before the host kills it. */
  exitWaitMs: number
  now: () => number
}

const DEFAULTS: CheckOptions = { timeoutMs: REVIEW_LOOP.checkTimeoutMs, exitWaitMs: 2_000, now: Date.now }

export interface CheckRequest {
  /** The `check` intent's id (`<executor>.<n>`): what a cancel names. */
  intent: string
  /** The repo's name: the check runs in /workspaces/<repo>. */
  repo: string
  command: string
}

/** The container was stopped and confirmed not running, or it was not. */
export type Stopped = { ok: true } | { ok: false; detail: string }

/**
 * How a run ended:
 *  - `finished`: the shell exited by itself (`result.code` is its code).
 *  - `stopped`: gurt stopped the container — `reason` `timeout`
 *    (`result.timedOut`, code -1) or `cancel` ({@link CheckRunner.cancel}) —
 *    and confirmed it is not running.
 *  - `unconfirmed`: the container could not be confirmed stopped, so the check
 *    may still be running: the controller keeps its hold and retries (§5.3).
 *  - `failed-to-run`: nothing started (container would not come up, invalid
 *    request, exec could not spawn).
 */
export type CheckRun =
  | { status: 'finished'; result: CheckResult }
  | { status: 'stopped'; reason: 'timeout' | 'cancel'; result: CheckResult }
  | { status: 'unconfirmed'; reason: 'timeout' | 'cancel'; detail: string; result: CheckResult }
  | { status: 'failed-to-run'; error: string }

const INTENT_RE = /^[A-Za-z0-9._-]{1,128}$/
const REPO_RE = /^[A-Za-z0-9._-]{1,128}$/

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Active {
  /** Unset until the exec has been spawned (a cancel can land before that). */
  child?: ExecChild
  exited: boolean
  /** Resolves when the exec has closed. */
  closed: Promise<void>
  /** Set once a stop has begun; later stop requests share it. */
  stop?: { reason: 'timeout' | 'cancel'; done: Promise<Stopped> }
  onStop: () => void
}

export class CheckRunner {
  private readonly o: CheckOptions
  private readonly active = new Map<string, Active>()
  /** The stop in flight, shared: two ends (a timeout and a cancel, a cancel and
   *  the boot scan) never race two `docker stop`s. */
  private stopping?: Promise<Stopped> | undefined

  constructor(private readonly deps: CheckDeps) {
    this.o = { ...DEFAULTS, ...deps.options }
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
    const a: Active = { exited: false, closed: new Promise<void>((r) => (closeIt = r)), onStop: () => {} }
    const stopRequested = new Promise<void>((r) => (a.onStop = r))
    this.active.set(req.intent, a)
    try {
      return await this.runRegistered(req, a, closeIt, stopRequested)
    } finally {
      this.active.delete(req.intent)
    }
  }

  private async runRegistered(req: CheckRequest, a: Active, closeIt: () => void, stopRequested: Promise<void>): Promise<CheckRun> {
    const started = this.o.now()
    const ring = new LineRing()
    const result = (extra: Partial<CheckResult> = {}, code = -1): CheckResult => {
      ring.end()
      return { repo: req.repo, command: req.command, code, ms: this.o.now() - started, tail: ring.lines(), ...extra }
    }
    try {
      await this.deps.ensureContainerUp()
    } catch (e) {
      return a.stop ? { status: 'stopped', reason: 'cancel', result: result() } : { status: 'failed-to-run', error: `container would not come up: ${errText(e)}` }
    }
    // Nothing was started yet, so there is nothing to stop.
    if (a.stop) return { status: 'stopped', reason: 'cancel', result: result() }

    let child: ExecChild
    try {
      child = this.deps.exec(loginShell(req.command), `/workspaces/${req.repo}`)
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
    } finally {
      clearTimeout(timer)
    }
    const stop = stopOf(a) // (re-read: TS cannot see `onStop` set it during the awaits)
    if (stop) {
      const t = await stop.done
      // The container is stopped (or not confirmable); the exec's client has
      // nothing left to relay. Let it close, else kill the docker client.
      await this.reap(a)
      const r = result(stop.reason === 'timeout' ? { timedOut: true } : {})
      return t.ok ? { status: 'stopped', reason: stop.reason, result: r } : { status: 'unconfirmed', reason: stop.reason, detail: t.detail, result: r }
    }
    if (spawnError !== undefined) return { status: 'failed-to-run', error: `could not start the check: ${spawnError}` }
    // The shell exited by itself: nothing to terminate (§5.3).
    return { status: 'finished', result: result({}, code ?? -1) }
  }

  /** Cancel a running check (the loop ended, §5.3): stop the container and
   *  confirm it. The running {@link run} resolves `stopped`/`cancel` once this
   *  does. Nothing running under that intent: a no-op that succeeds. */
  cancel(intent: string): Promise<Stopped> {
    return this.beginStop(intent, 'cancel')
  }

  /** Stop the container and confirm it is not running — for a leftover found
   *  at boot (an intent `check` that was running when the app died, §8). */
  stopContainer(): Promise<Stopped> {
    return (this.stopping ??= this.stopAndConfirm().finally(() => (this.stopping = undefined)))
  }

  // --- internals ---

  private beginStop(intent: string, reason: 'timeout' | 'cancel'): Promise<Stopped> {
    const a = this.active.get(intent)
    if (!a) return Promise.resolve({ ok: true })
    if (!a.stop) {
      // Before the exec exists nothing runs: the run sees `stop` and ends.
      a.stop = { reason, done: a.child ? this.stopContainer() : Promise.resolve({ ok: true }) }
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

  /** `docker stop`, then a separate inspect: a stop that threw is still
   *  confirmed (the container may be down anyway), a stop that returned is not
   *  believed. Anything but "not running" is unconfirmed. */
  private async stopAndConfirm(): Promise<Stopped> {
    let stopError: string | undefined
    try {
      await this.deps.stopContainer()
    } catch (e) {
      stopError = errText(e)
    }
    let running: boolean | null
    try {
      running = await this.deps.containerRunning()
    } catch {
      running = null
    }
    if (running === false) return { ok: true }
    const why = running === true ? 'is still running' : 'could not be inspected'
    return { ok: false, detail: `the executor's container ${why} after docker stop${stopError ? ` (${stopError})` : ''}` }
  }
}

const stopOf = (a: Active): Active['stop'] => a.stop
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
