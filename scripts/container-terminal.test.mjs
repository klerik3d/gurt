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
const source = (file) => JSON.stringify(path.resolve(file))
await bundle({
  stdin: {
    contents: `
      export { terminalShellCommand } from ${source('src/main/terminal.ts')}
      export { ContainerManager } from ${source('src/main/containers.ts')}
      export { containerTerminalCommand } from ${source('src/main/provision.ts')}
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

test('container terminal addresses the exact container as the agent’s user, cwd and PATH', () => {
  const command = m.containerTerminalCommand({
    containerId: 'container-a', user: 'dev', cwd: '/workspace a', path: '/p/bin:/opt/gurt/node/bin'
  })
  const args = command.args
  assert.equal(command.cmd, '/usr/bin/env')
  assert.match(args[0], /^PATH=/)
  assert.deepEqual(args.slice(1, 12), [
    'docker', 'exec', '-i', '-t', '-u', 'dev', '-w', '/workspace a',
    '-e', 'PATH=/p/bin:/opt/gurt/node/bin', 'container-a'
  ])
  assert.deepEqual(args.slice(12, 14), ['sh', '-c'])
  assert.match(args[14], /exec "\$sh_" -l$/, 'the user’s login shell, interactive')
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
    for (const { id, repos, role } of [
      { id: 'single', repos: ['repo'], role: 'executor' },
      { id: 'history', repos: ['repo'], role: 'executor' },
      { id: 'multi', repos: ['a', 'b'], role: 'executor' },
      { id: 'operator', repos: [], role: 'operator' }
    ]) {
      const info = {
        id, workspace: 'ws', task: 'task', env: 'dev', repos, role,
        container: {
          status: 'running', id: `container-${id}`, remoteWorkspaceFolder: '/workspaces',
          user: `user-${id}`, path: `/path-${id}`
        }
      }
      const manager = new m.ContainerManager({ session: () => info })
      fs.rmSync(capture, { force: true })
      await manager.openTerminal(id)
      const deadline = Date.now() + 3000
      while (!fs.existsSync(capture) && Date.now() < deadline) await delay(10)
      assert.ok(fs.existsSync(capture), 'the terminal emulator was launched')
      const args = JSON.parse(fs.readFileSync(capture, 'utf8'))
      assert.equal(args[0], '--')
      assert.equal(args[1], '/usr/bin/env')
      assert.equal(args[args.indexOf('docker') + 1], 'exec')
      // everything comes from the session's record — nothing resolved on the host
      assert.equal(args[args.indexOf('-u') + 1], `user-${id}`)
      assert.equal(args[args.indexOf('-w') + 1], '/workspaces')
      assert.ok(args.includes(`PATH=/path-${id}`))
      assert.equal(args[args.indexOf(`PATH=/path-${id}`) + 1], `container-${id}`)
    }
    // a container that is not running (or not recorded) is refused
    const stopped = { id: 'x', workspace: 'ws', task: 'task', env: 'dev', repos: [], container: { status: 'stopped', id: 'c', remoteWorkspaceFolder: '/w' } }
    assert.throws(() => new m.ContainerManager({ session: () => stopped }).openTerminal('x'), /not running/)
  } finally {
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
  }
})
