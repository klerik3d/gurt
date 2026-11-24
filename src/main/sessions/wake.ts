import { formatResetAt, type PlanHold } from '../../shared/planUsage'
import { sessionRole, type ChatEntry, type ChatEntryBase, type EnvRef } from '../../shared/types'
import {
  deadlineText,
  isWakeOrigin,
  wakeText,
  watchWakeText,
  watcherActive,
  withoutWatch,
  type PendingWake,
  type WakeLate,
  type WakeOrigin,
  type WatcherState
} from '../../shared/watchers'
import type { Bus } from '../bus'
import { createLogger } from '../log'
import { LIMIT_CONTINUE_PROMPT, limitBackoffMs } from './pure'
import type { PendingPrompt, Session, SessionEvents, WatcherHooks } from './types'

const log = createLogger('sessions')

// Wakes, watchers and plan limits: the host's own prompts (a watcher's wake, the
// "continue" after a limit) and the holds that delay them (docs/requirements-
// watchers.md, docs/requirements-plan-limits.md).

/** What wake.ts needs of the session manager: its state and the manager's own
 *  operations it calls back into. */
export interface WakeCtx {
  readonly agentAccounts: Map<string, string>
  readonly bootAt: number
  readonly bus: Bus
  drainPending(s: Session): Promise<void>
  endWatcher(sessionId: string, end: NonNullable<WatcherState['end']>): void
  readonly events: SessionEvents
  isWakeWork(p: PendingPrompt): boolean
  limitHold(s: Session): PlanHold | undefined
  limitTimer: NodeJS.Timeout | undefined
  pendingSeq: number
  persistNow(s: Session): Promise<void>
  push(s: Session, entry: ChatEntryBase): ChatEntry
  queuedWakes(s: Session): PendingPrompt[]
  schedule(): void
  schedulePersist(ref: EnvRef): void
  readonly sessions: Map<string, Session>
  wakeBlock(s: Session): { why: WakeLate; hold?: PlanHold } | undefined
  readonly watcherHooks: WatcherHooks | undefined
  watcherPaused(s: Session): boolean
}

/**
 * Why this session may not send anything to its agent right now, if it may
 * not: its own limit hit (`limitedUntil`, which survives a restart) or its
 * account's — every agent instance on the same credential draws from the
 * same plan, so a hold read through one of them holds them all.
 */
export function limitHold(mgr: WakeCtx, s: Session): PlanHold | undefined {
  const now = Date.now()
  const own = s.info.limitedUntil && Date.parse(s.info.limitedUntil) > now
    ? { until: s.info.limitedUntil, reason: 'limit reached' }
    : undefined
  const agent = s.info.agent
  if (!agent) return own
  const account = mgr.agentAccounts.get(agent)
  const peers = account
    ? [...mgr.agentAccounts].filter(([, c]) => c === account).map(([id]) => id)
    : [agent]
  const shared = mgr.events.planHold(peers)
  if (!own || !shared) return own ?? shared
  // Both hold: the later end is the real one.
  if (!shared.until) return shared
  return Date.parse(shared.until) > Date.parse(own.until) ? shared : own
}

/** "plan limit: Current session 97% — waits for the reset at 15:00" — one
 *  wording for every place a session says it is waiting on a limit. */
export function holdText(h: PlanHold): string {
  return h.until
    ? `plan limit: ${h.reason} — waits for the reset at ${formatResetAt(h.until, Date.now())}`
    : `plan limit: ${h.reason} — waits for the next usage read below the threshold`
}

/**
 * Re-run the scheduler when the earliest hold is due to lift. Holds also lift
 * on fresh usage data (`usage.changed` re-runs it from the kernel); this is
 * the clock for the case nothing new arrives — a reset passing in silence.
 * A hold with no end is re-checked every minute.
 */
