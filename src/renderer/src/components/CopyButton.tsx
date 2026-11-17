import { useEffect, useRef, useState } from 'react'
import { Icon } from './icons'
import { showToast } from '../toast'

/** Copies `text` to the clipboard. Hover-revealed by default: place it inside
 *  an element with the `has-copy` class and it fades in with that element
 *  (and with keyboard focus). The click never reaches the surrounding row, so
 *  a copy button on a clickable card does not also open the card. */
export function CopyButton({
  text,
  title = 'copy',
  className = ''
}: {
  text: string | (() => string)
  title?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <button
      type="button"
      className={`copy-btn ${className}`}
      title={copied ? 'copied' : title}
      aria-label={title}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        const value = typeof text === 'function' ? text() : text
        navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true)
            window.clearTimeout(timer.current)
            timer.current = window.setTimeout(() => setCopied(false), 1200)
          },
          () => showToast('Could not copy to the clipboard')
        )
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} size={13} />
    </button>
  )
}
