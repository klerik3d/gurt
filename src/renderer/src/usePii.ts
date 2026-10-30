import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ChatEntry, PlanEntry } from '../../shared/types'
import { emptyPiiTable, revealTokens, type PiiStatus, type PiiTable } from '../../shared/pii'
import { logErr } from './log'
import { readPreference, z } from './persisted'

// The chat view's side of the masking layer (docs/requirements-pii-mask.md).
//
// The timeline holds what the agent saw and wrote — `[email:1]` tokens. This
// hook pulls the session's table from main (and follows its growth) and hands
// back the one decision the view needs: show the reals, or show the tokens. It
// is a display switch and nothing else; neither choice changes a byte of what
// the agent receives or what is stored.

const key = (sessionId: string): string => `pii.reveal.${sessionId}`
const openSchema = z.boolean()

/** Whether this session's view starts open (reals). A preference, per session. */
const readOpen = (sessionId: string): boolean => readPreference(key(sessionId), true, openSchema)

/** Whether masking can run right now, and if not why — for the composer switch,
 *  which says so instead of silently not being there. */
export function usePiiStatus(sessionId: string): PiiStatus | null {
  const [status, setStatus] = useState<PiiStatus | null>(null)
  useEffect(() => {
    let live = true
    window.gurt
      .getPiiStatus()
      .then((s) => live && setStatus(s))
      .catch(logErr('getPiiStatus'))
    return () => {
      live = false
    }
  }, [sessionId])
  return status
}

export interface PiiView {
  /** The session's table — empty until the first pull lands, never undefined. */
  table: PiiTable
  /** Reals are shown (true) or the tokens the agent sees (false). */
  open: boolean
  setOpen: (open: boolean) => void
  /** The table has at least one row: there is something for the switch to do. */
  hasTokens: boolean
}

export function usePiiView(sessionId: string): PiiView {
  const [table, setTable] = useState<PiiTable>(emptyPiiTable)
  const [open, setOpenState] = useState(() => readOpen(sessionId))

  useEffect(() => {
    let live = true
    setTable(emptyPiiTable())
    setOpenState(readOpen(sessionId))
    // The pull covers rows that existed before this pane did; the subscription
    // covers every row after. Main emits before the entry that uses a new
    // token, so the order here is the order the user could ever notice.
    window.gurt
      .getPiiTable(sessionId)
      .then((t) => live && setTable(t))
      .catch(logErr('getPiiTable'))
    const off = window.gurt.onPiiTable((e) => {
      if (live && e.sessionId === sessionId) setTable(e.table)
    })
    return () => {
      live = false
      off()
    }
  }, [sessionId])

  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next)
      try {
        localStorage.setItem(`gurt.ui.${key(sessionId)}`, JSON.stringify(next))
      } catch {
        /* Keep working without storage. */
      }
    },
    [sessionId]
  )

  const hasTokens = useMemo(() => Object.keys(table.tokens).length > 0, [table])
  return { table, open, setOpen, hasTokens }
}

/** One entry with its tokens revealed; the same object when nothing changed, so
 *  memoized rows downstream do not re-render for text that has no token in it. */
function revealEntry(e: ChatEntry, table: PiiTable): ChatEntry {
  switch (e.kind) {
    case 'user':
    case 'agent':
    case 'thought':
    case 'system': {
      const text = revealTokens(e.text, table)
      return text === e.text ? e : { ...e, text }
    }
    case 'tool': {
      const title = revealTokens(e.title, table)
      const detail = e.detail === undefined ? undefined : revealTokens(e.detail, table)
      return title === e.title && detail === e.detail
        ? e
        : { ...e, title, ...(detail === undefined ? {} : { detail }) }
    }
    case 'permission': {
      const title = revealTokens(e.title, table)
      const detail = e.detail === undefined ? undefined : revealTokens(e.detail, table)
      return title === e.title && detail === e.detail
        ? e
        : { ...e, title, ...(detail === undefined ? {} : { detail }) }
    }
  }
}

/** The timeline as the view should show it: revealed when open, as stored when
 *  closed. */
export function usePiiEntries(entries: ChatEntry[], view: PiiView): ChatEntry[] {
  const { table, open } = view
  return useMemo(
    () => (open ? entries.map((e) => revealEntry(e, table)) : entries),
    [entries, table, open]
  )
}

/** The plan bar's rows, likewise. */
export function usePiiPlan(plan: PlanEntry[] | undefined, view: PiiView): PlanEntry[] | undefined {
  const { table, open } = view
  return useMemo(
    () => (open && plan ? plan.map((p) => ({ ...p, content: revealTokens(p.content, table) })) : plan),
    [plan, table, open]
  )
}
