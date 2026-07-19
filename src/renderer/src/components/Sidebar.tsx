import { useEffect, useState } from 'react'
import type { AgentsFile, McpMode, McpSelection, RepoChanges, SessionInfo, SessionStatus, Tree } from '../../../shared/types'
import { isActionable, isDelivered, sessionStatus } from '../../../shared/types'
import type { CredentialEntry } from '../../../shared/credentials'
import { hasManagedCredential, resolveForRepo } from '../../../shared/credentials'
import type { McpDef } from '../../../shared/mcp'
import type { Selection } from '../App'
import { agentName, useAgents } from '../useAgents'
import { alertDialog, confirmDialog } from '../dialog'
import { Modal } from './Modal'
import { ReposModal } from './ReposModal'

type AddForm =
  | { type: 'workspace' }
  | { type: 'repos'; ws: string }
  | { type: 'task'; ws: string }
  | { type: 'session'; ws: string; task: string }
  | null

/** Glyph + human label per fine-grained session status; color comes from `mark-<status>`. */
const STATUS_MARK: Record<SessionStatus, { glyph: string; label: string }> = {
  draft: { glyph: '✎', label: 'draft' },
  queued: { glyph: '⏳', label: 'queued' },
  starting: { glyph: '◐', label: 'starting' },
  running: { glyph: '●', label: 'running' },
  waiting: { glyph: '◆', label: 'awaiting your input' },
  idle: { glyph: '○', label: 'idle — turn ended' }
}

