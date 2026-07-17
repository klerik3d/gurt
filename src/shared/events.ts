// Domain event map — the substrate the future inter-agent communication layer
// rides on. Shared so events forwarded to the renderer stay typed there too.
import type { EnvRef, EnvStatus, SessionLogRecord, SessionState } from './types'

export interface DomainEvents {
  /** Tree-shape change: ws/task/repo CRUD, env status, session list/state. */
  'tree.changed': void
  'env.status': { ref: EnvRef; status: EnvStatus }
  /** User or agent activity on an env — postpones idle auto-stop. */
  'env.activity': { ref: EnvRef }
  /** The ACP adapter process of (env, agent) exited — its sessions detached. */
  'env.adapterExited': { ref: EnvRef; agent: string }
  'session.state': { sessionId: string; ref: EnvRef; state: SessionState }
  'session.turn': { sessionId: string; ref: EnvRef; phase: 'started' | 'ended' }
  'session.awaiting': { sessionId: string; ref: EnvRef; awaiting: boolean }
  /** Coarse "snapshot changed" — the UI's re-render trigger. */
  'session.changed': { sessionId: string }
  /** Appended session-log records (timeline deltas), in seq order. */
  'session.log': { sessionId: string; records: SessionLogRecord[] }
  'provision.log': { key: string; line: string }
}
