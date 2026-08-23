// Turns select bus events into user-facing notifications — the "what happened
// while you weren't looking" layer over the domain bus. See
// docs/requirements-notifications.md. A plain subscriber, same shape as the
// idle auto-stop policy in kernel.ts.
import { randomUUID } from 'node:crypto'
import type { Bus } from './bus'
import type { EnvRef, SessionInfo } from '../shared/types'
import type { NotificationPrefs, NotificationRecord, NotificationType } from '../shared/notifications'
import { NOTIFICATION_RING_CAP } from '../shared/notifications'
import { sendExternal } from './notify-external'
import { createLogger } from './log'

const log = createLogger('notifications')

export interface Notifications {
  /** Oldest first. */
  list(): NotificationRecord[]
  markRead(id: string): void
  markAllRead(): void
  /** Reading a session's own state some other way (opened from the sidebar)
   *  also marks its pending notifications read — dedupe by sessionId, not
   *  just by explicit panel interaction (§4.2). */
  markSessionRead(sessionId: string): void
  /** Per-item dismiss (§4.2) — removes the record instead of just marking it read. */
  dismiss(id: string): void
  /** Live-swap the on/off matrix (Settings → Notifications save). */
  setPrefs(prefs: NotificationPrefs): void
}

export function createNotifications(
  bus: Bus,
  initialPrefs: NotificationPrefs,
  sessionInfo: (id: string) => SessionInfo | undefined
): Notifications {
  let prefs = initialPrefs
  const ring: NotificationRecord[] = []

  // Per-session bookkeeping, all reset at the boundaries noted below — none of
  // it is persisted, matching the ring buffer's own restart-clears-history rule.

  /** Which type (if any) already accounted for the session's current turn —
   *  'error' outranks 'proposal'; either suppresses the turn-ended fallback. */
  const turnOutcome = new Map<string, NotificationType>()
  /** An `awaiting` notification is currently outstanding for this session —
   *  guards the false->true edge and lets a stop/open clear it. */
  const awaitingOpen = new Set<string>()
  /** An `error` notification already fired for the session's current failure —
   *  a start failure emits BOTH `container.status(error)` and
   *  `session.state(start-failed)` for the same fault; this collapses them to
   *  one record. Cleared by anything that means "trying again" or "recovered". */
  const errorNotified = new Set<string>()
  /** A turn is currently open (between `started` and its final `ended`) for
   *  this session — guards `session.proposal` bookkeeping against a `complete`
   *  that lands outside any turn (a benign late POST, see `onComplete`): without
   *  it, that stray 'proposal' outcome marker would sit in `turnOutcome` and
   *  wrongly suppress the *next* turn's `turn-ended`. */
  const turnOpen = new Set<string>()

  function push(type: NotificationType, sessionId: string, ref: EnvRef, detail: string): void {
    const info = sessionInfo(sessionId)
    if (!info) return // session gone (deleted) — nothing to show
    const record: NotificationRecord = {
      id: randomUUID(),
      type,
      sessionId,
      ref,
      title: `${ref.task} · ${info.title}`,
      detail,
      ts: new Date().toISOString(),
      read: false
    }
    const p = prefs[type]
    if (p.inApp) {
      ring.push(record)
      if (ring.length > NOTIFICATION_RING_CAP) ring.shift()
      bus.emit('notification.created', record)
    }
    if (p.external)
      sendExternal(type, record).catch((e: unknown) =>
        log.error('internal.fail', { site: 'send-external', type, s: sessionId, err: e })
      )
  }

  function notifyError(sessionId: string, ref: EnvRef, detail: string): void {
    turnOutcome.set(sessionId, 'error')
    if (errorNotified.has(sessionId)) return // same fault already surfaced
    errorNotified.add(sessionId)
    push('error', sessionId, ref, detail)
  }

  function markSessionReadInternal(sessionId: string, onlyType?: NotificationType): void {
    let changed = false
    for (const r of ring)
      if (r.sessionId === sessionId && !r.read && (!onlyType || r.type === onlyType)) {
        r.read = true
        changed = true
      }
    if (changed) bus.emit('notification.read', { sessionId })
  }

  bus.on('session.awaiting', ({ sessionId, ref, awaiting }) => {
    if (awaiting) {
      if (awaitingOpen.has(sessionId)) return // already notified — not a fresh transition
      awaitingOpen.add(sessionId)
      push('awaiting', sessionId, ref, 'waiting on a permission request')
    } else {
      awaitingOpen.delete(sessionId)
      markSessionReadInternal(sessionId, 'awaiting')
    }
  })

  bus.on('session.turn', ({ sessionId, ref, phase, final }) => {
    if (phase === 'started') {
      turnOpen.add(sessionId)
      turnOutcome.delete(sessionId)
      return
    }
    turnOpen.delete(sessionId)
    if (final === false) return // the nudge turn's own boundary — wait for the real end
    const outcome = turnOutcome.get(sessionId)
    turnOutcome.delete(sessionId)
    if (outcome) return // error or proposal already covered this turn
    push('turn-ended', sessionId, ref, 'turn finished, nothing to review')
  })

  bus.on('session.proposal', ({ sessionId, ref, proposal }) => {
    if (turnOutcome.get(sessionId) === 'error') return // error already claimed this turn
    if (turnOpen.has(sessionId)) turnOutcome.set(sessionId, 'proposal')
    const subject = proposal.commit?.subject
    push('proposal', sessionId, ref, subject ? `ready to review — ${subject}` : 'ready to review')
  })

  bus.on('session.state', ({ sessionId, ref, reason, err }) => {
    // Any other transition (queued, starting, a fresh run) is "trying again" —
    // the next failure, if any, deserves its own notification.
    if (reason !== 'start-failed' && !err) {
      errorNotified.delete(sessionId)
      return
    }
    notifyError(sessionId, ref, err?.message ?? 'failed to start')
  })

  bus.on('container.status', ({ sessionId, ref, status }) => {
    if (status !== 'error') {
      errorNotified.delete(sessionId) // recovered — a later error is a new fault
      return
    }
    const detail = sessionInfo(sessionId)?.container?.error ?? 'container error'
    notifyError(sessionId, ref, detail)
  })

  bus.on('session.adapterExited', ({ sessionId, expected, wasLive }) => {
    if (expected) return // a host-initiated detach (stop/switch/delete), not a crash
    if (!wasLive) return // idle session, e.g. its container was killed out-of-band — not a crash mid-work
    const info = sessionInfo(sessionId)
    if (!info) return
    const ref: EnvRef = { workspace: info.workspace, task: info.task, env: info.env }
    notifyError(sessionId, ref, 'agent process exited unexpectedly')
  })

  bus.on('session.deleted', ({ sessionId }) => {
    for (let i = ring.length - 1; i >= 0; i--)
      if (ring[i]?.sessionId === sessionId) ring.splice(i, 1)
    turnOutcome.delete(sessionId)
    turnOpen.delete(sessionId)
    awaitingOpen.delete(sessionId)
    errorNotified.delete(sessionId)
  })

  return {
    list: () => ring.slice(),
    markRead: (id) => {
      const r = ring.find((r) => r.id === id)
      if (r) r.read = true
    },
    markAllRead: () => {
      for (const r of ring) r.read = true
    },
    markSessionRead: (sessionId) => markSessionReadInternal(sessionId),
    dismiss: (id) => {
      const i = ring.findIndex((r) => r.id === id)
      if (i >= 0) ring.splice(i, 1)
    },
    setPrefs: (next) => {
      prefs = next
    }
  }
}
