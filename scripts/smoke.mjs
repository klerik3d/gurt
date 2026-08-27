// The happy path through the real UI, no docker: workspace -> repo -> env ->
// task -> client -> session draft, each step going through IPC to the store on
// disk. A session starts life as a bare draft and is configured afterwards on
// its own Config tab, so the draft's env/repo/agent are picked there.
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
// The sidebar header is a static "Tasks" label — the workspace name lives in
// the titlebar switcher, which is therefore the readback for the create.
await page.waitForSelector('.tb-ws-btn:has-text("personal")', { timeout: 5000 })
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

// create a session draft off the task row (the button only shows on hover).
// There is no modal any more: the draft exists the moment the button is
// clicked, and its pane opens on the Chat tab.
await openWork()
await page.hover('.sb-task >> nth=0')
await page.click('.sb-task .icon-sq[title="new session"] >> nth=0')
await page.waitForSelector('.session-pane .tab-bar', { timeout: 5000 })
await page.waitForSelector('.sb-session', { timeout: 5000 })
assert.equal(await page.locator('.modal').count(), 0, 'a new session is a bare draft, not a modal')
console.log('session draft created OK')

// configure the draft on its own Config tab — every pick saves immediately over
// IPC, there is no Save button. This is what ties the env, repo and client
// registered above to a session.
await page.click('.tab-btn:has-text("Config")')
await page.waitForSelector('.ns-body', { timeout: 5000 })
await page.click('.ns-body .seclabel:text-is("ENVIRONMENT") + .pick-wrap .pick-row')
await page.click('.ns-body .pick-menu .menu-item:has-text("dev")')
await page.click('.ns-body .seclabel:text-is("REPOSITORY") + .pick-wrap .pick-row')
await page.click('.ns-body .pick-menu .menu-item:has-text("demo")')
await page.keyboard.press('Escape') // the repo menu stays open for multi-select
await page.waitForSelector('.ns-body .chip-tag:has-text("octocat/Hello-World")', { timeout: 5000 })
await page.click('.ns-body .seclabel:text-is("AGENT") + .pick-wrap .pick-row')
await page.click('.ns-body .pick-menu .menu-item:has-text("claude smoke")')
await page.waitForSelector('.ns-body .pick-menu', { state: 'detached', timeout: 5000 })
await page.screenshot({ path: path.join(SHOT_DIR, '03-config-tab.png') })
console.log('draft configured on the Config tab OK')

// back on Chat: the prompt persists on blur, and Run now unblocks only once
// the draft has an environment, a repository and an agent.
await page.click('.tab-btn:has-text("Chat")')
await page.waitForSelector('.draft-prompt', { timeout: 5000 })
await page.fill('.draft-prompt', 'say hello')
await page.click('.chat-title') // blur the textarea -> sessionEditPrompt
await page.waitForSelector('.draft-body .btn-primary:not([disabled])', { timeout: 5000 })
console.log('draft prompt saved, draft is runnable OK')

// the task pane is what a task row opens — proves the selection wiring, and
// that the draft above did not silently land under some other task
await page.click('.sb-task-name:has-text("demo-task")')
await page.waitForSelector('.task-pane', { timeout: 5000 })
assert.equal(await page.locator('.sb-session').count(), 1, 'exactly one session draft exists')
await page.screenshot({ path: path.join(SHOT_DIR, '04-task-pane.png') })
console.log('task pane OK')

// everything above went through IPC to disk, so it must survive a reload
await page.reload()
await page.waitForSelector('.tb-ws-btn:has-text("personal")', { timeout: 15000 })
await page.waitForSelector('.sb-task-name:has-text("demo-task")', { timeout: 5000 })
assert.equal(await page.locator('.sb-session').count(), 1, 'the draft is persisted, not in-memory only')
// …and so is what the Config/Chat tabs wrote into it, field by field.
await page.click('.sb-session >> nth=0')
await page.waitForSelector('.draft-prompt', { timeout: 5000 })
assert.equal(await page.locator('.draft-prompt').inputValue(), 'say hello', 'the prompt survived')
await page.click('.tab-btn:has-text("Config")')
await page.waitForSelector('.ns-body .chip-tag:has-text("octocat/Hello-World")', { timeout: 5000 })
assert.equal(
  await page.locator('.ns-body .seclabel:text-is("ENVIRONMENT") + .pick-wrap .pick-value').innerText(),
  'dev',
  'the picked environment survived'
)
console.log('persisted across reload OK')

await app.close()
console.log('SMOKE PASS')
