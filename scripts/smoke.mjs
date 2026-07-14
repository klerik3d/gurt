import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const APP_DIR = '/Users/klerik3d/workspace/personal/gurt'
const SHOT_DIR = path.join(process.env.SCRATCH ?? '/tmp', 'shots')
const GURT_ROOT = path.join(process.env.SCRATCH ?? '/tmp', 'gurt-root')
fs.mkdirSync(SHOT_DIR, { recursive: true })

const require = createRequire(path.join(APP_DIR, 'package.json'))
const { _electron } = require('playwright-core')

const env = { ...process.env, GURT_ROOT }
delete env.ELECTRON_RUN_AS_NODE // inherited from the VSCode extension host shell

const app = await _electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [APP_DIR],
  env,
  timeout: 30000
})

const page = await app.firstWindow()
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text())
})

await page.waitForSelector('.sidebar', { timeout: 15000 })
await page.screenshot({ path: path.join(SHOT_DIR, '01-initial.png') })
console.log('initial render OK')

// create a workspace through the real UI -> IPC -> store
await page.evaluate(() => document.querySelector('button[title="new workspace"]').click())
await page.waitForSelector('.modal input')
await page.fill('.modal input', 'personal')
await page.click('.modal .form button')
await page.waitForSelector('.ws-node', { timeout: 5000 })
console.log('workspace created OK')

// add a repo (writes workspace.json, no network)
await page.evaluate(() => document.querySelector('button[title="add repo"]').click())
await page.waitForSelector('.modal input')
await page.fill('.modal input[placeholder="name"]', 'demo')
await page.fill('.modal input[placeholder*="git url"]', 'https://github.com/octocat/Hello-World.git')
await page.click('.modal .form > button')
await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 })
console.log('repo added OK')

// create a task
await page.evaluate(() => document.querySelector('button[title="new task"]').click())
await page.waitForSelector('.modal input')
await page.fill('.modal input', 'try-electron')
await page.click('.modal .form button')
await page.waitForSelector('.task-node', { timeout: 5000 })
console.log('task created OK')

// add an env from the registered repo
await page.evaluate(() => document.querySelector('button[title="add environment"]').click())
await page.waitForSelector('.modal .form button')
await page.click('.modal .form button')
await page.waitForSelector('.env-node', { timeout: 5000 })
console.log('env added OK')

// select env -> env pane with Start button
await page.evaluate(() => document.querySelector('.env-node .node-label').click())
await page.waitForSelector('.env-pane', { timeout: 5000 })
await page.screenshot({ path: path.join(SHOT_DIR, '02-tree-env.png') })
console.log('env pane OK')

// agents modal
await page.evaluate(() => document.querySelector('button[title="agents"]').click())
await page.waitForSelector('.modal input[type="password"]', { timeout: 5000 })
await page.screenshot({ path: path.join(SHOT_DIR, '03-agents.png') })
console.log('agents modal OK')

console.log('state on disk:')
for (const f of fs.readdirSync(GURT_ROOT, { recursive: true })) console.log(' ', f)

await app.close()
console.log('SMOKE PASS')
