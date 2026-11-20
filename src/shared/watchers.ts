// Watchers (docs/requirements-watchers.md): one long-lived session that watches
// an outside process and wakes itself. Shapes and pure rules, shared by main
// (the manager, the session manager's timed prompt, the `gurt` tools) and the
// renderer (the mode). The precedent is `proactive.ts`.
import type { ScopeLabel } from './proactive'
import type { SessionInfo } from './types'

/** A watcher's settings — `task.json`'s `watcher` member of its scope (§2.1). */
export interface WatcherConfig {
  /** Wakes are sent by themselves only while true (Pause / Resume, §3). */
  wakeups: boolean
  /** Wakes this watcher may send in its life; the deadline's final wake is not counted. */
  maxWakeups: number
  /** The deadline, as a duration from Start (frozen into `deadlineAt` there). */
  maxHours: number
  /** `wake_me` is clamped into [min, max] (§5.2). */
  minDelayMinutes: number
  maxDelayMinutes: number
  label?: ScopeLabel
}

export const WATCHER_DEFAULTS: WatcherConfig = {
  wakeups: true,
  maxWakeups: 50,
  maxHours: 8,
  minDelayMinutes: 2,
  maxDelayMinutes: 240
}

/** Bounds every numeric setting is clamped to. */
export const WATCHER_BOUNDS: Record<
  'maxWakeups' | 'maxHours' | 'minDelayMinutes' | 'maxDelayMinutes',
  [number, number]
> = {
  maxWakeups: [1, 500],
  maxHours: [0.25, 72],
  minDelayMinutes: [1, 60],
  maxDelayMinutes: [5, 1440]
}

const clamp = (v: number, [lo, hi]: [number, number]): number => Math.min(hi, Math.max(lo, v))

/** Coerce untrusted input into a valid config: malformed or missing keys keep
 *  `fallback`'s value, unknown keys are dropped, `minDelay ≤ maxDelay`. */
export function sanitizeWatcherConfig(raw: unknown, fallback: WatcherConfig = WATCHER_DEFAULTS): WatcherConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const num = (key: keyof typeof WATCHER_BOUNDS, whole: boolean): number => {
    const v = r[key]
    if (typeof v !== 'number' || !Number.isFinite(v)) return fallback[key]
    return clamp(whole ? Math.round(v) : Math.round(v * 100) / 100, WATCHER_BOUNDS[key])
  }
  const out: WatcherConfig = {
    wakeups: typeof r['wakeups'] === 'boolean' ? r['wakeups'] : fallback.wakeups,
    maxWakeups: num('maxWakeups', true),
    maxHours: num('maxHours', false),
    minDelayMinutes: num('minDelayMinutes', true),
    maxDelayMinutes: num('maxDelayMinutes', true)
  }
  if (out.minDelayMinutes > out.maxDelayMinutes) {
    // The key the caller just edited wins; the other follows it.
    if ('minDelayMinutes' in r && !('maxDelayMinutes' in r)) out.maxDelayMinutes = out.minDelayMinutes
    else out.minDelayMinutes = out.maxDelayMinutes
  }
  const label = 'label' in r ? labelOf(r['label']) : fallback.label
  if (label) out.label = label
  return out
}

function labelOf(raw: unknown): ScopeLabel | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const text = typeof r['text'] === 'string' ? r['text'].replace(/\s+/g, ' ').trim().slice(0, 12).trim() : ''
  if (!text) return undefined
  const color = typeof r['color'] === 'string' && /^#[0-9a-f]{6}$/i.test(r['color']) ? r['color'].toLowerCase() : '#4da3ff'
  return { text, color }
}

/** The one pending wakeup (SessionInfo.wake). */
export interface PendingWake {
  at: string
  /** The agent's reminder to itself, ≤ 500 chars. */
  note: string
  setAt: string
}

export type WatcherFinal = 'deadline' | 'max-wakeups'
export type WatcherOutcome = 'success' | 'failure' | 'inconclusive' | 'stopped' | 'expired'

