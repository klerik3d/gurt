/**
 * Bottom-right error toast, visually matching the session notification popups
 * but independent of them — git/task operations aren't tied to a session, so
 * they can't go through the sessionId-keyed notification system. Callable
 * from anywhere (event handlers, promise `catch`) like {@link alertDialog}.
 *
 * This module is only the channel; the UI lives in `components/ToastHost`.
 * Keeping the two apart means components the host renders (e.g. `CopyButton`)
 * can call {@link showToast} without an import cycle.
 */

export interface ToastRecord {
  id: string
  message: string
}

let enqueue: ((t: ToastRecord) => void) | null = null
let counter = 0

export function showToast(message: string): void {
  enqueue?.({ id: `toast-${++counter}`, message })
}

/** Registers the single toast host's listener; returns its unregister. While
 *  no host is registered, {@link showToast} is a no-op. */
export function onToast(listener: (t: ToastRecord) => void): () => void {
  enqueue = listener
  return () => {
    if (enqueue === listener) enqueue = null
  }
}
