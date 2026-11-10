// How a review loop reads in the session pane (docs/requirements-review-loop.md
// §5.2, §7): the phase, the round, the findings and — for an end — the reason,
// as plain data. Pure, so the pane draws it and a test pins the wording
// (scripts/review-block.test.mjs); the loop itself is `loopStep`'s.
import type { DeliveredStep, EndReason, LoopEnd, LoopPhase, LoopState } from './reviewLoop'
import { loopIsLive } from './reviewLoop'
import type { ReviewFinding } from './types'
import { findingRef } from './types'

/** Why a loop ended `needs-you`, in the sentence the pane and the
 *  notification both can use. Exhaustive on purpose: a new reason is a compile
 *  error here until it has words. */
export const END_REASON_TEXT: Record<EndReason, string> = {
  'no-progress': 'the executor’s fix changed nothing',
  oscillation: 'the same finding came back after being fixed',
  disagreement: 'the executor declined a blocker in two rounds',
  'executor-blocked': 'the executor reported it is blocked',
  'executor-incomplete': 'the executor ended a turn without a result',
  'executor-error': 'the executor’s turn failed',
  'check-red': 'the check kept failing',
  'missing-proposal': 'the executor gave no commit text for its changes',
  'reviewer-unavailable': 'the reviewer could not run',
  'tree-moved': 'the working tree changed during the review',
  'time-cap': 'the loop ran out of time',
  'permission-wait': 'a permission request waited too long',
  'delivery-failed': 'a delivery step failed',
  'taken-over': 'you took over the session',
  cancelled: 'the loop was stopped'
}

export type LoopTone = 'accent' | 'green' | 'yellow' | 'red' | 'faint'

/** What the loop line shows. `findings` are the ones to list under it: the
 *  open set while a fix is due, the unresolved ones once it has ended. */
export interface LoopLine {
  live: boolean
  tone: LoopTone
  /** "reviewing · round 1 of 2" */
  headline: string
  /** The end's reason or error, the delivered steps — a second line. */
  detail?: string | undefined
  findings: { ref: string; finding: ReviewFinding }[]
  /** "Stop loop" is offered: live and not delivering (§5.6). */
  stoppable: boolean
}

const PHASE_TEXT: Record<Exclude<LoopPhase, 'ended'>, string> = {
  dormant: 'implementing',
  checking: 'running the check',
  proposing: 'waiting for commit texts',
  reviewing: 'reviewing',
  fixing: 'fixing',
  delivering: 'delivering'
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** "committed a1b2c3d in api · pushed gurt/x in api" */
export function deliveredText(steps: readonly DeliveredStep[]): string {
  const verb = { commit: 'committed', push: 'pushed', pr: 'opened PR', merge: 'merged into main' } as const
  return steps.map((d) => `${verb[d.step]} ${d.ref} in ${d.repo}`).join(' · ')
}

function endLine(s: LoopState, end: LoopEnd): Omit<LoopLine, 'live' | 'stoppable'> {
  const rounds = plural(s.round, 'round')
  const refs = (open: ReviewFinding[]): LoopLine['findings'] =>
    open.map((f) => ({ ref: findingRef(s.round, f.id), finding: f }))
  switch (end.outcome) {
    case 'ready': {
      const notes = end.notes.length ? `${plural(end.notes.length, 'minor note')}` : ''
      return {
        tone: 'green',
        headline: `clean after ${rounds}`,
        detail: [end.delivered.length ? deliveredText(end.delivered) : 'nothing delivered — ready for you', notes]
          .filter(Boolean)
          .join(' · '),
        findings: []
      }
    }
    case 'exhausted':
      return {
        tone: 'yellow',
        headline: `ended — ${rounds} used, ${plural(end.open.length, 'finding')} unresolved`,
        findings: refs(end.open)
      }
    case 'needs-you':
      return {
        tone: end.reason === 'taken-over' || end.reason === 'cancelled' ? 'faint' : 'yellow',
        headline: `ended — ${END_REASON_TEXT[end.reason]}`,
        detail: [end.detail, end.delivered.length ? deliveredText(end.delivered) : '']
          .filter(Boolean)
          .join(' · ') || undefined,
        findings: refs(end.open)
      }
    case 'failed':
      return {
        tone: 'red',
        headline: 'failed',
        detail: [end.error, end.delivered.length ? deliveredText(end.delivered) : ''].filter(Boolean).join(' · '),
        findings: []
      }
  }
}

/** The loop line for an executor's state (§5.2): the phase, "round r of N"
 *  (reviewers created so far; before the first review it says which is next),
 *  the open findings while a fix is due, and an end's reason with what is still
 *  unresolved. A dormant loop with no deadline is armed but has not started a
 *  turn. */
export function loopLine(s: LoopState): LoopLine {
  const live = loopIsLive(s)
  const max = s.config.maxRounds
  if (s.phase === 'ended' && s.end) return { live, stoppable: false, ...endLine(s, s.end) }
  if (s.phase === 'ended') return { live, stoppable: false, tone: 'faint', headline: 'ended', findings: [] }
  if (s.phase === 'dormant' && !live)
    return { live, stoppable: false, tone: 'faint', headline: `armed · up to ${plural(max, 'round')}`, findings: [] }
  const where =
    s.phase === 'reviewing' ? `round ${s.round} of ${max}` : s.round === 0 ? `before round 1 of ${max}` : `after round ${s.round} of ${max}`
  const fixing = s.phase === 'fixing' && s.open.length > 0
  const findings = fixing ? s.open.map((f) => ({ ref: findingRef(s.round, f.id), finding: f })) : []
  return {
    live,
    stoppable: s.phase !== 'delivering',
    tone: 'accent',
    headline: `${PHASE_TEXT[s.phase]} · ${where}${fixing ? ` · ${plural(s.open.length, 'finding')}` : ''}`,
    ...(s.phase === 'delivering' && s.delivered.length ? { detail: deliveredText(s.delivered) } : {}),
    findings
  }
}