/** SessionInfo.watcher — present on a watcher's session from Start (§2.2). */
export interface WatcherState {
  startedAt: string
  deadlineAt: string
  /** Wake turns run so far, counted when the drain takes a wake off the queue. */
  wakeups: number
  /** The final wake has been taken: only `finish_watch` is offered from now on. */
  final?: WatcherFinal
  /** Phase 2 (§6): the one active `watch`. */
  watch?: ActiveWatch
  end?: {
    outcome: WatcherOutcome
    summary: string
    at: string
    by: 'agent' | 'user' | 'host'
  }
  /** A notification the user has not opened yet: the sidebar says "needs attention". */
  attention?: { level: WatcherLevel; text: string; at: string }
}

export type WatcherLevel = 'info' | 'warning' | 'error'

/** Why a watch woke the agent (§6.2); `user` is the pane's Wake now. */
export type WatchReason = 'condition' | 'timeout' | 'broken' | 'user'

/** The one active watch (§6.3), persisted on `WatcherState.watch`. */
export interface ActiveWatch {
  command: string
  everySeconds: number
  /** `changed`, `exit0` or `regex:<re>`. */
  wakeWhen: string
  timeoutAt: string
  note?: string
  setAt: string
  /** `changed` only: the first successful poll's stdout. */
  baseline?: string
  polls: number
  failedInARow: number
  last?: { at: string; exit: number | null; out: string; err: string }
  /** Fired, but its wake could not be sent yet (§5.4): polling has stopped. */
  fired?: { at: string; reason: WatchReason; out: string }
}

/** The poller's limits (§6.1). */
export const WATCH_LIMITS = {
  /** One poll's runtime, then the container is stopped. */
  pollMs: 60_000,
  outBytes: 4 * 1024,
  errBytes: 1024,
  /** Failed polls in a row before the agent is woken to fix its command. */
  brokenAfter: 5,
  /** The regex is tested against at most this much stdout. */
  regexInput: 4 * 1024,
  regexSource: 200
} as const

/** The origin a wake prompt carries in the queue (§5.1). */
export interface WakeOrigin {
  /** `PendingWake.setAt` of the wakeup it carries. */
  wake: string
  final?: WatcherFinal
  /** What the wake was, so Pause can put it back (§3) and a failed turn can retry it (§7). */
  at?: string
  note?: string
}

export const isWakeOrigin = (o: unknown): o is WakeOrigin =>
  !!o && typeof o === 'object' && typeof (o as { wake?: unknown }).wake === 'string'

/** What the renderer's mode reads for one watcher. */
export interface WatcherView {
  name: string
  config: WatcherConfig
  /** The watcher's only session (absent only for a scope whose session is gone). */
  sessionId?: string
  /** Its record, with the runtime overlay — what the sidebar's dot reads. */
  session?: SessionInfo
}

/** Shown in the composer row and the pane: "in 4:12". */
export const formatCountdown = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

/** Local `HH:MM`, with the date when it is not the day of `now` (§5.2). */
export function clockText(iso: string, now: number): string {
  const d = new Date(iso)
  const n = new Date(now)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const same = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  return same ? hm : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`
}

export interface WakeAt {
  at: string
  /** What the tool answers the agent: what the time ended up being. */
  text: string
  clamped: boolean
}

/**
 * When `wake_me({ in_minutes })` falls due: clamped into the watcher's
 * [minDelay, maxDelay] and never past the deadline (§5.2). The result says
 * what happened, so the agent need not retry.
 */
export function wakeAtFor(
  inMinutes: number,
  config: Pick<WatcherConfig, 'minDelayMinutes' | 'maxDelayMinutes'>,
  deadlineAt: string,
  now: number
): WakeAt {
  let minutes = inMinutes
  let why = ''
  if (minutes < config.minDelayMinutes) {
    minutes = config.minDelayMinutes
    why = `clamped to ${minutes} min (this watcher's minimum)`
  } else if (minutes > config.maxDelayMinutes) {
    minutes = config.maxDelayMinutes
    why = `clamped to ${minutes} min (this watcher's maximum)`
  }
  let at = now + minutes * 60_000
  const deadline = Date.parse(deadlineAt)
  if (Number.isFinite(deadline) && at > deadline) {
    at = Math.max(now, deadline)
    why = `clamped to ${clockText(new Date(at).toISOString(), now)}, the deadline`
  }
  const iso = new Date(at).toISOString()
  return { at: iso, clamped: !!why, text: `wake set for ${clockText(iso, now)}${why ? ` — ${why}` : ''}` }
}

