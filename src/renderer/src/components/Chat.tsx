import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  ChatEntry,
  ChatPermission,
  ChatToolCall,
  CommandInfo,
  PendingPromptInfo,
  PlanEntry,
  PromptCapabilities,
  PromptContext,
  PromptImage,
  SessionConfigOption,
  SessionMode,
  SessionModes,
  SessionNetwork,
  SessionSnapshot,
  Tree
} from '../../../shared/types'
import { sessionRole, sessionStatus } from '../../../shared/types'
import { agentOptionView } from '../../../shared/agentConfig'
import { agentKind, agentName, useAgents } from '../useAgents'
import { useMcpEntries, useMcpFailures } from '../useMcp'
import { resolveMcpSelection } from '../../../shared/mcp'
import { alertDialog } from '../dialog'
import { createLogger, logErr } from '../log'
import { SESSION_DOT } from '../status'
import { Icon, Dot } from './icons'
import { AgentMark, EnvRepoMarks, hasNetMark, McpFailBanner, McpMarks, NetMark, RoleMark } from './tags'
import { NetButton } from './Network'
import { ConfigTab } from './ConfigTab'
import { SessionMenu } from './SessionActions'
import { TabBar, type SessionTab } from './SessionTabs'
import { VscodeButton } from './VscodeButton'
import { run } from '../async'
import { elapsedClock } from '../time'

const log = createLogger('chat')

/** Don't ping the main process on every keystroke — once per this interval is enough
 *  to keep postponing the env's idle auto-stop while the user is composing. */
const ACTIVITY_PING_INTERVAL_MS = 5_000

/**
 * Blanket permission-bypass modes (Claude's "bypassPermissions", Codex's "yolo").
 * They disable every guardrail, so they're hidden from the mode picker — gurt's
 * "auto" already maps to the safer accept-edits mode. Kept out of the UI, not the
 * protocol: the agent may still report one as current.
 */
const BLANKET_MODE_RE = /bypass|yolo/i
const isBlanketMode = (m: SessionMode): boolean => BLANKET_MODE_RE.test(`${m.id} ${m.name}`)

/** Word count × an average tokens-per-word ratio — not the real tokenizer, just
 *  enough to animate the live thinking counter and the session size pill. */
function approxTokens(text: string): number {
  return Math.round(text.trim().split(/\s+/).filter(Boolean).length * 1.3)
}

const formatTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)

/** Height the pinned request bar overlays at the top of the feed — used both to
 *  decide when the real message counts as "scrolled out" and to clear the bar
 *  when jumping back to that message. */
const PIN_BAR_CLEARANCE = 36

/** Unsent composer text/context/images, kept outside React state so they survive
 *  the remount `key={sessionId}` forces on every session switch (that key exists
 *  to stop a *different* bug — stale text bleeding into the next session). Entries
 *  are dropped once a draft goes back to empty, so switching away after sending
 *  doesn't leak an entry per session for the life of the app. */
const composerDrafts = new Map<string, { text: string; chips: PromptContext[]; images: PromptImage[] }>()

