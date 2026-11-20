import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useOutsideClose } from '../hooks'
import { Icon, InfoDot } from './icons'
import type { IconName } from './icons'

/** One suggestion in a `PickerField` dropdown. */
export interface PickerItem {
  id: string
  label: string
  /** Quiet right-aligned text: a url, a description, a source. */
  meta?: string
  /** Tooltip. */
  title?: string
  /** A caution shown under the suggestion, before it is picked. */
  warning?: string | undefined
}

/**
 * The one "pick any number of things" field: repositories, MCP servers and
 * skills are all this, and differ only in what an item is.
 *
 *  - an input that is always there; focusing it drops a small suggestion list
 *    (a few rows, the rest scrolls);
 *  - typing filters the suggestions; ArrowDown/ArrowUp walk the list from the
 *    input, Enter or a click picks the highlighted one;
 *  - a pick is "on" — there is no separate switch. The picked ones leave the
 *    suggestions and are listed under the field (`renderSelected`), where
 *    removing one is the way to turn it off.
 *
 * `selected` may name ids that are not in `items` (a repo or skill the
 * workspace no longer offers): they are still listed under the field, so the
 * caller decides how an unavailable one reads.
 */
export function PickerField({
  label,
  info,
  icon,
  placeholder,
  items,
  selected,
  onPick,
  renderSelected,
  emptyText,
  disabled,
  create,
  footer
}: {
  label: string
  info?: string
  icon: IconName
  placeholder: string
  items: PickerItem[]
  selected: string[]
  onPick: (id: string) => void
  renderSelected: (id: string) => ReactNode
  /** Shown in the dropdown when there is nothing to suggest at all. */
  emptyText: string
  disabled?: boolean
  /** Offers to make a new thing out of what was typed (a local repository).
   *  Appears as the last suggestion once something is typed and nothing named
   *  exactly that exists. */
  create?: {
    label: (query: string) => string
    title?: string
    /** Resolves to whether it worked; the typed text is kept when it did not. */
    onCreate: (query: string) => Promise<boolean>
  }
  /** Notes under the selected list. */
  footer?: ReactNode
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  // The highlighted row is remembered by id, not position: when the list
  // changes under it (a pick elsewhere, a refresh) the highlight follows its
  // row or, if the row is gone, drops — Enter never lands on a stranger.
  const [activeId, setActiveId] = useState<string | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const uid = useId()
  const optionId = (index: number) => `${uid}-opt-${index}`

  const close = () => {
    setOpen(false)
    setActiveId(null)
  }
  useOutsideClose(open, wrap, close)

  const q = query.trim().toLowerCase()
  const suggestions = useMemo(
    () =>
      items.filter(
        (i) =>
          !selected.includes(i.id) &&
          (!q ||
            i.label.toLowerCase().includes(q) ||
            i.id.toLowerCase().includes(q) ||
            (i.meta ?? '').toLowerCase().includes(q))
      ),
    [items, selected, q]
  )
  const canCreate = !!create && !!q && !items.some((i) => i.id.toLowerCase() === q)
  // The create row is addressed like a suggestion, one past the last of them.
  const rows = suggestions.length + (canCreate ? 1 : 0)
  const CREATE_ID = '\u0000create'
  const rowIds = [...suggestions.map((x) => x.id), ...(canCreate ? [CREATE_ID] : [])]
  // -1: focus is in the input and no row is highlighted (or the row is gone).
  const cursor = activeId === null ? -1 : rowIds.indexOf(activeId)
  const setCursor = (index: number) => setActiveId(rowIds[index] ?? null)

  useEffect(() => {
    if (cursor < 0) return
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const creating = useRef(false)
  const choose = (index: number) => {
    if (index < suggestions.length) {
      const item = suggestions[index]
      if (!item) return
      onPick(item.id)
      setQuery('')
    } else if (create && canCreate) {
      if (creating.current) return
      creating.current = true
      const typed = query.trim()
      // The text stays until the create succeeds — and is only cleared then if
      // the user has not typed something else meanwhile.
      void create.onCreate(typed).then((ok) => {
        creating.current = false
        if (ok) setQuery((now) => (now.trim() === typed ? '' : now))
      })
    }
    setActiveId(null)
    input.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Keys of an IME composition belong to the IME (Enter commits the text,
    // arrows pick a candidate) — not to this list.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      if (rows) setCursor((cursor + 1) % rows)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setOpen(true)
      if (rows) setCursor(cursor <= 0 ? rows - 1 : cursor - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (!open) return
      // Nothing highlighted: Enter still acts when there is only one thing it
      // could mean — the single match, or the "new local repository" row for a
      // name that matches nothing (the old "type a name, Enter" flow).
      if (cursor >= 0 && cursor < rows) choose(cursor)
      // A highlight that vanished (activeId set, row gone) is not "nothing
      // highlighted": do not let Enter pick whatever is left.
      else if (activeId === null && rows === 1) choose(0)
    } else if (e.key === 'Tab') {
      close()
    }
  }

  const row = (index: number, key: string, content: ReactNode, title?: string) => (
    <div
      key={key}
      id={optionId(index)}
      role="option"
      aria-selected={cursor === index}
      data-active={cursor === index}
      className={`menu-item ${cursor === index ? 'active' : ''}`}
      title={title}
      // mousedown only keeps focus in the input (so the list does not close);
      // the pick itself is the click — primary button, released on the row.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => choose(index)}
      onMouseMove={() => cursor !== index && setCursor(index)}
    >
      {content}
    </div>
  )

  return (
    <div className="cfg-cell">
      <div className="seclabel-row">
        <span className="seclabel">{label}</span>
        {info && <InfoDot text={info} />}
      </div>
      <div
        className="pick-wrap"
        ref={wrap}
        // Focus leaving the widget (not just a press outside) closes the list.
        onBlur={(e) => {
          if (!wrap.current?.contains(e.relatedTarget)) close()
        }}
      >
        <div className={`pick-row pick-input ${open ? 'focus' : ''}`}>
          <Icon name={icon} size={14} className="dim icon-fixed" />
          <input
            ref={input}
            type="text"
            className="pick-input-field"
            placeholder={placeholder}
            value={query}
            disabled={disabled}
            role="combobox"
            aria-label={label}
            aria-expanded={open}
            aria-controls={`${uid}-list`}
            aria-activedescendant={open && cursor >= 0 && cursor < rows ? optionId(cursor) : undefined}
            aria-autocomplete="list"
            onFocus={() => setOpen(true)}
            // Escape closes the list with focus still here; a click reopens it.
            onClick={() => setOpen(true)}
            onChange={(e) => {
              setQuery(e.target.value)
              setOpen(true)
              setActiveId(null)
            }}
            onKeyDown={onKeyDown}
          />
          {selected.length > 0 && <span className="pick-meta">{selected.length}</span>}
        </div>
        {open && !disabled && (
          <div
            className="menu pick-menu pick-menu-field"
            role="listbox"
            id={`${uid}-list`}
            ref={list}
            // Pressing the list's scrollbar focuses the list; hand focus
            // straight back so the input stays the one place keys go.
            tabIndex={-1}
            onFocus={() => input.current?.focus()}
          >
            {suggestions.map((s, i) =>
              row(
                i,
                s.id,
                <>
                  <Icon name={icon} size={11} className="faint icon-fixed" />
                  <span className="menu-item-name">{s.label}</span>
                  {s.meta && <span className="menu-meta mono">{s.meta}</span>}
                  {s.warning && <span className="menu-item-warn">{s.warning}</span>}
                </>,
                s.title
              )
            )}
            {canCreate &&
              create &&
              row(
                suggestions.length,
                CREATE_ID,
                <>
                  <Icon name="plus" size={11} className="faint icon-fixed" />
                  <span className="menu-item-name">{create.label(query.trim())}</span>
                </>,
                create.title
              )}
            {!rows && (
              <div className="menu-empty">
                {items.length === 0
                  ? emptyText
                  : q
                    ? `nothing matches "${query.trim()}"`
                    : 'everything is already picked'}
              </div>
            )}
          </div>
        )}
      </div>
      {selected.length > 0 && (
        // A disabled field keeps what was picked, shown but inert: it is not
        // in effect (the agent cannot use it) and cannot be edited here.
        <div className={`sel-list ${disabled ? 'sel-list-off' : ''}`} inert={disabled ? true : undefined}>
          {selected.map((id) => renderSelected(id))}
        </div>
      )}
      {footer}
    </div>
  )
}