export function armLimitTimer(mgr: WakeCtx, holds: PlanHold[], instants: number[] = []): void {
  clearTimeout(mgr.limitTimer)
  mgr.limitTimer = undefined
  if (!holds.length && !instants.length) return
  const now = Date.now()
  // The wake and deadline instants of watchers are the same clock (§5.1):
  // only future ones — a due-but-held item is the hold's business.
  const due = Math.min(
    ...holds.map((h) => (h.until ? Date.parse(h.until) - now : 60_000)),
    ...instants.filter((t) => t > now).map((t) => t - now)
  )
  mgr.limitTimer = setTimeout(() => mgr.schedule(), Math.min(5 * 60_000, Math.max(1_000, due + 1_000)))
  mgr.limitTimer.unref?.()
}

// --- watchers (docs/requirements-watchers.md §5) ---------------------------

/** Why a due wake cannot be sent right now, if it cannot (§5.2). */
export function wakeBlock(mgr: WakeCtx, s: Session): { why: WakeLate; hold?: PlanHold } | undefined {
  if (s.info.state !== 'started') return { why: 'busy' }
  if (s.recovering) return { why: 'busy' }
  const hold = mgr.limitHold(s)
  if (hold) return { why: { hold: hold.until ? formatResetAt(hold.until, Date.now()) : 'the next usage read' }, hold }
  if (
    s.pending.length ||
    s.busy ||
    s.draining ||
    s.promptRunning ||
    s.nudgePending ||
    s.loading ||
    s.recoveryStarting ||
    s.polling
  )
    return { why: 'busy' }
  return undefined
}

/**
 * May the watcher's poller run a poll now (§6.1)? Never while a turn runs or
 * is about to (a poll that overran would stop the container under it), while
 * recovering, or while a wake is going out. A plan hold does not stop it:
 * polls cost no tokens (§5.4), so whatever waits behind the hold does not
 * count as "about to run".
 */
export function canPoll(mgr: WakeCtx, sessionId: string): boolean {
  const s = mgr.sessions.get(sessionId)
  if (!s || s.info.state !== 'started' || s.recovering || s.polling) return false
  if (s.busy || s.draining || s.promptRunning || s.nudgePending || s.loading || s.recoveryStarting) return false
  if (s.pending.length && !mgr.limitHold(s)) return false
  return true
}

/** The poller's poll starts or ends. A prompt that arrived during one is
 *  sent when it ends (§6.1). */
export function setPolling(mgr: WakeCtx, sessionId: string, polling: boolean): void {
  const s = mgr.sessions.get(sessionId)
  if (!s || !!s.polling === polling) return
  s.polling = polling || undefined
  mgr.bus.emit('session.changed', { sessionId })
  if (!polling) {
    void mgr.drainPending(s)
    mgr.schedule()
  }
}

/**
 * The wake half of the scheduler pass: a watcher whose wakeup or deadline is
 * due gets its message queued — only when it could be sent now, in one write
 * with the clearing of `wake` — and the instants still ahead go to the one
 * timer. Holds that keep a due wake waiting feed the same timer.
 */
