import { useEffect, useState } from 'react'
import type { SessionInfo, SessionSnapshot } from '../../../shared/types'
import type { LoopState } from '../../../shared/reviewLoop'
import { loopLine, type LoopLine } from '../../../shared/reviewStatus'
import { alertDialog, confirmDialog } from '../dialog'
import { logErr } from '../log'
import { Dot } from './icons'
import { pollLatest } from '../pollLatest'

/** How often a pane re-reads the loop while it is live. A transition of the
 *  executor's loop also pushes its snapshot (`session.changed`), which re-reads
 *  at once; the interval is for a reviewer's pane, whose own snapshot does not
 *  change when the loop moves on. */
const POLL_MS = 4000

/** The review loop a session is part of (docs/requirements-review-loop.md
 *  §5.2, §5.6): an executor's own, or the executor's that a reviewer serves.
 *  The story of the loop — checks, reviewers, verdicts, delivery — is told in
 *  the chat itself; this is only its current state and the way to stop it. */
export interface LoopView {
  line: LoopLine
  /** The session is a reviewer of someone else's loop. */
  asReviewer: boolean
  round: number | undefined
  stop: () => Promise<void>
}

/** Undefined for a session that is in no loop. */
export function useReviewLoop(
  info: Pick<SessionInfo, 'id' | 'review' | 'reviewOf'>,
  /** The session's snapshot: a new one is a reason to re-read. */
  version: SessionSnapshot | undefined
): LoopView | undefined {
  const executor = info.reviewOf?.executor ?? (info.review ? info.id : undefined)
  const [state, setState] = useState<LoopState | undefined>(undefined)

  useEffect(() => {
    if (!executor) {
      setState(undefined)
      return
    }
    // Reads overlap; `pollLatest` keeps a slow earlier answer from putting an
    // earlier phase (or Stop-loop availability) back over a newer one.
    return pollLatest(() => window.gurt.reviewLoopState(executor), setState, logErr('reviewLoopState'), POLL_MS)
    // `version` is the push that says the loop may have moved.
  }, [executor, version])

  if (!executor || !state) return undefined
  const stop = async (): Promise<void> => {
    if (
      !(await confirmDialog('Stop the review loop? The running turn is cancelled and nothing is committed.', {
        title: 'Stop loop',
        confirmText: 'Stop loop',
        danger: true
      }))
    )
      return
    try {
      await window.gurt.reviewLoopStop(executor)
    } catch (e) {
      await alertDialog(String(e))
    }
  }
  return { line: loopLine(state), asReviewer: executor !== info.id, round: info.reviewOf?.round, stop }
}

/** The loop's place in the session menu: where it stands, and "Stop loop". */
export function LoopMenuSection({ loop, onDone }: { loop: LoopView; onDone: () => void }) {
  const { line } = loop
  return (
    <>
      <div className="menu-status" data-testid="loop-headline-row">
        <Dot tone={line.tone} pulse={line.live} hollow={!line.live} size={7} />
        <div className="menu-status-text">
          <span className="seclabel">
            review loop{loop.asReviewer ? ` · reviewer of round ${loop.round ?? ''}` : ''}
          </span>
          <span data-testid="loop-headline">{line.headline}</span>
        </div>
      </div>
      {line.stoppable && (
        <div
          className="menu-item danger"
          onMouseDown={(e) => {
            e.preventDefault()
            onDone()
            void loop.stop()
          }}
        >
          <span>Stop loop</span>
        </div>
      )}
      <div className="menu-sep" />
    </>
  )
}

/** The menu button's mark: a loop that is running shows it. */
export function LoopDot({ loop }: { loop: LoopView }) {
  if (!loop.line.live) return null
  return <span className="menu-loop-dot" title={loop.line.headline}><Dot tone={loop.line.tone} pulse size={6} /></span>
}
