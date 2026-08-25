import { useEffect, useState } from 'react'
import type { SessionSnapshot, Tree } from '../../../shared/types'
import { roleLocksClone, sessionRole, sessionStatus } from '../../../shared/types'
import { agentKind, agentName, useAgents } from '../useAgents'
import { useMcpEntries } from '../useMcp'
import { resolveMcpSelection } from '../../../shared/mcp'
import { alertDialog } from '../dialog'
import { logErr } from '../log'
import { SESSION_DOT } from '../status'
import { Dot } from './icons'
import {
  AgentMark,
  AgentTag,
  EnvRepoMarks,
  EnvTag,
  McpMarks,
  McpTag,
  NetMark,
  NetTag,
  RepoTag,
  RoleMark,
  RoleTag
} from './tags'
import { TrafficPanel } from './Network'
import { Chat } from './Chat'
import { SessionMenu, deleteSession, duplicateSession } from './SessionActions'
import { NewSessionModal } from './Sidebar'
import { VscodeButton } from './VscodeButton'
import { run } from '../async'

export function SessionPane({
  tree,
  snapshot,
  sessionId,
  queuePosition,
  log,
  onSelect,
  onDeleted
}: {
  tree: Tree | null
  snapshot?: SessionSnapshot | undefined
  sessionId: string
  queuePosition?: number | undefined
  log: string[]
  /** Select another session — where a duplicate's fresh draft is handed to. */
  onSelect: (id: string) => void
  onDeleted: () => void
}) {
  if (!snapshot) return <div className="placeholder">loading session…</div>
  if (snapshot.info.state === 'started')
    return <Chat snapshot={snapshot} sessionId={sessionId} onSelect={onSelect} onDeleted={onDeleted} />

  return (
    <NonStartedPane
      tree={tree}
      snapshot={snapshot}
      sessionId={sessionId}
      queuePosition={queuePosition}
      log={log}
      onSelect={onSelect}
      onDeleted={onDeleted}
    />
  )
}

function Header({
  snapshot,
  onSelect,
  onDeleted
}: {
  snapshot: SessionSnapshot
  onSelect: (id: string) => void
  onDeleted: () => void
}) {
  const { info } = snapshot
  const agents = useAgents()
  const mcpOffered = useMcpEntries(info.workspace)
  const mcp = resolveMcpSelection(info.mcp, mcpOffered)
  const dot = SESSION_DOT[sessionStatus(info)]
  return (
    <div className="chat-head">
      <Dot tone={dot.tone} pulse={dot.pulse} />
      <span className="chat-title">
        {info.task} / {info.title}
      </span>
      <span className="tag">{info.state}</span>
      <span className="spacer" />
      <span className="chat-pill">
        <RoleMark role={sessionRole(info)} />
        <EnvRepoMarks env={info.env} repos={info.repos} task={info.task} />
        {/* Own element, not a bare string: adjacent text nodes collapse into one
            flex item and lose the row's gap. */}
        {info.agent && (
          <span>
            · <AgentMark kind={agentKind(agents, info.agent)} name={agentName(agents, info.agent)} />
          </span>
        )}
        {mcp.length > 0 && (
          <span>
            · <McpMarks resolved={mcp} />
          </span>
        )}
        {info.network?.internal && (
          <span>
            · <NetMark network={info.network} />
          </span>
        )}
      </span>
      <VscodeButton info={info} />
      <SessionMenu info={info} onSelect={onSelect} onDeleted={onDeleted} />
    </div>
  )
}

