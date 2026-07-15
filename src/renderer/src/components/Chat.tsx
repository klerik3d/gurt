import { useEffect, useRef, useState } from 'react'
import type {
  ChatEntry,
  CommandInfo,
  PlanEntry,
  SessionModes,
  SessionSnapshot
} from '../../../shared/types'

/** Don't ping the main process on every keystroke — once per this interval is enough
 *  to keep postponing the env's idle auto-stop while the user is composing. */
const ACTIVITY_PING_INTERVAL_MS = 5_000

export function Chat({ snapshot, sessionId }: { snapshot?: SessionSnapshot; sessionId: string }) {
  const [planOpen, setPlanOpen] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [snapshot?.entries.length, snapshot?.entries[snapshot.entries.length - 1]?.id])

  if (!snapshot) return <div className="placeholder">loading session…</div>

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

      <Composer
        sessionId={sessionId}
        busy={busy}
        autoAllow={autoAllow}
        modes={modes}
        commands={commands ?? []}
      />
    </div>
  )
}

const MAX_TA_HEIGHT = 220

function Composer({
  sessionId,
  busy,
  autoAllow,
  modes,
  commands
}: {
  sessionId: string
  busy: boolean
  autoAllow: boolean
  modes?: SessionModes
  commands: CommandInfo[]
}) {
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  const [slashOpen, setSlashOpen] = useState(false)
  const [modeOpen, setModeOpen] = useState(false)
  const [cmdIdx, setCmdIdx] = useState(0)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const lastActivityPingRef = useRef(0)

  const pingActivity = () => {
    const now = performance.now()
    if (now - lastActivityPingRef.current < ACTIVITY_PING_INTERVAL_MS) return
    lastActivityPingRef.current = now
    window.gurt.sessionActivity(sessionId).catch(console.error)
  }

  const autoGrow = () => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, MAX_TA_HEIGHT) + 'px'
  }

  // Re-fit whenever the value changes (send clears it, pickCommand extends it).
  useEffect(autoGrow, [text])

  // Close the mode menu on an outside click.
  useEffect(() => {
    if (!modeOpen) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setModeOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [modeOpen])

  /** The `/token` currently being typed, or null when the slash menu shouldn't show.
   *  Active only while the text is a single `/word` with no whitespace yet. */
  const slashToken =
    text.startsWith('/') && !/\s/.test(text) ? text.slice(1).toLowerCase() : null
  const filteredCmds =
    slashToken === null
      ? []
      : commands.filter(
          (c) =>
            c.name.toLowerCase().includes(slashToken) ||
            (c.description ?? '').toLowerCase().includes(slashToken)
        )
  const showSlash = slashOpen && slashToken !== null && commands.length > 0

  // Keep the highlighted command in range as the filtered list shrinks.
  useEffect(() => {
    if (cmdIdx >= filteredCmds.length) setCmdIdx(0)
  }, [filteredCmds.length, cmdIdx])

  const send = () => {
    const t = text.trim()
    if (!t || busy) return
    setText('')
    setSlashOpen(false)
    window.gurt.sessionPrompt(sessionId, t).catch(console.error)
  }

  const pickCommand = (name: string) => {
    setText(`/${name} `)
    setSlashOpen(false)
    setCmdIdx(0)
    taRef.current?.focus()
  }

  const openSlashFromButton = () => {
    if (busy) return
    setModeOpen(false)
    if (showSlash) {
      setSlashOpen(false)
      return
    }
    setText((t) => (t.trim() === '' ? '/' : t))
    setSlashOpen(true)
    setCmdIdx(0)
    taRef.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSlash) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCmdIdx((i) => Math.min(i + 1, filteredCmds.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCmdIdx((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const c = filteredCmds[cmdIdx]
        if (c) {
          e.preventDefault()
          pickCommand(c.name)
          return
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashOpen(false)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const canSend = !busy && text.trim().length > 0
  const curMode = modes?.availableModes.find((m) => m.id === modes.currentModeId)

  return (
    <div className="composer-wrap">
      <div
        ref={rootRef}
        className={`composer ${busy ? 'disabled' : ''} ${focused && !busy ? 'focused' : ''}`}
      >
        {showSlash && (
          <div className="cmp-menu slash-menu">
            {filteredCmds.length === 0 ? (
              <div className="cmp-menu-empty">No matching commands</div>
            ) : (
              filteredCmds.map((c, i) => (
                <div
                  key={c.name}
                  className={`cmp-menu-item ${i === cmdIdx ? 'active' : ''}`}
                  onMouseEnter={() => setCmdIdx(i)}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pickCommand(c.name)
                  }}
                >
                  <span className="cmd-name">/{c.name}</span>
                  {c.description && <span className="cmd-desc">{c.description}</span>}
                </div>
              ))
            )}
          </div>
        )}

        {modeOpen && modes && modes.availableModes.length > 0 && (
          <div className="cmp-menu mode-menu">
            <div className="cmp-menu-head">MODE</div>
            {modes.availableModes.map((m) => (
              <div
                key={m.id}
                className="cmp-menu-item"
                onMouseDown={(e) => {
                  e.preventDefault()
                  setModeOpen(false)
                  window.gurt.sessionSetMode(sessionId, m.id).catch((er) => alert(String(er)))
                }}
              >
                <span className="mode-mark">{m.id === modes.currentModeId ? '✓' : ''}</span>
                <span>{m.name}</span>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={taRef}
          rows={1}
          className="composer-input"
          placeholder={busy ? 'agent is working…' : 'Ask gurt, or type / for commands…'}
          value={text}
          disabled={busy}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => {
            const v = e.target.value
            setText(v)
            // Re-arm the menu whenever a fresh slash token is being typed.
            if (v.startsWith('/') && !/\s/.test(v)) setSlashOpen(true)
            else if (!v.startsWith('/')) setSlashOpen(false)
            pingActivity()
          }}
          onKeyDown={onKeyDown}
        />

        <div className="composer-toolbar">
          <button
            className={`tbtn tbtn-slash ${showSlash ? 'active' : ''}`}
            title="Commands"
            disabled={busy}
            onClick={openSlashFromButton}
          >
            /
          </button>
          <button
            className={`tbtn ${autoAllow ? 'active' : ''}`}
            title={autoAllow ? 'auto-allow on' : 'auto-allow off'}
            onClick={() => window.gurt.sessionAutoAllow(sessionId, !autoAllow)}
          >
            {autoAllow ? '🔓' : '🔒'}
          </button>
          <span className="spacer" />
          {text.length > 0 && <span className="char-count">{text.length} chars</span>}
          {modes && modes.availableModes.length > 0 && (
            <button
              className={`mode-pill ${modeOpen ? 'active' : ''}`}
              onClick={() => {
                setSlashOpen(false)
                setModeOpen((o) => !o)
              }}
            >
              <span style={{ color: 'var(--green)' }}>⚡</span>
              {curMode?.name ?? 'Mode'}
              <span className="caret">▾</span>
            </button>
          )}
          <button className="send-btn" disabled={!canSend} onClick={send} title="send">
            ↑
          </button>
        </div>
      </div>
      <div className="composer-hint">
        Enter to send · Shift+Enter for newline · <span className="k">/</span> for commands
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
