import { useEffect, useState } from 'react'
import type { AgentsFile, EnvRef, Tree } from '../../../shared/types'
import { AGENT_DEFS } from '../../../shared/agents'
import type { Selection } from '../App'
import { Modal } from './Modal'
import { ReposModal } from './ReposModal'

type AddForm =
  | { type: 'workspace' }
  | { type: 'repos'; ws: string }
  | { type: 'task'; ws: string }
  | { type: 'env'; ws: string; task: string }
  | null

const STATUS_ICON: Record<string, string> = {
  stopped: '○',
  starting: '◐',
  running: '●',
  error: '✕'
}

export function Sidebar({
  tree,
  selection,
  onSelectEnv,
  onSelectSession,
  onOpenAgents
}: {
  tree: Tree | null
  selection: Selection
  onSelectEnv: (ref: EnvRef) => void
  onSelectSession: (id: string) => void
  onOpenAgents: () => void
}) {
  const [form, setForm] = useState<AddForm>(null)
  const [error, setError] = useState('')

  const act = async (fn: () => Promise<unknown>) => {
    setError('')
    try {
      await fn()
      setForm(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="logo">gurt</span>
        <span className="spacer" />
        <button className="icon-btn" title="agents" onClick={onOpenAgents}>⚙</button>
        <button className="icon-btn" title="new workspace" onClick={() => setForm({ type: 'workspace' })}>+</button>
      </div>

      <div className="tree">
        {tree?.workspaces.map((ws) => (
          <div key={ws.name} className="ws">
            <div className="node ws-node">
              <span className="node-label">{ws.name}</span>
              <span className="spacer" />
              <button className="icon-btn" title="repos" onClick={() => setForm({ type: 'repos', ws: ws.name })}>repos</button>
              <button className="icon-btn" title="new task" onClick={() => setForm({ type: 'task', ws: ws.name })}>⊕ task</button>
            </div>
            {ws.tasks.map((task) => (
              <div key={task.name} className="task">
                <div className="node task-node">
                  <span className="node-label">{task.name}</span>
                  <span className="spacer" />
                  <button
                    className="icon-btn"
                    title="add environment"
                    onClick={() => setForm({ type: 'env', ws: ws.name, task: task.name })}
                  >
                    +
                  </button>
                  <button
                    className="icon-btn"
                    title="delete task"
                    onClick={() => {
                      if (window.confirm(`Delete task "${task.name}" with all its environments, clones and sessions?`))
                        window.gurt.removeTask(ws.name, task.name).catch((e) => alert(String(e)))
                    }}
                  >
                    🗑
                  </button>
                </div>
                {task.envs.map((env) => {
                  const ref: EnvRef = { workspace: ws.name, task: task.name, repo: env.repo }
                  const selected =
                    selection?.type === 'env' &&
                    selection.ref.workspace === ws.name &&
                    selection.ref.task === task.name &&
                    selection.ref.repo === env.repo
                  return (
                    <div key={env.repo} className="env">
                      <div className={`node env-node ${selected ? 'selected' : ''}`}>
                        <span className={`status status-${env.status}`}>{STATUS_ICON[env.status]}</span>
                        <span className="node-label clickable" onClick={() => onSelectEnv(ref)}>
                          {env.repo}
                        </span>
                        <span className="agent-badge">{env.agent ?? 'claude-code'}</span>
                        <span className="spacer" />
                        {(env.status === 'stopped' || env.status === 'error') && (
                          <>
                            <button
                              className="icon-btn"
                              title="start environment"
                              onClick={() => {
                                onSelectEnv(ref)
                                window.gurt.startEnv(ref).catch(() => {})
                              }}
                            >
                              ▶
                            </button>
                            <button
                              className="icon-btn"
                              title="delete environment"
                              onClick={() => {
                                if (window.confirm(`Delete env "${env.repo}" with its container, clone and sessions? Uncommitted work will be lost.`))
                                  window.gurt.removeEnv(ref).catch((e) => alert(String(e)))
                              }}
                            >
                              🗑
                            </button>
                          </>
                        )}
                        {env.status === 'running' && (
                          <>
                            <button
                              className="icon-btn"
                              title="new session"
                              onClick={() =>
                                window.gurt.createSession(ref).then((s) => onSelectSession(s.id)).catch((e) => alert(String(e)))
                              }
                            >
                              +
                            </button>
                            <button
                              className="icon-btn"
                              title="stop environment"
                              onClick={() => window.gurt.stopEnv(ref).catch((e) => alert(String(e)))}
                            >
                              ■
                            </button>
                          </>
                        )}
                      </div>
                      {env.sessions.map((s) => (
                        <div
                          key={s.id}
                          className={`node session-node clickable ${
                            selection?.type === 'session' && selection.id === s.id ? 'selected' : ''
                          }`}
                          onClick={() => onSelectSession(s.id)}
                        >
                          {s.title}
                        </div>
                      ))}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        ))}
        {tree && tree.workspaces.length === 0 && (
          <div className="hint">no workspaces yet — create one with “+” above</div>
        )}
      </div>

      {form?.type === 'workspace' && (
        <NameModal
          title="New workspace"
          error={error}
          onClose={() => setForm(null)}
          onSubmit={(name) => act(() => window.gurt.createWorkspace(name))}
        />
      )}
      {form?.type === 'task' && (
        <NameModal
          title={`New task in ${form.ws}`}
          error={error}
          onClose={() => setForm(null)}
          onSubmit={(name) => act(() => window.gurt.createTask(form.ws, name))}
        />
      )}
      {form?.type === 'repos' && tree && (
        <ReposModal tree={tree} ws={form.ws} onClose={() => setForm(null)} />
      )}
      {form?.type === 'env' && tree && (
        <EnvModal
          tree={tree}
          ws={form.ws}
          task={form.task}
          error={error}
          onClose={() => setForm(null)}
          onSubmit={(repo, agent) =>
            act(() => window.gurt.addEnv({ workspace: form.ws, task: form.task, repo }, agent))
          }
        />
      )}
    </aside>
  )
}

function NameModal({
  title,
  error,
  onClose,
  onSubmit
}: {
  title: string
  error: string
  onClose: () => void
  onSubmit: (name: string) => void
}) {
  const [name, setName] = useState('')
  return (
    <Modal title={title} onClose={onClose}>
      <div className="form">
        <input
          autoFocus
          placeholder="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && name.trim() && onSubmit(name.trim())}
        />
        {error && <div className="error">{error}</div>}
        <button disabled={!name.trim()} onClick={() => onSubmit(name.trim())}>Create</button>
      </div>
    </Modal>
  )
}

function EnvModal({
  tree,
  ws,
  task,
  error,
  onClose,
  onSubmit
}: {
  tree: Tree
  ws: string
  task: string
  error: string
  onClose: () => void
  onSubmit: (repo: string, agent: string) => void
}) {
  const [agents, setAgents] = useState<AgentsFile | null>(null)
  const [agent, setAgent] = useState('')

  useEffect(() => {
    window.gurt.getAgents().then((a) => {
      setAgents(a)
      const first = AGENT_DEFS.find((d) => a[d.id]?.enabled)
      if (first) setAgent(first.id)
    })
  }, [])

  const wsData = tree.workspaces.find((w) => w.name === ws)
  const taskData = wsData?.tasks.find((t) => t.name === task)
  const used = new Set(taskData?.envs.map((e) => e.repo) ?? [])
  const available = (wsData?.repos ?? []).filter((r) => !used.has(r.name))
  const enabledAgents = AGENT_DEFS.filter((d) => agents?.[d.id]?.enabled)

  return (
    <Modal title={`Add environment to ${task}`} onClose={onClose}>
      <div className="form">
        <label>
          agent
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            {enabledAgents.map((d) => (
              <option key={d.id} value={d.id}>{d.label}</option>
            ))}
          </select>
        </label>
        {enabledAgents.length === 0 && <div className="hint">no agents enabled — check ⚙ Agents</div>}
        {available.length === 0 && (
          <div className="hint">every registered repo already has an environment in this task</div>
        )}
        {available.map((r) => (
          <button key={r.name} disabled={!agent} onClick={() => onSubmit(r.name, agent)}>
            {r.name} <span className="dim">({r.url})</span>
          </button>
        ))}
        {error && <div className="error">{error}</div>}
      </div>
    </Modal>
  )
}
