import { useRef, useState } from 'react'
import type { CredentialEntry } from '../../../../shared/credentials'
import { useOutsideClose } from '../../hooks'
import { Icon } from '../icons'

/** `https://github.com/acme/x.git` → `github.com/acme/x`. */
export function stripProtocol(url: string): string {
  return url.replace(/^[a-z+]+:\/\//, '').replace(/^git@/, '').replace(/\.git$/, '')
}

/** Agent-token picker for a client's CREDENTIAL field. */
export function CredentialPick({
  tokens,
  value,
  onPick
}: {
  tokens: CredentialEntry[]
  value: string | undefined
  onPick: (id: string | undefined) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(open, ref, () => setOpen(false))
  const cur = tokens.find((t) => t.id === value)
  return (
    <div className="pick-wrap" ref={ref}>
      <button type="button" className="pick-row" onClick={() => setOpen((o) => !o)}>
        <span className={`pick-value mono ${cur ? '' : 'faint'}`}>
          {cur ? cur.label : 'none — adapter reports its own auth error'}
        </span>
        {cur && <span className="tag">oauth</span>}
        <span className="spacer" />
        <Icon name="chevron" size={12} className="faint" style={{ flex: 'none' }} />
      </button>
      {open && (
        <div className="menu pick-menu">
          <div
            className="menu-item"
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(undefined)
              setOpen(false)
            }}
          >
            none — adapter reports its own auth error
          </div>
          {tokens.map((t) => (
            <div
              key={t.id}
              className={`menu-item ${t.id === value ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                onPick(t.id)
                setOpen(false)
              }}
            >
              <Icon name="key" size={11} className="faint" />
              {t.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
