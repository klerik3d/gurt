import type {
  EnvRef,
  PendingPromptInfo,
  PromptContext,
  PromptImage
} from '../../shared/types'
import {
  isWakeOrigin,
  prefaceFor,
  watcherActive,
  withoutWatch,
  type WatcherState
} from '../../shared/watchers'
import type { Bus } from '../bus'
import { keptWhenTyping, pendingInfo } from './pure'
import type { Connection, PendingPrompt, Session } from './types'

// The prompt queue as the outside sees it: typed prompts, and withdrawing or
// cancelling what is queued or running.

/** What prompts.ts needs of the session manager: its state and the manager's own
 *  operations it calls back into. */
export interface PromptsCtx {
  assertSessionWritable(id: string): void
  readonly bus: Bus
  readonly connections: Map<string, Connection>
  drainPending(s: Session): Promise<void>
  dropAuto(s: Session, which: 'all' | 'limit' | 'wake', finalWithdrawn?: boolean): void
  endWatcher(sessionId: string, end: NonNullable<WatcherState['end']>): void
  pendingSeq: number
  persistNow(s: Session): Promise<void>
  queuedWakes(s: Session): PendingPrompt[]
  schedule(): void
  schedulePersist(ref: EnvRef): void
  readonly sessions: Map<string, Session>
}

export async function prompt(mgr: PromptsCtx, sessionId: string,
  text: string,
  context?: PromptContext[],
  images?: PromptImage[]): Promise<void> {
  mgr.assertSessionWritable(sessionId)
  const s = mgr.sessions.get(sessionId)
  if (!s) throw new Error('unknown session')
  if (s.info.state !== 'started') throw new Error('session is not started')
  // Everything goes through the queue, including the send that could have run
  // straight away — that is what keeps "one turn at a time" structural rather
  // than a rule each caller has to remember. Overlapping prompts would share
  // `turnComplete`, so a `complete` for one turn could silently satisfy the
  // other (and both could nudge).
  //
  // Resolves once the prompt is *accepted*, not once it has run: a queued one
  // may wait minutes for the clone, and the caller (the composer) needs its
  // message cleared now. What happened to it afterwards is the timeline's to
  // tell, and a failed turn writes itself there.
  const id = `p${++mgr.pendingSeq}`
  // What the user types now is the continuation an interrupted session was
  // going to send on its own — it replaces the automatic "continue".
  const queuedAt = s.pending.find((p) => p.auto)?.queuedAt ?? new Date().toISOString()
  const w = s.info.watcher
  if (watcherActive(w)) {
    // A queued wake is replaced like the limit `continue` — it stays pending
    // as the wakeup, uncounted, and its note rides in front of the typed
    // message; a final wake is never replaced (§5.3).
    const dropped = s.pending.find((p) => isWakeOrigin(p.origin) && !p.origin.final)
    if (dropped && isWakeOrigin(dropped.origin) && dropped.origin.at && !s.info.wake)
      s.info.wake = { at: dropped.origin.at, note: dropped.origin.note ?? '', setAt: dropped.origin.wake }
    const line = prefaceFor(w, s.info.wake, Date.now())
    if (line) s.preface = s.preface ? `${s.preface}\n${line}` : line
    s.pending = s.pending.filter((p) => !p.auto || (isWakeOrigin(p.origin) && !!p.origin.final))
  } else s.pending = s.pending.filter(keptWhenTyping)
  s.pending.push({
    id,
    queuedAt,
    text,
    ...(context?.length ? { context } : {}),
    ...(images?.length ? { images } : {})
  })
  await mgr.persistNow(s)
  s.recovering = false
  void mgr.drainPending(s)
  // Still queued after the drain had its synchronous chance at it: nothing
  // else is going to announce it. A drain already in flight returns at its
  // own guard without a word, and the turn it is waiting behind may run for
  // minutes — the pane has to show the message now, not then. When the drain
  // *did* take it, `sendTurn` has already emitted for the turn it started.
  if (s.pending.some((p) => p.id === id)) {
    mgr.bus.emit('session.changed', { sessionId: s.info.id })
    // A waiting prompt wants the clone exactly like a queued draft does, and
    // the handoff only ever runs off a signal. Without this one the holder is
    // already idle — its turn ended before the message was typed — so nothing
    // else will fire, and the message sits out the whole grace period.
    mgr.bus.emit('session.promptQueued', { sessionId: s.info.id })
  }
}

/** Take everything out of the queue and hand it back — the composer puts the
 *  text (and chips) where it came from, so stopping a session never eats what
 *  was typed behind it. Images are dropped; see {@link PendingPromptInfo}. */
