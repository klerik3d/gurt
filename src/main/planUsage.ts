// The plan-usage cache: what each agent instance's provider says is left of
// its plan, from two sources — live events riding normal session responses
// (a plugin's `usageMeta`, emitted by the session manager as
// `agent.planUsage`), and polls of a provider's usage endpoint (a plugin's
// `planUsage` hooks). Which kinds have either, what they ask and how a body
// parses is the plugins'; the floor, the single flight, the Retry-After and
// the keep-the-last-good-read rule are this file's.
//
// Both sources preserve the last good snapshot when data is unavailable.
import type { CredentialEntry } from '../shared/credentials'
import { resolveAgentSecret } from '../shared/credentials'
import type { AgentsFile } from '../shared/types'
import type { AgentLink, PlanUsagePoll } from '../shared/agentPlugin'
import type { PlanUsage } from '../shared/planUsage'
export { STALE_AFTER_MS } from '../shared/planUsage'
import type { Bus } from './bus'
import { agentMain } from './agentPlugins'
import { createLogger } from './log'

const log = createLogger('plan-usage')

/** A CLI's own timeout for this call (Claude Code's). */
const TIMEOUT_MS = 5_000
/**
 * Floor between two polls for one agent. Usage endpoints are rate limited —
 * Claude Code's own `/usage` degrades to last-known bars when it gets refused —
 * so the dashboard being open must not become a request per render.
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
  /** The cached snapshots of these agent instances, without polling —
   *  synchronous, for the scheduler's launch gate (`planHold`). */
  peek(agents: readonly string[]): PlanUsage[]
}

export interface PlanUsageDeps {
  agents: () => Promise<AgentsFile>
  credentials: () => Promise<CredentialEntry[]>
  /** Injected by tests; defaults to the platform fetch. */
  fetchImpl?: typeof fetch
  /** Refresh an OAuth sign-in and re-read its entry — for a kind that polls
   *  with a fresh sign-in (`PlanUsagePoll.freshSignIn`). */
  freshCredential?: (id: string) => Promise<CredentialEntry>
  now?: () => number
}

/** A failed poll, with the provider's own "come back later" when it sent one. */
class FetchUsageError extends Error {
  retryAfterMs?: number
}

/** One GET, returning the parsed body or throwing with a short reason. */
async function fetchUsage(
  request: { url: string; headers: Record<string, string> },
  doFetch: typeof fetch
): Promise<unknown> {
  const res = await doFetch(request.url, {
    method: 'GET',
    headers: request.headers,
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

  bus.on('agent.planUsage', ({ agent, windows, overage, rejected, rejectedUntil }) => {
    const prev = cache.get(agent)
    const next: Partial<PlanUsage> = {}
    if (windows.length) Object.assign(next, { windows, fetchedAt: new Date(now()).toISOString(), error: undefined })
    if (overage !== undefined && overage !== prev?.overage) next.overage = overage
    // An allowed response is the provider accepting again — whatever refusal
    // was on record is over.
    const refusal = rejected ? rejectedUntil : undefined
    if (rejected !== undefined && refusal !== prev?.rejectedUntil) next.rejectedUntil = refusal
    // Every response carries one of these; one that changes nothing is not news.
    if (!Object.keys(next).length) return
    patch(agent, next)
    bus.emit('usage.changed', undefined)
  })

  // A turn the limit detector claimed: the account refused, whatever the
  // windows last said. The session manager has already settled on `until`.
  bus.on('agent.limited', ({ agent, until }) => {
    patch(agent, { rejectedUntil: until })
    bus.emit('usage.changed', undefined)
  })

  async function poll(
    agent: string,
    hooks: PlanUsagePoll,
    link: AgentLink,
    entry: CredentialEntry | undefined
  ): Promise<void> {
    const started = now()
    const previous = cache.get(agent)
    lastAttempt.set(agent, started)
    try {
      if (hooks.freshSignIn && entry) {
        const fresh = deps.freshCredential ? await deps.freshCredential(entry.id) : entry
        const resolved = resolveAgentSecret([fresh], fresh.id)
        link = { secret: resolved.secret, credential: fresh, error: resolved.error }
      }
      const body = await fetchUsage(hooks.request(link), doFetch)
      const { windows, overage } = hooks.parse(body)
      // A live response received during this request is the newer snapshot.
      if (cache.get(agent) !== previous) return
      if (!windows.length) {
        // A 200 we cannot read is a shape change, not an empty plan: keep the
        // previous windows rather than blanking every meter to zero.
        patch(agent, { error: 'usage endpoint returned a shape gurt cannot read' })
        log.warn('plan usage: unreadable body', { agent })
        return
      }
      patch(agent, { windows, overage, fetchedAt: new Date(started).toISOString(), error: undefined })
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
      const hooks = agentMain(a.kind)?.planUsage
      if (!hooks) continue
      const { secret, entry, error } = resolveAgentSecret(creds, a.credentialId)
      const link: AgentLink = { secret, credential: entry, error }
      const verdict = hooks.eligible(link)
      if (verdict !== true) {
        // A kind whose numbers also ride session responses keeps what those
        // brought and only says why it is not polled while it has nothing;
        // otherwise the reason is the whole answer.
        if (!verdict.live) cache.set(id, { agent: id, windows: [], error: verdict.error })
        else if (!cache.has(id)) patch(id, { error: verdict.error })
        continue
      }
      const pending = inFlight.get(id)
      if (pending) {
        work.push(pending)
        continue
      }
      if (now() - (lastAttempt.get(id) ?? 0) < MIN_INTERVAL_MS) continue
      const p = poll(id, hooks, link, entry).finally(() => inFlight.delete(id))
      inFlight.set(id, p)
      work.push(p)
    }
    if (work.length) {
      await Promise.all(work)
      bus.emit('usage.changed', undefined)
    }
    return Object.fromEntries(cache)
  }

  return {
    get: refreshAll,
    peek: (agents) => agents.flatMap((a) => cache.get(a) ?? [])
  }
}
