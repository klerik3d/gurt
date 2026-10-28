import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { ChatText, ChatToolCall } from '../../../shared/types'
import { Icon, type IconName } from './icons'
import { durationLabel } from '../time'

/** A tool call or a thought — the entries that collapse into one icon strip. */
type Timed = { id: number; at?: number; endAt?: number }
export type StripEntry = (ChatToolCall & Timed) | (Omit<ChatText, 'kind'> & { kind: 'thought' } & Timed)

/** Icon box widths + gap, kept in step with `.ts-item` / `.ts-row` in styles.css. */
const ITEM_PX = 28
const MCP_PX = 56
const GAP_PX = 6

const stripName = (s: string, re: RegExp): string => s.replace(re, '')

/** An MCP tool call, as `mcp__server__method` (claude-code) or `Tool: server/method`
 *  (codex): the server's short mark and the method with the redundant `mcp` and
 *  server name cut out. */
export function parseMcp(title: string): { server: string; abbr: string; method: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(title) ?? /^Tool:\s*([\w.-]+)\/([\w.-]+)$/.exec(title)
  if (!m) return null
  const server = m[1]!
  const rawMethod = m[2]!
  const tokens = stripName(server, /mcp/gi)
    .split(/[-_.\s]+/)
    .filter(Boolean)
  if (!tokens.length) tokens.push(server)
  const abbr = (tokens.length > 1 ? tokens.map((t) => t[0]).join('') : tokens[0]!).slice(0, 3).toUpperCase()
  let method = rawMethod
  const esc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Peel the server's name (whole or abbreviated) off the front, as often as it repeats.
  const pats = [...tokens, abbr].sort((a, b) => b.length - a.length)
  for (let changed = true; changed; ) {
    changed = false
    for (const pat of pats) {
      const next = method.replace(new RegExp(`^${esc(pat)}(?:[-_.\\s:]+|$)`, 'i'), '')
      if (next !== method) {
        method = next
        changed = true
      }
    }
  }
  method = stripName(method, /mcp/gi).replace(/^[-_.\s:]+|[-_.\s:]+$/g, '')
  return { server, abbr, method: method || rawMethod }
}

const mcpOf = (e: StripEntry) => (e.kind === 'tool' ? parseMcp(e.title) : null)
const widthOf = (e: StripEntry): number => (mcpOf(e) ? MCP_PX : ITEM_PX)

const KIND_ICON: Record<string, IconName> = {
  execute: 'terminal',
  read: 'file',
  edit: 'edit',
  delete: 'trash',
  move: 'move',
  search: 'search',
  fetch: 'globe',
  think: 'think'
}

/** What the row is called ("run", "edit", …); a generic tag when the agent sent no kind. */
function labelOf(e: StripEntry): string {
  if (e.kind === 'thought') return 'think'
  if (mcpOf(e)) return 'mcp'
  const k = e.toolKind
  if (!k) return 'tool'
  return k === 'execute' ? 'run' : k
}

function iconOf(e: StripEntry): IconName {
  if (e.kind === 'thought') return 'think'
  return (e.toolKind && KIND_ICON[e.toolKind]) || 'dots'
}

function titleOf(e: StripEntry): string {
  return e.kind === 'thought' ? 'thinking' : e.title
}

