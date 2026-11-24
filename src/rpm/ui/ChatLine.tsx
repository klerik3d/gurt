// A handoff line in chat (t3v2 §10.2, t2v3 C): who → whom → which findings
// with what; ▾ opens the full text the agent received. A red check is a
// handoff of its output to the executor; a green one is never a line.
import { useState } from 'react'
import type { ChatRef, RpmChatLine as Line, RpmState } from '../core'
import { FindingRef, FindingText } from './FindingPopup'
import { useRpmHostOptional, type RpmHost } from './host'
import { markFiles } from './labels'

const fromLabel = (l: Line): string => (l.from === 'reviewer' && l.review !== undefined ? `reviewer R${l.review}` : l.from)
const toLabel = (l: Line): string =>
  l.to === 'reviewer' && l.review !== undefined && l.from !== 'reviewer' ? `reviewer R${l.review}` : l.to

/** Where a participant link goes: a known entry, or the RPM line of a journal entry in that session's log. */
export type ActorTarget =
  | { sessionId: string; entryId: number }
  | { sessionId: string; line: { executor: string; run: number; seq: number } }

/**
 * The chat message of `who` this line refers to (t2v3 D: "reviewer R2 ·
 * executor" → that session's chat, on that message).
 *
 * - The sender: its own message, from the findings' history refs
 *   (`HistoryItem.chat`) — its latest one up to this line.
 * - The addressee: the handoff it got — the RPM line of the next step for it
 *   (`step executor` in the executor's chat, `step review` in the reviewer's).
 *   That line is in the log as soon as the step starts, before any answer, so
 *   a reviewer still at work is reached too. The reviewer's session: the
 *   running review's (`status.session`), else the one that recorded the
 *   review of that step.
 */
export function actorTarget(state: RpmState | undefined, line: Line, who: 'reviewer' | 'executor', side: 'from' | 'to'): ActorTarget | undefined {
  if (!state) return undefined
  const at = (seq: number): { executor: string; run: number; seq: number } => ({ executor: line.executor, run: line.run, seq })
  if (side === 'to') {
    const step = state.journal.find((e) => e.kind === 'step' && e.what === (who === 'reviewer' ? 'review' : 'executor') && e.seq >= line.seq)
    if (step?.kind === 'step') {
      if (who === 'executor') return { sessionId: line.executor, line: at(step.seq) }
      const done = state.journal.find((e) => e.kind === 'review' && e.step === step.step && e.seq > step.seq)
      const session = done
        ? state.findings.flatMap((f) => f.history).find((h) => h.seq === done.seq && h.chat)?.chat?.sessionId
        : state.status.phase === 'review'
          ? state.status.session
          : undefined
      if (session) return { sessionId: session, line: at(step.seq) }
    }
    // No step for it yet (a check runs first) or its session is gone: no target, never an older one.
    return undefined
  }
  const chat = senderChat(state, line, who)
  return chat && { sessionId: chat.sessionId, entryId: chat.entryId }
}

/** The sender's message: its latest history ref up to this line (else the first after it). */
function senderChat(state: RpmState, line: Line, who: 'reviewer' | 'executor'): ChatRef | undefined {
  const ids = new Set(line.items.map((i) => i.id))
  const moves = state.findings
    .filter((f) => !ids.size || ids.has(f.id))
    .flatMap((f) => f.history)
    .filter((h) => h.chat && h.by === who && (who !== 'reviewer' || line.review === undefined || h.review === line.review))
  const before = moves.filter((h) => h.seq <= line.seq).sort((a, b) => b.seq - a.seq)[0]
  const after = moves.filter((h) => h.seq > line.seq).sort((a, b) => a.seq - b.seq)[0]
  return (before ?? after)?.chat
}

/** A participant of the line: reviewer and executor link to their chat message. */
function Actor({ host, line, side }: { host: RpmHost | null; line: Line; side: 'from' | 'to' }) {
  const who = line[side]
  const label = side === 'from' ? fromLabel(line) : toLabel(line)
  if (!host || (who !== 'reviewer' && who !== 'executor')) return <>{label}</>
  const open = (): void => {
    void host.api.rpmState(line.executor, line.run).then((s) => {
      const t = actorTarget(s, line, who, side)
      // TODO(rpm): nothing found (no step after the line, no history ref) — the click does nothing.
      if (!t) return
      if ('entryId' in t) host.openChat(t.sessionId, t.entryId)
      else host.openChatLine(t.sessionId, t.line)
    })
  }
  return (
    <button type="button" className="btn-link rpm-link rpm-actor" onClick={open}>
      {label}
    </button>
  )
}

export function RpmChatLine({ line }: { line: Line }) {
  const host = useRpmHostOptional()
  const [open, setOpen] = useState(false)
  const { executor, run } = line

  if (line.kind === 'note-queued')
    return (
      <div className="rpm-line">
        <span>{line.text}</span> <span className="faint">queued</span>
      </div>
    )

  if (line.kind === 'passed') {
    const openDiff = (): void => {
      if (!host) return
      void host.api.rpmState(executor, run).then((s) => {
        const scope = host.scopeOf(executor)
        if (s?.mark && scope) host.openDiff(scope.ws, scope.task, markFiles(s.mark))
      })
    }
    return (
      <div className="rpm-line rpm-line-head">
        <span className="rpm-line-who">review passed</span>
        {line.more &&
          (host ? (
            <button type="button" className="btn-link rpm-link" onClick={openDiff}>
              {line.more}
            </button>
          ) : (
            <span className="dim">{line.more}</span>
          ))}
      </div>
    )
  }

  const full = line.text && line.text.trim() ? line.text : undefined
  return (
    <div className={`rpm-line ${line.kind === 'check-red' ? 'rpm-line-red' : ''}`}>
      <div className="rpm-line-head">
        <span className="rpm-line-who">
          <Actor host={host} line={line} side="from" /> <span className="faint">→</span> <Actor host={host} line={line} side="to" />
        </span>
        {line.items.map((it) => (
          <FindingRef
            key={it.id}
            executor={executor}
            run={run}
            id={it.id}
            label={it.label.startsWith(it.id) ? it.label.slice(it.id.length).trim() || undefined : it.label}
          />
        ))}
        {line.more && (
          <span className={line.kind === 'check-red' ? 'rpm-line-fail' : 'dim'}>
            {line.items.length > 0 && <span className="faint">· </span>}
            <FindingText executor={executor} run={run} text={line.more} />
          </span>
        )}
        {full && (
          <button type="button" className="btn-link rpm-line-more" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? '▴' : '▾'}
          </button>
        )}
      </div>
      {open && full && <pre className="rpm-line-text">{full}</pre>}
    </div>
  )
}
