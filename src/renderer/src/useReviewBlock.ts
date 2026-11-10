import { useEffect, useState } from 'react'
import type { AgentConfig, RepoConfig, SessionInfo, ShipRung, Tree } from '../../shared/types'
import { repoMode, sessionRole } from '../../shared/types'
import { ladderOfRepos, validateReviewBlock } from '../../shared/reviewBlock'
import { useAgents } from './useAgents'
import { logErr } from './log'

/** What an executor draft's Review block needs to be judged
 *  (docs/requirements-review-loop.md §3): the repos it would ship, the ladder
 *  they offer, and whether it may start. One hook for the Config tab (which
 *  draws the block) and the session pane (which disables Run), so the two can
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
  /** Why the block may not start; `null` when it may, or when there is no block. */
  problem: string | null
}

export function useReviewBlock(tree: Tree | null, info: SessionInfo): ReviewBlockView {
  const agents = useAgents()
  const [configs, setConfigs] = useState<Record<string, AgentConfig | null>>({})
  const review = info.review
  const wsData = tree?.workspaces.find((w) => w.name === info.workspace)
  const allRepos = wsData?.repos ?? []
  const writeRepos = info.repos.filter((r) => repoMode(info, r) === 'write')
  const writeConfigs = writeRepos.flatMap((n) => allRepos.find((r) => r.name === n) ?? [])

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

  const ladder = ladderOfRepos(writeRepos, allRepos)
  const loaded = wanted.every((id) => id in configs)
  const problem = !review
    ? null
    : !loaded
      ? 'checking the reviewer…'
      : validateReviewBlock(
          review,
          { role: sessionRole(info), agent: info.agent, configValues: info.configValues },
          { agents, deniedAgents: wsData?.deniedAgents ?? [], configs },
          ladder
        )
  return {
    writeRepos,
    writeConfigs,
    ladder,
    checkless: writeRepos.filter((n) => !allRepos.find((r) => r.name === n)?.check),
    reviewerConfig: review?.agent ? configs[review.agent] : undefined,
    problem
  }
}
