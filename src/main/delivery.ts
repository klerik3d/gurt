// The review loop's delivery (docs/requirements-review-loop.md §6, and the
// `deliver` rows of §8's table): host functions on top of changes.ts that the
// controller calls one step at a time — all commits, then pushes, then PRs or
// merges (`deliveryPlan` in shared/reviewLoop.ts orders them). Host side only;
// no credential ever enters a container (every call runs under the repo's
// resolved host git access, git/env.ts). The clone is the agent's to write, so
// every git call here is UNATTENDED (§6, §10): the clone's program-running
// config is pinned and no git hook runs (git/harden.ts) — the repo's `check`
// command is the quality gate, not its hooks.
//
// Each step is safe to look for and to repeat (§8): the controller writes the
// intent before the effect and the outcome after, and after a crash in between
// it simply calls the step again — the step's first move is the recovery probe
// ("is my effect already there?"), so a repeat finds it and returns the same
// DeliveredStep instead of doing it twice. Nothing is rolled back and nothing
// on a forge is ever merged; a failing step throws a typed DeliveryError.
import { cloneDir } from './store'
import { unattendedGitAccessForRepo as hostAccess, type HostGitAccess } from './git/env'
import { findOpenPullRequest, localRepoNoPr, openPullRequest } from './git/pullRequest'
import { FETCH_TIMEOUT_MS, branchFor, commit, defaultBranch, git, mergeToMain, push, revParse, serialized } from './changes'
import { diffHash, parseDiffHash, repoTree } from './treeHash'
import { createLogger } from './log'
import { deliveryPlan, type DeliveredStep } from '../shared/reviewLoop'
import type { ReviewFinding, ShipRung, StoredProposal } from '../shared/types'

const log = createLogger('delivery')

/** A step's result: the {@link DeliveredStep} §5.2 records, plus what the end
 *  should report beyond it — the step was found already done (`found`), nothing
 *  was there to commit, or a remote moved on after our push (`note`). */
export type DeliveryStepResult = DeliveredStep & { note?: string | undefined; found?: true | undefined }

export type DeliveryErrorKind =
  | 'tree-moved' // the working tree (or HEAD) is no longer what the reviewer saw
  | 'no-commit-text' // a changed write repo has no commit text in any proposal
  | 'wrong-branch' // HEAD is not the task branch (§6): nothing is committed or pushed from it
  | 'commit-failed' // `git add` / `git commit` failed (hooks are off: never a hook)
  | 'push-failed'
  | 'non-fast-forward' // the remote branch diverged from HEAD; never forced
  | 'pr-failed' // `gh`, or a repo that cannot take a PR
  | 'merge-failed'

/** How much of a failing command's output the end quotes. */
const TAIL_CHARS = 1500

/**
 * A delivery failure, typed (§6): `repo`/`step` name the failing step (absent
 * for a precondition, where `delivered` is empty and nothing was done);
 * `tail` is its output tail; `delivered` lists exactly the steps completed
 * before it — commit SHAs, branches, PR URLs. `message` is the one text the
 * `delivery-failed` event and the end carry.
 */
export class DeliveryError extends Error {
  constructor(
    readonly kind: DeliveryErrorKind,
    readonly tail: string,
    readonly repo?: string,
    readonly step?: DeliveredStep['step'],
    readonly delivered: DeliveredStep[] = []
  ) {
    super(formatDeliveryFailure(kind, tail, repo, step, delivered))
    this.name = 'DeliveryError'
  }

  /** The same failure with the steps that completed before it. */
  withDelivered(delivered: DeliveredStep[]): DeliveryError {
    return new DeliveryError(this.kind, this.tail, this.repo, this.step, delivered)
  }
}

const tailOf = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e)
  return m.length > TAIL_CHARS ? `…${m.slice(-TAIL_CHARS)}` : m
}

const stepText = (d: DeliveredStep): string => `${d.step} ${d.repo} ${d.ref}`

