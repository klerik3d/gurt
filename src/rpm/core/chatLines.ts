// The handoff lines in chat (t3v2 §10.2): one builder per row of the table.
// Each takes the fold the line describes and the journal entry it comes from;
// `text` is the full text the agent received, when there is one.
import { ownerOf, tracked } from './machine'
import type { CallReason, CheckRun, EntryOf, Finding, ReplyAct, RpmChatLine, RunState } from './model'

type Line = RpmChatLine
const head = (run: RunState, seq: number): Pick<Line, 'executor' | 'run' | 'seq'> => ({ executor: run.executor, run: run.run, seq })

const ACT_LABEL: Record<ReplyAct, string> = { fixed: 'fixed', contested: 'contested', cant: "can't", documented: 'documented' }

/** «+2 below threshold»: findings below the threshold that nobody moves. */
function below(run: RunState): string | undefined {
  const n = run.findings.filter((f) => !tracked(run, f) && ownerOf(f.state) !== 'none').length
  return n ? `+${n} below threshold` : undefined
}

const lastBy = (run: RunState, id: string): string | undefined => run.history[id]?.[run.history[id].length - 1]?.by

/**
 * `step executor` — the host message to the executor (`text` = executorMessage).
 * `reviewer R1 → executor F1 F2` / `you → executor F2 must do`. `run` = the fold
 * with the step entry.
 */
function executorStep(run: RunState, e: EntryOf<'step'>, text: string): Line {
  const items = (e.items ?? []).map((id) => run.findings.find((f) => f.id === id)).filter((f): f is Finding => !!f)
  const fromYou = items.length > 0 && items.every((f) => lastBy(run, f.id) === 'you')
  const more = below(run)
  return {
    ...head(run, e.seq),
    from: fromYou ? 'you' : 'reviewer',
    ...(!fromYou && run.lastReview && { review: run.lastReview.n }),
    to: 'executor',
    items: items.map((f) => ({ id: f.id, label: f.state === 'must' ? `${f.id} must do` : f.state === 'defer' ? `${f.id} defer` : f.id })),
    ...(more && { more }),
    text,
    kind: 'handoff'
  }
}

/** `step executor` after a red check (3в): `check → executor npm test failed`; `text` = checkMessage. */
function checkRed(run: RunState, e: EntryOf<'step'>, runs: CheckRun[], text: string): Line {
  const failed = runs.filter((r) => r.code !== 0 || r.timedOut).map((r) => `${r.command} failed`)
  return { ...head(run, e.seq), from: 'check', to: 'executor', items: [], more: failed.join(', ') || 'check failed', text, kind: 'check-red' }
}

/**
 * `turn` — `executor → reviewer F1 fixed F2 contested` and, separately,
 * `executor → you F7 can't`. No replies — no line. `run` = the fold with the turn.
 */
function turn(run: RunState, e: EntryOf<'turn'>): Line[] {
  const ignored = new Set(run.ignoredMoves.filter((m) => m.seq === e.seq).map((m) => m.id))
  const label = (r: { id: string; act: ReplyAct }): { id: string; label: string } => ({
    id: r.id,
    label: `${r.id} ${ACT_LABEL[r.act]}${ignored.has(r.id) ? ' (ignored)' : ''}`
  })
  const text = (rs: typeof e.replies): string => rs.map((r) => `${r.id} ${ACT_LABEL[r.act]}: ${r.comment}`).join('\n')
  const toReviewer = e.replies.filter((r) => r.act !== 'cant')
  const toYou = e.replies.filter((r) => r.act === 'cant')
  const lines: Line[] = []
  if (toReviewer.length) lines.push({ ...head(run, e.seq), from: 'executor', to: 'reviewer', items: toReviewer.map(label), text: text(toReviewer), kind: 'handoff' })
  if (toYou.length) lines.push({ ...head(run, e.seq), from: 'executor', to: 'you', items: toYou.map(label), text: text(toYou), kind: 'handoff' })
  return lines
}

/** `step review` — in the reviewer's chat: `executor → reviewer R2 F1 fixed …`; `text` = reviewerPrompt. `run` = the fold with the step entry. */
function reviewStep(run: RunState, e: EntryOf<'step'>, text: string): Line {
  const items = (e.items ?? []).map((id) => {
    const f = run.findings.find((x) => x.id === id)
    return { id, label: f ? `${id} ${f.state === 'cant' ? "can't" : f.state}` : id }
  })
  return { ...head(run, e.seq), from: 'executor', to: 'reviewer', review: run.reviews + 1, items, ...(e.full === false && { more: 'verify only' }), text, kind: 'handoff' }
}

