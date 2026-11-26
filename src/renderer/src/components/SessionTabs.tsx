import { usePreference, z } from '../persisted'
import { ReviewBadge, runOfStepKey } from '../../../rpm/ui'
import { sessionRole, writeRepos, type SessionInfo } from '../../../shared/types'

type ReviewTarget = Pick<SessionInfo, 'id' | 'role' | 'repos' | 'repoModes' | 'reviewerOf'>

/** The executor whose Review tab a session shows (t3v2 §3.3). An executor's own
 *  (drafts too) once it has a repository mounted for write — there is nothing
 *  to review without one; and an RPM reviewer's, which shows the loop it is a
 *  review of — one loop, seen from either side, with the same controls.
 *  Undefined = the tab shows, disabled. */
export const reviewOf = (info: ReviewTarget): string | undefined => {
  const role = sessionRole(info)
  if (role === 'reviewer') return info.reviewerOf?.executor
  return role === 'executor' && writeRepos(info).length > 0 ? info.id : undefined
}

/** The run a reviewer's Review tab opens on — the one it reviews, not the
 *  loop's last (a later run may have started since). `ReviewTab`'s
 *  `initialRun`: a starting point, not a focus, so a jump or a pick moves the
 *  tab away from it for good. */
export const reviewerRun = (info: ReviewTarget | undefined): number | undefined => {
  const key = info?.reviewerOf?.key
  return key === undefined ? undefined : runOfStepKey(key)
}

/** Which pane of a session is showing — chat/prompt, its config, its review
 *  (an executor's or an RPM reviewer's, t3v2 §3.3), or its provisioning/container logs.
 *  Persisted per-session UI state. */
export type SessionTab = 'chat' | 'review' | 'config' | 'logs'

const TABS: { id: SessionTab; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'config', label: 'Config' },
  { id: 'review', label: 'Review' },
  { id: 'logs', label: 'Logs' }
]

const REVIEW_OFF = 'Review needs an executor with a repository mounted for write (Config tab), or an RPM reviewer'

export function TabBar({
  active,
  onChange,
  review
}: {
  active: SessionTab
  onChange: (t: SessionTab) => void
  /** The executor whose Review tab this is; none = the tab is there, disabled. */
  review?: string | undefined
}) {
  return (
    <div className="tab-bar">
      {TABS.map((t) => {
        const off = t.id === 'review' && !review
        return (
          <button
            key={t.id}
            type="button"
            className={`tab-btn ${active === t.id ? 'active' : ''}`}
            disabled={off}
            title={off ? REVIEW_OFF : undefined}
            onClick={() => onChange(t.id)}
          >
            {t.label}
            {t.id === 'review' && review && <ReviewBadge executor={review} />}
          </button>
        )
      })}
    </div>
  )
}

/** `review` = whether this session's Review tab is enabled; a remembered
 *  `review` of a session whose tab is disabled reads as `chat`. */
export function useSessionTab(sessionId: string, review = false): [SessionTab, (tab: SessionTab) => void] {
  const [tabs, setTabs] = usePreference<Record<string, SessionTab>>('sessionTabs', {}, z.record(z.string(), z.enum(['chat', 'review', 'config', 'logs'])))
  const tab = tabs[sessionId] ?? 'chat'
  return [tab === 'review' && !review ? 'chat' : tab, (next) => setTabs((previous) => ({ ...previous, [sessionId]: next }))]
}
