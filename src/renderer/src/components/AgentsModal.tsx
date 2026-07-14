import { useEffect, useState } from 'react'
import type { AgentsFile } from '../../../shared/types'
import { AGENT_DEFS } from '../../../shared/agents'
import { Modal } from './Modal'

export function AgentsModal({ onClose }: { onClose: () => void }) {
  const [agents, setAgents] = useState<AgentsFile | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    window.gurt.getAgents().then(setAgents).catch((e) => setError(String(e)))
  }, [])

  const save = async () => {
    if (!agents) return
    try {
      await window.gurt.setAgents(agents)
      onClose()
    } catch (e) {
      setError(String(e))
    }
  }

  const patch = (id: string, p: Partial<AgentsFile[string]>) =>
    setAgents((prev) => prev && { ...prev, [id]: { ...prev[id], ...p } })

  return (
    <Modal title="Agents" onClose={onClose}>
      {agents && (
        <div className="form">
          {AGENT_DEFS.map((def) => {
            const cfg = agents[def.id]
            if (!cfg) return null
            return (
              <div key={def.id} className="agent-block">
                <label className="row">
                  <input
                    type="checkbox"
                    checked={cfg.enabled}
                    onChange={(e) => patch(def.id, { enabled: e.target.checked })}
                  />
                  {def.label}
                </label>
                {cfg.enabled && (
                  <div className="agent-fields">
                    <label>
                      secret env var
                      <input
                        value={cfg.secretEnv ?? def.secretEnv}
                        onChange={(e) => patch(def.id, { secretEnv: e.target.value })}
                      />
                    </label>
                    <label>
                      secret
                      <input
                        type="password"
                        placeholder="token / api key"
                        value={cfg.secret}
                        onChange={(e) => patch(def.id, { secret: e.target.value })}
                      />
                    </label>
                  </div>
                )}
              </div>
            )
          })}
          {error && <div className="error">{error}</div>}
          <button onClick={save}>Save</button>
        </div>
      )}
    </Modal>
  )
}
