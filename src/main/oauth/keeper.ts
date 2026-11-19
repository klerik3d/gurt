// Keeps a *running* session's proxy scope supplied with a live OAuth access
// token (docs/requirements-oauth-credentials.md §5.2, §6). An MCP access token
// rides in the scope file the proxy reads (`pushScope`), and that file is
// written once at session start — a token with a one-hour life would make the
// MCP server answer 401 an hour into a long session, with nobody to refresh it.
//
// So, for every session whose selected http servers link an `oauth` entry, one
// timer per entry fires shortly before the access token goes stale, resolves it
// (the single-flight refresh of `resolveOAuthAccess` — a refresh another
// session already made is simply picked up), and, when the token changed, asks
// the session to rebuild and push its scope. The scope file *is* the push
// (docs/requirements-mcp-proxy.md §5.4): the agent keeps the proxy URL and
// opaque token it already holds and never notices.
//
// The refresh token never leaves `credentials.json` through any of this — the
// rebuild composes the same scope `attachMcp` does, which carries the access
// token only (§5.2).
import { onCredentialsWritten } from '../credentials'
import {
  EXPIRY_SKEW_MS,
  SignedOutError,
  oauthExpiresAtMs,
  oauthStoredAccess,
  resolveOAuthAccess
} from './index'

/** Fire this long after the entry's refresh window opens (`expiresAt` minus
 *  the skew `resolveOAuthAccess` refreshes inside), so the resolve finds the
 *  token stale and refreshes it instead of returning it. */
const FIRE_AFTER_WINDOW_MS = 5_000
/** The shortest sleep between renewals — only a guard against a hot loop on a
 *  token that lives a few seconds. It is never allowed to push a renewal past
 *  the token's own expiry: see {@link renewalDelay}. */
const MIN_DELAY_MS = 5_000
/** `setTimeout` cannot sleep beyond 2³¹ ms; a long-lived token is re-checked
 *  at this cadence instead (the re-check is a store read, not a request). */
const MAX_DELAY_MS = 6 * 3_600_000
/** After a failed refresh or push: retry sooner than the window, backing off. */
const RETRY_BASE_MS = 60_000
const RETRY_MAX_MS = 10 * 60_000
/** Credential-store writes arrive in bursts; recheck once, this long after the
 *  first. */
const STORE_DEBOUNCE_MS = 250

/**
 * How long to sleep before renewing a token with `remainingMs` left.
 *
 * Normally: until the refresh window (`resolveOAuthAccess`'s skew) has just
 * opened. A token that lives *less* than the skew is inside that window from
 * birth — resolving it always refreshes — so the window says nothing and the
 * renewal is taken at half its remaining life instead: late enough not to spin,
 * early enough that the refresh request and the scope push finish while the
 * token the proxy holds is still valid. The floor only guards the hot loop on
 * tokens of a few seconds; the delay never exceeds the remaining life minus it
 * unless the token is already gone.
 */
export function renewalDelay(remainingMs: number): number {
  const windowOpens = remainingMs - EXPIRY_SKEW_MS + FIRE_AFTER_WINDOW_MS
  if (windowOpens > 0) return windowOpens
  return Math.max(remainingMs / 2, MIN_DELAY_MS)
}

export interface KeeperDeps {
  /** A live access token for the entry — `resolveOAuthAccess`. */
  resolve: (credentialId: string) => Promise<string>
  /** The stored access token, never refreshing (null when none is usable).
   *  What a credential-store write is checked with: a refresh persists, and a
   *  check that refreshed would be answered by the write it just made. Absent
   *  → such checks fall back to `resolve`. */
  peek?: (credentialId: string) => Promise<string | null>
  /** When the entry's stored access token expires (epoch ms), or null. */
  expiresAtMs: (credentialId: string) => Promise<number | null>
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  /** Subscribe to credential-store writes; returns the unsubscribe. */
  onStoreWrite: (fn: () => void) => () => void
}

export interface WatchHooks {
  /** Rebuild the session's scope and push it. Called after the token of
   *  `credentialId` changed; must skip the push when `isCurrent()` is false
   *  (the session was stopped or re-attached meanwhile — a late write must not
   *  undo a revocation). It must fail only for a reason that concerns
   *  `credentialId` itself: another entry's trouble is that entry's own timer's
   *  to report, and must not stop this one's renewal from landing. A rejection
   *  is retried. `token` is the access token just resolved for `credentialId`;
   *  the rebuild must use it as it is rather than resolve (and maybe refresh) again. */
  rebuild: (isCurrent: () => boolean, credentialId: string, token: string) => Promise<void>
  /** Said once per failing streak, for the session's provisioning log. */
  onProblem?: (message: string) => void
}