export function formatDeliveryFailure(
  kind: DeliveryErrorKind,
  tail: string,
  repo: string | undefined,
  step: DeliveredStep['step'] | undefined,
  delivered: DeliveredStep[]
): string {
  const at = step && repo ? `${step} of ${repo}` : (repo ?? 'preconditions')
  const done = delivered.length ? delivered.map(stepText).join('; ') : 'nothing'
  return `delivery failed (${kind}) at ${at}: ${tail}\ncompleted before it: ${done}`
}

/** What every step needs: the task, the reviewed state, the commit texts. */
export interface DeliveryContext {
  ws: string
  task: string
  /** The {@link diffHash} the reviewer saw (`LoopState.reviewedHash`). */
  reviewedHash: string
  /** The latest proposal's view of one write repo (`SessionManager.latestProposal`,
   *  which applies `proposalForRepo`): its commit text and optional PR texts. */
  proposalFor(repo: string): Pick<StoredProposal, 'commit' | 'pr'> | undefined
  /** `ReviewLoopConfig.draftPr`. */
  draftPr: boolean
  /** The final verdict's minor/nit findings — the PR body's "Review notes". */
  notes: readonly ReviewFinding[]
}

/** Commit text from a proposal: subject, blank line, body (§6). */
export function commitMessage(p: Pick<StoredProposal, 'commit'> | undefined): string | undefined {
  const c = p?.commit
  if (!c?.subject.trim()) return undefined
  const body = c.body?.trim()
  return body ? `${c.subject.trim()}\n\n${body}` : c.subject.trim()
}

const oneLine = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** At most this many findings are listed in a PR body. */
const REVIEW_NOTES_MAX = 10

/** A short "Review notes" list for a repo's PR: the final minor/nit findings
 *  whose `file` lies in that repo ('' when there are none). Typed fields only. */
export function reviewNotesSection(repo: string, notes: readonly ReviewFinding[]): string {
  const mine = notes.filter((f) => f.file.startsWith(`${repo}/`))
  if (!mine.length) return ''
  const lines = mine
    .slice(0, REVIEW_NOTES_MAX)
    .map((f) => `- [${f.severity}] \`${f.file}${f.line !== undefined ? `:${f.line}` : ''}\` — ${oneLine(f.claim, 300)}`)
  if (mine.length > REVIEW_NOTES_MAX) lines.push(`- … and ${mine.length - REVIEW_NOTES_MAX} more`)
  return `## Review notes\n${lines.join('\n')}`
}

/** PR title/body (§6): the proposal's `pr`, else its commit text, plus the
 *  review notes. */
export function prTexts(
  repo: string,
  p: Pick<StoredProposal, 'commit' | 'pr'> | undefined,
  notes: readonly ReviewFinding[]
): { title: string; body: string } {
  const title = p?.pr?.title.trim() || p?.commit?.subject.trim() || repo
  const base = (p?.pr ? p.pr.body : p?.commit?.body)?.trim() ?? ''
  return { title, body: [base, reviewNotesSection(repo, notes)].filter(Boolean).join('\n\n') }
}

async function headTree(dir: string, access: HostGitAccess): Promise<string> {
  return (await git(dir, access, ['rev-parse', '--verify', '--quiet', 'HEAD^{tree}'], { okCodes: [0, 1] })).trim()
}

/** Commits in `a` that `b` lacks. */
async function countOnly(dir: string, access: HostGitAccess, a: string, b: string): Promise<number> {
  return parseInt((await git(dir, access, ['rev-list', '--count', `${b}..${a}`])).trim(), 10)
}

/** Write repos with something to commit: working tree ≠ HEAD's tree. */
async function changedRepos(ws: string, task: string, repos: readonly string[]): Promise<string[]> {
  const out: string[] = []
  for (const repo of repos) {
    const dir = cloneDir(ws, task, repo)
    const access = await hostAccess(ws, repo)
    const [now, head] = await Promise.all([repoTree(ws, task, repo), headTree(dir, access)])
    if (now.tree !== head) out.push(repo)
  }
  return out
}