export function wakePass(mgr: WakeCtx, holds: PlanHold[]): number[] {
  const hooks = mgr.watcherHooks
  const instants: number[] = []
  if (!hooks) return instants
  const now = Date.now()
  for (const s of mgr.sessions.values()) {
    const w = s.info.watcher
    if (!watcherActive(w) || w.final) continue
    const cfg = hooks.config(s.info.id)
    if (!cfg?.wakeups) continue
    const deadline = Date.parse(w.deadlineAt)
    const wakeAt = s.info.wake ? Date.parse(s.info.wake.at) : undefined
    const deadlineDue = deadline <= now
    const wakeDue = wakeAt !== undefined && wakeAt <= now
    // A watch that fired is a due wake whose message is not written yet (§5.4).
    const fired = w.watch?.fired
    if (!deadlineDue) instants.push(deadline)
    if (wakeAt !== undefined && !wakeDue) instants.push(wakeAt)
    if (!deadlineDue && !wakeDue && !fired) continue
    if (s.pending.some((p) => isWakeOrigin(p.origin) && p.origin.final)) continue
    const block = mgr.wakeBlock(s)
    if (block) {
      s.wakeHeld = block.why
      if (block.hold) holds.push(block.hold)
      continue
    }
    let origin: WakeOrigin
    let text: string
    if (deadlineDue) {
      // The deadline wins: the wakeup is dropped, one final wake goes out.
      origin = { wake: now.toString(), final: 'deadline' }
      text = deadlineText(w.deadlineAt, now)
    } else if (!wakeDue && fired && w.watch) {
      const watch = w.watch
      const last = w.wakeups + 1 >= cfg.maxWakeups
      const late: WakeLate = Date.parse(fired.at) < mgr.bootAt ? 'restart' : s.wakeHeld ?? 'busy'
      // `at` / `note` are what Pause puts back as the wakeup (§3): due at once.
      origin = {
        wake: watch.setAt,
        at: fired.at,
        note: `(watch ${fired.reason}) ${watch.note ?? ''}`.trim(),
        ...(last ? { final: 'max-wakeups' as const } : {})
      }
      text = watchWakeText({ watch, fired, wakeups: w.wakeups, maxWakeups: cfg.maxWakeups, deadlineAt: w.deadlineAt, now, late })
    } else {
      const wake = s.info.wake!
      const last = w.wakeups + 1 >= cfg.maxWakeups
      const late: WakeLate =
        wakeAt! < mgr.bootAt ? 'restart' : s.wakeHeld ?? 'busy'
      origin = { wake: wake.setAt, at: wake.at, note: wake.note, ...(last ? { final: 'max-wakeups' as const } : {}) }
      text = wakeText({ wake, wakeups: w.wakeups, maxWakeups: cfg.maxWakeups, deadlineAt: w.deadlineAt, now, late })
    }
    s.wakeHeld = undefined
    // Captured before it is cleared: a failed write restores it. The watch
    // goes with it: its output rides in the message (or the deadline ends it).
    const wasWake = s.info.wake
    const wasWatch = w.watch
    s.info.wake = undefined
    if (wasWatch) s.info.watcher = withoutWatch(w)
    const prompt: PendingPrompt = { id: `p${++mgr.pendingSeq}`, queuedAt: new Date(now).toISOString(), text, auto: true, origin }
    s.wakeWriting = prompt
    s.pending.push(prompt)
    mgr.push(s, { kind: 'system', text })
    mgr.bus.emit('session.changed', { sessionId: s.info.id })
    // One write for the queued message and the cleared wakeup (§5.1); the
    // wake is delivered only once it is on disk. A failed write puts the
    // wakeup back and withdraws the prompt, so the next pass retries it and
    // a restart cannot find the old wake after it ran.
    void mgr.persistNow(s).then(
      () => {
        // Only this write's own barrier: a newer wake may have set its own.
        if (s.wakeWriting === prompt) s.wakeWriting = undefined
        return mgr.drainPending(s)
      },
      (e: unknown) => {
        log.error('internal.fail', { site: 'wake-persist', s: s.info.id, err: e })
        if (s.wakeWriting === prompt) s.wakeWriting = undefined
        // Only a transfer that still owns its prompt restores the wakeup: a
        // Cancel / Esc during the write already withdrew both (§5.3).
        const owned = s.pending.includes(prompt)
        s.pending = s.pending.filter((p) => p !== prompt)
        if (owned && !s.info.wake && !deadlineDue) s.info.wake = wasWake
        const cur = s.info.watcher
        if (owned && wasWatch && !deadlineDue && watcherActive(cur) && !cur.watch && !s.info.wake)
          s.info.watcher = { ...cur, watch: wasWatch }
        mgr.bus.emit('session.changed', { sessionId: s.info.id })
        // Whatever was typed meanwhile goes now; the wake is retried later
        // (bounded: one try per 30 s, not a spin).
        void mgr.drainPending(s)
        setTimeout(() => mgr.schedule(), 30_000).unref?.()
      }
    )
  }
  return instants
}

