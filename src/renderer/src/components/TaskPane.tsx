import { useState } from 'react'
import type { EnvRef, Tree } from '../../../shared/types'
import { envKey } from '../App'

const STATUS_ICON: Record<string, string> = {
  stopped: '○',
  starting: '◐',
  running: '●',
  error: '✕'
}

export function TaskPane({
  tree,
  ws,
  task,
  logs,
  positions,
  onSelectSession
}: {
  tree: Tree | null
  ws: string
  task: string
  logs: Record<string, string[]>
  positions: Record<string, number>
  onSelectSession: (id: string) => void
}) {
  const [openLog, setOpenLog] = useState<string | null>(null)

  const taskData = tree?.workspaces.find((w) => w.name === ws)?.tasks.find((t) => t.name === task)
  if (!taskData) return <div className="placeholder">task not found</div>

  const queued = taskData.sessions
    .filter((s) => s.state === 'queued')
    .sort((a, b) => (positions[a.id] ?? 0) - (positions[b.id] ?? 0))

  return (
    <div className="task-pane">
      <div className="chat-header">
        <span>{ws} / {task}</span>
      </div>

      <div className="pane-section">
        <h3>environments</h3>
        {taskData.envs.length === 0 && (
          <div className="hint">no environments yet — they are created when a session starts</div>
        )}
        <table className="env-table">
          <tbody>
            {taskData.envs.map((env) => {
              const ref: EnvRef = { workspace: ws, task, repo: env.repo }
              const key = envKey(ref)
              return (
                <tr key={env.repo}>
                  <td className="env-cell">
                    <span className={`status status-${env.status}`}>{STATUS_ICON[env.status]}</span>
                    {env.repo}
                    <span className="dim"> — {env.status}</span>
                    {env.error && <span className="error inline-error"> {env.error}</span>}
                  </td>
                  <td className="env-actions">
                    {(env.status === 'stopped' || env.status === 'error') && (
                      <button onClick={() => window.gurt.startEnv(ref).catch(() => {})}>Start</button>
                    )}
                    {(env.status === 'running' || env.status === 'starting') && (
                      <button onClick={() => window.gurt.stopEnv(ref).catch((e) => alert(String(e)))}>
                        Stop
                      </button>
                    )}
                    <button
                      onClick={() => {
                        if (window.confirm(`Delete env "${env.repo}" (container + clone)? Its sessions are kept and re-provision on next run. Uncommitted work is lost.`))
                          window.gurt.removeEnv(ref).catch((e) => alert(String(e)))
                      }}
                    >
                      Delete
                    </button>
                    <button onClick={() => setOpenLog(openLog === key ? null : key)}>
                      {openLog === key ? 'hide log' : 'log'}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {openLog && (
          <pre className="env-log">
            {(logs[openLog] ?? []).join('\n') || 'no provisioning output yet'}
          </pre>
        )}
      </div>

      <div className="pane-section">
        <h3>
          queue{' '}
          <span className="dim" title="a queued session starts when its repo is free; a repo frees only when its environment is stopped">
            (ⓘ starts when the repo's env is stopped)
          </span>
        </h3>
        {queued.length === 0 && <div className="hint">no queued sessions in this task</div>}
        {queued.map((s) => (
          <div key={s.id} className="queue-row">
            <span className="queue-pos">#{positions[s.id]}</span>
            <span className="node-label clickable" onClick={() => onSelectSession(s.id)}>
              {s.title}
            </span>
            <span className="chip">{s.envRepo}</span>
            <span className="chip">{s.agent}</span>
            <span className="spacer" />
            <button onClick={() => window.gurt.sessionCancelQueue(s.id).catch((e) => alert(String(e)))}>
              Cancel
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
