import { useEffect, useRef, useState } from 'react'
import type { EnvRef, EnvState, RepoChanges, Tree } from '../../../shared/types'
import { isActionable, isDelivered } from '../../../shared/types'
import { envKey } from '../App'
import { agentName, useAgents } from '../useAgents'
import { alertDialog, confirmDialog } from '../dialog'
import { Icon, Dot } from './icons'
import { Modal } from './Modal'

const ENV_DOT: Record<EnvState['status'], { tone: 'green' | 'yellow' | 'red' | 'outline'; pulse?: boolean }> = {
  stopped: { tone: 'outline' },
  starting: { tone: 'yellow', pulse: true },
  running: { tone: 'yellow', pulse: true },
  error: { tone: 'red' }
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
  const agents = useAgents()

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
      <div className="chat-head">
        <span className="chat-title">
          <span className="dim" style={{ fontWeight: 400 }}>
            {ws} /
          </span>{' '}
          {task}
        </span>
      </div>

      <div className="tp-body">
        <ChangesSection ws={ws} task={task} changes={changes} onRefresh={onRefreshChanges} />

        <div className="tp-sep" />

        <div className="tp-section">
          <span className="seclabel">ENVIRONMENTS</span>
          {taskData.envs.length === 0 && (
            <div className="tp-empty">no environments yet — they are created when a session starts</div>
          )}
          {taskData.envs.map((env) => {
            const ref: EnvRef = { workspace: ws, task, env: env.env }
            const key = envKey(ref)
            const dot = ENV_DOT[env.status]
            return (
              <div key={env.env}>
                <div className="env-row">
                  <Dot tone={dot.tone} pulse={dot.pulse} />
                  <span className="env-name">{env.env}</span>
                  {env.repo && <span className="tag">{env.repo}</span>}
                  <span className={`env-status ${env.status === 'error' ? 'red' : 'dim'}`}>
                    {env.status}
                  </span>
                  {env.error && <span className="env-err mono">{env.error}</span>}
                  <span className="spacer" />
                  {(env.status === 'running' || env.status === 'starting') && (
                    <button
                      className="btn btn-xs"
                      onClick={() => window.gurt.stopEnv(ref).catch((e) => alertDialog(String(e)))}
                    >
                      Stop
                    </button>
                  )}
                  <button
                    className="btn btn-xs"
                    onClick={async () => {
                      if (
                        await confirmDialog(
                          `Delete env "${env.env}" (container + clone)? Its sessions are kept and re-provision on next run. Uncommitted work is lost.`,
                          { title: 'Delete environment', confirmText: 'Delete', danger: true }
                        )
                      )
                        window.gurt.removeTaskEnv(ref).catch((e) => alertDialog(String(e)))
                    }}
                  >
                    Delete
                  </button>
                  <button
                    className="btn-log mono"
                    onClick={() => setOpenLog(openLog === key ? null : key)}
                  >
                    {openLog === key ? 'hide' : 'log'}
                  </button>
                </div>
                {openLog === key && (
                  <pre className="env-log">
                    {(logs[key] ?? []).join('\n') || 'no provisioning output yet'}
                  </pre>
                )}
              </div>
            )
          })}
        </div>

        <div className="tp-sep" />

        <div className="tp-section">
          <div className="tp-sec-head">
            <span className="seclabel">QUEUE</span>
            <span className="tp-sec-hint">· starts when the environment and its repository are free</span>
          </div>
          {queued.length === 0 && <div className="tp-dashed">no queued sessions in this task</div>}
          {queued.map((s) => (
            <div key={s.id} className="queue-row">
              <span className="queue-pos mono">#{positions[s.id]}</span>
              <span className="queue-title clickable" onClick={() => onSelectSession(s.id)}>
                {s.title}
              </span>
              <span className="tag">{s.env}</span>
              {s.repo && <span className="tag">{s.repo}</span>}
              <span className="tag">{agentName(agents, s.agent)}</span>
              <span className="spacer" />
              <button
                className="btn btn-xs"
                onClick={() => window.gurt.sessionCancelQueue(s.id).catch((e) => alertDialog(String(e)))}
              >
                Cancel
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ---- Changes panel — the task's delivery thread (docs/requirements-changes-thread.md) ----

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
  const [diffCommit, setDiffCommit] = useState<{ repo: string; sha: string } | null>(null)
  const [commitRepo, setCommitRepo] = useState<string | null>(null)
  /** repo -> last action error, rendered inline in its group. */
  const [errors, setErrors] = useState<Record<string, string>>({})
  /** repo with an action in flight — its buttons are disabled. */
  const [busyRepo, setBusyRepo] = useState<string | null>(null)

  // A repo renders while it has work to do or work awaiting merge; an integrated
  // thread is gone from the panel until a new commit reopens it.
  const rendered = (changes ?? []).filter((r) => isActionable(r) || isDelivered(r))
  const flat = rendered.length === 1

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
    <div className="tp-section">
      <div className="tp-sec-head">
        <span className="seclabel">CHANGES</span>
        <span className="spacer" />
        <button className="icon-sq bordered" title="refresh changes" onClick={onRefresh}>
          <Icon name="history" size={13} />
        </button>
        {flat && (
          <button
            className="btn btn-sm"
            disabled={busyRepo === rendered[0].repo}
            onClick={() => openVscode(rendered[0].repo)}
          >
            Open in VS Code
          </button>
        )}
      </div>
      {rendered.length === 0 && <div className="tp-empty">No changes</div>}
      {rendered.map((r) => (
        <div key={r.repo} className="changes-group">
          {!flat && (
            <div className="changes-group-head">
              <span className="changes-repo">▾ {r.repo}</span>
              <span className="spacer" />
              <button
                className="btn btn-xs"
                disabled={busyRepo === r.repo}
                onClick={() => openVscode(r.repo)}
              >
                Open in VS Code
              </button>
            </div>
          )}
          {r.dirty && (
            <div className="changes-block">
              <div className="block-head">Uncommitted</div>
              <div className="file-list mono">
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
              </div>
              <div className="changes-counts mono">
                {r.files.length} file{r.files.length === 1 ? '' : 's'} ·{' '}
                <span className="ins">+{r.insertions}</span>{' '}
                <span className="del">−{r.deletions}</span>
              </div>
              <div className="changes-actions">
                <button
                  className="btn btn-sm"
                  disabled={busyRepo === r.repo}
                  onClick={() => setCommitRepo(r.repo)}
                >
                  Commit
                </button>
              </div>
            </div>
          )}
          {!r.integrated && r.commits.length > 0 && (
            <div className="changes-block">
              <div className="block-head">
                On <span className="branch-name mono">gurt/{task}</span> · {r.commits.length} commit
                {r.commits.length === 1 ? '' : 's'} not in {r.defaultBranch}
              </div>
              <div className="commit-list">
                {r.commits.map((c) => (
                  <div
                    key={c.sha}
                    className="commit-row clickable"
                    onClick={() => setDiffCommit({ repo: r.repo, sha: c.sha })}
                  >
                    <span className="commit-sha mono">{c.sha.slice(0, 7)}</span>
                    <span className="commit-subject">{c.subject}</span>
                    <span className={`tag ${c.pushed ? 'tag-green' : ''}`}>
                      {c.pushed ? 'pushed' : 'local'}
                    </span>
                  </div>
                ))}
              </div>
              <div className="changes-actions">
                <button
                  className="btn btn-sm"
                  disabled={!r.commits.some((c) => !c.pushed) || busyRepo === r.repo}
                  onClick={() => act(r.repo, () => window.gurt.changesPush(ws, task, r.repo))}
                >
                  Push
                </button>
                {r.prUrl && (
                  <button
                    className="btn btn-sm"
                    disabled={busyRepo === r.repo}
                    onClick={() => act(r.repo, () => window.gurt.changesOpenPr(ws, task, r.repo))}
                  >
                    Create PR
                  </button>
                )}
              </div>
            </div>
          )}
          {errors[r.repo] && <div className="error changes-error">{errors[r.repo]}</div>}
        </div>
      ))}
      {diffFile && (
        <DiffModal
          key={`${diffFile.repo}/${diffFile.path}`}
          title={`${diffFile.repo}: ${diffFile.path}`}
          load={() => window.gurt.getFileDiff(ws, task, diffFile.repo, diffFile.path)}
          onClose={() => setDiffFile(null)}
        />
      )}
      {diffCommit && (
        <DiffModal
          key={`${diffCommit.repo}/${diffCommit.sha}`}
          title={`${diffCommit.repo}: ${diffCommit.sha.slice(0, 7)}`}
          load={() => window.gurt.getCommitDiff(ws, task, diffCommit.repo, diffCommit.sha)}
          onClose={() => setDiffCommit(null)}
        />
      )}
      {commitRepo && (
        <CommitModal
          ws={ws}
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

/** Read-only unified diff — one file (`git diff`) or one commit (`git show`). */
function DiffModal({
  title,
  load,
  onClose
}: {
  title: string
  load: () => Promise<string>
  onClose: () => void
}) {
  const [diff, setDiff] = useState<string | null>(null)
  const [error, setError] = useState('')

  // Mounted with a key per file/commit, so loading once on mount is the whole story.
  useEffect(() => {
    let live = true
    load()
      .then((d) => {
        if (live) setDiff(d)
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const lineClass = (line: string) =>
    line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : ''

  return (
    <Modal title={title} wide onClose={onClose}>
      <div className="diff-view mono">
        {error && <div className="error">{error}</div>}
        {diff === null && !error && <div className="tp-empty">loading diff…</div>}
        {diff !== null &&
          (diff.trim()
            ? diff.split('\n').map((line, i) => (
                <div key={i} className={`diffline ${lineClass(line)}`}>
                  {line || ' '}
                </div>
              ))
            : <div className="tp-empty">no diff</div>)}
      </div>
    </Modal>
  )
}

/** Small commit dialog. The message prefills from the session's latest change
 *  proposal (subject + body) when one exists, else falls back to `gurt: <task>`. */
function CommitModal({
  ws,
  task,
  repo,
  onClose,
  onCommit
}: {
  ws: string
  task: string
  repo: string
  onClose: () => void
  onCommit: (message: string) => void
}) {
  const [message, setMessage] = useState(`gurt: ${task}`)
  /** The user may start editing before the proposal loads — don't clobber that.
   *  A ref, not state: the load callback below must see the *current* value, not
   *  the one captured when the effect mounted. */
  const touched = useRef(false)

  useEffect(() => {
    let live = true
    window.gurt
      .latestProposal(ws, task, repo)
      .then((p) => {
        if (!live || touched.current || !p?.commit) return
        setMessage(p.commit.body ? `${p.commit.subject}\n\n${p.commit.body}` : p.commit.subject)
      })
      .catch(() => {})
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const edit = (v: string) => {
    touched.current = true
    setMessage(v)
  }
  return (
    <Modal title={`Commit in ${repo}`} onClose={onClose}>
      <div className="modal-body">
        <label className="fld">
          <span className="seclabel">MESSAGE</span>
          <textarea
            className="input commit-message"
            autoFocus
            rows={message.includes('\n') ? 6 : 2}
            value={message}
            onChange={(e) => edit(e.target.value)}
            // Enter inserts a newline (bodies are multi-line); ⌘/Ctrl+Enter commits.
            onKeyDown={(e) =>
              e.key === 'Enter' &&
              (e.metaKey || e.ctrlKey) &&
              message.trim() &&
              onCommit(message.trim())
            }
          />
        </label>
      </div>
      <div className="modal-foot">
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!message.trim()} onClick={() => onCommit(message.trim())}>
          Commit
        </button>
      </div>
    </Modal>
  )
}
