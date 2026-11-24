// TreeId (t3v2 §2): sha256 of the write repos' RepoTree[] sorted by repo.
import { createHash } from 'node:crypto'
import type { RepoTree, TreeId } from '../core'

export function treeId(trees: readonly RepoTree[]): TreeId {
  const sorted = [...trees]
    .sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0))
    .map((t) => ({ repo: t.repo, head: t.head, tree: t.tree }))
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex')
}