/**
 * §6's checks before any step: the hash is still the reviewed one
 * (`tree-moved`), every changed write repo has a commit text
 * (`no-commit-text`) and is on the task branch (`wrong-branch`). Throws a
 * {@link DeliveryError} with nothing done.
 */
export async function checkDeliveryPreconditions(ctx: DeliveryContext, writeRepos: readonly string[]): Promise<void> {
  const now = await diffHash(ctx.ws, ctx.task, writeRepos)
  if (now !== ctx.reviewedHash)
    throw new DeliveryError('tree-moved', 'the working tree changed after the review; nothing was delivered')
  const changed = await changedRepos(ctx.ws, ctx.task, writeRepos)
  const missing = changed.filter((r) => !commitMessage(ctx.proposalFor(r)))
  if (missing.length)
    throw new DeliveryError('no-commit-text', `no commit text for ${missing.join(', ')}; nothing was delivered`)
  // Every changed repo is on its task branch, before the first one is committed
  // (a half delivery is the worse outcome); each step checks again.
  for (const repo of changed)
    await expectBranch(cloneDir(ctx.ws, ctx.task, repo), await hostAccess(ctx.ws, repo), ctx.task, repo)
}

/** Where a recovery probe needs the remote as it is now. A failed fetch is
 *  logged, not fatal: the push or merge that follows reports a real problem. */
async function fetchOrigin(dir: string, access: HostGitAccess): Promise<void> {
  try {
    await serialized(dir, () => git(dir, access, ['fetch', 'origin'], { timeoutMs: FETCH_TIMEOUT_MS }))
  } catch (e) {
    log.warn('fetch before a delivery step failed', { dir, err: e })
  }
}

/** HEAD must BE the task branch (§6): the push rung pushes `origin <task
 *  branch>`, the MCP tool pushes `HEAD`, and `gh pr create` takes the head from
 *  the current branch — all three mean the same only on that branch. A detached
 *  HEAD or another branch (the agent can `git switch`) fails `wrong-branch`
 *  before anything is committed or pushed. */
async function expectBranch(
  dir: string,
  access: HostGitAccess,
  task: string,
  repo: string,
  step?: DeliveredStep['step']
): Promise<void> {
  const on = (await git(dir, access, ['symbolic-ref', '--short', '--quiet', 'HEAD'], { okCodes: [0, 1] })).trim()
  if (on !== branchFor(task))
    throw new DeliveryError('wrong-branch', `${repo}: HEAD is ${on ? `on ${on}` : 'detached'}, not on the task branch ${branchFor(task)}`, repo, step)
}

/** HEAD must still be the commit the step was decided for ('' = unchecked). */
async function expectHead(dir: string, access: HostGitAccess, repo: string, head: string): Promise<string> {
  const now = await revParse(dir, access, 'HEAD')
  if (head && now !== head)
    throw new DeliveryError('tree-moved', `${repo}: HEAD is ${now.slice(0, 12)}, not the ${head.slice(0, 12)} that was reviewed and committed`, repo)
  return now
}

const short = (sha: string): string => sha.slice(0, 12)

/** §8 `deliver` commit. `head` = HEAD before the commit (the intent's). */
async function deliverCommit(ctx: DeliveryContext, repo: string, head: string): Promise<DeliveryStepResult> {
  const dir = cloneDir(ctx.ws, ctx.task, repo)
  const access = await hostAccess(ctx.ws, repo)
  const step = 'commit'
  const reviewed = parseDiffHash(ctx.reviewedHash)?.[repo]
  if (!reviewed) throw new DeliveryError('tree-moved', `the reviewed hash has no entry for ${repo}`, repo, step)
  await expectBranch(dir, access, ctx.task, repo, step)
  const now = await repoTree(ctx.ws, ctx.task, repo)
  // Found: HEAD moved since the intent was written and its tree is the
  // reviewed tree — the commit happened and only its record was lost.
  if (head && now.head !== head) {
    if ((await headTree(dir, access)) === reviewed.tree)
      return { repo, step, ref: now.head, found: true, note: 'already committed' }
    throw new DeliveryError('tree-moved', `${repo}: HEAD moved to ${short(now.head)} and its tree is not the reviewed one`, repo, step)
  }
  if (now.tree !== reviewed.tree)
    throw new DeliveryError('tree-moved', `${repo}: the working tree is not the reviewed one`, repo, step)
  // A clean repo is skipped (§6): nothing differs from HEAD.
  if (now.tree === (await headTree(dir, access)))
    return { repo, step, ref: now.head, note: 'nothing to commit' }
  const message = commitMessage(ctx.proposalFor(repo))
  if (!message) throw new DeliveryError('no-commit-text', `no commit text for ${repo}`, repo, step)
  try {
    // Unattended: hardened git, no hooks (§6) — `--no-verify` and an empty
    // `core.hooksPath`; the message is prose, never logged (changes.commit).
    await commit(ctx.ws, ctx.task, repo, message, { noVerify: true }, true)
  } catch (e) {
    throw new DeliveryError('commit-failed', tailOf(e), repo, step)
  }
  return { repo, step, ref: await revParse(dir, access, 'HEAD') }
}

