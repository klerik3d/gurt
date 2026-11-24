// `RpmTools` (t3v2 §4.3, §5): the definitions and instructions come from
// rpm/core; `call` checks a model's call against the run as it is now (the
// fold) and returns the normalized payload that the session manager puts into
// the turn. Nothing is written here: the engine records the turn's result.
import {
  allowedReplies,
  replyFindingsSchema,
  rpmInstructions,
  rpmToolsFor,
  submitReviewSchema,
  type Finding,
  type ReplyFindingsInput,
  type RunState,
  type SubmitReviewInput
} from '../core'
import type { RpmTools } from './api'
import type { Journals } from './journals'
import type { RpmPorts } from './ports'

export function createTools(ports: RpmPorts, journals: Journals): RpmTools {
  return {
    for: (role) => rpmToolsFor(role),
    instructions: (role) => rpmInstructions(role),
    call(sessionId, name, input) {
      if (name === 'reply_findings') return replyFindings(ports, journals, sessionId, input)
      if (name === 'submit_review') return submitReview(ports, journals, sessionId, input)
      throw new Error(`unknown tool: ${name}`)
    }
  }
}

function invalid(issues: readonly { path: readonly PropertyKey[]; message: string }[]): Error {
  return new Error(issues.map((i) => `${i.path.map(String).join('.') || 'input'}: ${i.message}`).join('; '))
}

function replyFindings(ports: RpmPorts, journals: Journals, sessionId: string, input: unknown): { payload: unknown; text: string } {
  const live = ports.sessions.info(sessionId)?.role === 'executor' ? journals.live(sessionId) : undefined
  if (!live) throw new Error('gurt sent you no findings: there is nothing to reply to.')
  const parsed = replyFindingsSchema.safeParse(input)
  if (!parsed.success) throw invalid(parsed.error.issues)
  const { replies } = parsed.data
  const run = live.state
  const errors: string[] = []
  for (const r of replies) {
    const f = run.findings.find((x) => x.id === r.id)
    if (!f) {
      errors.push(`${r.id} is not a finding of this review.`)
      continue
    }
    const allowed = allowedReplies(f.state)
    if (!allowed.includes(r.act)) errors.push(`${r.id}: "${r.act}" is not possible — ${whatNow(run, f)}`)
  }
  if (errors.length) throw new Error(`Nothing was recorded. ${errors.join(' ')}`)
  const payload: ReplyFindingsInput = { replies: replies.map((r) => ({ id: r.id, act: r.act, comment: r.comment.trim() })) }
  return {
    payload,
    text: `Recorded: ${payload.replies.map((r) => `${r.id} ${r.act}`).join(', ')}. The replies take effect when your turn ends; for each finding the last reply counts.`
  }
}

/** What is going on with a finding now, for a refused reply (t3v2 §5.1). */
function whatNow(run: RunState, f: Finding): string {
  const last = run.history[f.id]?.filter((h) => !h.ignored).at(-1)
  switch (f.state) {
    case 'open':
      return `${f.id} is open: answer fixed, contested or cant.`
    case 'must':
      return `the user decided ${f.id} must be fixed: answer fixed or cant.`
    case 'defer':
      return `the user deferred ${f.id}: write it down where asked and answer documented.`
    case 'fixed':
    case 'contested':
    case 'documented':
      return `you already answered ${f.state} on ${f.id}; it waits for the reviewer — nothing to do now.`
    case 'disputed':
    case 'cant':
      return `${f.id} waits for the user's decision — nothing to do now.`
    case 'closed':
      return `${f.id} is closed: the reviewer accepted the fix — nothing is needed on it.`
    case 'rejected':
      return last?.by === 'you'
        ? `the user rejected ${f.id} — nothing is needed on it.`
        : `${f.id} is withdrawn: the reviewer accepted your objection — nothing is needed on it.`
    case 'deferred':
      return `${f.id} is deferred and documented — nothing is needed on it.`
  }
}

function submitReview(ports: RpmPorts, journals: Journals, sessionId: string, input: unknown): { payload: unknown; text: string } {
  const of = ports.sessions.info(sessionId)?.reviewerOf
  const live = of ? journals.live(of.executor) : undefined
  const step = live?.state.step
  if (!of || !live || !step || step.what !== 'review' || step.key !== of.key) {
    throw new Error('This review is not running any more: there is nothing to submit.')
  }
  const parsed = submitReviewSchema.safeParse(input)
  if (!parsed.success) throw invalid(parsed.error.issues)
  const review = parsed.data
  const items = step.items ?? []
  const full = step.full ?? true
  const errors: string[] = []

  const given = review.verify.map((v) => v.id)
  const missing = items.filter((id) => !given.includes(id))
  const extra = given.filter((id) => !items.includes(id))
  if (missing.length) errors.push(`verify is missing: ${missing.join(', ')}.`)
  if (extra.length) errors.push(`verify has items you were not given: ${extra.join(', ')}.`)
  if (!items.length && given.length) errors.push('you were given nothing to verify: verify must be empty.')

  if (!full && review.findings.length) errors.push('this review only verifies the given items: findings must be empty.')

  const repos = ports.sessions.info(of.executor)?.writeRepos ?? live.state.base.map((b) => b.repo)
  review.findings.forEach((f, i) => {
    if (f.file === undefined) return
    const repo = repos.find((r) => f.file?.startsWith(`${r}/`) && f.file.length > r.length + 1)
    if (!repo) errors.push(`findings[${i}].file "${f.file}" must be <repo>/<path> in one of: ${repos.join(', ')}.`)
  })

  if (errors.length) throw new Error(`The review was not accepted. ${errors.join(' ')} Fix it and call submit_review again.`)

  const byId = new Map(review.verify.map((v) => [v.id, v]))
  const payload: SubmitReviewInput = {
    findings: review.findings.map((f) => ({
      severity: f.severity,
      ...(f.file !== undefined && { file: f.file }),
      ...(f.line !== undefined && { line: f.line }),
      claim: f.claim.trim(),
      scenario: f.scenario.trim()
    })),
    verify: items.map((id) => {
      const v = byId.get(id)!
      return { id, accept: v.accept, comment: v.comment.trim() }
    })
  }
  return {
    payload,
    text: `Review accepted: ${payload.findings.length} new finding(s), ${payload.verify.length} item(s) verified. This is your turn's result; you are done.`
  }
}
