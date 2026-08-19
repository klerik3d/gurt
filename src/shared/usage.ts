// Agent usage accounting — the pure model behind the dashboard's agent cards.
//
// What this can and cannot know. gurt observes only the turns it ran itself:
// how many, how long, what the adapter reported, and whether the provider
// refused one because a limit was reached. The *remaining* quota of a plan is
// not exposed over ACP by any adapter we drive, so nothing here pretends to
// know a percentage of a limit. The windows below are the provider's published
// window *shapes*, filled with gurt's own observations — the dashboard labels
// them that way.
import type { SessionUsage } from './types'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** How a turn ended, for accounting. `limited` is an `error` the limit
 *  detector claimed — it is the one outcome that says "the plan, not the code". */
export type TurnOutcome = 'ok' | 'error' | 'limited' | 'cancelled'

/**
 * One completed agent turn: a single `session/prompt` round-trip. The turn
 * contract's automatic nudge is a round-trip of its own and is recorded like
 * any other — it consumes the same quota.
 */
export interface TurnRecord {
  /** ISO timestamp of the turn's END (the ledger is append-ordered by it). */
  ts: string
  /** Agent instance id (a key of `AgentsFile`); '' when the session had none. */
  agent: string
  /** Agent kind (an `AgentDef.id`) — what {@link agentLimits} keys on. */
  kind: string
  sessionId: string
  workspace: string
  task: string
  /** Wall-clock duration of the turn, ms. */
  ms: number
  outcome: TurnOutcome
  /** Context-window occupancy at the turn's end, when the adapter reports usage.
   *  NOT cumulative: it drops on compaction, so it is aggregated as a peak. */
  ctx?: number
  /** Session-cumulative cost at the turn's end, when reported. Cumulative, so a
   *  window's own cost is the rise of this counter inside it (see `aggregate`). */
  cost?: number
  currency?: string
  /** stopReason / error text — what the limit detector read, kept for the UI. */
  detail?: string
  /** Provider-stated reset time, when the refusal named one (ISO). */
  resetAt?: string
}

/** A provider limit window shape: the published period, not a quota. */
export interface LimitWindowDef {
  id: string
  label: string
  /** Window length, ms. */
  ms: number
  /** One line under the meter — what the window is, in the provider's terms. */
  hint: string
}

/**
 * Limit windows gurt can actually anchor, per agent kind. A kind with no entry
 * gets the trailing rollups only — better than asserting a window shape we
 * would be guessing at.
 *
 * Only the session window is modelled, and only for claude-code. The rule that
 * decides this is *can gurt locate the window's start?*:
 *
 * - The **5-hour session window** is session-based — it opens with a turn and
 *   resets five hours later — so the first turn not covered by the previous
 *   window locates it exactly. That is what {@link windowsOf} computes.
 * - The **weekly window is deliberately absent.** A plan's weekly limit resets
 *   "at a fixed time each week that is assigned to your account", unchanged by
 *   when you started using Claude. That anchor lives on the account and is not
 *   discoverable from anything gurt observes, so a 7-day window rolled from the
 *   first turn would drift from the real cycle and quietly report the wrong
 *   reset. The dashboard shows a trailing 7-day rollup instead and says so.
 * - **codex** has no entry: its plan windows were never verified against a
 *   published source, and an unverified window is exactly what this comment
 *   exists to keep out.
 * - **opencode** fronts whatever provider its instance points at, usually a
 *   per-token API key with no window at all.
 *
 * Note that even the session window is a lower bound: plan usage is pooled
 * across every Claude surface (claude.ai, Claude Code, Claude Desktop) and
 * across machines, and gurt sees only the turns it ran itself.
 */
const LIMITS: Record<string, LimitWindowDef[]> = {
  'claude-code': [
    {
      id: 'session',
      label: '5-hour window',
      ms: 5 * HOUR,
      hint: 'session limit — opens with the first turn after the last one closed'
    }
  ],
  codex: [],
  opencode: []
}

export const agentLimits = (kind: string): LimitWindowDef[] => LIMITS[kind] ?? []

