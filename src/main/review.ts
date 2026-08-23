/**
 * Manual review state: the per-repo review lock and the inline comments left
 * against a diff. See docs/requirements-manual-review.md.
 *
 * Persisted in `<ws>/<task>/review.json`, but the *locks* are also held in
 * memory: the session scheduler asks "is this clone locked?" synchronously, on
 * every pass, and may not wait on the disk to answer. The set is seeded from
 * disk at boot and is the source of truth from then on — every mutation goes
 * through here, so the two can only disagree if something edits the file behind
 * the app's back (a case the next boot heals).
 */
import { randomUUID } from 'node:crypto'
import type { ReviewComment, ReviewFile, ReviewState } from '../shared/types'
import * as store from './store'
import { createLogger } from './log'

const log = createLogger('review')

const lockKey = (ws: string, task: string, repo: string) => `${ws}/${task}/${repo}`

export interface ReviewManager {
  /** Seed the lock set from disk. Awaited by the kernel's boot restore. */
  load(): Promise<void>
  /** Synchronous, for the scheduler: is this clone held by a manual review? */
  isLocked(ws: string, task: string, repo: string): boolean
  /** Locked repos of a task — what the Changes panel needs, without touching
   *  comments (`state` prunes; a lock read must not). */
  locks(ws: string, task: string): Promise<Record<string, boolean>>
  state(
    ws: string,
    task: string,
    repo: string,
    target: string,
    paths?: string[]
  ): Promise<ReviewState>
  setLock(ws: string, task: string, repo: string, locked: boolean): Promise<void>
  addComment(
    ws: string,
    task: string,
    repo: string,
    target: string,
    c: Pick<ReviewComment, 'path' | 'side' | 'line' | 'text'> & Pick<Partial<ReviewComment>, 'endLine'>
  ): Promise<ReviewComment>
  resolveComment(ws: string, task: string, id: string, resolved: boolean): Promise<void>
  deleteComment(ws: string, task: string, id: string): Promise<void>
  /** Drop a deleted task's locks — its review.json goes with the directory. */
  dropTask(ws: string, task: string): void
  dropWorkspace(ws: string): void
  /** Follow a task rename: review.json moves with the directory, the in-memory
   *  keys do not. */
  renameTask(ws: string, oldTask: string, newTask: string): void
}

