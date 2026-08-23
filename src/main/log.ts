// Hand-rolled application log: one record per line, written by a single
// serialized writer to `~/.gurt/logs/gurt.log` (rotated), plus one plain file
// per session for subprocess output. No dependencies, no upload, no network —
// the log is a local diagnostic artifact and nothing else.
//
// Two rules shape everything below:
//   - the logger never throws and never logs through itself. Every internal
//     failure disables the affected sink and reports once on `console.error`;
//     the app keeps working with no log rather than failing with one.
//   - one record is exactly one line. Every string that reaches a file goes
//     through `sanitize` (ANSI stripped, control chars escaped, secrets
//     redacted), so neither agent output nor a credential can break the format.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { gurtRoot } from './store'

export type Level = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(msg: string, ctx?: object): void
  info(msg: string, ctx?: object): void
  warn(msg: string, ctx?: object): void
  error(msg: string, ctx?: object): void
}

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const TAG: Record<Level, string> = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' }

/** Rotate the app log at this size; keep `gurt.log` + `.1`…`.5` (6 files max). */
const APP_MAX_BYTES = 10 * 1024 * 1024
const ROTATIONS = 5
/** A session file is capped, not rotated — it is one process's output. */
const SESSION_MAX_BYTES = 20 * 1024 * 1024
/** Records buffered before the writer starts dropping (and counting drops). */
const QUEUE_MAX = 1000
/** Hard bound on one record, so a pathological ctx cannot bloat the file. */
const RECORD_MAX = 8 * 1024
/** Per-second budget for renderer-submitted records (untrusted input). */
const RENDERER_RATE = 200
const DIR_MODE = 0o700
const FILE_MODE = 0o600
const REDACTED = '[redacted]'

const requireFn = createRequire(import.meta.url)

/** `!app.isPackaged` when we are inside Electron; false anywhere else (headless
 *  embedders — tests, scripts, the orchestrator — get the production defaults
 *  and no console mirror unless they set GURT_LOG). */
function isDev(): boolean {
  try {
    const electron = requireFn('electron') as { app?: { isPackaged?: boolean } }
    const app = typeof electron === 'object' && electron ? electron.app : undefined
    return app ? !app.isPackaged : false
  } catch {
    return false
  }
}

function envLevel(): Level | undefined {
  const v = (process.env['GURT_LOG'] ?? '').trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(RANK, v) ? (v as Level) : undefined
}

const dev = isDev()
/** Effective threshold: `GURT_LOG`, else debug in dev / info in production. */
export const logLevel: Level = envLevel() ?? (dev ? 'debug' : 'info')
const threshold = RANK[logLevel]
/** In dev every record is mirrored to the terminal that started the app. */
const mirror = dev

/** True when a record at this level would be written — the call sites that
 *  build expensive context (IPC args) check this before doing the work. */
export const enabled = (level: Level): boolean => RANK[level] >= threshold

export const logDir = (): string => path.join(gurtRoot, 'logs')

// --- failure reporting ----------------------------------------------------

let reported = false

/** The one place the logger is allowed to talk to the console: a sink could not
 *  be opened or written. Reported once per process — a broken log must not turn
 *  into a second flood.
 *
 *  Open question (deliberately unresolved): once-per-PROCESS means the first
 *  broken sink silences the report for every other file — a session sink that
 *  breaks an hour after gurt.log did dies with no trace anywhere. Sinks break
 *  independently (`broken` is per-sink), so once-per-FILE (a Set of paths)
 *  would be more informative at the cost of one line per newly-broken file
 *  on e.g. a full disk. Left as-is until the mute-after-first-failure actually
 *  hurts a real diagnosis. */
function internalFailure(file: string, e: unknown): void {
  if (reported) return
  reported = true
  console.error(`gurt: logging to ${file} disabled:`, e)
}

// --- sanitization & redaction ---------------------------------------------

/**
 * `String()` for a value that came off the wire (renderer IPC, arbitrary ctx)
 * and should have been text. An object deliberately lands as its default
 * '[object Object]' rather than being expanded: everything here is untrusted
 * and unbounded, and the structured path (ctxValue) is the only place an object
 * is meant to be walked.
 */
function wireText(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  // Symbols and functions carry their own toString (a function's source, say —
  // just as caller-controlled as any other string, and truncated the same way).
  if (typeof v === 'symbol' || typeof v === 'function') return v.toString()
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  return Object.prototype.toString.call(v)
}

// Standard ANSI/OSC escape matcher — agent stderr and devcontainer output are
// full of colour codes, and an OSC sequence can even carry a terminal command.
// The control characters in both patterns below are the point of them, which is
// what no-control-regex exists to question.
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007|(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~])/g
// Everything below 0x20 except \t \n \r, plus DEL.
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
/** `scheme://user:pass@host` — the one credential shape that rides in a URL.
 *  Quantifiers are bounded: an unbounded `scheme` + `user` + `pass` run makes
 *  this pattern backtrack quadratically over a long match-free string (a 60 KB
 *  line of plain letters took ~6.5 s; 240 KB took ~100 s). No real scheme,
 *  username or password is anywhere near these lengths. */
