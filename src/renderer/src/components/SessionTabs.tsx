import { usePreference, z } from '../persisted'
import { ReviewBadge } from '../../../rpm/ui'
import { sessionRole, type SessionInfo } from '../../../shared/types'

/** The executor whose Review tab a session shows (t3v2 §3.3: executors only, drafts too). */
export const reviewOf = (info: Pick<SessionInfo, 'id' | 'role' | 'repos'>): string | undefined =>
  sessionRole(info) === 'executor' ? info.id : undefined

/** Which pane of a session is showing — chat/prompt, its review (an
 *  executor's only, t3v2 §3.3), its config, or its provisioning/container
 *  logs. Persisted per-session UI state. */
export type SessionTab = 'chat' | 'review' | 'config' | 'logs'

const TABS: { id: SessionTab; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'review', label: 'Review' },
  { id: 'config', label: 'Config' },
  { id: 'logs', label: 'Logs' }
]

export function TabBar({
  active,
  onChange,
  review
}: {
  active: SessionTab
  onChange: (t: SessionTab) => void
  /** The executor whose Review tab to show; none = no Review tab. */
  review?: string | undefined
}) {
  return (
    <div className="tab-bar">
      {TABS.filter((t) => t.id !== 'review' || review).map((t) => (
        <button
          key={t.id}
          type="button"
          className={`tab-btn ${active === t.id ? 'active' : ''}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.id === 'review' && review && <ReviewBadge executor={review} />}
        </button>
      ))}
    </div>
  )
}

/** `review` = whether this session has a Review tab; a remembered `review`
 *  of a session that no longer has one reads as `chat`. */
export function useSessionTab(sessionId: string, review = false): [SessionTab, (tab: SessionTab) => void] {
  const [tabs, setTabs] = usePreference<Record<string, SessionTab>>('sessionTabs', {}, z.record(z.string(), z.enum(['chat', 'review', 'config', 'logs'])))
  const tab = tabs[sessionId] ?? 'chat'
  return [tab === 'review' && !review ? 'chat' : tab, (next) => setTabs((previous) => ({ ...previous, [sessionId]: next }))]
}
