import { useEffect, useState } from 'react'
import type { SessionSnapshot } from '../../../shared/types'
import { Chat } from './Chat'

export function SessionPane({
  snapshot,
  sessionId,
  queuePosition,
  log,
  onDeleted
}: {
  snapshot?: SessionSnapshot
  sessionId: string
  queuePosition?: number
  log: string[]
  onDeleted: () => void
}) {
  if (!snapshot) return <div className="placeholder">loading session…</div>
  if (snapshot.info.state === 'started') return <Chat snapshot={snapshot} sessionId={sessionId} />

  return (
    <NonStartedPane
      snapshot={snapshot}
      sessionId={sessionId}
      queuePosition={queuePosition}
      log={log}
      onDeleted={onDeleted}
    />
  )
}

function Header({ snapshot }: { snapshot: SessionSnapshot }) {
  const { info } = snapshot
  return (
    <div className="chat-header">
      <span>
        {info.workspace} / {info.task} / {info.envRepo} — {info.title}
      </span>
      <span className={`chip mark-${info.state}`}>{info.state}</span>
      {info.agent && <span className="chip">{info.agent}</span>}
    </div>
  )
}

function NonStartedPane({
  snapshot,
  sessionId,
  queuePosition,
  log,
  onDeleted
}: {
  snapshot: SessionSnapshot
  sessionId: string
  queuePosition?: number
  log: string[]
  onDeleted: () => void
}) {
  const { info } = snapshot
  const [text, setText] = useState(info.startPrompt)

  // Keep the editor in sync when the persisted prompt changes elsewhere.
  useEffect(() => {
    setText(info.startPrompt)
  }, [info.startPrompt, sessionId])

  const del = () => {
    if (window.confirm(`Delete session "${info.title}"?`))
      window.gurt.sessionDelete(sessionId).then(onDeleted).catch((e) => alert(String(e)))
  }

  return (
    <div className="session-pane">
      <Header snapshot={snapshot} />
      {snapshot.startError && (
        <div className="error env-error">start failed: {snapshot.startError}</div>
      )}

      {info.state === 'draft' && (
        <div className="draft-body">
          <textarea
            className="draft-prompt"
            rows={10}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => {
              if (text !== info.startPrompt)
                window.gurt.sessionEditPrompt(sessionId, text).catch(console.error)
            }}
          />
          <div className="row-buttons">
            <button
              disabled={!text.trim()}
              onClick={async () => {
                if (text !== info.startPrompt) await window.gurt.sessionEditPrompt(sessionId, text)
                window.gurt.sessionRun(sessionId).catch((e) => alert(String(e)))
              }}
            >
              Run now
            </button>
            <button
              disabled={!text.trim()}
              onClick={async () => {
                if (text !== info.startPrompt) await window.gurt.sessionEditPrompt(sessionId, text)
                window.gurt.sessionEnqueue(sessionId).catch((e) => alert(String(e)))
              }}
            >
              Add to queue
            </button>
            <button onClick={del}>Delete</button>
          </div>
        </div>
      )}

      {info.state === 'queued' && (
        <div className="draft-body">
          {queuePosition != null && (
            <div className="queue-badge">
              queued — position #{queuePosition}
              <div className="dim">
                starts when this repo's environment is stopped (an agent finishes by its env being
                stopped)
              </div>
            </div>
          )}
          <pre className="draft-prompt readonly">{info.startPrompt}</pre>
          <div className="row-buttons">
            <button onClick={() => window.gurt.sessionCancelQueue(sessionId).catch((e) => alert(String(e)))}>
              Cancel
            </button>
            <button onClick={del}>Delete</button>
          </div>
        </div>
      )}

      {info.state === 'starting' && (
        <div className="draft-body">
          <div className="queue-badge">starting…</div>
          <pre className="draft-prompt readonly">{info.startPrompt}</pre>
          <pre className="env-log">{log.length ? log.join('\n') : 'launching…'}</pre>
        </div>
      )}
    </div>
  )
}