/** A watcher's own turn (a wake, the start prompt) is not sent once it has
 *  been stopped — `session/cancel` has nothing to cancel before the request
 *  went out (§3). Typed turns of a finished watcher are allowed. */
export function assertNotStopped(s: Session): void {
  if (s.turnGuard && s.info.watcher?.end) throw new Error('the watcher was stopped')
}

/** The wake prompts this session has queued, final ones included. */
export function queuedWakes(s: Session): PendingPrompt[] {
  return s.pending.filter((p) => isWakeOrigin(p.origin))
}

/** Watcher paused: no unattended turn of any kind (§3). */
export function watcherPaused(mgr: WakeCtx, s: Session): boolean {
  if (!watcherActive(s.info.watcher)) return false
  const cfg = mgr.watcherHooks?.config(s.info.id)
  return !!cfg && !cfg.wakeups
}

/** A queued prompt that is the watcher's own unattended work. */
export function isWakeWork(p: PendingPrompt): boolean {
  return isWakeOrigin(p.origin) || (!!p.origin && 'limit' in p.origin && p.origin.of === 'wake')
}

/**
 * Pause (§3): wake-origin work already queued is held. A queued `{ wake }`
 * goes back into `wake`, uncounted; a deadline wake is dropped (the
 * deadline is still due and Resume queues it again); a wake-origin limit
 * `continue` stays, and the drain skips it while paused.
 */
export function holdWakes(mgr: WakeCtx, sessionId: string): void {
  const s = mgr.sessions.get(sessionId)
  if (!s) return
  const kept: PendingPrompt[] = []
  for (const p of s.pending) {
    if (!isWakeOrigin(p.origin)) {
      kept.push(p)
      continue
    }
    if (p.origin.final === 'deadline') continue
    if (!s.info.wake && p.origin.at)
      s.info.wake = { at: p.origin.at, note: p.origin.note ?? '', setAt: p.origin.wake }
  }
  s.pending = kept
  mgr.schedulePersist(s.ref)
  mgr.bus.emit('session.changed', { sessionId })
  mgr.schedule()
}

/** Apply a change to a watcher's session record: its state and wakeup. */
export function patchWatcher(mgr: WakeCtx, sessionId: string,
  patch: { watcher?: WatcherState | undefined; wake?: PendingWake | undefined },
  opts: { persist?: boolean } = {}): void {
  const s = mgr.sessions.get(sessionId)
  if (!s) throw new Error('unknown session')
  if ('watcher' in patch) s.info.watcher = patch.watcher
  if ('wake' in patch) s.info.wake = patch.wake
  if (opts.persist !== false) mgr.schedulePersist(s.ref)
  mgr.bus.emit('session.changed', { sessionId })
  mgr.schedule()
}

/** Wake now (§5.3): the wakeup is due this instant; the pass gates it. */
export function wakeNow(mgr: WakeCtx, sessionId: string): void {
  const s = mgr.sessions.get(sessionId)
  const w = s?.info.watcher
  if (!s || !watcherActive(w)) throw new Error('this watcher is not active')
  if (w.final) throw new Error('only finish_watch is left')
  if (mgr.watcherPaused(s)) throw new Error('paused — resume it first')
  if (mgr.queuedWakes(s).length) return
  const now = new Date().toISOString()
  if (w.watch && !s.info.wake) {
    // Ends the watch and wakes the agent with its last output (§5.3).
    if (!w.watch.fired)
      s.info.watcher = { ...w, watch: { ...w.watch, fired: { at: now, reason: 'user', out: w.watch.last?.out ?? '' } } }
    mgr.schedulePersist(s.ref)
    mgr.bus.emit('session.changed', { sessionId })
    mgr.schedule()
    return
  }
  s.info.wake = { at: now, note: s.info.wake?.note ?? '(woken by you)', setAt: s.info.wake?.setAt ?? now }
  mgr.schedulePersist(s.ref)
  mgr.schedule()
}