const URL_CREDS_RE = /([a-zA-Z][a-zA-Z0-9+.-]{0,30}:\/\/)[^\s/@:]{1,256}:[^\s/@]{1,256}@/g

/** Secret values (raw + base64) redacted from every outgoing line. */
const secrets = new Set<string>()
/** Longest first, so a secret containing another is replaced whole. */
let secretsByLength: string[] = []
/** Below this a "secret" is more likely a common word than a credential — the
 *  false-positive cost of redacting ordinary short strings outweighs catching
 *  a credential this short, which real secret generators essentially never
 *  produce. This is a deliberate, documented exception to the "every secret is
 *  replaced wherever it appears" rule in docs/logging.md's Redaction section:
 *  a secret shorter than `MIN_SECRET_LEN` is never redacted. */
const MIN_SECRET_LEN = 6

/**
 * Register secret values to redact. Sourced from the credential store (loaded
 * at startup, refreshed on every save), so redaction is value-based: it catches
 * a token wherever it appears — an argv entry, a git error, agent stderr —
 * without any call site having to know it was a secret.
 */
export function addSecrets(values: string[]): void {
  let added = false
  for (const v of values) {
    if (typeof v !== 'string') continue
    const raw = v.trim()
    if (raw.length < MIN_SECRET_LEN) continue
    const b64 = Buffer.from(raw, 'utf8').toString('base64')
    const b64url = Buffer.from(raw, 'utf8').toString('base64url')
    for (const form of [raw, b64, b64.replace(/=+$/, ''), b64url]) {
      if (form.length < MIN_SECRET_LEN || secrets.has(form)) continue
      secrets.add(form)
      added = true
    }
  }
  if (added) secretsByLength = [...secrets].sort((a, b) => b.length - a.length)
}

function redact(s: string): string {
  let out = s
  for (const secret of secretsByLength)
    if (out.includes(secret)) out = out.split(secret).join(REDACTED)
  return out.replace(URL_CREDS_RE, `$1${REDACTED}@`)
}

