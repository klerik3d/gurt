import { taskKey } from '../../shared/keys'
import {
  applyLog,
  type EnvRef,
  type InterruptedSession,
  type PersistedSession
} from '../../shared/types'
import { createLogger } from '../log'
import { LIMIT_CONTINUE_PROMPT, turnSeqOf } from './pure'
import type { RestoredSession, Session, SessionEvents } from './types'

const log = createLogger('sessions')

// Persistence and recovery: what is written to `sessions.json` and the JSONL
// logs, when, and how a restart reads it back (docs/requirements-session-
// recovery.md).

/** What persistence.ts needs of the session manager: its state and the manager's own
 *  operations it calls back into. */
export interface PersistenceCtx {
  drainPending(s: Session): Promise<void>
  readonly events: SessionEvents
  flushLog(s: Session): void
  flushSessions(sessions: Session[]): Promise<void>
  pendingSeq: number
  persistNow(s: Session): Promise<void>
  readonly persistTimers: Map<string, NodeJS.Timeout>
  recordsFor(ws: string, task: string): PersistedSession[]
  readonly sessions: Map<string, Session>
  sessionsFor(ws: string, task: string): Session[]
  watcherPaused(s: Session): boolean
}

/** Load sessions persisted by a previous run; they reattach lazily on prompt. */
export function restore(mgr: PersistenceCtx, records: RestoredSession[]): void {
  for (const r of records) {
    if (mgr.sessions.has(r.info.id)) continue
    // A proactive run from a previous app life is over: its tools are closed
    // (only the agent's run in progress may use them), so there is nothing to
    // resume or continue — the agent's next run picks up from its cursor
    // (docs/design-proactive-agents.md §3.2).
    if (r.info.role === 'proactive') {
      r.interrupted = false
      r.pending = []
      r.info.limitedUntil = undefined
    }
    const entries = applyLog([], r.log)
    if (!r.info.lastActivityAt) {
      const at = entries.reduce((n, e) => Math.max(n, e.endAt ?? e.at ?? 0), 0)
      if (at) r.info.lastActivityAt = new Date(at).toISOString()
    }
    if (!r.info.lastContentAt) {
      const at = entries.reduce((n, e) => Math.max(n, e.endAt ?? e.at ?? 0), 0)
      if (at) r.info.lastContentAt = new Date(at).toISOString()
    }
    const lastSeq = r.log[r.log.length - 1]?.seq ?? 0
    mgr.sessions.set(r.info.id, {
      info: r.info,
      ref: { workspace: r.info.workspace, task: r.info.task, env: r.info.env },
      acpSessionId: r.acpSessionId,
      preface: r.preface,
      proposal: r.proposal,
      records: r.log,
      lastSeq,
      flushedSeq: lastSeq,
      flushInFlight: false,
      entries,
      nextEntryId: Math.max(0, ...entries.map((e) => e.id)) + 1,
      busy: false,
      pending: (r.pending ?? []).map((p) => ({ ...p, id: `p${++mgr.pendingSeq}` })),
      interrupted: r.interrupted,
      recovering: !!r.interrupted,
      draining: false,
      turnComplete: false,
      turns: 0,
      ranOrigin: r.ranOrigin,
      lastSettled: r.lastSettled,
      turnSeq: Math.max(r.turnSeq ?? 0, turnSeqOf(r.lastSettled?.turnId)),
      carry: r.carry,
      attached: false,
      loading: false,
      pendingPermissions: new Map(),
      turnRejected: false,
      limitStrikes: 0
    })
    // Legacy records did not persist queued automatic continuations.
    const restored = mgr.sessions.get(r.info.id)!
    if (r.info.state === 'started' && r.info.limitedUntil && !restored.pending.length) {
      restored.pending.push({ id: `p${++mgr.pendingSeq}`, queuedAt: r.info.lastActivityAt ?? '', text: LIMIT_CONTINUE_PROMPT, auto: true, ...(r.carry ? { continues: true as const } : {}), ...(r.info.role === 'watcher' ? { origin: { limit: true as const, of: r.ranOrigin === 'wake' ? 'wake' as const : 'user' as const } } : {}) })
    }
  }
}

/** Live sessions of the task, projected to their persisted shape. */
export function recordsFor(mgr: PersistenceCtx, ws: string, task: string): PersistedSession[] {
  return mgr.sessionsFor(ws, task).map((s) => {
    const info = { ...s.info }
    // `starting` is runtime-only; persist it as draft (crash-safe).
    if (info.state === 'starting') {
      info.state = 'draft'
      info.queuedAt = undefined
    }
    // `incomplete` is a runtime overlay — never persisted.
    delete info.incomplete
    return {
      info,
      acpSessionId: s.acpSessionId,
      preface: s.preface,
      proposal: s.proposal,
      ...(s.ranOrigin ? { ranOrigin: s.ranOrigin } : {}),
      ...(s.lastSettled ? { lastSettled: structuredClone(s.lastSettled) } : {}),
      ...(s.turnSeq ? { turnSeq: s.turnSeq } : {}),
      ...(s.carry ? { carry: structuredClone(s.carry) } : {}),
      interrupted: s.interrupted,
      pending: structuredClone(s.pending)
    }
  })
}

