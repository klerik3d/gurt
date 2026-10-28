// Docker garbage collection. gurt creates images, containers and build cache
// and, until this module, only ever removed containers of deleted sessions.
// One pass (`runGc`) reclaims, in order:
//   1. session containers stopped longer than the retention window — the
//      session and its clone stay, the next start builds a fresh container;
//   2. env images (`gurt-env:*`) nothing uses, keeping only the newest build
//      per (repo, env) label pair — unlabeled leftovers from before labels
//      existed are removed when unused;
//   3. BuildKit cache older than the configured age (optional) — daemon-wide,
//      Docker has no per-owner view of the cache.
// When the disk is over the configured threshold the TTLs are ignored: every
// stopped container goes and all unused cache is pruned.
// Nothing else is pruned: no `image prune`, so other projects' images are never
// touched. Images in use are never removed: `docker rmi` without -f refuses.
import { statfs } from 'node:fs/promises'
import type { ContainerManager } from './containers'
import { envBuildInFlight, run } from './provision'
import { createLogger } from './log'
import * as store from './store'
import { gurtRoot } from './store'
import { type GcResult, type GcSettings } from '../shared/gc'

const log = createLogger('gc')
const DOCKER_TIMEOUT_MS = 120_000
/** A prune of a large cache can legitimately take a while. */
const PRUNE_TIMEOUT_MS = 10 * 60_000
const INTERVAL_MS = 6 * 60 * 60_000
const noop = (): void => {}

interface ImageInfo {
  id: string
  tag: string
  created: number
  repo: string | undefined
  env: string | undefined
}

async function docker(args: string[], timeoutMs = DOCKER_TIMEOUT_MS): Promise<string> {
  return run('docker', args, noop, { timeoutMs })
}

/** gurt-env images with the labels `buildEnvImage` stamps (undefined on the
 *  unlabeled ones built before labels existed). */
async function envImages(): Promise<ImageInfo[]> {
  const tags = (await docker(['image', 'ls', '--filter', 'reference=gurt-env', '--format', '{{.Repository}}:{{.Tag}}']))
    .split('\n')
    .map((l) => l.trim())
    .filter((t) => t && !t.endsWith(':<none>'))
  if (!tags.length) return []
  const raw: unknown = JSON.parse(await docker(['image', 'inspect', ...tags]))
  if (!Array.isArray(raw)) return []
  const out: ImageInfo[] = []
  for (const r of raw as Array<Record<string, any>>) {
    const labels = (r['Config']?.['Labels'] ?? {}) as Record<string, string>
    const tag = (r['RepoTags'] as string[] | undefined)?.find((t) => t.startsWith('gurt-env:'))
    if (!tag || typeof r['Id'] !== 'string') continue
    out.push({
      id: r['Id'],
      tag,
      created: Date.parse(String(r['Created'])) || 0,
      repo: labels['gurt.repo'],
      env: labels['gurt.env']
    })
  }
  return out
}

/** Image ids (full `sha256:…`) any container, running or stopped, was created from. */
async function usedImageIds(): Promise<Set<string>> {
  const ids = (await docker(['ps', '-a', '-q', '--no-trunc'])).split('\n').map((l) => l.trim()).filter(Boolean)
  if (!ids.length) return new Set()
  const out = await docker(['inspect', '--format', '{{.Image}}', ...ids])
  return new Set(out.split('\n').map((l) => l.trim()).filter(Boolean))
}

/** Env images to remove: unused ones other than the newest labeled build of
 *  each (repo, env). Exported for the unit test. */
export function pickStaleImages(images: ImageInfo[], used: Set<string>): ImageInfo[] {
  const newest = new Map<string, ImageInfo>()
  for (const img of images) {
    if (img.repo === undefined || img.env === undefined) continue
    const key = `${img.repo}\n${img.env}`
    const cur = newest.get(key)
    if (!cur || img.created > cur.created) newest.set(key, img)
  }
  const keep = new Set([...newest.values()].map((i) => i.id))
  return images.filter((i) => !used.has(i.id) && !keep.has(i.id))
}