function escapeControl(s: string): string {
  return s
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(CTRL_RE, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
}

/** ANSI out, secrets out, control chars escaped — the result is single-line
 *  and safe to concatenate into a record. Applied to every string we write,
 *  app log and session files alike. */
export function sanitize(text: string): string {
  return escapeControl(redact(String(text).replace(ANSI_RE, '')))
}

/** Longer than any real secret, so truncating a string to `limit + headroom`
 *  before sanitizing it can never slice a secret in half: anything that will
 *  survive to the final `limit`-sized output starts well before this cutoff,
 *  so it is either wholly included here (and redact() matches it whole) or
 *  wholly excluded (and nothing of it leaks). */
const TRUNCATE_HEADROOM = 1024

/** Bound `s` before it reaches `sanitize()`. `sanitize()`/`redact()` cost is
 *  driven by input length, so a call site that only keeps the first `limit`
 *  bytes anyway must not hand sanitize() the full, unbounded string first —
 *  see the module doc for the O(n) vs O(n^2) numbers this fixes. */
function truncateForSanitize(s: string, limit: number): string {
  const str = String(s)
  return str.length > limit + TRUNCATE_HEADROOM ? str.slice(0, limit + TRUNCATE_HEADROOM) : str
}

// --- context serialization -------------------------------------------------

/** Key substrings that redact their value outright, whatever it holds. The key
 *  is case-folded and stripped of `-`/`_` before matching, so `api_key`,
 *  `api-key` and `apiKey` all hit `apikey`. */
const DENY_KEYS = [
  'token',
  'authorization',
  'password',
  'secret',
  'apikey',
  'passphrase',
  'credential',
  'cookie',
  'bearer'
]
const denied = (key: string): boolean => {
  const k = key.toLowerCase().replace(/[-_]/g, '')
  return DENY_KEYS.some((d) => k.includes(d))
}

const MAX_DEPTH = 4
const MAX_ARRAY = 20
const MAX_STRING = 512
const MAX_STACK = 2000
const MAX_KEY_LEN = 64
/** Bound the number of keys processed per object level. Without this, an
 *  object with an enormous key count costs proportionally unbounded
 *  `sanitizeKey()` work before the record's final 8 KB cap ever kicks in —
 *  the same reasoning as `MAX_ARRAY` for arrays, applied to key count. */
const MAX_OBJECT_KEYS = 64

/** Total sanitized output a single ctx may accumulate across every leaf and
 *  nesting level *combined*, before the walk stops early. `MAX_OBJECT_KEYS` /
 *  `MAX_ARRAY` / `MAX_DEPTH` each bound one level in isolation, but a
 *  renderer-supplied ctx nested a few levels deep (e.g. 64 keys of 64 keys of
 *  64 keys) multiplies them: up to 64^3 leaf `sanitize()` calls before
 *  `buildRecord`'s final `RECORD_MAX` truncation — measured at ~25s of
 *  synchronous main-process time for one record. `serializeCtx`/`ctxValue`
 *  share one running counter for the whole ctx and stop recursing the moment
 *  it passes this ceiling — set well above `RECORD_MAX` so no ctx that would
 *  otherwise survive truncation intact is affected, but far below what an
 *  adversarial fan-out could otherwise force. */
const CTX_BUDGET = RECORD_MAX * 2

interface CtxBudget {
  used: number
}
const budgetExceeded = (b: CtxBudget): boolean => b.used > CTX_BUDGET
const spend = (b: CtxBudget, n: number): void => {
  b.used += n
}

/** ctx keys are just as attacker-influenced as values (a renderer call, a
 *  nested object built from process output) — the same sanitize/redact pass
 *  applies to them, so a secret cannot ride through unredacted as a key name
 *  while its value gets `[redacted]`. */
function sanitizeKey(k: string): string {
  return sanitize(String(k)).slice(0, MAX_KEY_LEN)
}

/** `{name, message, code}` — the error shape ctx carries, and the same shape
 *  the domain events use for their `err` field. */
export interface ErrCtx {
  name: string
  message: string
  code?: string | number
}

/** Normalize any thrown value into `ErrCtx` (for event payloads and ctx). Also
 *  accepts an already-flattened error — one that crossed the IPC boundary from
 *  the renderer, or rode on a domain event — so it is not re-stringified into
 *  `[object Object]`. */
export function errCtx(e: unknown): ErrCtx {
  const shaped = e as { name?: unknown; message?: unknown; code?: unknown } | null
  if (e instanceof Error || (shaped && typeof shaped === 'object' && typeof shaped.message === 'string')) {
    const code = shaped!.code
    return {
      name: typeof shaped!.name === 'string' ? shaped!.name : 'Error',
      message: typeof shaped!.message === 'string' ? shaped!.message : String(e),
      ...(typeof code === 'string' || typeof code === 'number' ? { code } : {})
    }
  }
  return { name: 'Error', message: String(e) }
}

/** ctx.err: `{name, message, code}`, with the stack only at ERR — a stack on
 *  every warn would drown the file, and at ERR it is what you actually need. */
function errValue(e: unknown, level: Level, budget: CtxBudget): Record<string, unknown> {
  const base = errCtx(e)
  const name = sanitize(base.name)
  const message = sanitize(truncateForSanitize(base.message, MAX_STRING)).slice(0, MAX_STRING)
  const out: Record<string, unknown> = { name, message }
  spend(budget, name.length + message.length)
  if (base.code !== undefined)
    out['code'] = typeof base.code === 'number' ? base.code : sanitize(String(base.code))
  const stack = (e as { stack?: unknown } | null)?.stack
  if (level === 'error' && typeof stack === 'string' && stack) {
    const stackOut = sanitize(truncateForSanitize(stack, MAX_STACK)).slice(0, MAX_STACK)
    out['stack'] = stackOut
    spend(budget, stackOut.length)
  }
  return out
}

function ctxValue(v: unknown, level: Level, depth: number, budget: CtxBudget): unknown {
  if (v === null || v === undefined) return v
  if (typeof v === 'string') {
    const out = sanitize(truncateForSanitize(v, MAX_STRING)).slice(0, MAX_STRING)
    spend(budget, out.length)
    return out
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v
  if (v instanceof Error) return errValue(v, level, budget)
  if (Array.isArray(v)) {
    if (depth >= MAX_DEPTH) return `[array:${v.length}]`
    const items = v.slice(0, MAX_ARRAY)
    const head: unknown[] = []
    for (const x of items) {
      // Shared across the whole ctx, not just this array — a sibling or an
      // ancestor's sibling that already blew the budget must stop this loop
      // from starting too, not just its own.
      if (budgetExceeded(budget)) {
        head.push('[budget]')
        break
      }
      head.push(ctxValue(x, level, depth + 1, budget))
    }
    return v.length > MAX_ARRAY ? [...head, `+${v.length - MAX_ARRAY} more`] : head
  }
  if (typeof v === 'object') {
    if (depth >= MAX_DEPTH) return '[object]'
    const out: Record<string, unknown> = {}
    const entries = Object.entries(v as Record<string, unknown>)
    for (const [k, x] of entries.slice(0, MAX_OBJECT_KEYS)) {
      if (budgetExceeded(budget)) {
        out['⋯'] = '[budget]'
        break
      }
      out[sanitizeKey(k)] =
        denied(k) ? REDACTED : k === 'err' ? errValue(x, level, budget) : ctxValue(x, level, depth + 1, budget)
    }
    if (entries.length > MAX_OBJECT_KEYS) out['…'] = `+${entries.length - MAX_OBJECT_KEYS} more`
    return out
  }
  // bigint / symbol / function — same bounds as the string path: the text of an
  // exotic value (a function's source, say) is just as caller-controlled.
  const out = sanitize(truncateForSanitize(wireText(v), MAX_STRING)).slice(0, MAX_STRING)
  spend(budget, out.length)
  return out
}

/** ctx → one JSON object, or '' when there is nothing to say. JSON.stringify
 *  escapes what is left of the control chars, so the record stays one line.
 *  `budget` is one counter shared by every leaf and nesting level of this
 *  ctx (see `CTX_BUDGET`) — it is what actually bounds the walk; the per-level
 *  `MAX_*` constants alone do not stop an exponential fan-out. */
function serializeCtx(ctx: object, level: Level): string {
  try {
    const budget: CtxBudget = { used: 0 }
    const out: Record<string, unknown> = {}
    const entries = Object.entries(ctx as Record<string, unknown>)
    for (const [k, v] of entries.slice(0, MAX_OBJECT_KEYS)) {
      if (v === undefined) continue
      if (budgetExceeded(budget)) {
        out['⋯'] = '[budget]'
        break
      }
      out[sanitizeKey(k)] =
        denied(k) ? REDACTED : k === 'err' ? errValue(v, level, budget) : ctxValue(v, level, 1, budget)
    }
    if (entries.length > MAX_OBJECT_KEYS) out['…'] = `+${entries.length - MAX_OBJECT_KEYS} more`
    const keys = Object.keys(out)
    return keys.length ? JSON.stringify(out) : ''
  } catch {
    // Circular or exotic ctx — the record is still worth writing.
    return '{"ctx":"[unserializable]"}'
  }
}

// --- the writer ------------------------------------------------------------

type DropSink = (n: number) => void

/**
 * One append-only file with a bounded queue and a single write in flight.
 * `rotate` renames at the size limit; `cap` writes one `[log capped]` line and
 * drops everything after it. The path is resolved lazily — the logger must be
 * usable at import time, before `~/.gurt` necessarily exists.
 */
class Sink {
  private fd: number | null = null
  private size = 0
  private queue: string[] = []
  private draining = false
  /** True from the moment an fs.write() is dispatched until its callback
   *  fires. Distinct from `draining`, which is also true while merely waiting
   *  for the drain timer — rotate()/cap must never close the fd while this is
   *  true (see `prepare`). */
  private writing = false
  /** True for the duration of the async `prepare()` (open + rotate), i.e. the
   *  window before a write even starts. `flushSync()` (crash path) must stay
   *  fully synchronous, so it cannot await this — instead its own sync
   *  open/rotate is skipped for the cycle while this is true, the same way
   *  `writing` makes it skip rotation. Without this a crash landing mid-open
   *  could run the sync and async paths against the same fd/size fields at
   *  once. */
  private opening = false
  private broken = false
  private capped = false
  /** Set by `close()` when an async write/open was still in flight on the fd —
   *  the in-flight path closes the fd itself once it completes (see `close`). */
  private closeRequested = false
  private dropped = 0

  constructor(
    private file: () => string,
    private max: number,
    private mode: 'rotate' | 'cap',
    private onDrop: DropSink = () => {}
  ) {}

  write(line: string): void {
    if (this.broken || this.capped || this.closeRequested) return
    if (this.queue.length >= QUEUE_MAX) {
      this.dropped++
      return
    }
    this.queue.push(line)
    this.schedule()
  }

  /** Count records the caller dropped before they reached the queue (renderer
   *  rate limiting) — they surface through the same `log.dropped` record. */
  noteDropped(n: number): void {
    if (this.broken || n <= 0) return
    this.dropped += n
    this.schedule()
  }

  /** One drain in flight at a time; records written meanwhile join its batch. */
  private schedule(): void {
    if (this.draining) return
    this.draining = true
    setTimeout(() => this.kick(), 0)
  }

  /** Start a drain cycle, never letting it reject: `drain()` awaits async
   *  fs calls (see `prepare`), and the logger must never throw — a failure
   *  disables the sink exactly like a synchronous one would via `fail()`. */
  private kick(): void {
    this.drain().catch((e: unknown) => {
      this.draining = false
      this.fail(e)
    })
  }

  private async drain(): Promise<void> {
    if (this.broken || this.capped) {
      this.queue.length = 0
      this.draining = false
      return
    }
    // Take the batch first: `onDrop` writes through this same sink, and a queue
    // that is still full would drop the very record that reports the drops.
    const pending = this.queue
    this.queue = []
    if (this.dropped) {
      const n = this.dropped
      this.dropped = 0
      this.onDrop(n)
    }
    if (!pending.length) {
      if (this.queue.length) this.kick()
      else this.draining = false
      return
    }
    const buf = Buffer.from(pending.join(''), 'utf8')
    if (!(await this.prepare(buf.length))) {
      this.draining = false
      return
    }
    // close() may have been requested while prepare() was awaited — the sink is
    // being discarded, so drop the batch and finish the deferred close.
    if (this.closeRequested) {
      this.closeFd()
      this.draining = false
      return
    }
    this.writing = true
    fs.write(this.fd!, buf, (err) => {
      this.writing = false
      if (this.closeRequested) {
        this.closeFd()
        this.draining = false
        return
      }
      if (err) {
        this.fail(err)
        this.draining = false
        return
      }
      this.size += buf.length
      if (this.queue.length || this.dropped) this.kick()
      else this.draining = false
    })
  }

  /** Crash path: put whatever is queued on disk with a synchronous write.
   *  Uses the sync open/rotate below, never the async ones `drain()` uses —
   *  `before-quit` and the crash handlers cannot await anything. */
  flushSync(): void {
    if (this.broken || this.capped || !this.queue.length) return
    const buf = Buffer.from(this.queue.join(''), 'utf8')
    // The queue is cleared only once prepareSync() succeeds: when it bails
    // because an async prepare() is mid-flight (`opening`), the records stay
    // queued for that drain to write instead of being discarded. A real
    // failure clears the queue via fail() either way.
    if (!this.prepareSync(buf.length)) return
    this.queue.length = 0
    try {
      fs.writeSync(this.fd!, buf)
      this.size += buf.length
    } catch (e) {
      this.fail(e)
    }
  }

  close(): void {
    this.flushSync()
    // An outstanding async write (or open) still references this fd. Closing it
    // now would at best fail that write with EBADF — and at worst, if the fd
    // number is reused by another open first, land the write in whatever file
    // took the descriptor. Defer instead: the in-flight path sees
    // `closeRequested` when it completes and closes the fd itself.
    if (this.idle) this.closeFd()
    else this.closeRequested = true
  }

  /** True when no fs.write() is outstanding and no async open/rotate is in
   *  flight on this sink's fd — safe to `close()` (flush whatever is merely
   *  queued, synchronously, then close the fd) without racing either. Used by
   *  the session-sink eviction cap: a sink can be evicted mid-`draining`
   *  (still waiting on its drain timer, nothing written or opened yet) just
   *  not mid-write or mid-open. */
  get idle(): boolean {
    return !this.writing && !this.opening
  }

  /** Non-blocking path used by `drain()`: `open()`/`rotate()` run on
   *  `fs.promises` so a first write, a rotation, or reopening an evicted
   *  session sink never blocks the main process's event loop. */
  private async prepare(len: number): Promise<boolean> {
    this.opening = true
    try {
      if (!(await this.open())) return false
      if (this.size + len <= this.max) return true
      // An async write dispatched by drain() can still be outstanding here —
      // flushSync() calls prepareSync() too, regardless of `draining`. Rotating
      // (or capping) now would close the fd that write still references: its
      // callback then fails and fail() disables the sink for the rest of the
      // run. Skip rotation/capping this cycle instead — the next call catches
      // up once the fd is free.
      if (this.writing) return true
      if (this.mode === 'rotate') {
        await this.rotate()
        return this.open()
      }
      this.capped = true
      try {
        await writeFd(this.fd!, Buffer.from('[log capped]\n'))
      } catch {
        // The cap line is a courtesy; the file is closed either way.
      }
      this.closeFd()
      return false
    } finally {
      this.opening = false
    }
  }

  private async open(): Promise<boolean> {
    if (this.fd !== null) return true
    if (this.broken) return false
    const file = this.file()
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: DIR_MODE })
      // A dir that already existed keeps its mode — tighten it best-effort.
      try {
        await fs.promises.chmod(path.dirname(file), DIR_MODE)
      } catch {
        /* not ours / not chmod-able — the file mode below still applies */
      }
      // Rotation is also checked at open: a run that ends just under the limit
      // must not append to an over-sized file on the next start.
      if (this.mode === 'rotate' && ((await statSizeAsync(file)) ?? 0) >= this.max) await this.rotate()
      // 'a' is O_APPEND|O_CREAT|O_WRONLY — every write lands at the end, so a
      // second writer (an old process, a crash-path flush) cannot overwrite us.
      this.fd = await openFd(file, 'a', FILE_MODE)
      // openSync's mode argument only applies when the file is created — a
      // gurt.log left over from a build with looser permissions would
      // otherwise keep that mode forever.
      try {
        await fchmodFd(this.fd, FILE_MODE)
      } catch {
        /* not chmod-able — best effort, same as the directory mode above */
      }
      this.size = (await fstatFd(this.fd)).size
      return true
    } catch (e) {
      this.fail(e)
      return false
    }
  }

  private async rotate(): Promise<void> {
    this.closeFd()
    const file = this.file()
    try {
      await fs.promises.rm(`${file}.${ROTATIONS}`, { force: true })
      for (let i = ROTATIONS - 1; i >= 1; i--) await renameIfExistsAsync(`${file}.${i}`, `${file}.${i + 1}`)
      await renameIfExistsAsync(file, `${file}.1`)
      this.size = 0
    } catch (e) {
      this.fail(e)
    }
  }

  /** Blocking path used only by `flushSync()` (before-quit, crash handlers) —
   *  those must put bytes on disk before the process exits, so they cannot
   *  await the async path above. Skips its own work while an async
   *  `prepare()` is in flight (`opening`) rather than risk two code paths
   *  mutating `fd`/`size` at once; losing a crash-time flush in that
   *  sub-millisecond window is a far better outcome than a corrupted sink. */
  private prepareSync(len: number): boolean {
    if (this.opening) return false
    if (!this.openSync()) return false
    if (this.size + len <= this.max) return true
    if (this.writing) return true
    if (this.mode === 'rotate') {
      this.rotateSync()
      return this.openSync()
    }
    this.capped = true
    try {
      fs.writeSync(this.fd!, '[log capped]\n')
    } catch {
      // The cap line is a courtesy; the file is closed either way.
    }
    this.closeFd()
    return false
  }

  private openSync(): boolean {
    if (this.fd !== null) return true
    if (this.broken) return false
    const file = this.file()
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE })
      try {
        fs.chmodSync(path.dirname(file), DIR_MODE)
      } catch {
        /* not ours / not chmod-able — the file mode below still applies */
      }
      if (this.mode === 'rotate' && (statSize(file) ?? 0) >= this.max) this.rotateSync()
      this.fd = fs.openSync(file, 'a', FILE_MODE)
      try {
        fs.fchmodSync(this.fd, FILE_MODE)
      } catch {
        /* not chmod-able — best effort, same as the directory mode above */
      }
      this.size = fs.fstatSync(this.fd).size
      return true
    } catch (e) {
      this.fail(e)
      return false
    }
  }

  private rotateSync(): void {
    this.closeFd()
    const file = this.file()
    try {
      fs.rmSync(`${file}.${ROTATIONS}`, { force: true })
      for (let i = ROTATIONS - 1; i >= 1; i--) renameIfExists(`${file}.${i}`, `${file}.${i + 1}`)
      renameIfExists(file, `${file}.1`)
      this.size = 0
    } catch (e) {
      this.fail(e)
    }
  }

  private closeFd(): void {
    if (this.fd === null) return
    try {
      fs.closeSync(this.fd)
    } catch {
      /* already gone */
    }
    this.fd = null
  }

  /** A sink that cannot be written is switched off for the rest of the run:
   *  retrying an EACCES on every record would cost more than the log is worth. */
  private fail(e: unknown): void {
    this.broken = true
    this.queue.length = 0
    this.closeFd()
    internalFailure(this.file(), e)
  }
}