/** §8 `deliver` push. After a fetch, `origin/<branch>` containing HEAD means
 *  done — equal, or advanced since by someone else (reported). */
async function deliverPush(ctx: DeliveryContext, repo: string, head: string): Promise<DeliveryStepResult> {
  const dir = cloneDir(ctx.ws, ctx.task, repo)
  const access = await hostAccess(ctx.ws, repo)
  const step = 'push'
  const branch = branchFor(ctx.task)
  await expectBranch(dir, access, ctx.task, repo, step)
  const at = await expectHead(dir, access, repo, head)
  await fetchOrigin(dir, access)
  const remote = await revParse(dir, access, `refs/remotes/origin/${branch}`)
  if (remote) {
    if (remote === at) return { repo, step, ref: branch, found: true }
    if ((await countOnly(dir, access, at, remote)) === 0)
      return { repo, step, ref: branch, found: true, note: `origin/${branch} advanced to ${short(remote)} after our ${short(at)}` }
    // Neither contains the other: a plain push would be refused, and a forced
    // one overwrites someone's work — neither is the loop's to do.
    if ((await countOnly(dir, access, remote, at)) > 0)
      throw new DeliveryError('non-fast-forward', `origin/${branch} (${short(remote)}) has diverged from ${short(at)}; not pushed`, repo, step)
  }
  try {
    await push(ctx.ws, ctx.task, repo, { noVerify: true }, true)
  } catch (e) {
    const tail = tailOf(e)
    throw new DeliveryError(/non-fast-forward|\(fetch first\)/i.test(tail) ? 'non-fast-forward' : 'push-failed', tail, repo, step)
  }
  return { repo, step, ref: branch }
}

/** §8 `deliver` merge (local repos): the same probe against the default branch. */
async function deliverMerge(ctx: DeliveryContext, repo: string, head: string): Promise<DeliveryStepResult> {
  const dir = cloneDir(ctx.ws, ctx.task, repo)
  const access = await hostAccess(ctx.ws, repo)
  const step = 'merge'
  await expectBranch(dir, access, ctx.task, repo, step)
  const at = await expectHead(dir, access, repo, head)
  await fetchOrigin(dir, access)
  const def = await defaultBranch(dir, access)
  const remote = await revParse(dir, access, `refs/remotes/origin/${def}`)
  if (remote) {
    if (remote === at) return { repo, step, ref: def, found: true }
    if ((await countOnly(dir, access, at, remote)) === 0)
      return { repo, step, ref: def, found: true, note: `origin/${def} advanced to ${short(remote)} after our ${short(at)}` }
  }
  try {
    // Fast-forward only: a branch behind the default is refused (changes.ts).
    await mergeToMain(ctx.ws, ctx.task, repo, true)
  } catch (e) {
    const tail = tailOf(e)
    throw new DeliveryError(/is behind|non-fast-forward/i.test(tail) ? 'non-fast-forward' : 'merge-failed', tail, repo, step)
  }
  return { repo, step, ref: def }
}

/** §8 `deliver` pr: `gh pr view <branch>` finds an open PR, else open one
 *  (draft per the block). GitHub only today. */