/** "Total reclaimed space: 1.2GB" / "Total:  1.2GB" → "1.2GB". */
const reclaimed = (out: string): string | undefined =>
  /^Total(?: reclaimed space)?:\s*(.+)$/im.exec(out)?.[1]?.trim()

/** The moment a stopped container stopped; `undefined` if it cannot be read. */
async function finishedAt(containerId: string): Promise<number | undefined> {
  try {
    const t = Date.parse((await docker(['inspect', '--format', '{{.State.FinishedAt}}', containerId])).trim())
    return Number.isFinite(t) && t > 0 ? t : undefined
  } catch {
    return undefined
  }
}

/** Used share (0–100) of the disk holding Docker's data: the daemon's own
 *  directory where it is readable (Linux, docker-in-docker), else the gurt
 *  root. Undefined when neither can be read. */
async function diskUsedPercent(): Promise<number | undefined> {
  for (const dir of ['/var/lib/docker', gurtRoot]) {
    try {
      const f = await statfs(dir)
      if (f.blocks > 0) return Math.round((1 - f.bavail / f.blocks) * 100)
    } catch {
      /* try the next candidate */
    }
  }
  return undefined
}

let inFlight: Promise<GcResult> | undefined

/** One collection pass. Single-flight: a call during a pass joins it. */
export function runGc(containers: ContainerManager, settings: GcSettings): Promise<GcResult> {
  inFlight ??= pass(containers, settings).finally(() => (inFlight = undefined))
  return inFlight
}

async function pass(containers: ContainerManager, s: GcSettings): Promise<GcResult> {
  const started = Date.now()
  const result: GcResult = { containers: 0, images: 0, ms: 0 }
  const done = (skipped?: string): GcResult => {
    result.ms = Date.now() - started
    if (skipped) result.skipped = skipped
    log.info('gc.done', { ...result })
    return result
  }
  try {
    await docker(['version', '--format', '{{.Server.Version}}'])
  } catch {
    return done('Docker is not reachable')
  }
  const used = await diskUsedPercent()
  if (used !== undefined) result.diskPercent = used
  // Disk nearly full: waiting out the TTLs would be the wrong call.
  const emergency = used !== undefined && used >= s.diskThresholdPercent
  if (emergency) result.emergency = true
  try {
    const cutoff = emergency ? Date.now() : Date.now() - s.stoppedContainerHours * 3_600_000
    result.containers = await containers.gcStopped(async (id) => {
      const t = await finishedAt(id)
      return t !== undefined && t < cutoff
    })
  } catch (e) {
    log.warn('gc.containers.fail', { err: e })
  }
  // Between a build finishing and its `up`, the image has no container: do not
  // look at images while any start or build is in progress.
  if (containers.isStarting() || envBuildInFlight()) {
    return done('a session is starting — images and cache left for the next pass')
  }
  try {
    const stale = pickStaleImages(await envImages(), await usedImageIds())
    for (const img of stale) {
      // No -f: an image a container still uses is refused and kept.
      const ok = await docker(['rmi', img.tag]).then(() => true, () => false)
      if (ok) result.images++
    }
  } catch (e) {
    log.warn('gc.images.fail', { err: e })
  }
  if (!s.pruneBuildCache) return done()
  try {
    const out = await docker(
      ['builder', 'prune', '-f', ...(emergency ? ['--all'] : ['--filter', `until=${s.buildCacheHours}h`])],
      PRUNE_TIMEOUT_MS
    )
    const r = reclaimed(out)
    if (r) result.buildCacheReclaimed = r
  } catch (e) {
    log.warn('gc.builder.fail', { err: e })
  }
  return done()
}

/** Start the periodic pass: one shortly after boot, then every few hours. The
 *  settings are re-read each time, so toggling `enabled` takes effect without a
 *  restart. The timer never keeps the app alive. */
export function startGc(containers: ContainerManager): void {
  const tick = (): void => {
    void store
      .getGcSettings()
      .then((s) => (s.enabled ? runGc(containers, s) : undefined))
      .catch((e: unknown) => log.error('internal.fail', { site: 'gc', err: e }))
  }
  setTimeout(tick, 60_000).unref()
  setInterval(tick, INTERVAL_MS).unref()
}
