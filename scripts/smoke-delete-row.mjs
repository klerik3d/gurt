// Del/⌫ on the sidebar tree deletes the selected row, behind a confirmation.
//
// Drives the real app (Electron + the renderer), because what is under test is
// the wiring: the tree has to be holding focus after a plain click, the dialog
// has to gate the delete, cancelling has to change nothing, and confirming has
// to move the selection off the row that just went away.
//
// Sessions are seeded as drafts straight into GURT_ROOT — no agent, no clone,
// no container, so nothing here needs docker.
//
//   npm run build && node scripts/smoke-delete-row.mjs
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SCRATCH = process.env.SCRATCH ?? '/tmp/gurt-smoke-delete-row'
const GURT_ROOT = path.join(SCRATCH, 'gurt-root')
const SHOT_DIR = path.join(SCRATCH, 'shots')
fs.rmSync(GURT_ROOT, { recursive: true, force: true })
fs.mkdirSync(SHOT_DIR, { recursive: true })

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
fs.writeFileSync(path.join(GURT_ROOT, ws, 'agents.json'), JSON.stringify({}))
fs.writeFileSync(path.join(GURT_ROOT, ws, task, 'task.json'), JSON.stringify({}))
const draft = (id, title) => ({
  info: {
    id,
    env: 'dev',
    repo: 'alpha',
    task,
    workspace: ws,
    title,
    state: 'draft',
    startPrompt: 'hi'
  }
})
const sessionsFile = path.join(GURT_ROOT, ws, task, 'sessions.json')
fs.writeFileSync(sessionsFile, JSON.stringify([draft('s-alpha', 'Alpha'), draft('s-bravo', 'Bravo')]))

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
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text())
})
page.on('pageerror', (e) => console.log('[pageerror]', e.message))

const shot = (name) => page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) })
const titles = () => page.locator('.sb-session-name').allInnerTexts()
const selected = () => page.locator('.sb-session.selected .sb-session-name').innerText()

try {
  await page.waitForSelector('.sidebar', { timeout: 15000 })
  await page.waitForSelector('.sb-session', { timeout: 10000 })
  assert.deepEqual(await titles(), ['Alpha', 'Bravo'], 'both seeded drafts are in the tree')

  // Plain click, then the key — the flow a user actually performs. It only works
  // if the click leaves focus on the tree, which is the point of asserting it.
  await page.click('.sb-session:has-text("Alpha")')
  assert.match(await selected(), /Alpha/, 'clicking a row selects it')

  // --- cancelling changes nothing ---
  await page.keyboard.press('Delete')
  await page.waitForSelector('.dialog', { timeout: 5000 })
  assert.equal(await page.locator('.dialog-title').innerText(), 'Delete session')
  assert.match(await page.locator('.dialog-message').innerText(), /Delete session "Alpha"\?/)
  await shot('01-confirm')
  await page.click('.dialog-cancel')
  await page.waitForSelector('.dialog', { state: 'detached', timeout: 5000 })
  assert.deepEqual(await titles(), ['Alpha', 'Bravo'], 'a cancelled delete keeps the session')
  assert.match(await selected(), /Alpha/, 'a cancelled delete leaves the selection put')
  console.log('Del asks first, and takes no for an answer OK')

  // --- confirming deletes, and the selection steps to the neighbour ---
  // ⌫ this time: the same handler serves the keyboard that has no forward Delete.
  await page.keyboard.press('Backspace')
  await page.waitForSelector('.dialog', { timeout: 5000 })
  await page.click('.dialog-ok')
  await page.waitForSelector('.dialog', { state: 'detached', timeout: 5000 })
  await page.waitForFunction(() => document.querySelectorAll('.sb-session').length === 1, null, {
    timeout: 5000
  })
  assert.deepEqual(await titles(), ['Bravo'], 'the confirmed session is gone from the tree')
  assert.match(await selected(), /Bravo/, 'the selection lands on the surviving neighbour')
  await shot('02-deleted')
  console.log('Del deletes the selected session and moves on OK')

  // The delete reaches disk, not just the tree in memory (300ms debounce).
  let persisted = null
  for (let i = 0; i < 40; i++) {
    persisted = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'))
    if (persisted.length === 1) break
    await new Promise((r) => setTimeout(r, 100))
  }
  assert.deepEqual(
    persisted.map((r) => r.info.id),
    ['s-bravo'],
    'sessions.json no longer holds the deleted session'
  )
  console.log('the delete is persisted OK')

  // --- the same key on a task row runs the task delete ---
  await page.click('.sb-task-name:has-text("t")')
  await page.keyboard.press('Delete')
  await page.waitForSelector('.dialog', { timeout: 5000 })
  assert.equal(await page.locator('.dialog-title').innerText(), 'Delete task')
  await page.click('.dialog-ok')
  await page.waitForFunction(() => document.querySelectorAll('.sb-task').length === 0, null, {
    timeout: 10000
  })
  await shot('03-task-deleted')
  console.log('Del on a task row deletes the task OK')

  console.log('smoke-delete-row: PASS')
} catch (e) {
  await shot('99-failure').catch(() => {})
  console.error('smoke-delete-row: FAIL')
  console.error(e)
  console.error('shots in', SHOT_DIR)
  process.exitCode = 1
} finally {
  await app.close().catch(() => {})
}
