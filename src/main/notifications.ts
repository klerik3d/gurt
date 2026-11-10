// Turns select bus events into user-facing notifications — the "what happened
// while you weren't looking" layer over the domain bus. See
// docs/requirements-notifications.md. A plain subscriber, same shape as the
// idle auto-stop policy in kernel.ts.
import { randomUUID } from 'node:crypto'
import type { Bus } from './bus'
import type { EnvRef, ReviewFinding, SessionInfo } from '../shared/types'
import { findingRef } from '../shared/types'
import type { LoopEnd } from '../shared/reviewLoop'
import type { NotificationPrefs, NotificationRecord, NotificationType } from '../shared/notifications'
import { NOTIFICATION_RING_CAP } from '../shared/notifications'
import { sendExternal } from './notify-external'
import { createLogger } from './log'

const log = createLogger('notifications')

/** The most findings an `awaiting` detail lists before "… and N more". */
const FINDINGS_SHOWN = 3

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

function findingsText(rounds: number, open: readonly ReviewFinding[]): string {
  if (!open.length) return ''
  const shown = open
    .slice(0, FINDINGS_SHOWN)
    .map((f) => `${findingRef(rounds, f.id)} [${f.severity}] ${f.file}: ${f.claim}`)
  const more = open.length > shown.length ? `; … and ${open.length - shown.length} more` : ''
  return ` — unresolved: ${shown.join('; ')}${more}`
}

/** §7's mapping of a loop's end onto the four existing types: `ready` →
 *  `proposal`; `exhausted` and every needs-you reason (`taken-over` and
 *  `cancelled` included) → `awaiting`, with the reason and the unresolved
 *  findings; `failed` → `error`. Exported for the unit test. */
export function loopEndNotification(
  end: LoopEnd,
  rounds: number,
  subject?: string
): { type: NotificationType; detail: string } {
  const delivered = (d: readonly { step: string; repo: string; ref: string; note?: string | undefined }[]): string =>
    d.length ? `; delivered: ${d.map((x) => `${x.step} ${x.repo} ${x.ref}${x.note ? ` (${x.note})` : ''}`).join(', ')}` : ''
  switch (end.outcome) {
    case 'ready': {
      const n = end.notes.length
      return {
        type: 'proposal',
        detail:
          `review loop clean after ${plural(rounds, 'round')}${subject ? ` — ${subject}` : ''}` +
          (delivered(end.delivered) || '; nothing delivered') +
          (n ? `; ${plural(n, 'minor/nit finding')}` : '')
      }
    }
    case 'exhausted':
      return {
        type: 'awaiting',
        detail: `review loop out of rounds (${rounds})${findingsText(rounds, end.open)}`
      }
    case 'needs-you':
      return {
        type: 'awaiting',
        detail:
          `review loop stopped: ${end.reason}${end.detail ? ` (${end.detail})` : ''}` +
          `${findingsText(rounds, end.open)}${delivered(end.delivered)}`
      }
    case 'failed':
      return { type: 'error', detail: `review loop failed: ${end.error}${delivered(end.delivered)}` }
  }
}

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
  sessionInfo: (id: string) => SessionInfo | undefined,
  /** The session's turn and proposal notifications belong to its review loop
   *  (docs/requirements-review-loop.md §7): true from its first turn until the
   *  loop's end has been notified. */
  loopSpeaksFor: (id: string) => boolean = () => false
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
    // A proactive run's turn is the run itself, announced as one by
    // `proactive.run` below — not a turn anybody is waiting to read.
    // Read off the raw field on purpose: a proactive run always carries its
    // role, and a pre-roles record (no role) is never one.
    if (sessionInfo(sessionId)?.role === 'proactive') return
    // Nor is a review loop's reviewer: it exists for one verdict (§7); and its
    // executor's turn is the controller's to announce while the loop runs.
    if (sessionInfo(sessionId)?.role === 'reviewer' || loopSpeaksFor(sessionId)) return
    push('turn-ended', sessionId, ref, 'turn finished, nothing to review')
  })

  bus.on('session.proposal', ({ sessionId, ref, proposal }) => {
    // A loop session's proposals are intermediate (checked, reviewed, fixed):
    // the one `proposal` notification is the loop's `ready` (§7).
    if (loopSpeaksFor(sessionId)) return
    if (turnOutcome.get(sessionId) === 'error') return // error already claimed this turn
    if (turnOpen.has(sessionId)) turnOutcome.set(sessionId, 'proposal')
    // A session writing several repos may carry only per-repo commits.
    const subject = proposal.commit?.subject ?? proposal.repos?.[0]?.commit.subject
    push('proposal', sessionId, ref, subject ? `ready to review — ${subject}` : 'ready to review')
  })

  // A proactive run that raised scopes left drafts for the user — the same
  // "something to review" a proposal is. A run that timed out or skipped its
  // `finish_run` is a fault worth seeing; a failed start is already one above.
  bus.on('proactive.run', ({ sessionId, ref, agent, outcome, proposed }) => {
    if (proposed.length)
      push(
        'proposal',
        sessionId,
        ref,
        `${agent} raised ${proposed.length === 1 ? 'a scope' : `${proposed.length} scopes`}: ${proposed.join(', ')}`
      )
    if (outcome === 'timeout' || outcome === 'incomplete')
      notifyError(sessionId, ref, outcome === 'timeout' ? 'proactive run timed out' : 'proactive run ended without finish_run')
  })

  // The review loop's own voice (§7): an ordinary `turn-ended` for a dormant
  // `no_changes` turn, or the mapping of its end.
  bus.on('review.loop', ({ sessionId, ref, notice }) => {
    if (notice.kind === 'turn-ended') {
      push('turn-ended', sessionId, ref, 'turn finished, nothing to review')
      return
    }
    const n = loopEndNotification(notice.end, notice.rounds, notice.subject)
    // The end may arrive while the turn it cancelled is still open: that turn's
    // own end must not add a second notification.
    if (turnOpen.has(sessionId)) turnOutcome.set(sessionId, n.type)
    push(n.type, sessionId, ref, n.detail)
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
