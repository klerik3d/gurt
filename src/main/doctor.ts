// The machine checklist and its one action (docs/requirements-first-run.md
// §3, §5).
//
// This is `logStartBanner`'s content (index.ts: the docker version, the CLI
// path, the PATH searched) turned from a line in a log file nobody opens into
// three rows on the screen a first-time user is already looking at — at the
// moment the answer can still be acted on, which is the same argument
// `resolveHostCommand` makes for checking an MCP command when it is *saved*
// (docs/requirements-mcp-stdio.md §4.3).
//
// Nothing here is cached. The three facts it reports all change while the app
// is open — Docker Desktop is quit, an image is pulled, a runtime is
// installed — and a stale "everything is fine" is worse than no checklist at
// all, because it is the sentence that sends a user looking somewhere else.
import { spawn } from 'node:child_process'
import {
  DOCTOR_ROWS,
  doctorReady,
  type DoctorReport,
  type DoctorRow,
  type DoctorRowId
} from '../shared/doctor'
import { AGENT_MANIFESTS } from '../shared/agents'
import { hostPath } from './hostPath'
import { createLogger } from './log'
import { getBaseImage } from './store'
import { PROXY_IMAGE } from './proxy/manager'
import {
  NODE_RUNTIME_IMAGE,
  dockerCliPath,
  dockerDaemon,
  dockerImageExists,
  adaptersVolumeKey,
  adaptersVolumeName,
  ensureAdaptersVolume,
  ensureNodeRuntimeVolume,
  run,
  type LogSink
} from './provision'

const log = createLogger('doctor')

/** Generous on purpose: the case this exists for is a conference hotel's wifi,
 *  where the pull is slow but not broken. Both refs share the budget. */
const PULL_TIMEOUT_MS = 15 * 60_000

/**
 * The images a first session needs, digest-pinned, all read from where they
 * are already defined rather than restated here — a packaged update bumps the
 * base image's pin and Prepare has to follow it: the base image, gurt's Node
 * runtime image (its volume is filled right after the pulls) and the proxy.
 *
 * Only the base image: a workspace env may name a Dockerfile, which is not a
 * pull at all.
 */
export async function prepareImages(): Promise<string[]> {
  return [...new Set([await getBaseImage(), NODE_RUNTIME_IMAGE, PROXY_IMAGE])]
}

/** A row's label and gating come from the one shared list, so main and the
 *  renderer cannot disagree about what is being checked or in what order. */
const rowDef = (id: DoctorRowId): { id: DoctorRowId; label: string; gates: boolean } =>
  DOCTOR_ROWS.find((r) => r.id === id)!

const rowOf = (id: DoctorRowId, state: DoctorRow['state'], detail: string): DoctorRow => ({
  ...rowDef(id),
  state,
  detail
})

/** A skipped row is never `ok`. "We could not ask" and "the answer is no" must
 *  not read alike — the same distinction `dockerSessionContainers` keeps with
 *  its `null`-vs-empty return, here in prose. */
const notChecked = (id: DoctorRowId): DoctorRow =>
  rowOf(id, 'fail', 'not checked — Docker is not available')

/**
 * Run the checklist. Never rejects: every failure it can have is a row, which
 * is the entire point of the thing.
 *
 * The probes are parameters so a test can drive the table without a daemon,
 * the way `assertDockerCli` takes its lookup as a defaulted argument.
 */