export function clearPending(mgr: PromptsCtx, sessionId: string): PendingPromptInfo[] {
  const s = mgr.sessions.get(sessionId)
  // A watcher drops its wakeup whether or not anything was queued (§5.3).
  if (!s || (!s.pending.length && !s.info.watcher)) return []
  // Stopping the session stops its automatic continuation too; the "continue"
  // itself was never typed, so it does not go back to the composer.
  const out = s.pending.filter((p) => !p.auto).map(pendingInfo)
  const finalQueued = s.pending.some((p) => isWakeOrigin(p.origin) && !!p.origin.final)
  s.pending = []
  mgr.schedulePersist(s.ref)
  mgr.dropAuto(s, 'all', finalQueued)
  mgr.bus.emit('session.changed', { sessionId })
  mgr.schedule()
  return out
}

/** The same for one entry, by id (a row's own cancel). Returns it so that
 *  one, too, can go back to the composer rather than just vanishing. */
export function cancelPending(mgr: PromptsCtx, sessionId: string, promptId: string): PendingPromptInfo | undefined {
  const s = mgr.sessions.get(sessionId)
  if (!s) return undefined
  const i = s.pending.findIndex((p) => p.id === promptId)
  if (i < 0) return undefined
  const [gone] = s.pending.splice(i, 1)
  mgr.schedulePersist(s.ref)
  // Cancelling the automatic "continue" is "do not resume this one by
  // yourself": the session-level hold goes with it (the account's stays).
  if (gone?.auto)
    mgr.dropAuto(s, isWakeOrigin(gone.origin) ? 'wake' : 'limit', isWakeOrigin(gone.origin) && !!gone.origin.final)
  mgr.bus.emit('session.changed', { sessionId })
  mgr.schedule()
  return gone && !gone.auto ? pendingInfo(gone) : undefined
}

/** Withdraw what the host would send by itself: the limit hold's `continue`
 *  (`'limit'`), a watcher's wakeup (`'wake'`), or both (`'all'`, Esc / Stop).
 *  At the end of a watcher's life (a final wake queued or taken) withdrawing
 *  ends it as stopped — nothing else could finish it (§5.3). */
export function dropAuto(mgr: PromptsCtx, s: Session, which: 'all' | 'limit' | 'wake', finalWithdrawn = false): void {
  if (which !== 'wake' && s.info.limitedUntil) {
    s.info.limitedUntil = undefined
    mgr.schedulePersist(s.ref)
  }
  const w = s.info.watcher
  if (which === 'limit' || !watcherActive(w)) return
  const atEnd = finalWithdrawn || !!w.final
  s.info.wake = undefined
  if (w.watch) s.info.watcher = withoutWatch(w)
  s.pending = s.pending.filter((p) => !isWakeOrigin(p.origin))
  mgr.schedulePersist(s.ref)
  mgr.bus.emit('session.changed', { sessionId: s.info.id })
  if (atEnd)
    mgr.endWatcher(s.info.id, {
      outcome: 'stopped',
      summary: 'the last report was withdrawn',
      at: new Date().toISOString(),
      by: 'user'
    })
  else mgr.schedule()
}

/** The composer row's Cancel: withdraw the wakeup. */
export function cancelWake(mgr: PromptsCtx, sessionId: string): void {
  const s = mgr.sessions.get(sessionId)
  if (s) mgr.dropAuto(s, 'wake', mgr.queuedWakes(s).some((p) => isWakeOrigin(p.origin) && !!p.origin.final))
}

/**
 * Esc: cancel the running turn and any open permission request. A person's
 * act by default; the host cancelling a turn on its own account (a proactive
 * run's timeout) passes `by: 'host'`.
 */
export function cancel(mgr: PromptsCtx, sessionId: string, by: 'user' | 'host' = 'user'): void {
  const s = mgr.sessions.get(sessionId)
  if (!s) return
  if (by === 'user' && s.info.watcher) s.cancelledAt = Date.now()
  const conn = mgr.connections.get(s.info.id)
  if (s.acpSessionId) conn?.peer.notify('session/cancel', { sessionId: s.acpSessionId })
  const wasAwaiting = s.pendingPermissions.size > 0
  for (const resolve of s.pendingPermissions.values())
    resolve({ outcome: { outcome: 'cancelled' } })
  s.pendingPermissions.clear()
  if (wasAwaiting)
    mgr.bus.emit('session.awaiting', { sessionId: s.info.id, ref: s.ref, awaiting: false })
}
