import type { HTMLAttributes, ReactNode } from 'react'
import type { ScopeLabel } from '../../../shared/proactive'
import { scopeWantsUser, type ScopeStatus } from '../scopeStatus'
import { Icon, type IconName } from './icons'
import { LabelTag } from './tags'

export function ScopeRow({ name, open, selected, cursor, status, label, editing, children, onSelect, onToggle, ...attributes }: {
  name: string
  open: boolean
  selected: boolean
  cursor: boolean
  /** The status strip; absent where the row has none (the archive). */
  status?: ScopeStatus | undefined
  label?: ScopeLabel | undefined
  editing?: boolean
  children?: ReactNode
  onSelect: () => void
  onToggle: () => void
} & Pick<HTMLAttributes<HTMLDivElement>, 'id' | 'title' | 'aria-level' | 'onDoubleClick' | 'onContextMenu'>) {
  return <div {...attributes} data-scope={name} className={`sb-task${selected ? ' selected' : ''}${cursor ? ' cursor' : ''}${status && scopeWantsUser(status) ? ' wants-user' : ''}`}
    role="treeitem" aria-expanded={open} aria-selected={selected} onClick={() => {
      if (editing) return
      onSelect()
      onToggle()
    }}>
    <span className="sb-chev" onClick={(event) => { event.stopPropagation(); onToggle() }}>
      <Icon name="chevron" size={12} className={open ? '' : 'chev-closed'} />
    </span>
    {children ?? <>
      <span className="sb-task-name">{name}</span>
      <span className="spacer" />
      {label && <LabelTag label={label} />}
      {status && <ScopeStrip status={status} />}
    </>}
  </div>
}

/** The strip's slots, in their fixed order: shape names the slot. */
const SLOTS: readonly { key: keyof ScopeStatus; icon: IconName }[] = [
  { key: 'sessions', icon: 'agent-head' },
  { key: 'review', icon: 'review-cycle' },
  { key: 'delivery', icon: 'branch-out' }
]

/**
 * Three fixed columns at the right of the row, the same in every scope panel
 * and whether the scope is open or folded. An absent slot keeps its width, so
 * the columns line up down the list. Static by design: no pulse — "working"
 * does not need the eye (docs/requirements-scope-row-status.md §4).
 */
function ScopeStrip({ status }: { status: ScopeStatus }) {
  return <span className="scope-strip">
    {SLOTS.map(({ key, icon }) => {
      const slot = status[key]
      return slot
        ? <span key={key} className={`scope-slot tone-${slot.tone}`} title={slot.title} role="img" aria-label={slot.title}>
          <Icon name={icon} size={14} />
        </span>
        : <span key={key} className="scope-slot" aria-hidden="true" />
    })}
  </span>
}
