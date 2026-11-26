import { taskKey } from '../../shared/keys'
import type {
  EnvRef,
  PersistedSession,
  SessionContainer
} from '../../shared/types'
import type { Bus } from '../bus'
import { createLogger } from '../log'
import type { PiiMask } from '../pii'
import { stopPiiRewrite } from '../piiRewrite'
import type { Session, SessionEvents } from './types'

const log = createLogger('sessions')

// Ending and renaming sessions and tasks: deleting one (its container, clone
// claims, log and checkpoints), dropping a task's or a workspace's, retiring one
// to the archive.

/** What lifecycle.ts needs of the session manager: its state and the manager's own
 *  operations it calls back into. */
export interface LifecycleCtx {
  assertSessionWritable(id: string): void
  readonly bus: Bus
  clearCheckpoints(s: Session): Promise<void>
  detach(sessionId: string): void
  readonly events: SessionEvents
  readonly mask: PiiMask
  readonly persistTimers: Map<string, NodeJS.Timeout>
  recordsFor(ws: string, task: string): PersistedSession[]
  schedule(): void
  schedulePersist(ref: EnvRef): void
  readonly sessions: Map<string, Session>
}

/**
 * Delete a session in any state — including one that is running or still
 * starting, which is the whole point: a session configured wrong is usually
 * noticed after it has begun. Everything the session owns goes with it (its
 * container, its adapter, its host servers, its chat log, its mount scratch,
 * an executor's RPM reviewer sessions);
 * the clone and the uncommitted work in it deliberately stay, since a clone
 * outlives every session of its task.
 */
export function deleteSession(mgr: LifecycleCtx, sessionId: string): void {
  mgr.assertSessionWritable(sessionId)
  const s = mgr.sessions.get(sessionId)
  if (!s) return
  for (const resolve of s.pendingPermissions.values())
    resolve({ outcome: { outcome: 'cancelled' } })
  // The container is bound to this session — take it down with the session.
  // Before the record goes: the container manager finds the container through
  // this map, so a session dropped first would leave its container orphaned
  // until the next boot reconcile.
  const { workspace, task } = s.ref
  void mgr.events
    .releaseContainer(sessionId, 'session-deleted')
    // Only once the container is gone: its bind mounts are staged inside that
    // directory, so removing it any earlier races the daemon.
    .then(() => mgr.events.deleteScratch(workspace, task, sessionId))
  void mgr.clearCheckpoints(s).catch((err: unknown) => log.warn('checkpoint.cleanup.failed', { err }))
  mgr.sessions.delete(sessionId)
  // Its correspondence table goes with it — the tokens it produced end here.
  mgr.mask.drop(sessionId)
  stopPiiRewrite(sessionId)
  mgr.events.deleteLog(s.ref.workspace, s.ref.task, sessionId)
  mgr.events.stopGurtServer(sessionId)
  mgr.bus.emit('session.deleted', { sessionId })
  mgr.schedulePersist(s.ref)
  mgr.bus.emit('tree.changed', undefined)
  // An executor's RPM reviewers (`reviewerOf`) exist only for its loop — they
  // go with it. After the executor, never before: its `session.deleted` lets
  // RPM forget the loop first, so a reviewer's own deletion finds no live run
  // to fail a step of (and to start a fresh review for).
  for (const [id, r] of mgr.sessions) if (r.info.reviewerOf?.executor === sessionId) deleteSession(mgr, id)
  // Its clone may now be free — let the next queued session take it.
  mgr.schedule()
}

/** Drop every checkpoint of the session (delete and archive retirement). */
export async function clearCheckpoints(mgr: LifecycleCtx, s: Session): Promise<void> {
  await mgr.events.clearCheckpoints?.(s.info)
}

/** Forget sessions of a whole task without persisting (task dir is removed).
 *  A pending debounced persist for the task is cancelled first: the container
 *  teardown that precedes this schedules one (a session's container record is
 *  cleared), and left alone it fires after the directory is gone — silently
 *  resurrecting the deleted task with an empty sessions.json. */