function stateOf(e: StripEntry): 'failed' | 'running' | 'ok' {
  if (e.kind !== 'tool') return 'ok'
  if (e.status === 'failed') return 'failed'
  return e.status === 'in_progress' || e.status === 'pending' ? 'running' : 'ok'
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

function DurationMark({ entry, now, live }: { entry: StripEntry; now: number; live: boolean }) {
  const d = durationOf(entry, now, live)
  if (!d) return null
  return (
    <span className="tool-meta mono" style={live ? { color: 'var(--yellow)' } : undefined} title={live ? 'running' : 'took'}>
      {live ? `running ${d}` : d}
    </span>
  )
}

/** Icon body of a strip item: the kind icon, or for an MCP tool a two-line mark —
 *  the server's abbreviation over the method. */
function ItemFace({ e }: { e: StripEntry }) {
  const mcp = mcpOf(e)
  if (!mcp) return <Icon name={iconOf(e)} size={14} />
  return (
    <span className="ts-mcp-face mono">
      <span className="ts-mcp-srv">{mcp.abbr}</span>
      <span className="ts-mcp-fn">{mcp.method}</span>
    </span>
  )
}

/** The hover card: `run` splits into in/out, file tools show the path and what
 *  was read or written, a thought shows its text. */
function Panel({ entry, live }: { entry: StripEntry; live: boolean }) {
  const state = stateOf(entry)
  if (entry.kind === 'thought') {
    return (
      <div className="ts-panel-body">
        <div className="ts-sec seclabel">THINK{live ? ' · live' : ''}</div>
        <div className="thought-text">{entry.text || '…'}</div>
      </div>
    )
  }
  const k = entry.toolKind
  const inLabel =
    k === 'execute' ? 'IN' : k === 'search' ? 'QUERY' : k === 'fetch' ? 'URL' : k ? 'FILE' : 'CALL'
  const outLabel = k === 'read' ? 'READ' : k === 'edit' ? 'WROTE' : 'OUT'
  return (
    <div className="ts-panel-body">
      <div className="ts-sec seclabel">
        {inLabel}
        {state === 'failed' && <span className="tool-exit mono">FAILED</span>}
        {state === 'running' && (
          <span className="tool-meta mono" style={{ color: 'var(--yellow)' }}>
            running…
          </span>
        )}
      </div>
      <pre className="tool-in mono">{entry.title}</pre>
      {entry.detail && (
        <>
          <div className="ts-sec seclabel">{outLabel}</div>
          <ToolDetail detail={entry.detail} kind={k} />
        </>
      )}
    </div>
  )
}

/** Re-render once a second while `on` — drives the running-time readout. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  return now
}

/** Is this block still going: a tool without a final status, or the streaming thought. */
function isLive(e: StripEntry, busy: boolean, liveId: number | undefined): boolean {
  if (e.endAt != null) return false
  return e.kind === 'thought' ? e.id === liveId : busy && stateOf(e) === 'running'
}

/** Time taken (or taken so far): null when the log carries no timestamps. */
function durationOf(e: StripEntry, now: number, live: boolean): string | null {
  if (e.at == null) return null
  const end = e.endAt ?? (live ? now : undefined)
  return end == null ? null : durationLabel(Math.max(0, end - e.at))
}

const EDGE_PX = 8

/** The hover card, pinned to the viewport (`position: fixed`) rather than laid
 *  out in the feed, so opening it never grows the scroll area or moves the
 *  chat. It opens below the strip, or above when the feed has more room there,
 *  and scrolls inside itself when neither side fits it whole. */
function FloatingPanel({ anchor, children }: { anchor: RefObject<HTMLElement | null>; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<React.CSSProperties>({ visibility: 'hidden' })

  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.current
      const el = ref.current
      if (!a || !el) return
      const r = a.getBoundingClientRect()
      const bounds = a.closest('.feed')?.getBoundingClientRect()
      const top = bounds ? bounds.top : 0
      const bottom = bounds ? bounds.bottom : window.innerHeight
      const below = bottom - r.bottom - EDGE_PX
      const above = r.top - top - EDGE_PX
      // Natural height: measured with the cap lifted by the style below.
      const want = el.scrollHeight
      const up = below < want && above > below
      const room = Math.max(80, up ? above : below)
      const next: React.CSSProperties = {
        left: r.left,
        width: r.width,
        maxHeight: room,
        ...(up ? { bottom: window.innerHeight - r.top } : { top: r.bottom }),
        ...(up ? { paddingBottom: 4 } : { paddingTop: 4 })
      }
      // Bail out on an identical placement: this runs after every render, and a
      // fresh object each time would re-render forever.
      setPos((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next))
    }
    place()
    // The feed scrolling or resizing moves the strip under a pinned panel.
    const feed = anchor.current?.closest('.feed')
    feed?.addEventListener('scroll', place, { passive: true })
    window.addEventListener('resize', place)
    return () => {
      feed?.removeEventListener('scroll', place)
      window.removeEventListener('resize', place)
    }
  })

  return (
    <div className="ts-panel" ref={ref} style={pos}>
      {children}
    </div>
  )
}

