import type { HTMLAttributes, ReactNode } from 'react'
import { isActionable, isDelivered, type RepoChanges } from '../../../shared/types'
import type { ScopeLabel } from '../../../shared/proactive'
import { Icon } from './icons'
import { LabelTag } from './tags'

export function ScopeRow({ name, open, selected, cursor, repos, label, editing, children, onSelect, onToggle, ...attributes }: {
  name: string
  open: boolean
  selected: boolean
  cursor: boolean
  repos: RepoChanges[]
  label?: ScopeLabel | undefined
  editing?: boolean
  children?: ReactNode
  onSelect: () => void
  onToggle: () => void
} & Pick<HTMLAttributes<HTMLDivElement>, 'id' | 'title' | 'aria-level' | 'onDoubleClick' | 'onContextMenu'>) {
  return <div {...attributes} data-scope={name} className={`sb-task${selected ? ' selected' : ''}${cursor ? ' cursor' : ''}`}
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
      <ScopeBadge repos={repos} />
      {label && <LabelTag label={label} />}
    </>}
  </div>
}

/** Delivery state is identical in every scope panel. */
function ScopeBadge({ repos }: { repos: RepoChanges[] }) {
  if (repos.some(isActionable))
    return <span className="task-badge" title="uncommitted or unpushed changes" />
  if (repos.some(isDelivered))
    return <span className="task-badge badge-delivered" title="delivered — awaiting merge" />
  return null
}
