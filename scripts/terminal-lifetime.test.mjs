import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { bundle } from './lib/bundle.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-terminal-'))
process.env.GURT_ROOT = root
const outfile = path.join(root, 'terminals.mjs')
await bundle({ entryPoints: ['src/main/terminals.ts'], external: ['node-pty'], outfile })
const { TerminalManager } = await import(pathToFileURL(outfile).href)
for (const ws of ['one', 'two'])
  for (const task of ['alpha', 'beta']) {
    const dir = path.join(root, ws, task)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'task.json'), '{}')
  }
after(() => fs.rmSync(root, { recursive: true, force: true }))

function fixture(loader) {
  const ptys = []
  const outputs = []
  const updates = []
  const spawn = (_shell, _args, options) => {
    const dataHandlers = new Set()
    const exitHandlers = new Set()
    const pty = {
      options, writes: [], sizes: [], killed: false,
      onData(fn) { dataHandlers.add(fn); return { dispose: () => dataHandlers.delete(fn) } },
      onExit(fn) { exitHandlers.add(fn); return { dispose: () => exitHandlers.delete(fn) } },
      write(data) { this.writes.push(data) },
      resize(cols, rows) { this.sizes.push([cols, rows]) },
      kill() { this.killed = true },
      data(data) { for (const fn of dataHandlers) fn(data) },
      exit(exitCode) { for (const fn of exitHandlers) fn({ exitCode }) }
    }
    ptys.push(pty)
    return pty
  }
  const manager = new TerminalManager(
    (sessions) => updates.push(sessions), (event) => outputs.push(event),
    loader ? () => loader(spawn) : async () => spawn
  )
  return { manager, ptys, outputs, updates }
}

test('switching scopes and repeated opens reuse the same live shell and screen output', async () => {
  const { manager, ptys, outputs } = fixture()
  const [a, same] = await Promise.all([manager.ensure('one', 'alpha'), manager.ensure('one', 'alpha')])
  assert.equal(a.id, same.id)
  assert.equal(ptys.length, 1)
  assert.equal(ptys[0].options.cwd, path.join(root, 'one', 'alpha'))
  manager.write(a.id, 'export KEEP=present\r')
  ptys[0].data('\x1b[32mkept\x1b[0m')
  const b = await manager.ensure('two', 'alpha')
  const again = await manager.ensure('one', 'alpha')
  assert.equal(again.id, a.id)
  assert.notEqual(b.id, a.id)
  assert.equal(ptys[0].killed, false)
  assert.equal(manager.snapshot(a.id).data, '\x1b[32mkept\x1b[0m')
  assert.equal(manager.snapshot(a.id).sequence, outputs[0].sequence)
  manager.resize(a.id, 100, 30)
  assert.deepEqual(ptys[0].sizes, [[100, 30]])
  assert.equal(manager.snapshot(a.id).info.cols, 100)
  manager.dispose()
  assert.ok(ptys.every((p) => p.killed))
})

test('multiple terminals, shell exit and explicit close have separate lifetimes', async () => {
  const { manager, ptys } = fixture()
  const a = await manager.create('one', 'alpha')
  const b = await manager.create('one', 'alpha')
  ptys[0].data('last output')
  ptys[0].exit(7)
  manager.write(a.id, 'ignored')
  assert.deepEqual(ptys[0].writes, [])
  assert.equal(manager.snapshot(a.id).info.exitCode, 7)
  assert.equal(manager.snapshot(a.id).data, 'last output')
  manager.close(a.id)
  assert.deepEqual(manager.list().map((s) => s.id), [b.id])
  manager.close(b.id)
  assert.equal(ptys[1].killed, true)
  const next = await manager.ensure('one', 'alpha')
  assert.notEqual(next.id, b.id)
  manager.dispose()
})

test('scope and workspace deletion dispose only their terminals and remove all replay data', async () => {
  const { manager, ptys, outputs } = fixture()
  const a = await manager.create('one', 'alpha')
  await manager.create('one', 'beta')
  const other = await manager.create('two', 'alpha')
  manager.dropScope('one', 'alpha')
  assert.equal(ptys[0].killed, true)
  assert.equal(ptys[1].killed, false)
  assert.throws(() => manager.snapshot(a.id), /no longer exists/)
  ptys[0].data('late output')
  assert.equal(outputs.length, 0)
  manager.dropScope('one')
  assert.equal(ptys[1].killed, true)
  assert.deepEqual(manager.list().map((s) => s.id), [other.id])
  manager.dispose()
})