/** One run of consecutive tool calls / thoughts between texts, drawn as a single
 *  row of kind icons. Hovering (or clicking, to pin) an icon opens its details
 *  below (or above when there is no room); the row never wraps — what does not fit is folded into a "+N" chip. */
export function ToolStrip({
  entries,
  busy,
  liveId
}: {
  entries: StripEntry[]
  busy: boolean
  liveId?: number | undefined
}) {
  const rowRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(Infinity)
  const [hover, setHover] = useState<number | null>(null)
  const [pinned, setPinned] = useState<number | null>(null)

  useLayoutEffect(() => {
    const el = rowRef.current
    if (!el) return
    const measure = () => setWidth(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Newest stay visible; the oldest fold into the "+N" chip, which takes a slot
  // of its own once anything is folded.
  const total = entries.reduce((sum, e) => sum + widthOf(e) + GAP_PX, -GAP_PX)
  let first = 0
  if (total > width) {
    let room = width - ITEM_PX - GAP_PX
    first = entries.length
    while (first > 0 && room >= widthOf(entries[first - 1]!)) {
      room -= widthOf(entries[first - 1]!) + GAP_PX
      first--
    }
    // Always show the newest one, even in a sliver of a row.
    if (first === entries.length) first = entries.length - 1
  }
  const overflow = first > 0
  const hiddenCount = first
  const visible = entries.slice(first)
  const hidden = entries.slice(0, first)

  const activeId = hover ?? pinned
  const active = entries.find((e) => e.id === activeId)
  const [moreOpen, setMoreOpen] = useState(false)
  const activeLive = !!active && isLive(active, busy, liveId)
  // One clock for the badges and the panel; it only ticks while something is running.
  const now = useNow(entries.some((e) => isLive(e, busy, liveId)))

  return (
    <div
      className="ts"
      ref={stripRef}
      onMouseLeave={() => {
        setHover(null)
        setMoreOpen(false)
      }}
    >
      <div className="ts-row" ref={rowRef}>
        {overflow && (
          <button
            className={`ts-item ts-more mono ${moreOpen ? 'on' : ''}`}
            onMouseEnter={() => {
              setHover(null)
              setMoreOpen(true)
            }}
          >
            +{hiddenCount}
          </button>
        )}
        {visible.map((e) => {
          const live = isLive(e, busy, liveId)
          const dur = durationOf(e, now, live)
          return (
            <span key={e.id} className="ts-cell">
              <button
                className={`ts-item ts-${stateOf(e)} ${mcpOf(e) ? 'ts-mcp' : ''} ${activeId === e.id ? 'on' : ''}`}
                onMouseEnter={() => {
                  setMoreOpen(false)
                  setHover(e.id)
                }}
                onClick={() => setPinned((p) => (p === e.id ? null : e.id))}
                aria-label={`${labelOf(e)}: ${titleOf(e)}`}
              >
                <ItemFace e={e} />
              </button>
              {dur && <span className={`ts-dur mono ${live ? 'live' : ''}`}>{dur}</span>}
            </span>
          )
        })}
      </div>
      {moreOpen && hidden.length > 0 && (
        <FloatingPanel anchor={stripRef}>
          <div className="ts-more-list">
            {hidden.map((e) => (
              <div
                key={e.id}
                className="ts-more-row"
                onMouseEnter={() => {
                  setMoreOpen(false)
                  setHover(e.id)
                }}
              >
                <Icon name={iconOf(e)} size={13} />
                <span className="tool-kind mono">{labelOf(e)}</span>
                <span className="tool-title mono">{titleOf(e)}</span>
              </div>
            ))}
          </div>
        </FloatingPanel>
      )}
      {active && !moreOpen && (
        <FloatingPanel anchor={stripRef}>
          <div className="ts-panel-head">
            <Icon name={iconOf(active)} size={13} />
            <span className="tool-kind mono">{labelOf(active)}</span>
            {mcpOf(active) && (
              <span className="tool-title mono">
                {mcpOf(active)!.server} / {mcpOf(active)!.method}
              </span>
            )}
            <span className="spacer" />
            {pinned === active.id && <span className="tool-meta mono">pinned</span>}
            <DurationMark entry={active} now={now} live={activeLive} />
          </div>
          <Panel entry={active} live={active.id === liveId} />
        </FloatingPanel>
      )}
    </div>
  )
}