export function Chat({
  tree,
  snapshot,
  sessionId,
  log,
  onSelect,
  onDeleted
}: {
  tree: Tree | null
  snapshot?: SessionSnapshot | undefined
  sessionId: string
  log: string[]
  /** Select another session — where a duplicate's fresh draft is handed to. */
  onSelect: (id: string) => void
  onDeleted: () => void
}) {
  const [activeTab, setActiveTab] = useState<SessionTab>('chat')
  useEffect(() => setActiveTab('chat'), [sessionId])
  const feedRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  /** Follow-the-tail flag: true until the user scrolls away from the bottom. */
  const stickRef = useRef(true)
  const [pinnedId, setPinnedId] = useState<number | undefined>(undefined)
  const pinnedTextRef = useRef('')
  const agents = useAgents()
  // Up here with the other hooks: the snapshot guard below is an early return.
  const mcpOffered = useMcpEntries(snapshot?.info.workspace)
  const mcpFailures = useMcpFailures(sessionId)

  const entries = snapshot?.entries ?? []
  const hasSnapshot = !!snapshot
  // Real usage (ACP `usage_update`) wins when the adapter sends it; otherwise fall
  // back to a rough word-count estimate over the log — not every adapter reports
  // usage yet (e.g. codex-acp).
  const usage = snapshot?.usage
  const sessionTokens = entries.reduce((sum, e) => {
    switch (e.kind) {
      case 'user':
      case 'agent':
      case 'thought':
      case 'system':
        return sum + approxTokens(e.text)
      case 'tool':
        return sum + approxTokens(`${e.title} ${e.detail ?? ''}`)
      case 'permission':
        return sum + approxTokens(e.title)
      default:
        return sum
    }
  }, 0)
  const sizeLabel = usage
    ? `${formatTokens(usage.used)}/${formatTokens(usage.size)} tokens`
    : `~${formatTokens(sessionTokens)} tokens`
  const userEntries = entries.filter(
    (e): e is ChatEntry & { kind: 'user' } => e.kind === 'user' && !!e.text.trim()
  )
  const lastUserEntry = userEntries[userEntries.length - 1]
  const lastUserId = lastUserEntry?.id
  const pinnedEntry = userEntries.find((e) => e.id === pinnedId)
  if (pinnedEntry) pinnedTextRef.current = pinnedEntry.text

  // Keep the feed glued to its bottom edge while it's following the tail. A
  // ResizeObserver catches every way the tail can move — text streaming into
  // the same entry, the live thinking row appearing, the composer or plan bar
  // resizing the viewport — which a discrete "new entry" effect misses.
  useLayoutEffect(() => {
    const feed = feedRef.current
    const inner = innerRef.current
    if (!feed || !inner) return
    stickRef.current = true
    feed.scrollTop = feed.scrollHeight
    const ro = new ResizeObserver(() => {
      if (stickRef.current) feed.scrollTop = feed.scrollHeight
    })
    ro.observe(inner)
    ro.observe(feed)
    return () => ro.disconnect()
  }, [sessionId, hasSnapshot])

  // Sending a prompt jumps to the tail even if the user had scrolled up.
  useLayoutEffect(() => {
    const feed = feedRef.current
    if (!feed || lastUserId === undefined) return
    stickRef.current = true
    feed.scrollTop = feed.scrollHeight
  }, [lastUserId])

  /** Re-arm tail-following once the user is back within reach of the bottom. */
  const onFeedScroll = () => {
    const el = feedRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  // The "your request" bar tracks whichever user message the current scroll
  // position has passed — like a scrollspy following section headings — so
  // scrolling back through history always shows the request that's "active"
  // for what's on screen, not just the very last one in the whole session.
  // Recomputed from live geometry on every scroll/resize rather than tracked
  // incrementally: an IntersectionObserver only fires when a node crosses the
  // visibility threshold, so a node that jumps straight from above-the-fold
  // to below-the-fold (a fast scrollbar drag, Home/End) never fires and its
  // last-known state goes stale.
  useEffect(() => {
    const feed = feedRef.current
    if (!feed || userEntries.length === 0) {
      setPinnedId(undefined)
      return
    }
    const nodes = userEntries
      .map((e) => ({ id: e.id, node: feed.querySelector<HTMLElement>(`.msg-user[data-eid="${e.id}"]`) }))
      .filter((n): n is { id: number; node: HTMLElement } => !!n.node)
    if (nodes.length === 0) {
      setPinnedId(undefined)
      return
    }

    const recompute = () => {
      const threshold = feed.getBoundingClientRect().top + PIN_BAR_CLEARANCE
      let active: number | undefined
      for (const { id, node } of nodes) {
        if (node.getBoundingClientRect().top < threshold) active = id
      }
      setPinnedId(active)
    }
    recompute()
    feed.addEventListener('scroll', recompute, { passive: true })
    const ro = new ResizeObserver(recompute)
    ro.observe(feed)
    return () => {
      feed.removeEventListener('scroll', recompute)
      ro.disconnect()
    }
    // `userEntries` is a fresh array on every render — including it would tear
    // down and re-attach the scroll listener on every streamed chunk. The set of
    // user messages it reads only grows, and it grows exactly when `lastUserId`
    // changes, which is the dependency standing in for it here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, hasSnapshot, lastUserId])

  // Clicking the pinned bar jumps straight to the real message it's echoing,
  // clearing the same clearance the recompute above uses so the bar doesn't
  // immediately re-cover it.
  const scrollToPinned = () => {
    const feed = feedRef.current
    const id = pinnedId ?? lastUserId
    if (!feed || id === undefined) return
    const node = feed.querySelector<HTMLElement>(`.msg-user[data-eid="${id}"]`)
    if (!node) return
    feed.scrollTo({ top: node.offsetTop - PIN_BAR_CLEARANCE, behavior: 'smooth' })
  }

  // Esc stops the current turn while the agent is working (replaces the Stop
  // button). Ignore Esc raised from a text field so it can close its own popup,
  // and while any modal/dialog is open — there Esc means "dismiss it", and both
  // listeners live on window, so this one must stand down explicitly.
  const busy = snapshot?.busy ?? false
  const pending = snapshot?.pending ?? []
  const pendingCount = pending.length
  /** Text (and chips) handed back to the composer when a queued prompt is
   *  pulled out of the queue — bumped by `at` so the same text twice still
   *  registers as a second hand-back. */
  const [restore, setRestore] = useState<{ text: string; context: PromptContext[]; at: number } | null>(null)
  useEffect(() => {
    if (!busy && !pendingCount) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      if (document.querySelector('.modal-backdrop, .cmp-menu, .gear-pop')) return
      e.preventDefault()
      // Stop means stop. Anything queued behind this turn would otherwise fire
      // the instant the turn it was waiting on ends, which is the opposite of
      // what the key was pressed for — so it comes back to the composer, where
      // the user can edit it, drop it, or send it again.
      window.gurt
        .sessionClearPending(sessionId)
        .then((dropped) => {
          if (!dropped.length) return
          setRestore({
            text: dropped.map((p) => p.text).join('\n\n'),
            context: dropped.flatMap((p) => p.context ?? []),
            at: Date.now()
          })
        })
        .catch(logErr('sessionClearPending'))
      if (busy) window.gurt.sessionCancel(sessionId).catch(logErr('sessionCancel'))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, pendingCount, sessionId])

  if (!snapshot) return <div className="placeholder">loading session…</div>

  const { info, modes, plan, commands, configOptions, promptCapabilities } = snapshot
  const mcp = resolveMcpSelection(info.mcp, mcpOffered)

  const hasPlan = !!plan && plan.length > 0

  // The live tail indicator appears only when the tail itself shows no
  // activity: a pending permission card or a running tool row is already the
  // "what's happening" signal (and a streaming thought carries its own
  // "thinking…" header). While session/load is in flight it reads "resuming…".
  const lastEntry = entries[entries.length - 1]
  const tailBusy =
    (lastEntry?.kind === 'tool' &&
      (lastEntry.status === 'in_progress' || lastEntry.status === 'pending')) ||
    lastEntry?.kind === 'thought'
  const liveTail = !busy
    ? null
    : snapshot.resuming
      ? 'resuming session…'
      : info.awaitingInput || tailBusy
        ? null
        : 'thinking…'

  // `busy` is the live flag, fresher than the copy on `info`.
  const headDot = SESSION_DOT[sessionStatus({ ...info, busy })]

  return (
    <div className="chat">
      <div className="chat-head">
        <TabBar active={activeTab} onChange={setActiveTab} />
        <span className="spacer" />
        <Dot tone={headDot.tone} pulse={headDot.pulse} />
        <span className="chat-title">
          {info.task} / {info.title}
        </span>
        <span className="chat-pill">{sizeLabel}</span>
        <span className="chat-pill">
          <RoleMark role={sessionRole(info)} />
          <EnvRepoMarks env={info.env} repos={info.repos} task={info.task} />
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
          {hasNetMark(info.network) && (
            <span>
              · <NetMark network={info.network} />
            </span>
          )}
        </span>
        <VscodeButton info={info} />
        {/* A session already running is exactly where "this was set up wrong"
            is noticed — duplicate/delete belong on this header, not only on the
            draft pane the session has left behind. */}
        <SessionMenu info={info} onSelect={onSelect} onDeleted={onDeleted} />
        {(busy || pendingCount > 0) && <span className="chat-hint mono">esc to stop</span>}
      </div>

      {/* A local MCP server that would not start does not fail the session
          (§6): without this the agent would simply be missing tools, and the
          reason would be in ~/.gurt/logs. */}
      <McpFailBanner failures={mcpFailures} />

      {activeTab === 'config' && <ConfigTab tree={tree} snapshot={snapshot} />}

      {activeTab === 'logs' && (
        <pre className="env-log">{log.length ? log.join('\n') : 'no logs yet'}</pre>
      )}

      {activeTab === 'chat' && (
        <>
          <div className="feed-wrap">
            {lastUserEntry && (
              <PinnedRequest
                text={pinnedTextRef.current || lastUserEntry.text}
                visible={pinnedId !== undefined}
                onNavigate={scrollToPinned}
              />
            )}
            <div className="feed" ref={feedRef} onScroll={onFeedScroll}>
              <div className="feed-inner" ref={innerRef}>
                {entries.map((e, i) => (
                  <Msg key={e.id} entry={e} sessionId={sessionId} live={busy && i === entries.length - 1} />
                ))}
                {liveTail && <ThinkingLive label={liveTail} />}
              </div>
            </div>
          </div>

          {plan && plan.length > 0 && <PlanPinned plan={plan} />}

          <Composer
            key={sessionId}
            sessionId={sessionId}
            agentKind={agentKind(agents, info.agent)}
            network={info.network}
            busy={busy}
            pending={pending}
            pendingBlocked={snapshot.pendingBlocked}
            restore={restore}
            flush={!hasPlan}
            modes={modes}
            commands={commands ?? []}
            configOptions={configOptions ?? []}
            promptCaps={promptCapabilities}
          />
        </>
      )}
    </div>
  )
}

/** Sticky one-line echo of the user's last request. Shown only while the real
 *  message is scrolled out of view (`visible`); otherwise it slides away and
 *  the in-feed message takes over. Clicking it jumps to that message; the
 *  separate expand toggle (shown only when the preview is actually truncated)
 *  reveals the full text in place without leaving the current scroll spot. */
function PinnedRequest({
  text,
  visible,
  onNavigate
}: {
  text: string
  visible: boolean
  onNavigate: () => void
}) {
  const [open, setOpen] = useState(false)
  const textRef = useRef<HTMLSpanElement>(null)
  const [truncated, setTruncated] = useState(false)

  // Only re-measure while collapsed: expanded text wraps instead of
  // overflowing, so checking then would wrongly read as "not truncated"
  // and hide the toggle needed to collapse back.
  useLayoutEffect(() => {
    const el = textRef.current
    if (!el || open) return
    const check = (): void => setTruncated(el.scrollWidth > el.clientWidth)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text, open])

  return (
    <div
      className={`pinned-req ${open ? 'open' : ''} ${visible ? '' : 'off'}`}
      onClick={onNavigate}
    >
      <span className="seclabel">↑ YOUR REQUEST</span>
      <span className="pinned-req-text" ref={textRef}>
        {text}
      </span>
      {truncated && (
        <span
          className="pinned-req-toggle mono"
          onClick={(e) => {
            e.stopPropagation()
            setOpen((o) => !o)
          }}
        >
          {open ? 'collapse ▴' : 'expand ▾'}
        </span>
      )}
    </div>
  )
}

// ---- feed entries ----

function Msg({
  entry,
  sessionId,
  live
}: {
  entry: ChatEntry
  sessionId: string
  live?: boolean | undefined
}) {
  switch (entry.kind) {
    case 'user':
      return (
        <div className="msg msg-user" data-eid={entry.id}>
          <span className="msg-dot msg-dot-user" />
          <div className="msg-you seclabel">YOU</div>
          <div className="msg-text user">{entry.text}</div>
        </div>
      )
    case 'agent':
      return (
        <div className="msg">
          <span className="msg-dot" style={{ background: 'var(--accent)' }} />
          <div className="msg-text markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text}</ReactMarkdown>
          </div>
        </div>
      )
    case 'thought':
      return <ThoughtMsg text={entry.text} live={live} />
    case 'tool':
      return <ToolMsg entry={entry} />
    case 'permission':
      return <PermissionMsg entry={entry} sessionId={sessionId} />
    case 'system':
      return (
        <div className="msg msg-tool">
          <span className="msg-dot msg-dot-sm" style={{ background: 'var(--border2)' }} />
          <div className="msg-sys mono">{entry.text}</div>
        </div>
      )
  }
}

/** Fallback progress readout for a live row: how long it has been up. Agents
 *  that stream no thinking text give nothing to count tokens from, so without
 *  this the row sits there with no sign of movement — the clock answers the
 *  only question it raises, is this still going. Its own component so the 1s
 *  interval exists only while such a row is on screen. */
function Elapsed() {
  const startRef = useRef(Date.now())
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setSecs(Math.round((Date.now() - startRef.current) / 1000)), 1000)
    return () => clearInterval(id)
  }, [])
  return <span>· {elapsedClock(secs)}</span>
}