function statSize(file: string): number | null {
  try {
    return fs.statSync(file).size
  } catch {
    return null
  }
}

async function statSizeAsync(file: string): Promise<number | null> {
  try {
    return (await fs.promises.stat(file)).size
  } catch {
    return null
  }
}

function renameIfExists(from: string, to: string): void {
  try {
    fs.renameSync(from, to)
  } catch {
    // Missing generation — nothing to shift.
  }
}

async function renameIfExistsAsync(from: string, to: string): Promise<void> {
  try {
    await fs.promises.rename(from, to)
  } catch {
    // Missing generation — nothing to shift.
  }
}

/** Promise wrappers around the fd-based fs calls `open()`/`prepare()` need —
 *  hand-written rather than `util.promisify` because `fs.open`/`fs.write`
 *  have ambiguous overloads that promisify does not always resolve to the
 *  short callback form used here. */
function openFd(file: string, flags: string, mode: number): Promise<number> {
  return new Promise((resolve, reject) =>
    fs.open(file, flags, mode, (err, fd) => (err ? reject(err) : resolve(fd)))
  )
}

function fchmodFd(fd: number, mode: number): Promise<void> {
  return new Promise((resolve, reject) => fs.fchmod(fd, mode, (err) => (err ? reject(err) : resolve())))
}