/** `review` — in the reviewer's chat: `reviewer R2 → gurt F1 yes F2 no · new F8`. `run` = the fold with the review. */
function review(run: RunState, e: EntryOf<'review'>): Line {
  const ids = e.findings.map((f) => f.id)
  const text = [
    ...e.verify.map((v) => `${v.id} ${v.accept ? 'yes' : 'no'}: ${v.comment}`),
    ...e.findings.map((f) => `${f.id} ${f.severity}${f.file ? ` ${f.file}${f.line !== undefined ? `:${f.line}` : ''}` : ''}: ${f.claim}`)
  ].join('\n')
  return {
    ...head(run, e.seq),
    from: 'reviewer',
    review: run.reviews,
    to: 'gurt',
    items: e.verify.map((v) => ({ id: v.id, label: `${v.id} ${v.accept ? 'yes' : 'no'}` })),
    ...(ids.length && { more: `new ${ids.join(' ')}` }),
    ...(text && { text }),
    kind: 'handoff'
  }
}

const CALL_MORE: Record<Exclude<CallReason, 'findings'>, (run: RunState) => string> = {
  budget: (run) => `${run.sinceYou.reviews} reviews without you`,
  'check-red': (run) => `failed ${run.sinceYou.redChecks} times`,
  'check-unchanged': () => 'failed, code unchanged',
  'idle-executor': () => 'no replies, code unchanged',
  'executor-failed': () => 'executor failed',
  'executor-blocked': () => 'executor blocked',
  'reviewer-failed': () => 'reviewer failed',
  'check-error': () => 'check could not run'
}

const CALL_FROM: Record<Exclude<CallReason, 'findings'>, Line['from']> = {
  budget: 'rpm',
  'check-red': 'check',
  'check-unchanged': 'check',
  'idle-executor': 'executor',
  'executor-failed': 'executor',
  'executor-blocked': 'executor',
  'reviewer-failed': 'reviewer',
  'check-error': 'check'
}

/**
 * `call` — `reviewer R2 → you F2 disputed` / `rpm → you 3 reviews without you` /
 * `check → you failed 3 times`. `run` = the fold before the call entry (its counters).
 */
function call(run: RunState, e: EntryOf<'call'>): Line {
  if (e.why === 'findings') {
    const yours = run.findings.filter((f) => tracked(run, f) && ownerOf(f.state) === 'you')
    const fromReviewer = yours.some((f) => f.state === 'disputed')
    return {
      ...head(run, e.seq),
      from: fromReviewer ? 'reviewer' : 'executor',
      ...(fromReviewer && run.lastReview && { review: run.lastReview.n }),
      to: 'you',
      items: yours.map((f) => ({ id: f.id, label: `${f.id} ${f.state === 'cant' ? "can't" : f.state}` })),
      kind: 'handoff'
    }
  }
  return { ...head(run, e.seq), from: CALL_FROM[e.why], to: 'you', items: [], more: CALL_MORE[e.why](run), kind: 'handoff' }
}

/** `note` — `<text> queued`. */
function note(run: RunState, e: EntryOf<'note'>): Line {
  return { ...head(run, e.seq), from: 'you', to: 'executor', items: [], more: 'queued', text: e.text, kind: 'note-queued' }
}

/** `mark` — `review passed marked 4 files`. */
function mark(run: RunState, e: EntryOf<'mark'>): Line {
  const files = e.mark.repos.reduce((n, r) => n + r.files.length, 0)
  return { ...head(run, e.seq), from: 'rpm', to: 'you', items: [], more: `marked ${files} file${files === 1 ? '' : 's'}`, kind: 'passed' }
}

export const chatLines = { executorStep, checkRed, turn, reviewStep, review, call, note, mark }

/** One plain line for the chat log (`ChatSystem.text` when `line.text` is absent). */
export function chatLineSummary(l: RpmChatLine): string {
  if (l.kind === 'note-queued') return `${l.text ?? ''} queued`.trim()
  if (l.kind === 'passed') return `review passed${l.more ? ` ${l.more}` : ''}`
  const from = l.from === 'reviewer' && l.review !== undefined ? `reviewer R${l.review}` : l.from
  const to = l.to === 'reviewer' && l.review !== undefined && l.from !== 'reviewer' ? `reviewer R${l.review}` : l.to
  const parts = [`${from} → ${to}`, ...l.items.map((i) => i.label)]
  return parts.join(' ') + (l.more ? ` · ${l.more}` : '')
}
