import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * App-native replacement for `window.alert` / `window.confirm`. The OS chrome of
 * the built-in dialogs looks foreign inside the app, so every warning/confirm is
 * routed through {@link DialogHost} — a single in-app modal mounted at the root.
 *
 * The two entry points are plain functions (not hooks) so any code — event
 * handlers, promise `catch`, non-component modules — can call them exactly like
 * the native ones, just `await`-ed:
 *   `void alertDialog('boom')`  ·  `if (await confirmDialog('Delete?')) …`
 */

interface DialogRequest {
  message: string
  title?: string
  confirmText?: string
  cancelText?: string
  /** Destructive action — the confirm button reads as a warning. */
  danger?: boolean
}

interface ActiveDialog extends DialogRequest {
  kind: 'alert' | 'confirm'
  resolve: (ok: boolean) => void
}

/** Module-level bridge into the mounted host; null until it renders. */
let enqueue: ((d: ActiveDialog) => void) | null = null

function request(kind: 'alert' | 'confirm', req: DialogRequest): Promise<boolean> {
  if (!enqueue) {
    // No host mounted (shouldn't happen in-app) — degrade to native chrome.
    return Promise.resolve(kind === 'confirm' ? window.confirm(req.message) : (window.alert(req.message), true))
  }
  const push = enqueue
  return new Promise<boolean>((resolve) => push({ ...req, kind, resolve }))
}

/** In-app alert. Resolves once dismissed. */
export const alertDialog = (message: string, opts?: Omit<DialogRequest, 'message'>): Promise<boolean> =>
  request('alert', { message, ...opts })

/** In-app confirm. Resolves true if the user confirmed, false otherwise. */
export const confirmDialog = (message: string, opts?: Omit<DialogRequest, 'message'>): Promise<boolean> =>
  request('confirm', { message, ...opts })

/** Root-mounted host that renders queued dialogs one at a time. */
export function DialogHost(): JSX.Element | null {
  const [queue, setQueue] = useState<ActiveDialog[]>([])
  const okRef = useRef<HTMLButtonElement>(null)
  const current = queue[0]

  useEffect(() => {
    enqueue = (d) => setQueue((q) => [...q, d])
    return () => {
      enqueue = null
    }
  }, [])

  const close = useCallback((ok: boolean) => {
    setQueue((q) => {
      const head = q[0]
      if (head) queueMicrotask(() => head.resolve(ok))
      return q.slice(1)
    })
  }, [])

  // Focus the default action and wire Enter/Esc while a dialog is open.
  useEffect(() => {
    if (!current) return
    okRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close(false)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        close(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, close])

  if (!current) return null

  return (
    <div className="modal-backdrop" onMouseDown={() => close(false)}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        {current.title && <div className="dialog-title">{current.title}</div>}
        <div className="dialog-message">{current.message}</div>
        <div className="dialog-buttons">
          {current.kind === 'confirm' && (
            <button className="dialog-cancel" onClick={() => close(false)}>
              {current.cancelText ?? 'Cancel'}
            </button>
          )}
          <button
            ref={okRef}
            className={`dialog-ok${current.danger ? ' danger' : ''}`}
            onClick={() => close(true)}
          >
            {current.confirmText ?? (current.kind === 'confirm' ? 'OK' : 'Dismiss')}
          </button>
        </div>
      </div>
    </div>
  )
}
