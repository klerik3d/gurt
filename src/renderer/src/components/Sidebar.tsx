import { useEffect, useState } from 'react'
import type { AgentsFile, SessionInfo, SessionState, Tree } from '../../../shared/types'
import { AGENT_DEFS } from '../../../shared/agents'
import type { Selection } from '../App'
import { Modal } from './Modal'
import { ReposModal } from './ReposModal'

type AddForm =
  | { type: 'workspace' }
  | { type: 'repos'; ws: string }
  | { type: 'task'; ws: string }
  | { type: 'session'; ws: string; task: string }
  | null

const SESSION_MARK: Record<SessionState, string> = {
  draft: '✎',
  queued: '⏳',
  starting: '◐',
  started: '●'
}

export function Sidebar({
  tree,
  selection,
  onSelectTask,
  onSelectSession,
  onOpenAgents
}: {
  tree: Tree | null
  selection: Selection
  onSelectTask: (ws: string, task: string) => void
  onSelectSession: (id: string) => void
  onOpenAgents: () => void
}) {
  const [form, setForm] = useState<AddForm>(null)
  const [error, setError] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })

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
            {ws.tasks.map((task) => {
              const taskSelected =
                selection?.type === 'task' &&
                selection.ws === ws.name &&
                selection.task === task.name
              const tkey = `${ws.name}/${task.name}`
              const isCollapsed = collapsed.has(tkey)
              return (
                <div key={task.name} className="task">
                  <div className={`node task-node ${taskSelected ? 'selected' : ''}`}>
                    <span
                      className="clickable"
                      style={{ color: 'var(--text-dim3)', fontSize: 10, width: 10 }}
                      onClick={() => toggle(tkey)}
                    >
                      {isCollapsed ? '▸' : '▾'}
                    </span>
                    <span
                      className="node-label clickable"
                      onClick={() => onSelectTask(ws.name, task.name)}
                    >
                      {task.name}
                    </span>
                    <span className="spacer" />
                    <button
                      className="icon-btn"
                      title="new session"
                      onClick={() => setForm({ type: 'session', ws: ws.name, task: task.name })}
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
                  {!isCollapsed &&
                    task.sessions.map((s) => (
                      <div
                        key={s.id}
                        className={`node session-node ${
                          selection?.type === 'session' && selection.id === s.id ? 'selected' : ''
                        }`}
                      >
                        <span className={`session-mark mark-${s.state}`}>{SESSION_MARK[s.state]}</span>
                        <span className="node-label clickable" onClick={() => onSelectSession(s.id)}>
                          {s.title}
                        </span>
                        <span className="chip">{s.envRepo}</span>
                        <span className="chip">{s.agent}</span>
                      </div>
                    ))}
                  {!isCollapsed && task.sessions.length === 0 && (
                    <div className="hint task-hint">no sessions — “+” to add one</div>
                  )}
                </div>
              )
            })}
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
      {form?.type === 'session' && tree && (
        <NewSessionModal
          tree={tree}
          ws={form.ws}
          task={form.task}
          onClose={() => setForm(null)}
          onCreated={(s) => {
            setForm(null)
            onSelectSession(s.id)
          }}
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

function NewSessionModal({
  tree,
  ws,
  task,
  onClose,
  onCreated
}: {
  tree: Tree
  ws: string
  task: string
  onClose: () => void
  onCreated: (s: SessionInfo) => void
}) {
  const [agents, setAgents] = useState<AgentsFile | null>(null)
  const [agent, setAgent] = useState('')
  const [repo, setRepo] = useState('')
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    window.gurt.getAgents().then((a) => {
      setAgents(a)
      const first = AGENT_DEFS.find((d) => a[d.id]?.enabled)
      if (first) setAgent(first.id)
    })
  }, [])

  const wsData = tree.workspaces.find((w) => w.name === ws)
  const taskData = wsData?.tasks.find((t) => t.name === task)
  const repos = wsData?.repos ?? []
  const enabledAgents = AGENT_DEFS.filter((d) => agents?.[d.id]?.enabled)

  useEffect(() => {
    if (!repo && repos.length) setRepo(repos[0].name)
  }, [repo, repos])

  const create = async (action: 'run' | 'queue' | 'draft') => {
    setError('')
    if (action === 'run') {
      const busy = (taskData?.sessions ?? []).some(
        (s) => s.envRepo === repo && (s.state === 'starting' || s.state === 'started')
      )
      if (
        busy &&
        !window.confirm(
          `Another session is already working on "${repo}". Running now means two agents share one working tree. Continue?`
        )
      )
        return
    }
    try {
      const s = await window.gurt.createSession({ workspace: ws, task, repo }, agent, prompt, action)
      onCreated(s)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const ready = !!repo && !!agent && !!prompt.trim()

  return (
    <Modal title={`New session in ${task}`} onClose={onClose}>
      <div className="form">
        <label>
          repo
          <select value={repo} onChange={(e) => setRepo(e.target.value)}>
            {repos.map((r) => (
              <option key={r.name} value={r.name}>{r.name}</option>
            ))}
          </select>
        </label>
        {repos.length === 0 && <div className="hint">no repos — add one via the workspace “repos”</div>}
        <label>
          agent
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            {enabledAgents.map((d) => (
              <option key={d.id} value={d.id}>{d.label}</option>
            ))}
          </select>
        </label>
        {enabledAgents.length === 0 && <div className="hint">no agents enabled — check ⚙ Agents</div>}
        <label>
          start prompt
          <textarea
            rows={5}
            placeholder="what should the agent do first?"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        {error && <div className="error">{error}</div>}
        <div className="row-buttons">
          <button disabled={!ready} onClick={() => create('run')}>Run now</button>
          <button disabled={!ready} onClick={() => create('queue')}>Add to queue</button>
          <button disabled={!ready} onClick={() => create('draft')}>Save draft</button>
        </div>
      </div>
    </Modal>
  )
}
