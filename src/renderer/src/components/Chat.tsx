import { useEffect, useRef, useState } from 'react'
import type { ChatEntry, SessionSnapshot } from '../../../shared/types'

export function Chat({ snapshot, sessionId }: { snapshot?: SessionSnapshot; sessionId: string }) {
  const [text, setText] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

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

  return (
    <div className="chat">
      <div className="chat-header">
        <span>
          {snapshot.info.workspace} / {snapshot.info.task} / {snapshot.info.envRepo} —{' '}
          {snapshot.info.title}
        </span>
        {snapshot.info.agent && <span className="agent-badge">{snapshot.info.agent}</span>}
        <span className="spacer" />
        {snapshot.modes && snapshot.modes.availableModes.length > 0 && (
          <select
            className="mode-select"
            value={snapshot.modes.currentModeId}
            onChange={(e) => window.gurt.sessionSetMode(sessionId, e.target.value).catch((er) => alert(String(er)))}
          >
            {snapshot.modes.availableModes.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        )}
        <label className="row auto-allow">
          <input
            type="checkbox"
            checked={snapshot.autoAllow}
            onChange={(e) => window.gurt.sessionAutoAllow(sessionId, e.target.checked)}
          />
          auto-allow
        </label>
        {snapshot.busy && (
          <>
            <span className="busy">working…</span>
            <button onClick={() => window.gurt.sessionCancel(sessionId)}>Stop</button>
          </>
        )}
      </div>
      <div className="chat-log">
        {snapshot.entries.map((e) => (
          <Entry key={e.id} entry={e} sessionId={sessionId} />
        ))}
        <div ref={bottomRef} />
      </div>
      {snapshot.plan && snapshot.plan.length > 0 && (
        <div className="plan">
          {snapshot.plan.map((p, i) => (
            <div key={i} className={`plan-entry plan-${p.status}`}>
              <span className="plan-mark">
                {p.status === 'completed' ? '✓' : p.status === 'in_progress' ? '›' : '·'}
              </span>
              {p.content}
            </div>
          ))}
        </div>
      )}
      <div className="chat-input">
        <textarea
          rows={3}
          placeholder={snapshot.busy ? 'agent is working…' : 'prompt (Enter to send, Shift+Enter for newline)'}
          value={text}
          disabled={snapshot.busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button disabled={snapshot.busy || !text.trim()} onClick={send}>
          Send
        </button>
      </div>
      {snapshot.commands && snapshot.commands.length > 0 && (
        <div className="commands">
          {snapshot.commands.map((c) => (
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
  )
}

function Entry({ entry, sessionId }: { entry: ChatEntry; sessionId: string }) {
  switch (entry.kind) {
    case 'user':
      return <div className="entry entry-user">{entry.text}</div>
    case 'agent':
      return <div className="entry entry-agent">{entry.text}</div>
    case 'thought':
      return <div className="entry entry-thought">{entry.text}</div>
    case 'tool':
      return (
        <div className="entry entry-tool">
          <span className={`tool-status tool-${entry.status}`}>{entry.status}</span>{' '}
          {entry.toolKind && <span className="dim">[{entry.toolKind}]</span>} {entry.title}
          {entry.detail && (
            <details>
              <summary>output</summary>
              <pre className="tool-detail">{entry.detail}</pre>
            </details>
          )}
        </div>
      )
    case 'permission':
      return (
        <div className="entry entry-permission">
          <div className="permission-title">🔐 {entry.title}</div>
          {entry.chosen ? (
            <div className="dim">
              → {entry.options.find((o) => o.optionId === entry.chosen)?.name ?? entry.chosen}
              {entry.chosen === 'auto' ? ' (auto)' : ''}
            </div>
          ) : (
            <div className="permission-buttons">
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
      return <div className="entry entry-system">{entry.text}</div>
  }
}