export function sessionsFor(mgr: PersistenceCtx, ws: string, task: string): Session[] {
  const key = taskKey(ws, task)
  return [...mgr.sessions.values()].filter((s) => taskKey(s.ref.workspace, s.ref.task) === key)
}

export async function persistNow(mgr: PersistenceCtx, s: Session): Promise<void> {
  await mgr.events.persist(s.ref.workspace, s.ref.task, mgr.recordsFor(s.ref.workspace, s.ref.task))
}

/** Wait for buffered state and history before an intentional update restart. */
export async function flushForRestart(mgr: PersistenceCtx): Promise<void> {
  await mgr.flushSessions([...mgr.sessions.values()])
}

export async function flushTask(mgr: PersistenceCtx, ws: string, task: string): Promise<void> {
  const key = taskKey(ws, task)
  clearTimeout(mgr.persistTimers.get(key))
  mgr.persistTimers.delete(key)
  await mgr.flushSessions(mgr.sessionsFor(ws, task))
}

export async function flushSessions(mgr: PersistenceCtx, sessions: Session[]): Promise<void> {
  for (const s of sessions) {
    await mgr.persistNow(s)
    while (s.flushInFlight) await new Promise((resolve) => setTimeout(resolve, 10))
    mgr.flushLog(s)
    while (s.flushInFlight) await new Promise((resolve) => setTimeout(resolve, 10))
    if (s.flushedSeq < s.lastSeq) throw new Error('Could not save session history before restart')
  }
}

/** Append the unflushed log tail; `flushedSeq` advances only once the write is
 *  confirmed, so a failed append is retried by the next flush instead of being
 *  silently dropped. One flush per session at a time keeps the tail ordered. */
export function flushLog(mgr: PersistenceCtx, s: Session): void {
  if (s.flushInFlight || s.lastSeq <= s.flushedSeq) return
  const upTo = s.lastSeq
  const tail = s.records.filter((r) => r.seq > s.flushedSeq)
  s.flushInFlight = true
  void mgr.events
    .appendLog(s.ref.workspace, s.ref.task, s.info.id, tail)
    .then(
      () => {
        s.flushedSeq = upTo
      },
      (e: unknown) =>
        log.error('internal.fail', { site: 'session-log-append', s: s.info.id, err: e })
    )
    .then(() => {
      s.flushInFlight = false
      // Records that landed mid-flight (or joined a failed batch) flush now; a
      // failed batch alone waits for the next persist tick. Never resurrect a
      // deleted session's file.
      if (mgr.sessions.get(s.info.id) === s && s.lastSeq > upTo) mgr.flushLog(s)
    })
}

export function schedulePersist(mgr: PersistenceCtx, ref: EnvRef): void {
  const key = taskKey(ref.workspace, ref.task)
  clearTimeout(mgr.persistTimers.get(key))
  mgr.persistTimers.set(
    key,
    setTimeout(() => {
      void Promise.resolve(mgr.events.persist(ref.workspace, ref.task, mgr.recordsFor(ref.workspace, ref.task)))
        .catch((err: unknown) => log.error('session.persist.fail', { err }))
      // Flush each session's unflushed log tail (the JSONL is append-only).
      for (const s of mgr.sessionsFor(ref.workspace, ref.task)) mgr.flushLog(s)
    }, 300)
  )
}

export async function resumeInterrupted(mgr: PersistenceCtx, id: string): Promise<void> {
  const s = mgr.sessions.get(id)
  if (!s?.recovering || s.recoveryStarting || s.info.state !== 'started') return
  s.recoveryStarting = true
  const previous = [...s.pending]
  const wasInterrupted = s.interrupted
  // The manager's own resume of an approved wake turn stays that (§10); a
  // person's Resume in the checklist makes it attended work.
  const keepsWake = s.resumeOnBoot && s.info.role === 'watcher' && s.ranOrigin === 'wake' && !mgr.watcherPaused(s)
  s.resumeOnBoot = undefined
  try {
    if (s.interrupted) {
      s.pending.unshift({
        id: `p${++mgr.pendingSeq}`,
        auto: true,
        ...(keepsWake ? { origin: { limit: true as const, of: 'wake' as const } } : {}),
        queuedAt: s.pending[0]?.queuedAt ?? new Date().toISOString(),
        text: 'The application restarted during your previous turn. Resume the unfinished task using the existing conversation. First inspect the current state: actions may already have completed. Do not repeat completed actions. Request any necessary permissions again.'
      })
    }
    s.interrupted = false
    await mgr.persistNow(s)
    s.recovering = false
    void mgr.drainPending(s)
  } catch (err) {
    s.pending = previous
    s.interrupted = wasInterrupted
    throw err
  } finally {
    s.recoveryStarting = false
  }
}

export function interruptedSessions(mgr: PersistenceCtx): InterruptedSession[] {
  return [...mgr.sessions.values()].filter((s) => s.recovering && s.info.state === 'started' && !s.resumeOnBoot)
    .map(({ info }) => ({ id: info.id, title: info.title, workspace: info.workspace, task: info.task }))
}

export function hasUnfinishedWork(mgr: PersistenceCtx): boolean {
  return [...mgr.sessions.values()].some((s) => (s.busy || s.draining || s.loading || s.promptRunning ||
    s.pendingPermissions.size > 0 || s.pending.length > 0 || s.recovering ||
    s.info.state === 'starting' || s.info.state === 'queued' || !!s.info.limitedUntil))
}
