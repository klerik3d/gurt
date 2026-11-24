import { useEffect, useMemo, useState } from 'react'
import {
  missingRepoReason,
  repoMode,
  type PromptImage,
  type SessionSnapshot,
  type Tree
} from '../../../shared/types'
import { useMcpFailures } from '../useMcp'
import { alertDialog } from '../dialog'
import { logErr } from '../log'
import { McpFailBanner } from './tags'
import { TrafficPanel } from './Network'
import { Chat, ImageThumbs, pastedImages, readImages, type ComposerNote } from './Chat'
import { ConfigTab } from './ConfigTab'
import { SessionMenu, deleteSession, duplicateSession } from './SessionActions'
import { TabBar, useSessionTab, type SessionTab } from './SessionTabs'
import { ContainerTerminalButton } from './ContainerTerminalButton'
import { FileLinkScopeProvider } from '../fileLinks'
import { run } from '../async'

export function SessionPane({
  tree,
  snapshot,
  sessionId,
  queuePosition,
  log,
  composerNote,
  onSelect,
  onDeleted
}: {
  tree: Tree | null
  snapshot?: SessionSnapshot | undefined
  sessionId: string
  queuePosition?: number | undefined
  log: string[]
  /** A line above a started session's composer — see `Chat`. */
  composerNote?: ComposerNote | undefined
  /** Select another session — where a duplicate's fresh draft is handed to. */
  onSelect: (id: string) => void
  onDeleted: () => void
}) {
  // Paths in the agent's messages resolve against this session's scope.
  const linkWs = snapshot?.info.workspace
  const linkTask = snapshot?.info.task
  const linkRepos = snapshot?.info.repos.join('\n') ?? ''
  const linkScope = useMemo(
    () => (linkWs !== undefined && linkTask !== undefined
      ? { ws: linkWs, task: linkTask, repos: linkRepos ? linkRepos.split('\n') : [] }
      : null),
    [linkWs, linkTask, linkRepos]
  )
  if (!snapshot) return <div className="placeholder">loading session…</div>
  if (snapshot.info.state === 'started')
    return (
      <FileLinkScopeProvider scope={linkScope}>
        <Chat
          tree={tree}
          snapshot={snapshot}
          sessionId={sessionId}
          log={log}
          composerNote={composerNote}
          onSelect={onSelect}
          onDeleted={onDeleted}
        />
      </FileLinkScopeProvider>
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

/** Images pasted into a draft, by session — kept outside React state so they
 *  survive switching to another session and back (main holds a copy for the start). */
const draftImages = new Map<string, PromptImage[]>()

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
  return (
    <div className="chat-head">
      <TabBar active={activeTab} onChange={onTab} />
      <span className="spacer" />
      <ContainerTerminalButton info={info} />
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
  const [images, setImagesState] = useState<PromptImage[]>(draftImages.get(sessionId) ?? [])
  const [activeTab, setActiveTab] = useSessionTab(sessionId)
  // Run flips `info.state` away from 'draft', which normally swaps this whole
  // body out on its own — but that swap rides the same IPC round trip the
  // click kicked off, so for a beat the draft view (and its button) just sits
  // there with nothing to show the click landed. This is the beat.
  const [submitting, setSubmitting] = useState(false)

  // Keep the editor in sync when the selection switches to another session.
  useEffect(() => {
    setText(info.startPrompt)
    setImagesState(draftImages.get(sessionId) ?? [])
    setSubmitting(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])
  useEffect(() => {
    setText(info.startPrompt)
  }, [info.startPrompt])
  // This pane outlives the draft → starting/queued → draft round trip of a
  // failed start, so "the click landed" has to end with the state that answered
  // it — otherwise the returned draft keeps its buttons disabled until the
  // selection changes.
  useEffect(() => {
    setSubmitting(false)
  }, [info.state])

  /** Images follow the draft to main (memory only) so a queued start has them too. */
  const setImages = (next: PromptImage[]) => {
    if (next.length) draftImages.set(sessionId, next)
    else draftImages.delete(sessionId)
    setImagesState(next)
    window.gurt.sessionEditPrompt(sessionId, text, next).catch(logErr('sessionEditPrompt'))
  }
  // Unknown capabilities (never-run agent) count as yes; only an agent that said no turns it off.
  const imageOk = !snapshot.promptCapabilities || snapshot.promptCapabilities.image !== false

  const del = async () => {
    if (await deleteSession(info)) onDeleted()
  }
  const copy = () => duplicateSession(sessionId, (c) => onSelect(c.id))

  // A start needs an environment, a repository and an agent — a bare draft
  // (created with none of these picked) has all three blank until the Config
  // tab fills them in. Which repository is needed is the role's to say — a
  // `write` one for an executor, none at all for an operator
  // (docs/requirements-repo-mounts.md §4).
  const repoGap = missingRepoReason(info)
  const missing = !info.env
    ? 'an environment'
    : repoGap
      ? repoGap.startsWith('an executor') ? 'a repository mounted for write' : 'a repository'
      : !info.agent
        ? 'an agent'
        : null
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
      {/* A failed start is announced as an `error` notification (main's
          notifications.ts), not as a banner here. */}
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
            onPaste={(e) => {
              if (!imageOk) return
              const files = pastedImages(e)
              if (!files.length) return
              e.preventDefault()
              void readImages(files).then((added) => added.length && setImages([...images, ...added]))
            }}
            onBlur={() => {
              if (text !== info.startPrompt)
                window.gurt.sessionEditPrompt(sessionId, text, images).catch(logErr('sessionEditPrompt'))
            }}
          />
          <ImageThumbs images={images} onRemove={(i) => setImages(images.filter((_, j) => j !== i))} />
          <div className="row-buttons">
            {/* One way to launch: through the queue. It starts at once when
                nothing stands in the way, and otherwise waits — for the clone,
                the task's cap, or the account's plan limit — instead of
                failing, which is all a separate "Run now" could add. */}
            <button
              className="btn btn-primary"
              disabled={!canRun || submitting}
              title={missing ? `pick ${missing} first (Config tab)` : undefined}
              onClick={run(async () => {
                setSubmitting(true)
                try {
                  await window.gurt.sessionEditPrompt(sessionId, text, images)
                  await window.gurt.sessionEnqueue(sessionId)
                  // Main keeps them for the queued start; this copy is only the
                  // editor's — kept, so a cancelled wait comes back with them.
                } catch (e) {
                  await alertDialog(String(e))
                  setSubmitting(false)
                }
              })}
            >
              {submitting ? 'Starting…' : 'Run'}
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
                {snapshot.waiting ?? (info.repos.some((r) => repoMode(info, r) !== 'read')
                  ? 'starts when its repositories are free — the session holding one releases it as soon as its turn ends'
                  : 'starts as soon as the queue reaches it — it only reads live trees and waits for no one')}
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