interface Watch {
  generation: number
  hooks: WatchHooks
  ids: string[]
  /** Entries with a check in flight, and those asked for again meanwhile. */
  busy: Set<string>
  dirty: Set<string>
  recheck: Set<string>
  /** Entries signed out: no timer, re-checked when the store is written. */
  parked: Set<string>
  timers: Map<string, unknown>
  lastToken: Map<string, string>
  failing: Set<string>
  retries: Map<string, number>
}

const defaultDeps: KeeperDeps = {
  resolve: (id) => resolveOAuthAccess(id),
  peek: oauthStoredAccess,
  expiresAtMs: oauthExpiresAtMs,
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms)
    t.unref?.()
    return t
  },
  clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
  onStoreWrite: onCredentialsWritten
}

export class ScopeKeeper {
  private readonly watches = new Map<string, Watch>()
  private generation = 0
  private unsubscribe: (() => void) | null = null
  private debounce: unknown = undefined

  constructor(private readonly deps: KeeperDeps = defaultDeps) {}

  /** Watch the `oauth` entries behind a session's pushed scope. Replaces any
   *  earlier watch of the session (a resume re-attaches and pushes again).
   *
   *  `pushed` is the access token each entry contributed to the scope that was
   *  actually pushed — the keeper's baseline. It is deliberately not re-read
   *  from the store: another session may have refreshed the entry between the
   *  plan being composed and this call, and then the proxy holds a token the
   *  store no longer does. An entry with no pushed token (its route was left
   *  out of the scope) is pushed as soon as it resolves. */
  watch(
    session: string,
    credentialIds: readonly string[],
    hooks: WatchHooks,
    pushed: Readonly<Record<string, string>>
  ): void {
    this.unwatch(session)
    const ids = [...new Set(credentialIds)]
    if (ids.length === 0) return
    const w: Watch = {
      generation: ++this.generation,
      hooks,
      ids,
      parked: new Set(),
      busy: new Set(),
      dirty: new Set(),
      recheck: new Set(),
      timers: new Map(),
      lastToken: new Map(),
      failing: new Set(),
      retries: new Map()
    }
    this.watches.set(session, w)
    // The credential store is the one place a new sign-in, a refresh by another
    // session, or a revocation shows up: watch it while anything is watched.
    this.unsubscribe ??= this.deps.onStoreWrite(() => this.storeWritten())
    for (const id of ids) {
      if (pushed[id] !== undefined) w.lastToken.set(id, pushed[id])
      // The first check goes through the same path as every later one — a
      // refresh failure here parks or retries exactly as it would at a timer.
      // The attach that built the scope already said what was wrong with it.
      void this.fire(session, w, id, hooks, true)
    }
  }

  /** Stop watching — the session's scope is being revoked or its container
   *  stopped. Pending timers are cleared; an in-flight rebuild sees
   *  `isCurrent()` turn false. */
  unwatch(session: string): void {
    const w = this.watches.get(session)
    if (!w) return
    this.watches.delete(session)
    for (const h of w.timers.values()) this.deps.clearTimer(h)
    w.timers.clear()
    w.parked.clear()
    if (this.watches.size === 0) {
      this.unsubscribe?.()
      this.unsubscribe = null
      if (this.debounce !== undefined) this.deps.clearTimer(this.debounce)
      this.debounce = undefined
    }
  }

  /** A write to the credential store may be a re-authentication (the live scope
   *  would otherwise keep the replaced token until its old timer, hours away —
   *  and a provider may have revoked it already), a refresh another session
   *  made, or the sign-in a parked entry is waiting for. Writes come in bursts
   *  (a refresh persists, then a save), so they are coalesced into one recheck
   *  of every watched entry; an entry whose token did not change costs one
   *  store read. */
  private storeWritten(): void {
    if (this.debounce !== undefined) return
    this.debounce = this.deps.setTimer(() => {
      this.debounce = undefined
      for (const [session, w] of [...this.watches])
        for (const id of w.ids) {
          w.parked.delete(id)
          void this.fire(session, w, id, w.hooks, false, true)
        }
    }, STORE_DEBOUNCE_MS)
  }

