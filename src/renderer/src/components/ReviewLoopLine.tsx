import { useEffect, useState } from 'react'
import type { SessionInfo, SessionSnapshot } from '../../../shared/types'
import type { LoopState } from '../../../shared/reviewLoop'
import { loopLine } from '../../../shared/reviewStatus'
import { alertDialog, confirmDialog } from '../dialog'
import { logErr } from '../log'
import { Dot } from './icons'
import { run } from '../async'
import { pollLatest } from '../pollLatest'

/** How often a pane re-reads the loop while it is live. A transition of the
 *  executor's loop also pushes its snapshot (`session.changed`), which re-reads
 *  at once; the interval is for a reviewer's pane, whose own snapshot does not
 *  change when the loop moves on. */
const POLL_MS = 4000

/**
 * The loop status line (docs/requirements-review-loop.md §5.2, §5.6): for a
 * loop-enabled executor and for its reviewers — the phase, "round r of N", the
 * findings count and, once it has ended, the reason and what is still
 * unresolved — and the "Stop loop" button. Renders nothing for a session that
 * is in no loop.
 */
export function ReviewLoopLine({
  info,
  version
}: {
  info: SessionInfo
  /** The session's snapshot: a new one is a reason to re-read. */
  version: SessionSnapshot | undefined
}) {
  const executor = info.reviewOf?.executor ?? (info.review ? info.id : undefined)
  const [state, setState] = useState<LoopState | undefined>(undefined)
  const [stopping, setStopping] = useState(false)

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

  if (!executor || !state) return null
  const line = loopLine(state)
  const asReviewer = executor !== info.id
  const stop = async (): Promise<void> => {
    if (
      !(await confirmDialog('Stop the review loop? The running turn is cancelled and nothing is committed.', {
        title: 'Stop loop',
        confirmText: 'Stop loop',
        danger: true
      }))
    )
      return
    setStopping(true)
    try {
      await window.gurt.reviewLoopStop(executor)
    } catch (e) {
      await alertDialog(String(e))
    } finally {
      setStopping(false)
    }
  }
  return (
    <div className="rv-line" data-phase={state.phase} data-live={line.live ? 'true' : 'false'}>
      <div className="rv-line-head">
        <Dot tone={line.tone} pulse={line.live} hollow={!line.live} size={7} />
        <span className="rv-line-title">review loop{asReviewer ? ` · reviewer of round ${info.reviewOf?.round ?? ''}` : ''}</span>
        <span className="rv-line-text" data-testid="loop-headline">{line.headline}</span>
        <span className="spacer" />
        {line.stoppable && (
          <button type="button" className="btn btn-sm" disabled={stopping} onClick={run(stop)}>
            Stop loop
          </button>
        )}
      </div>
      {line.detail && <div className="rv-line-detail">{line.detail}</div>}
      {line.findings.length > 0 && (
        <ul className="rv-findings">
          {line.findings.map(({ ref, finding }) => (
            <li key={ref} title={finding.suggestion ?? finding.evidence ?? undefined}>
              <span className="mono">{ref}</span>
              <span className={`rv-sev rv-sev-${finding.severity}`}>{finding.severity}</span>
              <span className="mono faint">
                {finding.file}
                {finding.line ? `:${finding.line}` : ''}
              </span>
              <span>{finding.claim}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