async function deliverPr(ctx: DeliveryContext, repo: string, head: string): Promise<DeliveryStepResult> {
  const dir = cloneDir(ctx.ws, ctx.task, repo)
  const access = await hostAccess(ctx.ws, repo)
  const step = 'pr'
  const branch = branchFor(ctx.task)
  if (access.mode === 'local') throw new DeliveryError('pr-failed', localRepoNoPr(repo), repo, step)
  if (access.mode === 'blocked')
    throw new DeliveryError('pr-failed', `git access is blocked: ${access.reason ?? 'no credential resolves'}`, repo, step)
  if (!access.host?.includes('github'))
    throw new DeliveryError('pr-failed', `pull requests are opened on GitHub only (origin host: ${access.host ?? 'unknown'})`, repo, step)
  await expectBranch(dir, access, ctx.task, repo, step)
  await expectHead(dir, access, repo, head)
  const found = await findOpenPullRequest(ctx.ws, repo, dir, branch)
  if (found && 'error' in found) throw new DeliveryError('pr-failed', tailOf(found.error), repo, step)
  if (found) return { repo, step, ref: found.url, found: true, note: 'a pull request for this branch was already open' }
  const { title, body } = prTexts(repo, ctx.proposalFor(repo), ctx.notes)
  // The push rung has pushed already: the function does not push again.
  const r = await openPullRequest(ctx.ws, repo, dir, { title, body, draft: ctx.draftPr, push: false, unattended: true })
  if (!r.ok) throw new DeliveryError('pr-failed', tailOf(r.text), repo, step)
  return { repo, step, ref: r.url ?? r.text.trim().split('\n').pop() ?? branch }
}

/**
 * One delivery step, safe to repeat. `head` is the intent's recorded HEAD: for
 * a commit, HEAD before it; for the later steps, the commit they ship. Resolves
 * with the step's {@link DeliveredStep}; throws a {@link DeliveryError}
 * (`delivered` empty — the caller owns the list of completed steps).
 */
export async function deliverStep(
  ctx: DeliveryContext,
  s: { repo: string; step: DeliveredStep['step']; head: string }
): Promise<DeliveryStepResult> {
  switch (s.step) {
    case 'commit':
      return deliverCommit(ctx, s.repo, s.head)
    case 'push':
      return deliverPush(ctx, s.repo, s.head)
    case 'pr':
      return deliverPr(ctx, s.repo, s.head)
    case 'merge':
      return deliverMerge(ctx, s.repo, s.head)
  }
}

/**
 * The whole of §6 without persistence: preconditions, then the rung's steps in
 * order (all commits, then pushes, then PRs or merges), stopping at the first
 * failure with a {@link DeliveryError} that lists the completed steps. The
 * controller does not use this — it records an intent around every step — but
 * it is the contract the pieces add up to, and what the tests drive.
 */
export async function deliverAll(
  ctx: DeliveryContext,
  rung: ShipRung,
  writeRepos: readonly string[]
): Promise<DeliveryStepResult[]> {
  await checkDeliveryPreconditions(ctx, writeRepos)
  const heads = parseDiffHash(ctx.reviewedHash) ?? {}
  const repos = await changedRepos(ctx.ws, ctx.task, writeRepos)
  const done: DeliveryStepResult[] = []
  for (const s of deliveryPlan(rung, repos)) {
    const committed = done.find((d) => d.repo === s.repo && d.step === 'commit')
    // The controller's own rule (`deliverNext`): a commit's HEAD before is the
    // base, a later step's is the commit it ships.
    const head = s.step === 'commit' ? (heads[s.repo]?.head ?? '') : (committed?.ref ?? '')
    try {
      done.push(await deliverStep(ctx, { ...s, head }))
    } catch (e) {
      throw (e instanceof DeliveryError ? e : new DeliveryError('push-failed', tailOf(e), s.repo, s.step)).withDelivered(
        done.map(({ repo, step, ref }) => ({ repo, step, ref }))
      )
    }
  }
  return done
}
