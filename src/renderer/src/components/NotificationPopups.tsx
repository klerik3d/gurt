import { useEffect } from 'react'
import type { NotificationRecord } from '../../../shared/notifications'
import type { Tree } from '../../../shared/types'
import { Icon } from './icons'

function NotificationPopup({ notification, onDismiss, onOpen }: {
  notification: NotificationRecord
  onDismiss: (id: string) => void
  onOpen: (notification: NotificationRecord) => void
}) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(notification.id), 8000)
    return () => window.clearTimeout(timer)
  }, [notification.id, onDismiss])

  return (
    <div className="notification-popup">
      <button className="notification-popup-open" onClick={() => onOpen(notification)}>
        <span className="notif-loc mono">{notification.ref.workspace} / {notification.title}</span>
        <span className="notif-detail">{notification.detail}</span>
      </button>
      <button className="notif-dismiss" aria-label="Dismiss notification" onClick={() => onDismiss(notification.id)}>
        <Icon name="x" size={12} />
      </button>
    </div>
  )
}

export function NotificationPopups({ notifications, tree, onDismiss, onOpen }: {
  notifications: NotificationRecord[]
  tree: Tree | null
  onDismiss: (id: string) => void
  onOpen: (notification: NotificationRecord) => void
}) {
  const live = new Set(tree?.workspaces.flatMap((w) => w.tasks.flatMap((t) => t.sessions.map((s) => s.id))))
  return (
    <div className="notification-popups" aria-label="New notifications" aria-live="polite">
      {notifications.filter((n) => live.has(n.sessionId)).map((n) => (
        <NotificationPopup key={n.id} notification={n} onDismiss={onDismiss} onOpen={onOpen} />
      ))}
    </div>
  )
}
