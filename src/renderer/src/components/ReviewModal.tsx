// Manual review surface: a split before/after diff of one clone, inline
// comments anchored to it, and the fix session those comments seed.
// See docs/requirements-manual-review.md.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangedFile, DiffPair, DiffTarget, ReviewComment, ReviewState } from '../../../shared/types'
import { alignRows, foldRows, type Cell, type Row, type Span } from '../splitDiff'
import { Modal } from './Modal'
import { Icon } from './icons'

/** Where a not-yet-written comment is being composed. */
interface Draft {
  path: string
  side: 'before' | 'after'
  line: number
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
      await window.gurt.addReviewComment(ws, task, repo, target, d.path, d.side, d.line, text)
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
  const rows = useMemo(() => alignRows(before, after), [before, after])
  const shown = useMemo(() => foldRows(rows, expanded), [rows, expanded])

  /** Comments hanging off a row — either side's line may carry them. */
  const notesFor = (row: Row): ReviewComment[] => {
    if (row.kind === 'fold') return []
    return comments.filter(
      (c) =>
        (c.side === 'before' && row.before && c.line === row.before.line) ||
        (c.side === 'after' && row.after && c.line === row.after.line)
    )
  }

  return (
    <div className="split mono">
      {shown.map((row, i) => {
        if (row.kind === 'fold')
          return (
            <div key={`f${row.at}`} className="split-fold" onClick={() => onExpand(row.at)}>
              ⋯ {row.count} unchanged line{row.count === 1 ? '' : 's'} ⋯
            </div>
          )
        const notes = notesFor(row)
        const draftHere =
          draft &&
          draft.path === path &&
          ((draft.side === 'before' && row.before?.line === draft.line) ||
            (draft.side === 'after' && row.after?.line === draft.line))
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
              />
              <Pane
                cell={row.after}
                side="after"
                kind={row.kind}
                path={path}
                canComment={canComment}
                onDraft={onDraft}
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
      })}
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
  onDraft
}: {
  cell: Cell | undefined
  side: 'before' | 'after'
  kind: 'equal' | 'change'
  path: string
  canComment: boolean
  onDraft: (d: Draft) => void
}) {
  // A change row missing this side is the padding that keeps the panes aligned.
  const tone = !cell ? 'pad' : kind === 'equal' ? '' : side === 'before' ? 'del' : 'add'
  return (
    <div className={`split-pane ${tone}`}>
      <span className="split-gutter">
        {cell && <span className="split-ln">{cell.line}</span>}
        {cell && canComment && (
          <button
            className="split-add"
            title="comment on this line"
            onClick={() => onDraft({ path, side, line: cell.line })}
          >
            +
          </button>
        )}
      </span>
      <span className="split-code">{cell ? <Code cell={cell} /> : ''}</span>
    </div>
  )
}

/** Line text, word-highlighted when the line was paired with its rewrite. */
function Code({ cell }: { cell: Cell }): JSX.Element {
  if (!cell.spans) return <>{cell.text || ' '}</>
  return (
    <>
      {cell.spans.map((s: Span, i: number) =>
        s.changed ? (
          <span key={i} className="split-word">
            {s.text}
          </span>
        ) : (
          <span key={i}>{s.text}</span>
        )
      )}
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
        {c.line}
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