  /** Sessions currently watched (tests, diagnostics). */
  watching(): string[] {
    return [...this.watches.keys()]
  }

  private isCurrent(session: string, w: Watch): boolean {
    return this.watches.get(session)?.generation === w.generation
  }

  private schedule(session: string, w: Watch, id: string, ms: number, hooks: WatchHooks): void {
    if (!this.isCurrent(session, w)) return
    const old = w.timers.get(id)
    if (old !== undefined) this.deps.clearTimer(old)
    w.timers.set(
      id,
      this.deps.setTimer(() => void this.fire(session, w, id, hooks), Math.min(ms, MAX_DELAY_MS))
    )
  }

  private async next(session: string, w: Watch, id: string, hooks: WatchHooks): Promise<void> {
    const exp = await this.deps.expiresAtMs(id).catch(() => null)
    // No expiry on record: nothing to schedule from. The next session start
    // (or a retry-less refresh failure) is what will surface the problem.
    if (exp === null) return
    this.schedule(session, w, id, renewalDelay(exp - this.deps.now()), hooks)
  }

  /** Resolve one entry and, when its token differs from the one the proxy
   *  holds, rebuild and push. One at a time per entry: a check that arrives
   *  while another is running is run again right after it, so nothing that
   *  happened mid-flight is missed and nothing runs twice at once. */
  private async fire(
    session: string,
    w: Watch,
    id: string,
    hooks: WatchHooks,
    quiet = false,
    peek = false
  ): Promise<void> {
    if (!this.isCurrent(session, w)) return
    if (w.busy.has(id)) {
      // A refresh-check queued behind a peek must not be downgraded.
      if (!peek) w.dirty.add(id)
      else w.recheck.add(id)
      return
    }
    w.busy.add(id)
    try {
      await this.check(session, w, id, hooks, quiet, peek)
    } finally {
      w.busy.delete(id)
    }
    if (w.dirty.delete(id)) await this.fire(session, w, id, hooks)
    else if (w.recheck.delete(id)) await this.fire(session, w, id, hooks, false, true)
  }

  private async check(
    session: string,
    w: Watch,
    id: string,
    hooks: WatchHooks,
    quiet: boolean,
    peek: boolean
  ): Promise<void> {
    try {
      // After a store write: look at what is stored, do not refresh — the write
      // may be this keeper's (or another session's) own refresh, and refreshing
      // in answer would write again, forever, for a token shorter than the skew.
      // Only the entry's timer (or the first check) refreshes.
      const token = peek && this.deps.peek ? await this.deps.peek(id) : await this.deps.resolve(id)
      if (!this.isCurrent(session, w)) return
      if (token === null) return
      if (token !== w.lastToken.get(id)) {
        await hooks.rebuild(() => this.isCurrent(session, w), id, token)
        w.lastToken.set(id, token)
      }
      w.failing.delete(id)
      w.retries.delete(id)
      w.parked.delete(id)
      await this.next(session, w, id, hooks)
    } catch (e) {
      if (!this.isCurrent(session, w)) return
      const message = e instanceof Error ? e.message : String(e)
      // Said once per streak: a refresh that keeps failing must not flood the
      // session's log. (`oauth.refresh` / `oauth.expired` already carry every
      // attempt — this is the user-facing half.)
      if (!w.failing.has(id)) {
        w.failing.add(id)
        if (!quiet) hooks.onProblem?.(message)
      }
      // A dead refresh token stays dead until the user signs in again — which
      // may happen any time, from the MCP editor, with this session running.
      // The entry is parked (no timer) and re-checked on the next store write;
      // the new sign-in is such a write.
      if (e instanceof SignedOutError) {
        w.parked.add(id)
        const old = w.timers.get(id)
        if (old !== undefined) this.deps.clearTimer(old)
        w.timers.delete(id)
        return
      }
      // Anything else (offline, a 5xx) is retried with back-off — and each
      // attempt is already an `oauth.refresh` record.
      const attempt = (w.retries.get(id) ?? 0) + 1
      w.retries.set(id, attempt)
      this.schedule(session, w, id, Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS), hooks)
    }
  }
}

/** The process-wide keeper the session manager uses. */
export const scopeKeeper = new ScopeKeeper()