/** Why a late wake was late — the agent has to know it missed time (§5.2). */
export type WakeLate = 'restart' | 'busy' | { hold: string }

/** "now 14:31", and why it is late when it is by more than a minute. */
function nowText(now: number, lateMs: number, late: WakeLate | undefined): string {
  let text = `now ${clockText(new Date(now).toISOString(), now)}`
  if (lateMs > 60_000) {
    const reason =
      late === 'restart' || late === undefined
        ? 'Gurt was not running'
        : late === 'busy'
          ? 'a turn was still running'
          : `waited for the plan limit reset (${late.hold})`
    text += ` — late: ${reason}`
  }
  return text
}

/** The message the agent is woken with (§5.2). */
export function wakeText(o: {
  wake: PendingWake
  wakeups: number
  maxWakeups: number
  deadlineAt: string
  now: number
  late?: WakeLate | undefined
}): string {
  const { wake, now } = o
  const n = o.wakeups + 1
  const lateMs = now - Date.parse(wake.at)
  const nowPart = nowText(now, lateMs, o.late)
  const last = n >= o.maxWakeups ? ' This is your last wakeup: report and call `finish_watch`.' : ''
  return (
    `⏰ Wakeup ${n}/${o.maxWakeups}. Your note: "${wake.note}". Set at ${clockText(wake.setAt, now)} ` +
    `for ${clockText(wake.at, now)}, ${nowPart}. Deadline ${clockText(o.deadlineAt, now)}.${last}`
  )
}

/** The deadline's final wake (uncounted, §8). */
export const deadlineText = (deadlineAt: string, now: number): string =>
  `⏰ The deadline (${clockText(deadlineAt, now)}) has come. Report and call \`finish_watch\`.`

/** The message for a typed turn, put in front of it (§5.3): the pending wake
 *  stays, or only `finish_watch` is left. */
export function prefaceFor(
  state: Pick<WatcherState, 'final' | 'watch'>,
  wake: PendingWake | undefined,
  now: number
): string | undefined {
  if (state.final)
    return `(Only \`finish_watch\` is left: ${state.final === 'deadline' ? 'the deadline has passed' : 'no wakeups are left'}.)`
  if (!wake && state.watch && !state.watch.fired)
    return (
      `(Your watch \`${cut(state.watch.command, 120)}\` is still active${state.watch.note ? `: "${state.watch.note}"` : ''}. ` +
      'Keep it, replace it with `wake_me` or `watch`, or finish.)'
    )
  if (!wake) return undefined
  return (
    `(Your wakeup at ${clockText(wake.at, now)} is still pending: "${wake.note}". ` +
    'Keep it, replace it with `wake_me`, or cancel it.)'
  )
}

export const WATCHER_NUDGE_PROMPT =
  'You ended your turn without scheduling your next look. Call `wake_me` ' +
  '(or `watch`) with a note, or `finish_watch` if the monitoring is over, and ' +
  'do nothing else.'

export const WATCHER_FINAL_NUDGE_PROMPT =
  'Call `finish_watch` now with your report, and do nothing else.'

/** The state without its watch (a wakeup replaces it, the end drops it). */
export function withoutWatch(w: WatcherState): WatcherState {
  const { watch: _watch, ...rest } = w
  return rest
}

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Is the watcher active — started and not finished (§3)? */
export const watcherActive = (w: WatcherState | undefined): w is WatcherState => !!w && !w.end

/**
 * The role's `turnComplete` (§7): a turn of an active watcher is satisfied by
 * a pending wakeup, or `finish_watch`. Once `final` is set only `end` counts;
 * a deadline that is due while `final` is not yet set satisfies it too (the
 * final wake follows).
 */
