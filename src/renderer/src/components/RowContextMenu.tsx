import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useOutsideClose } from '../hooks'

/** A row's actions at the pointer instead of behind a button — opened by
 *  right-click (or a trackpad's two-finger tap, which the browser already
 *  maps to the same `contextmenu` event). Closes like any other dropdown:
 *  outside click or Escape. */
export function RowContextMenu({
  x,
  y,
  onClose,
  children
}: {
  x: number
  y: number
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(true, ref, onClose)
  // Anchored at the raw pointer position first, then nudged back on-screen
  // once its real size is known — a menu that opens near the window edge
  // should still land fully inside it, not spill off.
  const [pos, setPos] = useState({ x, y })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const margin = 6
    const rect = el.getBoundingClientRect()
    setPos({
      x: Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin)),
      y: Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin))
    })
  }, [x, y])

  return (
    <div className="menu ctx-menu" ref={ref} style={{ left: pos.x, top: pos.y }}>
      {children}
    </div>
  )
}

