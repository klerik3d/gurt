// External delivery — stub for this slice (docs/requirements-notifications.md
// §5). The seam a later Slack/webhook/email/OS-push implementation replaces;
// nothing else in this spec changes when it does.
import type { NotificationType, NotificationRecord } from '../shared/notifications'
import { createLogger } from './log'

const log = createLogger('notify-external')

// `async` with no `await`: a deliberate seam for a later real implementation
// (network calls, retries) — not load-bearing today. The `.catch` at the
// call site (notifications.ts) is likewise dormant until then.
export async function sendExternal(type: NotificationType, record: NotificationRecord): Promise<void> {
  // `record.title` embeds the session's (free-form, user-editable) display
  // title — never logged, same rule `OPAQUE_ARGS` gives `renameSession` in ipc.ts.
  log.info('external.stub', { type, s: record.sessionId })
}
