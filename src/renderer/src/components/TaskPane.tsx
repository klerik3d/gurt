import { useEffect, useState } from 'react'
import type { EnvRef, RepoChanges, Tree } from '../../../shared/types'
import { envKey } from '../App'
import { Modal } from './Modal'

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
  changes,
  onRefreshChanges,
  onSelectSession
}: {
  tree: Tree | null
  ws: string
  task: string
  logs: Record<string, string[]>
  positions: Record<string, number>
  /** Git state of this task's clones; undefined until first fetched. */
  changes: RepoChanges[] | undefined
  onRefreshChanges: () => void
  onSelectSession: (id: string) => void
}) {
  const [openLog, setOpenLog] = useState<string | null>(null)

  // Opening the task pane is a refresh trigger.
  useEffect(() => {
    onRefreshChanges()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, task])

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

      <ChangesSection ws={ws} task={task} changes={changes} onRefresh={onRefreshChanges} />

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

// ---- Changes panel — the task's product (docs/requirements-changes-panel.md) ----

function ChangesSection({
  ws,
  task,
  changes,
  onRefresh
}: {
  ws: string
  task: string
  changes: RepoChanges[] | undefined
  onRefresh: () => void
}) {
  const [diffFile, setDiffFile] = useState<{ repo: string; path: string } | null>(null)
  const [commitRepo, setCommitRepo] = useState<string | null>(null)
  /** repo -> last action error, rendered inline in its group. */
  const [errors, setErrors] = useState<Record<string, string>>({})
  /** repo with an action in flight — its buttons are disabled. */
  const [busyRepo, setBusyRepo] = useState<string | null>(null)

  const actionable = (changes ?? []).filter((r) => r.dirty || r.ahead > 0)
  const flat = actionable.length === 1

  const act = async (repo: string, fn: () => Promise<void>) => {
    setBusyRepo(repo)
    setErrors((prev) => ({ ...prev, [repo]: '' }))
    try {
      await fn()
    } catch (e) {
      setErrors((prev) => ({ ...prev, [repo]: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusyRepo(null)
      onRefresh()
    }
  }

  const openVscode = (repo: string) =>
    act(repo, () => window.gurt.changesOpenVscode(ws, task, repo))

  return (
    <div className="pane-section changes-section">
      <div className="changes-head">
        <h3>changes</h3>
        <span className="spacer" />
        <button className="icon-btn" title="refresh changes" onClick={onRefresh}>↻</button>
        {flat && (
          <button
            disabled={busyRepo === actionable[0].repo}
            onClick={() => openVscode(actionable[0].repo)}
          >
            Open in VS Code
          </button>
        )}
      </div>
      {actionable.length === 0 && <div className="hint no-changes">No changes</div>}
      {actionable.map((r) => (
        <div key={r.repo} className="changes-group">
          {!flat && (
            <div className="changes-group-head">
              <span className="changes-repo">▾ {r.repo}</span>
              <span className="spacer" />
              <button disabled={busyRepo === r.repo} onClick={() => openVscode(r.repo)}>
                Open in VS Code
              </button>
            </div>
          )}
          {r.files.map((f) => (
            <div key={f.path} className="file-row">
              <span className={`file-status st-${f.status}`}>{f.status}</span>
              <span
                className="file-path clickable"
                onClick={() => setDiffFile({ repo: r.repo, path: f.path })}
              >
                {f.path}
              </span>
            </div>
          ))}
          <div className="changes-counts">
            {r.files.length} file{r.files.length === 1 ? '' : 's'} · <span className="ins">+{r.insertions}</span>{' '}
            <span className="del">−{r.deletions}</span>
            {!r.dirty && r.ahead > 0 && (
              <span className="dim"> — {r.ahead} commit{r.ahead === 1 ? '' : 's'} to push</span>
            )}
          </div>
          <div className="changes-actions">
            <button disabled={!r.dirty || busyRepo === r.repo} onClick={() => setCommitRepo(r.repo)}>
              Commit
            </button>
            <button
              disabled={r.ahead === 0 || busyRepo === r.repo}
              onClick={() => act(r.repo, () => window.gurt.changesPush(ws, task, r.repo))}
            >
              Push
            </button>
            {r.prAvailable && (
              <button
                disabled={!r.prReady || busyRepo === r.repo}
                onClick={() => act(r.repo, () => window.gurt.changesOpenPr(ws, task, r.repo))}
              >
                Create PR
              </button>
            )}
          </div>
          {errors[r.repo] && <div className="error changes-error">{errors[r.repo]}</div>}
        </div>
      ))}
      {diffFile && (
        <DiffModal
          ws={ws}
          task={task}
          repo={diffFile.repo}
          path={diffFile.path}
          onClose={() => setDiffFile(null)}
        />
      )}
      {commitRepo && (
        <CommitModal
          task={task}
          repo={commitRepo}
          onClose={() => setCommitRepo(null)}
          onCommit={(message) => {
            setCommitRepo(null)
            act(commitRepo, () => window.gurt.changesCommit(ws, task, commitRepo, message))
          }}
        />
      )}
    </div>
  )
}

/** Read-only unified diff of one file. */
function DiffModal({
  ws,
  task,
  repo,
  path,
  onClose
}: {
  ws: string
  task: string
  repo: string
  path: string
  onClose: () => void
}) {
  const [diff, setDiff] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    window.gurt
      .getFileDiff(ws, task, repo, path)
      .then(setDiff)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [ws, task, repo, path])

  const lineClass = (line: string) =>
    line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : ''

  return (
    <Modal title={`${repo}: ${path}`} wide onClose={onClose}>
      <div className="diff-view">
        {error && <div className="error">{error}</div>}
        {diff === null && !error && <div className="hint">loading diff…</div>}
        {diff !== null &&
          (diff.trim()
            ? diff.split('\n').map((line, i) => (
                <div key={i} className={`diff-line ${lineClass(line)}`}>
                  {line || ' '}
                </div>
              ))
            : <div className="hint">no diff</div>)}
      </div>
    </Modal>
  )
}

/** Small commit dialog with the message prefilled `gurt: <task>`. */
function CommitModal({
  task,
  repo,
  onClose,
  onCommit
}: {
  task: string
  repo: string
  onClose: () => void
  onCommit: (message: string) => void
}) {
  const [message, setMessage] = useState(`gurt: ${task}`)
  return (
    <Modal title={`Commit in ${repo}`} onClose={onClose}>
      <div className="form">
        <label>
          message
          <input
            autoFocus
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && message.trim() && onCommit(message.trim())}
          />
        </label>
        <div className="row-buttons">
          <button disabled={!message.trim()} onClick={() => onCommit(message.trim())}>Commit</button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  )
}
