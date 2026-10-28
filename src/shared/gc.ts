// Docker garbage-collection settings + result shape — shared between main (the
// collector, persistence) and renderer (Settings → Docker cleanup).

export interface GcSettings {
  /** Run automatically at startup and every few hours. "Clean now" always works. */
  enabled: boolean
  /** A stopped session container is removed after this many hours stopped. The
   *  clone is a host bind mount, so the next start just creates a fresh one. */
  stoppedContainerHours: number
  /** When the disk holding Docker's data is fuller than this, a pass drops the
   *  TTLs: every stopped container goes and all unused build cache is pruned. */
  diskThresholdPercent: number
  /** Prune BuildKit cache at all. Daemon-wide: Docker cannot filter cache by
   *  owner, so on a shared Docker it also clears other projects' build cache. */
  pruneBuildCache: boolean
  /** BuildKit cache older than this many hours is pruned. */
  buildCacheHours: number
}

export const GC_DEFAULTS: GcSettings = {
  enabled: true,
  stoppedContainerHours: 48,
  diskThresholdPercent: 80,
  pruneBuildCache: true,
  buildCacheHours: 48
}

/** Bounds for the numeric settings: at least an hour, at most a year. */
export const GC_HOURS_MIN = 1
export const GC_HOURS_MAX = 24 * 365
export const GC_DISK_MIN = 50
export const GC_DISK_MAX = 99

const hours = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v)
    ? Math.min(GC_HOURS_MAX, Math.max(GC_HOURS_MIN, Math.round(v)))
    : fallback

/** The IPC boundary and the file on disk are untrusted: coerce every field,
 *  falling back to `fallback` (the current settings) for a missing/garbled one. */
export function normalizeGcSettings(raw: unknown, fallback: GcSettings = GC_DEFAULTS): GcSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof GcSettings, unknown>>
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : fallback.enabled,
    stoppedContainerHours: hours(r.stoppedContainerHours, fallback.stoppedContainerHours),
    diskThresholdPercent:
      typeof r.diskThresholdPercent === 'number' && Number.isFinite(r.diskThresholdPercent)
        ? Math.min(GC_DISK_MAX, Math.max(GC_DISK_MIN, Math.round(r.diskThresholdPercent)))
        : fallback.diskThresholdPercent,
    pruneBuildCache: typeof r.pruneBuildCache === 'boolean' ? r.pruneBuildCache : fallback.pruneBuildCache,
    buildCacheHours: hours(r.buildCacheHours, fallback.buildCacheHours)
  }
}

/** What one collection pass did. */
export interface GcResult {
  /** Stopped session containers removed (their sessions are kept). */
  containers: number
  /** Env images removed (superseded, or unlabeled leftovers nothing uses). */
  images: number
  /** Human-readable space reclaimed by the build-cache prune ("1.2GB"), if reported. */
  buildCacheReclaimed?: string
  /** The disk was over the threshold, so TTLs were ignored for this pass. */
  emergency?: boolean
  /** Used share of the disk that was checked, percent (when it could be read). */
  diskPercent?: number
  /** Set when the pass could not run (Docker unreachable, sessions starting…). */
  skipped?: string
  ms: number
}