export function Sidebar({
  width,
  tree,
  selection,
  changes,
  activity,
  onSelectTask,
  onSelectSession,
  onOpenAgents,
  onOpenCredentials
}: {
  /** Current sidebar width in px (user-draggable). */
  width: number
  tree: Tree | null
  selection: Selection
  /** Per-task git changes keyed `ws/task` — drives the actionable badge. */
  changes: Record<string, RepoChanges[]>
  /** Live runtime overlay per session id — splits `started` into running/waiting/idle. */
  activity: Record<string, { busy?: boolean; awaitingInput?: boolean }>
  onSelectTask: (ws: string, task: string) => void
  onSelectSession: (id: string) => void
  onOpenAgents: () => void
  onOpenCredentials: () => void
}) {
  const [form, setForm] = useState<AddForm>(null)
  const [error, setError] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const agents = useAgents()

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
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-header">
        <span className="logo">gurt</span>
        <span className="spacer" />
        <button className="icon-btn" title="credentials" onClick={onOpenCredentials}>🔑</button>
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
                    <TaskBadge repos={changes[tkey] ?? []} />
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
                      onClick={async () => {
                        const dirty = await window.gurt.taskDirtyRepos(ws.name, task.name).catch(() => [])
                        const warning = dirty.length
                          ? `Task "${task.name}" has uncommitted changes in: ${dirty.join(', ')}. Delete anyway and permanently lose them, along with all environments and sessions?`
                          : `Delete task "${task.name}" with all its environments, clones and sessions?`
                        if (await confirmDialog(warning, { title: 'Delete task', confirmText: 'Delete', danger: true }))
                          window.gurt.removeTask(ws.name, task.name).catch((e) => alertDialog(String(e)))
                      }}
                    >
                      🗑
                    </button>
                  </div>
                  {!isCollapsed &&
                    task.sessions.map((s) => {
                      const raw = sessionStatus({ ...s, ...activity[s.id] })
                      // running/waiting mean a live agent process is attached; if the
                      // session's env isn't up, that process is gone — never render it
                      // as live, however the runtime overlay lags.
                      const env = task.envs.find((e) => e.repo === s.envRepo)
                      const envLive = env?.status === 'running' || env?.status === 'starting'
                      const status =
                        !envLive && (raw === 'running' || raw === 'waiting') ? 'idle' : raw
                      const mark = STATUS_MARK[status]
                      return (
                      <div
                        key={s.id}
                        className={`node session-node ${
                          selection?.type === 'session' && selection.id === s.id ? 'selected' : ''
                        }`}
                      >
                        <span className={`session-mark mark-${status}`} title={mark.label}>{mark.glyph}</span>
                        <span className="node-label clickable" onClick={() => onSelectSession(s.id)}>
                          {s.title}
                        </span>
                        <span className="chip">{s.envRepo}</span>
                        <span className="chip">{agentName(agents, s.agent)}</span>
                        {s.mcp?.map((m) => (
                          <span
                            key={m.id}
                            className="chip chip-mcp"
                            title={`MCP ${m.id} · ${m.mode}`}
                          >
                            {m.id}
                            {m.mode === 'read-only' ? ' ᴿᴼ' : ''}
                          </span>
                        ))}
                        {s.gitAccess && (
                          <span className="chip chip-git" title="native git access">
                            git
                          </span>
                        )}
                      </div>
                      )
                    })}
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

/** Delivery state of the task's clones: work to do, work awaiting merge, or nothing. */
function TaskBadge({ repos }: { repos: RepoChanges[] }) {
  if (repos.some(isActionable))
    return (
      <span className="task-badge" title="uncommitted or unpushed changes">
        ●
      </span>
    )
  if (repos.some(isDelivered))
    return (
      <span className="task-badge badge-delivered" title="delivered — awaiting merge">
        ○
      </span>
    )
  return null
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

export function NewSessionModal({
  tree,
  ws,
  task,
  edit,
  onClose,
  onCreated
}: {
  tree: Tree
  ws: string
  task: string
  /** When present, edit this existing draft's settings instead of creating one. */
  edit?: SessionInfo
  onClose: () => void
  onCreated: (s: SessionInfo) => void
}) {
  const editing = !!edit
  const [agents, setAgents] = useState<AgentsFile | null>(null)
  const [agent, setAgent] = useState(edit?.agent ?? '')
  const [repo, setRepo] = useState(edit?.envRepo ?? '')
  const [prompt, setPrompt] = useState(edit?.startPrompt ?? '')
  const [mcpDefs, setMcpDefs] = useState<McpDef[]>([])
  /** MCP id -> granted mode; absent = not attached. */
  const [mcp, setMcp] = useState<Record<string, McpMode>>(
    Object.fromEntries((edit?.mcp ?? []).map((m) => [m.id, m.mode]))
  )
  /** Permission mode: auto-allow tool calls, or ask for each one. */
  const [autoAllow, setAutoAllow] = useState(edit?.autoAllow ?? true)
  /** Native git access injection — off by default; the user opts in per session. */
  const [gitAccess, setGitAccess] = useState(edit?.gitAccess ?? false)
  const [credentials, setCredentials] = useState<CredentialEntry[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    window.gurt.getAgents().then((a) => {
      setAgents(a)
      // Create mode picks the first enabled agent; edit mode keeps the draft's.
      if (!editing) {
        const first = Object.keys(a).find((id) => a[id].enabled)
        if (first) setAgent(first)
      }
    })
    window.gurt.getMcpDefs().then(setMcpDefs)
    window.gurt.getCredentials().then((f) => setCredentials(f.credentials)).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggleMcp = (id: string, on: boolean) =>
    setMcp((prev) => {
      const next = { ...prev }
      if (on) next[id] = prev[id] ?? 'read-only'
      else delete next[id]
      return next
    })

  const mcpSelection = (): McpSelection[] =>
    Object.entries(mcp).map(([id, mode]) => ({ id, mode }))

  const wsData = tree.workspaces.find((w) => w.name === ws)
  const taskData = wsData?.tasks.find((t) => t.name === task)
  const repos = wsData?.repos ?? []
  const enabledAgents = agents
    ? Object.entries(agents)
        .filter(([, a]) => a.enabled)
        .map(([id, a]) => ({ id, label: a.label }))
    : []

  useEffect(() => {
    if (!repo && repos.length) setRepo(repos[0].name)
  }, [repo, repos])

  const repoCfg = repos.find((r) => r.name === repo)
  const gitResolution = repoCfg ? resolveForRepo(credentials, repoCfg) : null

  const saveEdit = async () => {
    setError('')
    try {
      await window.gurt.sessionEditDraft(edit!.id, {
        agent,
        envRepo: repo,
        autoAllow,
        gitAccess,
        mcp: mcpSelection(),
        startPrompt: prompt
      })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const create = async (action: 'run' | 'queue' | 'draft') => {
    setError('')
    if (action === 'run') {
      const busy = (taskData?.sessions ?? []).some(
        (s) => s.envRepo === repo && (s.state === 'starting' || s.state === 'started')
      )
      if (
        busy &&
        !(await confirmDialog(
          `Another session is already working on "${repo}". Running now means two agents share one working tree. Continue?`,
          { title: 'Shared working tree', confirmText: 'Run anyway' }
        ))
      )
        return
    }
    try {
      const s = await window.gurt.createSession(
        { workspace: ws, task, repo },
        agent,
        prompt,
        action,
        mcpSelection(),
        autoAllow,
        gitAccess
      )
      onCreated(s)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const ready = !!repo && !!agent && !!prompt.trim()

  return (
    <Modal title={editing ? `Edit session in ${task}` : `New session in ${task}`} onClose={onClose}>
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
            {enabledAgents.map((a) => (
              <option key={a.id} value={a.id}>{a.label}</option>
            ))}
          </select>
        </label>
        {enabledAgents.length === 0 && <div className="hint">no agents enabled — check ⚙ Agents</div>}
        <label>
          mode
          <select
            value={autoAllow ? 'auto' : 'manual'}
            onChange={(e) => setAutoAllow(e.target.value === 'auto')}
          >
            <option value="auto">auto — allow tool calls automatically</option>
            <option value="manual">manual — confirm each tool call</option>
          </select>
        </label>
        <label>
          git access
          <select
            value={gitAccess ? 'on' : 'off'}
            onChange={(e) => setGitAccess(e.target.value === 'on')}
          >
            <option value="on">on — native git + gh in the container</option>
            <option value="off">off — delegate remote git to the github MCP</option>
          </select>
          {gitResolution && (
            <span className="dim">
              {hasManagedCredential(gitResolution)
                ? `credential: ${gitResolution.entry?.label}`
                : gitResolution.error
                  ? `credential error: ${gitResolution.error}`
                  : gitResolution.entry?.kind === 'git-host'
                    ? `host credentials (explicit): ${gitResolution.entry.label}`
                    : 'no credential — remote git/forge is blocked until one is configured'}
            </span>
          )}
        </label>
        {mcpDefs.length > 0 && (
          <div className="mcp-picker">
            <div className="mcp-picker-title">MCP servers</div>
            {mcpDefs.map((def) => {
              const mode = mcp[def.id]
              return (
                <div key={def.id} className="mcp-row">
                  <label className="row" title={def.description}>
                    <input
                      type="checkbox"
                      checked={mode != null}
                      onChange={(e) => toggleMcp(def.id, e.target.checked)}
                    />
                    {def.label}
                  </label>
                  {mode != null && (
                    <select
                      value={mode}
                      onChange={(e) =>
                        setMcp((prev) => ({ ...prev, [def.id]: e.target.value as McpMode }))
                      }
                    >
                      <option value="read-only">read-only</option>
                      <option value="full">full</option>
                    </select>
                  )}
                </div>
              )
            })}
          </div>
        )}
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
          {editing ? (
            <>
              <button disabled={!ready} onClick={saveEdit}>Save</button>
              <button onClick={onClose}>Cancel</button>
            </>
          ) : (
            <>
              <button disabled={!ready} onClick={() => create('run')}>Run now</button>
              <button disabled={!ready} onClick={() => create('queue')}>Add to queue</button>
              <button disabled={!ready} onClick={() => create('draft')}>Save draft</button>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
