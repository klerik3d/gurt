// Phase 3: session persistence across app restart. Requires docker.
// Run A: provision env, create session, prompt (auth error is fine), quit.
// Run B: relaunch, expect session in tree with history, prompt -> session/load.
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const APP_DIR = '/Users/klerik3d/workspace/personal/gurt'
const SHOT_DIR = path.join(process.env.SCRATCH ?? '/tmp', 'shots')
const GURT_ROOT = path.join(os.homedir(), '.gurt-smoke')
fs.rmSync(GURT_ROOT, { recursive: true, force: true })
fs.mkdirSync(SHOT_DIR, { recursive: true })

const require = createRequire(path.join(APP_DIR, 'package.json'))
const { _electron } = require('playwright-core')

const env = { ...process.env, GURT_ROOT }
delete env.ELECTRON_RUN_AS_NODE

async function launch() {
  const app = await _electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: [APP_DIR],
    env,
    timeout: 30000
  })
  app.process().stdout.on('data', (d) => process.stdout.write(`[main] ${d}`))
  app.process().stderr.on('data', (d) => {
    const t = d.toString()
    if (!t.includes('Debugger')) process.stdout.write(`[main!] ${t}`)
  })
  const page = await app.firstWindow()
  page.on('dialog', (dg) => {
    console.log('[dialog]', dg.message())
    dg.dismiss().catch(() => {})
  })
  await page.waitForSelector('.sidebar', { timeout: 15000 })
  return { app, page }
}

// ---- run A ----
let { app, page } = await launch()

async function modalName(title, value) {
  await page.evaluate((t) => document.querySelector(`button[title="${t}"]`).click(), title)
  await page.waitForSelector('.modal input')
  await page.fill('.modal input', value)
  await page.click('.modal .form > button')
  await page.waitForSelector('.modal', { state: 'detached' })
}

await modalName('new workspace', 'personal')
await page.waitForSelector('.ws-node')
await page.evaluate(() => document.querySelector('button[title="add repo"]').click())
await page.waitForSelector('.modal input[placeholder="name"]')
await page.fill('.modal input[placeholder="name"]', 'hello')
await page.fill('.modal input[placeholder*="git url"]', 'https://github.com/octocat/Hello-World.git')
await page.fill('.modal textarea', '{ "image": "mcr.microsoft.com/devcontainers/base:ubuntu" }')
await page.click('.modal .form > button')
await page.waitForSelector('.modal', { state: 'detached' })
await modalName('new task', 'try-electron')
await page.waitForSelector('.task-node')
await page.evaluate(() => document.querySelector('button[title="add environment"]').click())
await page.waitForSelector('.modal .form button')
await page.click('.modal .form button')
await page.waitForSelector('.modal', { state: 'detached' })
await page.evaluate(() => document.querySelector('.env-node .node-label').click())
await page.waitForSelector('.env-pane')
await page.evaluate(() => {
  ;[...document.querySelectorAll('.env-pane button')]
    .find((b) => b.textContent.trim() === 'Start')
    ?.click()
})
console.log('provisioning...')
await page.waitForSelector('.status-running', { timeout: 600000 })
console.log('env running')

await page.evaluate(() => {
  ;[...document.querySelectorAll('.env-pane button')]
    .find((b) => b.textContent.trim() === 'New session')
    ?.click()
})
await page.waitForSelector('.chat-input', { timeout: 60000 })
await page.fill('.chat-input textarea', 'hello from run A')
await page.click('.chat-input button')
await page.waitForSelector('.entry-agent, .entry-system', { timeout: 120000 })
await new Promise((r) => setTimeout(r, 2000))
console.log('--- run A chat ---')
console.log(await page.evaluate(() => document.querySelector('.chat-log')?.innerText))
await new Promise((r) => setTimeout(r, 1000)) // let debounced persist flush
await app.close()
console.log('run A closed')

const persisted = path.join(GURT_ROOT, 'personal', 'try-electron', 'sessions.json')
console.log('sessions.json exists:', fs.existsSync(persisted))
console.log(fs.readFileSync(persisted, 'utf8'))

// ---- run B ----
;({ app, page } = await launch())
await page.waitForSelector('.session-node', { timeout: 10000 })
console.log('session visible in tree after restart')
await page.evaluate(() => document.querySelector('.session-node').click())
await page.waitForSelector('.chat-log')
await new Promise((r) => setTimeout(r, 500))
console.log('--- restored chat ---')
console.log(await page.evaluate(() => document.querySelector('.chat-log')?.innerText))
await page.screenshot({ path: path.join(SHOT_DIR, '06-restored.png') })

await page.fill('.chat-input textarea', 'hello from run B')
await page.click('.chat-input button')
await page.waitForFunction(
  () => document.querySelector('.chat-log')?.innerText.includes('resum'),
  { timeout: 60000 }
)
await new Promise((r) => setTimeout(r, 20000))
console.log('--- run B chat after prompt ---')
console.log(await page.evaluate(() => document.querySelector('.chat-log')?.innerText))
await page.screenshot({ path: path.join(SHOT_DIR, '07-resumed.png') })

await app.close()
console.log('PHASE3 DONE')