export async function machineDoctor(
  probes: {
    cliPath?: () => string | null
    daemon?: () => Promise<string | null>
    imageExists?: (ref: string) => Promise<boolean>
    images?: () => Promise<string[]>
    /** How many agent adapter volumes do not exist yet (null: could not ask). */
    adapterVolumesMissing?: () => Promise<number | null>
    platform?: NodeJS.Platform
    /** Called with each row the moment it is decided, before the next probe
     *  runs. The renderer draws the row list up front and fills it in from
     *  these, so a slow `docker info` holds up its own row and nothing else. */
    onRow?: (row: DoctorRow) => void
  } = {}
): Promise<DoctorReport> {
  const cliPath = probes.cliPath ?? dockerCliPath
  const daemon = probes.daemon ?? (() => dockerDaemon())
  const imageExists = probes.imageExists ?? dockerImageExists
  const images = probes.images ?? prepareImages
  const adaptersMissing = probes.adapterVolumesMissing ?? missingAdapterVolumes
  const platform = probes.platform ?? process.platform

  const rows: DoctorRow[] = []
  const settle = (row: DoctorRow): DoctorRow => {
    rows.push(row)
    probes.onRow?.(row)
    return row
  }

  // 1. The binary. Cheap enough to be unconditional: a few `stat`s over the
  //    PATH hostPath.ts repaired at startup.
  const cli = cliPath()
  settle(
    rowOf(
      'docker-cli',
      cli ? 'ok' : 'fail',
      cli
        ? cli
        : 'Docker was not found on this machine. Install Docker Desktop (or another Docker ' +
          `runtime) and re-check. Directories searched: ${hostPath()}`
    )
  )

  // 2. The daemon behind it. Skipped when there is nothing to spawn.
  if (!cli) {
    settle(notChecked('docker-daemon'))
    settle(notChecked('images'))
    return { rows, ready: doctorReady(rows) }
  }
  const version = await daemon()
  settle({
    ...rowOf(
      'docker-daemon',
      version ? 'ok' : 'fail',
      version
        ? version
        : platform === 'darwin'
          ? 'Docker is installed but its daemon is not answering — start Docker Desktop and re-check.'
          : // No action button here: the daemon is a system service, gurt does
            // not run `sudo`, and `systemctl --user start docker` is right for
            // a rootless install and wrong for every other (§3.4).
            'Docker is installed but its daemon is not answering — start your Docker runtime ' +
            '(dockerd, Docker Desktop, OrbStack, Rancher Desktop) and re-check.'
    ),
    // Offered only where it can work. A button that silently does nothing on
    // half the supported platforms is worse than no button.
    ...(version || platform !== 'darwin' ? {} : { action: 'start-docker' as const })
  })

  // 3. The images. Never gates: a missing image is a pull the Start button
  //    does itself (§3.3), not a broken machine.
  if (!version) {
    settle(notChecked('images'))
    return { rows, ready: doctorReady(rows) }
  }
  const refs = await images()
  const present = await Promise.all(refs.map((ref) => imageExists(ref)))
  const missing = refs.filter((_, i) => !present[i])
  // Only worth asking once the images are there (a volume is filled from one).
  const volumesMissing = missing.length ? 0 : ((await adaptersMissing()) ?? 0)
  settle({
    ...rowOf(
      'images',
      missing.length || volumesMissing ? 'warn' : 'ok',
      missing.length
        ? `${missing.length} image${missing.length === 1 ? '' : 's'} to pull — the first session ` +
          'pulls them anyway; Prepare does it now'
        : volumesMissing
          ? `images present, ${volumesMissing} agent adapter volume${volumesMissing === 1 ? '' : 's'} ` +
            'to fill — the first start of that agent fills it (npm, once); Prepare does it now'
          : // Deliberately not the word "ready": the row checks that the
            // volumes exist, not that they are sound (§5.2).
            'images and agent adapter volumes present'
    ),
    ...(missing.length || volumesMissing ? { action: 'prepare' as const } : {})
  })
  return { rows, ready: doctorReady(rows) }
}

/** Adapter volumes (one per distinct pin set, for the node image's arch) that
 *  do not exist. null when the arch cannot be read — never a guess. */
async function missingAdapterVolumes(): Promise<number | null> {
  try {
    const arch = (
      await run('docker', ['image', 'inspect', '-f', '{{.Architecture}}', NODE_RUNTIME_IMAGE], () => {})
    ).trim()
    const names = new Map(AGENT_MANIFESTS.map((a) => [adaptersVolumeKey(a), adaptersVolumeName(a, arch)]))
    const exist = await Promise.all(
      [...names.values()].map((n) => run('docker', ['volume', 'inspect', n], () => {}).then(() => true, () => false))
    )
    return exist.filter((e) => !e).length
  } catch {
    return null
  }
}

/** One pull at a time, deliberately: two `docker pull` progress streams
 *  interleaved into one line-oriented log are unreadable, and the total is
 *  bounded by bandwidth either way. */
export async function machinePrepare(sink: LogSink): Promise<void> {
  const refs = await prepareImages()
  for (const ref of refs) {
    if (await dockerImageExists(ref)) {
      sink(`${ref} — already present`)
      continue
    }
    sink(`pulling ${ref}`)
    await run('docker', ['pull', ref], sink, { timeoutMs: PULL_TIMEOUT_MS })
  }
  // The Node runtime volume the session containers mount: filled from the
  // image just pulled, so the first start does not pay for it.
  const arch = (
    await run('docker', ['image', 'inspect', '-f', '{{.Architecture}}', NODE_RUNTIME_IMAGE], () => {})
  ).trim()
  await ensureNodeRuntimeVolume(arch, sink)
  // The adapters volumes, one per distinct pin set, so the first start of any
  // agent kind does not npm-install either. One at a time, like the pulls.
  const seen = new Set<string>()
  for (const agent of AGENT_MANIFESTS) {
    const key = adaptersVolumeKey(agent)
    if (seen.has(key)) continue
    seen.add(key)
    await ensureAdaptersVolume(agent, arch, sink)
  }
  sink('images ready')
}

/**
 * Bring the host's Docker GUI up. macOS only — see the `start-docker` action's
 * absence on every other platform in {@link machineDoctor}. Fire-and-forget:
 * Docker Desktop takes the better part of a minute to answer, and the row's
 * re-check is what reports the result, not this call.
 */
export function startDockerApp(): void {
  if (process.platform !== 'darwin') return
  try {
    const child = spawn('open', ['-a', 'Docker'], { detached: true, stdio: 'ignore' })
    child.on('error', (e) => log.warn('docker.open.fail', { err: e }))
    child.unref()
  } catch (e) {
    log.warn('docker.open.fail', { err: e })
  }
}
