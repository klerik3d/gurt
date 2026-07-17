// Phase 5: focused codex-in-gurt test. Run one codex session (env provisioned on
// start), verify the chat header names codex, prompt, expect an auth error.
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const APP_DIR = '/Users/klerik3d/workspace/personal/gurt'
const SHOT_DIR = path.join(process.env.SCRATCH ?? '/tmp', 'shots')
const GURT_ROOT = path.join(os.homedir(), `.gurt-smoke-${Date.now()}`)
console.log('GURT_ROOT:', GURT_ROOT)
fs.mkdirSync(SHOT_DIR, { recursive: true })

const require = createRequire(path.join(APP_DIR, 'package.json'))
const { _electron } = require('playwright-core')

const env = { ...process.env, GURT_ROOT }
delete env.ELECTRON_RUN_AS_NODE

// Seed the codex agent (no credential — auth error expected). The registry
// starts empty, so it must be added before it is selectable.
fs.mkdirSync(GURT_ROOT, { recursive: true })
fs.writeFileSync(
  path.join(GURT_ROOT, 'agents.json'),
  JSON.stringify({ codex: { kind: 'codex', label: 'codex' } })
)

const app = await _electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [APP_DIR],
  env,
  timeout: 30000
})
app.process().stdout.on('data', (d) => process.stdout.write(`[main] ${d}`))
const page = await app.firstWindow()
page.on('dialog', (d) => {
  console.log('[dialog]', d.type(), d.message().slice(0, 120))
  d.accept().catch(() => {})
})

const clickTitle = (t) => page.evaluate((x) => document.querySelector(`button[title="${x}"]`)?.click(), t)
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

await page.waitForSelector('.sidebar', { timeout: 15000 })

// ws
await clickTitle('new workspace')
await page.waitForSelector('.modal input')
await page.fill('.modal input', 'p')
await page.click('.modal .form > button')
await modalGone()
// repo
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
// codex is seeded and selectable (agents are added, not toggled available).
// task
await clickTitle('new task')
await page.waitForSelector('.modal input')
await page.fill('.modal input', 't')
await page.click('.modal .form > button')
await modalGone()

// codex session — births and provisions the env
await clickTitle('new session')
await page.waitForSelector('.modal textarea')
await page.selectOption('.modal label:has-text("agent") select', 'codex')
await page.fill('.modal textarea', 'ping')
await clickText('.modal .row-buttons', 'Run now')
await modalGone()
console.log('provisioning codex env...')

await page.waitForFunction(
  () => {
    if (document.querySelector('.env-error')) return true
    const m = document.querySelector('.session-node .session-mark')
    const st = m && [...m.classList].find((c) => c.startsWith('mark-'))?.slice(5)
    return st && ['running', 'waiting', 'idle'].includes(st)
  },
  undefined,
  { timeout: 600000, polling: 2000 }
)
// Keyless codex refuses session/new with 'Authentication required' (every
// codex-acp version does) — that outcome still proves the whole pipe: install,
// spawn, initialize, session/new round-trip, error surfaced in the UI. Any
// other start error is a real failure.
const startErr = await page.evaluate(() => document.querySelector('.env-error')?.innerText)
if (startErr && !startErr.includes('Authentication required')) {
  console.log('SESSION START FAILED:', startErr)
  await app.close()
  process.exit(1)
}
console.log(
  startErr
    ? 'codex refused without a key at session/new (ACP pipe proven)'
    : 'codex session started (ACP handshake OK)'
)

// open the chat; the header chip must name codex (right session opened)
await page.evaluate(() => document.querySelector('.session-node .node-label')?.click())
await page.waitForSelector('.chat-header', { timeout: 15000 })
const header = await page.evaluate(() => document.querySelector('.chat-header')?.innerText)
console.log('chat header:', header)
if (!header.includes('codex')) {
  console.log('WRONG SESSION OPENED')
  await app.close()
  process.exit(1)
}
if (startErr) {
  // A never-started session renders the draft pane, not a timeline — the
  // error banner is the assertion.
  console.log('--- codex draft pane ---')
  console.log(await page.evaluate(() => document.querySelector('.env-error')?.innerText))
} else {
  await page.waitForSelector('.entry-text, .perm-card', { timeout: 120000 })
  await new Promise((r) => setTimeout(r, 1500))
  console.log('--- codex chat ---')
  console.log(await page.evaluate(() => document.querySelector('.chat-log')?.innerText))
}
await page.screenshot({ path: path.join(SHOT_DIR, '10-codex.png') })
await app.close()
console.log('PHASE5 DONE')
