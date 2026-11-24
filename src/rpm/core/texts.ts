// What the models see (t1v6 §6, t3v2 §2.2, §5). Built only from RunState and
// the ports' data.
//
// - Reviewer: the task, the diff, the check, the findings so far with their
//   history (comments, severity changes), the items to verify, the severity
//   definitions, the scenario rule. Never the threshold, the budget, the round
//   number, the attempts, or what follows its answer.
// - Executor: only its own items (tracked, its move), the allowed replies, the
//   last comments of the reviewer and yours, your notes. On a red check — only
//   the check's output.
import { allowedReplies, ownerOf, tracked } from './machine'
import type { CheckRun, Finding, FindingState, HistoryItem, ReplyAct, ReviewerInput, RunState } from './model'

// --- shared pieces ------------------------------------------------------------------

const where = (f: Pick<Finding, 'file' | 'line'>): string => (f.file ? ` · ${f.file}${f.line !== undefined ? `:${f.line}` : ''}` : '')

const quote = (s: string): string => s.split('\n').map((l) => `  > ${l}`).join('\n')

/** Plain words for a state, as the reviewer reads it (no attempts, no rules). */
const STATE_FOR_REVIEWER: Record<FindingState, string> = {
  open: 'open — waiting for the executor',
  must: 'open — the user requires a fix',
  defer: 'deferred by the user — the executor is to write it down',
  fixed: 'the executor says it is fixed — to verify',
  contested: 'the executor contests it — to verify',
  documented: 'the executor says it is written down — to verify',
  disputed: 'in dispute — waiting for the user',
  cant: 'the executor cannot do it — waiting for the user',
  closed: 'closed — fixed and verified',
  rejected: 'rejected — no action needed',
  deferred: 'deferred — written down for later'
}

const ACT_WORDS: Record<ReplyAct, string> = {
  fixed: 'fixed',
  contested: 'contested',
  cant: "can't",
  documented: 'documented'
}

function historyLine(h: HistoryItem): string | undefined {
  const who = h.by === 'you' ? 'user' : h.by
  let what: string
  if (h.severity) what = `severity ${h.severity.from} → ${h.severity.to}`
  else if (h.ignored) what = `${h.to ?? 'answer'} (did not apply)`
  else if (h.by === 'reviewer' && h.from === undefined) what = 'raised'
  else if (h.by === 'reviewer') what = h.to === 'closed' || h.to === 'rejected' || h.to === 'deferred' ? 'accepted' : 'not accepted'
  else if (h.by === 'you') what = h.to === 'must' ? 'verdict: must do' : h.to === 'rejected' ? 'verdict: reject' : 'verdict: defer'
  else if (h.by === 'executor' && h.to) what = ACT_WORDS[h.to as ReplyAct] ?? h.to
  else return undefined
  return `  - ${who}: ${what}${h.comment ? ` — ${JSON.stringify(h.comment)}` : ''}`
}

const SEVERITY_DEFINITIONS = [
  '- blocker — the change is broken: data loss, a crash or a security hole on a normal path, or the task is not done.',
  '- major — a real bug a user will hit: wrong result, a broken case of the task, a missing piece the task asked for.',
  '- minor — a rare edge case, a small inconsistency, a weak spot that works today.',
  '- nit — style, naming, wording, taste.'
].join('\n')

// --- reviewer ------------------------------------------------------------------------

