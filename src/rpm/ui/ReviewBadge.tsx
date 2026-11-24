// ReviewBadge (t3v2 §3.3): on the Review tab's label, the number of findings
// that wait for you while the run calls you. Nothing otherwise.
import type { RpmState } from '../core'
import { useRpm } from './useRpm'

/** The count the badge shows; 0 = no badge. */
export function badgeCount(state: RpmState | undefined): number {
  if (!state?.live || state.status.phase !== 'called') return 0
  return state.status.items.length
}

export function ReviewBadge({ executor }: { executor: string }) {
  const { state } = useRpm(executor)
  const n = badgeCount(state)
  // TODO(rpm): a call without findings (check failed, executor failed) has no count, so no badge;
  // the notification carries it.
  return n > 0 ? <span className="tab-badge" title={`${n} waiting for you`}>{n}</span> : null
}
