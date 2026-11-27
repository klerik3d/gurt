// The scope row's status strip (docs/requirements-scope-row-status.md): three
// fixed slots — sessions, review (RPM), delivery — each one static icon whose
// shape names the slot and whose colour is the slot's most urgent state. The
// colour rule is "will this change without the user?" (see the grammar in
// status.ts). Pure: App gathers the inputs, ScopeRow draws the result.
import { isActionable, isDelivered, sessionFlow, sessionRole, sessionStatus, type RepoChanges, type SessionInfo } from '../../shared/types'
import type { TurnRecord } from '../../shared/usage'
import { FLOW_DOT, SESSION_DOT, URGENCY, moreUrgent, turnFailed, type Tone } from './status'

/** One drawn slot: its colour and the tooltip that spells it out. */
export interface Slot {
  tone: Tone
  title: string
}

/** A scope's strip. An absent slot is not drawn but keeps its width. */
export interface ScopeStatus {
  sessions: Slot
  /** Phase 2 (RPM aggregate) — always absent for now; the column is reserved. */
  review?: Slot | undefined
  delivery?: Slot | undefined
}

/** Any yellow or red slot: the scope wants the user, so its name is raised
 *  from `--dim` to `--text`. */
export const scopeWantsUser = (status: ScopeStatus): boolean =>
  [status.sessions, status.review, status.delivery].some((s) => s?.tone === 'red' || s?.tone === 'yellow')

// ---- slot 1: sessions --------------------------------------------------------

/** What the strip knows about one session. `info` carries the renderer's live
 *  overlay (busy, awaitingInput, flow, seen) already merged in. */
export interface SessionInput {
  info: SessionInfo
  /** The last failed start (`SessionSnapshot.startError`) — main keeps it on
   *  the snapshot only, not the record. */
  startError?: string | undefined
  /** The session's last turn on the usage ledger (`lastTurns`). */
  lastTurn?: Pick<TurnRecord, 'outcome' | 'detail'> | undefined
  /** Formats `limitedUntil` for the tooltip; ISO as-is when absent. */
  formatTime?: ((iso: string) => string) | undefined
}

