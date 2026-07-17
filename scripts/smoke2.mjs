// Phase 2 (clean): real provisioning through the UI — requires docker daemon.
// Session-centric flow: envs are born when a session starts. Two repos are
// registered; one session runs on "hello" — only hello's env may appear, and it
// must reach running. The prompt fails auth (no secret), which still proves the
// whole devcontainer + ACP pipe.
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const APP_DIR = '/Users/klerik3d/workspace/personal/gurt'
const SHOT_DIR = path.join(process.env.SCRATCH ?? '/tmp', 'shots')
// must live under a Docker-Desktop-shared path (/Users) for bind mounts;
// unique per run: Docker Desktop's virtiofs caches deleted paths, so reusing
// a recently-removed directory name breaks bind mounts ("source does not exist")
const GURT_ROOT = path.join(os.homedir(), `.gurt-smoke-${Date.now()}`)
console.log('GURT_ROOT:', GURT_ROOT)
fs.mkdirSync(SHOT_DIR, { recursive: true })

const require = createRequire(path.join(APP_DIR, 'package.json'))
const { _electron } = require('playwright-core')

const env = { ...process.env, GURT_ROOT }
delete env.ELECTRON_RUN_AS_NODE

// Seed a claude-code agent (no credential — the prompt fails auth, which still
// proves the pipe). The registry starts empty otherwise.
fs.mkdirSync(GURT_ROOT, { recursive: true })
fs.writeFileSync(
  path.join(GURT_ROOT, 'agents.json'),
  JSON.stringify({ 'claude-code': { kind: 'claude-code', label: 'claude code' } })
)

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
  d.accept().catch(() => {})
})
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text())
})

await page.waitForSelector('.sidebar', { timeout: 15000 })

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

async function nameModal(buttonTitle, value) {
  await clickTitle(buttonTitle)
  await page.waitForSelector('.modal input')
  await page.fill('.modal input', value)
  await page.click('.modal .form > button')
  await modalGone()
}

async function addRepo(name, url, devcontainer) {
  await clickText('.modal', 'Add repo')
  await page.waitForSelector('.modal .repo-form input')
  await page.fill('.modal .repo-form input[placeholder="name"]', name)
  await page.fill('.modal .repo-form input[placeholder*="git url"]', url)
  if (devcontainer) await page.fill('.modal .repo-form textarea', devcontainer)
  await clickText('.repo-form', 'Add')
  await page.waitForFunction(
    (n) => [...document.querySelectorAll('.repo-row')].some((r) => r.textContent.includes(n)),
    name
  )
  console.log(`repo "${name}" added`)
}

await nameModal('new workspace', 'personal')
await page.waitForSelector('.ws-node')
await clickTitle('repos')
await page.waitForSelector('.modal')
await addRepo('demo', 'https://github.com/octocat/Hello-World.git', '')
await addRepo('hello', 'https://github.com/octocat/Hello-World.git',
  '{ "image": "mcr.microsoft.com/devcontainers/base:ubuntu" }')
await page.click('.modal-header .icon-btn')
await modalGone()
await nameModal('new task', 'try-electron')
await page.waitForSelector('.task-node')

// run a session on "hello" — this is what births and provisions the env
await clickTitle('new session')
await page.waitForSelector('.modal textarea')
await page.selectOption('.modal label:has-text("repo") select', 'hello')
await page.fill('.modal textarea', 'Reply with exactly one word: pong')
await clickText('.modal .row-buttons', 'Run now')
await modalGone()
console.log('session started, provisioning...')

// poll the session mark up to 10 min, echo the provisioning log as it grows
// (the selected session pane shows .env-log while starting)
const startedAt = Date.now()
let lastLen = 0
let mark = 'starting'
let startError = ''
while (Date.now() - startedAt < 600_000) {
  await new Promise((r) => setTimeout(r, 3000))
  const state = await page.evaluate(() => {
    const m = document.querySelector('.session-node .session-mark')
    return {
      mark: m && [...m.classList].find((c) => c.startsWith('mark-'))?.slice(5),
      log: document.querySelector('.env-log')?.innerText ?? '',
      startError: document.querySelector('.env-error')?.innerText ?? ''
    }
  })
  if (state.log.length > lastLen) {
    process.stdout.write(state.log.slice(lastLen))
    lastLen = state.log.length
  }
  mark = state.mark
  startError = state.startError
  if (['running', 'waiting', 'idle'].includes(mark) || startError) break
}
console.log(`\n=== session mark: ${mark} (${Math.round((Date.now() - startedAt) / 1000)}s) ===`)
if (startError) console.log('start error:', startError)
await page.screenshot({ path: path.join(SHOT_DIR, '04-provisioned.png') })
if (!['running', 'waiting', 'idle'].includes(mark)) {
  await app.close()
  process.exit(1)
}

// task pane: exactly one env (hello) exists and is running — demo got none
await page.evaluate(() => document.querySelector('.task-node .node-label')?.click())
await page.waitForSelector('.task-pane')
const envs = await page.evaluate(() =>
  [...document.querySelectorAll('.env-cell')].map((c) => c.innerText.replace(/\n/g, ' ').trim())
)
console.log('envs:', JSON.stringify(envs))
if (envs.length !== 1 || !/hello — running/.test(envs[0])) {
  console.log('FAIL: expected exactly one running env for "hello"')
  await app.close()
  process.exit(1)
}

// chat: the start prompt and the agent's reply (an auth error without a secret —
// still proves the whole ACP pipe)
await page.evaluate(() => document.querySelector('.session-node .node-label')?.click())
await page.waitForSelector('.chat-log', { timeout: 15000 })
await page.waitForSelector('.entry-text', { timeout: 120000 })
await new Promise((r) => setTimeout(r, 2000))
const chatText = await page.evaluate(() => document.querySelector('.chat-log')?.innerText)
console.log('=== chat ===\n' + chatText)
await page.screenshot({ path: path.join(SHOT_DIR, '05-chat.png') })

await app.close()
console.log('PHASE2 DONE')
