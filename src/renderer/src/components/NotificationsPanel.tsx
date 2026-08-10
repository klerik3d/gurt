import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { NotificationRecord, NotificationType } from '../../../shared/notifications'
import type { Tree } from '../../../shared/types'
import type { Tone } from '../status'
import { Icon, Dot } from './icons'

/** Same tone grammar as `status.ts` (§4.2): awaiting -> yellow, proposal ->
 *  green, error -> red. `turn-ended` is off by default and carries no
 *  urgency, so it reads as a neutral outline when a user turns it on. */
const NOTIF_DOT: Record<NotificationType, Tone> = {
  awaiting: 'yellow',
  proposal: 'green',
  error: 'red',
  'turn-ended': 'outline'
}

function relativeTime(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

/** Every session id the tree currently knows about — a notification for one
 *  that isn't here belongs to a deleted session; clicking it would otherwise
 *  silently no-op (`selectSession` finds no owner). */
function liveSessionIds(tree: Tree | null): Set<string> {
  const ids = new Set<string>()
  for (const ws of tree?.workspaces ?? [])
    for (const task of ws.tasks) for (const s of task.sessions) ids.add(s.id)
  return ids
}

export function NotificationsPanel({
  notifications,
  tree,
  onClose,
  onSelectSession,
  onMarkRead,
  onMarkAllRead,
  onDismiss
}: {
  notifications: NotificationRecord[]
  tree: Tree | null
  onClose: () => void
  onSelectSession: (id: string) => void
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
    onSelectSession(n.sessionId)
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
            className={`notif-row ${n.read ? 'read' : ''} ${i === idx ? 'active' : ''}`}
            onClick={() => open(n)}
            onMouseEnter={() => setIdx(i)}
          >
            <Dot tone={NOTIF_DOT[n.type]} />
            <div className="notif-body">
              <div className="notif-loc mono">
                {n.ref.workspace} / {n.title}
              </div>
              <div className="notif-detail">{n.detail}</div>
              <div className="notif-ts mono">{relativeTime(n.ts)}</div>
            </div>
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
