// The review loop's "diff hash" (docs/requirements-review-loop.md, Terms; §6):
// a fingerprint of the write repos' working trees, host-side git only. Per
// repo: HEAD plus the tree id `git write-tree` gives after `read-tree HEAD` and
// `add -A` into a TEMPORARY index (`GIT_INDEX_FILE`) — the same content a
// `commit` (`add -A`, then commit) would record, so tracked files matching
// `.gitignore` count and untracked ignored ones do not, and the real index —
// which the agent in the container shares through the bind — is never touched.
//
// The string is parseable on purpose (a sorted JSON list of [repo, HEAD, tree]):
// delivery's recovery probe compares one repo's tree with the reviewed one
// (§8, `deliver` commit), and loopStep only ever compares whole strings.
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cloneDir } from './store'
import { hostGitAccessForRepo } from './git/env'
import { git, serialized } from './changes'

export interface RepoTree {
  /** HEAD's commit, '' for an unborn branch. */
  head: string
  /** The tree id of the working tree as a commit would record it. */
  tree: string
}

/** One repo's {@link RepoTree}. Joins the clone's chain (`serialized`) so it
 *  never interleaves with a commit's `add -A` or a fetch on the same clone. */
export async function repoTree(ws: string, task: string, repo: string): Promise<RepoTree> {
  const dir = cloneDir(ws, task, repo)
  const base = await hostGitAccessForRepo(ws, repo)
  return serialized(dir, async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'gurt-index-'))
    try {
      // Same access (config args, env) as every host git call, plus the
      // throwaway index; an absolute path, since git resolves it from the cwd.
      const access = { ...base, env: { ...base.env, GIT_INDEX_FILE: path.join(scratch, 'index') } }
      const head = (await git(dir, base, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { okCodes: [0, 1] })).trim()
      await git(dir, access, head ? ['read-tree', head] : ['read-tree', '--empty'])
      await git(dir, access, ['add', '-A'])
      return { head, tree: (await git(dir, access, ['write-tree'])).trim() }
    } finally {
      await fs.rm(scratch, { recursive: true, force: true })
    }
  })
}

/** The diff hash of `writeRepos` in the task's clones: one stable string, equal
 *  across calls while no repo's HEAD or content changes. Order-independent. */
export async function diffHash(ws: string, task: string, writeRepos: readonly string[]): Promise<string> {
  const names = [...new Set(writeRepos)].sort()
  const trees = await Promise.all(names.map((r) => repoTree(ws, task, r)))
  return JSON.stringify(names.map((r, i) => [r, trees[i]!.head, trees[i]!.tree]))
}

/** Back to per-repo values; undefined for a string this module did not make. */
export function parseDiffHash(hash: string): Record<string, RepoTree> | undefined {
  try {
    const rows: unknown = JSON.parse(hash)
    if (!Array.isArray(rows)) return undefined
    const out: Record<string, RepoTree> = {}
    for (const row of rows as unknown[]) {
      if (!Array.isArray(row) || row.length !== 3 || row.some((v) => typeof v !== 'string')) return undefined
      const [repo, head, tree] = row as [string, string, string]
      out[repo] = { head, tree }
    }
    return out
  } catch {
    return undefined
  }
}
