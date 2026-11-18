import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react'
import { Icon, type IconName } from './icons'

/** Files and Git share row geometry, icons, selection and focus styling. */
export function FileTreeRow({ label, depth, icon, open, selected = false, cursor = false,
  className = '', labelClassName = '', beforeLabel, children, ...attributes }: {
  label: string
  depth: number
  icon: IconName
  open?: boolean | undefined
  selected?: boolean
  cursor?: boolean
  className?: string
  labelClassName?: string
  beforeLabel?: ReactNode
  children?: ReactNode
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'style' | 'children'>) {
  return <button {...attributes} type="button" role="treeitem" tabIndex={-1}
    className={`file-tree-row${className ? ` ${className}` : ''}${selected ? ' selected' : ''}${cursor ? ' cursor' : ''}`}
    aria-level={depth + 1} aria-expanded={open} aria-selected={selected} style={{ '--level': depth } as CSSProperties}>
    <span className="file-tree-chevron">{open !== undefined && <Icon name="chevron" size={12}
      className={open ? '' : 'chev-closed'} />}</span>
    <Icon name={icon} size={14} />
    {beforeLabel}
    <span className={`file-tree-name${labelClassName ? ` ${labelClassName}` : ''}`}>{label}</span>
    {children}
  </button>
}
