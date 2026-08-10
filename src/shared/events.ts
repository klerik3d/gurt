// Domain event map — the substrate the future inter-agent communication layer
// rides on. Shared so events forwarded to the renderer stay typed there too.
import type {
  ContainerStatus,
  EnvRef,
  SessionLogRecord,
  SessionState,
  StoredProposal
} from './types'
import type { NotificationRecord } from './notifications'

/** Why a container reached its new status — the "who asked for this" a status
 *  alone cannot answer. `user` covers both a user action and the scheduler
 *  acting on one (a start, a manual stop); `idle` is the auto-stop policy;
 *  `queue` is that policy cut short because a queued session needs this
 *  container's clone. */
export type ContainerStatusReason =
  | 'idle'
  | 'queue'
  | 'user'
  | 'task-deleted'
  | 'workspace-deleted'
  | 'session-deleted'
  | 'error'
  | 'reconcile'

/** Why a session reached its new state. `user` covers both a user action and
 *  the scheduler acting on one; `start-failed` rides with `err`. */
export type SessionStateReason = 'created' | 'user' | 'scheduler' | 'start-failed'

/** `{name, message, code}` of the failure behind a state change. */
export interface EventError {
  name: string
  message: string
  code?: string | number
}

export interface DomainEvents {
  /** Tree-shape change: ws/task/repo CRUD, container status, session list/state. */
  'tree.changed': void
  /** The session's own container changed state. */
  'container.status': {
    sessionId: string
    ref: EnvRef
    status: ContainerStatus
    reason: ContainerStatusReason
  }
  /** User or agent activity on a session — postpones its container's auto-stop. */
  'session.activity': { sessionId: string }
  /** The session's ACP adapter process exited — the session is detached.
   *  `expected` is true when a host-side call (`detach`) killed it — a
   *  container teardown, an env switch, a delete; false/absent means the
   *  process went away on its own (crash). `wasLive` is true when the
   *  session was busy or awaiting a permission at the moment the adapter
   *  died — an idle session's container going down out-of-band (a manual
   *  `docker stop`, a Docker Desktop restart) is neither. The notifications
   *  subscriber fires `error` only when both hold: unexpected AND live. */
  'session.adapterExited': { sessionId: string; expected?: boolean; wasLive?: boolean }
  /** `reason` names the trigger (`'user'`, `'scheduler'`, `'start-failed'`, …);
   *  `err` rides along when that trigger was a failure. */
  'session.state': {
    sessionId: string
    ref: EnvRef
    state: SessionState
    reason?: SessionStateReason
    err?: EventError
  }
  /** `final` rides with `phase: 'ended'` only: false for the internal nudge
   *  turn's own boundary (the turn-contract healing prompt in
   *  `SessionManager.runPrompt`), true for the turn a user actually sees end.
   *  Consumers that want "the turn is over" per bus-event cadence (the idle
   *  auto-stop policy) can ignore it; consumers that want "the turn the user
   *  started is over" (the notifications subscriber's `turn-ended`) must not. */
  'session.turn': { sessionId: string; ref: EnvRef; phase: 'started' | 'ended'; final?: boolean }
  'session.awaiting': { sessionId: string; ref: EnvRef; awaiting: boolean }
  /** Coarse "snapshot changed" — the UI's re-render trigger. */
  'session.changed': { sessionId: string }
  /** Appended session-log records (timeline deltas), in seq order. */
  'session.log': { sessionId: string; records: SessionLogRecord[] }
  /** A `complete` call with outcome=changes stored a proposal — the seam the
   *  committer stage will consume. */
  'session.proposal': { sessionId: string; ref: EnvRef; proposal: StoredProposal }
  /** Provisioning output of one session's container; `key` is the session id. */
  'provision.log': { key: string; line: string }
  /** A bus event resolved into a user-facing notification (see
   *  docs/requirements-notifications.md) — fired only when that type's
   *  in-app pref is on. */
  'notification.created': NotificationRecord
  /** A session's pending notifications were marked read server-side by
   *  something other than a panel click (opening the session another way, or
   *  its `awaiting` clearing) — the renderer mirrors this so the bell badge
   *  doesn't go stale for a session that was already open when it happened. */
  'notification.read': { sessionId: string }
  /** A session record is gone for good (deleted, or its task deleted) — the
   *  notifications subscriber drops its ring entries and per-session
   *  bookkeeping so both don't grow for the process lifetime. */
  'session.deleted': { sessionId: string }
}
