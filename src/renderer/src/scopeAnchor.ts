import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

/** Where the active scope's row last stood on screen — shared by every scope
 *  panel (Agents, Git, Files), so the one that takes over puts the row back
 *  on the same pixel. Viewport-relative, which also absorbs any difference
 *  between the panels above their trees. */
let anchor: { ws: string; task: string; top: number } | null = null

const shown = (el: HTMLElement) => el.getClientRects().length > 0

/** Keeps the active scope's row still across a mode switch (and a sidebar
 *  re-show or remount): on entry the tree scrolls so the row lands where the
 *  previous panel had it, and stays pinned there through the renders that
 *  follow (folders loading, changes arriving) until the tree scrolls by any
 *  hand but this hook's, or the user clicks or types in it.
 *
 *  Only real scrolling holds it — the way the browser's own scroll anchoring
 *  works. Where the new content leaves too little room above or below the
 *  row, the scroll stops at its end and the row moves by just the shortfall;
 *  the tree never gets padding, so it never shows a gap.
 *
 *  A newly active scope is held the same way, from where it was when it
 *  became active: the accordion folding the previous scope out of view above
 *  it then moves nothing on screen; one folding in view lets it rise, as in
 *  any accordion. Only when it was in view, though: a row reached by arrow
 *  keys off the edge is left to the cursor-follow.
 *
 *  Only a row the user can see whole is held: one scrolled out of view (say,
 *  far above a long list of sessions) is scrolled into view on entry instead.
 *
 *  `pinned()` tells callers to leave the scroll alone — a cursor-follow
 *  scrollIntoView during the pin would move the row it holds. */
export function useScopeAnchor(
  treeRef: RefObject<HTMLElement | null>,
  ws: string,
  task: string | null,
  mode: string
): { pinned: () => boolean; onScroll: () => void } {
  const wasShown = useRef(false)
  const lastMode = useRef(mode)
  const lastTask = useRef(task)
  const pinned = useRef(false)
  /** The scrollTop this hook last left the tree at, while pinned: a scroll
   *  event finding anything else came from someone else and ends the pin. */
  const pinnedTop = useRef(0)

  const rowOf = (tree: HTMLElement) =>
    task === null ? null : tree.querySelector<HTMLElement>(`[data-scope="${CSS.escape(task)}"]`)

  /** Whether the whole row shows in the tree's viewport. */
  const inView = (tree: HTMLElement, row: HTMLElement) => {
    const box = tree.getBoundingClientRect()
    const at = row.getBoundingClientRect()
    return at.top >= box.top && at.bottom <= box.bottom
  }

  const record = (tree: HTMLElement) => {
    const row = rowOf(tree)
    if (!row || task === null) return
    anchor = inView(tree, row) ? { ws, task, top: row.getBoundingClientRect().top } : null
  }

  /** Scrolls the row back to `top` as far as the content allows; the browser
   *  clamps scrollTop to the real range. */
  const apply = (tree: HTMLElement, top: number) => {
    const row = rowOf(tree)
    if (!row) return
    tree.scrollTop += row.getBoundingClientRect().top - top
    pinnedTop.current = tree.scrollTop
  }

  useLayoutEffect(() => {
    const tree = treeRef.current
    const visible = !!tree && shown(tree)
    const entered = visible && (!wasShown.current || lastMode.current !== mode)
    wasShown.current = visible
    if (!tree || !visible) return
    lastMode.current = mode
    const switched = !entered && lastTask.current !== task
    lastTask.current = task
    if (switched) {
      const row = rowOf(tree)
      if (row && inView(tree, row)) {
        record(tree)
        pinned.current = true
        pinnedTop.current = tree.scrollTop
        return
      }
    }
    const held = anchor && anchor.ws === ws && anchor.task === task ? anchor : null
    if (entered) pinned.current = !!held
    if (pinned.current && held) apply(tree, held.top)
    else {
      pinned.current = false
      const row = rowOf(tree)
      if (entered && row && !inView(tree, row)) row.scrollIntoView({ block: 'nearest' })
      record(tree)
    }
  })

  useEffect(() => {
    const tree = treeRef.current
    if (!tree) return
    const release = () => { pinned.current = false }
    const events = ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const
    for (const name of events) tree.addEventListener(name, release, { capture: true, passive: true })
    return () => { for (const name of events) tree.removeEventListener(name, release, { capture: true }) }
  }, [treeRef])

  return {
    pinned: () => pinned.current,
    onScroll: () => {
      const tree = treeRef.current
      if (!tree || !shown(tree)) return
      if (pinned.current && Math.abs(tree.scrollTop - pinnedTop.current) < 1) return
      pinned.current = false
      record(tree)
    }
  }
}