export function dropTaskSessions(mgr: LifecycleCtx, ws: string, task: string): void {
  const key = taskKey(ws, task)
  clearTimeout(mgr.persistTimers.get(key))
  mgr.persistTimers.delete(key)
  for (const [id, s] of mgr.sessions) {
    if (s.ref.workspace !== ws || s.ref.task !== task) continue
    mgr.detach(id)
    mgr.events.stopGurtServer(id)
    mgr.mask.drop(id)
    stopPiiRewrite(id)
    mgr.sessions.delete(id)
    mgr.bus.emit('session.deleted', { sessionId: id })
  }
  mgr.bus.emit('tree.changed', undefined)
}

/** Same as {@link dropTaskSessions}, scaled up to every task in the
 *  workspace — the whole workspace directory is about to go. */
export function dropWorkspaceSessions(mgr: LifecycleCtx, ws: string): void {
  const prefix = `${ws}/`
  for (const [key, timer] of mgr.persistTimers) {
    if (!key.startsWith(prefix)) continue
    clearTimeout(timer)
    mgr.persistTimers.delete(key)
  }
  for (const [id, s] of mgr.sessions) {
    if (s.ref.workspace !== ws) continue
    mgr.detach(id)
    mgr.events.stopGurtServer(id)
    mgr.mask.drop(id)
    stopPiiRewrite(id)
    mgr.sessions.delete(id)
    mgr.bus.emit('session.deleted', { sessionId: id })
  }
  mgr.bus.emit('tree.changed', undefined)
}

/** Archive retirement preserves the log/history until the archive is verified. */
export async function dropArchivedSession(mgr: LifecycleCtx, id: string): Promise<void> {
  const s = mgr.sessions.get(id)
  if (!s) return
  await mgr.clearCheckpoints(s)
  mgr.detach(id)
  mgr.events.stopGurtServer(id)
  mgr.mask.drop(id)
  stopPiiRewrite(id)
  mgr.sessions.delete(id)
  mgr.schedulePersist(s.ref)
  mgr.bus.emit('session.deleted', { sessionId: id })
  mgr.bus.emit('tree.changed', undefined)
}

/**
 * Point every live session of the task at its new name and persist under it —
 * the caller has already moved the task's directory (with its `sessions.json`
 * and logs) there on disk. Any pending debounced persist under the old name is
 * dropped first: left alone it would fire 300ms later, find no sessions under
 * the old key, and write an empty `sessions.json` into a directory that is
 * gone. Surviving adapters are killed rather than re-pointed — each was
 * spawned against the old workspace path and cannot follow the move; sessions
 * re-attach on their next prompt.
 */
export function renameTask(mgr: LifecycleCtx, ws: string, oldTask: string, newTask: string): void {
  clearTimeout(mgr.persistTimers.get(taskKey(ws, oldTask)))
  mgr.persistTimers.delete(taskKey(ws, oldTask))
  for (const s of mgr.sessions.values())
    if (s.ref.workspace === ws && s.ref.task === oldTask) mgr.detach(s.info.id)
  for (const s of mgr.sessions.values()) {
    if (s.ref.workspace !== ws || s.ref.task !== oldTask) continue
    s.ref = { ...s.ref, task: newTask }
    s.info.task = newTask
    s.info.lastActivityAt = new Date().toISOString()
    s.attached = false
  }
  void Promise.resolve(mgr.events.persist(ws, newTask, mgr.recordsFor(ws, newTask)))
    .catch((err: unknown) => log.error('session.persist.fail', { err }))
  mgr.bus.emit('tree.changed', undefined)
}

/** Rename a session's display title (sidebar/pane header) — cosmetic only. */
export function renameSession(mgr: LifecycleCtx, sessionId: string, title: string): void {
  mgr.assertSessionWritable(sessionId)
  const s = mgr.sessions.get(sessionId)
  const trimmed = title.trim()
  if (!s || !trimmed || trimmed === s.info.title) return
  s.info.title = trimmed
  s.info.lastActivityAt = new Date().toISOString()
  mgr.bus.emit('tree.changed', undefined)
  mgr.bus.emit('session.changed', { sessionId })
  mgr.schedulePersist(s.ref)
}

/**
 * Write the session's container record. The container manager owns the
 * contents; the session owns the storage, since the container is a field of
 * the session and is persisted and deleted with it.
 */
export function patchContainer(mgr: LifecycleCtx, sessionId: string, container: SessionContainer | undefined): void {
  const s = mgr.sessions.get(sessionId)
  if (!s) return
  if (container) s.info.container = container
  else delete s.info.container
  mgr.bus.emit('session.changed', { sessionId })
  mgr.schedulePersist(s.ref)
}
