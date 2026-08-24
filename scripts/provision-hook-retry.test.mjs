// A create-time lifecycle hook (`postCreateCommand: npm install`, typically)
// that fails leaves a container the next `up` would adopt by id-label —
// skipping the hooks it "already ran" and reporting success against a workspace
// whose install never finished. That is the "it fails on the first start and
// works on the second" report; the second start was the broken one.
//
// `devcontainerUp` (src/main/provision.ts) must therefore remove the container
// a failed create-time hook leaves behind, retry once in a fresh one, and — if
// that fails too — say which hook failed and quote its output.
//
//   node scripts/provision-hook-retry.test.mjs
import { test, after } from 'node:test'
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-hook-retry-'))
process.env.GURT_ROOT = path.join(tmp, 'gurt') // store.ts reads this at import time

// The devcontainer CLI and `docker` are both stubbed, so this test needs no
// Docker daemon. `runNodeCli` resolves the CLI through `require.resolve` from
// the bundle's own directory, so the stub goes in a node_modules next to it;
// `dockerRemove` spawns plain `docker`, so that stub goes on PATH.
const cliDir = path.join(tmp, 'node_modules', '@devcontainers', 'cli')
fs.mkdirSync(cliDir, { recursive: true })
fs.writeFileSync(
  path.join(cliDir, 'package.json'),
  JSON.stringify({ name: '@devcontainers/cli', version: '0.0.0-stub', main: 'devcontainer.js' })
)
// Fails its postCreateCommand on the first FAKE_FAILURES invocations, exactly
// the way the real CLI reports it: hook output on stderr, one JSON result line
// on stdout naming the container it left behind.
fs.writeFileSync(
  path.join(cliDir, 'devcontainer.js'),
  `const fs = require('fs')
const state = process.env.FAKE_STATE
const runs = JSON.parse(fs.readFileSync(state, 'utf8'))
runs.push(process.argv.slice(2))
fs.writeFileSync(state, JSON.stringify(runs))
const n = runs.length
console.error('[stub] #7 exporting to image')
console.error('[stub] Running the postCreateCommand from devcontainer.json...')
if (n <= Number(process.env.FAKE_FAILURES)) {
  console.error('[stub] npm error code ECONNRESET')
  console.error('[stub] npm error network request to https://registry.npmjs.org/react failed')
  console.error('Error: Command failed: /bin/sh -c npm install')
  console.error('    at Q (/stub/devContainersSpecCLI.js:1:1)')
  console.log(JSON.stringify({
    outcome: 'error',
    message: 'Command failed: /bin/sh -c npm install',
    description: process.env.FAKE_DESCRIPTION ?? 'postCreateCommand from devcontainer.json failed.',
    ...(process.env.FAKE_NO_CONTAINER ? {} : { containerId: 'container-' + n })
  }))
  process.exit(1)
}
console.log(JSON.stringify({ outcome: 'success', containerId: 'container-' + n, remoteWorkspaceFolder: '/workspaces/repo' }))
`
)
const bin = path.join(tmp, 'bin')
fs.mkdirSync(bin)
const dockerLog = path.join(tmp, 'docker.log')
fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(dockerLog)}\n`)
fs.chmodSync(path.join(bin, 'docker'), 0o755)
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`

