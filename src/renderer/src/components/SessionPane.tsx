import { useEffect, useState } from 'react'
import type { SessionSnapshot, Tree } from '../../../shared/types'
import { agentName, useAgents } from '../useAgents'
import { alertDialog, confirmDialog } from '../dialog'
import { Dot } from './icons'
import { Chat } from './Chat'
import { NewSessionModal } from './Sidebar'

export function SessionPane({
  tree,
  snapshot,
  sessionId,
  queuePosition,
  log,
  onDeleted
}: {
  tree: Tree | null
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
      tree={tree}
      snapshot={snapshot}
      sessionId={sessionId}
      queuePosition={queuePosition}
      log={log}
      onDeleted={onDeleted}
    />
  )
}

const STATE_DOT = {
  draft: { tone: 'outline' as const, pulse: false },
  queued: { tone: 'accent' as const, pulse: false },
  starting: { tone: 'yellow' as const, pulse: true },
  started: { tone: 'green' as const, pulse: false }
}

function Header({ snapshot }: { snapshot: SessionSnapshot }) {
  const { info } = snapshot
  const agents = useAgents()
  const dot = STATE_DOT[info.state]
  return (
    <div className="chat-head">
      <Dot tone={dot.tone} pulse={dot.pulse} />
      <span className="chat-title">
        {info.task} / {info.title}
      </span>
      <span className="tag">{info.state}</span>
      <span className="spacer" />
      <span className="chat-pill">
        {info.envRepo}
        {info.agent ? ` · ${agentName(agents, info.agent)}` : ''}
      </span>
    </div>
  )
}

function NonStartedPane({
  tree,
  snapshot,
  sessionId,
  queuePosition,
  log,
  onDeleted
}: {
  tree: Tree | null
  snapshot: SessionSnapshot
  sessionId: string
  queuePosition?: number
  log: string[]
  onDeleted: () => void
}) {
  const { info } = snapshot
  const agents = useAgents()
  const [text, setText] = useState(info.startPrompt)
  const [editOpen, setEditOpen] = useState(false)

  // Keep the editor in sync when the persisted prompt changes elsewhere.
  useEffect(() => {
    setText(info.startPrompt)
  }, [info.startPrompt, sessionId])

  const del = async () => {
    if (await confirmDialog(`Delete session "${info.title}"?`, { title: 'Delete session', confirmText: 'Delete', danger: true }))
      window.gurt.sessionDelete(sessionId).then(onDeleted).catch((e) => alertDialog(String(e)))
  }

  return (
    <div className="session-pane">
      <Header snapshot={snapshot} />
      {snapshot.startError && (
        <div className="error env-error">start failed: {snapshot.startError}</div>
      )}

      {info.state === 'draft' && (
        <div className="draft-body">
          <div className="draft-settings">
            <span className="tag">{info.envRepo}</span>
            <span className="tag">{info.agent ? agentName(agents, info.agent) : 'no agent'}</span>
            <span className="tag">{info.autoAllow === false ? 'manual' : 'auto'}</span>
            {info.gitAccess && <span className="tag tag-green">git</span>}
            {info.mcp?.map((m) => (
              <span key={m.id} className="tag tag-accent" title={`MCP ${m.id} · ${m.mode}`}>
                {m.id}
                {m.mode === 'read-only' ? ' ᴿᴼ' : ''}
              </span>
            ))}
            <span className="spacer" />
            <button className="btn btn-sm" onClick={() => setEditOpen(true)}>
              Edit settings
            </button>
          </div>
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
              className="btn btn-primary"
              disabled={!text.trim()}
              onClick={async () => {
                if (text !== info.startPrompt) await window.gurt.sessionEditPrompt(sessionId, text)
                window.gurt.sessionRun(sessionId).catch((e) => alertDialog(String(e)))
              }}
            >
              Run now
            </button>
            <button
              className="btn"
              disabled={!text.trim()}
              onClick={async () => {
                if (text !== info.startPrompt) await window.gurt.sessionEditPrompt(sessionId, text)
                window.gurt.sessionEnqueue(sessionId).catch((e) => alertDialog(String(e)))
              }}
            >
              Add to queue
            </button>
            <span className="spacer" />
            <button className="btn btn-danger-text" onClick={del}>
              Delete
            </button>
          </div>
          {editOpen && tree && (
            <NewSessionModal
              tree={tree}
              ws={info.workspace}
              task={info.task}
              edit={info}
              onClose={() => setEditOpen(false)}
              onCreated={() => setEditOpen(false)}
            />
          )}
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
            <button
              className="btn"
              onClick={() => window.gurt.sessionCancelQueue(sessionId).catch((e) => alertDialog(String(e)))}
            >
              Cancel
            </button>
            <span className="spacer" />
            <button className="btn btn-danger-text" onClick={del}>
              Delete
            </button>
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
