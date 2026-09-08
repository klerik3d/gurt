// The PATH a GUI-launched gurt has to repair, and the docker preflight built
// on it (src/main/hostPath.ts, `assertDockerCli` in src/main/provision.ts).
//
// Why this file exists: gurt shells out to `docker` for every session, and a
// macOS bundle launched from the Dock inherits launchd's PATH
// (/usr/bin:/bin:/usr/sbin:/sbin) — which is exactly where Docker Desktop does
// not put its CLI. The app then reports `start failed: spawn docker ENOENT`, an
// internal-looking error for a plain missing dependency, from a build that
// works when launched from a terminal. Both halves of the fix are checked here:
//
//   - the search path keeps the user's own PATH first (a user who put a docker
//     shim ahead of the real one meant it), appends the directories a GUI
//     process loses, and de-duplicates;
//   - the preflight refuses the start with a sentence naming Docker, and finds
//     a `docker` that is only on PATH because of the repair.
//
// No electron, no daemon: the stub `docker` here is a shell script that is
// never run, only resolved.
//
//   node scripts/host-path.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

// store.ts reads GURT_ROOT at module load — set it before the import.
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-host-path-'))
process.env.GURT_ROOT = GURT_ROOT

const outfile = path.join(os.tmpdir(), `gurt-host-path-${process.pid}.mjs`)
await bundle({
  stdin: {
    contents: `
      export { hostPath, applyHostPath, resolveHostCommand } from ${S('src/main/hostPath.ts')}
      export { dockerCliPath, assertDockerCli, assertDockerDaemon, resetDockerDaemonMemo } from ${S('src/main/provision.ts')}
    `,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  external: ['electron'],
  outfile
})
const m = await import(pathToFileURL(outfile).href)

const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-host-path-bin-'))
fs.writeFileSync(path.join(BIN, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
const PATH_BEFORE = process.env.PATH

after(() => {
  process.env.PATH = PATH_BEFORE
  fs.rmSync(outfile, { force: true })
  fs.rmSync(BIN, { recursive: true, force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

// --- the search path --------------------------------------------------------

test('the PATH gurt searches is the user PATH plus where GUI apps lose it', () => {
  const resolved = m.hostPath({ PATH: '/usr/local/bin:/custom' })
  assert.equal(resolved.startsWith('/usr/local/bin:/custom:'), true, 'the user PATH wins and comes first')
  assert.equal(resolved.includes('/opt/homebrew/bin'), true)
  // De-duplicated: /usr/local/bin is in both halves and appears once.
  assert.equal(resolved.split(':').filter((d) => d === '/usr/local/bin').length, 1)
})

test('the directories a docker CLI actually installs into are on it', () => {
  const dirs = m.hostPath({ PATH: '' }).split(':')
  // Docker Desktop keeps the real binary here and only symlinks /usr/local/bin;
  // OrbStack and Rancher Desktop ship directories a shell rc file puts on PATH.
  for (const dir of ['.docker/bin', '.orbstack/bin', '.rd/bin'])
    assert.ok(
      dirs.includes(path.join(os.homedir(), dir)),
      `${dir} is where a docker CLI lives and must be searched`
    )
})

test('applying it mutates the process PATH, and is a no-op the second time', () => {
  process.env.PATH = `${BIN}:/usr/bin`
  const first = m.applyHostPath()
  assert.equal(process.env.PATH, first)
  assert.equal(first.startsWith(`${BIN}:/usr/bin:`), true)
  assert.equal(m.applyHostPath(), first, 'idempotent — a repaired PATH repairs to itself')
})

// --- resolving one command --------------------------------------------------

test('a command is resolved to an absolute path, or refused by name', () => {
  const env = { PATH: '/usr/bin:/bin' }
  assert.ok(m.resolveHostCommand('sh', env)?.startsWith('/'), 'a bare name is searched along PATH')
  assert.equal(m.resolveHostCommand('definitely-not-installed-xyz', env), null)
  // A path is checked as a path, never searched.
  assert.equal(m.resolveHostCommand('/bin/sh', env), '/bin/sh')
  assert.equal(m.resolveHostCommand('/bin/definitely-not-there', env), null)
})

// --- the docker preflight ---------------------------------------------------

test('docker is looked up along the search path, off the live process PATH', () => {
  // The lookup runs the way the preflight does — no env argument — so this is
  // the process PATH, and the stub is the docker it must find.
  process.env.PATH = `${BIN}:/nonexistent-launchd-path`
  assert.equal(m.dockerCliPath(), path.join(BIN, 'docker'))
  // Deliberately NOT asserted here: that a PATH without docker resolves to
  // null. The appended directories are searched too and one of them is
  // /usr/bin, so on any machine with docker installed — every CI runner — that
  // lookup correctly finds it. What "docker is nowhere" does to a start is the
  // next test's job, through the preflight's own parameter.
  assert.equal(m.resolveHostCommand('docker-no-runtime-installs-this'), null)
})

test('a missing docker fails the start with a sentence, not `spawn docker ENOENT`', () => {
  assert.doesNotThrow(() => m.assertDockerCli('/usr/local/bin/docker'))
  let message = ''
  try {
    m.assertDockerCli(null)
  } catch (e) {
    message = String(e)
  }
  assert.match(message, /Docker was not found/)
  assert.match(message, /install Docker Desktop/i, 'says what to do about it')
  assert.doesNotMatch(message, /ENOENT/, 'the message it replaces read like an internal error')
})

// --- the daemon preflight ---------------------------------------------------
//
// The second half of the start preflight (docs/requirements-first-run.md §4):
// a `docker` binary with no daemon behind it fails exactly the way a missing
// binary does — every probe underneath swallows spawn errors — so it needs its
// own sentence, and it must not borrow the CLI one's.

test('a dead daemon fails the start with its own sentence, not the CLI one', async () => {
  m.resetDockerDaemonMemo()
  await assert.doesNotReject(() => m.assertDockerDaemon(async () => '27.3.1'))
  m.resetDockerDaemonMemo()
  let message = ''
  try {
    await m.assertDockerDaemon(async () => null)
  } catch (e) {
    message = String(e)
  }
  assert.match(message, /daemon is not responding/)
  assert.match(message, /start Docker Desktop/i, 'says what to do about it')
  assert.doesNotMatch(
    message,
    /was not found on this machine/,
    'a stopped daemon must not read as "install Docker" — different cause, different fix'
  )
})

test('only a yes is memoized: a daemon that stops is not reported as up', async () => {
  m.resetDockerDaemonMemo()
  let calls = 0
  const up = async () => {
    calls++
    return '27.3.1'
  }
  await m.assertDockerDaemon(up)
  await m.assertDockerDaemon(up)
  assert.equal(calls, 1, 'a burst of starts pays for one `docker info`')

  // A negative answer is never cached — a user who has just started Docker
  // Desktop must not have to wait out a stale no.
  m.resetDockerDaemonMemo()
  let downCalls = 0
  const down = async () => {
    downCalls++
    return null
  }
  await assert.rejects(() => m.assertDockerDaemon(down))
  await assert.rejects(() => m.assertDockerDaemon(down))
  assert.equal(downCalls, 2)
})
