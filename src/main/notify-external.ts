// External delivery (docs/requirements-notifications.md §5). The one
// implementation is the phone push of remote access
// (docs/requirements-remote-access.md §8): while remote access is on, it
// installs a sink here and every external notification becomes a `PUSH` on the
// host socket — a type and a session id, nothing else. With no sink installed
// (remote access off) a notification is only logged, as before.
import type { NotificationType, NotificationRecord } from '../shared/notifications'
import { createLogger } from './log'

const log = createLogger('notify-external')

/** Delivers one notification; false when it could not be handed on. */
export type ExternalSink = (type: NotificationType, sessionId: string) => boolean

let sink: ExternalSink | undefined

/** Install (or with `undefined`, remove) the delivery sink. */
export function setExternalSink(next: ExternalSink | undefined): void {
  sink = next
}

// `async` with no `await`: the seam allows for delivery that waits; the push
// sink does not. The `.catch` at the call site (notifications.ts) stays for it.
export async function sendExternal(type: NotificationType, record: NotificationRecord): Promise<void> {
  // `record.title` embeds the session's (free-form, user-editable) display
  // title — never logged, never sent: same rule `OPAQUE_ARGS` gives
  // `renameSession` in ipc.ts, and a push carries no title (§8.3).
  if (!sink) {
    log.info('external.none', { type, s: record.sessionId })
    return
  }
  const sent = sink(type, record.sessionId)
  log.info('external.push', { type, s: record.sessionId, sent })
}
