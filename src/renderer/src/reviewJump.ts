// "Open this executor's Review tab, focused" — asked from elsewhere (an
// F-number in a chat line, the tab badge, a notification: rpm/ui
// `openReview`, t2v3 D), carried out by that session's Chat once it is
// mounted: it shows the Review tab and hands the focus to `ReviewTab`.
// `executor` is the session whose pane carries it out: the executor, or one
// of its reviewers when the jump was asked from that reviewer's own pane.
import { useSyncExternalStore } from 'react'
import type { ReviewFocus } from '../../rpm/ui'

export interface ReviewJump extends ReviewFocus {
  executor: string
  /** Distinguishes two jumps to the same place. */
  n: number
}

let pending: ReviewJump | undefined
let n = 0
const listeners = new Set<() => void>()
const notify = (): void => listeners.forEach((fn) => fn())

export function requestReviewJump(executor: string, focus: ReviewFocus): void {
  pending = { ...focus, executor, n: ++n }
  notify()
}

/** The jump done (or given up): it is not repeated on the next render. */
export function clearReviewJump(jump: ReviewJump): void {
  if (pending?.n !== jump.n) return
  pending = undefined
  notify()
}

/** The jump waiting for this executor, if any. */
export function useReviewJump(executor: string): ReviewJump | undefined {
  const jump = useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => pending
  )
  return jump?.executor === executor ? jump : undefined
}
