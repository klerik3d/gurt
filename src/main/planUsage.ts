// Reads a subscription's real plan limits from the provider and caches them.
//
// See shared/planUsage.ts for what the endpoint is and why it is worth using
// despite being unpublished. This module is the network half: one poll per
// agent instance, rate-limited hard, with the last good read kept and served
// while a later attempt is failing.
import type { CredentialEntry } from '../shared/credentials'
import { resolveAgentSecret } from '../shared/credentials'
import type { AgentsFile } from '../shared/types'
import type { PlanUsage } from '../shared/planUsage'
import { isOauthToken, parsePlanWindows } from '../shared/planUsage'
export { STALE_AFTER_MS } from '../shared/planUsage'
import type { Bus } from './bus'
import { createLogger } from './log'

const log = createLogger('plan-usage')

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'
/** The CLI's own timeout for this call. */
const TIMEOUT_MS = 5_000
/**
 * Floor between two polls for one agent. The endpoint is rate limited — Claude
 * Code's own `/usage` degrades to last-known bars when it gets refused — so the
 * dashboard being open must not become a request per render.
 */
const MIN_INTERVAL_MS = 60_000
/**
 * The background cadence: the app polls every claude-code instance on this
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
  now?: () => number
}

/** One GET, returning the parsed body or throwing with a short reason. */
async function fetchUsage(secret: string, doFetch: typeof fetch): Promise<unknown> {
  const res = await doFetch(ENDPOINT, {
    method: 'GET',
    headers: {
      // An OAuth token rides `Authorization`, never `x-api-key`, and the
      // endpoint sits behind the same oauth beta gate as the rest of that surface.
      Authorization: `Bearer ${secret}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json'
    },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!res.ok) {
    // 429 here is routine, not a fault — word it as the state it is.
    throw new Error(
      res.status === 429
        ? 'usage endpoint is rate limited — showing the last read'
        : `usage endpoint returned ${res.status}`
    )
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

  async function poll(agent: string, secret: string): Promise<void> {
    const started = now()
    lastAttempt.set(agent, started)
    try {
      const windows = parsePlanWindows(await fetchUsage(secret, doFetch))
      if (!windows.length) {
        // A 200 we cannot read is a shape change, not an empty plan: keep the
        // previous windows rather than blanking every meter to zero.
        patch(agent, { error: 'usage endpoint returned a shape gurt cannot read' })
        log.warn('plan usage: unreadable body', { agent })
        return
      }
      patch(agent, { windows, fetchedAt: new Date(started).toISOString(), error: undefined })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      patch(agent, { error })
      log.warn('plan usage: fetch failed', { agent, error })
    }
  }

  /** Poll every claude-code instance whose linked secret is a subscription
   *  token and whose last attempt is past the floor. */
  async function refreshAll(): Promise<Record<string, PlanUsage>> {
    const agents = await deps.agents().catch(() => ({}) as AgentsFile)
    const creds = await deps.credentials().catch(() => [] as CredentialEntry[])
    const work: Promise<void>[] = []
    for (const [id, a] of Object.entries(agents)) {
      // claude-code only: these windows belong to that plan, and every other
      // kind would collect nothing but 401s.
      if (a.kind !== 'claude-code') continue
      const { secret } = resolveAgentSecret(creds, a.credentialId)
      if (!secret || !isOauthToken(secret)) {
        // Not a failure and not worth retrying: an API-key agent bills per
        // token and has no plan window to report.
        if (!cache.has(id)) patch(id, { error: 'no subscription token linked' })
        continue
      }
      const pending = inFlight.get(id)
      if (pending) {
        work.push(pending)
        continue
      }
      if (now() - (lastAttempt.get(id) ?? 0) < MIN_INTERVAL_MS) continue
      const p = poll(id, secret).finally(() => inFlight.delete(id))
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