/**
 * Signatures of "the provider stopped this turn, not the code". Loose on
 * purpose: every adapter wraps the upstream message differently, and the cost
 * of a miss (a limit hit filed as a plain error) is worse than the cost of a
 * false positive (one turn drawn in red, with its own text right next to it).
 */
const LIMIT_PATTERNS = [
  // Claude Code's own wording, verbatim: "You've hit your session limit" (the
  // 5-hour window), "…your weekly limit", "…your Opus limit" (model-specific,
  // and the one case where switching models keeps you working).
  /hit your .{0,24}limit/i,
  /\b(session|weekly|hourly|daily|opus) limit\b/i,
  /usage limit reached/i,
  /rate.?limit/i,
  /\bquota\b.*\b(exceed|reach|exhaust)/i,
  /limit (will )?reset/i,
  /too many requests/i,
  /\b429\b/
]

export const isLimitMessage = (text?: string): boolean =>
  !!text && LIMIT_PATTERNS.some((re) => re.test(text))

/** The reset instant a refusal named, when it named one as a machine-readable
 *  value (ISO or a unix stamp). Prose forms ("resets at 3pm") are left alone —
 *  parsing those needs the provider's timezone, which the message doesn't carry. */
export function limitResetAt(text?: string): string | undefined {
  const m = text?.match(
    /reset\w*(?:\s+at)?[\s:="']*(\d{4}-\d{2}-\d{2}T[\d:.]+Z?|\d{10}(?:\d{3})?)\b/i
  )
  if (!m) return undefined
  const raw = m[1]
  const at = /^\d+$/.test(raw) ? new Date(Number(raw) * (raw.length === 10 ? 1000 : 1)) : new Date(raw)
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString()
}

/** Fold a turn's raw ending into the recorded outcome. */
export function turnOutcome(o: {
  threw: boolean
  stopReason?: string
  detail?: string
}): TurnOutcome {
  if (isLimitMessage(o.detail)) return 'limited'
  if (o.threw) return 'error'
  if (o.stopReason === 'cancelled') return 'cancelled'
  return o.stopReason === 'end_turn' || !o.stopReason ? 'ok' : 'error'
}

/** What one window (or trailing span) of turns adds up to. */
export interface UsageWindow {
  /** Epoch ms bounds. `end` is exclusive and may lie in the future (open window). */
  start: number
  end: number
  turns: number
  /** Agent-busy time inside the window, ms — the closest proxy to "consumed"
   *  gurt can actually measure. */
  ms: number
  /** Distinct sessions that ran a turn here. */
  sessions: number
  errors: number
  /** Turns the provider refused for a limit. */
  limited: number
  /** ISO of the first such refusal, when there was one. */
  limitedAt?: string
  /** Provider-stated reset time from that refusal, when it carried one. */
  resetAt?: string
  /** Cost accrued inside the window: the rise of each session's cumulative
   *  counter, summed. Undefined when no turn here reported cost. */
  cost?: number
  currency?: string
  /** Highest context occupancy seen; `ctx` is not cumulative, so it cannot be summed. */
  peakCtx?: number
}

/** Aggregate an already-bounded slice of turns. `records` need not be sorted. */
export function aggregate(records: TurnRecord[], start: number, end: number): UsageWindow {
  const w: UsageWindow = { start, end, turns: 0, ms: 0, sessions: 0, errors: 0, limited: 0 }
  const sessions = new Set<string>()
  /** Per session: the lowest and highest cumulative cost seen inside the window. */
  const cost = new Map<string, { lo: number; hi: number }>()
  for (const r of records) {
    w.turns++
    w.ms += r.ms
    sessions.add(r.sessionId)
    if (r.outcome === 'error') w.errors++
    if (r.outcome === 'limited') {
      w.limited++
      if (!w.limitedAt || r.ts < w.limitedAt) {
        w.limitedAt = r.ts
        w.resetAt = r.resetAt
      }
    }
    if (r.ctx != null) w.peakCtx = Math.max(w.peakCtx ?? 0, r.ctx)
    if (r.cost != null) {
      const cur = cost.get(r.sessionId)
      if (!cur) cost.set(r.sessionId, { lo: r.cost, hi: r.cost })
      else {
        cur.lo = Math.min(cur.lo, r.cost)
        cur.hi = Math.max(cur.hi, r.cost)
      }
      w.currency ??= r.currency
    }
  }
  w.sessions = sessions.size
  // A session whose first turn in this window already carried cost accrued
  // earlier contributes only its rise here — which is exactly hi - lo.
  if (cost.size) w.cost = [...cost.values()].reduce((sum, c) => sum + (c.hi - c.lo), 0)
  return w
}

/**
 * Slice turns into provider-shaped windows. A window opens with the first turn
 * not covered by the previous one and closes `ms` later — the same "the window
 * starts when you start using it" rule the providers document, which is why the
 * anchor is a turn and never the clock or a calendar boundary.
 *
 * Oldest first. The last window is the live one iff its `end` is still ahead of
 * `now`; when it isn't, no window is open and the next turn will start one.
 */
export function windowsOf(records: TurnRecord[], ms: number): UsageWindow[] {
  const sorted = [...records].sort((a, b) => a.ts.localeCompare(b.ts))
  const out: UsageWindow[] = []
  let bucket: TurnRecord[] = []
  let start = 0
  const flush = (): void => {
    if (bucket.length) out.push(aggregate(bucket, start, start + ms))
    bucket = []
  }
  for (const r of sorted) {
    const t = Date.parse(r.ts)
    if (!Number.isFinite(t)) continue
    if (!bucket.length) start = t
    else if (t >= start + ms) {
      flush()
      start = t
    }
    bucket.push(r)
  }
  flush()
  return out
}

/** Everything one agent instance's card renders. */
export interface AgentUsage {
  /** Agent instance id (a key of `AgentsFile`). */
  agent: string
  kind: string
  /** One entry per published window shape of the kind; empty for kinds with none. */
  limits: {
    def: LimitWindowDef
    /** Oldest first, capped by the caller's retention. */
    history: UsageWindow[]
    /** The window still open right now, if any — always the last of `history`. */
    open?: UsageWindow
  }[]
  /** Trailing spans, independent of any window model. */
  day: UsageWindow
  week: UsageWindow
  /** ISO of the most recent turn, when there is one. */
  lastAt?: string
}

/** Build one agent instance's view. `records` must already be that agent's. */
export function agentUsage(records: TurnRecord[], kind: string, now: number): AgentUsage {
  const since = (span: number): TurnRecord[] =>
    records.filter((r) => Date.parse(r.ts) >= now - span)
  const limits = agentLimits(kind).map((def) => {
    const history = windowsOf(records, def.ms)
    const last = history[history.length - 1]
    return { def, history, open: last && last.end > now ? last : undefined }
  })
  let lastAt: string | undefined
  for (const r of records) if (!lastAt || r.ts > lastAt) lastAt = r.ts
  return {
    agent: records[0]?.agent ?? '',
    kind,
    limits,
    day: aggregate(since(DAY), now - DAY, now),
    week: aggregate(since(7 * DAY), now - 7 * DAY, now),
    lastAt
  }
}

/** Compact duration for meters and rows: `4h 12m`, `12m`, `48s`, `—` for zero. */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rest = m % 60
  if (h < 24) return rest ? `${h}h ${rest}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}

/** `in 2h 14m` / `now` — for a window's remaining time. */
export const formatIn = (ms: number): string => (ms <= 0 ? 'now' : `in ${formatDuration(ms)}`)

/** `1.2M` / `84k` / `912` — the token-ish counters. */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(Math.round(n))
}

/** The turn record fields an adapter's usage report contributes. */
export const usageFields = (u?: SessionUsage): Pick<TurnRecord, 'ctx' | 'cost' | 'currency'> =>
  u ? { ctx: u.used, cost: u.cost?.amount, currency: u.cost?.currency } : {}
