// Caches subscription limits from live Claude sessions and Claude/Codex OAuth polls.
//
// Token credentials use rate-limit events from normal session responses.
// Browser OAuth credentials can also poll the unpublished usage endpoint.
// Both sources preserve the last good snapshot when data is unavailable.
import { z } from 'zod'
import type { CredentialEntry } from '../shared/credentials'
import { resolveAgentSecret } from '../shared/credentials'
import type { AgentsFile } from '../shared/types'
import type { PlanUsage, PlanWindow } from '../shared/planUsage'
import { isOauthToken, PLAN_WINDOW_LABELS } from '../shared/planUsage'
export { STALE_AFTER_MS } from '../shared/planUsage'
import type { Bus } from './bus'
import { createLogger } from './log'

const log = createLogger('plan-usage')

/** Order the meters render in; anything else — the model-scoped weeks among
 *  them, whose ids are dynamic — follows in reported order. */
const ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * One node of the response, read through the field spellings this endpoint is
 * known to use. Every member is optional and `.catch`es back to "absent", which
 * is what keeps the parser as tolerant as the hand-rolled reads it replaces: an
 * incomplete body, a window the plan is not metering (fields arrive `null`), or
 * a spelling that changes again all degrade to "no data" for that node, never
 * to a thrown parse. Loose: unknown members are what the walk below recurses
 * into.
 */
const USAGE_NODE = z.looseObject({
  // Reset instant. Three spellings in the wild, and either an ISO string or an
  // epoch number.
  resets_at: z.union([z.string(), z.number()]).nullish().catch(undefined),
  resetsAt: z.union([z.string(), z.number()]).nullish().catch(undefined),
  reset: z.union([z.string(), z.number()]).nullish().catch(undefined),
  // `percent` is the `limits[]` spelling, `utilization` the keyed one.
  utilization: z.number().nullish().catch(undefined),
  percent: z.number().nullish().catch(undefined),
  kind: z.string().nullish().catch(undefined),
  scope: z
    .looseObject({
      model: z.looseObject({ display_name: z.string().nullish().catch(undefined) }).nullish().catch(undefined),
      surface: z.looseObject({ display_name: z.string().nullish().catch(undefined) }).nullish().catch(undefined)
    })
    .nullish()
    .catch(undefined)
})
type UsageNode = z.infer<typeof USAGE_NODE>

/** The reset instant of one window object, in whatever form it arrived. */
function resetOf(o: UsageNode): string | undefined {
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
 *  (Both spellings arrive null on a window the plan has but is not metering.) */
function utilizationOf(o: UsageNode): number | undefined {
  const v = o.utilization ?? o.percent
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** The display name a `limits[]` entry is scoped to, if any — a model
 *  ("Fable") or a surface, whichever the entry carries. */
function scopeNameOf(o: UsageNode): string | undefined {
  for (const target of [o.scope?.model, o.scope?.surface]) {
    if (target?.display_name) return target.display_name
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
 * Structural in its walk, schema-bound per node: it descends the response
 * looking for objects that carry a utilization — keyed by name or describing
 * themselves via `kind` — at any depth, and reads each candidate through
 * {@link USAGE_NODE}. The exact nesting is the one thing that could not be read
 * off the binary, so the walk stays shape-agnostic; getting it wrong still
 * costs nothing — an unrecognized body yields an empty list, which every caller
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
        ...(resetsAt ? { resetsAt } : {})
      })
  }
  const visit = (node: unknown, key: string | null, depth: number): void => {
    if (depth > 5) return
    if (Array.isArray(node)) {
      for (const el of node) visit(el, null, depth + 1)
      return
    }
    if (!isRecord(node)) return
    const parsed = USAGE_NODE.safeParse(node)
    if (!parsed.success) return
    const util = utilizationOf(parsed.data)
    const kind = parsed.data.kind ?? undefined
    if (kind && util !== undefined) {
      const base = PLAN_WINDOW_LABELS[kind] ?? kind.replace(/_/g, ' ')
      const name = scopeNameOf(parsed.data)
      put(name ? `${kind}:${name}` : kind, name ? `${base} (${name})` : base, util, resetOf(parsed.data))
      return
    }
    if (key !== null && util !== undefined) {
      put(key, PLAN_WINDOW_LABELS[key] ?? key.replace(/_/g, ' '), util, resetOf(parsed.data))
      return
    }
    for (const [k, v] of Object.entries(node)) visit(v, k, depth + 1)
  }
  visit(body, null, 0)
  const known = ORDER.filter((id) => found.has(id)).map((id) => found.get(id)!)
  const rest = [...found.values()].filter((w) => !ORDER.includes(w.id))
  return [...known, ...rest]
}

/** SDK events use fractions (0.7 = 70%), unlike the usage endpoint's percent.
 * Confirmed with a setup-token response; never infer units from the value. */
