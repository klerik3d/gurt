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
 *  The new mode can have less above the row than the scroll would need to
 *  take away, or less below it than the scroll would need to reach. Two empty
 *  blocks make up the difference: `head` at the start of the tree, `tail` at
 *  its end (callers render both, empty, as the tree's first and last child).
 *  They shrink away as the user scrolls, by exactly as much as the scroll
 *  leaves out of view, so nothing on screen moves for it.
 *
 *  A newly active scope is held the same way, from where it was when it
 *  became active, so the accordion folding the previous one above it does not
 *  pull it out from under the pointer — as long as it was in view: a row
 *  reached by arrow keys off the edge is left to the cursor-follow.
 *
 *  Only a row the user can see whole is held: one scrolled out of view (say, far
 *  above a long list of sessions) would be held there too, and the new mode
 *  could then show nothing but padding. Such a row is just scrolled into view
 *  on entry instead.
 *
 *  `pinned()` tells callers to leave the scroll alone — a cursor-follow
 *  scrollIntoView during the pin would move the row it holds. */
export function useScopeAnchor(
  treeRef: RefObject<HTMLElement | null>,
  ws: string,
  task: string | null,
  mode: string
): {
  headRef: RefObject<HTMLDivElement | null>
  tailRef: RefObject<HTMLDivElement | null>
  pinned: () => boolean
  onScroll: () => void
} {
  const headRef = useRef<HTMLDivElement>(null)
  const tailRef = useRef<HTMLDivElement>(null)
  const wasShown = useRef(false)
  const lastMode = useRef(mode)
  const lastTask = useRef(task)
  const pinned = useRef(false)
  /** The scrollTop this hook last left the tree at, while pinned: a scroll
   *  event finding anything else came from someone else and ends the pin. */
  const pinnedTop = useRef(0)

  const rowOf = (tree: HTMLElement) =>
    task === null ? null : tree.querySelector<HTMLElement>(`[data-scope="${CSS.escape(task)}"]`)

  /** Scroll height the content needs without the tail: where the tail starts,
   *  in scroll coordinates, plus the tree's bottom padding. Not scrollHeight,
   *  which never drops below the viewport and so hides a tree that fits. */
  const contentEnd = (tree: HTMLElement, tail: HTMLElement) =>
    tail.getBoundingClientRect().top - tree.getBoundingClientRect().top - tree.clientTop + tree.scrollTop +
    parseFloat(getComputedStyle(tree).paddingBottom)

  const setHeight = (el: HTMLElement, px: number) => { el.style.height = `${Math.max(0, px)}px` }

  /** Drops whatever head and tail the scroll position no longer needs —
   *  only what lies out of view, so nothing on screen moves. */
  const trim = (tree: HTMLElement) => {
    const head = headRef.current
    const tail = tailRef.current
    if (!head || !tail) return
    const cut = Math.min(head.offsetHeight, tree.scrollTop)
    if (cut > 0) {
      // The tail sits right after the content, so it shows how far the
      // content moved — whatever the browser's own scroll anchoring did.
      const before = tail.getBoundingClientRect().top
      setHeight(head, head.offsetHeight - cut)
      tree.scrollTop += tail.getBoundingClientRect().top - before
    }
    const needed = tree.scrollTop + tree.clientHeight - contentEnd(tree, tail)
    if (needed < tail.offsetHeight) setHeight(tail, needed)
  }

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

  const apply = (tree: HTMLElement, top: number) => {
    const row = rowOf(tree)
    const head = headRef.current
    const tail = tailRef.current
    if (!row || !head || !tail) return
    setHeight(head, 0)
    setHeight(tail, 0)
    let target = tree.scrollTop + row.getBoundingClientRect().top - top
    // Less above the row than the scroll would take away: pad the start.
    if (target < 0) {
      setHeight(head, -target)
      target = 0
    }
    // Less below than the scroll needs to reach: pad the end.
    setHeight(tail, target + tree.clientHeight - contentEnd(tree, tail))
    tree.scrollTop = target
    // Whatever rounding (or the browser's scroll anchoring) left over.
    const error = row.getBoundingClientRect().top - top
    if (Math.abs(error) >= 0.5) tree.scrollTop += error
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
      trim(tree)
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
    headRef,
    tailRef,
    pinned: () => pinned.current,
    onScroll: () => {
      const tree = treeRef.current
      if (!tree || !shown(tree)) return
      if (pinned.current && Math.abs(tree.scrollTop - pinnedTop.current) < 1) return
      pinned.current = false
      trim(tree)
      record(tree)
    }
  }
}
