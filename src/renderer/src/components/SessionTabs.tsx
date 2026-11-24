import { usePreference, z } from '../persisted'
import { ReviewBadge } from '../../../rpm/ui'
import { sessionRole, writeRepos, type SessionInfo } from '../../../shared/types'

/** The executor whose Review tab a session shows (t3v2 §3.3: executors only,
 *  drafts too) — and only once it has a repository mounted for write: there is
 *  nothing to review without one. Undefined = the tab shows, disabled. */
export const reviewOf = (info: Pick<SessionInfo, 'id' | 'role' | 'repos' | 'repoModes'>): string | undefined =>
  sessionRole(info) === 'executor' && writeRepos(info).length > 0 ? info.id : undefined

/** Which pane of a session is showing — chat/prompt, its config, its review
 *  (an executor's only, t3v2 §3.3), or its provisioning/container logs.
 *  Persisted per-session UI state. */
export type SessionTab = 'chat' | 'review' | 'config' | 'logs'

const TABS: { id: SessionTab; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'config', label: 'Config' },
  { id: 'review', label: 'Review' },
  { id: 'logs', label: 'Logs' }
]

const REVIEW_OFF = 'Review needs an executor with a repository mounted for write (Config tab)'

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