function fstatFd(fd: number): Promise<fs.Stats> {
  return new Promise((resolve, reject) => fs.fstat(fd, (err, stats) => (err ? reject(err) : resolve(stats))))
}

function writeFd(fd: number, buf: Buffer): Promise<void> {
  return new Promise((resolve, reject) => fs.write(fd, buf, (err) => (err ? reject(err) : resolve())))
}

// --- sinks -----------------------------------------------------------------

const appSink = new Sink(() => path.join(logDir(), 'gurt.log'), APP_MAX_BYTES, 'rotate', (n) =>
  appSink.write(buildRecord('m', 'warn', 'log', 'log.dropped', { n }))
)

/** Per-session subprocess output, keyed by the sanitized file id. */
const sessionSinks = new Map<string, Sink>()

/** `<id>` becomes a file name, so it is reduced to `[a-zA-Z0-9-]`. Provisioning
 *  keys that are not session ids (`env-build:<ws>/<env>`) map to their own file
 *  the same way. A short hash of the raw key is appended: the reduction alone
 *  collapses distinct keys (`env-build:ws/env` and `env-build-ws-env` both
 *  sanitize to `env-build-ws-env`) onto the same file, and `dropSessionLog`
 *  deleting one would delete the other's. */
function fileId(key: string): string {
  const raw = String(key)
  const id = raw.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8)
  return `${id || 'unknown'}-${hash}`
}

