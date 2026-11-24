import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { CopyButton } from './CopyButton'
import type { NotificationRecord, NotificationType } from '../../../shared/notifications'
import type { Tree } from '../../../shared/types'
import type { Tone } from '../status'
import { Icon, Dot } from './icons'
import { relativeTime } from '../time'

/** Same tone grammar as `status.ts` (§4.2): awaiting -> yellow, proposal ->
 *  green, error -> red. `turn-ended` is off by default and carries no
 *  urgency, so it reads as a neutral hollow mark when a user turns it on. */
const NOTIF_DOT: Record<NotificationType, { tone: Tone; hollow?: boolean }> = {
  awaiting: { tone: 'yellow' },
  proposal: { tone: 'green' },
  error: { tone: 'red' },
  'turn-ended': { tone: 'faint', hollow: true },
  // Overridden by the record's own level (see `dotFor`).
  watcher: { tone: 'yellow' }
}

/** A record's own level wins over its type's tone (a `watcher` notification). */
const LEVEL_TONE: Record<NonNullable<NotificationRecord['level']>, Tone> = { info: 'green', warning: 'yellow', error: 'red' }

/** Every session id the tree currently knows about — a notification for one
 *  that isn't here belongs to a deleted session; clicking it would otherwise
 *  silently no-op (`selectSession` finds no owner). */
function liveSessionIds(tree: Tree | null): Set<string> {
  const ids = new Set<string>()
  for (const ws of tree?.workspaces ?? []) {
    for (const task of ws.tasks) for (const s of task.sessions) ids.add(s.id)
    // A proactive agent's runs live outside the scopes, and notify too.
    for (const agent of ws.proactive) for (const s of agent.sessions) ids.add(s.id)
    // A watcher's notification is the point of the feature: its session counts too.
    for (const w of ws.watchers) if (w.sessionId) ids.add(w.sessionId)
  }
  return ids
}

export function NotificationsPanel({
  notifications,
  tree,
  onClose,
  onOpen,
  onMarkRead,
  onMarkAllRead,
  onDismiss
}: {
  notifications: NotificationRecord[]
  tree: Tree | null
  onClose: () => void
  /** Go where the notification leads: its session, or RPM's Review target (`open`). */
  onOpen: (n: NotificationRecord) => void
  onMarkRead: (id: string) => void
  onMarkAllRead: () => void
  onDismiss: (id: string) => void
}) {
  const live = liveSessionIds(tree)
  // Newest first; the panel is the catch-up surface, not an append-only log.
  const items = notifications
    .slice()
    .reverse()
    .filter((n) => live.has(n.sessionId))
  const hasUnread = items.some((n) => !n.read)

  // ↑↓ + ↵, the same interaction family as CommandPalette (§4.1) — Escape
  // already closes the popover via the outside-click hook in App.tsx.
  const [idx, setIdx] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (idx >= items.length) setIdx(Math.max(0, items.length - 1))
  }, [items.length, idx])
  useEffect(() => {
    listRef.current?.querySelector('.notif-row.active')?.scrollIntoView({ block: 'nearest' })
  }, [idx])

  const open = (n: NotificationRecord) => {
    onMarkRead(n.id)
    onOpen(n)
    onClose()
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIdx((i) => Math.min(i + 1, items.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      // A focused control inside a row (copy, dismiss) activates itself.
      if ((e.target as HTMLElement).closest('button')) return
      e.preventDefault()
      const n = items[idx]
      if (n) open(n)
    }
  }

  return (
    <div className="notif-panel" tabIndex={-1} autoFocus onKeyDown={onKeyDown}>
      <div className="notif-head">
        <span className="notif-title">Notifications</span>
        <span className="spacer" />
        <button className="btn-link" disabled={!hasUnread} onClick={onMarkAllRead}>
          Mark all read
        </button>
      </div>
      <div className="notif-list" ref={listRef}>
        {items.map((n, i) => (
          <div
            key={n.id}
            role="button"
            tabIndex={-1}
            className={`notif-row has-copy ${n.read ? 'read' : ''} ${i === idx ? 'active' : ''}`}
            onClick={() => open(n)}
            onMouseEnter={() => setIdx(i)}
          >
            <Dot tone={n.level ? LEVEL_TONE[n.level] : NOTIF_DOT[n.type].tone} hollow={NOTIF_DOT[n.type].hollow} />
            <div className="notif-body">
              <div className="notif-loc mono">
                {n.ref.workspace} / {n.title}
              </div>
              <div className="notif-detail">{n.detail}</div>
              <div className="notif-ts mono">{relativeTime(n.ts)}</div>
            </div>
            <CopyButton text={`${n.title}\n${n.detail}`} title="copy notification" />
            <button
              className="notif-dismiss"
              title="Dismiss"
              onClick={(e) => {
                e.stopPropagation()
                onDismiss(n.id)
              }}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        ))}
        {items.length === 0 && <div className="menu-empty">nothing yet</div>}
      </div>
    </div>
  )
}
