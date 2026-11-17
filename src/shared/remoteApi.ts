// The remote API, as Gurt sees it (docs/requirements-remote-access.md §6.1,
// docs/requirements-remote-protocol.md §7). Declared once in the shared
// protocol package, which the app depends on too, so the two cannot drift;
// this module is where Gurt takes it from, and where the package's copies of
// Gurt's own vocabularies are checked against the originals at compile time.
//
// Not a mirror of `GurtApi`: a `GurtApi` method is reachable from a phone only
// by being added to the package's `RemoteApi`, never by default.
import type { NotificationType as GurtNotificationType } from './notifications'
import type { SessionRole, SessionStatus } from './types'
import type {
  NotificationType,
  RemoteSessionRole,
  RemoteSessionStatus
} from '../../packages/remote-protocol/src/index'

export type * from '../../packages/remote-protocol/src/remoteApi'
export {
  REMOTE_API_VERSION,
  REMOTE_API_MIN,
  REMOTE_API_METHODS,
  REMOTE_CHANNEL_METHODS,
  REMOTE_EVENTS,
  apiCompatibility
} from '../../packages/remote-protocol/src/remoteApi'
export { RPC_ERROR, MAX_IN_FLIGHT } from '../../packages/remote-protocol/src/rpc'
export type { RpcErrorCode } from '../../packages/remote-protocol/src/rpc'

/** Same members both ways, or `never`. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

// The protocol package spells out vocabularies it shares with Gurt instead of
// importing them (it is published on its own). A change to either side that
// is not made to both is a compile error here.
const _notificationTypes: Same<NotificationType, GurtNotificationType> = true
const _statuses: Same<RemoteSessionStatus, SessionStatus> = true
const _roles: Same<RemoteSessionRole, SessionRole> = true
void _notificationTypes
void _statuses
void _roles
