import { useEffect, useState } from 'react'
import type { AgentInstance, AgentsFile } from '../../../shared/types'
import type { CredentialEntry } from '../../../shared/credentials'
import { agentCredentials } from '../../../shared/credentials'
import { AGENT_DEFS, agentDef } from '../../../shared/agents'
import { refreshAgents } from '../useAgents'
import { Modal } from './Modal'

/** Temp-keyed rows are new instances whose id is minted from the label on save. */
const isTemp = (id: string) => id.startsWith('__new__:')

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

function uniqueId(label: string, kind: string, taken: Set<string>): string {
  const base = slug(label) || kind
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  return id
}

/** Serialize/parse the extra-env map as `KEY=VALUE` lines for the textarea. */
const envToText = (env?: Record<string, string>) =>
  Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n')

function textToEnv(text: string): Record<string, string> | undefined {
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
  }
  return Object.keys(env).length ? env : undefined
}

export function AgentsModal({ onClose }: { onClose: () => void }) {
  const [agents, setAgents] = useState<AgentsFile | null>(null)
  const [credentials, setCredentials] = useState<CredentialEntry[]>([])
  /** Raw `KEY=VALUE` text per row, so partial lines don't flicker while typing. */
  const [envText, setEnvText] = useState<Record<string, string>>({})
  const [error, setError] = useState('')

  useEffect(() => {
    window.gurt
      .getAgents()
      .then((a) => {
        setAgents(a)
        setEnvText(Object.fromEntries(Object.entries(a).map(([id, i]) => [id, envToText(i.env)])))
      })
      .catch((e) => setError(String(e)))
    window.gurt.getCredentials().then((f) => setCredentials(f.credentials)).catch(() => {})
  }, [])

  const tokens = agentCredentials(credentials)

  const patch = (id: string, p: Partial<AgentInstance>) =>
    setAgents((prev) => prev && { ...prev, [id]: { ...prev[id], ...p } })

  const remove = (id: string) =>
    setAgents((prev) => {
      if (!prev) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })

  const add = () => {
    const key = `__new__:${crypto.randomUUID()}`
    const inst: AgentInstance = { kind: 'claude-code', label: '' }
    setAgents((prev) => ({ ...(prev ?? {}), [key]: inst }))
    setEnvText((prev) => ({ ...prev, [key]: '' }))
  }

  const save = async () => {
    if (!agents) return
    // Mint stable ids for new rows from their label; drop blank rows.
    const taken = new Set(Object.keys(agents).filter((id) => !isTemp(id)))
    const out: AgentsFile = {}
    for (const [id, a] of Object.entries(agents)) {
      const inst: AgentInstance = { ...a, env: textToEnv(envText[id] ?? '') }
      if (isTemp(id)) {
        if (!inst.label.trim()) continue
        const finalId = uniqueId(inst.label, inst.kind, taken)
        taken.add(finalId)
        out[finalId] = inst
      } else {
        out[id] = inst
      }
    }
    try {
      await window.gurt.setAgents(out)
      refreshAgents()
      onClose()
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <Modal title="Agents" onClose={onClose}>
      {agents && (
        <div className="form">
          {Object.entries(agents).map(([id, cfg]) => {
            const def = agentDef(cfg.kind)
            return (
              <div key={id} className="agent-block">
                <div className="row">
                  <input
                    className="agent-label"
                    placeholder="name (e.g. claude code work)"
                    value={cfg.label}
                    onChange={(e) => patch(id, { label: e.target.value })}
                  />
                  <select value={cfg.kind} onChange={(e) => patch(id, { kind: e.target.value })}>
                    {AGENT_DEFS.map((d) => (
                      <option key={d.id} value={d.id}>{d.label}</option>
                    ))}
                  </select>
                  <button className="link" onClick={() => remove(id)}>remove</button>
                </div>
                <div className="agent-fields">
                  <label>
                    credential
                    <select
                      value={cfg.credentialId ?? ''}
                      onChange={(e) => patch(id, { credentialId: e.target.value || undefined })}
                    >
                      <option value="">none — adapter reports its own auth error</option>
                      {tokens.map((c) => (
                        <option key={c.id} value={c.id}>{c.label}</option>
                      ))}
                    </select>
                  </label>
                  {tokens.length === 0 && (
                    <div className="hint">no agent tokens yet — add one in 🔑 Credentials</div>
                  )}
                  <label>
                    secret env var
                    <input
                      value={cfg.secretEnv ?? def?.secretEnv ?? ''}
                      placeholder={def?.secretEnv}
                      onChange={(e) => patch(id, { secretEnv: e.target.value })}
                    />
                  </label>
                  <label>
                    extra env (KEY=VALUE per line)
                    <textarea
                      rows={2}
                      placeholder="ANTHROPIC_BASE_URL=http://host.docker.internal:1234"
                      value={envText[id] ?? ''}
                      onChange={(e) =>
                        setEnvText((prev) => ({ ...prev, [id]: e.target.value }))
                      }
                    />
                  </label>
                </div>
              </div>
            )
          })}
          {Object.keys(agents).length === 0 && (
            <div className="hint">no agents yet — add one and link its token</div>
          )}
          <button className="link" onClick={add}>+ add agent</button>
          {error && <div className="error">{error}</div>}
          <button onClick={save}>Save</button>
        </div>
      )}
    </Modal>
  )
}
