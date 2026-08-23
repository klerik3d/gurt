// Manual review surface: a split before/after diff of one clone, inline
// comments anchored to it, and the fix session those comments seed.
// See docs/requirements-manual-review.md.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { ChangedFile, DiffPair, DiffTarget, ReviewComment, ReviewState } from '../../../shared/types'
import { alignRows, foldRows, groupBlocks, type Block, type Cell, type Row, type Span } from '../splitDiff'
import { langOf } from '../syntaxLang'
import { Modal } from './Modal'
import { Icon } from './icons'

/** Where a not-yet-written comment is being composed. */
interface Draft {
  path: string
  side: 'before' | 'after'
  line: number
  /** 1-based, inclusive; a range (drag-select or a whole block) rather than one line. */
  endLine?: number
}

export function ReviewModal({
  ws,
  task,
  repo,
  target,
  title,
  onClose,
  onChanged
}: {
  ws: string
  task: string
  repo: string
  target: DiffTarget
  title: string
  onClose: () => void
  /** Lock taken/released, or a fix session drafted — the task pane refreshes. */
  onChanged: () => void
}) {
  const [files, setFiles] = useState<ChangedFile[] | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const [pair, setPair] = useState<DiffPair | null>(null)
  const [review, setReview] = useState<ReviewState | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  const [launched, setLaunched] = useState('')

  const act = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  const loadReview = useCallback(async () => {
    setReview(await window.gurt.getReviewState(ws, task, repo, target))
    // `target` is a fresh object each render; the modal is keyed per target, so
    // its identity never changes for the life of this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, task, repo])

  // File list + review state, once per mounted target.
  useEffect(() => {
    let live = true
    Promise.all([
      window.gurt.getDiffFiles(ws, task, repo, target),
      window.gurt.getReviewState(ws, task, repo, target)
    ])
      .then(([f, r]) => {
        if (!live) return
        setFiles(f)
        setReview(r)
        setActive((cur) => cur ?? f[0]?.path ?? null)
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The selected file's content pair.
  useEffect(() => {
    if (!active) return
    let live = true
    setPair(null)
    setExpanded(new Set())
    setDraft(null)
    window.gurt
      .getDiffPair(ws, task, repo, target, active)
      .then((p) => live && setPair(p))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const comments = review?.comments ?? []
  const open = comments.filter((c) => !c.resolved)
  const locked = !!review?.locked

  const toggleLock = () =>
    act(async () => {
      await window.gurt.setReviewLock(ws, task, repo, !locked)
      await loadReview()
      onChanged()
    })

  const addComment = (d: Draft, text: string) =>
    act(async () => {
      await window.gurt.addReviewComment(ws, task, repo, target, d.path, d.side, d.line, text, d.endLine)
      setDraft(null)
      await loadReview()
    })

  const launch = () =>
    act(async () => {
      await window.gurt.launchReviewFix(ws, task, repo, target, prompt)
      setPrompt('')
      setLaunched(`fix session drafted with ${open.length} comment${open.length === 1 ? '' : 's'}`)
      onChanged()
    })

  return (
    <Modal title={`Review: ${title}`} width={1080} onClose={onClose}>
      <div className="review">
        <div className="review-body">
          <div className="review-files">
            {files?.length === 0 && <div className="tp-empty">nothing to review</div>}
            {files?.map((f) => {
              const n = open.filter((c) => c.path === f.path).length
              return (
                <div
                  key={f.path}
                  className={`review-file${f.path === active ? ' active' : ''}`}
                  onClick={() => setActive(f.path)}
                >
                  <span className={`file-status st-${f.status}`}>{f.status}</span>
                  <span className="review-file-path" title={f.path}>
                    {f.path}
                  </span>
                  {n > 0 && <span className="review-count">{n}</span>}
                </div>
              )
            })}
          </div>
          <div className="review-diff">
            <div className="review-diff-head">
              <span className="mono">{active ?? '—'}</span>
              <span className="spacer" />
              <span
                className={`tag tag-ico${locked ? ' tag-accent' : ''}`}
                title={
                  locked
                    ? 'agents cannot start against this repo'
                    : 'lock to leave comments and keep agents off this clone'
                }
              >
                <Icon name="lock" size={11} />
                {locked ? 'locked' : 'unlocked'}
              </span>
              <button className="btn btn-xs" disabled={busy} onClick={toggleLock}>
                {locked ? 'Unlock' : 'Lock for review'}
              </button>
            </div>
            {pair === null && active && <div className="tp-empty">loading diff…</div>}
            {pair?.binary && <div className="tp-empty">binary file — no text diff</div>}
            {pair && !pair.binary && active && (
              <SplitDiff
                before={pair.before}
                after={pair.after}
                path={active}
                comments={comments.filter((c) => c.path === active)}
                expanded={expanded}
                onExpand={(at) => setExpanded((s) => new Set(s).add(at))}
                draft={draft}
                canComment={locked}
                onDraft={setDraft}
                onSubmit={addComment}
                onResolve={(id, r) =>
                  act(async () => {
                    await window.gurt.resolveReviewComment(ws, task, id, r)
                    await loadReview()
                  })
                }
                onDelete={(id) =>
                  act(async () => {
                    await window.gurt.deleteReviewComment(ws, task, id)
                    await loadReview()
                  })
                }
              />
            )}
          </div>
        </div>
        <div className="review-foot">
          <span className="review-foot-count">
            {open.length} open comment{open.length === 1 ? '' : 's'}
            {!locked && (
              <span className="review-hint"> · lock the repo to leave comments</span>
            )}
          </span>
          <input
            className="input review-prompt"
            placeholder="prompt for the fix session (optional)"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <button
            className="btn btn-primary btn-sm"
            disabled={busy || (!open.length && !prompt.trim())}
            title={
              !open.length && !prompt.trim()
                ? 'leave a comment or write a prompt first'
                : 'draft an executor session seeded with these comments'
            }
            onClick={launch}
          >
            Launch fix
          </button>
        </div>
        {error && <div className="error review-error">{error}</div>}
        {launched && !error && <div className="review-ok">{launched}</div>}
      </div>
    </Modal>
  )
}

/** Text width, in px, of a monospace string — used to size the horizontal
 *  scroll tracks. A single offscreen canvas is reused across calls. */
let measureCanvas: HTMLCanvasElement | null = null
function textWidth(text: string, font: string): number {
  if (!measureCanvas) measureCanvas = document.createElement('canvas')
  const ctx = measureCanvas.getContext('2d')
  if (!ctx) return 0
  ctx.font = font
  return ctx.measureText(text).width
}

/** Two panes, row-aligned, with folds and comment threads inline. */
function SplitDiff({
  before,
  after,
  path,
  comments,
  expanded,
  onExpand,
  draft,
  canComment,
  onDraft,
  onSubmit,
  onResolve,
  onDelete
}: {
  before: string
  after: string
  path: string
  comments: ReviewComment[]
  expanded: ReadonlySet<number>
  onExpand: (at: number) => void
  draft: Draft | null
  canComment: boolean
  onDraft: (d: Draft | null) => void
  onSubmit: (d: Draft, text: string) => void
  onResolve: (id: string, resolved: boolean) => void
  onDelete: (id: string) => void
}) {
  const lang = useMemo(() => langOf(path), [path])
  const rows = useMemo(() => alignRows(before, after, lang), [before, after, lang])
  const shown = useMemo(() => foldRows(rows, expanded), [rows, expanded])

  // One shared horizontal scroll position per side — see .split-hscroll-row.
  const rootRef = useRef<HTMLDivElement>(null)
  const beforeTrackRef = useRef<HTMLDivElement>(null)
  const afterTrackRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number | null>(null)
  const [scrollX, setScrollX] = useState({ before: 0, after: 0 })
  const [font, setFont] = useState('12px monospace')

  useEffect(() => {
    if (!rootRef.current) return
    const cs = getComputedStyle(rootRef.current)
    setFont(`${cs.fontSize} ${cs.fontFamily}`)
  }, [])

  // Trackpad/shift-wheel horizontal scroll routed to whichever side the
  // pointer is over. Native (non-passive) listener: React's synthetic wheel
  // handler is passive and can't preventDefault.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
      const rect = el.getBoundingClientRect()
      const before = e.clientX - rect.left < rect.width / 2
      const track = (before ? beforeTrackRef : afterTrackRef).current
      if (!track) return
      e.preventDefault()
      track.scrollLeft += e.deltaX
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onTrackScroll = (side: 'before' | 'after') => (e: React.UIEvent<HTMLDivElement>) => {
    const x = e.currentTarget.scrollLeft
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      setScrollX((s) => (s[side] === x ? s : { ...s, [side]: x }))
    })
  }

  const maxWidth = useMemo(() => {
    let b = 0
    let a = 0
    for (const r of shown) {
      if (r.kind === 'fold') continue
      if (r.before) b = Math.max(b, textWidth(r.before.text, font))
      if (r.after) a = Math.max(a, textWidth(r.after.text, font))
    }
    return { before: b + 12, after: a + 12 }
  }, [shown, font])

  /** Comments hanging off a row — attached at the last line of their anchor,
   *  same rule for a single line (endLine absent) or a range. */
  const notesFor = (row: Row): ReviewComment[] => {
    if (row.kind === 'fold') return []
    return comments.filter(
      (c) =>
        (c.side === 'before' && row.before && row.before.line === (c.endLine ?? c.line)) ||
        (c.side === 'after' && row.after && row.after.line === (c.endLine ?? c.line))
    )
  }

  const inCommentRange = (side: 'before' | 'after', line: number): boolean =>
    comments.some((c) => c.side === side && line >= c.line && line <= (c.endLine ?? c.line))

  // Drag-select a range of lines on one side's gutter — mousedown anchors it,
  // mouseenter over another row of the same side extends it, mouseup (which
  // may land outside any row) commits the draft.
  const [drag, setDrag] = useState<{ side: 'before' | 'after'; anchor: number; current: number } | null>(
    null
  )
  const onGutterDown = (side: 'before' | 'after', line: number) => {
    if (canComment) setDrag({ side, anchor: line, current: line })
  }
  const onGutterEnter = (side: 'before' | 'after', line: number) =>
    setDrag((d) => (d && d.side === side ? { ...d, current: line } : d))
  useEffect(() => {
    if (!drag) return
    const onUp = () => {
      const lo = Math.min(drag.anchor, drag.current)
      const hi = Math.max(drag.anchor, drag.current)
      setDrag(null)
      onDraft(hi > lo ? { path, side: drag.side, line: lo, endLine: hi } : { path, side: drag.side, line: lo })
    }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [drag, path, onDraft])
  const inDragRange = (side: 'before' | 'after', line: number): boolean =>
    !!drag && drag.side === side && line >= Math.min(drag.anchor, drag.current) && line <= Math.max(drag.anchor, drag.current)

  // Whole change blocks — the "comment on this block" affordance.
  const blocks = useMemo(() => groupBlocks(shown), [shown])
  const blockAt = useMemo(() => new Map(blocks.map((b) => [b.startIndex, b])), [blocks])
  const blockDraft = (block: Block): Draft => {
    const rowsIn = shown.slice(block.startIndex, block.endIndex + 1)
    const linesOf = (side: 'before' | 'after') =>
      rowsIn
        .map((r) => (r.kind === 'fold' ? undefined : r[side]?.line))
        .filter((n): n is number => n !== undefined)
    const afterLines = linesOf('after')
    const side: 'before' | 'after' = afterLines.length ? 'after' : 'before'
    const lines = afterLines.length ? afterLines : linesOf('before')
    const line = Math.min(...lines)
    const endLine = Math.max(...lines)
    return endLine > line ? { path, side, line, endLine } : { path, side, line }
  }

  type DiffRow = Extract<Row, { kind: 'equal' | 'change' }>

  const renderRow = (row: DiffRow, i: number): JSX.Element => {
    const notes = notesFor(row)
    const endOf = draft?.endLine ?? draft?.line
    const draftHere =
      draft &&
      draft.path === path &&
      ((draft.side === 'before' && row.before && row.before.line === endOf) ||
        (draft.side === 'after' && row.after && row.after.line === endOf))
    return (
      <div key={i} className="split-row-wrap">
        <div className={`split-row ${row.kind}`}>
          <Pane
            cell={row.before}
            side="before"
            kind={row.kind}
            path={path}
            canComment={canComment}
            onDraft={onDraft}
            scrollX={scrollX.before}
            selecting={!!row.before && inDragRange('before', row.before.line)}
            inRange={!!row.before && inCommentRange('before', row.before.line)}
            onGutterDown={onGutterDown}
            onGutterEnter={onGutterEnter}
          />
          <Pane
            cell={row.after}
            side="after"
            kind={row.kind}
            path={path}
            canComment={canComment}
            onDraft={onDraft}
            scrollX={scrollX.after}
            selecting={!!row.after && inDragRange('after', row.after.line)}
            inRange={!!row.after && inCommentRange('after', row.after.line)}
            onGutterDown={onGutterDown}
            onGutterEnter={onGutterEnter}
          />
        </div>
        {notes.map((c) => (
          <Note key={c.id} c={c} onResolve={onResolve} onDelete={onDelete} />
        ))}
        {draftHere && (
          <Composer onCancel={() => onDraft(null)} onSubmit={(t) => onSubmit(draft, t)} />
        )}
      </div>
    )
  }

  const elements: JSX.Element[] = []
  for (let i = 0; i < shown.length; ) {
    const row = shown[i]
    if (row.kind === 'fold') {
      elements.push(
        <div key={`f${row.at}`} className="split-fold" onClick={() => onExpand(row.at)}>
          ⋯ {row.count} unchanged line{row.count === 1 ? '' : 's'} ⋯
        </div>
      )
      i++
      continue
    }
    const block = blockAt.get(i)
    if (block) {
      const blockRows: JSX.Element[] = []
      for (let j = i; j <= block.endIndex; j++) blockRows.push(renderRow(shown[j] as DiffRow, j))
      elements.push(
        <div key={`b${i}`} className="split-block">
          {canComment && (
            <button
              className="split-block-add"
              title="comment on this whole change block"
              onClick={() => onDraft(blockDraft(block))}
            >
              + block
            </button>
          )}
          {blockRows}
        </div>
      )
      i = block.endIndex + 1
      continue
    }
    elements.push(renderRow(row, i))
    i++
  }

  return (
    <div className="split mono" ref={rootRef}>
      {elements}
      <div className="split-hscroll-row">
        <div className="split-hscroll-pane">
          <span className="split-hscroll-gutter" />
          <div className="split-hscroll" ref={beforeTrackRef} onScroll={onTrackScroll('before')}>
            <div className="split-hscroll-spacer" style={{ width: maxWidth.before }} />
          </div>
        </div>
        <div className="split-hscroll-pane">
          <span className="split-hscroll-gutter" />
          <div className="split-hscroll" ref={afterTrackRef} onScroll={onTrackScroll('after')}>
            <div className="split-hscroll-spacer" style={{ width: maxWidth.after }} />
          </div>
        </div>
      </div>
    </div>
  )
}

/** One side of one row: gutter (line number + add-comment affordance) + code. */
function Pane({
  cell,
  side,
  kind,
  path,
  canComment,
  onDraft,
  scrollX,
  selecting,
  inRange,
  onGutterDown,
  onGutterEnter
}: {
  cell: Cell | undefined
  side: 'before' | 'after'
  kind: 'equal' | 'change'
  path: string
  canComment: boolean
  onDraft: (d: Draft) => void
  scrollX: number
  selecting: boolean
  inRange: boolean
  onGutterDown: (side: 'before' | 'after', line: number) => void
  onGutterEnter: (side: 'before' | 'after', line: number) => void
}) {
  // A change row missing this side is the padding that keeps the panes aligned.
  const tone = !cell ? 'pad' : kind === 'equal' ? '' : side === 'before' ? 'del' : 'add'
  const cls = `split-pane ${tone}${selecting ? ' selecting' : ''}${inRange ? ' in-range' : ''}`
  return (
    <div className={cls}>
      <span className={`split-gutter${canComment ? ' commentable' : ''}`}>
        {cell && (
          <span
            className="split-ln"
            onMouseDown={
              canComment
                ? (e) => {
                    e.preventDefault()
                    onGutterDown(side, cell.line)
                  }
                : undefined
            }
            onMouseEnter={canComment ? () => onGutterEnter(side, cell.line) : undefined}
          >
            {cell.line}
          </span>
        )}
        {cell && canComment && (
          <button
            className="split-add"
            title="comment on this line"
            onClick={(e) => {
              e.stopPropagation()
              onDraft({ path, side, line: cell.line })
            }}
          >
            +
          </button>
        )}
      </span>
      <span className="split-code">
        {cell && (
          <span className="split-code-inner" style={{ transform: `translateX(-${scrollX}px)` }}>
            <Code cell={cell} />
          </span>
        )}
      </span>
    </div>
  )
}

/** Syntax-colored, word-highlighted where the line was paired with its rewrite. */
function Code({ cell }: { cell: Cell }): JSX.Element {
  if (!cell.text) return <> </>
  return (
    <>
      {cell.spans.map((s: Span, i: number) => {
        const cls = [s.cls, s.changed ? 'split-word' : null].filter(Boolean).join(' ')
        return (
          <span key={i} className={cls || undefined}>
            {s.text}
          </span>
        )
      })}
    </>
  )
}

function Note({
  c,
  onResolve,
  onDelete
}: {
  c: ReviewComment
  onResolve: (id: string, resolved: boolean) => void
  onDelete: (id: string) => void
}) {
  return (
    <div className={`split-note${c.resolved ? ' resolved' : ''}`}>
      <input
        type="checkbox"
        checked={!!c.resolved}
        title={c.resolved ? 'reopen' : 'resolve'}
        onChange={(e) => onResolve(c.id, e.target.checked)}
      />
      <span className="split-note-anchor">
        {c.side === 'before' ? '−' : '+'}
        {c.endLine && c.endLine > c.line ? `${c.line}-${c.endLine}` : c.line}
      </span>
      <span className="split-note-text">{c.text}</span>
      <span className="spacer" />
      <button className="icon-sq" title="delete comment" onClick={() => onDelete(c.id)}>
        <Icon name="trash" size={12} />
      </button>
    </div>
  )
}

function Composer({
  onCancel,
  onSubmit
}: {
  onCancel: () => void
  onSubmit: (text: string) => void
}) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => ref.current?.focus(), [])
  return (
    <div className="split-composer">
      <textarea
        ref={ref}
        className="input"
        rows={2}
        placeholder="comment…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            // Stop the modal's own Esc handler — the composer closes first.
            e.stopPropagation()
            onCancel()
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) onSubmit(text)
        }}
      />
      <div className="split-composer-actions">
        <span className="kbd-tag">⌘↵</span>
        <button className="btn btn-xs" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-xs btn-primary" disabled={!text.trim()} onClick={() => onSubmit(text)}>
          Comment
        </button>
      </div>
    </div>
  )
}