function NonStartedPane({
  tree,
  snapshot,
  sessionId,
  queuePosition,
  log,
  onSelect,
  onDeleted
}: {
  tree: Tree | null
  snapshot: SessionSnapshot
  sessionId: string
  queuePosition?: number | undefined
  log: string[]
  onSelect: (id: string) => void
  onDeleted: () => void
}) {
  const { info } = snapshot
  const agents = useAgents()
  const mcpOffered = useMcpEntries(info.workspace)
  const mcp = resolveMcpSelection(info.mcp, mcpOffered)
  const [text, setText] = useState(info.startPrompt)
  const [editOpen, setEditOpen] = useState(false)

  // Keep the editor in sync when the persisted prompt changes elsewhere.
  useEffect(() => {
    setText(info.startPrompt)
  }, [info.startPrompt, sessionId])

  const del = async () => {
    if (await deleteSession(info)) onDeleted()
  }
  const copy = () => duplicateSession(sessionId, (c) => onSelect(c.id))

  return (
    <div className="session-pane">
      <Header snapshot={snapshot} onSelect={onSelect} onDeleted={onDeleted} />
      {snapshot.startError && (
        <div className="error env-error">start failed: {snapshot.startError}</div>
      )}
      {/* A session that has run keeps what its proxy was seen doing, and this
          pane is where it lands once the session goes idle — which is exactly
          when someone asks why a host could not be reached (§8). */}
      <TrafficPanel sessionId={sessionId} network={info.network} />

      {info.state === 'draft' && (
        <div className="draft-body">
          <div className="draft-settings">
            <RoleTag role={sessionRole(info)} />
            <EnvTag name={info.env} />
            {info.repos.length ? (
              info.repos.map((r) => <RepoTag key={r} name={r} />)
            ) : (
              <RepoTag name="no repo" title="no repository — Run/Queue disabled" />
            )}
            {info.agent ? (
              <AgentTag kind={agentKind(agents, info.agent)} name={agentName(agents, info.agent)} />
            ) : (
              <span className="tag">no agent</span>
            )}
            <span className="tag">{info.autoAllow === false ? 'manual' : 'auto'}</span>
            {mcp.map((r) => (
              <McpTag key={r.selection.id} {...r} />
            ))}
            <NetTag network={info.network} />
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
                window.gurt.sessionEditPrompt(sessionId, text).catch(logErr('sessionEditPrompt'))
            }}
          />
          <div className="row-buttons">
            <button
              className="btn btn-primary"
              disabled={!text.trim() || !info.repos.length}
              title={!info.repos.length ? 'pick a repository first (Edit settings)' : undefined}
              onClick={run(async () => {
                if (text !== info.startPrompt) await window.gurt.sessionEditPrompt(sessionId, text)
                window.gurt.sessionRun(sessionId).catch((e: unknown) => alertDialog(String(e)))
              })}
            >
              Run now
            </button>
            <button
              className="btn"
              disabled={!text.trim() || !info.repos.length}
              title={!info.repos.length ? 'pick a repository first (Edit settings)' : undefined}
              onClick={run(async () => {
                if (text !== info.startPrompt) await window.gurt.sessionEditPrompt(sessionId, text)
                window.gurt.sessionEnqueue(sessionId).catch((e: unknown) => alertDialog(String(e)))
              })}
            >
              Add to queue
            </button>
            <span className="spacer" />
            <button className="btn" onClick={run(copy)} title="copy these settings and prompt into a new draft">
              Duplicate
            </button>
            <button className="btn btn-danger-text" onClick={run(del)}>
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
                {roleLocksClone(sessionRole(info))
                  ? 'starts when its repository is free — the session holding it releases it as soon as its turn ends'
                  : 'starts as soon as the queue reaches it — a researcher mounts its repos read-only and waits for no one'}
              </div>
            </div>
          )}
          <pre className="draft-prompt readonly">{info.startPrompt}</pre>
          <div className="row-buttons">
            <button
              className="btn"
              onClick={run(() => window.gurt.sessionCancelQueue(sessionId).catch((e: unknown) => alertDialog(String(e))))}
            >
              Cancel
            </button>
            <span className="spacer" />
            <button className="btn" onClick={run(copy)} title="copy these settings and prompt into a new draft">
              Duplicate
            </button>
            <button className="btn btn-danger-text" onClick={run(del)}>
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
          {/* A start is exactly when a misconfigured session shows itself, and
              it can take minutes — the way out is offered here, not only after
              it finishes. Deleting mid-start takes down whatever the start has
              already provisioned. */}
          <div className="row-buttons">
            <span className="spacer" />
            <button className="btn" onClick={run(copy)} title="copy these settings and prompt into a new draft">
              Duplicate
            </button>
            <button className="btn btn-danger-text" onClick={run(del)}>
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
