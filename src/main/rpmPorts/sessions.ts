// `SessionsPort` (t3v2 §4.1) over the session manager: RPM's view of sessions.
// The manager does the work (src/main/sessions/rpm.ts and queue.ts); this
// adapter only maps names, subscribes to the bus and runs the keep-alive pings.
import type { SessionsPort, SettledTurn } from '../../rpm/main'
import type { Bus } from '../bus'
import type { SessionManager } from '../sessions'

export interface SessionsPortDeps {
  /** The bus the manager emits on (`session.settled`, `session.deleted`, `session.copied`). */
  bus: Bus
  /** Stop the session's container; the session stays (kernel: `containers.stop`). */
  stopContainer(sessionId: string): Promise<void>
  /** How often `keepAlive` pings `activity`; one minute by default. */
  keepAliveMs?: number
}

export function createSessionsPort(sessions: SessionManager, deps: SessionsPortDeps): SessionsPort {
  const alive = new Map<string, NodeJS.Timeout>()
  const every = deps.keepAliveMs ?? 60_000
  return {
    info: (id) => sessions.rpmFacts(id),
    list: () => sessions.allSessions().map((s) => s.id),
    userPrompts: (id, afterTurnId) => sessions.userPrompts(id, afterTurnId),
    checkpointBefore: (id, turnId) => sessions.checkpointBefore(id, turnId),
    onSettled: (fn: (t: SettledTurn) => void) => deps.bus.on('session.settled', (e) => fn(e.turn)),
    lastSettled: (id) => sessions.lastSettled(id),
    onDeleted: (fn) =>
      deps.bus.on('session.deleted', ({ sessionId }) => {
        const t = alive.get(sessionId)
        if (t) clearInterval(t)
        alive.delete(sessionId)
        fn(sessionId)
      }),
    onCopied: (fn) => deps.bus.on('session.copied', ({ from, to }) => fn(from, to)),
    send: (id, m) => sessions.rpmSend(id, m),
    sent: (id, key) => sessions.rpmSent(id, key),
    cancelTurn: async (id) => sessions.cancel(id, 'host'),
    createReviewer: (r) => sessions.createReviewer(r),
    stopContainer: (id) => deps.stopContainer(id),
    hold: (executor) => sessions.holdClones(executor),
    release: (executor) => sessions.releaseClones(executor),
    keepAlive(executor, on) {
      const t = alive.get(executor)
      if (!on) {
        if (t) clearInterval(t)
        alive.delete(executor)
        return
      }
      if (t) return
      sessions.activity(executor)
      const timer = setInterval(() => sessions.activity(executor), every)
      timer.unref?.()
      alive.set(executor, timer)
    },
    chatLine: (id, line) => sessions.rpmChatLine(id, line)
  }
}
