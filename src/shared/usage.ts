// The turn ledger's pure model: what one recorded turn is, how a refusal is
// recognized as a limit hit, and the small formatters the UI shares.
//
// What this can and cannot know. gurt observes only the turns it ran itself:
// how many, how long, what the adapter reported, and whether the provider
// refused one because a limit was reached. How much of a plan is *used* has
// exactly one honest source — the provider's own usage endpoint (see
// shared/planUsage.ts) — so nothing here derives a quota from turn counts.
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
  /** Agent kind (an `AgentDef.id`). */
  kind: string
  sessionId: string
  workspace: string
  task: string
  /** Wall-clock duration of the turn, ms. */
  ms: number
  outcome: TurnOutcome
  /** Context-window occupancy at the turn's end, when the adapter reports
   *  usage. NOT cumulative: it drops on compaction. */
  ctx?: number
  /** Session-cumulative cost at the turn's end, when reported. */
  cost?: number
  currency?: string
  /** stopReason / error text — what the limit detector read, kept for the UI. */
  detail?: string
  /** Provider-stated reset time, when the refusal named one (ISO). */
  resetAt?: string
}

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
  const raw = /reset\w*(?:\s+at)?[\s:="']*(\d{4}-\d{2}-\d{2}T[\d:.]+Z?|\d{10}(?:\d{3})?)\b/i.exec(
    text ?? ''
  )?.[1]
  if (!raw) return undefined
  const at = /^\d+$/.test(raw) ? new Date(Number(raw) * (raw.length === 10 ? 1000 : 1)) : new Date(raw)
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString()
}

/** Fold a turn's raw ending into the recorded outcome. */
export function turnOutcome(o: {
  threw: boolean
  stopReason?: string | undefined
  detail?: string | undefined
}): TurnOutcome {
  if (isLimitMessage(o.detail)) return 'limited'
  if (o.threw) return 'error'
  if (o.stopReason === 'cancelled') return 'cancelled'
  return o.stopReason === 'end_turn' || !o.stopReason ? 'ok' : 'error'
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

/** The turn record fields an adapter's usage report contributes. */
export const usageFields = (u?: SessionUsage): Pick<TurnRecord, 'ctx' | 'cost' | 'currency'> =>
  u ? { ctx: u.used, ...(u.cost ? { cost: u.cost.amount, currency: u.cost.currency } : {}) } : {}
