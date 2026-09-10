// `~/.gurt` is itself a git repository (`store.ensureJournalRepo`, for the
// config journal), and a mounted/read-only session's `--workspace-folder` is
// an empty wrapper dir staged underneath it
// (`store.mountedWorkspaceDir` → `~/.gurt/<ws>/<task>/.multirepo/<session>/repos`).
// The devcontainer CLI's own default, when `workspaceFolder` sits inside a git
// working tree, is to resolve `git rev-parse --show-toplevel` from it and
// mount *that* instead — which for the wrapper case is `~/.gurt` itself,
// credentials.json included. `devcontainerUp` (src/main/provision.ts) must
// pass `--mount-workspace-git-root=false` on every `up` so the CLI mounts
// exactly the folder it was given, never a git ancestor of it.
//
// The spelling matters: the CLI's yargs parser has `boolean-negation` off, so
// `--no-mount-workspace-git-root` is an *unknown argument* and `up` exits 1
// without starting anything. The stub CLI below accepts any argv, so a second
// test replays the recorded argv through the real bundled CLI and asserts its
// parser accepts it.
//
//   node scripts/mount-workspace-git-root.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-mount-git-root-'))
process.env.GURT_ROOT = path.join(tmp, 'gurt')

const cliDir = path.join(tmp, 'node_modules', '@devcontainers', 'cli')
fs.mkdirSync(cliDir, { recursive: true })
fs.writeFileSync(
  path.join(cliDir, 'package.json'),
  JSON.stringify({ name: '@devcontainers/cli', version: '0.0.0-stub', main: 'devcontainer.js' })
)
// Records the exact argv it was invoked with, then reports success.
fs.writeFileSync(
  path.join(cliDir, 'devcontainer.js'),
  `const fs = require('fs')
fs.writeFileSync(process.env.FAKE_STATE, JSON.stringify(process.argv.slice(2)))
console.log(JSON.stringify({ outcome: 'success', containerId: 'container-1', remoteWorkspaceFolder: '/workspaces/repo' }))
`
)
const bin = path.join(tmp, 'bin')
fs.mkdirSync(bin)
fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\ntrue\n`)
fs.chmodSync(path.join(bin, 'docker'), 0o755)
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`

const outfile = path.join(tmp, 'entry.mjs')
await bundle({
  stdin: {
    contents: `export { devcontainerUp } from ${JSON.stringify(path.join(ROOT, 'src/main/provision.ts'))}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  external: ['@devcontainers/cli'],
  outfile
})

const workspace = path.join(tmp, 'workspace')
fs.mkdirSync(workspace)
const state = path.join(tmp, 'run.json')
process.env.FAKE_STATE = state

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const m = await import(pathToFileURL(outfile).href)

test('devcontainer up always disables mounting the workspace folder\'s git root', async () => {
  await m.devcontainerUp('s1', [], workspace, () => {}, 'repo', null, undefined, [])
  const argv = JSON.parse(fs.readFileSync(state, 'utf8'))
  assert.ok(
    argv.includes('--mount-workspace-git-root=false'),
    `expected --mount-workspace-git-root=false in CLI invocation, got: ${argv.join(' ')}`
  )
})

test('the real devcontainer CLI accepts every flag devcontainerUp passes', async () => {
  await m.devcontainerUp('s1', [], workspace, () => {}, 'repo', null, undefined, [])
  const argv = JSON.parse(fs.readFileSync(state, 'utf8'))
  // Point the workspace at a folder with no devcontainer.json: the CLI parses
  // argv first, so an unknown flag surfaces as `Unknown arguments: …` and exit
  // 1 before it ever looks for the config, while a fully-parsed argv fails
  // later with a JSON `{"outcome":"error"}` about the missing config. Either
  // way nothing touches Docker.
  const missing = path.join(tmp, 'no-such-workspace')
  const replayed = argv.map((a) => (a === workspace ? missing : a))
  const realCli = path.join(ROOT, 'node_modules', '@devcontainers', 'cli', 'devcontainer.js')
  const r = spawnSync(process.execPath, [realCli, ...replayed], { encoding: 'utf8' })
  const out = r.stdout + r.stderr
  assert.ok(
    !/Unknown arguments?:/.test(out),
    `real CLI rejected gurt's argv (${replayed.join(' ')}):\n${out}`
  )
  assert.match(out, /"outcome":"error"/, `expected the CLI to get as far as config lookup:\n${out}`)
})
