/** Which pane of a session is showing — chat/prompt, its config, or its
 *  provisioning/container logs. Local per-session UI state, not persisted. */
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
