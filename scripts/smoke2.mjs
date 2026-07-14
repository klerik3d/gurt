// Phase 2 (clean): real provisioning through the UI — requires docker daemon.
// Fresh GURT_ROOT; recreates ws/repos/task/envs, starts only "hello".
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const APP_DIR = '/Users/klerik3d/workspace/personal/gurt'
const SHOT_DIR = path.join(process.env.SCRATCH ?? '/tmp', 'shots')
// must live under a Docker-Desktop-shared path (/Users) for bind mounts
const GURT_ROOT = path.join(os.homedir(), '.gurt-smoke')
fs.rmSync(GURT_ROOT, { recursive: true, force: true })
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
app.process().stderr.on('data', (d) => process.stdout.write(`[main!] ${d}`))

const page = await app.firstWindow()
page.on('dialog', (d) => {
  console.log('[dialog]', d.message())
  d.dismiss().catch(() => {})
})
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text())
})

await page.waitForSelector('.sidebar', { timeout: 15000 })

async function nameModal(buttonTitle, value) {
  await page.evaluate((t) => document.querySelector(`button[title="${t}"]`).click(), buttonTitle)
  await page.waitForSelector('.modal input')
  await page.fill('.modal input', value)
  await page.click('.modal .form > button')
  await page.waitForSelector('.modal', { state: 'detached' })
}

async function addRepo(name, url, devcontainer) {
  await page.evaluate(() => document.querySelector('button[title="add repo"]').click())
  await page.waitForSelector('.modal input[placeholder="name"]')
  await page.fill('.modal input[placeholder="name"]', name)
  await page.fill('.modal input[placeholder*="git url"]', url)
  if (devcontainer) await page.fill('.modal textarea', devcontainer)
  await page.click('.modal .form > button')
  await page.waitForSelector('.modal', { state: 'detached' })
  console.log(`repo "${name}" added`)
}

async function addEnv(repoName) {
  await page.evaluate(() => document.querySelector('button[title="add environment"]').click())
  await page.waitForSelector('.modal .form button')
  await page.evaluate((n) => {
    const btn = [...document.querySelectorAll('.modal .form button')].find((b) =>
      b.textContent.includes(n)
    )
    btn?.click()
  }, repoName)
  await page.waitForSelector('.modal', { state: 'detached' })
  console.log(`env "${repoName}" added`)
}

await nameModal('new workspace', 'personal')
await page.waitForSelector('.ws-node')
await addRepo('demo', 'https://github.com/octocat/Hello-World.git', '')
await addRepo('hello', 'https://github.com/octocat/Hello-World.git',
  '{ "image": "mcr.microsoft.com/devcontainers/base:ubuntu" }')
await nameModal('new task', 'try-electron')
await page.waitForSelector('.task-node')
await addEnv('demo')
await addEnv('hello')
await page.waitForSelector('.env-node')

// select env "hello" and hit Start
await page.evaluate(() => {
  const label = [...document.querySelectorAll('.env-node .node-label')].find(
    (l) => l.textContent.trim() === 'hello'
  )
  label?.click()
})
await page.waitForSelector('.env-pane')
const header = await page.evaluate(() => document.querySelector('.chat-header')?.innerText)
console.log('env pane header:', header)
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.env-pane button')].find(
    (b) => b.textContent.trim() === 'Start'
  )
  btn?.click()
})
console.log('start clicked, provisioning...')

// poll status up to 10 min, echo provisioning log as it grows
const started = Date.now()
let lastLen = 0
let status = 'starting'
while (Date.now() - started < 600_000) {
  await new Promise((r) => setTimeout(r, 5000))
  const state = await page.evaluate(() => {
    const statuses = {}
    for (const node of document.querySelectorAll('.env-node')) {
      const name = node.querySelector('.node-label')?.textContent.trim()
      const cls = [...(node.querySelector('.status')?.classList ?? [])].find((c) =>
        c.startsWith('status-')
      )
      statuses[name] = cls?.replace('status-', '')
    }
    return { statuses, log: document.querySelector('.env-log')?.innerText ?? '' }
  })
  if (state.log.length > lastLen) {
    process.stdout.write(state.log.slice(lastLen))
    lastLen = state.log.length
  }
  status = state.statuses['hello']
  if (state.statuses['demo'] !== 'stopped')
    console.log(`\n!!! demo status changed: ${state.statuses['demo']}`)
  if (status === 'running' || status === 'error') break
}
console.log(`\n=== env status: ${status} (${Math.round((Date.now() - started) / 1000)}s) ===`)
await page.screenshot({ path: path.join(SHOT_DIR, '04-provisioned.png') })
if (status !== 'running') {
  await app.close()
  process.exit(1)
}

// create a session and send a prompt (no oauth token — an auth error in chat
// still proves the whole ACP pipe works)
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.env-pane button')].find(
    (b) => b.textContent.trim() === 'New session'
  )
  btn?.click()
})
try {
  await page.waitForSelector('.chat-input', { timeout: 60000 })
  console.log('session created, chat open')
  await page.fill('.chat-input textarea', 'Reply with exactly one word: pong')
  await page.click('.chat-input button')
  await page.waitForSelector('.entry-agent, .entry-system', { timeout: 120000 })
  await new Promise((r) => setTimeout(r, 5000))
  const chatText = await page.evaluate(() => document.querySelector('.chat-log')?.innerText)
  console.log('=== chat ===\n' + chatText)
} catch (e) {
  console.log('session/chat step failed:', e.message)
}
await page.screenshot({ path: path.join(SHOT_DIR, '05-chat.png') })

await app.close()
console.log('PHASE2 DONE')