/** End a watcher (§3, §7, §8): drops the wakeup and every queued wake. */
export function endWatcher(mgr: WakeCtx, sessionId: string, end: NonNullable<WatcherState['end']>): void {
  const s = mgr.sessions.get(sessionId)
  const w = s?.info.watcher
  if (!s || !w || w.end) return
  s.info.watcher = { ...withoutWatch(w), end }
  s.info.wake = undefined
  s.pending = s.pending.filter((p) => !mgr.isWakeWork(p))
  s.info.limitedUntil = s.pending.some((p) => p.auto) ? s.info.limitedUntil : undefined
  mgr.push(s, { kind: 'system', text: `watcher finished · ${end.outcome} — ${end.summary}` })
  mgr.schedulePersist(s.ref)
  mgr.bus.emit('session.changed', { sessionId })
  mgr.bus.emit('tree.changed', undefined)
  mgr.schedule()
}

/** Sort a restored watcher's work by origin (§10) — called by the watcher
 *  manager before the first scheduler pass. Attended work waits in the
 *  Resume-sessions checklist; only the watcher's own wake turns go on. */
export function recoverWatcher(mgr: WakeCtx, sessionId: string, paused: boolean): boolean {
  const s = mgr.sessions.get(sessionId)
  if (!s || !s.info.watcher || s.info.state !== 'started') return false
  if (!watcherActive(s.info.watcher)) {
    // A finished watcher can still be talked to: what was typed before the
    // restart is attended work and waits for the user too (§10).
    if (s.pending.length || s.interrupted) s.recovering = true
    return false
  }
  const attended =
    s.pending.some((p) => !mgr.isWakeWork(p)) || (!!s.interrupted && s.ranOrigin !== 'wake')
  if (paused || attended) {
    s.recovering = !!s.interrupted || attended || undefined
    return false
  }
  // Approved work only: the manager resumes it itself.
  if (!s.interrupted) return false
  s.recovering = true
  s.resumeOnBoot = true
  return true
}

/** The watcher's turn failed (§7): retry once at the minimum delay, then
 *  go loud. Only for a turn that came from a wake. */
export function onWakeFailed(mgr: WakeCtx, s: Session, reason: string): void {
  const w = s.info.watcher
  const cfg = mgr.watcherHooks?.config(s.info.id)
  if (!watcherActive(w) || !cfg) return
  if (w.final) {
    mgr.endWatcher(s.info.id, { outcome: 'expired', summary: `the final turn failed: ${reason}`, at: new Date().toISOString(), by: 'host' })
    mgr.watcherHooks?.notify(s.info.id, 'error', `watcher expired — the final turn failed: ${reason}`, 'expired')
    return
  }
  s.wakeFailures = (s.wakeFailures ?? 0) + 1
  if (s.wakeFailures === 1) {
    if (s.info.wake) return
    const at = new Date(Date.now() + cfg.minDelayMinutes * 60_000).toISOString()
    s.info.wake = { at, setAt: new Date().toISOString(), note: `(retrying after a failed turn: ${reason}) ${s.wakeNote ?? ''}`.trim() }
    mgr.push(s, { kind: 'system', text: `wake turn failed (${reason}) — retrying at ${formatResetAt(at, Date.now())}` })
    mgr.schedulePersist(s.ref)
    return
  }
  const text = `wake turns are failing: ${reason}`
  s.info.watcher = { ...w, attention: { level: 'error', text, at: new Date().toISOString() } }
  mgr.watcherHooks?.notify(s.info.id, 'error', text, 'blind')
  mgr.schedulePersist(s.ref)
}

