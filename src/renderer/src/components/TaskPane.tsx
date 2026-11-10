import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { Tree } from '../../../shared/types'
import { agentKind, agentName, useAgents } from '../useAgents'
import { alertDialog, confirmDialog } from '../dialog'
import { useOutsideClose } from '../hooks'
import { containerDot } from '../status'
import { Icon, Dot } from './icons'
import { AgentTag, EnvTag, RepoTag } from './tags'
import { run } from '../async'

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
  const agents = useAgents()

  const taskData = tree?.workspaces.find((w) => w.name === ws)?.tasks.find((t) => t.name === task)
  const [capInput, setCapInput] = useState('')
  useEffect(() => {
    setCapInput(taskData?.maxConcurrentSessions ? String(taskData.maxConcurrentSessions) : '')
  }, [taskData?.maxConcurrentSessions])
  if (!taskData) return <div className="placeholder">scope not found</div>

  const commitCap = (): void => {
    const n = capInput.trim() === '' ? undefined : Number(capInput)
    window.gurt
      .setTaskMaxConcurrentSessions(ws, task, n !== undefined && n > 0 ? Math.floor(n) : undefined)
      .catch((e: unknown) => alertDialog(String(e)))
  }

  const queued = taskData.sessions
    .filter((s) => s.state === 'queued' || s.pending?.length)
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
        {taskData.origin && (
          <>
            {/* Raised by a proactive agent (docs/design-proactive-agents.md §5):
                what it found, from which items, and what it noted since. */}
            <div className="tp-section">
              <div className="tp-sec-head">
                <span className="seclabel">RAISED BY {taskData.origin.agent.toUpperCase()}</span>
                <span className="tp-sec-hint">· {new Date(taskData.origin.createdAt).toLocaleString()}</span>
              </div>
              <div className="tp-origin-title">{taskData.origin.title}</div>
              <div className="tp-origin-summary">{taskData.origin.summary}</div>
              <div className="tp-origin-refs">
                {taskData.origin.refs.map((r) => (
                  <span key={r} className="tag mono">
                    {r}
                  </span>
                ))}
              </div>
              {taskData.origin.notes?.map((n, i) => (
                <div key={i} className="tp-origin-note">
                  <span className="tp-sec-hint">{new Date(n.at).toLocaleString()} ·</span> {n.text}
                </div>
              ))}
            </div>
            <div className="tp-sep" />
          </>
        )}
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
                  <Dot tone={dot.tone} pulse={dot.pulse} hollow={dot.hollow} />
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
                  <button
                    className="btn-log mono"
                    onClick={() => setOpenLog(openLog === s.id ? null : s.id)}
                  >
                    {openLog === s.id ? 'hide' : 'log'}
                  </button>
                  <ContainerActionsMenu
                    canStop={c.status !== 'stopped' && c.status !== 'error'}
                    onStop={run(() =>
                      window.gurt.stopContainer(s.id).catch((e: unknown) => alertDialog(String(e)))
                    )}
                    onDelete={run(async () => {
                      if (
                        await confirmDialog(
                          `Delete the container of "${s.title}"? The session and its clone are kept — it re-provisions on the next run.`,
                          { title: 'Delete container', confirmText: 'Delete', danger: true }
                        )
                      )
                        window.gurt.releaseContainer(s.id).catch((e: unknown) => alertDialog(String(e)))
                    })}
                  />
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
            <span className="tp-sec-hint">· FIFO per repository; independent work may run in parallel</span>
            <span className="spacer" />
            <span className="tp-sec-hint">max concurrent</span>
            <input
              type="number"
              min={1}
              className="tp-cap-input"
              placeholder="unlimited"
              value={capInput}
              onChange={(e) => setCapInput(e.target.value)}
              onBlur={commitCap}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
            />
          </div>
          {queued.length === 0 && <div className="tp-dashed">no queued sessions in this scope</div>}
          {queued.map((s) => (
            <div key={s.id} className="queue-row">
              <span className="queue-pos mono">#{positions[s.id]}</span>
              <span className="queue-title clickable" onClick={() => onSelectSession(s.id)}>
                {s.title}
                {s.pending?.map((p, i) => (
                  <div key={p.id} className="dim">
                    {i + 1}. {p.auto ? 'Auto: ' : ''}{p.text}{p.images ? ` · ${p.images} image(s)` : ''}
                  </div>
                ))}
                {s.queueWaiting && <div className="dim">{s.queueWaiting}</div>}
              </span>
              <EnvTag name={s.env} />
              {s.repos.map((r) => (
                <RepoTag key={r} name={r} />
              ))}
              <AgentTag kind={agentKind(agents, s.agent)} name={agentName(agents, s.agent)} />
              <span className="spacer" />
              {s.state === 'queued' ? <button
                className="btn btn-xs"
                onClick={run(() => window.gurt.sessionCancelQueue(s.id).catch((e: unknown) => alertDialog(String(e))))}
              >
                Cancel
              </button> : <button className="btn btn-xs" onClick={() => onSelectSession(s.id)}>Open messages</button>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Overflow menu for a container row — stop / delete — behind a click instead
 *  of two bare buttons sitting in the row at all times. */
function ContainerActionsMenu({
  canStop,
  onStop,
  onDelete
}: {
  canStop: boolean
  onStop: () => void
  onDelete: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(open, ref, () => setOpen(false))

  return (
    <div className="session-menu" ref={ref}>
      <button
        className={`icon-sq ${open ? 'active' : ''}`}
        title="container actions"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="dots" size={14} />
      </button>
      {open && (
        <div className="menu session-menu-pop">
          {canStop && (
            <div
              className="menu-item"
              onMouseDown={(e) => {
                e.preventDefault()
                setOpen(false)
                onStop()
              }}
            >
              <span>Stop</span>
            </div>
          )}
          <div
            className="menu-item danger"
            onMouseDown={(e) => {
              e.preventDefault()
              setOpen(false)
              onDelete()
            }}
          >
            <span>Delete</span>
          </div>
        </div>
      )}
    </div>
  )
}
