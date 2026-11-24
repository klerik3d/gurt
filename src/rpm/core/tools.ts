// The model tools (t3v2 §5): their zod schemas, descriptions, and the session
// instructions. Shape only — checking a call against the run is rpm/main's job
// (task 8).
import { z } from 'zod'
import type { SessionRole } from '../../shared/types'
import type { RpmToolDef, RpmToolName } from './model'

/** A role as RPM knows it. `'reviewer'` comes back to SessionRole in task 5. */
export type RpmRole = SessionRole | 'reviewer'

const uniqueIds = (xs: { id: string }[]): boolean => new Set(xs.map((x) => x.id)).size === xs.length

export const replyFindingsSchema = z.object({
  replies: z
    .array(
      z.object({
        id: z.string().min(1).describe('The finding id, e.g. F2.'),
        act: z.enum(['fixed', 'contested', 'cant', 'documented']).describe('fixed — changed the code; contested — the finding does not hold; cant — you cannot do it; documented — written down where asked.'),
        comment: z.string().min(1).max(2000).describe('What you did, or why.')
      })
    )
    .min(1)
    .max(50)
    .refine(uniqueIds, { message: 'each id once per call' })
})

export const submitReviewSchema = z.object({
  findings: z
    .array(
      z.object({
        severity: z.enum(['blocker', 'major', 'minor', 'nit']),
        file: z.string().min(1).optional().describe('`<repo>/<path>` in one of the repositories under review.'),
        line: z.number().int().positive().optional(),
        claim: z.string().min(1).max(4000).describe('What is wrong.'),
        scenario: z.string().min(1).max(4000).describe('The concrete input or state, and the wrong result.')
      })
    )
    .max(50)
    .describe('New problems. Empty when there are none, and always empty in a verify-only review.'),
  verify: z
    .array(
      z.object({
        id: z.string().min(1),
        accept: z.boolean().describe('true — fixed / the executor is right / written down; false — not.'),
        comment: z.string().min(1).max(2000).describe('Why.')
      })
    )
    .refine(uniqueIds, { message: 'each item once' })
    .describe('Exactly the items you were given to verify, each once. Empty when none were given.')
})

export type ReplyFindingsInput = z.infer<typeof replyFindingsSchema>
export type SubmitReviewInput = z.infer<typeof submitReviewSchema>

export const rpmToolSchemas: Record<RpmToolName, RpmToolDef> = {
  reply_findings: {
    name: 'reply_findings',
    description:
      'Answer the review findings gurt sent you: one reply per finding (id, act, comment). Call before `complete`; ' +
      'you may call again — the last reply per finding counts. Refused when gurt sent you no findings or the act is not allowed for that finding.',
    schema: replyFindingsSchema
  },
  submit_review: {
    name: 'submit_review',
    description:
      'Send your review: new findings (severity, file and line, claim, scenario) and a decision on every item you were given to verify. ' +
      'Call once at the end of every turn, as the last action; if refused, fix what the refusal says and call again.',
    schema: submitReviewSchema
  }
}

/** The RPM tools a session of this role gets. */
export function rpmToolsFor(role: RpmRole): RpmToolDef[] {
  if (role === 'executor') return [rpmToolSchemas.reply_findings]
  if (role === 'reviewer') return [rpmToolSchemas.submit_review]
  return []
}

/** The paragraph RPM adds to the session's instructions. */
export function rpmInstructions(role: RpmRole): string | undefined {
  if (role === 'executor') {
    return (
      'Review findings: when a gurt message brings you review findings (F1, F2…), answer each with `reply_findings` ' +
      'before you call `complete` — fixed, contested, cant or documented, with a comment. If gurt sent you no findings, do not call it.'
    )
  }
  if (role === 'reviewer') {
    return (
      'You are a gurt reviewer. You only read: every repository is mounted read-only — do not edit files, commit or push. ' +
      'End every turn with `submit_review`, as your last action: the new findings, each with a scenario, and a decision on every item ' +
      'you were given to verify, each exactly once. If gurt refuses the call, fix it and call again.'
    )
  }
  return undefined
}
