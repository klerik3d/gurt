// Phase 5: focused codex-in-gurt test. Provision one codex env, create a
// session, verify the chat header says codex, prompt, expect auth error.
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

await page.waitForSelector('.sidebar', { timeout: 15000 })

// ws
await page.evaluate(() => document.querySelector('button[title="new workspace"]').click())
await page.waitForSelector('.modal input')
await page.fill('.modal input', 'p')
await page.click('.modal .form > button')
await page.waitForSelector('.modal', { state: 'detached' })
// repo
await page.evaluate(() => document.querySelector('button[title="repos"]').click())
await page.waitForSelector('.modal')
await page.evaluate(() => [...document.querySelectorAll('.modal button')].find((b) => b.textContent.trim() === 'Add repo').click())
await page.waitForSelector('.modal .repo-form input')
await page.fill('.modal .repo-form input[placeholder="name"]', 'hello')
await page.fill('.modal .repo-form input[placeholder*="git url"]', 'https://github.com/octocat/Hello-World.git')
await page.fill('.modal .repo-form textarea', '{ "image": "mcr.microsoft.com/devcontainers/base:ubuntu" }')
await page.evaluate(() => [...document.querySelectorAll('.repo-form button')].find((b) => b.textContent.trim() === 'Add').click())
await page.waitForSelector('.repo-row')
await page.click('.modal-header .icon-btn')
await page.waitForSelector('.modal', { state: 'detached' })
// enable codex
await page.evaluate(() => document.querySelector('button[title="agents"]').click())
await page.waitForSelector('.modal .agent-block')
await page.evaluate(() => {
  const block = [...document.querySelectorAll('.agent-block')].find((b) => b.textContent.includes('codex'))
  const cb = block.querySelector('input[type="checkbox"]')
  if (!cb.checked) cb.click()
})
await page.evaluate(() => [...document.querySelectorAll('.modal button')].find((b) => b.textContent.trim() === 'Save').click())
await page.waitForSelector('.modal', { state: 'detached' })
// task + env(codex)
await page.evaluate(() => document.querySelector('button[title="new task"]').click())
await page.waitForSelector('.modal input')
await page.fill('.modal input', 't')
await page.click('.modal .form > button')
await page.waitForSelector('.modal', { state: 'detached' })
await page.evaluate(() => document.querySelector('button[title="add environment"]').click())
await page.waitForSelector('.modal select')
await page.selectOption('.modal select', 'codex')
await page.evaluate(() => [...document.querySelectorAll('.modal .form button')].find((b) => b.textContent.includes('hello')).click())
await page.waitForSelector('.modal', { state: 'detached' })
await page.waitForSelector('.env-node')

// start
await page.evaluate(() => {
  const node = document.querySelector('.env-node')
  node.querySelector('.node-label').click()
  node.querySelector('button[title="start environment"]').click()
})
console.log('provisioning codex env...')
await page.waitForFunction(
  () => document.querySelector('.env-node .status-running') || document.querySelector('.env-node .status-error'),
  { timeout: 600000, polling: 2000 }
)
if (await page.$('.env-node .status-error')) {
  console.log('ENV ERROR:', await page.evaluate(() => document.querySelector('.env-error')?.innerText))
  await app.close()
  process.exit(1)
}
console.log('codex env running')

// session via sidebar "+" (fresh DOM query inside evaluate to avoid staleness)
await page.evaluate(() => document.querySelector('.env-node button[title="new session"]').click())
await page.waitForSelector('.chat-input', { timeout: 90000 })
const header = await page.evaluate(() => document.querySelector('.chat-header')?.innerText)
console.log('chat header:', header)
if (!header.includes('codex')) {
  console.log('WRONG SESSION OPENED')
  await app.close()
  process.exit(1)
}
await page.fill('.chat-input textarea', 'ping')
await page.click('.chat-input button')
await page.waitForSelector('.entry-system, .entry-agent, .entry-permission', { timeout: 120000 })
await new Promise((r) => setTimeout(r, 1500))
console.log('--- codex chat ---')
console.log(await page.evaluate(() => document.querySelector('.chat-log')?.innerText))
await page.screenshot({ path: path.join(SHOT_DIR, '10-codex.png') })
await app.close()
console.log('PHASE5 DONE')
