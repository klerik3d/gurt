// Proactive agents (docs/design-proactive-agents.md): shapes and pure rules
// shared by main (the manager, the `gurt` tools) and the renderer (the mode).
import type { SessionInfo } from './types'

/**
 * A proactive agent's settings — `task.json`'s `proactive` member of the scope
 * that holds its template and its runs. The rest of its configuration (agent,
 * env, repos, MCP, skills, network, instructions) is the template session's own
 * draft config, edited where every draft is edited.
 */
export interface ProactiveConfig {
  /** Runs start on schedule only while enabled; "Run now" works either way. */
  enabled: boolean
  /** One run every this many minutes, counted from the last run's start. */
  everyMinutes: number
  /** Scopes of this agent still waiting for the user — every session still an
   *  untouched draft. At the limit a due run is skipped, and a run in progress
   *  may raise no more (§5). */
  maxPendingScopes: number
  /** A run still going after this long is cancelled. */
  maxRunMinutes: number
  /** Finished run sessions kept for inspection; older ones are deleted (their
   *  summary stays in the run history). */
  keepRuns: number
  /** Id of the template session — the draft each run is copied from. */
  templateId?: string
}

export const PROACTIVE_DEFAULTS: Omit<ProactiveConfig, 'templateId'> = {
  enabled: false,
  everyMinutes: 60,
  maxPendingScopes: 10,
  maxRunMinutes: 30,
  keepRuns: 5
}

/** Bounds every numeric setting is clamped to. */
export const PROACTIVE_BOUNDS: Record<
  Exclude<keyof ProactiveConfig, 'enabled' | 'templateId'>,
  [number, number]
> = {
  everyMinutes: [5, 7 * 24 * 60],
  maxPendingScopes: [1, 200],
  maxRunMinutes: [5, 240],
  keepRuns: [1, 50]
}

/** Coerce untrusted input (the renderer, a hand-edited task.json) into a valid
 *  config; anything missing or malformed keeps `fallback`'s value, and unknown
 *  keys (an older build's `maxScopesPerRun`) are dropped. */
export function sanitizeProactiveConfig(
  raw: unknown,
  fallback: ProactiveConfig = PROACTIVE_DEFAULTS
): ProactiveConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: ProactiveConfig = {
    enabled: typeof r['enabled'] === 'boolean' ? r['enabled'] : fallback.enabled,
    everyMinutes: fallback.everyMinutes,
    maxPendingScopes: fallback.maxPendingScopes,
    maxRunMinutes: fallback.maxRunMinutes,
    keepRuns: fallback.keepRuns
  }
  for (const [key, [lo, hi]] of Object.entries(PROACTIVE_BOUNDS) as [
    keyof typeof PROACTIVE_BOUNDS,
    [number, number]
  ][]) {
    const v = r[key]
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = Math.min(hi, Math.max(lo, Math.round(v)))
  }
  const templateId = typeof r['templateId'] === 'string' ? r['templateId'] : fallback.templateId
  if (templateId) out.templateId = templateId
  return out
}

/** One note an agent appended to a scope it (or another agent) raised. */
export interface ProactiveNote {
  at: string
  agent: string
  run: string
  text: string
}

/**
 * Where a scope came from — `task.json`'s `origin` member, written in the same
 * write that creates the scope. The refs are the identity (§5): one ref is
 * bound to at most one scope in a workspace.
 */
export interface ProactiveOrigin {
  /** Name of the proactive agent (its scope's name). */
  agent: string
  /** Session id of the run that proposed it. */
  run: string
  refs: string[]
  title: string
  summary: string
  createdAt: string
  notes?: ProactiveNote[]
}

export type ProactiveRunOutcome =
  | 'running'
  | 'skipped'
  | 'finished'
  | 'incomplete'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  | 'interrupted'

/** One run in the agent's history. `id` is the run session's id — the session
 *  itself may have been collected since (`keepRuns`). A `skipped` or `failed`
 *  slot never had a session. */
export interface ProactiveRun {
  id: string
  startedAt: string
  endedAt?: string
  outcome: ProactiveRunOutcome
  /** Scopes this run created. */
  proposed: string[]
  /** Scopes this run attached refs or notes to. */
  attached: string[]
  summary?: string
  error?: string
}

/** `<ws>/<agent>/proactive-state.json` — what the agent remembers between runs. */
export interface ProactiveState {
  cursor?: string
  /** Start of the last run (scheduled or manual); the next one is due
   *  `everyMinutes` after it. */
  lastRunAt?: string
  runs: ProactiveRun[]
}

export const emptyProactiveState = (): ProactiveState => ({ runs: [] })

/** History kept per agent. */
export const PROACTIVE_RUNS_KEPT = 50

/** What the renderer's mode reads for one agent. */
export interface ProactiveAgentView {
  name: string
  config: ProactiveConfig
  state: ProactiveState
  /** Next scheduled run (ISO), absent while disabled. */
  nextRunAt?: string
  /** Id of the run in progress, if any. */
  activeRun?: string
  /** The template draft and the run sessions still kept. */
  sessions: SessionInfo[]
}

/** `<source>:<id>` — lowercase source, then anything without whitespace. */
const REF_RE = /^[a-z][a-z0-9_-]{0,31}:\S{1,300}$/

/** Validate and normalize refs: trimmed, deduplicated, shape-checked. */
export function normalizeRefs(refs: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of refs) {
    const ref = raw.trim()
    if (!REF_RE.test(ref))
      throw new Error(
        `"${raw}" is not a ref — use <source>:<id>, e.g. "sentry:4521337", "mail:<message-id>", ` +
          '"slack:C01ABC/1699999999.000100", "gh:org/repo#123"'
      )
    if (!out.includes(ref)) out.push(ref)
  }
  return out
}

/**
 * A scope name from a title: lowercase ascii words joined by `-`, cut to a
 * length a branch name carries comfortably. Scope names become branch names
 * (`<task>` in every clone), so only what git accepts everywhere is kept.
 */
export function scopeSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug || 'proactive'
}

/** When the next scheduled run is due: `everyMinutes` after the last run's
 *  start, or right away for an agent that has never run. Missed slots are not
 *  replayed — a run due in the past is one run, now (§3.1). */
export function nextRunDue(config: ProactiveConfig, state: Pick<ProactiveState, 'lastRunAt'>): number {
  if (!state.lastRunAt) return 0
  const last = Date.parse(state.lastRunAt)
  return Number.isFinite(last) ? last + config.everyMinutes * 60_000 : 0
}

/** A scope is pending ("waiting for you") while the user has not acted on it:
 *  it has sessions and every one of them is still a draft. What
 *  `maxPendingScopes` counts; any other raised scope is "in progress". */
export const isPendingScope = (sessions: readonly Pick<SessionInfo, 'state'>[]): boolean =>
  sessions.length > 0 && sessions.every((s) => s.state === 'draft')
