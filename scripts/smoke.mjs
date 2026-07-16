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

// Icon buttons in the sidebar are tiny/absolutely-positioned; click them via the
// DOM to skip Playwright's actionability wait (matches the rest of the smokes).
const clickIcon = (title) =>
  page.evaluate((t) => document.querySelector(`button[title="${t}"]`).click(), title)

await page.waitForSelector('.sidebar', { timeout: 15000 })
await page.screenshot({ path: path.join(SHOT_DIR, '01-initial.png') })
console.log('initial render OK')

// create a workspace through the real UI -> IPC -> store
await clickIcon('new workspace')
await page.waitForSelector('.modal input')
await page.fill('.modal input', 'personal')
await page.click('.modal .form button')
await page.waitForSelector('.ws-node', { timeout: 5000 })
console.log('workspace created OK')

// register a repo via the workspace "repos" modal (writes workspace.json, no network)
await clickIcon('repos')
await page.waitForSelector('.modal')
await page.getByRole('button', { name: 'Add repo' }).click()
await page.fill('.modal input[placeholder="name"]', 'demo')
await page.fill('.modal input[placeholder*="git url"]', 'https://github.com/octocat/Hello-World.git')
await page.getByRole('button', { name: 'Add', exact: true }).click()
await page.waitForSelector('.repo-row', { timeout: 5000 })
await page.click('.modal .modal-header .icon-btn') // close the repos modal
await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 })
console.log('repo added OK')

// create a task
await clickIcon('new task')
await page.waitForSelector('.modal input')
await page.fill('.modal input', 'try-electron')
await page.click('.modal .form button')
await page.waitForSelector('.task-node', { timeout: 5000 })
console.log('task created OK')

// draft a session — claude-code is enabled by default, so no agent secret is
// needed and nothing docker-bound runs (writes sessions.json).
await clickIcon('new session')
await page.waitForSelector('.modal textarea')
await page.fill('.modal textarea', 'say hello')
await page.getByRole('button', { name: 'Save draft' }).click()
await page.waitForSelector('.session-node', { timeout: 5000 })
console.log('session drafted OK')

// select the task -> task pane. No env yet: envs are born on session start, so
// the section shows its empty-state hint (UI only, no docker).
await page.evaluate(() => document.querySelector('.task-node .node-label').click())
await page.waitForSelector('.task-pane', { timeout: 5000 })
await page.getByText('no environments yet').waitFor({ timeout: 5000 })
await page.screenshot({ path: path.join(SHOT_DIR, '02-task-pane.png') })
console.log('task pane OK')

// agents modal
await clickIcon('agents')
await page.waitForSelector('.modal input[type="password"]', { timeout: 5000 })
await page.screenshot({ path: path.join(SHOT_DIR, '03-agents.png') })
console.log('agents modal OK')

console.log('state on disk:')
for (const f of fs.readdirSync(GURT_ROOT, { recursive: true })) console.log(' ', f)

await app.close()
console.log('SMOKE PASS')
