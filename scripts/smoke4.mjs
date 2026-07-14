// Phase 4: iteration-2 features. CRUD (repos/envs/tasks), env stop/delete,
// per-env agent, codex adapter handshake. Requires docker.
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

const app = await _electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [APP_DIR],
  env,
  timeout: 30000
})
app.process().stdout.on('data', (d) => process.stdout.write(`[main] ${d}`))
const page = await app.firstWindow()
page.on('dialog', (d) => {
  console.log('[dialog]', d.type(), d.message().slice(0, 100))
  d.accept().catch(() => {})
})

const clickTitle = (t) => page.evaluate((x) => document.querySelector(`button[title="${x}"]`)?.click(), t)
const clickText = (scope, text) =>
  page.evaluate(
    ([sc, tx]) => {
      const b = [...document.querySelectorAll(`${sc} button`)].find((b) => b.textContent.trim() === tx)
      if (!b) return 'NOT_FOUND'
      b.click()
      return 'OK'
    },
    [scope, text]
  )
const modalGone = () => page.waitForSelector('.modal', { state: 'detached' })

await page.waitForSelector('.sidebar', { timeout: 15000 })

// workspace
await clickTitle('new workspace')
await page.waitForSelector('.modal input')
await page.fill('.modal input', 'personal')
await page.click('.modal .form > button')
await modalGone()
console.log('ws created')

// repos modal: add hello, add tmp, edit tmp, delete tmp
await clickTitle('repos')
await page.waitForSelector('.modal')
async function addRepoInModal(name, url, dc) {
  await clickText('.modal', 'Add repo')
  await page.waitForSelector('.modal .repo-form input')
  await page.fill('.modal .repo-form input[placeholder="name"]', name)
  await page.fill('.modal .repo-form input[placeholder*="git url"]', url)
  if (dc) await page.fill('.modal .repo-form textarea', dc)
  await clickText('.repo-form', 'Add')
  await page.waitForFunction((n) => [...document.querySelectorAll('.repo-row')].some((r) => r.textContent.includes(n)), name)
}
await addRepoInModal('hello', 'https://github.com/octocat/Hello-World.git', '{ "image": "mcr.microsoft.com/devcontainers/base:ubuntu" }')
await addRepoInModal('tmp', 'https://example.com/x.git', '')
console.log('repos added')
// edit tmp
await page.evaluate(() => {
  const row = [...document.querySelectorAll('.repo-row')].find((r) => r.textContent.includes('tmp'))
  row?.querySelector('button[title="edit repo"]')?.click()
})
await page.waitForSelector('.modal .repo-form')
await page.fill('.modal .repo-form input[placeholder*="git url"]', 'https://example.com/y.git')
await clickText('.repo-form', 'Save')
await page.waitForFunction(() => [...document.querySelectorAll('.repo-row')].some((r) => r.textContent.includes('example.com/y')))
console.log('repo edited')
// second repo for codex
await addRepoInModal('hello2', 'https://github.com/octocat/Hello-World.git', '{ "image": "mcr.microsoft.com/devcontainers/base:ubuntu" }')
// delete tmp
await page.evaluate(() => {
  const row = [...document.querySelectorAll('.repo-row')].find((r) => r.textContent.includes('tmp'))
  row?.querySelector('button[title="delete repo"]')?.click()
})
await page.waitForFunction(() => ![...document.querySelectorAll('.repo-row')].some((r) => r.textContent.includes('tmp')))
console.log('repo deleted')
await page.screenshot({ path: path.join(SHOT_DIR, '08-repos.png') })
await page.click('.modal-header .icon-btn')
await modalGone()

// enable codex in agents
await clickTitle('agents')
await page.waitForSelector('.modal')
await page.evaluate(() => {
  const block = [...document.querySelectorAll('.agent-block')].find((b) => b.textContent.includes('codex'))
  const cb = block?.querySelector('input[type="checkbox"]')
  if (cb && !cb.checked) cb.click()
})
await clickText('.modal', 'Save')
await modalGone()
console.log('codex enabled')

// task + envs
await clickTitle('new task')
await page.waitForSelector('.modal input')
await page.fill('.modal input', 'try2')
await page.click('.modal .form > button')
await modalGone()
await clickTitle('add environment')
await page.waitForSelector('.modal select')
await page.selectOption('.modal select', 'claude-code')
await page.evaluate(() => [...document.querySelectorAll('.modal .form button')].find((b) => b.textContent.includes('hello ')).click())
await modalGone()
await clickTitle('add environment')
await page.waitForSelector('.modal select')
await page.selectOption('.modal select', 'codex')
await page.evaluate(() => [...document.querySelectorAll('.modal .form button')].find((b) => b.textContent.includes('hello2')).click())
await modalGone()
const badges = await page.evaluate(() => [...document.querySelectorAll('.env-node')].map((n) => n.textContent.trim()))
console.log('envs:', JSON.stringify(badges))