const outfile = path.join(tmp, 'entry.mjs')
await build({
  stdin: {
    contents: `export { devcontainerUp, hookOutputTail } from ${JSON.stringify(path.join(ROOT, 'src/main/provision.ts'))}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  mainFields: ['module', 'main'],
  // Resolved at run time from `outfile`'s directory — i.e. the stub above.
  external: ['@devcontainers/cli'],
  outfile,
  logLevel: 'silent'
})

const workspace = path.join(tmp, 'workspace')
fs.mkdirSync(workspace)

/** One `devcontainerUp` against the stub, with its own invocation record. */
async function up(m, failures, extraEnv = {}) {
  const state = path.join(tmp, `runs-${Math.random().toString(36).slice(2)}.json`)
  fs.writeFileSync(state, '[]')
  fs.writeFileSync(dockerLog, '')
  process.env.FAKE_STATE = state
  process.env.FAKE_FAILURES = String(failures)
  delete process.env.FAKE_DESCRIPTION
  delete process.env.FAKE_NO_CONTAINER
  Object.assign(process.env, extraEnv)
  const log = []
  const result = await m
    .devcontainerUp('s1', [], workspace, (l) => log.push(l), 'repo', null, undefined, [])
    .then((r) => ({ ok: r }), (e) => ({ err: e }))
  return {
    ...result,
    log,
    attempts: JSON.parse(fs.readFileSync(state, 'utf8')).length,
    removed: fs.readFileSync(dockerLog, 'utf8').trim().split('\n').filter(Boolean)
  }
}

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const m = await import(pathToFileURL(outfile).href)

// 1. The transient case — the hook fails once, then succeeds. `up` must run a
//    second time *in a fresh container*, not adopt the one it just failed in.
test('a failed create-time hook is retried in a fresh container, never adopted', async () => {
  const once = await up(m, 1)
  assert.equal(once.err, undefined, `a hook that fails once must not fail the start: ${once.err?.message}`)
  assert.equal(once.attempts, 2, 'the CLI is invoked again after a create-time hook failure')
  assert.equal(once.ok.containerId, 'container-2', 'the start returns the retry container, not the failed one')
  assert.deepEqual(once.removed, ['rm -f container-1'], 'the half-provisioned container is removed before the retry')
})

// 2. The persistent case — one retry, then a message that names the hook and
//    quotes its output. The CLI's own `message` is only the shell line.
test('a hook that keeps failing names the hook and quotes its output', async () => {
  const always = await up(m, 99)
  assert.ok(always.err, 'a hook failing twice fails the start')
  assert.equal(always.attempts, 2, 'a create-time hook is retried exactly once')
  assert.deepEqual(
    always.removed,
    ['rm -f container-1', 'rm -f container-2'],
    'no half-provisioned container survives, not even the last one'
  )
  const msg = always.err.message
  assert.ok(msg.includes('postCreateCommand from devcontainer.json failed.'), `names the hook: ${msg}`)
  assert.ok(msg.includes('Command failed: /bin/sh -c npm install'), `keeps the CLI's own message: ${msg}`)
  assert.ok(msg.includes('retried 2×'), `says it already retried: ${msg}`)
  assert.ok(msg.includes('npm error code ECONNRESET'), `quotes the reason the hook itself gave: ${msg}`)
  assert.ok(!msg.includes('exporting to image'), `does not quote the build that succeeded: ${msg}`)
  assert.ok(!msg.includes('    at Q ('), `does not quote CLI stack frames: ${msg}`)
})

// 3. Failures that are not a create-time hook are untouched: one attempt, the
//    CLI's message, and nothing removed (there may be no container at all).
test('a non-hook failure is not retried', async () => {
  const other = await up(m, 99, {
    FAKE_DESCRIPTION: 'Error: Could not resolve image',
    FAKE_NO_CONTAINER: '1'
  })
  assert.ok(other.err, 'a non-hook failure still fails')
  assert.equal(other.attempts, 1, 'a non-hook failure is not retried')
  assert.deepEqual(other.removed, [], 'a non-hook failure removes nothing')
  assert.equal(other.err.message, 'Command failed: /bin/sh -c npm install')
})

// 4. `hookOutputTail` keeps the hook's own output and drops the noise around
//    it — everything before the last lifecycle banner belongs to the build.
test('hookOutputTail keeps the hook output and drops the build noise', () => {
  const tail = m.hookOutputTail([
    '#5 [2/3] RUN apt-get install -y curl',
    'Running the postCreateCommand from devcontainer.json...',
    'npm error code EACCES',
    '    at Q (/x.js:1:1)',
    'Error: Command failed: /bin/sh -c npm install',
    '{"outcome":"error"}'
  ])
  assert.deepEqual(tail, [
    'Running the postCreateCommand from devcontainer.json...',
    'npm error code EACCES'
  ])
})
