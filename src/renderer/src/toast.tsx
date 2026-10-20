import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { Icon } from './components/icons'

/**
 * Bottom-right error toast, visually matching the session notification popups
 * but independent of them — git/task operations aren't tied to a session, so
 * they can't go through the sessionId-keyed notification system. Callable
 * from anywhere (event handlers, promise `catch`) like {@link alertDialog}.
 */

interface ToastRecord {
  id: string
  message: string
}

let enqueue: ((t: ToastRecord) => void) | null = null
let counter = 0

export function showToast(message: string): void {
  enqueue?.({ id: `toast-${++counter}`, message })
}

function Toast({ toast, onDismiss }: { toast: ToastRecord; onDismiss: (id: string) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), 8000)
    return () => window.clearTimeout(timer)
  }, [toast.id, onDismiss])

  return (
    <div className="notification-popup toast-popup">
      <div className="notification-popup-open">
        <span className="notif-detail">{toast.message}</span>
      </div>
      <button className="notif-dismiss" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}>
        <Icon name="x" size={12} />
      </button>
    </div>
  )
}

/** Root-mounted host; pair with {@link showToast} the way `DialogHost` pairs with `alertDialog`. */
export function ToastHost(): JSX.Element | null {
  const [toasts, setToasts] = useState<ToastRecord[]>([])

  useEffect(() => {
    enqueue = (t) => setToasts((q) => [...q, t].slice(-3))
    return () => {
      enqueue = null
    }
  }, [])

  if (!toasts.length) return null
  const dismiss = (id: string) => setToasts((q) => q.filter((t) => t.id !== id))
  return (
    <div className="toast-popups" aria-label="Errors" aria-live="assertive">
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={dismiss} />
      ))}
    </div>
  )
}