/** How many session files stay open at once. A long-lived process can rack up
 *  hundreds of sessions over its lifetime; each open sink is a real OS file
 *  descriptor, so past this cap the least-recently-used *idle* sink has its
 *  fd closed and its map entry dropped. A session that logs again afterwards
 *  transparently reopens the same file (its existing size comes back via
 *  fstat on the next open) — nothing is lost, just the fd. */
const MAX_OPEN_SESSION_SINKS = 64

function sessionSink(key: string): Sink {
  const id = fileId(key)
  let sink = sessionSinks.get(id)
  if (sink) {
    // Re-inserting moves `id` to the most-recently-used end of the map's
    // iteration order, which the eviction loop below relies on.
    sessionSinks.delete(id)
  } else {
    sink = new Sink(
      () => path.join(logDir(), `session-${id}.log`),
      SESSION_MAX_BYTES,
      'cap',
      (n) => appSink.write(buildRecord('m', 'warn', 'log', 'log.dropped', { n, s: id }))
    )
  }
  sessionSinks.set(id, sink)
  evictIdleSessionSinks()
  return sink
}

function evictIdleSessionSinks(): void {
  if (sessionSinks.size <= MAX_OPEN_SESSION_SINKS) return
  for (const [id, sink] of sessionSinks) {
    if (sessionSinks.size <= MAX_OPEN_SESSION_SINKS) break
    // A sink mid-write is never closed underneath itself (the same hazard as
    // flushSync racing rotate()) — it just stays open one cycle longer.
    if (!sink.idle) continue
    sink.close()
    sessionSinks.delete(id)
  }
}

