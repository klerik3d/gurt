import { useEffect, useState, type JSX } from 'react'
import { Icon } from './icons'
import { CopyButton } from './CopyButton'
import { onToast, type ToastRecord } from '../toast'

/** No timer: an error stays until the user closes it — one that vanishes on
 *  its own is one nobody may have read. */
function Toast({ toast, onDismiss }: { toast: ToastRecord; onDismiss: (id: string) => void }) {
  return (
    <div className="notification-popup toast-popup has-copy">
      <div className="notification-popup-open">
        <span className="notif-detail">{toast.message}</span>
      </div>
      <CopyButton text={toast.message} title="copy message" />
      <button className="notif-dismiss" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}>
        <Icon name="x" size={12} />
      </button>
    </div>
  )
}

/** Root-mounted host; pair with {@link showToast} the way `DialogHost` pairs with `alertDialog`. */
export function ToastHost(): JSX.Element | null {
  const [toasts, setToasts] = useState<ToastRecord[]>([])

  useEffect(() => onToast((t) => setToasts((q) => [...q, t].slice(-3))), [])

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