test('a pending spawn cannot resurrect a deleted/recreated scope', async () => {
  let release
  const { manager, ptys } = fixture((spawn) => new Promise((resolve) => { release = () => resolve(spawn) }))
  const creation = manager.ensure('one', 'alpha')
  const rejected = assert.rejects(creation, /scope changed/)
  await manager.withScopeBlocked('one', 'alpha', async () => {
    await assert.rejects(manager.create('one', 'alpha'), /being removed/)
    manager.dropScope('one', 'alpha')
  })
  release()
  await rejected
  assert.equal(ptys.length, 0)
  manager.dispose()
})

test('renaming keeps the same session; quitting cancels in-flight spawns', async () => {
  const { manager, ptys } = fixture()
  const a = await manager.create('one', 'alpha')
  manager.renameScope('one', 'alpha', 'beta')
  assert.equal((await manager.ensure('one', 'beta')).id, a.id)
  manager.dropScope('one', 'alpha')
  assert.equal(ptys[0].killed, false)
  manager.dropScope('one', 'beta')
  assert.equal(ptys[0].killed, true)
  let release
  const pending = fixture((spawn) => new Promise((resolve) => { release = () => resolve(spawn) }))
  const creation = pending.manager.create('one', 'alpha')
  const rejected = assert.rejects(creation, /being removed/)
  pending.manager.dispose()
  release()
  await rejected
  assert.equal(pending.ptys.length, 0)
  manager.dispose()
})

test('untrusted scope paths, dimensions and input are rejected; replay memory is bounded', async () => {
  const { manager, ptys } = fixture()
  await assert.rejects(manager.create('../one', 'alpha'), /Invalid/)
  await assert.rejects(manager.create('one', '../alpha'), /Invalid/)
  await assert.rejects(manager.create('one', 'missing'), /no longer exists/)
  const a = await manager.create('one', 'alpha')
  assert.throws(() => manager.resize(a.id, 0, 24), /Invalid/)
  assert.throws(() => manager.resize(a.id, NaN, 24), /Invalid/)
  assert.throws(() => manager.write(a.id, null), /Invalid/)
  ptys[0].data('a'.repeat(2 * 1024 * 1024))
  assert.ok(manager.snapshot(a.id).data.length <= 1024 * 1024)
  manager.dispose()
  assert.equal(manager.list().length, 0)
})


test('terminal names are stable, editable, scoped and discarded with their scope', async () => {
  const { manager, ptys, updates } = fixture()
  const a = await manager.create('one', 'alpha')
  const b = await manager.create('one', 'alpha')
  assert.equal(a.title, 'Terminal 1')
  assert.equal(b.title, 'Terminal 2')
  manager.rename(a.id, '  Server  ')
  assert.equal(manager.snapshot(a.id).info.title, 'Server')
  assert.equal(updates.at(-1)[0].title, 'Server')
  assert.equal(ptys.length, 2, 'renaming must not restart the shell')
  for (const title of ['', '   ', 'a'.repeat(81), 'line\nbreak', '\x1b[31m', null])
    assert.throws(() => manager.rename(a.id, title), /Terminal name/)
  assert.equal(manager.snapshot(a.id).info.title, 'Server')
  manager.close(a.id)
  assert.equal(manager.snapshot(b.id).info.title, 'Terminal 2')
  assert.equal((await manager.create('one', 'alpha')).title, 'Terminal 3')
  assert.equal((await manager.create('two', 'alpha')).title, 'Terminal 1')
  manager.renameScope('one', 'alpha', 'beta')
  assert.equal((await manager.create('one', 'beta')).title, 'Terminal 4')
  manager.dropScope('one', 'beta')
  assert.equal((await manager.create('one', 'beta')).title, 'Terminal 1')
  manager.dispose()
})


test('shell startup does not inherit the launching terminal identity or session', async () => {
  const values = {
    TERM_PROGRAM: 'Apple_Terminal', TERM_PROGRAM_VERSION: 'parent-version',
    TERM_SESSION_ID: 'parent-session', ITERM_SESSION_ID: 'parent-iterm', ELECTRON_RUN_AS_NODE: '1'
  }
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  Object.assign(process.env, values)
  const { manager, ptys } = fixture()
  try {
    await manager.create('one', 'alpha')
    assert.equal(ptys[0].options.env.TERM_PROGRAM, 'gurt')
    for (const key of Object.keys(values).filter((key) => key !== 'TERM_PROGRAM'))
      assert.equal(ptys[0].options.env[key], undefined)
  } finally {
    manager.dispose()
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
