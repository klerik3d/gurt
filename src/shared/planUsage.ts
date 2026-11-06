// Plan limits as the provider itself reports them — the other half of the
// dashboard's agent cards, and the only half that knows what is *left*.
//
// Where the numbers come from is each agent plugin's business: a live event
// riding normal session responses, a poll of the provider's usage endpoint,
// or both (main/planUsage.ts; the claude-code plugin documents the
// unpublished endpoint it reads). Such a source can change without notice, so
// every consumer treats a shape it does not recognize as "no data", never as
// zero.
//
// This is why it is worth the fragility: usage.ts can only ever count the turns
// gurt itself ran, while a plan's windows are pooled across every surface and
// machine of the account. Utilization from here is the real figure; the ledger
// is the local detail behind it.
import { agentDef } from './agents'

/** One plan window, as reported. */
export interface PlanWindow {
  /** Provider's own key (`five_hour`, `seven_day`, …), as the kind's plugin
   *  reports it. */
  id: string
  label: string
  /**
   * How much of the window is consumed.
   *
   * Normalized percentage (0–100). SDK fractions are multiplied by 100;
   * the usage endpoint already reports percentages.
   */
  utilization: number
  /** Exactly what the field held, before clamping — see {@link utilization}. */
  raw: number
  /** ISO instant the window resets, when reported. */
  resetsAt?: string
  /** Provider-reported duration; Codex windows need not be 5h or weekly. */
  durationSeconds?: number
}

/** What one agent instance's plan looks like right now. */
export interface PlanUsage {
  /** Agent instance id (a key of `AgentsFile`). */
  agent: string
  /** Windows from the last SUCCESSFUL fetch; empty when there has never been one. */
  windows: PlanWindow[]
  /** ISO of that successful fetch — how stale the numbers are. */
  fetchedAt?: string
  /** Why the most recent attempt failed, when it did — cleared by assignment on
   *  the next successful poll. `windows` then still holds the last good read,
   *  exactly as `/usage` falls back to its own last-known bars rather than
   *  showing nothing. */
  error?: string | undefined
  /** The account can keep spending past an exhausted window — Anthropic's
   *  extra usage switched on with room left, Codex credits, or a live event
   *  saying overage is allowed. From the same read as `windows`. */
  overage?: boolean | undefined
  /** The provider refused work and this is when it expects to accept again
   *  (ISO): a live event with `status: rejected`, or a turn the limit detector
   *  claimed. Cleared by the next live event that is allowed. */
  rejectedUntil?: string | undefined
}

/** Past this, a cached read has stopped being current. The same hour Claude
 *  Code's own `/usage` keeps its last-known bars for; the dashboard labels a
 *  stale read rather than hiding it, because a stale real number still beats
 *  no number. */
export const STALE_AFTER_MS = 60 * 60_000

/** Ordered worst-first: the window closest to its limit is the one to show. */
export const tightest = (windows: PlanWindow[]): PlanWindow | undefined =>
  windows.length
    ? windows.reduce((a, b) => (b.utilization > a.utilization ? b : a))
    : undefined

/** One kind's window lengths, for windows whose report carries none —
 *  compiled once per kind. Only the kind's own plugin can say: window ids are
 *  each provider's own keys, and two providers may well spell one alike. */
const durationsByKind = new Map<string, readonly { match: RegExp; seconds: number }[]>()
function windowDurations(kind: string | undefined): readonly { match: RegExp; seconds: number }[] {
  const def = kind ? agentDef(kind) : undefined
  if (!def) return []
  let hit = durationsByKind.get(def.id)
  if (!hit) {
    hit = (def.planWindows?.durations ?? []).map((d) => ({ match: new RegExp(d.match), seconds: d.seconds }))
    durationsByKind.set(def.id, hit)
  }
  return hit
}

/** Time progress is only meaningful for windows with a known duration/reset.
 *  `kind` is the agent kind the window was reported for: a window that names
 *  no duration of its own is timed by that kind's plugin
 *  (`planWindows.durations`), and by nothing else. */
export function windowElapsedPercent(window: PlanWindow, now: number, kind: string | undefined): number | undefined {
  const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN
  const duration = window.durationSeconds ?? windowDurations(kind).find((d) => d.match.test(window.id))?.seconds
  if (duration === undefined || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(reset) || !Number.isFinite(now)) return undefined
  return Math.min(100, Math.max(0, (1 - (reset - now) / (duration * 1000)) * 100))
}

