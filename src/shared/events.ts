// Domain event map — the substrate the future inter-agent communication layer
// rides on. Shared so events forwarded to the renderer stay typed there too.
import type {
  ContainerStatus,
  EnvRef,
  SessionLogRecord,
  SessionState,
  StoredProposal
} from './types'

/** Why a container reached its new status — the "who asked for this" a status
 *  alone cannot answer. `user` covers both a user action and the scheduler
 *  acting on one (a start, a manual stop); `idle` is the auto-stop policy. */
export type ContainerStatusReason =
  | 'idle'
  | 'user'
  | 'task-deleted'
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
  /** The session's ACP adapter process exited — the session is detached. */
  'session.adapterExited': { sessionId: string }
  /** `reason` names the trigger (`'user'`, `'scheduler'`, `'start-failed'`, …);
   *  `err` rides along when that trigger was a failure. */
  'session.state': {
    sessionId: string
    ref: EnvRef
    state: SessionState
    reason?: SessionStateReason
    err?: EventError
  }
  'session.turn': { sessionId: string; ref: EnvRef; phase: 'started' | 'ended' }
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
}
