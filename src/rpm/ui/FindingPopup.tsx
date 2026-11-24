// The finding popup (t2v3 C, t3v2 §3.3): hovering an F-number in a chat line,
// in History or elsewhere shows the finding as it is now — id, severity,
// state and whose move, the claim, file:line, the last comment. A click on the
// F-number opens the executor's Review tab on that row (t2v3 D).
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { RpmFinding } from '../core'
import { useRpmHostOptional } from './host'
import { STATE_LABEL, actorLabel, where } from './labels'

const WHOSE: Record<RpmFinding['owner'], string> = {
  you: 'waiting for you',
  executor: "executor's move",
  reviewer: "reviewer's move",
  none: ''
}

/** The popup's body over a finding of `rpmState` (undefined = still loading, null = not in that run). */
export function FindingPopup({
  id,
  finding,
  onOpenFile
}: {
  id: string
  finding: RpmFinding | null | undefined
  onOpenFile?: ((path: string, line?: number) => void) | undefined
}) {
  if (finding === undefined) return <div className="rpm-pop-body faint">{id} · loading…</div>
  if (finding === null) return <div className="rpm-pop-body faint">{id} · not in this run</div>
  const f = finding
  const last = [...f.history].reverse().find((h) => h.comment)
  const whose = f.tracked ? WHOSE[f.owner] : 'below threshold'
  return (
    <div className="rpm-pop-body">
      <div className="rpm-pop-head">
        <span className="mono strong">{f.id}</span>
        <span className={`rpm-sev rpm-sev-${f.severity}`}>{f.severity}</span>
        <span className="dim">
          {STATE_LABEL[f.state]}
          {whose && ` · ${whose}`}
        </span>
      </div>
      <div className="rpm-pop-claim">{f.claim}</div>
      {f.file &&
        (onOpenFile ? (
          <button type="button" className="btn-link rpm-link mono" onClick={() => onOpenFile(f.file!, f.line)}>
            {where(f)}
          </button>
        ) : (
          <div className="mono faint">{where(f)}</div>
        ))}
      {last && (
        <div className="rpm-pop-comment">
          <span className="dim">{last.by === 'reviewer' && last.review !== undefined ? `R${last.review}` : actorLabel(last.by)}:</span>{' '}
          {last.comment}
        </div>
      )}
    </div>
  )
}

const OPEN_MS = 250
const CLOSE_MS = 200

/**
 * Hover over an anchor → the popup of finding `id` of run `run` (none = the
 * last run). The state is read on the first hover and re-read on each next
 * one. Spread `anchor` on the element; render `popup` anywhere (it is a portal).
 */
export function useFindingHover(
  executor: string,
  run: number | undefined,
  id: string
): { anchor: { onMouseEnter: (e: ReactMouseEvent<HTMLElement>) => void; onMouseLeave: () => void }; popup: ReactNode } {
  const host = useRpmHostOptional()
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const [finding, setFinding] = useState<RpmFinding | null | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      clearTimeout(timer.current)
    }
  }, [])

  const stay = (): void => clearTimeout(timer.current)
  const leave = (): void => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setAt(null), CLOSE_MS)
  }
  const enter = (e: ReactMouseEvent<HTMLElement>): void => {
    if (!host) return
    clearTimeout(timer.current)
    const r = e.currentTarget.getBoundingClientRect()
    timer.current = setTimeout(() => {
      setAt({ x: r.left, y: r.bottom + 4 })
      host.api.rpmState(executor, run).then(
        (s) => live.current && setFinding(s?.findings.find((f) => f.id === id) ?? null),
        () => live.current && setFinding(null)
      )
    }, OPEN_MS)
  }

  const popup =
    at && host
      ? createPortal(
          <div
            className="menu rpm-pop"
            // TODO(rpm): no flip at the window's right/bottom edge.
            style={{ left: Math.min(at.x, window.innerWidth - 340), top: at.y }}
            onMouseEnter={stay}
            onMouseLeave={leave}
          >
            <FindingPopup id={id} finding={finding} onOpenFile={host.openFile} />
          </div>,
          document.body
        )
      : null
  return { anchor: { onMouseEnter: enter, onMouseLeave: leave }, popup }
}

/** An F-number: hover → popup, click → the executor's Review tab on this row. `label` follows it ("fixed"). */
export function FindingRef({
  executor,
  run,
  id,
  label
}: {
  executor: string
  run?: number | undefined
  id: string
  label?: string | undefined
}) {
  const host = useRpmHostOptional()
  const { anchor, popup } = useFindingHover(executor, run, id)
  return (
    <span className="rpm-ref">
      {host ? (
        <button
          type="button"
          className="btn-link rpm-link rpm-fid mono"
          {...anchor}
          onClick={(e) => {
            e.stopPropagation()
            host.openReview(executor, { ...(run !== undefined && { run }), finding: id })
          }}
        >
          {id}
        </button>
      ) : (
        <span className="rpm-fid mono">{id}</span>
      )}
      {label && <span className="rpm-ref-label"> {label}</span>}
      {popup}
    </span>
  )
}

const FID = /\b(F\d+)\b/g

/** Plain text with every F-number in it turned into a `FindingRef`. */
export function FindingText({ executor, run, text }: { executor: string; run?: number | undefined; text: string }) {
  const parts: ReactNode[] = []
  let i = 0
  for (const m of text.matchAll(FID)) {
    if (m.index > i) parts.push(text.slice(i, m.index))
    parts.push(<FindingRef key={`${m.index}`} executor={executor} run={run} id={m[1]!} />)
    i = m.index + m[0].length
  }
  if (i < text.length) parts.push(text.slice(i))
  return <>{parts}</>
}
