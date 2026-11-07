import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { bundle } from './lib/bundle.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-shutdown-'))
process.env.GURT_ROOT = path.join(root, 'data')
const source = (file) => JSON.stringify(path.resolve(file))
const outfile = path.join(root, 'shutdown.mjs')
await bundle({ stdin: { contents: `
  export { saveBeforeQuit } from ${source('src/main/shutdown.ts')}
  export { createKernel } from ${source('src/main/kernel.ts')}
  export * as store from ${source('src/main/store.ts')}
`, resolveDir: process.cwd(), loader: 'ts' }, outfile })
const { saveBeforeQuit, createKernel, store } = await import(pathToFileURL(outfile).href)
after(() => fs.rmSync(root, { recursive: true, force: true }))

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

class FakeApp extends EventEmitter {
  exits = 0
  exited = deferred()
  quit() {
    let prevented = false
    this.emit('before-quit', { preventDefault() { prevented = true } })
    if (!prevented) { this.exits++; this.exited.resolve() }
  }
}

test('repeated quit requests wait for one save and allow the final quit', async () => {
  const app = new FakeApp()
  const gate = deferred()
  let saves = 0
  saveBeforeQuit(app, async () => { saves++; await gate.promise }, (error) => { throw error })
  app.quit()
  app.quit()
  await Promise.resolve()
  assert.equal(saves, 1)
  assert.equal(app.exits, 0)
  gate.resolve()
  await app.exited.promise
  assert.equal(app.exits, 1)
})

test('failed persistence keeps the app open and permits a later retry', async () => {
  const app = new FakeApp()
  const failed = deferred()
  let attempts = 0
  saveBeforeQuit(app, async () => { if (++attempts === 1) throw new Error('disk full') }, (error) => failed.resolve(error))
  app.quit()
  assert.match((await failed.promise).message, /disk full/)
  assert.equal(app.exits, 0)
  app.quit()
  await app.exited.promise
  assert.equal(attempts, 2)
  assert.equal(app.exits, 1)
})

test('a quit cancelled by a window does not bypass saving on the next attempt', async () => {
  const app = new FakeApp()
  let saves = 0
  saveBeforeQuit(app, async () => { saves++ }, (error) => { throw error })
  app.quit()
  await app.exited.promise
  // Model a window refusing to close after before-quit was allowed.
  app.exited = deferred()
  app.quit()
  await app.exited.promise
  assert.equal(saves, 2)
})

test('quitting immediately after draft edits flushes the actual session store before exit', async () => {
  fs.mkdirSync(path.join(process.env.GURT_ROOT, 'personal', 'demo-task'), { recursive: true })
  fs.writeFileSync(path.join(process.env.GURT_ROOT, 'personal', 'workspace.json'), JSON.stringify({ repos: [], envs: [] }))
  fs.writeFileSync(path.join(process.env.GURT_ROOT, 'personal', 'demo-task', 'task.json'), '{}')
  const kernel = createKernel()
  await kernel.ready
  try {
    const info = kernel.sessions.createSession({ workspace: 'personal', task: 'demo-task', env: 'dev' }, [], 'agent', '', 'draft')
    kernel.sessions.editPrompt(info.id, 'say hello')
    kernel.sessions.editDraft(info.id, { configValues: { model: 'chosen-model' } })
    const app = new FakeApp()
    saveBeforeQuit(app, () => kernel.sessions.flushForRestart(), (error) => { throw error })
    app.quit()
    await app.exited.promise
    const records = await store.readSessions('personal', 'demo-task')
    assert.equal(records.length, 1)
    assert.equal(records[0].info.id, info.id)
    assert.equal(records[0].info.startPrompt, 'say hello')
    assert.equal(records[0].info.env, 'dev')
    assert.equal(records[0].info.configValues.model, 'chosen-model')
  } finally { kernel.sessions.dropTaskSessions('personal', 'demo-task') }
})