// --- the launch gate ---------------------------------------------------------
//
// What the numbers above are *for* beyond the dashboard: an account at its
// limit gets no new work. The scheduler holds its queued drafts, a started
// session's queued messages wait, and a session a limit cut off sends
// "continue" on its own once the hold lifts (main/sessions.ts).
//
// Deliberately simple metrics: every window counts the same, model-scoped
// weeks included. A window a session's model does not draw from can hold it
// back needlessly; that is the price of not modelling which model eats which
// pool, and the threshold below is the knob.

/** Global plan-limit policy (Settings → Clients). */
export interface LimitSettings {
  /** No new work starts on an account once any of its windows is at least
   *  this full. Below 100 on purpose: a long task started at 99% is cut off
   *  mid-way, and Codex's numbers arrive by poll, minutes late. */
  thresholdPercent: number
}

export const LIMIT_DEFAULTS: LimitSettings = { thresholdPercent: 95 }
export const LIMIT_THRESHOLD_MIN = 50
export const LIMIT_THRESHOLD_MAX = 100

/** The IPC boundary and the file on disk are untrusted: coerce, falling back
 *  to `fallback` (the current settings) for a missing or garbled field. */
export function normalizeLimitSettings(raw: unknown, fallback: LimitSettings = LIMIT_DEFAULTS): LimitSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof LimitSettings, unknown>>
  const t = r.thresholdPercent
  return {
    thresholdPercent:
      typeof t === 'number' && Number.isFinite(t)
        ? Math.min(LIMIT_THRESHOLD_MAX, Math.max(LIMIT_THRESHOLD_MIN, Math.round(t)))
        : fallback.thresholdPercent
  }
}

/** Why an account is held, and until when. */
export interface PlanHold {
  /** ISO instant the hold is expected to lift. Absent when nothing named one —
   *  the hold then lifts on the next read that is under the threshold. */
  until?: string
  /** Short label of what is full: "Current session 97%". */
  reason: string
}

/** Spend-past-the-limit, not a limit: it decides whether the others bind. */
const EXTRA_USAGE = 'extra_usage'

/**
 * Is this account held right now? `usages` are the snapshots of every agent
 * instance on one credential — the plan is pooled per account, so whichever
 * of them read it last speaks for all.
 *
 * - A refusal the provider stated (`rejectedUntil`) holds until that instant,
 *   whatever the windows say — the provider has already counted the overage.
 * - Otherwise a window at or past `thresholdPercent` holds, unless the account
 *   can spend past it (`overage`: Anthropic's extra usage, Codex credits).
 * - A window whose reset has passed no longer counts, even before a fresh
 *   read confirms it — a live-event-only credential reports nothing until the
 *   next turn, and that turn is exactly what the hold would be waiting for.
 *   One with no reset counts only while its read is fresh.
 * - A provider that resets early (OpenAI does) lifts the hold on the next
 *   poll: the freshest read wins over the old reset time.
 */
export function planHold(usages: PlanUsage[], thresholdPercent: number, now: number): PlanHold | undefined {
  let rejected: number | undefined
  for (const u of usages) {
    const at = u.rejectedUntil ? Date.parse(u.rejectedUntil) : NaN
    if (Number.isFinite(at) && at > now && (rejected === undefined || at > rejected)) rejected = at
  }
  if (rejected !== undefined) return { until: new Date(rejected).toISOString(), reason: 'limit reached' }
  const read = (u: PlanUsage): number => (u.fetchedAt ? Date.parse(u.fetchedAt) : NaN)
  const fresh = usages
    .filter((u) => u.windows.length && Number.isFinite(read(u)))
    .reduce<PlanUsage | undefined>((a, b) => (!a || read(b) > read(a) ? b : a), undefined)
  if (!fresh || fresh.overage) return undefined
  const current = now - read(fresh) < STALE_AFTER_MS
  const full = fresh.windows.filter((w) => {
    if (w.id === EXTRA_USAGE || w.utilization < thresholdPercent) return false
    const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN
    return Number.isFinite(reset) ? reset > now : current
  })
  if (!full.length) return undefined
  const worst = full.reduce((a, b) => (b.utilization > a.utilization ? b : a))
  const reason = `${worst.label} ${Math.round(worst.utilization)}%`
  // Every full window has to clear, so the hold lasts until the latest reset —
  // and has no known end if any of them named none.
  const resets = full.map((w) => (w.resetsAt ? Date.parse(w.resetsAt) : NaN))
  if (resets.some((r) => !Number.isFinite(r))) return { reason }
  return { until: new Date(Math.max(...resets)).toISOString(), reason }
}

/** "15:00", or "Thu 15:00" when it is not within the next day — how a hold's
 *  end is worded wherever a session says what it is waiting for. */
export function formatResetAt(iso: string, now: number): string {
  const at = new Date(iso)
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return at.getTime() - now < 20 * 60 * 60_000 ? time : `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`
}
