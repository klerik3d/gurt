import type {
  ChangeProposal,
  SessionRole,
  StoredProposal
} from '../../shared/types'
import { WATCHER_FINAL_NUDGE_PROMPT, WATCHER_NUDGE_PROMPT } from '../../shared/watchers'
import type { PostTurnAction } from './types'

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

/** The same for an RPM reviewer, whose terminal tool is `submit_review`
 *  (t3v2 §5.2). */
export const REVIEWER_NUDGE_PROMPT =
  'You ended your turn without calling the `submit_review` tool. Call ' +
  '`submit_review` now with your findings and the verification of the items ' +
  'you were given, and do nothing else.'

/** The terminal tool of a role's turn contract (see `roleHasTurnContract`) —
 *  what its nudge asks for and its `incomplete` line names. */
export const contractToolFor = (role: SessionRole): string =>
  role === 'proactive'
    ? 'finish_run'
    : role === 'reviewer'
      ? 'submit_review'
      : role === 'watcher'
        ? 'wake_me / watch / finish_watch'
        : 'complete'

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

/** One repo's view of a stored proposal: its own `repos` entry when it has one,
 *  else the shared commit/pr; undefined when neither applies. */
export function proposalForRepo(p: StoredProposal, repo: string): StoredProposal | undefined {
  const own = p.repos?.find((r) => r.repo === repo)
  const { repos: _repos, ...shared } = p
  if (own) return { ...shared, commit: own.commit, pr: own.pr }
  return shared.commit ? shared : undefined
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
