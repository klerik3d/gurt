import { useEffect, useMemo, useRef, useState } from 'react'
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
import { TabBar, reviewOf, reviewerRun, useSessionTab, type SessionTab } from './SessionTabs'
import { ContainerTerminalButton } from './ContainerTerminalButton'
import { FileLinkScopeProvider } from '../fileLinks'
import { run } from '../async'
import { ReviewTab } from '../../../rpm/ui'
import { clearReviewJump, useReviewJump } from '../reviewJump'
import { ReviewHost } from './ReviewHost'

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
        <ReviewHost info={snapshot.info} tree={tree} onSelect={onSelect}>
          <Chat
            tree={tree}
            snapshot={snapshot}
            sessionId={sessionId}
            log={log}
            composerNote={composerNote}
            onSelect={onSelect}
            onDeleted={onDeleted}
          />
        </ReviewHost>
      </FileLinkScopeProvider>
    )

  return (
    <ReviewHost info={snapshot.info} tree={tree} onSelect={onSelect}>
      <NonStartedPane
        tree={tree}
        snapshot={snapshot}
        sessionId={sessionId}
        queuePosition={queuePosition}
        log={log}
        onSelect={onSelect}
        onDeleted={onDeleted}
      />
    </ReviewHost>
  )
}

/** Images pasted into a draft, by session — kept outside React state so they
 *  survive switching to another session and back (main holds a copy for the start). */
const draftImages = new Map<string, PromptImage[]>()

/** A draft's prompt as last typed, by session — ahead of main's copy between a
 *  keystroke and the save that leaving the draft triggers, so coming back never
 *  shows the older text main happened to echo last. */
const draftTexts = new Map<string, string>()

/** Prompts this renderer sent to main whose snapshot has not come back yet, by
 *  session. Outlives the pane, so an echo landing after a leave-and-return is
 *  still known as ours — it says nothing about what has been typed since. */
const pendingSaves = new Map<string, Set<string>>()

/** Save a draft's prompt to main, remembered as ours until its echo lands. */
function savePrompt(sessionId: string, text: string, images: PromptImage[]): Promise<void> {
  let set = pendingSaves.get(sessionId)
  if (!set) pendingSaves.set(sessionId, (set = new Set()))
  // Re-sent: it is the newest again, so it moves to the end.
  set.delete(text)
  set.add(text)
  return window.gurt.sessionEditPrompt(sessionId, text, images).catch((e: unknown) => {
    // Refused: nothing will echo it back.
    pendingSaves.get(sessionId)?.delete(text)
    throw e
  })
}

/** The snapshot's prompt is one of our saves coming back: forget it (and every
 *  save sent before it — main has moved past those) and say so. */
function takeEcho(sessionId: string, prompt: string): boolean {
  const set = pendingSaves.get(sessionId)
  if (!set?.has(prompt)) return false
  for (const t of set) {
    set.delete(t)
    if (t === prompt) break
  }
  if (!set.size) pendingSaves.delete(sessionId)
  return true
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
  return (
    <div className="chat-head">
      <TabBar active={activeTab} onChange={onTab} review={reviewOf(info)} />
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
  const [text, setTextState] = useState(() => draftTexts.get(sessionId) ?? info.startPrompt)
  /** What the editor holds right now and what main was last told — read by the
   *  save-on-leave cleanup, which runs after the render that left. */
  const textRef = useRef(text)
  const savedRef = useRef(info.startPrompt)
  const imagesRef = useRef<PromptImage[]>([])
  const setText = (v: string) => {
    textRef.current = v
    draftTexts.set(sessionId, v)
    setTextState(v)
  }
  const [images, setImagesState] = useState<PromptImage[]>(draftImages.get(sessionId) ?? [])
  const [activeTab, setActiveTab] = useSessionTab(sessionId, !!reviewOf(info))
  // A queued reviewer's tab: its executor's loop, opened on the run it reviews.
  // A jump asked from this pane (its tab badge) is carried out here, as in Chat.
  const reviewJump = useReviewJump(sessionId)
  const hasReview = !!reviewOf(info)
  useEffect(() => {
    if (!reviewJump) return
    if (hasReview) setActiveTab('review')
    else clearReviewJump(reviewJump)
    // setActiveTab is a fresh closure every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewJump, hasReview])
  // Run flips `info.state` away from 'draft', which normally swaps this whole
  // body out on its own — but that swap rides the same IPC round trip the
  // click kicked off, so for a beat the draft view (and its button) just sits
  // there with nothing to show the click landed. This is the beat.
  const [submitting, setSubmitting] = useState(false)

  // Keep the editor in sync when the selection switches to another session,
  // and save the draft being left — on a switch (click, hotkey), on leaving
  // this pane (another view, Run), and on the window closing. A blur alone
  // misses most of these: a hotkey switch never blurs, and an unmounted
  // textarea does not reliably fire one.
  useEffect(() => {
    const own = draftTexts.get(sessionId) ?? info.startPrompt
    // Main caught up: from here on its copy is the one to trust (a prompt
    // edited elsewhere while this pane was away must not lose to a stale cache).
    if (own === info.startPrompt) draftTexts.delete(sessionId)
    textRef.current = own
    // An echo that landed while this pane was away settles those saves now.
    takeEcho(sessionId, info.startPrompt)
    // What main will hold once our saves land: the newest one still out.
    savedRef.current = [...(pendingSaves.get(sessionId) ?? [])].pop() ?? info.startPrompt
    setTextState(own)
    imagesRef.current = draftImages.get(sessionId) ?? []
    setImagesState(imagesRef.current)
    setSubmitting(false)
    const save = () => {
      if (textRef.current === savedRef.current) return
      savedRef.current = textRef.current
      savePrompt(sessionId, textRef.current, imagesRef.current).catch(logErr('sessionEditPrompt'))
    }
    window.addEventListener('beforeunload', save)
    return () => {
      window.removeEventListener('beforeunload', save)
      save()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])
  // Main's copy changed: any of our own saves coming back — including one sent
  // before a leave-and-return — is already accounted for on screen (and may be
  // older than what was typed since); anything else — the prompt edited from
  // elsewhere — replaces the editor.
  const promptSeenRef = useRef({ sessionId, prompt: info.startPrompt })
  useEffect(() => {
    const seen = promptSeenRef.current
    promptSeenRef.current = { sessionId, prompt: info.startPrompt }
    if (seen.sessionId !== sessionId || seen.prompt === info.startPrompt) return
    if (takeEcho(sessionId, info.startPrompt)) {
      if (draftTexts.get(sessionId) === info.startPrompt) draftTexts.delete(sessionId)
      return
    }
    savedRef.current = info.startPrompt
    setText(info.startPrompt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, info.startPrompt])
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
    imagesRef.current = next
    savedRef.current = text
    savePrompt(sessionId, text, next).catch(logErr('sessionEditPrompt'))
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

      {activeTab === 'review' && (
        <ReviewTab
          // Per pane, not per loop (as in Chat): each opens on its own run.
          key={sessionId}
          executor={reviewOf(info) ?? sessionId}
          focus={reviewJump}
          onFocused={() => reviewJump && clearReviewJump(reviewJump)}
          initialRun={reviewerRun(info)}
        />
      )}

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
              if (text === savedRef.current) return
              savedRef.current = text
              savePrompt(sessionId, text, images).catch(logErr('sessionEditPrompt'))
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
                  savedRef.current = text
                  await savePrompt(sessionId, text, images)
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