export function watcherTurnSatisfied(
  s: { wake?: PendingWake | undefined; watcher?: WatcherState | undefined },
  now: number
): boolean {
  const w = s.watcher
  if (!w || w.end) return true
  if (w.final) return false
  if (s.wake || w.watch) return true
  return Date.parse(w.deadlineAt) <= now
}

/**
 * What taking a wake off the queue does to the state (§5.1):
 * a plain wake adds one; the last allowed one adds one and sets `final`;
 * the deadline's adds nothing and sets `final`.
 */
export function wakeTaken(state: WatcherState, origin: WakeOrigin): WatcherState {
  if (origin.final === 'deadline') return { ...state, final: 'deadline' }
  const next: WatcherState = { ...state, wakeups: state.wakeups + 1 }
  if (origin.final === 'max-wakeups') next.final = 'max-wakeups'
  return next
}

/** The tool-layer refusals shared by `wake_me` and its siblings (§4.1). Empty
 *  when the call may go on; a `deadline` verdict is a non-error "end your turn". */
export function wakeRefusal(
  state: WatcherState | undefined,
  config: Pick<WatcherConfig, 'maxWakeups'>,
  now: number
): { kind: 'error' | 'deadline'; text: string } | undefined {
  if (!state || state.end) return { kind: 'error', text: 'this watcher has finished — the user can Re-arm it' }
  if (state.final)
    return {
      kind: 'error',
      text: `only finish_watch is left: ${state.final === 'deadline' ? 'the deadline has passed' : 'no wakeups are left'}`
    }
  if (state.wakeups >= config.maxWakeups) return { kind: 'error', text: 'only finish_watch is left: no wakeups are left' }
  if (Date.parse(state.deadlineAt) <= now)
    return { kind: 'deadline', text: 'the deadline has passed — your final wake follows; end your turn' }
  return undefined
}

export type WatcherPhrase = {
  status:
    | 'failed'
    | 'attention'
    | 'working'
    | 'recovering'
    | 'paused'
    | 'waiting'
    | 'watching'
    | 'sleeping'
    | 'idle'
    | 'finished'
    | 'draft'
  tone: 'red' | 'yellow' | 'blue' | 'grey' | 'green' | 'hollow'
  text: string
}

export interface WatcherStatusInput {
  /** The session's state: draft before Start. */
  state: 'draft' | 'queued' | 'starting' | 'started'
  busy: boolean
  recovering: boolean
  /** A turn's failure (start failed, container error, adapter died). */
  error?: string | undefined
  incomplete: boolean
  /** A wake or the deadline is due but held (plan hold, recovering). */
  held?: string | undefined
  wake?: PendingWake | undefined
  watcher?: WatcherState | undefined
  wakeups: boolean
}

/** The sidebar dot and phrase (§3); the first matching row wins. */
export function watcherStatus(v: WatcherStatusInput, now: number): WatcherPhrase {
  const w = v.watcher
  if (v.error) return { status: 'failed', tone: 'red', text: v.error }
  if (!w) {
    if (v.state === 'draft') return { status: 'draft', tone: 'hollow', text: 'not started' }
    return { status: 'working', tone: 'blue', text: 'starting' }
  }
  if (w.attention && !w.end)
    return { status: 'attention', tone: w.attention.level === 'error' ? 'red' : 'yellow', text: w.attention.text }
  if (w.end) {
    const tone = w.end.outcome === 'success' ? 'green' : w.end.outcome === 'failure' ? 'red' : 'grey'
    return { status: 'finished', tone, text: `finished · ${w.end.outcome}` }
  }
  if (v.incomplete) return { status: 'attention', tone: 'yellow', text: 'stopped without scheduling its next look' }
  if (v.busy || v.state === 'starting' || v.state === 'queued') return { status: 'working', tone: 'blue', text: 'working' }
  if (v.recovering) return { status: 'recovering', tone: 'yellow', text: 'waiting — resume it in the checklist' }
  if (!v.wakeups) {
    return {
      status: 'paused',
      tone: 'grey',
      text:
        v.wake && Date.parse(v.wake.at) <= now
          ? `paused — wakeup was due ${clockText(v.wake.at, now)}`
          : w.watch
            ? 'paused — watch kept'
            : 'paused'
    }
  }
  if (v.held && v.wake) return { status: 'waiting', tone: 'yellow', text: `wake due ${clockText(v.wake.at, now)} — ${v.held}` }
  if (v.held && w.watch?.fired)
    return { status: 'waiting', tone: 'yellow', text: `watch fired ${clockText(w.watch.fired.at, now)} — ${v.held}` }
  if (w.watch) {
    const next = w.watch.last ? Date.parse(w.watch.last.at) + w.watch.everySeconds * 1000 : now
    return {
      status: 'watching',
      tone: 'green',
      text: w.watch.fired
        ? 'watch fired'
        : `watching · ${w.watch.polls} checks${w.watch.last ? ` · next check ${formatCountdown(next - now)}` : ''}`
    }
  }
  if (v.wake) return { status: 'sleeping', tone: 'green', text: `sleeping until ${clockText(v.wake.at, now)}` }
  return { status: 'idle', tone: 'grey', text: 'nothing scheduled' }
}

