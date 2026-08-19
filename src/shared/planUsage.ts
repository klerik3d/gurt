// Plan limits as the provider itself reports them — the other half of the
// dashboard's agent cards, and the only half that knows what is *left*.
//
// Provenance. `GET /api/oauth/usage` on api.anthropic.com is the call Claude
// Code's own `/usage` makes to draw its plan bars; it is not part of the
// published API. Everything below (the path, the window keys, the field names,
// the labels) was read out of the CLI binary the ACP adapter ships, not guessed
// — but an unpublished endpoint can change without notice, so every consumer
// treats a shape it does not recognize as "no data", never as zero.
//
// This is why it is worth the fragility: usage.ts can only ever count the turns
// gurt itself ran, while a plan's windows are pooled across every Claude
// surface and machine. Utilization from here is the real figure; the ledger is
// the local detail behind it.

/** How the provider keys its windows. Unknown keys are kept, not dropped —
 *  a window we have no label for still has a real number on it. */
export const PLAN_WINDOW_LABELS: Record<string, string> = {
  five_hour: 'current session',
  seven_day: 'current week — all models',
  seven_day_opus: 'current week — Opus',
  seven_day_sonnet: 'current week — Sonnet'
}

/** Order the meters render in; anything else follows, in reported order. */
const ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']

/** One plan window, as reported. */
export interface PlanWindow {
  /** Provider's own key (`five_hour`, `seven_day`, …). */
  id: string
  label: string
  /**
   * How much of the window is consumed.
   *
   * Read as a PERCENT (0–100), which is how the field reads in the CLI's own
   * string table. It is the one thing here that could not be confirmed without
   * a live response, so the raw value rides along in {@link raw} and the UI
   * shows it on hover: if a plan ever reports a 0–1 fraction instead, the
   * mismatch is visible on the first render rather than silently drawn as 1%.
   */
  utilization: number
  /** Exactly what the field held, before clamping — see {@link utilization}. */
  raw: number
  /** ISO instant the window resets, when reported. */
  resetsAt?: string
}

/** What one agent instance's plan looks like right now. */
export interface PlanUsage {
  /** Agent instance id (a key of `AgentsFile`). */
  agent: string
  /** Windows from the last SUCCESSFUL fetch; empty when there has never been one. */
  windows: PlanWindow[]
  /** ISO of that successful fetch — how stale the numbers are. */
  fetchedAt?: string
  /** Why the most recent attempt failed, when it did. `windows` then still
   *  holds the last good read, exactly as `/usage` falls back to its own
   *  last-known bars rather than showing nothing. */
  error?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** The reset instant of one window object, in whatever form it arrived. */
function resetOf(o: Record<string, unknown>): string | undefined {
  const v = o.resets_at ?? o.resetsAt ?? o.reset
  if (typeof v === 'number') {
    // Seconds or milliseconds since the epoch — 1e12 is 2001 in ms, and no
    // plausible reset is 30,000 years out in seconds.
    const at = new Date(v < 1e12 ? v * 1000 : v)
    return Number.isNaN(at.getTime()) ? undefined : at.toISOString()
  }
  if (typeof v !== 'string') return undefined
  const at = new Date(v)
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString()
}

/** The utilization of one window object, or undefined if it carries none. */
function utilizationOf(o: Record<string, unknown>): number | undefined {
  const v = o.utilization ?? o.percent
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * Pull the windows out of a `/api/oauth/usage` body.
 *
 * Deliberately structural rather than schema-bound: it walks the response
 * looking for objects that carry a utilization, keyed by a name, at any depth.
 * The exact nesting is the one thing that could not be read off the binary, and
 * this way getting it wrong costs nothing — an unrecognized body yields an
 * empty list, which every caller already renders as "no data".
 */
export function parsePlanWindows(body: unknown): PlanWindow[] {
  const found = new Map<string, PlanWindow>()
  const visit = (node: unknown, key: string | null, depth: number): void => {
    if (depth > 4 || !isRecord(node)) return
    const util = utilizationOf(node)
    if (key !== null && util !== undefined && !found.has(key)) {
      found.set(key, {
        id: key,
        label: PLAN_WINDOW_LABELS[key] ?? key.replace(/_/g, ' '),
        utilization: Math.max(0, Math.min(100, util)),
        raw: util,
        resetsAt: resetOf(node)
      })
      return
    }
    for (const [k, v] of Object.entries(node)) visit(v, k, depth + 1)
  }
  visit(body, null, 0)
  const known = ORDER.filter((id) => found.has(id)).map((id) => found.get(id)!)
  const rest = [...found.values()].filter((w) => !ORDER.includes(w.id))
  return [...known, ...rest]
}

/** `sk-ant-oat…` — the endpoint authenticates a subscription's OAuth token, and
 *  an API key gets a 401 from it. Checked so a console-key agent is skipped
 *  with a reason instead of failing on every poll. */
export const isOauthToken = (secret: string): boolean => /^sk-ant-oat/.test(secret)

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
