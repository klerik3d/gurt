import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { bundle } from './lib/bundle.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-container-terminal-'))
process.env.GURT_ROOT = root
const outfile = path.join(root, 'terminal.mjs')
// The bundled CLI resolver uses createRequire(import.meta.url).
fs.symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir')
const source = (file) => JSON.stringify(path.resolve(file))
await bundle({
  stdin: {
    contents: `
      export { terminalShellCommand } from ${source('src/main/terminal.ts')}
      export { ContainerManager } from ${source('src/main/containers.ts')}
      export { containerTerminalCommand, sessionConfigPath } from ${source('src/main/provision.ts')}
      export { cloneDir, mountedWorkspaceDir, sessionScratchDir, overrideConfigPath } from ${source('src/main/store.ts')}
    `,
    resolveDir: process.cwd(), loader: 'ts'
  },
  outfile
})
const m = await import(pathToFileURL(outfile).href)
after(() => fs.rmSync(root, { recursive: true, force: true }))

test('terminal shell quoting preserves paths and treats shell syntax as data', async () => {
  const marker = path.join(root, 'must-not-exist')
  const args = [
    "a directory/with 'quotes'", 'double "quotes"', '', 'line\nbreak',
    `$(touch ${marker})`, '`exit 1`', '$HOME; exit 1', 'back\\slash'
  ]
  const command = m.terminalShellCommand(process.execPath, [
    '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...args
  ])
  const { stdout } = await promisify(execFile)('/bin/sh', ['-c', command])
  assert.deepEqual(JSON.parse(stdout), args)
  assert.equal(fs.existsSync(marker), false)
})

test('container terminal addresses the exact container with its workspace and config', () => {
  const command = m.containerTerminalCommand('container-a', ['--override-config', '/config with spaces.json'], '/workspace a')
  const args = command.args
  assert.equal(command.cmd, '/usr/bin/env')
  assert.equal(args[0], 'ELECTRON_RUN_AS_NODE=1')
  assert.equal(args[2], process.execPath)
  assert.deepEqual(args.slice(4), [
    'exec', '--container-id', 'container-a', '--workspace-folder', '/workspace a',
    '--mount-workspace-git-root=false', '--override-config', '/config with spaces.json',
    '/bin/sh', '-c', 'exec "${SHELL:-/bin/sh}" -l'
  ])
})

test('session terminal launches a system window for single-repo, mounted and repo-less sessions', {
  skip: process.platform !== 'linux'
}, async () => {
  const bin = path.join(root, 'bin')
  const capture = path.join(root, 'terminal-args.json')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'gnome-terminal'), `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)))
`, { mode: 0o755 })
  const oldPath = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`
  try {
    for (const { id, repos, role, merged } of [
      { id: 'single', repos: ['repo'], role: 'executor', merged: false },
      { id: 'history', repos: ['repo'], role: 'executor', merged: true },
      { id: 'multi', repos: ['a', 'b'], role: 'executor', merged: true },
      { id: 'operator', repos: [], role: 'operator', merged: false }
    ]) {
      const info = {
        id, workspace: 'ws', task: 'task', env: 'dev', repos, role,
        container: { status: 'running', id: `container-${id}`, remoteWorkspaceFolder: '/work' }
      }
      const manager = new m.ContainerManager({ session: () => info })
      const config = merged
        ? m.sessionConfigPath(m.sessionScratchDir('ws', 'task', id))
        : m.overrideConfigPath('ws', 'dev')
      if (merged) {
        fs.mkdirSync(path.dirname(config), { recursive: true })
        fs.writeFileSync(config, '{}')
      }
      fs.rmSync(capture, { force: true })
      await manager.openTerminal(id)
      const deadline = Date.now() + 3000
      while (!fs.existsSync(capture) && Date.now() < deadline) await delay(10)
      assert.ok(fs.existsSync(capture), 'the terminal emulator was launched')
      const args = JSON.parse(fs.readFileSync(capture, 'utf8'))
      assert.equal(args[0], '--')
      assert.equal(args[1], '/usr/bin/env')
      assert.equal(args[args.indexOf('--container-id') + 1], `container-${id}`)
      assert.equal(args[args.indexOf('--override-config') + 1], config)
      const workspace = repos.length === 1
        ? m.cloneDir('ws', 'task', repos[0])
        : m.mountedWorkspaceDir('ws', 'task', id)
      assert.equal(args[args.indexOf('--workspace-folder') + 1], workspace)
    }
  } finally {
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
  }
})
