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
import { parseEnvDevcontainer } from '../shared/envConfig'
import {
  DOCTOR_ROWS,
  doctorReady,
  type DoctorReport,
  type DoctorRow,
  type DoctorRowId
} from '../shared/doctor'
import { hostPath } from './hostPath'
import { createLogger } from './log'
import { bundledOperatorEnv } from './operatorEnv'
import { PROXY_IMAGE } from './proxy/manager'
import {
  dockerCliPath,
  dockerDaemon,
  dockerImageExists,
  run,
  type LogSink
} from './provision'

const log = createLogger('doctor')

/** Generous on purpose: the case this exists for is a conference hotel's wifi,
 *  where the pull is slow but not broken. Both refs share the budget. */
const PULL_TIMEOUT_MS = 15 * 60_000

/**
 * The two images a first session needs, digest-pinned, both read from where
 * they are already defined rather than restated here — a packaged update bumps
 * the operator env's pin and Prepare has to follow it.
 *
 * Only the *bundled* env. A workspace that re-pointed `operatorEnv`
 * (`setOperatorEnv`) may name an env with a `build` section, which is not a
 * pull at all; the row says so instead of claiming a check it did not make.
 */
export async function prepareImages(): Promise<string[]> {
  const env = await bundledOperatorEnv()
  const image = parseEnvDevcontainer(env.devcontainer).config?.['image']
  const refs = [PROXY_IMAGE]
  if (typeof image === 'string' && image.trim()) refs.unshift(image.trim())
  return refs
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
  settle({
    ...rowOf(
      'images',
      missing.length ? 'warn' : 'ok',
      missing.length
        ? `${missing.length} image${missing.length === 1 ? '' : 's'} to pull — the first session ` +
          'pulls them anyway; Prepare does it now'
        : // Deliberately not the word "ready": `devcontainer up` still injects
          // the node feature and gurt still npm-installs the ACP adapter inside
          // the container, both over the network, on every first start (§5.2).
          'images present — the first start still installs the node feature and the agent adapter'
    ),
    ...(missing.length ? { action: 'prepare' as const } : {})
  })
  return { rows, ready: doctorReady(rows) }
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