// start claude env
await page.evaluate(() => {
  const node = [...document.querySelectorAll('.env-node')].find((n) => n.querySelector('.node-label').textContent.trim() === 'hello')
  node.querySelector('.node-label').click()
  node.querySelector('button[title="start environment"]').click()
})
console.log('claude env starting...')
await page.waitForFunction(
  () => {
    const node = [...document.querySelectorAll('.env-node')].find((n) => n.querySelector('.node-label').textContent.trim() === 'hello')
    return node?.querySelector('.status-running') || node?.querySelector('.status-error')
  },
  { timeout: 600000, polling: 2000 }
)
let st = await page.evaluate(() => [...document.querySelectorAll('.env-node')].map((n) => n.querySelector('.status').className))
console.log('claude env status:', JSON.stringify(st))

// session + prompt (auth error expected)
await page.evaluate(() => {
  ;[...document.querySelectorAll('.env-pane button')].find((b) => b.textContent.trim() === 'New session')?.click()
})
await page.waitForSelector('.chat-input', { timeout: 60000 })
await page.fill('.chat-input textarea', 'ping')
await page.click('.chat-input button')
await page.waitForSelector('.entry-system, .entry-agent', { timeout: 120000 })
await new Promise((r) => setTimeout(r, 1500))
console.log('--- claude chat ---')
console.log(await page.evaluate(() => document.querySelector('.chat-log')?.innerText))
await page.screenshot({ path: path.join(SHOT_DIR, '09-chat2.png') })

// stop claude env
await page.evaluate(() => {
  const node = [...document.querySelectorAll('.env-node')].find((n) => n.querySelector('.node-label').textContent.trim() === 'hello')
  node.querySelector('.node-label').click()
})
await page.waitForSelector('.env-pane')
await clickText('.env-pane', 'Stop')
await page.waitForFunction(
  () => {
    const node = [...document.querySelectorAll('.env-node')].find((n) => n.querySelector('.node-label').textContent.trim() === 'hello')
    return node?.querySelector('.status-stopped')
  },
  { timeout: 120000, polling: 1000 }
)
console.log('claude env stopped')

// start codex env, create session (handshake check; auth may fail — that's data too)
await page.evaluate(() => {
  const node = [...document.querySelectorAll('.env-node')].find((n) => n.querySelector('.node-label').textContent.trim() === 'hello2')
  node.querySelector('.node-label').click()
  node.querySelector('button[title="start environment"]').click()
})
console.log('codex env starting...')
await page.waitForFunction(
  () => {
    const node = [...document.querySelectorAll('.env-node')].find((n) => n.querySelector('.node-label').textContent.trim() === 'hello2')
    return node?.querySelector('.status-running') || node?.querySelector('.status-error')
  },
  { timeout: 600000, polling: 2000 }
)
st = await page.evaluate(() => {
  const node = [...document.querySelectorAll('.env-node')].find((n) => n.querySelector('.node-label').textContent.trim() === 'hello2')
  return node.querySelector('.status').className
})
console.log('codex env status:', st)
if (st.includes('running')) {
  await page.evaluate(() => {
    ;[...document.querySelectorAll('.env-pane button')].find((b) => b.textContent.trim() === 'New session')?.click()
  })
  try {
    await page.waitForSelector('.chat-input', { timeout: 60000 })
    console.log('codex session created (ACP handshake OK)')
    await page.fill('.chat-input textarea', 'ping')
    await page.click('.chat-input button')
    await page.waitForSelector('.entry-system, .entry-agent, .entry-permission', { timeout: 90000 })
    await new Promise((r) => setTimeout(r, 1500))
    console.log('--- codex chat ---')
    console.log(await page.evaluate(() => document.querySelector('.chat-log')?.innerText))
  } catch (e) {
    console.log('codex session failed:', e.message.slice(0, 200))
  }
  await page.screenshot({ path: path.join(SHOT_DIR, '10-codex.png') })
}

// delete codex env (confirm auto-accepted), then delete task
await page.evaluate(() => {
  const node = [...document.querySelectorAll('.env-node')].find((n) => n.querySelector('.node-label').textContent.trim() === 'hello2')
  node.querySelector('.node-label').click()
})
await page.waitForSelector('.env-pane')
await clickText('.env-pane', 'Stop').catch(() => {})
await page.waitForFunction(
  () => {
    const node = [...document.querySelectorAll('.env-node')].find((n) => n.querySelector('.node-label')?.textContent.trim() === 'hello2')
    return node?.querySelector('.status-stopped')
  },
  { timeout: 120000, polling: 1000 }
)
await clickText('.env-pane', 'Delete')
await page.waitForFunction(
  () => ![...document.querySelectorAll('.env-node')].some((n) => n.querySelector('.node-label')?.textContent.trim() === 'hello2'),
  { timeout: 60000 }
)
console.log('codex env deleted; clone exists:', fs.existsSync(path.join(GURT_ROOT, 'personal', 'try2', 'hello2')))

await page.evaluate(() => {
  const node = [...document.querySelectorAll('.task-node')].find((n) => n.textContent.includes('try2'))
  node.querySelector('button[title="delete task"]').click()
})
await page.waitForFunction(() => document.querySelectorAll('.task-node').length === 0, { timeout: 60000 })
console.log('task deleted; task dir exists:', fs.existsSync(path.join(GURT_ROOT, 'personal', 'try2')))

await page.screenshot({ path: path.join(SHOT_DIR, '11-final.png') })
await app.close()
console.log('PHASE4 DONE')