export function reviewerPrompt(run: RunState, input: ReviewerInput): string {
  const out: string[] = []
  out.push(
    'You review the work of another agent (the executor) on the task below. You only read: the repositories are mounted read-only.',
    'Finish the turn with one call of `submit_review`, as your last action.'
  )

  out.push('', '## Task', '')
  out.push(input.task.length ? input.task.map((t) => t.trim()).join('\n\n---\n\n') : '(the user gave no text — judge the change by itself)')

  out.push('', '## Changes', '')
  if (input.diffs.length === 0) out.push('No changes.', '')
  for (const d of input.diffs) {
    out.push(`### ${d.repo} (/workspaces/${d.repo})`, '')
    for (const f of d.files) out.push(`- ${f.status} ${f.path}`)
    out.push('', '```diff', d.text, '```')
    if (d.truncated) out.push(`The diff is cut short: read the rest of the files in /workspaces/${d.repo}.`)
    out.push('')
  }

  out.push('## Check', '')
  if (input.check === 'not-configured') out.push('No check is configured for these repositories: tests were not run.')
  else if (input.check.ok) out.push(`The check passed: ${input.check.runs.map((r) => `\`${r.command}\` in ${r.repo}`).join(', ')}.`)
  else out.push(checkOutput(input.check.runs))

  if (run.findings.length) {
    out.push('', '## Findings so far', '')
    out.push('Earlier reviews of this task raised these. Do not raise them again; the user\'s decisions stand.')
    for (const f of run.findings) {
      out.push('', `${f.id} · ${f.severity}${where(f)} — ${STATE_FOR_REVIEWER[f.state]}`)
      out.push(quote(f.claim), `  Scenario: ${f.scenario}`)
      for (const h of run.history[f.id] ?? []) {
        const line = historyLine(h)
        if (line) out.push(line)
      }
    }
  }

  if (input.verify.length) {
    out.push('', '## Verify', '')
    out.push('Decide each item: `accept: true` or `false`, with a comment that says why.', '')
    for (const id of input.verify) {
      const f = run.findings.find((x) => x.id === id)
      if (!f) continue
      const reply = [...(run.history[id] ?? [])].reverse().find((h) => h.by === 'executor' && !h.ignored)
      const ask =
        f.state === 'fixed' ? 'Is it fixed in the code now?'
        : f.state === 'contested' ? 'Is the executor right that the finding does not hold?'
        : f.state === 'documented' ? 'Is it written down where it was asked?'
        : 'Does it hold now?'
      out.push(`- ${id}: ${ask}${reply?.comment ? ` The executor: ${JSON.stringify(reply.comment)}` : ''}`)
    }
  }

  out.push('', '## What to send', '')
  if (input.full) {
    out.push(
      'Read the whole change for problems the task or its users would hit. Each problem is one finding: severity, file (`<repo>/<path>`) and line when you can, the claim, and a scenario.',
      'No problems — send an empty `findings`.'
    )
  } else {
    out.push('The code has not changed since the last review: only verify the items above. Send an empty `findings`.')
  }
  out.push(
    '`verify` holds every item of the Verify list exactly once, and nothing else.',
    '',
    'Severity:',
    SEVERITY_DEFINITIONS,
    '',
    'Every finding needs a scenario: the concrete input or state, and the wrong result it leads to. No scenario — no finding.'
  )
  return out.join('\n')
}

// --- executor ------------------------------------------------------------------------

function lastComment(run: RunState, id: string, by: 'reviewer' | 'you'): string | undefined {
  return [...(run.history[id] ?? [])].reverse().find((h) => h.by === by && h.comment)?.comment
}

const ASK: Partial<Record<FindingState, string>> = {
  open: 'The reviewer asks for a fix.',
  must: 'The user requires a fix.',
  defer: 'The user deferred it: write it down for later (see the comment for where).'
}

const ACT_HELP: Record<ReplyAct, string> = {
  fixed: 'fixed — you changed the code',
  contested: 'contested — the finding does not hold; say why',
  cant: "cant — you cannot do it; say why",
  documented: 'documented — you wrote it down where asked'
}

export function executorMessage(run: RunState, items: string[], notes: string[]): string {
  const mine = items
    .map((id) => run.findings.find((f) => f.id === id))
    .filter((f): f is Finding => !!f && tracked(run, f) && ownerOf(f.state) === 'executor')
  const out: string[] = []
  out.push('gurt review: work on these findings.', '')
  for (const f of mine) {
    out.push(`${f.id} · ${f.severity}${where(f)}`, quote(f.claim), `  Scenario: ${f.scenario}`)
    out.push(`  ${ASK[f.state] ?? ''} Allowed replies: ${allowedReplies(f.state).join(', ')}.`)
    const r = lastComment(run, f.id, 'reviewer')
    if (r) out.push(`  Reviewer: ${JSON.stringify(r)}`)
    const y = lastComment(run, f.id, 'you')
    if (y) out.push(`  User: ${JSON.stringify(y)}`)
    out.push('')
  }
  if (notes.length) {
    out.push('From the user:', ...notes.map((n) => `- ${n}`), '')
  }
  const acts = [...new Set(mine.flatMap((f) => allowedReplies(f.state)))]
  out.push(
    'Before `complete`, call `reply_findings` with one reply per finding: id, act, comment.',
    ...acts.map((a) => `- ${ACT_HELP[a]}`)
  )
  return out.join('\n')
}

// --- check ---------------------------------------------------------------------------

function checkOutput(runs: CheckRun[]): string {
  const out: string[] = []
  for (const r of runs) {
    const bad = r.code !== 0 || r.timedOut
    if (!bad) {
      out.push(`\`${r.command}\` in ${r.repo}: passed.`)
      continue
    }
    out.push(`\`${r.command}\` in ${r.repo} (/workspaces/${r.repo}): ${r.timedOut ? `timed out after ${Math.round(r.ms / 1000)} s` : `failed, exit code ${r.code}`}.`)
    out.push('```', ...r.tail, '```')
  }
  return out.join('\n')
}

// TODO(rpm): notes written during the check loop are dropped: fold clears
// pendingNotes on every executor step, 3в included, and this text carries none.
export function checkMessage(runs: CheckRun[]): string {
  return [
    'gurt review: the check failed. Make it pass — nothing else for now.',
    '',
    checkOutput(runs),
    '',
    'Then `complete` as usual: gurt runs the check again.'
  ].join('\n')
}
