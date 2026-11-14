import type { SessionInfo } from './types'

export interface ArchiveSettings {
  autoArchive: boolean
  inactiveHours: number
  autoDelete: boolean
  retentionDays: number
}

const ARCHIVE_DEFAULTS: ArchiveSettings = {
  autoArchive: false, inactiveHours: 72, autoDelete: false, retentionDays: 90
}

export function normalizeArchiveSettings(raw: unknown): ArchiveSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ArchiveSettings>
  const count = (n: unknown, fallback: number, max: number): number =>
    typeof n === 'number' && Number.isFinite(n) ? Math.max(1, Math.min(max, Math.floor(n))) : fallback
  return {
    autoArchive: r.autoArchive === true,
    inactiveHours: count(r.inactiveHours, ARCHIVE_DEFAULTS.inactiveHours, 87600),
    autoDelete: r.autoDelete === true,
    retentionDays: count(r.retentionDays, ARCHIVE_DEFAULTS.retentionDays, 36500)
  }
}

export interface ScopeArchive {
  kind: 'scope' | 'session'
  id: string
  workspace: string
  task: string
  createdAt: string
  archivedAt: string
  pinned: boolean
  sessions: SessionInfo[]
  originalBytes: number
  compressedBytes: number
}

/** Unknown read/activity state never qualifies for automatic removal from work. */
export function canAutoArchive(sessions: SessionInfo[], cutoff: number): boolean {
  return sessions.length > 0 && sessions.every((s) => {
    const activity = Date.parse(s.lastActivityAt ?? '')
    const content = Date.parse(s.lastContentAt ?? '')
    const seen = Date.parse(s.archiveSeenAt ?? '')
    return s.state === 'started' && !s.busy && !s.awaitingInput && !s.limitedUntil &&
      Number.isFinite(activity) && activity < cutoff && Number.isFinite(seen) &&
      (!s.lastContentAt || (Number.isFinite(content) && seen >= content))
  })
}

export interface ArchiveProgress {
  id: string
  label: string
  stage: string
  bytes?: number | undefined
  done: boolean
  error?: string
}