/** One session's contribution: its colour and why, in words. */
export interface SessionState {
  tone: Tone
  reason: string
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

const clip = (text: string, max = 140): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * One session's state. The checks run in a deliberate order rather than by
 * urgency alone: an idle session whose RPM run, plan-limit wait or queued
 * message will move it on by itself is not waiting for the user, even though
 * it is unseen.
 */
export function sessionState({ info, startError, lastTurn, formatTime }: SessionInput): SessionState {
  const status = sessionStatus(info)
  if (startError) return { tone: 'red', reason: `failed to start: ${clip(startError)}` }
  if (info.container?.status === 'error') return { tone: 'red', reason: 'container error' }
  if (info.incomplete) return { tone: 'red', reason: 'turn ended without `complete`' }
  if (status === 'waiting') return { tone: 'yellow', reason: SESSION_DOT.waiting.label }
  if (status === 'running' || status === 'starting') return { tone: 'green', reason: SESSION_DOT[status].label }
  if (status === 'queued')
    return { tone: 'accent', reason: info.queueWaiting ? `queued — ${info.queueWaiting}` : SESSION_DOT.queued.label }
  if (status === 'draft')
    // An agent's draft (`create_session`) is a proposal the user has not
    // launched yet; the user's own draft is just a draft.
    return info.draftedBy && !info.handedOff
      ? { tone: 'yellow', reason: 'drafted by an agent — waiting for launch' }
      : { tone: 'faint', reason: SESSION_DOT.draft.label }
  // idle / idle-read from here on: the session is at rest, so the ledger's
  // last record is its last turn. (Above, a turn is in flight or not begun,
  // and the record is an earlier turn's — the Dashboard reads it for idle
  // sessions only, too.) A limit cut the session continues by itself is blue.
  if (info.limitedUntil)
    return {
      tone: 'accent',
      reason: `waiting for the plan limit — continues by itself at ${formatTime ? formatTime(info.limitedUntil) : info.limitedUntil}`
    }
  if (turnFailed(lastTurn))
    return {
      tone: 'red',
      reason: `${lastTurn?.outcome === 'limited' ? 'last turn hit a limit' : 'last turn errored'}${lastTurn?.detail ? `: ${clip(lastTurn.detail)}` : ''}`
    }
  // Phase 1 stop-gap: an idle executor's RPM flow is read here so the row
  // shows work going on. Once the review slot exists (phase 2) this belongs
  // there — drop it from sessions and keep only "no unseen yellow while a
  // flow continues".
  const flow = sessionFlow(info)
  if (flow) return { tone: flow === 'queued' ? 'accent' : 'green', reason: FLOW_DOT[flow].label }
  if (info.queueWaiting) return { tone: 'accent', reason: `message waiting — ${info.queueWaiting}` }
  if (status === 'idle') return { tone: 'yellow', reason: 'turn ended — not read yet' }
  return { tone: 'faint', reason: 'idle — read' }
}

const SLOT_WORDS: Record<Tone, string> = {
  red: 'broken',
  yellow: 'waiting for you',
  green: 'working',
  accent: 'will continue later',
  faint: 'nothing to report'
}

/** Slot 1: always present. Reviewers are left out — they are the review
 *  slot's. The tooltip names each session with something to say, most urgent
 *  first, and counts the quiet ones. */
export function sessionsSlot(inputs: SessionInput[]): Slot {
  const rows = inputs
    .filter((input) => sessionRole(input.info) !== 'reviewer')
    .map((input) => ({ title: input.info.title, ...sessionState(input) }))
  if (!rows.length) return { tone: 'faint', title: 'Sessions — none yet' }
  const tone = rows.reduce<Tone>((acc, row) => moreUrgent(acc, row.tone), 'faint')
  const loud = rows
    .filter((row) => row.tone !== 'faint')
    .sort((a, b) => URGENCY.indexOf(a.tone) - URGENCY.indexOf(b.tone))
  const quiet = rows.length - loud.length
  const lines = [
    `Sessions — ${SLOT_WORDS[tone]}`,
    ...loud.map((row) => `${row.title}: ${row.reason}`),
    ...(quiet ? [loud.length ? `+ ${plural(quiet, 'quiet session')}` : `${plural(quiet, 'session')}, all quiet`] : [])
  ]
  return { tone, title: lines.join('\n') }
}

// ---- slot 3: delivery --------------------------------------------------------

/**
 * Where a repo's work stands against its default branch, for the repos that
 * differ from it at all:
 *   conflict — an update from the default branch left conflicts
 *   local    — uncommitted changes, or commits not pushed yet
 *   pushed   — everything pushed, waiting for someone to merge it
 */
export type DeliveryKind = 'conflict' | 'local' | 'pushed'

/** Phase 1: presence only, every kind gray. The planned colours are a change
 *  to this table alone — conflict red, local (unpushed) yellow, pushed
 *  (awaiting merge) blue (§7, phase 3). */
export const DELIVERY_TONE: Record<DeliveryKind, Tone> = {
  conflict: 'faint',
  local: 'faint',
  pushed: 'faint'
}

/** The repo's delivery kind, or undefined when it does not differ from its
 *  default branch: neither dirty nor holding unintegrated commits. */
export function repoDelivery(repo: RepoChanges): DeliveryKind | undefined {
  if (!repo.dirty && (repo.integrated || !repo.commits.length)) return undefined
  if (repo.conflicted) return 'conflict'
  if (isActionable(repo)) return 'local'
  if (isDelivered(repo)) return 'pushed'
  return 'local'
}

function repoLine(repo: RepoChanges, kind: DeliveryKind): string {
  const parts: string[] = []
  if (kind === 'conflict') parts.push('merge conflicts')
  if (repo.dirty) parts.push('uncommitted changes')
  if (!repo.integrated && repo.commits.length) {
    const unpushed = repo.commits.filter((c) => !c.pushed).length
    parts.push(
      `${plural(repo.commits.length, 'commit')} not on ${repo.defaultBranch}` +
        (unpushed === repo.commits.length ? ', unpushed' : unpushed ? `, ${unpushed} unpushed` : ', pushed')
    )
  }
  return `${repo.repo}: ${parts.join(' · ')}`
}

/** Slot 3: present when any repo differs from its default branch, absent when
 *  the scope has no repos or none differs. */
export function deliverySlot(repos: RepoChanges[]): Slot | undefined {
  const differing = repos.flatMap((repo) => {
    const kind = repoDelivery(repo)
    return kind ? [{ repo, kind }] : []
  })
  if (!differing.length) return undefined
  const tone = differing.reduce<Tone>((acc, { kind }) => moreUrgent(acc, DELIVERY_TONE[kind]), 'faint')
  return {
    tone,
    title: ['Changes vs the default branch', ...differing.map(({ repo, kind }) => repoLine(repo, kind))].join('\n')
  }
}

// ---- the strip ---------------------------------------------------------------

export function scopeStatus(sessions: SessionInput[], repos: RepoChanges[]): ScopeStatus {
  // Phase 2 adds `review` from the per-scope RPM aggregate.
  return { sessions: sessionsSlot(sessions), delivery: deliverySlot(repos) }
}
