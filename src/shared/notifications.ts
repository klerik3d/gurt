// Notification prefs + record shape — shared between main (resolves bus events
// into records, persists the on/off matrix) and renderer (settings, panel).
import type { EnvRef } from './types'

export type NotificationType = 'awaiting' | 'proposal' | 'error' | 'turn-ended'

export interface NotificationTypePrefs {
  inApp: boolean
  external: boolean
}

export type NotificationPrefs = Record<NotificationType, NotificationTypePrefs>

export const NOTIFICATION_DEFAULTS: NotificationPrefs = {
  awaiting: { inApp: true, external: true },
  proposal: { inApp: true, external: false },
  error: { inApp: true, external: true },
  'turn-ended': { inApp: false, external: false }
}

/** Oldest dropped once the in-memory/renderer history exceeds this — one
 *  constant so main's ring and the renderer's mirror never disagree. */
export const NOTIFICATION_RING_CAP = 200

/** The IPC boundary is untrusted input, not `NotificationPrefs` — a renderer
 *  bug or a stale/hand-edited call can send anything. Walks the known types
 *  and coerces each field to a boolean, falling back to `fallback`'s value
 *  (the currently-persisted prefs, by default `NOTIFICATION_DEFAULTS`) when
 *  the field is missing or the wrong shape — a garbage or partial payload
 *  degrades to "leave that field as it was", never to "silently discard the
 *  user's setting", and never to writing anything but a valid, boolean
 *  matrix. */
export function normalizeNotificationPrefs(
  raw: unknown,
  fallback: NotificationPrefs = NOTIFICATION_DEFAULTS
): NotificationPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<
    Record<NotificationType, Partial<NotificationTypePrefs>>
  >
  const prefs = {} as NotificationPrefs
  for (const type of Object.keys(NOTIFICATION_DEFAULTS) as NotificationType[]) {
    const entry = r[type]
    const d = fallback[type]
    prefs[type] = {
      inApp: typeof entry?.inApp === 'boolean' ? entry.inApp : d.inApp,
      external: typeof entry?.external === 'boolean' ? entry.external : d.external
    }
  }
  return prefs
}

/** One entry in the in-app notification panel. */
export interface NotificationRecord {
  id: string
  type: NotificationType
  sessionId: string
  ref: EnvRef
  /** "<task> · <session title>" */
  title: string
  detail: string
  /** ISO timestamp. */
  ts: string
  read: boolean
}