/** The status row's input, read off a session record and the watcher's settings. */
export function watcherStatusOf(info: SessionInfo, config: Pick<WatcherConfig, 'wakeups'>, now: number): WatcherPhrase {
  return watcherStatus(
    {
      state: info.state,
      busy: !!info.busy,
      recovering: info.queueWaiting === 'waiting for resume',
      incomplete: !!info.incomplete,
      wake: info.wake,
      watcher: info.watcher,
      wakeups: config.wakeups
    },
    now
  )
}

// --- watch (phase 2, §6) ------------------------------------------------------

export type WakeWhen = { kind: 'changed' } | { kind: 'exit0' } | { kind: 'regex'; re: RegExp }

/** Parse `wake_when`; undefined when it is none of the three or the regex does
 *  not compile (§4.1). */
export function parseWakeWhen(raw: string): WakeWhen | undefined {
  if (raw === 'changed' || raw === 'exit0') return { kind: raw }
  if (!raw.startsWith('regex:')) return undefined
  const src = raw.slice('regex:'.length)
  if (!src || src.length > WATCH_LIMITS.regexSource) return undefined
  try {
    return { kind: 'regex', re: new RegExp(src, 'm') }
  } catch {
    return undefined
  }
}

/** One poll, as the poller measured it. `exit` is null for a poll that ran past
 *  its limit or could not run at all. */
export interface PollResult {
  at: string
  exit: number | null
  out: string
  err: string
}

/** A failed poll (§6.2): for `exit0` only one that never gave an exit code
 *  (non-zero is its "not yet"), for the others any non-zero exit as well. */
export const pollFailed = (cond: WakeWhen, poll: PollResult): boolean =>
  cond.kind === 'exit0' ? poll.exit === null : poll.exit !== 0

export interface WatchVerdict {
  /** Set when the agent is to be woken. */
  reason?: Exclude<WatchReason, 'user'>
  baseline?: string
  failedInARow: number
}

/**
 * What one poll means (§6.2). A condition beats the timeout; a failed poll can
 * never satisfy a condition; five failed polls in a row wake the agent to fix
 * its command ("broken").
 */
export function watchFired(
  watch: Pick<ActiveWatch, 'wakeWhen' | 'timeoutAt' | 'baseline' | 'failedInARow'>,
  poll: PollResult,
  now: number,
  /** How a `regex:` condition is tested. The poller passes a time-limited one
   *  (agent-supplied patterns can backtrack exponentially); the default is a
   *  plain `RegExp.test`, for pure callers and tests with trusted patterns. */
  testRegex: (re: RegExp, input: string) => boolean = (re, input) => re.test(input)
): WatchVerdict {
  const cond = parseWakeWhen(watch.wakeWhen)
  const timedOut = Date.parse(watch.timeoutAt) <= now
  const base = watch.baseline
  if (!cond) return { reason: 'broken', failedInARow: watch.failedInARow + 1, ...(base !== undefined ? { baseline: base } : {}) }
  const out = poll.out.trim()
  if (pollFailed(cond, poll)) {
    const failedInARow = watch.failedInARow + 1
    const v: WatchVerdict = { failedInARow, ...(base !== undefined ? { baseline: base } : {}) }
    if (failedInARow >= WATCH_LIMITS.brokenAfter) v.reason = 'broken'
    else if (timedOut) v.reason = 'timeout'
    return v
  }
  const v: WatchVerdict = { failedInARow: 0 }
  if (cond.kind === 'changed' && base === undefined) {
    // The first successful poll is the baseline, never a change.
    v.baseline = out
    if (timedOut) v.reason = 'timeout'
    return v
  }
  if (base !== undefined) v.baseline = base
  const met =
    cond.kind === 'exit0' ? poll.exit === 0 : cond.kind === 'changed' ? out !== base : testRegex(cond.re, out.slice(-WATCH_LIMITS.regexInput))
  if (met) v.reason = 'condition'
  else if (timedOut) v.reason = 'timeout'
  return v
}

