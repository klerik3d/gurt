import { useEffect, useState } from 'react'
import type { SessionSnapshot, Tree } from '../../../shared/types'
import { roleLocksClone, sessionRole, sessionStatus } from '../../../shared/types'
import { agentKind, agentName, useAgents } from '../useAgents'
import { useMcpEntries, useMcpFailures } from '../useMcp'
import { resolveMcpSelection } from '../../../shared/mcp'
import { alertDialog } from '../dialog'
import { logErr } from '../log'
import { SESSION_DOT } from '../status'
import { Dot } from './icons'
import { AgentMark, EnvRepoMarks, McpFailBanner, McpMarks, NetMark, RoleMark } from './tags'
import { TrafficPanel } from './Network'
import { Chat } from './Chat'
import { ConfigTab } from './ConfigTab'
import { SessionMenu, deleteSession, duplicateSession } from './SessionActions'
import { TabBar, type SessionTab } from './SessionTabs'
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
    return (
      <Chat
        tree={tree}
        snapshot={snapshot}
        sessionId={sessionId}
        log={log}
        onSelect={onSelect}
        onDeleted={onDeleted}
      />
    )

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
  activeTab,
  onTab,
  onSelect,
  onDeleted
}: {
  snapshot: SessionSnapshot
  activeTab: SessionTab
  onTab: (t: SessionTab) => void
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
      <TabBar active={activeTab} onChange={onTab} />
      <span className="spacer" />
      <Dot tone={dot.tone} pulse={dot.pulse} />
      <span className="chat-title">
        {info.task} / {info.title}
      </span>
      <span className="tag">{info.state}</span>
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
  const mcpFailures = useMcpFailures(sessionId)
  const [text, setText] = useState(info.startPrompt)
  const [activeTab, setActiveTab] = useState<SessionTab>('chat')

  // Keep the editor in sync when the persisted prompt changes elsewhere, and
  // land back on the chat tab when the selection switches to another session.
  useEffect(() => {
    setText(info.startPrompt)
    setActiveTab('chat')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])
  useEffect(() => {
    setText(info.startPrompt)
  }, [info.startPrompt])

  const del = async () => {
    if (await deleteSession(info)) onDeleted()
  }
  const copy = () => duplicateSession(sessionId, (c) => onSelect(c.id))

  // A start needs an environment, a repository and an agent — a bare draft
  // (created with none of these picked) has all three blank until the Config
  // tab fills them in.
  const missing = !info.env ? 'an environment' : !info.repos.length ? 'a repository' : !info.agent ? 'an agent' : null
  const canRun = !!text.trim() && !missing

  return (
    <div className="session-pane">
      <Header
        snapshot={snapshot}
        activeTab={activeTab}
        onTab={setActiveTab}
        onSelect={onSelect}
        onDeleted={onDeleted}
      />
      {snapshot.startError && (
        <div className="error env-error">start failed: {snapshot.startError}</div>
      )}
      {/* A local MCP server that would not start does not fail the session
          (§6), so this is the only place its reason shows up. */}
      <McpFailBanner failures={mcpFailures} />
      {/* A session that has run keeps what its proxy was seen doing, and this
          pane is where it lands once the session goes idle — which is exactly
          when someone asks why a host could not be reached (§8). */}
      {activeTab === 'chat' && <TrafficPanel sessionId={sessionId} network={info.network} />}

      {activeTab === 'config' && <ConfigTab tree={tree} snapshot={snapshot} />}

      {activeTab === 'logs' && (
        <pre className="env-log">{log.length ? log.join('\n') : 'no logs yet'}</pre>
      )}

      {activeTab === 'chat' && info.state === 'draft' && (
        <div className="draft-body">
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
              disabled={!canRun}
              title={missing ? `pick ${missing} first (Config tab)` : undefined}
              onClick={run(async () => {
                if (text !== info.startPrompt) await window.gurt.sessionEditPrompt(sessionId, text)
                window.gurt.sessionRun(sessionId).catch((e: unknown) => alertDialog(String(e)))
              })}
            >
              Run now
            </button>
            <button
              className="btn"
              disabled={!canRun}
              title={missing ? `pick ${missing} first (Config tab)` : undefined}
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
        </div>
      )}

      {activeTab === 'chat' && info.state === 'queued' && (
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

      {activeTab === 'chat' && info.state === 'starting' && (
        <div className="draft-body">
          <div className="queue-badge">starting…</div>
          <pre className="draft-prompt readonly">{info.startPrompt}</pre>
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
