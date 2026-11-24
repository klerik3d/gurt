// "What next" (t1v6 §4, t3v2 §2.2): decided only at a step boundary; the
// first rule that matches wins. Counters of rules 3а, 3б, 5, 8 run since your
// last entry (the fold keeps them).
import { ownerOf, tracked } from './machine'
import { CHECK_RED_LIMIT, type Facts, type Next, type RunState } from './model'

type Commands = { repo: string; command: string }[]

function sameCommands(a: Commands, b: Commands): boolean {
  const key = (c: Commands): string => c.map((x) => `${x.repo}\0${x.command}`).sort().join('\n')
  return key(a) === key(b)
}

export function next(run: RunState, facts: Facts): Next {
  if (run.ended) throw new Error(`rpm: next() on run ${run.run}, which has ended (${run.ended})`)
  if (run.step) return { do: 'wait', why: 'step-running' }

  // No command on any write repo: no check steps at all (t3v2 §6.2).
  const checks = facts.checks.length > 0
  const commandChanged = checks && run.lastCheck !== undefined && !sameCommands(run.lastCheck.commands, facts.checks)

  const live = run.findings.filter((f) => tracked(run, f))
  const ids = (owner: 'executor' | 'reviewer'): string[] => live.filter((f) => ownerOf(f.state) === owner).map((f) => f.id)

  // Rerun: this step at the nearest boundary, out of the rules' order — also
  // when paused or called (t3v2 §6.3); a rerun review is full.
  // TODO(rpm): rerun-check with no check configured stays pending and is skipped.
  if (run.rerun === 'check' && checks) return { do: 'check' }
  if (run.rerun === 'review') return { do: 'review', full: true, verify: ids('reviewer') }

  // 1. Paused, or you were called and have not answered yet.
  if (run.paused) return { do: 'wait', why: 'paused' }
  if (run.called) {
    // A new check command while you are called about the check runs it on the
    // same tree (t1v6 §3 "что можешь ты"); anything else waits for you.
    const aboutCheck = run.called === 'check-red' || run.called === 'check-unchanged'
    if (!(aboutCheck && commandChanged)) return { do: 'wait', why: 'called' }
  }
  // The last step gave no result (t3v2 §12): call you; Continue (any entry of yours) re-decides.
  if (run.failed) return { do: 'call', why: run.failed }

  // 2. No check yet, the code changed since the last check, or the command changed.
  if (checks && (!run.lastCheck || run.lastCheck.tree !== facts.tree || commandChanged)) return { do: 'check' }

  // 3. The check is red.
  const lc = checks ? run.lastCheck : undefined
  if (lc && !lc.ok) {
    const t = run.lastTurn
    // 3а: the executor moved after the red check, and the code is the same.
    if (t && t.seq > lc.seq && t.seq > run.lastYou && facts.tree === lc.tree) return { do: 'call', why: 'check-unchanged' }
    // 3б: red CHECK_RED_LIMIT times in a row.
    if (run.sinceYou.redChecks >= CHECK_RED_LIMIT) return { do: 'call', why: 'check-red' }
    // 3в: the executor fixes the check.
    return { do: 'fix-check' }
  }

  // 4. A finding in dispute or "can't": call you, everything waits.
  if (live.some((f) => ownerOf(f.state) === 'you')) return { do: 'call', why: 'findings' }

  // 5. An idle executor turn: no reply, the code the same as when the step began.
  const t = run.lastTurn
  if (t && t.step !== undefined && t.step === run.lastStep && t.seq > run.lastYou && t.replies === 0 && t.before === facts.tree) {
    return { do: 'call', why: 'idle-executor' }
  }

  // 6. The code changed since the last review, or items wait for the reviewer.
  //    One exception: a finding that was stuck with you (disputed/cant) and
  //    that your verdict sent back to the executor goes there first, and the
  //    review waits for it — the rest of the batch waited for you (t1v6 §1),
  //    and it keeps waiting until that finding catches up (§7 run в: F2 waits
  //    while F1 is documented, then R2 verifies both). A verdict on any other
  //    finding does not jump the review.
  const forReviewer = ids('reviewer')
  const forExecutor = ids('executor')
  const codeChanged = !run.lastReview || run.lastReview.tree !== facts.tree
  const yoursFirst = forExecutor.some((id) => run.fresh.includes(id))
  if (!yoursFirst && (codeChanged || forReviewer.length > 0)) {
    return { do: 'review', full: codeChanged, verify: forReviewer }
  }

  // 7. Every tracked finding is final.
  if (live.every((f) => ownerOf(f.state) === 'none')) return { do: 'mark' }

  // 8. The review budget since your last entry is spent.
  if (run.sinceYou.reviews >= run.config.reviews) return { do: 'call', why: 'budget' }

  // 9. Only the executor has moves left.
  return { do: 'executor', items: forExecutor }
}
