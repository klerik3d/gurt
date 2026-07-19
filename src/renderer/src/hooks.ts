import { useEffect } from 'react'
import type { RefObject } from 'react'

/** Close a popup on an outside mousedown or Escape while `open`. */
export function useOutsideClose(
  open: boolean,
  ref: RefObject<HTMLElement>,
  close: () => void
): void {
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, ref, close])
}