// --- records ---------------------------------------------------------------

const ELLIPSIS = '…'
const ELLIPSIS_BYTES = Buffer.byteLength(ELLIPSIS, 'utf8')

/** RECORD_MAX is a promise about bytes on disk, not UTF-16 code units — a run
 *  of multi-byte characters measured with `.length`/`.slice` would blow past
 *  it (up to ~4x on disk) and could slice a surrogate pair in half, leaving a
 *  lone surrogate that encodes as U+FFFD. Cutting the UTF-8 bytes directly and
 *  decoding back stays on a valid boundary — but if that cut lands mid
 *  sequence, Node's decoder turns the incomplete tail into one U+FFFD, which
 *  re-encodes to 3 bytes and can itself land a couple of bytes over `maxBytes`;
 *  trim character by character until it actually fits (at most a few
 *  iterations — one multi-byte character per pass). */
function truncateToBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= maxBytes) return s
  let out = buf.subarray(0, maxBytes).toString('utf8')
  while (Buffer.byteLength(out, 'utf8') > maxBytes) out = out.slice(0, -1)
  return out
}

function buildRecord(
  proc: 'm' | 'r',
  level: Level,
  scope: string,
  msg: string,
  ctx?: object,
  ts?: number
): string {
  let line = `${new Date(ts ?? Date.now()).toISOString()} ${TAG[level]} ${proc} [${scope}] ${sanitize(truncateForSanitize(msg, RECORD_MAX))}`
  if (ctx) {
    const json = serializeCtx(ctx, level)
    if (json) line += ` ${json}`
  }
  if (Buffer.byteLength(line, 'utf8') > RECORD_MAX)
    line = `${truncateToBytes(line, RECORD_MAX - ELLIPSIS_BYTES)}${ELLIPSIS}`
  return `${line}\n`
}

function emit(proc: 'm' | 'r', level: Level, scope: string, msg: string, ctx?: object, ts?: number): void {
  const line = buildRecord(proc, level, scope, msg, ctx, ts)
  appSink.write(line)
  if (mirror) (level === 'error' ? console.error : console.log)(line.slice(0, -1))
}

/** Scopes are `[a-z0-9-]{1,32}` — they name a subsystem, nothing more. `sanitize`
 *  runs first, on the untouched value, so a secret passed as a scope (the
 *  renderer's `logRenderer` channel is untrusted input) is redacted before
 *  case-folding could break a case-sensitive match — the char filter below
 *  only shapes the format, it was never a redaction step. */
function scopeName(scope: string, fallback = 'app'): string {
  const s = sanitize(String(scope)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  return s.slice(0, 32) || fallback
}

/**
 * A logger for one subsystem. The level check happens before ctx is touched, so
 * a disabled DBG call costs one comparison and never serializes anything.
 *
 * `scopeName` is resolved lazily, on the first record actually written, not
 * eagerly here: `store.ts` calls `createLogger('store')` at its own module
 * top level, and `log.ts` imports `gurtRoot` from `store.ts` — a circular
 * import. Resolving eagerly would run `scopeName`'s `sanitize()` (and thus
 * touch `secretsByLength`) while that cycle is still unwinding, before this
 * module's own top-level initializers have run. By the time any logger
 * actually logs, the whole module graph is long since initialized.
 */
export function createLogger(scope: string): Logger {
  let s: string | undefined
  const at =
    (level: Level) =>
    (msg: string, ctx?: object): void => {
      if (RANK[level] < threshold) return
      try {
        if (s === undefined) s = scopeName(scope)
        emit('m', level, s, msg, ctx)
      } catch (e) {
        internalFailure('gurt.log', e)
      }
    }
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }
}

