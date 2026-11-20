// Manual approval of a scope's uncommitted changes (docs/requirements-review-loop.md
// §13, "Manual approval"). The Diff view's "Approve" records, per repo, the
// HEAD and the working tree as a commit would record them (`treeHash.repoTree`,
// the same fingerprint the review loop reviews and delivers by). An approval
// counts only for exactly that content: the loop ships nothing but what was
// approved (the owner's reading of "any change resets the approval"):
//  - Snapshots: on every read (the Diff view's refresh, the loop's decision)
//    an approval that no longer matches HEAD and the tree is deleted — it does
//    not come back when the content does; only another "Approve" brings it.
//  - gurt's own writers drop it whatever they leave behind (`dropApprovals`):
//    every turn of a session that writes the repo (the kernel, at
//    `session.turn` `ended`; an approval is refused while such a turn runs),
//    every run of the loop's check in it, a Files view write / rename / delete,
//    a session rewind.
// An edit made and undone outside gurt (a terminal, an editor) between two
// reads leaves exactly the approved content — which is then what ships, as
// approved. Not watched for, by decision: there is nothing unapproved to ship.
//
// A review loop whose block asks for manual approval delivers only once every
// repo it ships is approved as it is now; it asks in the chat otherwise and goes
// on when the approval lands (`ReviewLoopController.approvalChanged`).
import type { RepoChanges } from '../shared/types'
import * as store from './store'
import { cloneDir, type StoredApproval } from './store'
import * as changes from './changes'
import { unattendedGitAccessForRepo } from './git/env'
import { repoTree, type RepoTree } from './treeHash'
import { keyedChain } from './keyedChain'

/** Read-modify-write of one scope's file, one at a time. */
const chain = keyedChain()
const chained = <T>(ws: string, task: string, fn: () => Promise<T>): Promise<T> =>
  chain(JSON.stringify([ws, task]), fn)

/** Whether `a` approves exactly the repo's state `t`. */
export const approvalMatches = (a: StoredApproval | undefined, t: RepoTree | undefined): boolean =>
  !!a && !!t && a.head === t.head && a.tree === t.tree

/** Approve the repo's uncommitted changes as they are now, or withdraw the
 *  approval. Approving a repo with nothing uncommitted is refused: there is
 *  nothing to approve. `guard` runs first, inside the scope's lock — where a
 *  loop's decision to deliver is taken too (`decideWithApprovals`) — and may
 *  refuse by throwing: a withdrawal is either seen by that decision or refused
 *  after it, never lost between the two. */
export function setApproval(ws: string, task: string, repo: string, approved: boolean, guard?: () => void): Promise<void> {
  return chained(ws, task, async () => {
    guard?.()
    const all = await store.readApprovals(ws, task)
    if (!approved) {
      if (!(repo in all)) return
      delete all[repo]
      await store.writeApprovals(ws, task, all)
      return
    }
    const t = await repoTree(ws, task, repo)
    const headTree = t.head
      ? await changes.revParse(cloneDir(ws, task, repo), await unattendedGitAccessForRepo(ws, repo), `${t.head}^{tree}`)
      : ''
    if (headTree && headTree === t.tree) throw new Error(`${repo} has no uncommitted changes to approve`)
    all[repo] = { head: t.head, tree: t.tree, at: new Date().toISOString() }
    await store.writeApprovals(ws, task, all)
  })
}

/** Compare the recorded approvals with `trees` (repo → its state now; a repo
 *  missing from it is not looked at) and delete every one that no longer
 *  matches. Resolves the repos approved as they are. One scope at a time, so a
 *  prune never deletes an approval `setApproval` wrote after it looked. */
function reconcile(ws: string, task: string, trees: () => Promise<Record<string, RepoTree | undefined>>): Promise<string[]> {
  return chained(ws, task, () => reconcileNow(ws, task, trees))
}

/** {@link reconcile}'s body; the caller holds the scope's lock. */
async function reconcileNow(ws: string, task: string, trees: () => Promise<Record<string, RepoTree | undefined>>): Promise<string[]> {
  const all = await store.readApprovals(ws, task)
  if (!Object.keys(all).length) return []
  const now = await trees()
  const stale = Object.keys(now).filter((r) => all[r] && now[r] && !approvalMatches(all[r], now[r]))
  if (stale.length) {
    for (const r of stale) delete all[r]
    await store.writeApprovals(ws, task, all)
  }
  return Object.keys(now).filter((r) => approvalMatches(all[r], now[r]))
}

/** Read which of `trees` are approved as they are and act on it in one step,
 *  under the scope's lock: no approval or withdrawal lands between the read
 *  and `decide` (a review loop's decision to start delivering). `decide` must
 *  not call back into this module. */
export function decideWithApprovals<T>(
  ws: string,
  task: string,
  trees: Record<string, RepoTree>,
  decide: (approved: string[]) => T | Promise<T>
): Promise<T> {
  return chained(ws, task, async () => decide(await reconcileNow(ws, task, () => Promise.resolve(trees))))
}

/** The repos' states now, for those with an approval on record (a tree hash each). */
const treesOf = (ws: string, task: string, repos: string[]) => async (): Promise<Record<string, RepoTree | undefined>> => {
  const all = await store.readApprovals(ws, task)
  const out: Record<string, RepoTree | undefined> = {}
  for (const r of repos.filter((x) => all[x])) out[r] = await repoTree(ws, task, r).catch(() => undefined)
  return out
}

/** Something that can write these repos ran: their approvals go, whatever the
 *  content is now — an edit undone within the same turn still drops it. */
export function dropApprovals(ws: string, task: string, repos: readonly string[]): Promise<void> {
  if (!repos.length) return Promise.resolve()
  return chained(ws, task, async () => {
    const all = await store.readApprovals(ws, task)
    const gone = repos.filter((r) => r in all)
    if (!gone.length) return
    for (const r of gone) delete all[r]
    await store.writeApprovals(ws, task, all)
  })
}

/** The Changes panel's view, with `approved` on each repo whose approval still
 *  matches its clone (a stale one is deleted). Only repos with an approval on
 *  record cost a tree hash. */
export async function withApprovals(ws: string, task: string, repos: RepoChanges[]): Promise<RepoChanges[]> {
  const approved = await reconcile(ws, task, treesOf(ws, task, repos.map((r) => r.repo)))
  return repos.map((r) => (r.dirty && approved.includes(r.repo) ? { ...r, approved: true as const } : r))
}
