// `NotifyPort` (t3v2 §11) over notifications.ts: `called` is an `awaiting`,
// `passed` a `proposal`; both open the executor's Review tab. The quieting of
// the executor's ordinary notifications is `Notifications.setQuiets`, which the
// kernel points at `Rpm.quiets`.
import type { NotifyPort } from '../../rpm/main'
import type { Notifications } from '../notifications'

export function createNotifyPort(notifications: Pick<Notifications, 'rpm'>): NotifyPort {
  return {
    notify: ({ sessionId, kind, text, open }) =>
      notifications.rpm({
        sessionId,
        type: kind === 'called' ? 'awaiting' : 'proposal',
        detail: text,
        open: { sessionId, tab: 'review', ...open }
      })
  }
}