// --- per-session subprocess output ----------------------------------------

/**
 * One line of a session's subprocess output (devcontainer CLI, agent stderr,
 * docker) into `logs/session-<id>.log`. Never reaches the app log: this is
 * volume, and it is the session's own diagnostic trail.
 */
export function sessionLogLine(sessionId: string, line: string): void {
  try {
    const text = truncateToBytes(sanitize(truncateForSanitize(line, RECORD_MAX)), RECORD_MAX)
    sessionSink(sessionId).write(`${new Date().toISOString()} ${text}\n`)
  } catch (e) {
    internalFailure('session log', e)
  }
}

/** Drop a session's file — called wherever the session's other artifacts are. */
export function dropSessionLog(sessionId: string): void {
  const id = fileId(sessionId)
  const sink = sessionSinks.get(id)
  if (sink) {
    sink.close()
    sessionSinks.delete(id)
  }
  fs.rm(path.join(logDir(), `session-${id}.log`), { force: true }, () => {})
}

// --- renderer transport ----------------------------------------------------

let windowStart = 0
let windowCount = 0

/** Fixed 1s window; over budget the record is dropped and counted, so a runaway
 *  renderer loop costs one comparison per call and one `log.dropped` record. */
function rateLimited(): boolean {
  const now = Date.now()
  if (now - windowStart >= 1000) {
    windowStart = now
    windowCount = 0
  }
  if (windowCount >= RENDERER_RATE) return true
  windowCount++
  return false
}

/** Bound every top-level string in a renderer-submitted ctx before it enters
 *  serialization — the record-size validation the renderer channel promises
 *  applies at the input boundary, not after the record is already built.
 *  Nested strings are still bounded by ctxValue's own truncate-before-sanitize. */
function truncateCtxStrings(ctx: object): object {
  const out: Record<string, unknown> = {}
  // Only the first MAX_OBJECT_KEYS entries get the string bound — they are the
  // only ones serializeCtx will read — but every key is carried through, so its
  // `+N more` marker still reports the true count instead of silently seeing an
  // already-sliced object. The pass stays O(keys) copy work either way.
  let i = 0
  for (const [k, v] of Object.entries(ctx as Record<string, unknown>)) {
    out[k] = typeof v === 'string' && i < MAX_OBJECT_KEYS ? truncateForSanitize(v, MAX_STRING) : v
    i++
  }
  return out
}

/** How far a renderer-reported event timestamp may drift from the main
 *  process's clock and still be trusted. Both processes read the same system
 *  clock, so real drift is ~0 — this only needs to absorb IPC/rate-limit
 *  delay, not clock skew across machines. Outside this window the timestamp
 *  is more likely forged or stale than accurate, so the receipt time is used
 *  instead. */
const RENDERER_TS_SKEW_MS = 60_000

/** Validate a renderer-supplied event timestamp: a finite number within
 *  `RENDERER_TS_SKEW_MS` of now, else the receipt time — the same fallback
 *  the timestamp existed to improve on, so a bad value never makes things
 *  worse than before this existed. */
function rendererTs(ts: unknown): number {
  const now = Date.now()
  return typeof ts === 'number' && Number.isFinite(ts) && Math.abs(ts - now) <= RENDERER_TS_SKEW_MS ? ts : now
}

/**
 * A record submitted by the renderer over IPC. Everything here is untrusted:
 * the level must be one of ours, the scope is reduced to `[a-z0-9-]{1,32}`, the
 * record is truncated to 8 KB, and the whole channel is rate limited.
 */
export function logRenderer(level: unknown, scope: unknown, msg: unknown, ctx?: unknown, ts?: unknown): void {
  try {
    if (typeof level !== 'string' || !Object.prototype.hasOwnProperty.call(RANK, level)) return
    const lvl = level as Level
    if (RANK[lvl] < threshold) return
    if (rateLimited()) {
      appSink.noteDropped(1)
      return
    }
    const safeCtx =
      ctx && typeof ctx === 'object' && !Array.isArray(ctx)
        ? truncateCtxStrings(ctx)
        : undefined
    const safeMsg = truncateForSanitize(wireText(msg), RECORD_MAX)
    emit('r', lvl, scopeName(wireText(scope), 'renderer'), safeMsg, safeCtx, rendererTs(ts))
  } catch (e) {
    internalFailure('gurt.log', e)
  }
}

// --- shutdown --------------------------------------------------------------

/** Put every queued record on disk synchronously (quit and crash paths). */
export function flushSync(): void {
  try {
    appSink.flushSync()
    for (const sink of sessionSinks.values()) sink.flushSync()
  } catch (e) {
    internalFailure('gurt.log', e)
  }
}
