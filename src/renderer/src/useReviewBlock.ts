import { useEffect, useMemo, useState } from 'react'
import type { AgentConfig, RepoConfig, ReviewLoopConfig, SessionInfo, ShipRung, Tree } from '../../shared/types'
import { repoMode, sessionRole } from '../../shared/types'
import type { CredentialEntry } from '../../shared/credentials'
import type { SeededReview } from '../../shared/reviewBlock'
import {
  defaultReviewer,
  ladderOfRepos,
  reviewSeedDue,
  reviewerCandidates,
  seedReviewBlock,
  validateReviewBlock
} from '../../shared/reviewBlock'
import { useAgents } from './useAgents'
import { logErr } from './log'

/** What an executor draft's Review block needs to be judged
 *  (docs/requirements-review-loop.md §3): the repos it would ship, the ladder
 *  they offer, and whether it may start. One hook for the Config tab (which
 *  draws the block) and the session pane (which disables Run and, with
 *  `autoSeed`, prefills the block whichever tab is showing), so the two can
 *  not disagree — and main runs the same `validateReviewBlock` when the start
 *  is asked for. */
export interface ReviewBlockView {
  /** The draft's write repos — the ones delivery touches; the first is the anchor. */
  writeRepos: string[]
  /** Their `RepoConfig`s, in the same order. */
  writeConfigs: RepoConfig[]
  ladder: ShipRung[]
  /** Write repos with no `check` command: the loop skips the check for them. */
  checkless: string[]
  /** The reviewer's cached/seed config surface (`getAgentConfig`), once read. */
  reviewerConfig: AgentConfig | null | undefined
  /** The agents the reviewer picker offers (workspace denials applied). */
  candidates: string[]
  /** A new block from the anchor's defaults — what the "on" chip writes. */
  seed(): ReviewLoopConfig
  /** Why the block may not start; `null` when it may, or when there is no block.
   *  Includes a prefill that is still owed (or failed): Run must not start a
   *  draft whose repository defaults say "review" before the block is in it. */
  problem: string | null
}

/** What the renderer last prefilled, per draft — outside React state so it
 *  survives the pane remounting (like SessionPane's pasted images). A restart
 *  forgets it, which only means a block is then never swapped on its own. */
const seeded = new Map<string, SeededReview>()

export function useReviewBlock(tree: Tree | null, info: SessionInfo, autoSeed = false): ReviewBlockView {
  const agents = useAgents()
  const [configs, setConfigs] = useState<Record<string, AgentConfig | null>>({})
  // Credentials decide the default reviewer (a usable sign-in or key, §3).
  const [credentials, setCredentials] = useState<CredentialEntry[] | null>(null)
  const [seedFailure, setSeedFailure] = useState<{ id: string; message: string } | undefined>(undefined)
  const review = info.review
  const wsData = tree?.workspaces.find((w) => w.name === info.workspace)
  const allRepos = wsData?.repos ?? []
  const deniedAgents = wsData?.deniedAgents
  const writeRepos = info.repos.filter((r) => repoMode(info, r) === 'write')
  const writeConfigs = writeRepos.flatMap((n) => allRepos.find((r) => r.name === n) ?? [])
  const candidates = useMemo(() => reviewerCandidates(agents, deniedAgents ?? []), [agents, deniedAgents])
  const executorDraft = info.state === 'draft' && sessionRole(info) === 'executor'
  const anchor = writeConfigs[0]

  // Both agents' config surfaces: the model is what tells an executor and a
  // reviewer on one instance apart.
  const wanted = review ? [info.agent, review.agent].filter((a): a is string => !!a) : []
  const key = [...new Set(wanted)].join('\u0000')
  useEffect(() => {
    let live = true
    for (const id of key ? key.split('\u0000') : [])
      window.gurt
        .getAgentConfig(id)
        .then((c) => live && setConfigs((prev) => ({ ...prev, [id]: c })))
        .catch((e: unknown) => {
          logErr('getAgentConfig')(e)
          if (live) setConfigs((prev) => ({ ...prev, [id]: null }))
        })
    return () => {
      live = false
    }
  }, [key])

  useEffect(() => {
    if (!executorDraft) return
    let live = true
    window.gurt
      .getCredentials()
      .then((f) => live && setCredentials(f.credentials))
      .catch(() => live && setCredentials([]))
    return () => {
      live = false
    }
  }, [executorDraft])

  const ladder = ladderOfRepos(writeRepos, allRepos)
  const seed = (): ReviewLoopConfig =>
    seedReviewBlock(
      anchor?.review,
      defaultReviewer({ executorAgent: info.agent, agents, deniedAgents: deniedAgents ?? [], credentials: credentials ?? [] }),
      ladder
    )

  // The prefill (§3) is the draft's, not the Config tab's: a draft that already
  // has its agent, env and repos can reach Run from the Chat tab, so it is
  // written here, once what the default depends on is known — the executor's
  // own agent, the credentials and an anchor.
  const due = reviewSeedDue({
    executor: executorDraft,
    review,
    reviewOff: !!info.reviewOff,
    anchor,
    seeded: seeded.get(info.id)
  })
  useEffect(() => {
    if (!autoSeed || !due || !info.agent || !credentials || !anchor) return
    const block = seed()
    const before = seeded.get(info.id)
    seeded.set(info.id, { anchor: anchor.name, block })
    setSeedFailure(undefined)
    window.gurt.sessionEditDraft(info.id, { review: block }).catch((e: unknown) => {
      // Still owed: put the memory back so Run keeps waiting and says why.
      if (before) seeded.set(info.id, before)
      else seeded.delete(info.id)
      setSeedFailure({ id: info.id, message: e instanceof Error ? e.message : String(e) })
    })
    // `seed` is a fresh closure every render; what it reads is listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSeed, due, info.id, info.agent, credentials, anchor?.name, Object.keys(agents).join('\u0000')])

  const loaded = wanted.every((id) => id in configs)
  const problem = due
    ? seedFailure?.id === info.id
      ? `the repository’s review defaults could not be applied (${seedFailure.message}) — set the loop on the Config tab`
      : 'applying the repository’s review defaults…'
    : !review
      ? null
      : !loaded
        ? 'checking the reviewer…'
        : validateReviewBlock(
            review,
            { role: sessionRole(info), agent: info.agent, configValues: info.configValues },
            { agents, deniedAgents: deniedAgents ?? [], configs },
            ladder
          )
  return {
    writeRepos,
    writeConfigs,
    ladder,
    checkless: writeRepos.filter((n) => !allRepos.find((r) => r.name === n)?.check),
    reviewerConfig: review?.agent ? configs[review.agent] : undefined,
    candidates,
    seed,
    problem
  }
}