const byteLength = (s: string): number => new TextEncoder().encode(s).length

/** The last `max` bytes of `s` (UTF-8 safe at the cut). */
export function tailBytes(s: string, max: number): string {
  const buf = new TextEncoder().encode(s)
  if (buf.length <= max) return s
  let from = buf.length - max
  while (from < buf.length && (buf[from]! & 0xc0) === 0x80) from++
  return new TextDecoder().decode(buf.subarray(from))
}

/** Output for a wake message: at most `max` bytes, cut from the head. */
export function cutHead(s: string, max: number): string {
  const total = byteLength(s)
  if (total <= max) return s
  const kept = tailBytes(s, max)
  return `…[${total - byteLength(kept)} bytes cut]\n${kept}`
}

/** What a watch's wake says it was. */
function firedWhat(w: ActiveWatch, reason: WatchReason): string {
  switch (reason) {
    case 'condition':
      return `Watch fired (${w.wakeWhen})`
    case 'timeout':
      return `Watch timed out (${w.wakeWhen} never held)`
    case 'broken':
      return `Watch is broken (${WATCH_LIMITS.brokenAfter} failed checks in a row)`
    case 'user':
      return 'Watch ended by you (Wake now)'
  }
}

/** The message a firing watch wakes the agent with (§6.2). */
export function watchWakeText(o: {
  watch: ActiveWatch
  fired: NonNullable<ActiveWatch['fired']>
  wakeups: number
  maxWakeups: number
  deadlineAt: string
  now: number
  late?: WakeLate | undefined
}): string {
  const { watch: w, fired, now } = o
  const n = o.wakeups + 1
  const lateMs = now - Date.parse(fired.at)
  const exit = w.last ? (w.last.exit === null ? 'no exit: timed out or could not run' : `exit ${w.last.exit}`) : 'no poll yet'
  let body = cutHead(fired.out, WATCH_LIMITS.outBytes)
  if (fired.reason === 'broken' && w.last?.err) body += `${body ? '\n' : ''}[stderr] ${tailBytes(w.last.err, WATCH_LIMITS.errBytes)}`
  const fence = '`'.repeat(Math.max(3, ...(body.match(/`+/g) ?? []).map((m) => m.length + 1)))
  const last = n >= o.maxWakeups ? ' This is your last wakeup: report and call `finish_watch`.' : ''
  return (
    `👁 ${firedWhat(w, fired.reason)} at ${clockText(fired.at, now)} after ${w.polls} checks — wakeup ${n}/${o.maxWakeups}, ` +
    `${nowText(now, lateMs, o.late)}.\n` +
    (w.note ? `Your note: "${w.note}".\n` : '') +
    `\`${cut(w.command, 300)}\`\n` +
    `Last output (${exit}):\n${fence}\n${body}\n${fence}\n` +
    `Deadline ${clockText(o.deadlineAt, now)}.${last}`
  )
}

/** `watch(...)`'s answer to the agent. */
export function watchSetText(w: ActiveWatch, now: number): string {
  return `watching \`${cut(w.command, 120)}\` every ${w.everySeconds} s for ${w.wakeWhen}; times out ${clockText(w.timeoutAt, now)}`
}
