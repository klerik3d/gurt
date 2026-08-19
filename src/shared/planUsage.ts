// Plan limits as the provider itself reports them — the other half of the
// dashboard's agent cards, and the only half that knows what is *left*.
//
// Provenance. `GET /api/oauth/usage` on api.anthropic.com is the call Claude
// Code's own `/usage` makes to draw its plan bars; it is not part of the
// published API. Everything below (the path, the window keys, the field names,
// the labels) was read out of the CLI binary the ACP adapter ships, not
// guessed — last re-verified against CLI 2.1.235, whose response schema is
// what `parsePlanWindows` documents. An unpublished endpoint can still change
// without notice, so every consumer treats a shape it does not recognize as
// "no data", never as zero.
//
// This is why it is worth the fragility: usage.ts can only ever count the turns
// gurt itself ran, while a plan's windows are pooled across every Claude
// surface and machine. Utilization from here is the real figure; the ledger is
// the local detail behind it.

/** How the provider keys its windows — both the keyed form (`five_hour: {…}`)
 *  and the `kind` of a `limits[]` entry resolve through this. Unknown keys are
 *  kept, not dropped: a window we have no label for still has a real number on
 *  it, and renders under its humanized key. `weekly_scoped` entries carry the
 *  model (or surface) they are scoped to in `scope.*.display_name`, which the
 *  parser appends — "Current week (Fable)". */
export const PLAN_WINDOW_LABELS: Record<string, string> = {
  five_hour: 'Current session',
  seven_day: 'Current week (all models)',
  seven_day_opus: 'Current week (Opus)',
  seven_day_sonnet: 'Current week (Sonnet)',
  seven_day_oauth_apps: 'Current week (apps)',
  weekly_scoped: 'Current week',
  extra_usage: 'Extra usage'
}

/** Order the meters render in; anything else — the model-scoped weeks among
 *  them, whose ids are dynamic — follows in reported order. */
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

/** The utilization of one window object, or undefined if it carries none.
 *  (`percent` is the `limits[]` spelling, `utilization` the keyed one; both
 *  arrive null on a window the plan has but is not metering.) */
function utilizationOf(o: Record<string, unknown>): number | undefined {
  const v = o.utilization ?? o.percent
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** The display name a `limits[]` entry is scoped to, if any — a model
 *  ("Fable") or a surface, whichever the entry carries. */
function scopeNameOf(o: Record<string, unknown>): string | undefined {
  if (!isRecord(o.scope)) return undefined
  for (const target of [o.scope.model, o.scope.surface]) {
    if (isRecord(target) && typeof target.display_name === 'string') return target.display_name
  }
  return undefined
}

/**
 * Pull the windows out of a `/api/oauth/usage` body.
 *
 * Two shapes exist in the wild, and a body may carry both at once:
 * - keyed: `{ five_hour: {utilization, resets_at}, seven_day: {…} }`
 * - listed: `{ limits: [{kind, percent, resets_at, scope: {model: {display_name}}}] }`
 *   — the newer form (CLI 2.1.x), and the only place model-scoped weeks
 *   ("Current week (Fable)") are reported.
 *
 * Deliberately structural rather than schema-bound: it walks the response
 * looking for objects that carry a utilization — keyed by name or describing
 * themselves via `kind` — at any depth. The exact nesting is the one thing
 * that could not be read off the binary, and this way getting it wrong costs
 * nothing — an unrecognized body yields an empty list, which every caller
 * already renders as "no data". Where both shapes report the same window the
 * keyed one wins (first found), so nothing draws twice.
 */
export function parsePlanWindows(body: unknown): PlanWindow[] {
  const found = new Map<string, PlanWindow>()
  const put = (id: string, label: string, util: number, resetsAt?: string): void => {
    if (!found.has(id))
      found.set(id, {
        id,
        label,
        utilization: Math.max(0, Math.min(100, util)),
        raw: util,
        resetsAt
      })
  }
  const visit = (node: unknown, key: string | null, depth: number): void => {
    if (depth > 5) return
    if (Array.isArray(node)) {
      for (const el of node) visit(el, null, depth + 1)
      return
    }
    if (!isRecord(node)) return
    const util = utilizationOf(node)
    const kind = typeof node.kind === 'string' ? node.kind : undefined
    if (kind && util !== undefined) {
      const base = PLAN_WINDOW_LABELS[kind] ?? kind.replace(/_/g, ' ')
      const name = scopeNameOf(node)
      put(name ? `${kind}:${name}` : kind, name ? `${base} (${name})` : base, util, resetOf(node))
      return
    }
    if (key !== null && util !== undefined) {
      put(key, PLAN_WINDOW_LABELS[key] ?? key.replace(/_/g, ' '), util, resetOf(node))
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
