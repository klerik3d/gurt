import { useState } from 'react'
import type { Tree } from '../../../../shared/types'
import { agentDef } from '../../../../shared/agents'
import { useAgents } from '../../useAgents'
import { AgentTag } from '../tags'

// ---- Agent access (workspace-scoped): default agent + deny-list ----
// The agents themselves stay a global registry (see `ClientsSection`); this is
// which of them a session in *this* workspace may use, and which one it gets
// when it names none — the same "registry is global, use is per-workspace"
// split `EnvironmentsSection`/`ReposSection` don't need because envs/repos
// were workspace-scoped from the start.

export function AgentAccessSection({ tree, ws }: { tree: Tree | null; ws: string | null }) {
  const agents = useAgents()
  const [error, setError] = useState('')
  const wsData = tree?.workspaces.find((w) => w.name === ws)
  const defaultAgent = wsData?.defaultAgent
  const denied = new Set(wsData?.deniedAgents ?? [])
  const entries = Object.entries(agents)

  const pickDefault = async (id: string | undefined) => {
    if (!ws) return
    setError('')
    try {
      await window.gurt.setDefaultAgent(ws, id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const toggleDenied = async (id: string) => {
    if (!ws) return
    setError('')
    const next = denied.has(id) ? [...denied].filter((x) => x !== id) : [...denied, id]
    try {
      await window.gurt.setDeniedAgents(ws, next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <>
      <div className="set-head">
        <div className="set-title-wrap">
          <span className="set-title">Agent access</span>
          <span className="set-count mono">
            {entries.length} client{entries.length === 1 ? '' : 's'}
            {ws ? ` · ${ws}` : ''}
          </span>
        </div>
      </div>
      <div className="set-list">
        {entries.map(([id, a]) => {
          const isDefault = defaultAgent === id
          const isDenied = denied.has(id)
          return (
            <div key={id} className="set-row">
              <span className="set-row-label">{a.label || id}</span>
              <AgentTag kind={a.kind} name={agentDef(a.kind)?.label ?? a.kind} />
              <span className="spacer" />
              <button
                type="button"
                className={`btn-link ${isDefault ? 'active' : ''}`}
                disabled={!ws || isDenied}
                title={isDenied ? 'denied agents cannot be the default' : undefined}
                onClick={() => void pickDefault(isDefault ? undefined : id)}
              >
                {isDefault ? 'default ✓' : 'set default'}
              </button>
              <button
                type="button"
                className={`btn-link ${isDenied ? 'active' : ''}`}
                disabled={!ws || isDefault}
                title={isDefault ? 'the default agent cannot be denied' : undefined}
                onClick={() => void toggleDenied(id)}
              >
                {isDenied ? 'denied' : 'deny'}
              </button>
            </div>
          )
        })}
        {entries.length === 0 && (
          <div className="tp-dashed">no clients configured yet — add one in Settings → Clients</div>
        )}
      </div>
      {error && <div className="error">{error}</div>}
    </>
  )
}
