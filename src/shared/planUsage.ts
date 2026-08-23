// Plan limits as the provider itself reports them — the other half of the
// dashboard's agent cards, and the only half that knows what is *left*.
//
// Provenance. `GET /api/oauth/usage` on api.anthropic.com is the call Claude
// Code's own `/usage` makes to draw its plan bars; it is not part of the
// published API. Everything below (the path, the window keys, the field names,
// the labels) was read out of the CLI binary the ACP adapter ships, not
// guessed — last re-verified against CLI 2.1.235, whose response schema is
// what `parsePlanWindows` (main/planUsage.ts, next to the fetch that needs it)
// documents. An unpublished endpoint can still change
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
  /** Why the most recent attempt failed, when it did — cleared by assignment on
   *  the next successful poll. `windows` then still holds the last good read,
   *  exactly as `/usage` falls back to its own last-known bars rather than
   *  showing nothing. */
  error?: string | undefined
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
