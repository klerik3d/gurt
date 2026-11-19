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
  const nowText = clockText(new Date(now).toISOString(), now)
  let nowPart = `now ${nowText}`
  if (lateMs > 60_000) {
    const reason =
      o.late === 'restart' || o.late === undefined
        ? 'Gurt was not running'
        : o.late === 'busy'
          ? 'a turn was still running'
          : `waited for the plan limit reset (${o.late.hold})`
    nowPart += ` — late: ${reason}`
  }
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
export function prefaceFor(state: Pick<WatcherState, 'final'>, wake: PendingWake | undefined, now: number): string | undefined {
  if (state.final)
    return `(Only \`finish_watch\` is left: ${state.final === 'deadline' ? 'the deadline has passed' : 'no wakeups are left'}.)`
  if (!wake) return undefined
  return (
    `(Your wakeup at ${clockText(wake.at, now)} is still pending: "${wake.note}". ` +
    'Keep it, replace it with `wake_me`, or cancel it.)'
  )
}

export const WATCHER_NUDGE_PROMPT =
  'You ended your turn without scheduling your next look. Call `wake_me` ' +
  'with a note, or `finish_watch` if the monitoring is over, and do nothing else.'

export const WATCHER_FINAL_NUDGE_PROMPT =
  'Call `finish_watch` now with your report, and do nothing else.'

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
  if (s.wake) return true
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
      text: v.wake && Date.parse(v.wake.at) <= now ? `paused — wakeup was due ${clockText(v.wake.at, now)}` : 'paused'
    }
  }
  if (v.held && v.wake) return { status: 'waiting', tone: 'yellow', text: `wake due ${clockText(v.wake.at, now)} — ${v.held}` }
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
