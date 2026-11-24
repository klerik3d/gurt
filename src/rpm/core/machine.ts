// The finding machine (t1v6 §1–2): one move on one finding, and the helpers
// "whose move" and "is it tracked" that the fold, `next` and the view share.
import type { Act, Actor, Finding, FindingState, Owner, ReplyAct, RpmConfig, RunState, Severity } from './model'

const OWNER: Record<FindingState, Owner> = {
  open: 'executor', must: 'executor', defer: 'executor',
  fixed: 'reviewer', contested: 'reviewer', documented: 'reviewer',
  disputed: 'you', cant: 'you',
  closed: 'none', rejected: 'none', deferred: 'none'
}

/** Whose move a finding in `state` waits for. */
export function ownerOf(state: FindingState): Owner {
  return OWNER[state]
}

/** The executor's allowed answers per state (t1v6 §2). The act names the state it leads to. */
const EXECUTOR_MOVES: Partial<Record<FindingState, readonly ReplyAct[]>> = {
  open: ['fixed', 'contested', 'cant'],
  must: ['fixed', 'cant'],
  defer: ['documented']
}

/** What the executor may answer on a finding in `state`. */
export function allowedReplies(state: FindingState): readonly ReplyAct[] {
  return EXECUTOR_MOVES[state] ?? []
}

const RANK: Record<Severity, number> = { blocker: 0, major: 1, minor: 2, nit: 3 }

/** Severity at or above the threshold. */
export function atOrAbove(s: Severity, threshold: Severity): boolean {
  return RANK[s] <= RANK[threshold]
}

/** Tracked = at or above the threshold, or has your verdict (t1v6 §4). */
export function tracked(run: Pick<RunState, 'config' | 'decided'>, f: Finding): boolean {
  return atOrAbove(f.severity, run.config.threshold) || run.decided.includes(f.id)
}

/**
 * One move (t1v6 §2). Returns the finding after the move, or 'not-allowed'.
 * - Executor: the answers of EXECUTOR_MOVES.
 * - Reviewer: yes/no on fixed, contested, documented. "No" on fixed/documented
 *   sends it back (+1 attempt); the N-th refusal (N = cfg.attempts) → disputed.
 *   "No" on contested → disputed.
 * - You: a verdict on any finding, any time; attempts → 0.
 */
export function move(f: Finding, by: Actor, act: Act, cfg: Pick<RpmConfig, 'attempts'>): Finding | 'not-allowed' {
  if (by === 'you') {
    if (typeof act !== 'object' || !('verdict' in act)) return 'not-allowed'
    if (act.verdict === 'must') return { ...f, state: 'must', back: 'must', attempts: 0 }
    if (act.verdict === 'reject') return { ...f, state: 'rejected', attempts: 0 }
    return { ...f, state: 'defer', attempts: 0 }
  }
  if (by === 'executor') {
    if (typeof act !== 'string' || !allowedReplies(f.state).includes(act)) return 'not-allowed'
    return { ...f, state: act }
  }
  if (by === 'reviewer') {
    if (typeof act !== 'object' || !('verify' in act)) return 'not-allowed'
    const refuse = (to: FindingState): Finding => {
      const attempts = f.attempts + 1
      return { ...f, attempts, state: attempts >= cfg.attempts ? 'disputed' : to }
    }
    switch (f.state) {
      case 'fixed': return act.verify ? { ...f, state: 'closed' } : refuse(f.back)
      case 'contested': return { ...f, state: act.verify ? 'rejected' : 'disputed' }
      case 'documented': return act.verify ? { ...f, state: 'deferred' } : refuse('defer')
      default: return 'not-allowed'
    }
  }
  return 'not-allowed'
}