/** The nudge turn still scheduled nothing (§7): gone blind, or — after the
 *  final wake — ended by the host. */
export function onWatcherIncomplete(mgr: WakeCtx, s: Session): void {
  const w = s.info.watcher
  if (!watcherActive(w)) return
  const now = new Date().toISOString()
  if (w.final) {
    const last = [...s.entries].reverse().find((e) => e.kind === 'agent')
    const summary = (last && 'text' in last ? last.text : 'no report').slice(0, 500) || 'no report'
    mgr.endWatcher(s.info.id, { outcome: 'expired', summary, at: now, by: 'host' })
    mgr.watcherHooks?.notify(s.info.id, 'warning', `watcher expired without a conclusion — ${summary}`, 'expired')
    return
  }
  const text = 'stopped without scheduling its next look'
  s.info.watcher = { ...w, attention: { level: 'warning', text, at: now } }
  mgr.watcherHooks?.notify(s.info.id, 'warning', text, 'blind')
}

/**
 * A turn ended on a limit. Settle when it is expected to lift — the reset
 * the refusal named, else the account's own hold, else a growing backoff —
 * record that on the session (persisted, so a restart still waits) and on
 * the account (so nothing else on it starts into the same refusal), and
 * queue the "continue" that resumes the work once it lifts. A message the
 * user already queued behind this turn goes instead: it *is* the
 * continuation, and sending both would answer one turn twice.
 */
export function onLimited(mgr: WakeCtx, s: Session, limit: { resetAt?: string | undefined }): string {
  s.limitStrikes++
  const now = Date.now()
  const named = limit.resetAt && Date.parse(limit.resetAt) > now ? limit.resetAt : undefined
  const until =
    named ??
    mgr.limitHold(s)?.until ??
    new Date(now + limitBackoffMs(s.limitStrikes)).toISOString()
  if (s.info.agent) mgr.bus.emit('agent.limited', { agent: s.info.agent, until })
  // A turn the user stopped (the watcher ended during it) is not continued: the
  // account's hold above stays, the automatic `continue` does not come back.
  const ended = s.info.watcher?.end
  if (ended && s.turnStartedAt !== undefined && Date.parse(ended.at) >= s.turnStartedAt) {
    mgr.push(s, { kind: 'system', text: `limit reached — not continued, the watcher was stopped (resets ${formatResetAt(until, now)})` })
    return until
  }
  // A proactive run is not continued after the reset: its turn has ended, and
  // with it the run and its tools. The account hold above still applies; the
  // agent's next scheduled run starts once the queue lets it.
  if (sessionRole(s.info) === 'proactive') {
    mgr.push(s, { kind: 'system', text: `limit reached — this run ends here (resets ${formatResetAt(until, now)})` })
    return until
  }
  s.info.limitedUntil = until
  if (!s.pending.length)
    s.pending.push({
      id: `p${++mgr.pendingSeq}`,
      queuedAt: new Date().toISOString(),
      text: LIMIT_CONTINUE_PROMPT,
      auto: true,
      // A watcher's continuation remembers whether the turn it continues was
      // its own wake (approved work) or a person's (§10).
      ...(s.info.role === 'watcher' ? { origin: { limit: true as const, of: s.ranOrigin === 'wake' ? ('wake' as const) : ('user' as const) } } : {})
    })
  mgr.push(s, {
    kind: 'system',
    text: `limit reached — continues on its own after the reset (${formatResetAt(until, now)})`
  })
  mgr.schedulePersist(s.ref)
  // Arms the clock for the reset.
  mgr.schedule()
  return until
}

/** A turn the provider accepted: whatever limit was on record is over. */
export function clearLimited(mgr: WakeCtx, s: Session): void {
  s.limitStrikes = 0
  if (!s.info.limitedUntil) return
  s.info.limitedUntil = undefined
  mgr.schedulePersist(s.ref)
}
