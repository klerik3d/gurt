// Runs the docker-free smoke/e2e suite as separate `node <file>` processes.
// Used by `npm run smoke` locally and by the `smoke` job in CI.
//
// These drive the *built* app (out/) with playwright-core's `_electron` through
// the real UI, so they need:
//   - a build: `npm run build` (run automatically below when out/ is missing)
//   - a display: the devcontainer starts Xvfb on :99; CI wraps the run in
//     `xvfb-run`. On a headless box without either, Electron cannot start.
//
// Every script gets its own SCRATCH directory. Smoke roots must be unique per
// run (see the Docker Desktop gotchas in the README: a recreated path can keep
// a stale virtiofs cache), and a shared root would also let concurrent or
// repeated runs stomp on each other's GURT_ROOT and screenshots.
//
// The scripts strip ELECTRON_RUN_AS_NODE themselves, so this runner does not.
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The docker-free subset. Docker-backed smokes (provisioning, persistence,
// crud, codex, queue, logging, turn-contract, …) need a daemon plus agent
// secrets and stay out of the default gate — run them by hand.
const SMOKES = [
  'smoke.mjs',
  'smoke-git-access.mjs',
  'smoke-delete-row.mjs',
  'smoke-session-copy.mjs',
  'smoke-roles.mjs',
  'smoke-deleted-task.mjs',
  'smoke-newtask.mjs',
]

// Per-script wall clock. A shared CI runner is a lot slower than a laptop and
// each script already has its own selector timeouts (15s for first paint, 5-10s
// per step); this is the outer backstop that turns a hung Electron into a FAIL
// instead of a job that burns the whole 6h budget.
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 240_000)

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const appDir = dirname(scriptsDir)

if (!existsSync(join(appDir, 'out', 'main', 'index.js'))) {
  console.log('out/ is missing — running `npm run build` first')
  const build = spawnSync('npm', ['run', 'build'], { cwd: appDir, stdio: 'inherit', shell: process.platform === 'win32' })
  if (build.status !== 0) {
    console.error('build failed — cannot run the smoke suite')
    process.exit(1)
  }
}

// One parent scratch per run, one child per script.
const scratchRoot = process.env.SMOKE_SCRATCH_ROOT
  ? (mkdirSync(process.env.SMOKE_SCRATCH_ROOT, { recursive: true }), process.env.SMOKE_SCRATCH_ROOT)
  : mkdtempSync(join(tmpdir(), 'gurt-smoke-'))
console.log(`scratch root: ${scratchRoot}`)

const failed = []
for (const name of SMOKES) {
  const rel = join('scripts', name)
  const scratch = join(scratchRoot, name.replace(/\.mjs$/, ''))
  mkdirSync(scratch, { recursive: true })
  console.log(`RUN ${rel}`)
  const result = spawnSync(process.execPath, [join(scriptsDir, name)], {
    cwd: appDir,
    stdio: 'inherit',
    timeout: TIMEOUT_MS,
    killSignal: 'SIGKILL',
    env: { ...process.env, SCRATCH: scratch },
  })
  if (result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGKILL') {
    console.log(`FAIL ${rel} (timed out after ${TIMEOUT_MS}ms)`)
    failed.push(`${rel} (timeout)`)
  } else if (result.status !== 0) {
    console.log(`FAIL ${rel} (exit ${result.status ?? `signal ${result.signal}`})`)
    failed.push(rel)
  } else {
    console.log(`PASS ${rel}`)
  }
}

if (failed.length > 0) {
  console.log(`\n${failed.length} smoke script(s) failed: ${failed.join(', ')}`)
  console.log(`artifacts (screenshots, gurt roots) under ${scratchRoot}`)
  process.exit(1)
}
console.log(`\nAll ${SMOKES.length} smoke script(s) passed.`)