export function parseClaudeRateLimit(body: unknown): PlanWindow[] {
  if (!isRecord(body)) return []
  const windows = isRecord(body['unifiedWindows'])
    ? body['unifiedWindows']
    : typeof body['rateLimitType'] === 'string'
      ? { [body['rateLimitType']]: body }
      : {}
  const out: PlanWindow[] = []
  for (const [id, value] of Object.entries(windows)) {
    const parsed = USAGE_NODE.safeParse(value)
    if (!parsed.success) continue
    const raw = parsed.data.utilization
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) continue
    const resetsAt = resetOf(parsed.data)
    out.push({
      id,
      label: PLAN_WINDOW_LABELS[id] ?? id.replace(/_/g, ' '),
      utilization: Math.min(100, raw * 100),
      raw,
      ...(resetsAt ? { resetsAt } : {})
    })
  }
  return out
}

/** Codex CLI's /backend-api/wham/usage response (backend-client, v0.160.1).
 * Only the main quota is shown; code-review and model-specific pools are separate.
 * Percentages and duration seconds are explicit, never inferred from magnitudes. */
export function parseCodexPlanWindows(body: unknown): PlanWindow[] {
  if (!isRecord(body) || !isRecord(body['rate_limit'])) return []
  const out: PlanWindow[] = []
  for (const slot of ['primary', 'secondary']) {
    const value = body['rate_limit'][`${slot}_window`]
    if (!isRecord(value)) continue
    const raw = value['used_percent']
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) continue
    const seconds = value['limit_window_seconds']
    const durationSeconds = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
    const reset = value['reset_at']
    const at = typeof reset === 'number' && Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : undefined
    const resetsAt = at && Number.isFinite(at.getTime()) ? at.toISOString() : undefined
    const label = durationSeconds === 604800 ? 'week'
      : durationSeconds !== undefined && durationSeconds % 3600 === 0 ? `${durationSeconds / 3600}h`
        : durationSeconds !== undefined ? `${durationSeconds / 60}m` : slot
    out.push({ id: `codex_${slot}`, label, utilization: Math.min(100, raw), raw,
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      ...(resetsAt ? { resetsAt } : {}) })
  }
  return out
}

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'
const CODEX_ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage'
/** The CLI's own timeout for this call. */
const TIMEOUT_MS = 5_000
/**
 * Floor between two polls for one agent. The endpoint is rate limited — Claude
 * Code's own `/usage` degrades to last-known bars when it gets refused — so the
 * dashboard being open must not become a request per render.
 */
const MIN_INTERVAL_MS = 60_000
/**
 * The background cadence: the app polls eligible subscription instances on this
 * clock (wired in ipc.ts, not here, so tests that build the store directly
 * don't inherit a live timer). Three minutes keeps the meters within one
 * dashboard glance of current while staying far above the floor.
 */
export const POLL_INTERVAL_MS = 3 * 60_000

export interface PlanUsageStore {
  /**
   * Cached plan usage per agent instance, polling whatever is past the rate
   * floor. Never rejects: a failed poll leaves the previous windows in place
   * and sets `error`.
   *
   * There is deliberately no `refresh()` alongside this. The floor is the only
   * gate, so a "force" variant could not do anything a plain call doesn't —
   * and offering one would imply the user can hurry an endpoint that answers
   * being hurried with a 429. The UI's retry button calls this and reads
   * `fetchedAt` to say how fresh the answer is.
   */
  get(): Promise<Record<string, PlanUsage>>
}

export interface PlanUsageDeps {
  agents: () => Promise<AgentsFile>
  credentials: () => Promise<CredentialEntry[]>
  /** Injected by tests; defaults to the platform fetch. */
  fetchImpl?: typeof fetch
  /** Refresh OAuth and re-read account metadata before a Codex request. */
  freshCredential?: (id: string) => Promise<CredentialEntry>
  now?: () => number
}

/** A failed poll, with the provider's own "come back later" when it sent one. */
class FetchUsageError extends Error {
  retryAfterMs?: number
}

