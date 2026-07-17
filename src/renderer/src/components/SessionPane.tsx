import { useEffect, useState } from 'react'
import type { SessionSnapshot, Tree } from '../../../shared/types'
import { agentName, useAgents } from '../useAgents'
import { alertDialog, confirmDialog } from '../dialog'
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

function Header({ snapshot }: { snapshot: SessionSnapshot }) {
  const { info } = snapshot
  const agents = useAgents()
  return (
    <div className="chat-header">
      <span>
        {info.workspace} / {info.task} / {info.envRepo} — {info.title}
      </span>
      <span className={`chip mark-${info.state}`}>{info.state}</span>
      {info.agent && <span className="chip">{agentName(agents, info.agent)}</span>}
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
            <span className="chip">{info.envRepo}</span>
            <span className="chip">{info.agent ? agentName(agents, info.agent) : 'no agent'}</span>
            <span className="chip">{info.autoAllow === false ? 'manual' : 'auto'}</span>
            {info.gitAccess && <span className="chip chip-git">git</span>}
            {info.mcp?.map((m) => (
              <span key={m.id} className="chip chip-mcp" title={`MCP ${m.id} · ${m.mode}`}>
                {m.id}
                {m.mode === 'read-only' ? ' ᴿᴼ' : ''}
              </span>
            ))}
            <span className="spacer" />
            <button onClick={() => setEditOpen(true)}>Edit settings</button>
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
              disabled={!text.trim()}
              onClick={async () => {
                if (text !== info.startPrompt) await window.gurt.sessionEditPrompt(sessionId, text)
                window.gurt.sessionRun(sessionId).catch((e) => alertDialog(String(e)))
              }}
            >
              Run now
            </button>
            <button
              disabled={!text.trim()}
              onClick={async () => {
                if (text !== info.startPrompt) await window.gurt.sessionEditPrompt(sessionId, text)
                window.gurt.sessionEnqueue(sessionId).catch((e) => alertDialog(String(e)))
              }}
            >
              Add to queue
            </button>
            <button onClick={del}>Delete</button>
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
            <button onClick={() => window.gurt.sessionCancelQueue(sessionId).catch((e) => alertDialog(String(e)))}>
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