export function createReview(): ReviewManager {
  /** `<ws>/<task>/<repo>` of every locked clone. */
  const locked = new Set<string>()
  /** Per-task write chain: review.json is read-modify-written, and two
   *  overlapping mutations would otherwise lose one of them. */
  const chains = new Map<string, Promise<unknown>>()

  /** Run `fn` over the task's review file, serialized against its siblings. */
  function edit<T>(ws: string, task: string, fn: (file: ReviewFile) => T): Promise<T> {
    const key = `${ws}/${task}`
    const next = Promise.resolve(chains.get(key))
      .catch(() => {})
      .then(async () => {
        const file = await store.readReview(ws, task)
        const out = fn(file)
        await store.writeReview(ws, task, file)
        return out
      })
    chains.set(
      key,
      next.catch(() => {})
    )
    return next
  }

  return {
    async load(): Promise<void> {
      locked.clear()
      for (const [ws, task] of await store.tasksWithReview().catch(() => [])) {
        const file = await store.readReview(ws, task)
        for (const repo of Object.keys(file.locked)) locked.add(lockKey(ws, task, repo))
      }
      if (locked.size) log.info('review.locks restored', { count: locked.size })
    },

    isLocked: (ws, task, repo) => locked.has(lockKey(ws, task, repo)),

    async locks(ws, task): Promise<Record<string, boolean>> {
      const file = await store.readReview(ws, task)
      return Object.fromEntries(Object.keys(file.locked).map((repo) => [repo, true]))
    },

    /**
     * Review state of one clone at one target. `paths` — the files that target
     * actually has — prunes comments whose file has left the diff (committed,
     * or the edit reverted): they are dropped from disk, not archived. Only
     * this target's comments are considered, so reading the working tree never
     * prunes a note left on a commit. Omit `paths` to read without pruning.
     */
    async state(ws, task, repo, target, paths): Promise<ReviewState> {
      const alive = paths && new Set(paths)
      const mine = (c: ReviewComment) => c.repo === repo && c.target === target
      const file = await edit(ws, task, (f) => {
        if (alive) f.comments = f.comments.filter((c) => !mine(c) || alive.has(c.path))
        return f
      })
      const at = file.locked[repo]
      return {
        locked: !!at,
        ...(at ? { lockedAt: at } : {}),
        comments: file.comments.filter(mine)
      }
    },

    async setLock(ws, task, repo, want): Promise<void> {
      await edit(ws, task, (f) => {
        if (want) f.locked[repo] = new Date().toISOString()
        else delete f.locked[repo]
      })
      // After the write, so a failed write leaves the scheduler seeing the old
      // state rather than a lock nothing on disk backs.
      if (want) locked.add(lockKey(ws, task, repo))
      else locked.delete(lockKey(ws, task, repo))
    },

    async addComment(ws, task, repo, target, c): Promise<ReviewComment> {
      const comment: ReviewComment = {
        id: randomUUID(),
        repo,
        target,
        path: c.path,
        side: c.side,
        line: c.line,
        ...(c.endLine !== undefined ? { endLine: c.endLine } : {}),
        text: c.text,
        createdAt: new Date().toISOString()
      }
      await edit(ws, task, (f) => f.comments.push(comment))
      return comment
    },

    async resolveComment(ws, task, id, resolved): Promise<void> {
      await edit(ws, task, (f) => {
        const c = f.comments.find((x) => x.id === id)
        // Cleared, not set to false: an unresolved comment carries no flag.
        if (c) c.resolved = resolved || undefined
      })
    },

    async deleteComment(ws, task, id): Promise<void> {
      await edit(ws, task, (f) => {
        f.comments = f.comments.filter((c) => c.id !== id)
      })
    },

    dropTask(ws, task): void {
      chains.delete(`${ws}/${task}`)
      const prefix = `${ws}/${task}/`
      for (const k of [...locked]) if (k.startsWith(prefix)) locked.delete(k)
    },

    dropWorkspace(ws): void {
      for (const k of [...chains.keys()]) if (k.startsWith(`${ws}/`)) chains.delete(k)
      for (const k of [...locked]) if (k.startsWith(`${ws}/`)) locked.delete(k)
    },

    renameTask(ws, oldTask, newTask): void {
      chains.delete(`${ws}/${oldTask}`)
      const prefix = `${ws}/${oldTask}/`
      for (const k of [...locked])
        if (k.startsWith(prefix)) {
          locked.delete(k)
          locked.add(`${ws}/${newTask}/${k.slice(prefix.length)}`)
        }
    }
  }
}

/**
 * The start prompt of a fix session: the open comments, grouped by file in path
 * order, followed by the user's own prose. Built here rather than in the
 * renderer so the wording is one thing, and so the smoke test can assert it
 * without driving the UI.
 */
export function fixPrompt(repo: string, comments: ReviewComment[], prompt: string): string {
  const open = comments.filter((c) => !c.resolved)
  const parts: string[] = []
  if (open.length) {
    const byPath = new Map<string, ReviewComment[]>()
    for (const c of open) byPath.set(c.path, [...(byPath.get(c.path) ?? []), c])
    const blocks = [...byPath.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, cs]) =>
        cs
          .sort((a, b) => a.line - b.line)
          .map((c) => {
            const at = c.endLine && c.endLine > c.line ? `${c.line}-${c.endLine}` : `${c.line}`
            return `${path}:${at}\n${indent(c.text)}`
          })
          .join('\n\n')
      )
    parts.push(`Review comments on ${repo}:\n\n${blocks.join('\n\n')}`)
  }
  if (prompt.trim()) parts.push(prompt.trim())
  return parts.join('\n\n')
}

/** Two spaces per line, so a multi-line note stays visibly one note. */
const indent = (text: string) =>
  text
    .trim()
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n')