/** One GET, returning the parsed body or throwing with a short reason. */
async function fetchUsage(secret: string, doFetch: typeof fetch, codex?: CredentialEntry): Promise<unknown> {
  const res = await doFetch(codex ? CODEX_ENDPOINT : ENDPOINT, {
    method: 'GET',
    headers: codex ? {
      Authorization: `Bearer ${secret}`,
      ...(codex.data['accountId'] ? { 'ChatGPT-Account-Id': codex.data['accountId'] } : {}),
      'User-Agent': 'codex-cli',
      Accept: 'application/json'
    } : {
      // An OAuth token rides `Authorization`, never `x-api-key`, and the
      // endpoint sits behind the same oauth beta gate as the rest of that surface.
      Authorization: `Bearer ${secret}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
      // The CLI's own UA, verbatim. This path is unpublished and its edge is
      // stricter than the API proper — an anonymous client risks the 429 lane
      // regardless of its token, so the request mirrors the binary's exactly.
      'User-Agent': 'claude-cli/2.1.235 (external, cli)'
    },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!res.ok) {
    // 429 here is routine, not a fault — word it as the state it is.
    const err = new FetchUsageError(
      res.status === 429
        ? 'usage endpoint is rate limited — showing the last read'
        : `usage endpoint returned ${res.status}`
    )
    const retryAfter = Number(res.headers?.get?.('retry-after'))
    if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterMs = retryAfter * 1000
    throw err
  }
  return res.json()
}

export function createPlanUsage(bus: Bus, deps: PlanUsageDeps): PlanUsageStore {
  const doFetch = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const cache = new Map<string, PlanUsage>()
  /** Epoch ms of the last *attempt* per agent. The floor is on attempts, not
   *  successes, so a rejected token cannot poll in a tight loop. */
  const lastAttempt = new Map<string, number>()
  /** One in-flight poll per agent; concurrent callers await the same one. */
  const inFlight = new Map<string, Promise<void>>()

  const patch = (agent: string, next: Partial<PlanUsage>): void => {
    const prev = cache.get(agent) ?? { agent, windows: [] }
    cache.set(agent, { ...prev, ...next })
  }

  bus.on('agent.planUsage', ({ agent, windows }) => {
    if (!windows.length) return
    patch(agent, { windows, fetchedAt: new Date(now()).toISOString(), error: undefined })
    bus.emit('usage.changed', undefined)
  })

  async function poll(agent: string, secret: string, codex?: CredentialEntry): Promise<void> {
    const started = now()
    const previous = cache.get(agent)
    lastAttempt.set(agent, started)
    try {
      if (codex) {
        codex = deps.freshCredential ? await deps.freshCredential(codex.id) : codex
        const resolved = resolveAgentSecret([codex], codex.id)
        if (codex.kind !== 'oauth' || codex.data['providerId'] !== 'openai' || resolved.error || !resolved.secret)
          throw new Error('no ChatGPT sign-in linked')
        secret = resolved.secret
      }
      const body = await fetchUsage(secret, doFetch, codex)
      const windows = codex ? parseCodexPlanWindows(body) : parsePlanWindows(body)
      // A live response received during this request is the newer snapshot.
      if (cache.get(agent) !== previous) return
      if (!windows.length) {
        // A 200 we cannot read is a shape change, not an empty plan: keep the
        // previous windows rather than blanking every meter to zero.
        patch(agent, { error: 'usage endpoint returned a shape gurt cannot read' })
        log.warn('plan usage: unreadable body', { agent })
        return
      }
      patch(agent, { windows, fetchedAt: new Date(started).toISOString(), error: undefined })
    } catch (e) {
      if (cache.get(agent) !== previous) return
      const error = e instanceof Error ? e.message : String(e)
      patch(agent, { error })
      // A named Retry-After outranks the floor: pushing the last-attempt mark
      // forward keeps every sweep before that instant from re-asking.
      if (e instanceof FetchUsageError && e.retryAfterMs)
        lastAttempt.set(agent, started + e.retryAfterMs)
      log.warn('plan usage: fetch failed', { agent, error })
    }
  }

  /** Poll eligible subscription instances whose last attempt is past the floor. */
  async function refreshAll(): Promise<Record<string, PlanUsage>> {
    const agents = await deps.agents().catch(() => ({}))
    const creds = await deps.credentials().catch(() => [])
    const work: Promise<void>[] = []
    for (const [id, a] of Object.entries(agents)) {
      if (a.kind !== 'claude-code' && a.kind !== 'codex') continue
      const { secret, entry, error } = resolveAgentSecret(creds, a.credentialId)
      const codex = a.kind === 'codex'
      if (codex && (entry?.kind !== 'oauth' || entry.data['providerId'] !== 'openai' || error)) {
        cache.set(id, { agent: id, windows: [], error: error ?? 'Link a ChatGPT sign-in in Settings → Agents' })
        continue
      }
      if (!codex && (!secret || !isOauthToken(secret))) {
        // Not a failure and not worth retrying: an API-key agent bills per
        // token and has no plan window to report.
        if (!cache.has(id)) patch(id, { error: 'no subscription token linked' })
        continue
      }
      // setup-token can run inference but lacks user:profile. Its real limits
      // arrive with normal session responses; never poll it into repeated 403s.
      if (!codex && entry?.kind === 'agent-token') {
        if (!cache.has(id)) patch(id, { error: 'waiting for usage from a Claude response' })
        continue
      }
      const pending = inFlight.get(id)
      if (pending) {
        work.push(pending)
        continue
      }
      if (now() - (lastAttempt.get(id) ?? 0) < MIN_INTERVAL_MS) continue
      const p = poll(id, secret, codex ? entry : undefined).finally(() => inFlight.delete(id))
      inFlight.set(id, p)
      work.push(p)
    }
    if (work.length) {
      await Promise.all(work)
      bus.emit('usage.changed', undefined)
    }
    return Object.fromEntries(cache)
  }

  return { get: refreshAll }
}
