import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { Icon } from './icons'

export function Modal({
  title,
  onClose,
  wide,
  full,
  width,
  children
}: {
  title: string
  onClose: () => void
  wide?: boolean
  /** Fill the window (less a margin) — for surfaces that need the room, like the review. */
  full?: boolean
  width?: number
  children: ReactNode
}) {
  // Esc dismisses the modal — unless a nested popup (menu) captured it first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className={`modal${wide ? ' modal-wide' : ''}${full ? ' modal-full' : ''}`}
        style={width ? { width } : undefined}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-title">{title}</span>
          <span className="spacer" />
          <span className="kbd-tag">esc</span>
          <button className="icon-sq" onClick={onClose} title="close">
            <Icon name="x" size={13} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