function ThoughtMsg({ text, live }: { text: string; live?: boolean | undefined }) {
  const [open, setOpen] = useState(false)
  const tokens = live ? approxTokens(text) : 0
  return (
    <div className="msg">
      <span className="msg-dot" style={{ background: 'var(--yellow)' }} />
      <div className="thought-head mono" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} thinking…
        {live && (tokens > 0 ? ` · ~${tokens} tokens` : <Elapsed />)}
      </div>
      {open && <div className="thought-text">{text}</div>}
    </div>
  )
}

/** Live placeholder shown at the tail of the log while the agent is working. */
function ThinkingLive({ label }: { label: string }) {
  return (
    <div className="msg">
      <span className="msg-dot dot-pulse" style={{ background: 'var(--yellow)' }} />
      <div className="thought-head mono">
        {label}
        <Elapsed />
      </div>
    </div>
  )
}

/** Uppercase kind label for the tool row; falls back to a generic tag. */
function toolLabel(entry: ChatToolCall): string {
  const k = entry.toolKind
  if (!k) return 'tool'
  if (k === 'execute') return 'run'
  return k
}

function ToolMsg({ entry }: { entry: ChatToolCall }) {
  const failed = entry.status === 'failed'
  const running = entry.status === 'in_progress' || entry.status === 'pending'
  const hasDetail = !!entry.detail
  // Everything expandable starts collapsed; the FAILED badge and red dot are
  // the signal to click into a failure.
  const [open, setOpen] = useState(false)

  const dotColor = failed ? 'var(--red)' : running ? 'var(--yellow)' : 'var(--border2)'

  const head = (
    <div className={`tool-head ${hasDetail ? 'clickable' : ''}`} onClick={() => hasDetail && setOpen((o) => !o)}>
      <span className="tool-kind mono">{toolLabel(entry)}</span>
      <span className="tool-title mono">{entry.title}</span>
      {failed && <span className="tool-exit mono">FAILED</span>}
      <span className="spacer" />
      {running && <span className="tool-meta mono" style={{ color: 'var(--yellow)' }}>running…</span>}
      {hasDetail && <span className="tool-meta mono">{open ? 'collapse ▾' : 'expand ▸'}</span>}
    </div>
  )

  return (
    <div className="msg msg-tool">
      <span
        className={`msg-dot msg-dot-sm ${running ? 'dot-pulse' : ''}`}
        style={{ background: dotColor }}
      />
      {hasDetail && open ? (
        <div className="tool-card">
          {head}
          <ToolDetail detail={entry.detail!} kind={entry.toolKind} />
        </div>
      ) : (
        <div className="tool-row">{head}</div>
      )}
    </div>
  )
}

