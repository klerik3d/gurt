import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { DiffTarget, RepoChanges, Tree } from '../../../shared/types'
import { isActionable, isDelivered } from '../../../shared/types'
import { agentKind, agentName, useAgents } from '../useAgents'
import { alertDialog, confirmDialog } from '../dialog'
import { containerDot } from '../status'
import { Icon, Dot } from './icons'
import { AgentTag, EnvTag, RepoTag } from './tags'
import { Modal } from './Modal'
import { ReviewModal } from './ReviewModal'
import { run } from '../async'

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

  // Opening the task pane is a refresh trigger. `onRefreshChanges` is stable
  // per (ws, task) — App memoizes it on the selection — so this fires when the
  // pane opens or switches task, not on every parent render.
  useEffect(() => {
    onRefreshChanges()
  }, [ws, task, onRefreshChanges])

  const taskData = tree?.workspaces.find((w) => w.name === ws)?.tasks.find((t) => t.name === task)
  if (!taskData) return <div className="placeholder">task not found</div>

  const queued = taskData.sessions
    .filter((s) => s.state === 'queued')
    .sort((a, b) => (positions[a.id] ?? 0) - (positions[b.id] ?? 0))
  // A container belongs to exactly one session, so the task's infrastructure is
  // just the sessions that have provisioned one.
  const withContainer = taskData.sessions.filter((s) => s.container)

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
          <span className="seclabel">CONTAINERS</span>
          {withContainer.length === 0 && (
            <div className="tp-empty">no containers yet — one is created when a session starts</div>
          )}
          {withContainer.map((s) => {
            const c = s.container!
            const dot = containerDot(c.status)
            return (
              <div key={s.id}>
                <div className="env-row">
                  <Dot tone={dot.tone} pulse={dot.pulse} />
                  <span className="env-name clickable" onClick={() => onSelectSession(s.id)}>
                    {s.title}
                  </span>
                  <EnvTag name={s.env} />
                  {c.repos.map((r) => (
                    <RepoTag key={r} name={r} />
                  ))}
                  <span className={`env-status ${c.status === 'error' ? 'red' : 'dim'}`}>
                    {dot.label}
                  </span>
                  {c.error && <span className="env-err mono">{c.error}</span>}
                  <span className="spacer" />
                  {c.status !== 'stopped' && c.status !== 'error' && (
                    <button
                      className="btn btn-xs"
                      onClick={run(() =>
                        window.gurt.stopContainer(s.id).catch((e: unknown) => alertDialog(String(e)))
                      )}
                    >
                      Stop
                    </button>
                  )}
                  <button
                    className="btn btn-xs"
                    onClick={run(async () => {
                      if (
                        await confirmDialog(
                          `Delete the container of "${s.title}"? The session and its clone are kept — it re-provisions on the next run.`,
                          { title: 'Delete container', confirmText: 'Delete', danger: true }
                        )
                      )
                        window.gurt.releaseContainer(s.id).catch((e: unknown) => alertDialog(String(e)))
                    })}
                  >
                    Delete
                  </button>
                  <button
                    className="btn-log mono"
                    onClick={() => setOpenLog(openLog === s.id ? null : s.id)}
                  >
                    {openLog === s.id ? 'hide' : 'log'}
                  </button>
                </div>
                {openLog === s.id && (
                  <pre className="env-log">
                    {(logs[s.id] ?? []).join('\n') || 'no provisioning output yet'}
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
            <span className="tp-sec-hint">· starts when its repository is free</span>
          </div>
          {queued.length === 0 && <div className="tp-dashed">no queued sessions in this task</div>}
          {queued.map((s) => (
            <div key={s.id} className="queue-row">
              <span className="queue-pos mono">#{positions[s.id]}</span>
              <span className="queue-title clickable" onClick={() => onSelectSession(s.id)}>
                {s.title}
              </span>
              <EnvTag name={s.env} />
              {s.repos.map((r) => (
                <RepoTag key={r} name={r} />
              ))}
              <AgentTag kind={agentKind(agents, s.agent)} name={agentName(agents, s.agent)} />
              <span className="spacer" />
              <button
                className="btn btn-xs"
                onClick={run(() => window.gurt.sessionCancelQueue(s.id).catch((e: unknown) => alertDialog(String(e))))}
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
  /** The open review surface: a repo plus what it reads (uncommitted, or one commit). */
  const [review, setReview] = useState<{ repo: string; target: DiffTarget } | null>(null)
  const [commitRepo, setCommitRepo] = useState<string | null>(null)
  /** Repos held by a manual review — the lock tag and the panel's Review button
   *  read it; the surface itself owns the toggling. */
  const [locks, setLocks] = useState<Record<string, boolean>>({})
  /** repo -> last action error, rendered inline in its group. */
  const [errors, setErrors] = useState<Record<string, string>>({})
  /** Repos with an action in flight — their buttons are disabled. A set, not a
   *  single slot: with several repos, action A finishing must not re-enable
   *  repo B's buttons while B's own action is still running. */
  const [busyRepos, setBusyRepos] = useState<Set<string>>(new Set())

  // A repo renders while it has work to do, work awaiting merge, or is behind
  // its default branch; an integrated thread with nothing behind is gone from
  // the panel until a new commit (or the default branch moving) reopens it.
  const rendered = (changes ?? []).filter(
    (r) => isActionable(r) || isDelivered(r) || r.behind > 0
  )
  /** The single rendered repo, when there is exactly one — the header then
   *  carries its actions instead of repeating them per row. */
  const only = rendered.length === 1 ? rendered[0] : undefined

  const act = async (repo: string, fn: () => Promise<void>) => {
    setBusyRepos((prev) => new Set(prev).add(repo))
    setErrors((prev) => ({ ...prev, [repo]: '' }))
    try {
      await fn()
    } catch (e) {
      setErrors((prev) => ({ ...prev, [repo]: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusyRepos((prev) => {
        const next = new Set(prev)
        next.delete(repo)
        return next
      })
      onRefresh()
    }
  }

  const openVscode = (repo: string) =>
    act(repo, () => window.gurt.changesOpenVscode(ws, task, repo))

  // Lock state, refreshed with the panel. Read-only here: the toggle lives in
  // the review surface, next to what it protects.
  useEffect(() => {
    let live = true
    window.gurt
      .getReviewLocks(ws, task)
      .then((l) => live && setLocks(l))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [ws, task, changes])

  return (
    <div className="tp-section">
      <div className="tp-sec-head">
        <span className="seclabel">CHANGES</span>
        <span className="spacer" />
        <button className="icon-sq bordered" title="refresh changes" onClick={onRefresh}>
          <Icon name="history" size={13} />
        </button>
        {only && locks[only.repo] && <LockTag />}
        {only && (
          <button
            className="btn btn-sm"
            disabled={busyRepos.has(only.repo)}
            onClick={run(() => openVscode(only.repo))}
          >
            Open in VS Code
          </button>
        )}
      </div>
      {rendered.length === 0 && <div className="tp-empty">No changes</div>}
      {rendered.map((r) => (
        <div key={r.repo} className="changes-group">
          {!only && (
            <div className="changes-group-head">
              <span className="changes-repo">▾ {r.repo}</span>
              {locks[r.repo] && <LockTag />}
              <span className="spacer" />
              <button
                className="btn btn-xs"
                disabled={busyRepos.has(r.repo)}
                onClick={run(() => openVscode(r.repo))}
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
                      onClick={() => setReview({ repo: r.repo, target: { kind: 'uncommitted' } })}
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
                  disabled={busyRepos.has(r.repo)}
                  onClick={() => setCommitRepo(r.repo)}
                >
                  Commit
                </button>
                <button
                  className="btn btn-sm"
                  title="split diff, comments, and the review lock"
                  onClick={() => setReview({ repo: r.repo, target: { kind: 'uncommitted' } })}
                >
                  Review
                </button>
              </div>
            </div>
          )}
          {r.behind > 0 && (
            <div className="changes-block">
              <div className="block-head">
                {r.behind} commit{r.behind === 1 ? '' : 's'} behind {r.defaultBranch}
                {r.conflicted && (
                  <span className="tag tag-red" style={{ marginLeft: 6 }}>
                    conflicts
                  </span>
                )}
              </div>
              <div className="changes-actions">
                <button
                  className="btn btn-sm"
                  disabled={busyRepos.has(r.repo) || r.conflicted}
                  title={r.conflicted ? 'resolve the conflicts below, then commit' : undefined}
                  onClick={run(() =>
                    act(r.repo, () => window.gurt.changesUpdateFromMain(ws, task, r.repo))
                  )}
                >
                  Update from {r.defaultBranch}
                </button>
              </div>
            </div>
          )}
          {!r.integrated && r.commits.length > 0 && (
            <div className="changes-block">
              <div className="block-head">
                On <span className="branch-name mono">{task}</span> · {r.commits.length} commit
                {r.commits.length === 1 ? '' : 's'} not in {r.defaultBranch}
              </div>
              <div className="commit-list">
                {r.commits.map((c) => (
                  <div
                    key={c.sha}
                    className="commit-row clickable"
                    onClick={() =>
                      setReview({ repo: r.repo, target: { kind: 'commit', sha: c.sha } })
                    }
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
                  disabled={!r.commits.some((c) => !c.pushed) || busyRepos.has(r.repo)}
                  onClick={run(() => act(r.repo, () => window.gurt.changesPush(ws, task, r.repo)))}
                >
                  Push
                </button>
                {r.prUrl && (
                  <button
                    className="btn btn-sm"
                    disabled={busyRepos.has(r.repo)}
                    onClick={run(() => act(r.repo, () => window.gurt.changesOpenPr(ws, task, r.repo)))}
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
      {review && (
        <ReviewModal
          // Keyed per target: the surface loads its file list once, on mount.
          key={`${review.repo}/${
            review.target.kind === 'commit' ? review.target.sha : 'uncommitted'
          }`}
          ws={ws}
          task={task}
          repo={review.repo}
          target={review.target}
          title={`${review.repo}${
            review.target.kind === 'commit' ? ` · ${review.target.sha.slice(0, 7)}` : ''
          }`}
          onClose={() => setReview(null)}
          onChanged={onRefresh}
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
            // `act` reports its own failures on the repo row; nothing here waits.
            void act(commitRepo, () => window.gurt.changesCommit(ws, task, commitRepo, message))
          }}
        />
      )}
    </div>
  )
}

/** "A human is reviewing this clone" — agents cannot start against it. */
function LockTag(): JSX.Element {
  return (
    <span
      className="tag tag-ico tag-accent"
      title="locked for review — agents cannot start on this repo"
    >
      <Icon name="lock" size={11} />
      locked
    </span>
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
    // The modal is mounted for one (ws, task, repo) and unmounted on close, so
    // this loads once; naming the props anyway means a future reuse that *does*
    // change them re-reads the proposal instead of showing the old one. The
    // `touched` guard is what keeps a reload from clobbering user edits.
  }, [ws, task, repo])

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
