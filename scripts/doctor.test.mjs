// The machine checklist (src/main/doctor.ts,
// docs/requirements-first-run.md §3).
//
// Three properties, and every one of them is a way the screen could lie to a
// user standing in front of a machine that does not work:
//
//   1. **A skipped row is never `ok`.** When there is no docker binary there is
//      nothing to spawn, so the daemon and image rows are not probed — and
//      "we could not ask" must not render as "the answer is fine". This is the
//      same distinction `dockerSessionContainers` keeps with its null-vs-empty
//      return, here in the row state.
//   2. **Only the two docker rows gate the button.** A missing image is a pull
//      the Start click does itself (§3.3); gating on it would cost a second
//      click for nothing.
//   3. **`docker info` exiting 0 is not an answer.** The probe underneath the
//      daemon row is driven here against a stub `docker` on PATH: empty output
//      and `<nil>` are the two shapes a half-started Docker Desktop produces
//      while the CLI still exits cleanly, and reading either as "up" would put
//      a green row in front of a machine that cannot start a thing.
//
// No docker, no daemon, no electron: every probe is a parameter.
//
//   node scripts/doctor.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-doctor-'))
process.env.GURT_ROOT = GURT_ROOT
// `operatorEnvPath()` resolves off `import.meta.url`, which for a bundle is a
// temp file — the same seam `GURT_PROXY_SCRIPT` gives the proxy, and the one
// the operator smoke already uses (requirements-session-operator.md §16).
process.env.GURT_OPERATOR_ENV = path.join(ROOT, 'resources', 'env', 'devcontainer.json')

