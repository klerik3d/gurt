import type {
  ChangeProposal,
  FindingReply,
  ReviewVerdict,
  SessionRole,
  StoredProposal
} from '../../shared/types'
import { CONTAINER_ROOT } from '../../shared/files'
import { WATCHER_FINAL_NUDGE_PROMPT, WATCHER_NUDGE_PROMPT } from '../../shared/watchers'
import type { PostTurnAction, TurnHow, TurnResult } from './types'

/** The one automatic follow-up sent when a turn ends without `complete`. */
export const NUDGE_PROMPT =
  'You ended your turn without calling the `complete` tool. Call `complete` ' +
  'now with the correct outcome (changes / no_changes / blocked) and do ' +
  'nothing else.'

/** The same follow-up for a proactive run, whose terminal tool is `finish_run`
 *  (docs/design-proactive-agents.md §4). */
export const PROACTIVE_NUDGE_PROMPT =
  'You ended your turn without calling the `finish_run` tool. Call `finish_run` ' +
  'now with a short summary of this run (and the cursor to resume from, if ' +
  'any) and do nothing else.'

/** The same for a review loop's reviewer, whose terminal tool is
 *  `submit_review` (docs/requirements-review-loop.md §4). */
export const REVIEWER_NUDGE_PROMPT =
  'You ended your turn without calling the `submit_review` tool. Call ' +
  '`submit_review` now with your verdict (approve / request_changes), a ' +
  'summary and the findings, and do nothing else.'

/** The terminal tool of a role's turn contract (see `roleHasTurnContract`) —
 *  what its nudge asks for and its `incomplete` line names. */
export const contractToolFor = (role: SessionRole): string =>
  role === 'proactive' ? 'finish_run' : role === 'reviewer' ? 'submit_review' : role === 'watcher' ? 'wake_me / watch / finish_watch' : 'complete'

/** The nudge for a role's turn contract. */
export const nudgePromptFor = (role: SessionRole, final = false): string =>
  role === 'proactive'
    ? PROACTIVE_NUDGE_PROMPT
    : role === 'reviewer'
      ? REVIEWER_NUDGE_PROMPT
      : role === 'watcher'
        ? final
          ? WATCHER_FINAL_NUDGE_PROMPT
          : WATCHER_NUDGE_PROMPT
        : NUDGE_PROMPT

/**
 * The host-side rules of a `complete` call that its schema cannot carry
 * (docs/requirements-repo-mounts.md §3): every per-repo entry names one of the
 * session's `write` repos, at most once. Pure and unit-tested; the message is
 * what the agent gets back as an `isError` result.
 */
export function assertProposalFits(writes: readonly string[], p: ChangeProposal): void {
  const seen = new Set<string>()
  for (const { repo } of p.repos ?? []) {
    if (!writes.includes(repo))
      throw new Error(
        writes.length
          ? `repo "${repo}" is not mounted for write in this session — propose only for: ${writes.join(', ')}`
          : `repo "${repo}" is not mounted for write in this session — it writes no repository`
      )
    if (seen.has(repo)) throw new Error(`repo "${repo}" is named twice in \`repos\``)
    seen.add(repo)
  }
}

/**
 * The open-set rule of a `complete` with `changes` (docs/requirements-review-
 * loop.md §4.2): `replies` answers every open finding exactly once and names
 * no finding outside the set. Pure and unit-tested; the message — every
 * offending ref named — is what the agent gets back as an `isError` result.
 * An empty open set asks for nothing.
 */
export function assertRepliesAnswer(open: readonly string[], replies: readonly FindingReply[] | undefined): void {
  if (!open.length) return
  const count = new Map<string, number>()
  for (const r of replies ?? []) count.set(r.findingId, (count.get(r.findingId) ?? 0) + 1)
  const missing = open.filter((id) => !count.has(id))
  const unknown = [...count.keys()].filter((id) => !open.includes(id))
  const twice = [...count].filter(([id, n]) => n > 1 && open.includes(id)).map(([id]) => id)
  const problems = [
    ...(missing.length ? [`not answered: ${missing.join(', ')}`] : []),
    ...(unknown.length ? [`not open: ${unknown.join(', ')}`] : []),
    ...(twice.length ? [`answered more than once: ${twice.join(', ')}`] : [])
  ]
  if (problems.length)
    throw new Error(
      `\`replies\` must answer every open review finding (${open.join(', ')}) exactly once — ${problems.join('; ')}`
    )
}

/**
 * The host rule of a `submit_review` call that its schema cannot carry
 * (docs/requirements-review-loop.md §4.1): every finding's `file` is
 * `<repo>/<path>` with `<repo>` one of the session's repos — never an absolute
 * path, never a `..` out of it. Pure, like {@link assertProposalFits}.
 */
export function assertVerdictFits(repos: readonly string[], v: ReviewVerdict): void {
  for (const f of v.findings) {
    const parts = f.file.split('/')
    if (!repos.includes(parts[0] ?? '') || parts.includes('..'))
      throw new Error(
        `finding "${f.id}": file "${f.file}" names no repository of this session — write it as ` +
          `<repo>/<path> relative to ${CONTAINER_ROOT}, <repo> one of: ${repos.join(', ') || '(none)'}`
      )
  }
}

/** One repo's view of a stored proposal: its own `repos` entry when it has one,
 *  else the shared commit/pr; undefined when neither applies. */
export function proposalForRepo(p: StoredProposal, repo: string): StoredProposal | undefined {
  const own = p.repos?.find((r) => r.repo === repo)
  const { repos: _repos, ...shared } = p
  if (own) return { ...shared, commit: own.commit, pr: own.pr }
  return shared.commit ? shared : undefined
}

/** How a logical turn ended, from its last round-trip (its nudge, when it had
 *  one): threw, the user's Esc, another non-`end_turn` stop, or a clean end with
 *  or without the contract tool (`incomplete`, §5.1). */
export function turnHow(last: TurnResult, incomplete: boolean): TurnHow {
  if (last.threw) return { failed: { stopReason: 'error' }, incomplete: false }
  if (last.stopReason === 'cancelled') return { cancelled: true, incomplete: false }
  if (last.stopReason && last.stopReason !== 'end_turn')
    return { failed: { stopReason: last.stopReason }, incomplete: false }
  return { incomplete }
}

/**
 * Decide what to do once a turn ends, from whether `complete` was seen. Pure and
 * unit-tested (scripts/turn-contract.test.mjs): only a clean `end_turn` that
 * skipped `complete` triggers healing — one nudge for a regular turn, an
 * `incomplete` mark for the nudge turn itself. A thrown prompt, a cancel, or any
 * non-`end_turn` stop never nudges.
 *
 * `hasContract` is false for the roles that are not offered `complete` at all
 * (researcher, inspector, operator): nudging them would demand a tool their `gurt` server
 * does not expose, so their turns simply end.
 */
export function postTurnDecision(o: {
  stopReason?: string | undefined
  turnComplete: boolean
  threw: boolean
  isNudge: boolean
  hasContract: boolean
  /** The turn ended on a provider limit: a nudge would only be refused too,
   *  and the session continues on its own once the limit resets. */
  limited?: boolean | undefined
}): PostTurnAction {
  if (!o.hasContract) return 'none'
  if (o.limited) return 'none'
  if (o.threw) return 'none'
  if (o.stopReason !== 'end_turn') return 'none'
  if (o.turnComplete) return 'none'
  return o.isNudge ? 'incomplete' : 'nudge'
}
