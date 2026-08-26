// The happy path through the real UI, no docker: workspace -> repo -> task ->
// client -> session draft, each step going through IPC to the store on disk.
//
//   npm run build && SCRATCH=/tmp/gurt-smoke node scripts/smoke.mjs
//
// Repos and clients live in the Settings view (Settings -> Repos / Clients),
// not in sidebar modals — see openSettings/openWork below.
import { createRequire } from 'node:module'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SHOT_DIR = path.join(process.env.SCRATCH ?? '/tmp', 'shots')
const GURT_ROOT = path.join(process.env.SCRATCH ?? '/tmp', 'gurt-root')
fs.mkdirSync(SHOT_DIR, { recursive: true })

const require = createRequire(path.join(APP_DIR, 'package.json'))
const { _electron } = require('playwright-core')
const electronPath = require('electron') // path string to the electron binary

const env = { ...process.env, GURT_ROOT, DISPLAY: process.env.DISPLAY ?? ':99' }
delete env.ELECTRON_RUN_AS_NODE // inherited from the VSCode extension host shell

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

// The two views in the activity bar. Settings sections are picked by their
// nav label, so a renamed section fails here rather than three steps later.
const openSettings = async (section) => {
  await page.click('.activitybar .ab-item[title="Settings"]')
  await page.click(`.set-nav-item:has-text("${section}")`)
}
const openWork = () => page.click('.activitybar .ab-item[title="Tasks & sessions"]')

await page.waitForSelector('.sidebar', { timeout: 15000 })
await page.screenshot({ path: path.join(SHOT_DIR, '01-initial.png') })
console.log('initial render OK')

// create a workspace through the real UI -> IPC -> store. It lives behind the
// workspace switcher in the titlebar breadcrumb, not a toolbar icon.
await page.click('.tb-ws-btn')
await page.click('text=+ new workspace')
await page.waitForSelector('.modal input')
await page.fill('.modal input', 'personal')
await page.click('.modal .btn-primary')
await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 })
await page.waitForSelector('.sb-ws-name:has-text("personal")', { timeout: 5000 })
console.log('workspace created OK')

// register a repo in Settings -> Repos (writes workspace.json, no network)
await openSettings('Repos')
await page.click('.set-head .btn-primary') // + New repo
await page.waitForSelector('.modal:has-text("New repo")', { timeout: 5000 })
await page.fill('.modal input[placeholder="checkout-web"]', 'demo')
await page.fill(
  '.modal input[placeholder="https://github.com/acme/checkout-web"]',
  'https://github.com/octocat/Hello-World.git'
)
await page.click('.modal-foot .btn-primary') // Save
await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 })
await page.waitForSelector('.set-row-label:has-text("demo")', { timeout: 5000 })
console.log('repo added OK')

// define an environment. Only the definition is exercised here — nothing is
// built or pulled, so this stays docker-free; a session draft needs one to
// exist before it can be saved.
await openSettings('Environments')
await page.click('.set-head .btn-primary') // + New environment
await page.waitForSelector('.modal input[placeholder="web-app"]', { timeout: 5000 })
await page.fill('.modal input[placeholder="web-app"]', 'dev')
await page.fill('.modal .jsoned textarea', '{"image":"x"}')
await page.click('.modal-foot .btn-primary') // Save
await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 })
await page.waitForSelector('.set-row-label:has-text("dev")', { timeout: 5000 })
console.log('environment defined OK')

// create a task — an inline popover in the sidebar header, no modal
await openWork()
await page.click('button[title="New task · ⌘⇧N"]')
await page.waitForSelector('.sb-newtask-menu input', { timeout: 5000 })
await page.fill('.sb-newtask-menu input', 'demo-task')
await page.press('.sb-newtask-menu input', 'Enter')
await page.waitForSelector('.sb-task-name:has-text("demo-task")', { timeout: 5000 })
console.log('task created OK')

// configure an agent in Settings -> Clients. A new card starts expanded with an
// empty label; saving persists it to agents.json through IPC.
await openSettings('Clients')
await page.click('.set-head .btn-primary') // + New client
await page.waitForSelector('.set-card input[placeholder="claude · personal"]', { timeout: 5000 })
await page.fill('.set-card input[placeholder="claude · personal"]', 'claude smoke')
await page.click('.set-card-foot .btn-primary') // Save
await page.waitForSelector('.set-row-label:has-text("claude smoke")', { timeout: 5000 })
await page.screenshot({ path: path.join(SHOT_DIR, '02-client.png') })
console.log('client configured OK')

// create a session draft off the task row (the button only shows on hover)
await openWork()
await page.hover('.sb-task >> nth=0')
await page.click('.sb-task .icon-sq[title="new session"] >> nth=0')
await page.waitForSelector('.modal:has-text("New session")', { timeout: 5000 })
await page.fill('.modal textarea[placeholder="What should the agent do?"]', 'say hello')
await page.getByRole('button', { name: 'Save draft' }).click()
await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 })
await page.waitForSelector('.sb-session', { timeout: 5000 })
console.log('session draft created OK')

// the task pane is what a task row opens — proves the selection wiring, and
// that the draft above did not silently land under some other task
await page.click('.sb-task-name:has-text("demo-task")')
await page.waitForSelector('.task-pane', { timeout: 5000 })
assert.equal(await page.locator('.sb-session').count(), 1, 'exactly one session draft exists')
await page.screenshot({ path: path.join(SHOT_DIR, '03-task-pane.png') })
console.log('task pane OK')

// everything above went through IPC to disk, so it must survive a reload
await page.reload()
await page.waitForSelector('.sb-ws-name:has-text("personal")', { timeout: 15000 })
await page.waitForSelector('.sb-task-name:has-text("demo-task")', { timeout: 5000 })
assert.equal(await page.locator('.sb-session').count(), 1, 'the draft is persisted, not in-memory only')
console.log('persisted across reload OK')

await app.close()
console.log('SMOKE PASS')
