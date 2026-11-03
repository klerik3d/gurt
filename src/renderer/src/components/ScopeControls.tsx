import { useId, useRef, useState } from 'react'
import { useOutsideClose } from '../hooks'
import { SORT_DIR_LABEL, SORT_KEY_LABEL, type ScopeListController, type TaskSortDir, type TaskSortKey } from '../useScopeList'
import { Dot, Icon } from './icons'

export function ScopeSort({ controller, disabled }: { controller: ScopeListController; disabled: boolean }) {
  const { sort, setSort } = controller
  const [open, setOpen] = useState(false)
  const popRef = useRef<HTMLDivElement>(null)
  useOutsideClose(open, popRef, () => setOpen(false))
  return <div className="sb-sort" ref={popRef}>
    <button className={`icon-sq${open ? ' active' : ''}`} disabled={disabled} aria-expanded={open}
      title={`Sort scopes · ${SORT_KEY_LABEL[sort.key]}, ${SORT_DIR_LABEL[sort.key][sort.dir]}`}
      onClick={() => setOpen((value) => !value)}>
      <Icon name="sort" size={14} style={sort.dir === 'desc' ? { transform: 'scaleY(-1)' } : undefined} />
    </button>
    {open && <div className="menu sb-sort-menu">
      {(['name', 'created'] as TaskSortKey[]).map((key) => <div key={key}
        className={`menu-item ${sort.key === key ? 'active' : ''}`} onClick={() => setSort({ ...sort, key })}>
        <Dot tone={sort.key === key ? 'accent' : 'faint'} hollow={sort.key !== key} size={6} />
        {SORT_KEY_LABEL[key]}
      </div>)}
      <div className="menu-sep" />
      {(['asc', 'desc'] as TaskSortDir[]).map((dir) => <div key={dir}
        className={`menu-item ${sort.dir === dir ? 'active' : ''}`} onClick={() => setSort({ ...sort, dir })}>
        <Dot tone={sort.dir === dir ? 'accent' : 'faint'} hollow={sort.dir !== dir} size={6} />
        {SORT_DIR_LABEL[sort.key][dir]}
      </div>)}
    </div>}
  </div>
}

export function ScopeFilter({ controller, onFocusTree }: { controller: ScopeListController; onFocusTree: () => void }) {
  const { query, setQuery, error } = controller
  const errorId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  return <div className="sb-filter-wrap">
    <div className={`sb-filter${error ? ' invalid' : ''}`}>
      <Icon name="search" size={12} />
      <input ref={inputRef} value={query} aria-label="Filter scopes (regular expression)"
        aria-invalid={!!error} aria-describedby={error ? errorId : undefined} spellCheck={false}
        onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setQuery(''); onFocusTree() }
          if (event.key === 'ArrowDown' || event.key === 'Enter') { event.preventDefault(); onFocusTree() }
        }} />
      {query && <button className="icon-sq" title="Clear scope filter" aria-label="Clear scope filter"
        onClick={() => { setQuery(''); inputRef.current?.focus() }}><Icon name="x" size={12} /></button>}
    </div>
    {error && <div className="sb-filter-error" id={errorId} role="alert">{error}</div>}
  </div>
}
