// The review settings (t2v3 A): one column of standard fields, each
// explained behind the label's "i". Before the first run it is the whole tab;
// after it, the same block folds under the findings and still applies at once.
import type { ReactNode } from 'react'
import type { RpmConfig, Severity } from '../core'
import { useRpmHost } from './host'
import { SEVERITIES } from './labels'

export const INFO = {
  review:
    "After each executor turn that changes code, gurt runs the repository's check and a fresh reviewer reads the change. A pass marks the reviewed state; nothing is committed or shipped.",
  reviewer:
    "The client the reviewer runs on — another one than the executor's by default: a reviewer from the same family tends to favour its own output. Only clients that receive gurt's tools can review.",
  threshold:
    'Findings at or above it go to the executor and must end closed, rejected or deferred. The rest are listed and do not hold the review.',
  attempts: 'How many fixes of one finding the reviewer may turn down before it comes to you.',
  reviews:
    'Reviews in a row without you; after that the loop asks you whether to go on. Raising it while the loop waits on this lets it go on; any other setting changes only the steps to come.'
}

/** Under the switch while it is off — what "off" means here. */
export const OFF_HINT = "Review is off: the executor's turns are not reviewed. Turn it on to change the settings below."

const ATTEMPTS = [1, 2, 3, 4, 5]
const REVIEWS = [1, 2, 3, 5, 10]

export function Settings({
  executor,
  config,
  onPatch
}: {
  executor: string
  config: RpmConfig
  onPatch: (patch: Partial<RpmConfig>) => void
}) {
  const { InfoDot, ReviewerFields, reviewerProblem } = useRpmHost()
  const problem = reviewerProblem(config.reviewer.agent)
  const label = (text: string, info: string): ReactNode => (
    <div className="seclabel-row">
      <span className="seclabel">{text}</span>
      <InfoDot text={info} />
    </div>
  )
  const chips = <T extends string | number | boolean>(
    values: readonly T[],
    current: T,
    name: (v: T) => string,
    pick: (v: T) => void,
    blocked?: (v: T) => string | undefined
  ): ReactNode => (
    <div className="chip-row">
      {values.map((v) => (
        <button
          key={String(v)}
          type="button"
          className={`chip-btn ${v === current ? 'on' : ''}`}
          disabled={v !== current && !!blocked?.(v)}
          title={v !== current ? blocked?.(v) : undefined}
          onClick={() => v !== current && pick(v)}
        >
          {name(v)}
        </button>
      ))}
    </div>
  )
  return (
    <div className="rpm-col">
      <div className="ns-section">
        {label('Review', INFO.review)}
        {/* No review without a reviewer that can submit one (t2v3 A). */}
        {chips([false, true], config.enabled, (v) => (v ? 'on' : 'off'), (enabled) => onPatch({ enabled }), (v) => (v ? problem : undefined))}
        {!config.enabled && <div className="rpm-hint faint">{OFF_HINT}</div>}
      </div>
      {/* Off: nothing below applies to anything, so nothing below takes a
          pick — turning the review on is the way in (a disabled fieldset
          disables every control inside it). Except the reviewer while it is
          what refuses "on" (gone, denied, no gurt tools): picking another one
          is the only way to turn the review on, so it stays open then. */}
      <fieldset className="rpm-fields" disabled={!config.enabled && !problem}>
        <ReviewerFields
          executor={executor}
          value={config.reviewer}
          info={INFO.reviewer}
          problem={problem}
          onChange={(reviewer) => onPatch({ reviewer })}
        />
      </fieldset>
      <fieldset className="rpm-fields" disabled={!config.enabled}>
      <div className="ns-section">
        {label('Threshold', INFO.threshold)}
        {chips<Severity>(SEVERITIES, config.threshold, String, (threshold) => onPatch({ threshold }))}
      </div>
      <div className="ns-section">
        {label('Attempts', INFO.attempts)}
        {chips(ATTEMPTS, config.attempts, String, (attempts) => onPatch({ attempts }))}
      </div>
      <div className="ns-section">
        {label('Reviews', INFO.reviews)}
        {chips(REVIEWS, config.reviews, String, (reviews) => onPatch({ reviews }))}
      </div>
      </fieldset>
    </div>
  )
}

/** "sol-6.1 · major · 2 · 3" — the folded Settings line (t2v3 B). */
export function settingsSummary(c: RpmConfig): string {
  const model = Object.values(c.reviewer.options).find((v): v is string => typeof v === 'string')
  return [c.enabled ? null : 'off', model ?? (c.reviewer.agent || 'no reviewer'), c.threshold, c.attempts, c.reviews]
    .filter((x) => x !== null)
    .join(' · ')
}