const outfile = path.join(os.tmpdir(), `gurt-doctor-${process.pid}.mjs`)
await bundle({
  stdin: {
    contents: `
      export { machineDoctor, prepareImages } from ${S('src/main/doctor.ts')}
      export { dockerDaemon } from ${S('src/main/provision.ts')}
      export { doctorReady, DOCTOR_ROWS, pendingRows } from ${S('src/shared/doctor.ts')}
      export { PROXY_IMAGE } from ${S('src/main/proxy/manager.ts')}
    `,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  external: ['electron'],
  outfile
})
const m = await import(pathToFileURL(outfile).href)

const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-doctor-bin-'))
const PATH_BEFORE = process.env.PATH
/** Put a fake `docker` first on PATH — `dockerDaemon` spawns the bare name. */
const stubDocker = (body) => {
  fs.writeFileSync(path.join(BIN, 'docker'), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  process.env.PATH = `${BIN}:${PATH_BEFORE}`
}

after(() => {
  process.env.PATH = PATH_BEFORE
  fs.rmSync(outfile, { force: true })
  fs.rmSync(BIN, { recursive: true, force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

/** A healthy machine, with each probe overridable per test. */
const healthy = (over = {}) => ({
  cliPath: () => '/usr/local/bin/docker',
  daemon: async () => '27.3.1',
  imageExists: async () => true,
  images: async () => ['node:22-bookworm-slim@sha256:aaa', 'node:22-alpine@sha256:bbb'],
  platform: 'linux',
  ...over
})

const row = (report, id) => report.rows.find((r) => r.id === id)

// --- the happy machine ------------------------------------------------------

test('a machine with everything reports three green rows and is ready', async () => {
  const r = await m.machineDoctor(healthy())
  assert.deepEqual(
    r.rows.map((x) => x.id),
    ['docker-cli', 'docker-daemon', 'images'],
    'the rows are in the order the screen reads them'
  )
  assert.equal(r.rows.every((x) => x.state === 'ok'), true)
  assert.equal(r.ready, true)
  // The detail is the fact, not the word "ok": the same line the start banner
  // writes into app.start, at the moment it can still be acted on.
  assert.equal(row(r, 'docker-cli').detail, '/usr/local/bin/docker')
  assert.equal(row(r, 'docker-daemon').detail, '27.3.1')
  // And never the word "ready": the node feature and the ACP adapter still
  // install over the network on the first start (§5.2).
  assert.match(row(r, 'images').detail, /still installs the node feature/)
})

// --- 1. skipping is not passing --------------------------------------------

test('no docker binary: the rows below it are failed as "not checked", never ok', async () => {
  const r = await m.machineDoctor(healthy({ cliPath: () => null }))
  assert.equal(row(r, 'docker-cli').state, 'fail')
  assert.match(row(r, 'docker-cli').detail, /Docker was not found/)
  assert.match(row(r, 'docker-cli').detail, /Directories searched:/, 'the PATH is unanswerable later')
  for (const id of ['docker-daemon', 'images']) {
    assert.equal(row(r, id).state, 'fail', `${id} must not read as ok`)
    assert.match(row(r, id).detail, /not checked/)
  }
  assert.equal(r.ready, false)
})

test('no daemon: the image row is not probed, and is not ok either', async () => {
  let probed = 0
  const r = await m.machineDoctor(
    healthy({
      daemon: async () => null,
      imageExists: async () => {
        probed++
        return true
      }
    })
  )
  assert.equal(probed, 0, 'the daemon holds the image store — there is nothing to ask')
  assert.equal(row(r, 'docker-daemon').state, 'fail')
  assert.equal(row(r, 'images').state, 'fail')
  assert.match(row(r, 'images').detail, /not checked/)
  assert.equal(r.ready, false)
})

// --- 2. what gates ----------------------------------------------------------

test('a missing image warns and does NOT gate the button', async () => {
  const r = await m.machineDoctor(healthy({ imageExists: async (ref) => ref.includes('alpine') }))
  assert.equal(row(r, 'images').state, 'warn')
  assert.equal(row(r, 'images').gates, false)
  assert.equal(row(r, 'images').action, 'prepare')
  assert.match(row(r, 'images').detail, /1 image to pull/)
  assert.equal(r.ready, true, 'one click stays one click — the click pulls it itself')
})

test('both docker rows gate', async () => {
  for (const over of [{ cliPath: () => null }, { daemon: async () => null }]) {
    const r = await m.machineDoctor(healthy(over))
    assert.equal(r.ready, false)
  }
  assert.equal(
    m.doctorReady([
      { id: 'docker-cli', label: '', state: 'ok', detail: '', gates: true },
      { id: 'images', label: '', state: 'warn', detail: '', gates: false }
    ]),
    true
  )
})

// --- 3. the platform split --------------------------------------------------

test('the "Start Docker Desktop" action is offered on macOS and nowhere else', async () => {
  const mac = await m.machineDoctor(healthy({ daemon: async () => null, platform: 'darwin' }))
  assert.equal(row(mac, 'docker-daemon').action, 'start-docker')
  assert.match(row(mac, 'docker-daemon').detail, /start Docker Desktop/)

  // On Linux the daemon is a system service, gurt does not sudo, and
  // `systemctl --user start docker` is right for a rootless install and wrong
  // for every other — so the row carries a sentence instead of a button that
  // would silently do nothing (§3.4).
  const linux = await m.machineDoctor(healthy({ daemon: async () => null, platform: 'linux' }))
  assert.equal(linux.rows.find((x) => x.id === 'docker-daemon').action, undefined)
  assert.match(row(linux, 'docker-daemon').detail, /OrbStack|dockerd/)
})

test('a healthy daemon offers no action at all', async () => {
  const r = await m.machineDoctor(healthy({ platform: 'darwin' }))
  assert.equal(row(r, 'docker-daemon').action, undefined)
  assert.equal(row(r, 'images').action, undefined)
})

// --- what Prepare pulls -----------------------------------------------------

test('prepare covers the bundled operator env AND the session proxy', async () => {
  // Both are read from where they are defined rather than restated: a packaged
  // update bumps the operator env's pin and Prepare has to follow it.
  const refs = await m.prepareImages()
  assert.equal(refs.length, 2)
  assert.equal(refs.includes(m.PROXY_IMAGE), true, 'every session gets a proxy container')
  const operator = refs.find((r) => r !== m.PROXY_IMAGE)
  assert.match(operator, /^node:.*@sha256:/, 'digest-pinned, like everything else gurt runs')
})

// --- the probe under the daemon row -----------------------------------------

test('`docker info` is only an answer when it exits 0 AND prints a version', async () => {
  stubDocker('echo 27.3.1')
  assert.equal(await m.dockerDaemon(5000), '27.3.1')

  // A half-started Docker Desktop: the CLI is fine, the daemon is not, and the
  // template has nothing to render. Exit code alone would call this "up".
  stubDocker('exit 0')
  assert.equal(await m.dockerDaemon(5000), null, 'exit 0 with no output is not a daemon')

  stubDocker('echo "<nil>"')
  assert.equal(await m.dockerDaemon(5000), null, 'the template renders <nil> for an absent field')

  stubDocker('echo "Cannot connect to the Docker daemon" >&2; exit 1')
  assert.equal(await m.dockerDaemon(5000), null)
})

test('a hung docker does not hold the checklist open forever', async () => {
  // The state this bound exists for: a Docker Desktop that is neither up nor
  // dead answers `info` never, and the row has to say something anyway.
  // `exec`, not a plain `sleep`: SIGKILL goes to the process gurt spawned, and
  // a shell that forked a child would leave that child holding the pipe.
  stubDocker('exec sleep 30')
  const started = Date.now()
  assert.equal(await m.dockerDaemon(300), null)
  assert.ok(Date.now() - started < 5000, 'killed at the timeout, not waited out')
})

// --- the sweep is watched, not awaited (§3.5) -------------------------------
//
// The rows are known before anything is probed, so the screen draws all three
// at once and fills them in order from `onRow`. The alternative — one report at
// the end — showed a placeholder for as long as the slowest probe took and then
// everything at once, which reads as a hang rather than as work.

test('the row list is static, and the renderer can draw it before asking anything', () => {
  assert.deepEqual(
    m.DOCTOR_ROWS.map((r) => r.id),
    ['docker-cli', 'docker-daemon', 'images']
  )
  const skeleton = m.pendingRows()
  assert.equal(skeleton.length, 3)
  assert.equal(skeleton.every((r) => r.state === 'pending' && r.detail === ''), true)
  // Labels and gating come from the one list, so a row cannot be labelled one
  // way by main and another by the screen.
  assert.deepEqual(
    skeleton.map((r) => [r.label, r.gates]),
    m.DOCTOR_ROWS.map((r) => [r.label, r.gates])
  )
})

test('each row is announced as it is decided, in order, before the report returns', async () => {
  const announced = []
  const report = await m.machineDoctor({
    ...healthy(),
    // The daemon is the slow one in real life; if the report were the only
    // signal, rows 1 and 3 would wait behind it for nothing.
    daemon: async () => {
      assert.deepEqual(announced.map((r) => r.id), ['docker-cli'], 'row 1 landed first')
      return '27.3.1'
    },
    onRow: (row) => announced.push(row)
  })
  assert.deepEqual(
    announced.map((r) => r.id),
    ['docker-cli', 'docker-daemon', 'images'],
    'announced in the order the screen reads them'
  )
  assert.deepEqual(announced, report.rows, 'and the stream is exactly the report')
  assert.equal(announced.some((r) => r.state === 'pending' || r.state === 'checking'), false,
    'main only ever announces settled rows')
})

test('a skipped row is announced too — the list must never stall half-drawn', async () => {
  const announced = []
  await m.machineDoctor({ ...healthy({ cliPath: () => null }), onRow: (r) => announced.push(r) })
  assert.deepEqual(
    announced.map((r) => r.id),
    ['docker-cli', 'docker-daemon', 'images'],
    'the rows below a missing binary still resolve, as "not checked"'
  )
  assert.equal(announced.every((r) => r.state === 'fail'), true)

  const halfway = []
  await m.machineDoctor({ ...healthy({ daemon: async () => null }), onRow: (r) => halfway.push(r) })
  assert.equal(halfway.length, 3, 'and likewise below a dead daemon')
})

test('machineDoctor works with no onRow at all', async () => {
  const r = await m.machineDoctor(healthy())
  assert.equal(r.rows.length, 3)
})