/** Expanded tool output. Diff-looking lines get the +/− tinted treatment. */
function ToolDetail({ detail, kind }: { detail: string; kind?: string | undefined }) {
  const lines = detail.replace(/\n+$/, '').split('\n')
  const isDiff = kind === 'edit' || lines.some((l) => /^[+-](?![+-])/.test(l))
  if (!isDiff) return <pre className="tool-out mono">{detail}</pre>
  return (
    <div className="tool-diff mono">
      {lines.map((line, i) => {
        const cls = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : ''
        return (
          <div key={i} className={`diffline ${cls}`}>
            {line || ' '}
          </div>
        )
      })}
    </div>
  )
}

function PermissionMsg({
  entry,
  sessionId
}: {
  entry: ChatPermission & { id: number }
  sessionId: string
}) {
  const pending = !entry.chosen
  return (
    <div className="msg">
      <span
        className={`msg-dot ${pending ? 'dot-pulse' : ''}`}
        style={{ background: pending ? 'var(--yellow)' : 'var(--border2)' }}
      />
      <div className={`perm-card ${pending ? '' : 'settled'}`}>
        <div className="perm-head">
          <Icon name="lock" size={14} style={{ color: 'var(--yellow)', flex: 'none' }} />
          <span className="perm-title">{entry.title}</span>
        </div>
        <div className="perm-foot">
          {entry.chosen ? (
            <span className="perm-chosen mono">
              → {entry.options.find((o) => o.optionId === entry.chosen)?.name ?? entry.chosen}
              {entry.chosen === 'auto' ? ' (auto)' : ''}
            </span>
          ) : (
            entry.options.map((o) => (
              <button
                key={o.optionId}
                className={o.kind?.startsWith('allow') ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
                onClick={run(() =>
                  window.gurt.sessionPermission(sessionId, entry.id, o.optionId).catch(logErr('sessionPermission'))
                )}
              >
                {o.name}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

// ---- pinned plan bar (bottom) ----

function PlanPinned({ plan }: { plan: PlanEntry[] }) {
  const [open, setOpen] = useState(false)
  const done = plan.filter((p) => p.status === 'completed').length
  const current = plan.find((p) => p.status === 'in_progress') ?? plan.find((p) => p.status !== 'completed')
  return (
    <div className="plan-pin">
      <div className="plan-pin-bar" onClick={() => setOpen((o) => !o)}>
        <span className="seclabel">{open ? '▾' : '▸'} PLAN</span>
        <span className="plan-count mono">
          {done} / {plan.length}
        </span>
        {!open && current && <span className="plan-current">◪ {current.content}</span>}
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
              <span className="pm mono">
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

// ---- composer ----

const MAX_TA_HEIGHT = 220

/** Trailing-slash-tolerant basename, also handling `git:` pseudo-paths. */
const basename = (p: string): string => {
  if (p.startsWith('git:')) return p
  const cleaned = p.replace(/\/+$/, '')
  return cleaned.split('/').pop() || cleaned || p
}

const chipIcon = (path: string): 'branch' | 'folder' | 'file' =>
  path.startsWith('git:') ? 'branch' : path.endsWith('/') ? 'folder' : 'file'

/** Read a File as bare base64 (no `data:...;base64,` prefix), for an ACP image block. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    // readAsDataURL always yields a string; anything else is a reader that did
    // not do what was asked, not a file to attach.
    r.onload = () =>
      typeof r.result === 'string'
        ? resolve(r.result.replace(/^data:[^,]*,/, ''))
        : reject(new Error(`could not read "${file.name}"`))
    r.onerror = () => reject(r.error ?? new Error(`could not read "${file.name}"`))
    r.readAsDataURL(file)
  })
}

function Composer({
  sessionId,
  agentKind,
  network,
  busy,
  pending,
  pendingBlocked,
  restore,
  flush,
  modes,
  commands,
  configOptions,
  promptCaps
}: {
  sessionId: string
  /** The session agent's kind (`AgentDef.id`) — scopes agent-specific UI fixups. */
  agentKind?: string | undefined
  /** The session's egress mode — what the network button on the bar reports (§8). */
  network?: SessionNetwork | undefined
  busy: boolean
  /** Prompts already sent that are waiting their turn, oldest first. */
  pending: PendingPromptInfo[]
  /** Why the queue is not moving with no turn running (a clone held elsewhere). */
  pendingBlocked?: string | undefined
  /** A queued prompt pulled back out of the queue upstream (Esc) — its text and
   *  chips land back in this composer. */
  restore?: { text: string; context: PromptContext[]; at: number } | null
  /** No plan bar above — the composer sits flush against the feed. */
  flush: boolean
  modes?: SessionModes | undefined
  commands: CommandInfo[]
  configOptions: SessionConfigOption[]
  promptCaps?: PromptCapabilities | undefined
}) {
  const draft = composerDrafts.get(sessionId)
  const [text, setText] = useState(draft?.text ?? '')
  const [focused, setFocused] = useState(false)
  const [chips, setChips] = useState<PromptContext[]>(draft?.chips ?? [])
  const [images, setImages] = useState<PromptImage[]>(draft?.images ?? [])
  const [slashOpen, setSlashOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [gearOpen, setGearOpen] = useState(false)
  const [netOpen, setNetOpen] = useState(false)
  const [cmdQuery, setCmdQuery] = useState('')
  const [cmdIdx, setCmdIdx] = useState(0)
  /** null → the add-context item list; 'file'/'folder' → an inline path input. */
  const [addKind, setAddKind] = useState<'file' | 'folder' | null>(null)
  const [addPath, setAddPath] = useState('')
  const [micOn, setMicOn] = useState(false)
  /** Last dictation failure, shown inline so the mic never fails silently (#audio). */
  const [micError, setMicError] = useState<string | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const cmdRef = useRef<HTMLInputElement>(null)
  /** The keyboard-highlighted command row — kept scrolled into view. */
  const cmdActiveRef = useRef<HTMLDivElement>(null)
  /** Anchor spans wrapping each popup trigger button — the popup renders inside
   *  its anchor so it pops up over that button, and outside-click detection
   *  checks containment against the anchor (popup + button) alone. */
  const addAnchorRef = useRef<HTMLSpanElement>(null)
  const slashAnchorRef = useRef<HTMLSpanElement>(null)
  const gearAnchorRef = useRef<HTMLSpanElement>(null)
  const netAnchorRef = useRef<HTMLSpanElement>(null)
  const imgRef = useRef<HTMLInputElement>(null)
  const recogRef = useRef<{ stop: () => void } | null>(null)
  const lastActivityPingRef = useRef(0)

  /** Put a prompt that left the queue back where it was typed. Appended, never
   *  overwritten: the user may well have started composing the next one while
   *  it waited. */
  const takeBack = (text: string, context: PromptContext[]) => {
    setText((t) => (t.trim() ? `${t.replace(/\s+$/, '')}\n\n${text}` : text))
    if (context.length)
      setChips((c) => [...c, ...context.filter((x) => !c.some((y) => y.path === x.path))])
    setTimeout(() => taRef.current?.focus(), 0)
  }

  // Esc upstream emptied the queue — this is where its contents come home.
  useEffect(() => {
    if (!restore) return
    takeBack(restore.text, restore.context)
    // takeBack is stable enough for this: it only ever closes over setState.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restore?.at])

  const cancelPending = (id: string) => {
    window.gurt
      .sessionCancelPending(sessionId, id)
      .then((gone) => gone && takeBack(gone.text, gone.context ?? []))
      .catch(logErr('sessionCancelPending'))
  }

  const pingActivity = () => {
    const now = performance.now()
    if (now - lastActivityPingRef.current < ACTIVITY_PING_INTERVAL_MS) return
    lastActivityPingRef.current = now
    window.gurt.sessionActivity(sessionId).catch(logErr('sessionActivity'))
  }

  const autoGrow = () => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, MAX_TA_HEIGHT) + 'px'
  }

  // Re-fit whenever the value changes (send clears it, pickCommand extends it).
  useEffect(autoGrow, [text])

  // Mirror the draft into the module-level cache on every change, so it
  // survives this component's remount on session switch. An empty draft is
  // removed rather than stored, so a sent (or never-started) message doesn't
  // leave a dangling entry behind.
  useEffect(() => {
    if (!text && chips.length === 0 && images.length === 0) composerDrafts.delete(sessionId)
    else composerDrafts.set(sessionId, { text, chips, images })
  }, [sessionId, text, chips, images])

  // Close the open popup on any click outside it (mousedown on the trigger
  // button lands inside the anchor, so it falls through to the button's own
  // toggle instead of double-closing) and on Esc. The textarea/slash input
  // also handle their own Esc; this document listener covers the rest (e.g.
  // focus left on the button that opened the menu).
  useEffect(() => {
    if (!slashOpen && !addOpen && !gearOpen && !netOpen) return
    const anchorRef = slashOpen
      ? slashAnchorRef
      : addOpen
        ? addAnchorRef
        : gearOpen
          ? gearAnchorRef
          : netAnchorRef
    const onDown = (e: MouseEvent) => {
      const anchor = anchorRef.current
      if (anchor && !anchor.contains(e.target as Node)) closeMenus()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenus()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [slashOpen, addOpen, gearOpen, netOpen])

  // Stop any live dictation when the composer unmounts (session switch).
  useEffect(() => () => recogRef.current?.stop(), [])

  // Name matches outrank description matches (and prefix outranks substring),
  // so "clea" surfaces /clean before commands that only mention it in their
  // description. Ties keep the agent's original order — sort() is stable.
  const filteredCmds = (() => {
    const q = cmdQuery.trim().toLowerCase().replace(/^\//, '')
    if (!q) return commands
    const rank = (c: CommandInfo): number => {
      const name = c.name.toLowerCase()
      if (name.startsWith(q)) return 0
      if (name.includes(q)) return 1
      if ((c.description ?? '').toLowerCase().includes(q)) return 2
      return 3
    }
    return commands
      .map((c) => ({ c, r: rank(c) }))
      .filter(({ r }) => r < 3)
      .sort((a, b) => a.r - b.r)
      .map(({ c }) => c)
  })()
  const showSlash = slashOpen && commands.length > 0

  // Keep the highlighted command in range as the filtered list shrinks.
  useEffect(() => {
    if (cmdIdx >= filteredCmds.length) setCmdIdx(0)
  }, [filteredCmds.length, cmdIdx])

  // Arrow keys can walk past the visible slice of the scrolling list — follow
  // the highlight so it is always the row the user can see.
  useEffect(() => {
    cmdActiveRef.current?.scrollIntoView({ block: 'nearest' })
  }, [cmdIdx, showSlash])

  const closeMenus = () => {
    setSlashOpen(false)
    setAddOpen(false)
    setGearOpen(false)
    setNetOpen(false)
    setAddKind(null)
    setAddPath('')
  }

  const openSlash = (open: boolean) => {
    setAddOpen(false)
    setGearOpen(false)
    setNetOpen(false)
    setSlashOpen(open)
    setCmdQuery('')
    setCmdIdx(0)
    if (open) setTimeout(() => cmdRef.current?.focus(), 0)
  }

  const openAdd = (open: boolean) => {
    setSlashOpen(false)
    setGearOpen(false)
    setNetOpen(false)
    setAddKind(null)
    setAddPath('')
    setAddOpen(open)
  }

  const send = () => {
    const t = text.trim()
    if (!t && images.length === 0) return
    const context = chips.length ? chips : undefined
    const imgs = images.length ? images : undefined
    setText('')
    setChips([])
    setImages([])
    closeMenus()
    window.gurt.sessionPrompt(sessionId, t, context, imgs).catch(logErr('sessionPrompt'))
  }

  /** Read image files into attachment chips (shared by the picker and paste). */
  const addImageFiles = async (files: File[]) => {
    const added: PromptImage[] = []
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue
      try {
        added.push({ name: f.name || 'pasted image', mimeType: f.type, data: await fileToBase64(f) })
      } catch (e) {
        log.warn('image attach failed', { name: f.name, err: e })
      }
    }
    if (added.length) setImages((imgs) => [...imgs, ...added])
  }

  const pickImages = async (files: FileList | null) => {
    openAdd(false)
    if (files?.length) await addImageFiles(Array.from(files))
    setTimeout(() => taRef.current?.focus(), 0)
  }

  /** Paste an image straight into the composer (gated on the agent accepting images). */
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!promptCaps?.image) return
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f != null)
    if (files.length) {
      e.preventDefault()
      void addImageFiles(files)
    }
  }

  const removeImage = (i: number) => setImages((imgs) => imgs.filter((_, j) => j !== i))

  const pickCommand = (name: string) => {
    setText(`/${name} `)
    closeMenus()
    setTimeout(() => taRef.current?.focus(), 0)
  }

  const addChip = (ctx: PromptContext) => {
    setChips((c) => [...c, ctx])
    openAdd(false)
    setTimeout(() => taRef.current?.focus(), 0)
  }

  const commitAddPath = () => {
    const raw = addPath.trim()
    if (!raw) return
    const path = addKind === 'folder' && !raw.endsWith('/') ? `${raw}/` : raw
    addChip({ name: basename(path), path })
  }

  const removeChip = (i: number) => setChips((c) => c.filter((_, j) => j !== i))

  const onCmdKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCmdIdx((i) => Math.min(i + 1, filteredCmds.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCmdIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      // Tab completes like Enter: both drop the highlighted command into the
      // composer (with a trailing space for arguments) and return focus there.
      e.preventDefault()
      const c = filteredCmds[cmdIdx]
      if (c) pickCommand(c.name)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setSlashOpen(false)
      taRef.current?.focus()
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
      return
    }
    if (e.key === 'Escape') closeMenus()
  }

  const toggleMic = () => {
    const SR =
      (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike })
        .webkitSpeechRecognition
    if (!SR) {
      setMicError('dictation is not available in this build')
      return
    }
    if (recogRef.current) {
      recogRef.current.stop()
      return
    }
    setMicError(null)
    const r = new SR()
    r.interimResults = false
    r.continuous = true
    r.onresult = (e: SpeechResultEvent) => {
      let add = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]
        if (res?.isFinal) add += res[0]?.transcript ?? ''
      }
      add = add.trim()
      if (add) setText((t) => (t && !t.endsWith(' ') ? `${t} ${add}` : `${t}${add}`))
    }
    r.onend = () => {
      recogRef.current = null
      setMicOn(false)
    }
    r.onerror = (e: SpeechErrorEvent) => {
      recogRef.current = null
      setMicOn(false)
      setMicError(speechErrorMessage(e?.error))
    }
    try {
      r.start()
      recogRef.current = r
      setMicOn(true)
    } catch (e) {
      recogRef.current = null
      setMicOn(false)
      setMicError(e instanceof Error ? e.message : 'could not start dictation')
    }
  }

  const canSend = text.trim().length > 0 || images.length > 0
  /** The send would join the queue rather than start a turn — a turn is running,
   *  something is already waiting, or the session's clone is elsewhere. */
  const queueing = busy || pending.length > 0 || !!pendingBlocked
  const hasGearContent = (!!modes && modes.availableModes.length > 0) || configOptions.length > 0

  return (
    <div className={`composer-wrap ${flush ? 'flush' : ''}`}>
      {/* What has been sent and is waiting. Visible and cancellable on purpose:
          a message that disappeared into an invisible queue is worse than a
          send button that refuses — which is what this replaces. */}
      {pending.length > 0 && (
        <div className={`pending-queue ${busy ? '' : 'waiting'}`}>
          {pending.map((p) => (
            <div className="pending-row" key={p.id}>
              {/* Blue only when this really is a queue: the session's own turn
                  is over and the prompt sits waiting for something else (the
                  clone's holder) to let go — the same grammar as a queued
                  session's dot. Piled onto a turn that is still running, it is
                  just the next thing to say, so it stays faint. */}
              {busy ? <Icon name="history" size={12} className="faint" /> : <Dot tone="accent" size={7} />}
              <span className="pending-text">{p.text}</span>
              {p.images ? (
                <span className="dim" title="images ride with it and are lost if you take it back">
                  {p.images} img
                </span>
              ) : null}
              <button
                className="icon-sq att"
                title="take it back out of the queue (returns to the composer)"
                onClick={() => cancelPending(p.id)}
              >
                <Icon name="x" size={12} />
              </button>
            </div>
          ))}
          <div className="pending-note">
            {pendingBlocked ?? 'sends when the current turn ends'}
          </div>
        </div>
      )}
      <div className={`composer ${focused ? 'focused' : ''}`}>
        <input
          ref={imgRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            void pickImages(e.target.files)
            e.target.value = ''
          }}
        />

        <div className="composer-top">
          <textarea
            ref={taRef}
            rows={1}
            className="composer-input"
            placeholder={
              busy
                ? 'agent is working — what you send now goes in the queue'
                : pendingBlocked
                  ? 'waiting for the repository — what you send now goes in the queue'
                  : 'Ask gurt to change your code…'
            }
            value={text}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(e) => {
              const v = e.target.value
              setText(v)
              if (v.trim() === '/' && !slashOpen) openSlash(true)
              else if (!v.startsWith('/')) setSlashOpen(false)
              pingActivity()
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          <button
            className={`mic-btn ${micOn ? 'on' : ''}`}
            title={micOn ? 'Stop dictation' : 'Dictate'}
            onClick={toggleMic}
          >
            <Icon name="mic" size={14} />
          </button>
        </div>

        <div className="composer-bar">
          <span className="pop-anchor" ref={addAnchorRef}>
            <button
              className={`icon-sq ${addOpen ? 'active' : ''}`}
              title="Add context"
              onClick={() => openAdd(!addOpen)}
            >
              <Icon name="plus" size={14} />
            </button>
            {addOpen && (
              <div className="cmp-menu add-menu">
                {addKind === null ? (
                  <>
                    <div className="cmp-menu-head seclabel">ADD CONTEXT</div>
                    <div
                      className="menu-item"
                      onMouseDown={(e) => {
                        e.preventDefault()
                        setAddKind('file')
                      }}
                    >
                      <Icon name="file" size={14} className="code" />
                      <span>File…</span>
                    </div>
                    <div
                      className="menu-item"
                      onMouseDown={(e) => {
                        e.preventDefault()
                        setAddKind('folder')
                      }}
                    >
                      <Icon name="folder" size={14} className="code" />
                      <span>Folder…</span>
                    </div>
                    <div
                      className="menu-item"
                      onMouseDown={(e) => {
                        e.preventDefault()
                        addChip({ name: 'git diff', path: 'git:diff' })
                      }}
                    >
                      <Icon name="branch" size={14} className="code" />
                      <span>Git diff</span>
                    </div>
                    {promptCaps?.image && (
                      <div
                        className="menu-item"
                        onMouseDown={(e) => {
                          e.preventDefault()
                          imgRef.current?.click()
                        }}
                      >
                        <Icon name="image" size={14} className="code" />
                        <span>Image…</span>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="cmp-menu-head seclabel">
                      {addKind === 'file' ? 'ADD FILE' : 'ADD FOLDER'}
                    </div>
                    <input
                      autoFocus
                      className="cmp-input add-path-input"
                      placeholder="path relative to repo root…"
                      value={addPath}
                      onChange={(e) => setAddPath(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          commitAddPath()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          setAddKind(null)
                          setAddPath('')
                        }
                      }}
                    />
                    <div className="add-path-hint">Enter to add · Esc to cancel</div>
                  </>
                )}
              </div>
            )}
          </span>
          <span className="pop-anchor" ref={slashAnchorRef}>
            <button
              className={`icon-sq ${showSlash ? 'active' : ''}`}
              title="Commands"
              disabled={commands.length === 0}
              onClick={() => openSlash(!slashOpen)}
            >
              <Icon name="slash" size={14} />
            </button>
            {showSlash && (
              <div className="cmp-menu slash-menu">
                <div className="slash-filter-row">
                  <Icon name="search" size={13} className="faint" />
                  <input
                    ref={cmdRef}
                    className="cmp-input"
                    placeholder="Filter commands…"
                    value={cmdQuery}
                    onChange={(e) => {
                      setCmdQuery(e.target.value)
                      setCmdIdx(0)
                    }}
                    onKeyDown={onCmdKey}
                  />
                </div>
                <div className="slash-list">
                  {filteredCmds.length === 0 ? (
                    <div className="cmp-menu-empty">No matching commands</div>
                  ) : (
                    filteredCmds.map((c, i) => (
                      <div
                        key={c.name}
                        // Hover deliberately does not move the keyboard cursor:
                        // the pointer drifting over the list must not change
                        // which command Tab/Enter completes.
                        ref={i === cmdIdx ? cmdActiveRef : undefined}
                        className={`menu-item ${i === cmdIdx ? 'active' : ''}`}
                        onMouseDown={(e) => {
                          e.preventDefault()
                          pickCommand(c.name)
                        }}
                      >
                        <span className="cmd-name mono">/{c.name}</span>
                        {c.description && <span className="cmd-desc">{c.description}</span>}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </span>
          {chips.map((c, i) => (
            <button
              key={`${c.path}-${i}`}
              className="icon-sq att"
              title={`${c.name} — click to remove`}
              onClick={() => removeChip(i)}
            >
              <Icon name={chipIcon(c.path)} size={13} />
            </button>
          ))}
          {images.map((img, i) => (
            <button
              key={`img-${img.name}-${i}`}
              className="icon-sq att"
              title={`${img.name} — click to remove`}
              onClick={() => removeImage(i)}
            >
              <Icon name="image" size={13} />
            </button>
          ))}
          <span className="spacer" />
          {/* What the session can reach, on the bar rather than above it: the
              icon is the mode, the click is the whole traffic ledger (§8). */}
          <span className="pop-anchor" ref={netAnchorRef}>
            <NetButton
              sessionId={sessionId}
              network={network}
              open={netOpen}
              onToggle={() => {
                setSlashOpen(false)
                setAddOpen(false)
                setGearOpen(false)
                setNetOpen((o) => !o)
              }}
            />
          </span>
          {hasGearContent && (
            <span className="pop-anchor" ref={gearAnchorRef}>
              <button
                className={`icon-sq ${gearOpen ? 'active' : ''}`}
                title="Session settings"
                onClick={() => {
                  setSlashOpen(false)
                  setAddOpen(false)
                  setNetOpen(false)
                  setGearOpen((o) => !o)
                }}
              >
                <Icon name="gear" size={14} />
              </button>
              {gearOpen && (
                <GearPopup
                  sessionId={sessionId}
                  agentKind={agentKind}
                  modes={modes}
                  configOptions={configOptions}
                />
              )}
            </span>
          )}
          {/* Never disabled by the session's state, only by an empty message:
              a blocked button over an input that accepts text is a dead end.
              What changes is what it promises — send now, or take a place in
              the queue. */}
          <button
            className={`send-btn ${queueing ? 'queued' : ''}`}
            disabled={!canSend}
            onClick={send}
            title={
              queueing
                ? (pendingBlocked ?? 'the agent is working — this goes to the queue and sends when it is free')
                : 'Send'
            }
          >
            <Icon name={queueing ? 'history' : 'send'} size={12} />
            {queueing ? 'queue' : 'send'}
          </button>
        </div>
      </div>
      {micError && (
        <div className="composer-mic-error" onClick={() => setMicError(null)} title="dismiss">
          {micError}
        </div>
      )}
    </div>
  )
}

/** ⚙ popup (#1b): model / effort / mode chip groups. Commands live in the
 *  slash menu alone — this popup is for session settings. */
function GearPopup({
  sessionId,
  agentKind,
  modes,
  configOptions
}: {
  sessionId: string
  /** The session agent's kind — passed to the kind-scoped model resolver. */
  agentKind?: string | undefined
  modes?: SessionModes | undefined
  configOptions: SessionConfigOption[]
}) {
  const setMode = (id: string) =>
    window.gurt.sessionSetMode(sessionId, id).catch((e: unknown) => alertDialog(String(e)))
  const setConfig = (opt: SessionConfigOption, value: string | boolean) =>
    window.gurt.sessionSetConfigOption(sessionId, opt.id, value).catch((e: unknown) => alertDialog(String(e)))

  // The agent may surface Mode as a config option too; the dedicated mode group
  // already renders it, so drop the duplicate control.
  const cfg = configOptions.filter((o) => o.category !== 'mode')
  // Kind-specific presentation quirks (which chips, what's active) live behind
  // the view — this component renders whatever it hands back.
  const view = agentOptionView(agentKind)
  const sectionTitle = (o: SessionConfigOption) =>
    o.category === 'model' ? 'MODEL' : o.category === 'thought_level' ? 'EFFORT' : o.name.toUpperCase()

  return (
    <div className="cmp-menu gear-pop">
      <div className="gear-groups">
        {cfg.map((opt) =>
          opt.type === 'select' ? (
            <div key={opt.id} className="gear-group">
              <div className="seclabel">{sectionTitle(opt)}</div>
              <div className="chip-row">
                {view.selectOptions(opt).map((o) => (
                  <button
                    key={o.value}
                    className={`chip-btn ${o.value === view.activeValue(opt) ? 'on' : ''}`}
                    title={o.description ?? undefined}
                    onClick={run(() => setConfig(opt, o.value))}
                  >
                    {o.name}
                  </button>
                ))}
              </div>
              {/* No chip claims the live value (a hidden "default" the view could
                  not resolve to a concrete entry) — state the truth in text
                  rather than showing nothing selected. */}
              {!view.selectOptions(opt).some((o) => o.value === view.activeValue(opt)) && (
                <div className="hc-note">
                  {(opt.options ?? []).find((o) => o.value === opt.currentValue)?.description ??
                    `current: ${String(opt.currentValue)}`}
                </div>
              )}
            </div>
          ) : (
            <div key={opt.id} className="gear-group">
              <div className="seclabel">{sectionTitle(opt)}</div>
              <div className="chip-row">
                <button
                  className={`chip-btn ${opt.currentValue === true ? 'on' : ''}`}
                  onClick={run(() => setConfig(opt, true))}
                >
                  on
                </button>
                <button
                  className={`chip-btn ${opt.currentValue === false ? 'on' : ''}`}
                  onClick={run(() => setConfig(opt, false))}
                >
                  off
                </button>
              </div>
            </div>
          )
        )}
        {modes && modes.availableModes.length > 0 && (
          <div className="gear-group">
            <div className="seclabel">MODE</div>
            <div className="chip-row">
              {modes.availableModes
                .filter((m) => !isBlanketMode(m))
                .map((m) => (
                  <button
                    key={m.id}
                    className={`chip-btn ${m.id === modes.currentModeId ? 'on' : ''}`}
                    onClick={run(() => setMode(m.id))}
                  >
                    {m.name}
                  </button>
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// Minimal typings for the Web Speech API (not in the DOM lib we target).
interface SpeechResultEvent {
  resultIndex: number
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>
}
interface SpeechErrorEvent {
  error?: string
}
interface SpeechRecognitionLike {
  interimResults: boolean
  continuous: boolean
  onresult: (e: SpeechResultEvent) => void
  onend: () => void
  onerror: (e: SpeechErrorEvent) => void
  start: () => void
  stop: () => void
}

/** Turn a Web Speech API error code into a legible, actionable message. */
function speechErrorMessage(code?: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'microphone blocked — allow mic access for gurt in your system settings'
    case 'no-speech':
      return 'no speech detected — try again'
    case 'audio-capture':
      return 'no microphone found'
    case 'network':
      // In Electron this usually means the build ships no speech backend
      // (missing service API key), not that the machine is offline.
      return 'could not reach the speech service — dictation may not be supported in this build'
    default:
      return `dictation error: ${code ?? 'unknown'}`
  }
}
