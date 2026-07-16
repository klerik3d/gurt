// Phase 3: session persistence across app restart. Requires docker.
// Run A: session on "hello" runs (env provisioned, prompt fails auth), quit.
// Run B: relaunch, expect the session in the tree with restored history,
// prompt again -> session/load resume path.
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const APP_DIR = '/Users/klerik3d/workspace/personal/gurt'
const SHOT_DIR = path.join(process.env.SCRATCH ?? '/tmp', 'shots')
// unique per run: Docker Desktop's virtiofs caches deleted paths, so reusing
// a recently-removed directory name breaks bind mounts ("source does not exist")
const GURT_ROOT = path.join(os.homedir(), `.gurt-smoke-${Date.now()}`)
console.log('GURT_ROOT:', GURT_ROOT)
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
    dg.accept().catch(() => {})
  })
  await page.waitForSelector('.sidebar', { timeout: 15000 })
  return { app, page }
}

// ---- run A ----
let { app, page } = await launch()

const clickTitle = (t) =>
  page.evaluate((x) => document.querySelector(`button[title="${x}"]`)?.click(), t)
const clickText = (scope, text) =>
  page.evaluate(
    ([sc, tx]) => {
      ;[...document.querySelectorAll(`${sc} button`)]
        .find((b) => b.textContent.trim() === tx)
        ?.click()
    },
    [scope, text]
  )
const modalGone = () => page.waitForSelector('.modal', { state: 'detached' })

async function modalName(title, value) {
  await clickTitle(title)
  await page.waitForSelector('.modal input')
  await page.fill('.modal input', value)
  await page.click('.modal .form > button')
  await modalGone()
}

// Resolves when the session mark reaches one of `states`; fails fast when the
// start fails (the session pane shows .env-error instead of ever starting).
const waitMark = async (states, timeout = 600000) => {
  await page.waitForFunction(
    (ss) => {
      if (document.querySelector('.env-error')) return true
      const m = document.querySelector('.session-node .session-mark')
      const st = m && [...m.classList].find((c) => c.startsWith('mark-'))?.slice(5)
      return st && ss.includes(st)
    },
    states,
    { timeout, polling: 1000 }
  )
  const err = await page.evaluate(() => document.querySelector('.env-error')?.innerText)
  if (err) throw new Error(`session start failed: ${err}`)
}

await modalName('new workspace', 'personal')
await page.waitForSelector('.ws-node')
await clickTitle('repos')
await page.waitForSelector('.modal')
await clickText('.modal', 'Add repo')
await page.waitForSelector('.modal .repo-form input')
await page.fill('.modal .repo-form input[placeholder="name"]', 'hello')
await page.fill('.modal .repo-form input[placeholder*="git url"]', 'https://github.com/octocat/Hello-World.git')
await page.fill('.modal .repo-form textarea', '{ "image": "mcr.microsoft.com/devcontainers/base:ubuntu" }')
await clickText('.repo-form', 'Add')
await page.waitForSelector('.repo-row')
await page.click('.modal-header .icon-btn')
await modalGone()
await modalName('new task', 'try-electron')
await page.waitForSelector('.task-node')

await clickTitle('new session')
await page.waitForSelector('.modal textarea')
await page.fill('.modal textarea', 'hello from run A')
await clickText('.modal .row-buttons', 'Run now')
await modalGone()
console.log('provisioning...')
await waitMark(['running', 'waiting', 'idle'])
console.log('session started')

// open the chat and wait for the turn to finish (auth error entry is fine)
await page.evaluate(() => document.querySelector('.session-node .node-label')?.click())
await page.waitForSelector('.chat-log', { timeout: 15000 })
await page.waitForSelector('.entry-text', { timeout: 120000 })
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
await page.evaluate(() => document.querySelector('.session-node .node-label')?.click())
await page.waitForSelector('.chat-log')
await new Promise((r) => setTimeout(r, 500))
const restored = await page.evaluate(() => document.querySelector('.chat-log')?.innerText)
console.log('--- restored chat ---')
console.log(restored)
if (!restored.includes('hello from run A')) {
  console.log('FAIL: history not restored')
  await app.close()
  process.exit(1)
}
await page.screenshot({ path: path.join(SHOT_DIR, '06-restored.png') })

await page.fill('.composer-input', 'hello from run B')
await page.click('.send-btn')
await page.waitForFunction(
  () => document.querySelector('.chat-log')?.innerText.includes('resum'),
  { timeout: 120000 }
)
await new Promise((r) => setTimeout(r, 20000))
console.log('--- run B chat after prompt ---')
console.log(await page.evaluate(() => document.querySelector('.chat-log')?.innerText))
await page.screenshot({ path: path.join(SHOT_DIR, '07-resumed.png') })

await app.close()
console.log('PHASE3 DONE')
