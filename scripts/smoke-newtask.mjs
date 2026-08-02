import { createRequire } from 'node:module'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SHOT_DIR = path.join(process.env.SCRATCH ?? '/tmp/gurt-smoke-newtask', 'shots')
const GURT_ROOT = path.join(process.env.SCRATCH ?? '/tmp/gurt-smoke-newtask', 'gurt-root')
fs.rmSync(GURT_ROOT, { recursive: true, force: true })
fs.mkdirSync(SHOT_DIR, { recursive: true })
fs.mkdirSync(GURT_ROOT, { recursive: true })

const require = createRequire(path.join(APP_DIR, 'package.json'))
const { _electron } = require('playwright-core')
const electronPath = require('electron')

const env = { ...process.env, GURT_ROOT, DISPLAY: process.env.DISPLAY ?? ':99' }
delete env.ELECTRON_RUN_AS_NODE

const app = await _electron.launch({
  executablePath: electronPath,
  args: [APP_DIR, '--no-sandbox'],
  env,
  timeout: 30000
})

const page = await app.firstWindow()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))

await page.waitForSelector('.sidebar', { timeout: 15000 })

// New workspace, so there's somewhere to create a task.
await page.click('.sb-ws-btn')
await page.click('text=+ new workspace')
await page.waitForSelector('.modal input')
await page.fill('.modal input', 'acme')
await page.click('.modal .btn-primary')
await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 })
await page.waitForSelector('.sb-ws-name:has-text("acme")', { timeout: 5000 })
console.log('workspace created OK')

// The fix under test: header "+" opens an inline popover, not a modal — one
// click + Enter, no second "Create" click, and no modal at all.
await page.click('button[title="New task · ⌘⇧N"]')
await page.waitForSelector('.sb-newtask-menu input', { timeout: 5000 })
assert.equal(await page.locator('.modal').count(), 0, 'no modal opened for inline task creation')
await page.fill('.sb-newtask-menu input', 'first-task')
await page.press('.sb-newtask-menu input', 'Enter')
await page.waitForSelector('.sb-newtask-menu', { state: 'detached', timeout: 5000 })
await page.waitForSelector('.sb-task-name:has-text("first-task")', { timeout: 5000 })
console.log('task created inline OK, no modal round-trip')

// The bug under test: this must create a TASK, never a session. Confirm the
// task has zero sessions (the empty-state hint is the give-away if one leaked in).
await page.waitForSelector('.sb-empty:has-text("no sessions")', { timeout: 5000 })
assert.equal(await page.locator('.sb-session').count(), 0, 'no stray session was created alongside the task')
await page.screenshot({ path: path.join(SHOT_DIR, '01-task-created.png') })
console.log('confirmed: task created, no session leaked in')

// A second task, to confirm the popover isn't confused with the per-row
// "new session" button — and that the two are now visually distinct (message
// icon vs plus icon) rather than two identical plus buttons.
await page.click('button[title="New task · ⌘⇧N"]')
await page.fill('.sb-newtask-menu input', 'second-task')
await page.press('.sb-newtask-menu input', 'Enter')
await page.waitForSelector('.sb-task-name:has-text("second-task")', { timeout: 5000 })
assert.equal(await page.locator('.sb-task').count(), 2, 'two independent tasks exist')
assert.equal(await page.locator('.sb-session').count(), 0, 'still no sessions after a second task')
console.log('second task created independently OK')

// The per-task "new session" button is now a distinct message icon, not a
// second identical plus — click it and confirm the New Session modal (not
// another task) is what opens. It's only visible on row hover.
await page.hover('.sb-task >> nth=0')
await page.click('.sb-task .icon-sq[title="new session"] >> nth=0')
await page.waitForSelector('.modal:has-text("New session")', { timeout: 5000 })
await page.screenshot({ path: path.join(SHOT_DIR, '02-new-session-modal.png') })
console.log('per-task + opens New Session modal, distinct from task creation OK')

await app.close()
console.log('DONE')
