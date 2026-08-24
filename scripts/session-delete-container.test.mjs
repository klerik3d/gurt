// Deleting a session destroys the container it owns (no daemon, no agent).
//
// The container manager finds a container by looking the session up in the
// session map, so the teardown has to run *before* the record is dropped — a
// session forgotten first leaves its container behind until the next boot
// reconcile reaps it as an orphan.
//
// Docker is a shim on PATH: `ps` fails, so the boot reconcile reads the daemon
// as unreachable and leaves the staged container record alone; everything else
// succeeds and is recorded, which is how the `rm` is observed.
//
//   node scripts/session-delete-container.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// GURT_ROOT must be set before the store module loads (read at import time).
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-del-container-'))
process.env.GURT_ROOT = GURT_ROOT

// A fake `docker`, ahead of the real one on PATH.
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-del-bin-'))
const CALLS = path.join(BIN, 'calls.log')
fs.writeFileSync(
  path.join(BIN, 'docker'),
  `#!/bin/sh
echo "$@" >> "$DOCKER_CALLS"
case "$1" in
  ps) exit 1 ;;
  *) exit 0 ;;
esac
`,
  { mode: 0o755 }
)
process.env.DOCKER_CALLS = CALLS
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`

const outfile = path.join(os.tmpdir(), `gurt-del-container-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await bundle({
  stdin: {
    contents: `export { createKernel } from ${S('src/main/kernel.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})

const { createKernel } = await import(pathToFileURL(outfile).href)

/** Wait for a recorded docker invocation matching `re`. */
async function waitForCall(re) {
  for (let i = 0; i < 200; i++) {
    const calls = fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8') : ''
    if (calls.split('\n').some((line) => re.test(line.trim()))) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return false
}

after(() => {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(BIN, { recursive: true, force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

const ws = 'w'
const task = 't'
fs.mkdirSync(path.join(GURT_ROOT, ws, task), { recursive: true })
fs.writeFileSync(
  path.join(GURT_ROOT, ws, 'workspace.json'),
  JSON.stringify({
    repos: [{ name: 'alpha', url: 'https://github.com/o/alpha.git' }],
    envs: [{ name: 'dev', devcontainer: '{"image":"x"}', repo: 'alpha' }]
  })
)
fs.writeFileSync(path.join(GURT_ROOT, ws, task, 'task.json'), JSON.stringify({}))
fs.writeFileSync(path.join(GURT_ROOT, ws, 'agents.json'), JSON.stringify({}))

const kernel = createKernel()
const ref = { workspace: ws, task, env: 'dev' }
const info = kernel.sessions.createSession(ref, ['alpha'], 'a1', 'hi', 'none')

// Stage a live container the same way the container manager would.
kernel.sessions.patchContainer(info.id, {
  status: 'running',
  id: 'container-a',
  remoteWorkspaceFolder: '/app',
  repos: ['alpha']
})

// The scratch dir a mounted session's repos are staged in (`.multirepo/<id>`)
// — gurt's own, and ownerless once the session is gone.
const scratch = path.join(GURT_ROOT, ws, task, '.multirepo', info.id, 'repos')

test('session delete takes its container down', async () => {
  assert.equal(
    kernel.sessions.snapshot(info.id).info.container?.id,
    'container-a',
    'the staged container survives the boot reconcile'
  )
  fs.mkdirSync(scratch, { recursive: true })

  kernel.sessions.deleteSession(info.id)

  assert.ok(
    await waitForCall(/^rm -f container-a$/),
    'deleting the session removes its container'
  )
  assert.equal(kernel.sessions.snapshot(info.id), undefined, 'the session itself is gone')
})

test('session delete removes its mount scratch', async () => {
  // Only after the container is down — the mounts live inside that directory.
  for (let i = 0; i < 200 && fs.existsSync(scratch); i++)
    await new Promise((r) => setTimeout(r, 25))
  assert.ok(
    !fs.existsSync(path.join(GURT_ROOT, ws, task, '.multirepo', info.id)),
    'the mount scratch dir goes with the session'
  )
})
