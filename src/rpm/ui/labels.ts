// Words of the Review tab (t2v3 B, t3v2 §3.2): the status line, the state
// labels, the history lines. Pure functions over the view types.
import {
  CHECK_RED_LIMIT,
  type Entry,
  type FindingState,
  type HistoryItem,
  type Owner,
  type RpmCommand,
  type RpmFinding,
  type ReviewMark,
  type RpmState,
  type Severity
} from '../core'

export const SEVERITIES: Severity[] = ['blocker', 'major', 'minor', 'nit']

export const STATE_LABEL: Record<FindingState, string> = {
  open: 'to do',
  must: 'must do',
  defer: 'defer',
  fixed: 'fixed',
  contested: 'contested',
  documented: 'documented',
  disputed: 'disputed',
  cant: "can't",
  closed: 'closed',
  rejected: 'rejected',
  deferred: 'deferred'
}

/** Whose move a state waits for, as a CSS tone (the only colour in the table). */
export const OWNER_TONE: Record<Owner, string> = {
  you: 'rpm-st-you',
  executor: 'rpm-st-ex',
  reviewer: 'rpm-st-rv',
  none: 'rpm-st-off'
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

export type StatusButton = 'pause' | 'resume' | 'continue' | 'stop'

/** What each status button sends (`rpmCommand`). Continue on a call is
 *  `resume`: rpm/main accepts it on a paused or a called run, and like any
 *  entry of yours it lifts the call (t3v2 §6.3, §12). */
export const STATUS_BUTTON: Record<StatusButton, { label: string; cmd: RpmCommand }> = {
  pause: { label: 'Pause', cmd: 'pause' },
  resume: { label: 'Resume', cmd: 'resume' },
  continue: { label: 'Continue', cmd: 'resume' },
  stop: { label: 'Stop', cmd: 'stop' }
}

export interface StatusLine {
  text: string
  /** The check output can be opened on the spot (t2v3 D, "output"). */
  output?: boolean
  /** "marked N files" (t2v3 B, Passed). */
  marked?: number
  buttons: StatusButton[]
}

/** The status line of t2v3 B, from `RunStatus` one to one (t3v2 §3.2). */
export function statusLine(s: RpmState): StatusLine {
  const st = s.status
  const running: StatusButton[] = s.live ? ['pause', 'stop'] : []
  switch (st.phase) {
    case 'check':
      return { text: `Running check${st.repos.length ? ` · ${st.repos.join(', ')}` : ''}`, buttons: running }
    case 'review': {
      const who = `Reviewer R${st.review}`
      if (st.waitingPlan) return { text: `${who} waits for its plan limit · ${clock(st.waitingPlan)}`, buttons: running }
      if (!st.full) return { text: `${who} is checking ${plural(st.items, 'finding')}`, buttons: running }
      return {
        text: st.items ? `${who} is reviewing the change and checking ${plural(st.items, 'finding')}` : `${who} is reviewing the change`,
        buttons: running
      }
    }
    case 'executor':
      return { text: st.items ? `Executor is fixing ${plural(st.items, 'finding')}` : 'Executor is working', buttons: running }
    case 'fix-check':
      return { text: `Executor is fixing the check · try ${st.try} of ${st.of}`, buttons: running }
    case 'paused':
      return { text: 'Paused', buttons: s.live ? ['resume', 'stop'] : [] }
    case 'passed':
      return { text: 'Passed', marked: st.files, buttons: [] }
    case 'ended':
      return { text: ENDED[st.why], buttons: [] }
    case 'called': {
      const go: StatusButton[] = s.live ? ['continue', 'stop'] : []
      switch (st.why) {
        case 'findings':
          return { text: `Waiting for you · ${plural(st.items.length, 'finding')}`, buttons: s.live ? ['stop'] : [] }
        case 'budget':
          return { text: `Waiting for you · ${plural(st.reviewsSinceYou, 'review')} without you`, buttons: go }
        case 'idle-executor':
          return { text: 'Waiting for you · the executor changed nothing', buttons: go }
        case 'check-red':
          return { text: `Stopped · check failed ${CHECK_RED_LIMIT} times in a row`, output: true, buttons: go }
        case 'check-unchanged':
          return { text: 'Stopped · check fails and the code did not change', output: true, buttons: go }
        case 'executor-failed':
          return { text: 'Waiting for you · executor failed', buttons: go }
        case 'executor-blocked':
          return { text: 'Waiting for you · executor is blocked', buttons: go }
        case 'reviewer-failed':
          return { text: 'Waiting for you · reviewer failed', buttons: go }
        case 'check-error':
          return { text: 'Waiting for you · check could not run', output: true, buttons: go }
      }
    }
  }
}

const ENDED: Record<'stopped' | 'disabled' | 'deleted' | 'archived', string> = {
  stopped: 'Stopped',
  disabled: 'Ended · review turned off',
  deleted: 'Ended · executor deleted',
  archived: 'Ended · archived'
}

/** `HH:MM` of an ISO time. */
export function clock(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** "reviewer R2", "executor", "you"… */
export function actorLabel(by: HistoryItem['by'], review?: number): string {
  return by === 'reviewer' && review !== undefined ? `reviewer R${review}` : by
}

/** "created", "to do → contested", "major → minor", "fixed — ignored". */
export function historyMove(h: HistoryItem, first: boolean): string {
  if (h.severity) return `${h.severity.from} → ${h.severity.to}`
  if (h.ignored) return `${h.to ? STATE_LABEL[h.to] : 'move'} — ignored`
  if (first && !h.from) return 'created'
  if (h.from && h.to) return `${STATE_LABEL[h.from]} → ${STATE_LABEL[h.to]}`
  return h.to ? STATE_LABEL[h.to] : ''
}

const ids = (xs: readonly string[] | undefined): string => (xs?.length ? ` ${xs.join(' ')}` : '')

/** One line of Review → History (t3v2 §10.1: one line per journal entry). */
export function entryLine(e: Entry, review?: number): string {
  switch (e.kind) {
    case 'start':
      return `run ${e.run} started`
    case 'step':
      if (e.what === 'check') return 'check started'
      if (e.what === 'review') return `review started · ${e.full ? 'full' : 'verify only'}${ids(e.items)}`
      return e.rule === '3в' ? 'executor asked to fix the check' : `executor asked to fix${ids(e.items)}`
    case 'check': {
      const red = e.runs.filter((r) => r.code !== 0).map((r) => `${r.command} (${r.repo})`)
      return e.ok ? 'check passed' : `check failed · ${red.join(', ')}`
    }
    case 'review': {
      const verify = e.verify.map((v) => `${v.id} ${v.accept ? 'yes' : 'no'}`).join(' ')
      const found = e.findings.map((f) => f.id).join(' ')
      return [`R${review ?? '?'}`, verify, found && `new ${found}`].filter(Boolean).join(' · ')
    }
    case 'turn':
      if (e.origin === 'user') return 'your message to the executor'
      return `executor ${e.outcome}${e.replies.length ? ` · ${e.replies.map((r) => `${r.id} ${STATE_LABEL[r.act]}`).join(' ')}` : ''}`
    case 'fail':
      return `${e.reason} · ${e.detail}`
    case 'verdict':
      return `${e.id} → ${e.to === 'must' ? 'must do' : e.to}`
    case 'severity':
      return `${e.id} severity → ${e.to}`
    case 'note':
      return `note · ${e.text}`
    case 'config':
      return `settings · ${Object.entries(e.patch)
        .map(([k, v]) => `${k} ${typeof v === 'object' ? (v as { agent?: string }).agent ?? '' : String(v)}`)
        .join(', ')}`
    case 'command':
      return e.cmd
    case 'call':
      return `you are called · ${e.why}`
    case 'mark':
      return `passed · marked ${plural(e.mark.repos.reduce((n, r) => n + r.files.length, 0), 'file')}`
    case 'end':
      return `ended · ${e.why}`
  }
}

// --- the findings table -------------------------------------------------------------

export type Filter = 'you' | 'executor' | 'reviewer' | 'final' | 'below' | 'all'

export const FILTERS: { id: Filter; label: string }[] = [
  { id: 'you', label: 'waiting for you' },
  { id: 'executor', label: 'executor' },
  { id: 'reviewer', label: 'reviewer' },
  { id: 'final', label: 'final' },
  { id: 'below', label: 'below threshold' },
  { id: 'all', label: 'all' }
]

export function inFilter(f: RpmFinding, filter: Filter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'below':
      return !f.tracked
    case 'final':
      return f.tracked && f.owner === 'none'
    default:
      return f.tracked && f.owner === filter
  }
}

export type SortKey = 'id' | 'severity' | 'where' | 'claim' | 'state' | 'tries'

const OWNER_ORDER: Record<Owner, number> = { you: 0, executor: 1, reviewer: 2, none: 3 }
const num = (id: string): number => Number(id.replace(/\D/g, '')) || 0
export const where = (f: RpmFinding): string => (f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '')

export function sortFindings(list: RpmFinding[], key: SortKey, desc: boolean): RpmFinding[] {
  const cmp = (a: RpmFinding, b: RpmFinding): number => {
    switch (key) {
      case 'id':
        return num(a.id) - num(b.id)
      case 'severity':
        // "severity ▾" = the worst first.
        return SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity)
      case 'where':
        return where(a).localeCompare(where(b))
      case 'claim':
        return a.claim.localeCompare(b.claim)
      case 'state':
        return OWNER_ORDER[b.owner] - OWNER_ORDER[a.owner]
      case 'tries':
        return a.attempts - b.attempts
    }
  }
  return [...list].sort((a, b) => (desc ? -cmp(a, b) : cmp(a, b)) || num(a.id) - num(b.id))
}

/** The marked files as `<repo>/<path>` — what "marked N files" opens in Diff (t2v3 D). */
export function markFiles(mark: ReviewMark): string[] {
  return mark.repos.flatMap((r) => r.files.map((f) => `${r.repo}/${f.path}`))
}
