import { useEffect, useRef, useState } from 'react'
import type { ChatEntry, PlanEntry, SessionSnapshot } from '../../../shared/types'

/** Don't ping the main process on every keystroke — once per this interval is enough
 *  to keep postponing the env's idle auto-stop while the user is composing. */
const ACTIVITY_PING_INTERVAL_MS = 5_000

export function Chat({ snapshot, sessionId }: { snapshot?: SessionSnapshot; sessionId: string }) {
  const [text, setText] = useState('')
  const [planOpen, setPlanOpen] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)
  const lastActivityPingRef = useRef(0)

  const pingActivity = () => {
    const now = performance.now()
    if (now - lastActivityPingRef.current < ACTIVITY_PING_INTERVAL_MS) return
    lastActivityPingRef.current = now
    window.gurt.sessionActivity(sessionId).catch(console.error)
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [snapshot?.entries.length, snapshot?.entries[snapshot.entries.length - 1]?.id])

  if (!snapshot) return <div className="placeholder">loading session…</div>

  const send = () => {
    const t = text.trim()
    if (!t || snapshot.busy) return
    setText('')
    window.gurt.sessionPrompt(sessionId, t).catch(console.error)
  }

  const { info, entries, modes, plan, commands, busy, autoAllow } = snapshot

  return (
    <div className="chat">
      <div className="chat-header">
        <span className="breadcrumb">
          {info.workspace}
          <span className="sep">/</span>
          {info.task}
          <span className="sep">/</span>
          <span className="leaf">{info.envRepo}</span>
        </span>
        {info.agent && <span className="chip">{info.agent}</span>}
        <span className="spacer" />
        {busy && (
          <>
            <span className="busy">working…</span>
            <button onClick={() => window.gurt.sessionCancel(sessionId)}>Stop</button>
          </>
        )}
      </div>

      <div className="chat-log">
        {entries.map((e, i) => (
          <EntryRow key={e.id} entry={e} sessionId={sessionId} last={i === entries.length - 1} />
        ))}
        <div ref={bottomRef} />
      </div>

      {plan && plan.length > 0 && (
        <PlanPanel plan={plan} open={planOpen} onToggle={() => setPlanOpen((o) => !o)} />
      )}

      <div className="composer-wrap">
        <div className={`composer ${busy ? 'disabled' : ''}`}>
          <textarea
            rows={2}
            placeholder={busy ? 'agent is working…' : 'Esc to focus or unfocus gurt'}
            value={text}
            disabled={busy}
            onChange={(e) => {
              setText(e.target.value)
              pingActivity()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          <div className="composer-toolbar">
            <button
              className={`tbtn ${autoAllow ? 'active' : ''}`}
              title={autoAllow ? 'auto-allow on' : 'auto-allow off'}
              onClick={() => window.gurt.sessionAutoAllow(sessionId, !autoAllow)}
            >
              {autoAllow ? '🔓' : '🔒'}
            </button>
            {modes && modes.availableModes.length > 0 && (
              <div className="mode-pill">
                <span style={{ color: 'var(--green)' }}>⚡</span>
                <select
                  value={modes.currentModeId}
                  onChange={(e) =>
                    window.gurt.sessionSetMode(sessionId, e.target.value).catch((er) => alert(String(er)))
                  }
                >
                  {modes.availableModes.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              </div>
            )}
            <span className="spacer" />
            <button className="send-btn" disabled={busy || !text.trim()} onClick={send} title="send">
              ↑
            </button>
          </div>
        </div>
        {commands && commands.length > 0 && (
          <div className="commands">
            {commands.map((c) => (
              <button
                key={c.name}
                className="command-chip"
                title={c.description}
                onClick={() => setText((t) => (t.startsWith('/') ? `/${c.name} ` : `/${c.name} ${t}`))}
              >
                /{c.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function EntryRow({
  entry,
  sessionId,
  last
}: {
  entry: ChatEntry
  sessionId: string
  last: boolean
}) {
  return (
    <div className="entry-row">
      <div className="rail">
        <RailNode entry={entry} />
        {!last && <span className="rail-line" />}
      </div>
      <div className="entry-body">
        <EntryBody entry={entry} sessionId={sessionId} />
      </div>
    </div>
  )
}

function RailNode({ entry }: { entry: ChatEntry }) {
  switch (entry.kind) {
    case 'user':
      return <span className="rail-dot" style={{ background: 'var(--accent)' }} />
    case 'agent':
      return <span className="rail-node rn-agent">G</span>
    case 'thought':
      return <span className="rail-node rn-thought">◔</span>
    case 'tool': {
      const cls =
        entry.status === 'completed' ? 'rn-ok' : entry.status === 'failed' ? 'rn-fail' : 'rn-run'
      const mark = entry.status === 'completed' ? '✓' : entry.status === 'failed' ? '✕' : '◔'
      return <span className={`rail-node ${cls}`}>{mark}</span>
    }
    case 'permission':
      return <span className="rail-node rn-perm">!</span>
    case 'system':
      return <span className="rail-node rn-sys">·</span>
  }
}

function EntryBody({ entry, sessionId }: { entry: ChatEntry; sessionId: string }) {
  switch (entry.kind) {
    case 'user':
      return (
        <>
          <div className="entry-label">You</div>
          <div className="entry-text user">{entry.text}</div>
        </>
      )
    case 'agent':
      return <div className="entry-text">{entry.text}</div>
    case 'thought':
      return (
        <>
          <div className="entry-label">Thinking</div>
          <div className="entry-text thought">{entry.text}</div>
        </>
      )
    case 'tool':
      return (
        <div className="tool-block">
          <div className="tool-chip">
            <span className={`tool-status tool-${entry.status}`}>{entry.status}</span>
            {entry.toolKind && <span className="tk">[{entry.toolKind}]</span>}
            <span>{entry.title}</span>
          </div>
          {entry.detail && (
            <details>
              <summary className="tool-chip" style={{ borderRadius: '0 0 7px 7px', borderTop: 'none' }}>
                <span className="tk">output ▸</span>
              </summary>
              <pre className="tool-detail">{entry.detail}</pre>
            </details>
          )}
        </div>
      )
    case 'permission':
      return (
        <div className="perm-card">
          <div className="perm-title">
            <span style={{ color: 'var(--yellow)' }}>🔓</span>
            {entry.title}
          </div>
          {entry.chosen ? (
            <div className="perm-chosen">
              → {entry.options.find((o) => o.optionId === entry.chosen)?.name ?? entry.chosen}
              {entry.chosen === 'auto' ? ' (auto)' : ''}
            </div>
          ) : (
            <div className="perm-buttons">
              {entry.options.map((o) => (
                <button
                  key={o.optionId}
                  className={o.kind?.startsWith('allow') ? 'allow-btn' : 'reject-btn'}
                  onClick={() =>
                    window.gurt.sessionPermission(sessionId, entry.id, o.optionId).catch(console.error)
                  }
                >
                  {o.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )
    case 'system':
      return <div className="entry-text sys">{entry.text}</div>
  }
}

function PlanPanel({
  plan,
  open,
  onToggle
}: {
  plan: PlanEntry[]
  open: boolean
  onToggle: () => void
}) {
  const done = plan.filter((p) => p.status === 'completed').length
  const running = plan.some((p) => p.status === 'in_progress')
  const pct = plan.length ? Math.round((done / plan.length) * 100) : 0
  return (
    <div className="plan-panel">
      <div className="plan-toggle" onClick={onToggle}>
        <svg
          className="plan-chevron"
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
        <span>TODO</span>
        <span style={{ color: 'var(--text-dim3)', fontWeight: 400 }}>
          {done} / {plan.length}
        </span>
        <div className="plan-bar">
          <div style={{ width: `${pct}%` }} />
        </div>
        {running && <span className="plan-running">running</span>}
      </div>
      {open && (
        <div className="plan-list">
          {plan.map((p, i) => (
            <div
              key={i}
              className={`plan-item ${
                p.status === 'completed' ? 'done' : p.status === 'in_progress' ? 'active' : ''
              }`}
            >
              <span className="pm">
                {p.status === 'completed' ? '✓' : p.status === 'in_progress' ? '›' : '·'}
              </span>
              {p.content}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
