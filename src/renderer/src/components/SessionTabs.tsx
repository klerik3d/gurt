import { usePreference, z } from '../persisted'
/** Which pane of a session is showing — chat/prompt, its config, or its
 *  provisioning/container logs. Persisted per-session UI state. */
export type SessionTab = 'chat' | 'config' | 'logs'

const TABS: { id: SessionTab; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'config', label: 'Config' },
  { id: 'logs', label: 'Logs' }
]

export function TabBar({
  active,
  onChange
}: {
  active: SessionTab
  onChange: (t: SessionTab) => void
}) {
  return (
    <div className="tab-bar">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`tab-btn ${active === t.id ? 'active' : ''}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function useSessionTab(sessionId: string): [SessionTab, (tab: SessionTab) => void] {
  const [tabs, setTabs] = usePreference<Record<string, SessionTab>>('sessionTabs', {}, z.record(z.string(), z.enum(['chat', 'config', 'logs'])))
  return [tabs[sessionId] ?? 'chat', (tab) => setTabs((previous) => ({ ...previous, [sessionId]: tab }))]
}
