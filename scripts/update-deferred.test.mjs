import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const outfile = path.join(os.tmpdir(), `gurt-update-${process.pid}.mjs`)
await bundle({
  stdin: { contents: "export * from './src/main/update.ts'; export { autoUpdater } from 'electron-updater'", resolveDir: process.cwd(), loader: 'ts' }, outfile,
  plugins: [{ name: 'electron-stub', setup(build) {
    build.onResolve({ filter: /^(electron|electron-updater)$/ }, (args) => ({ path: args.path, namespace: 'stub' }))
    build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: args.path === 'electron'
      ? 'export const app = { isPackaged: true }; export const BrowserWindow = { getAllWindows: () => [] }; export const dialog = {};'
      : 'export const autoUpdater = { handlers: {}, installs: 0, on(event, cb) { this.handlers[event] = cb }, checkForUpdates: async () => {}, quitAndInstall() { this.installs++ } };' }))
  } }]
})
const { initAutoUpdater, deferUpdate, updateStatus, autoUpdater } = await import(pathToFileURL(outfile).href)
after(() => fs.rmSync(outfile, { force: true }))
test('deferred update waits for idle, respects cancellation during flush, and installs once', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  initAutoUpdater()
  autoUpdater.handlers['update-downloaded']({ version: '2.0' })
  let busy = true
  let flushes = 0
  let release
  const prepare = () => { flushes++; return new Promise((resolve) => { release = resolve }) }
  deferUpdate(true, () => busy, prepare)
  t.mock.timers.tick(1000)
  assert.equal(flushes, 0)
  busy = false
  t.mock.timers.tick(1000)
  assert.equal(flushes, 1)
  deferUpdate(false, () => busy, prepare)
  release()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(autoUpdater.installs, 0)
  assert.equal(updateStatus().deferred, false)
  deferUpdate(true, () => busy, async () => {})
  t.mock.timers.tick(1000)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(autoUpdater.installs, 1)
  t.mock.timers.tick(5000)
  assert.equal(autoUpdater.installs, 1)
})
