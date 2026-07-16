// Phase 4: iteration-2 features. CRUD (repos/tasks), env stop/delete via the
// task pane, per-session agent, codex adapter handshake. Requires docker.
// Session-centric: envs are born when a session runs; claude session on "hello",
// codex session on "hello2" (auth errors expected — no secrets configured).
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

// session mark (fine-grained status) of the session titled `title`
const sessionMark = (title) =>
  page.evaluate((t) => {
    const node = [...document.querySelectorAll('.session-node')].find(
      (n) => n.querySelector('.node-label')?.textContent.trim() === t
    )
    const mark = node?.querySelector('.session-mark')
    return mark && [...mark.classList].find((c) => c.startsWith('mark-'))?.slice(5)
  }, title)

const waitMark = (title, states, timeout = 600000) =>
  page.waitForFunction(
    ([t, ss]) => {
      const node = [...document.querySelectorAll('.session-node')].find(
        (n) => n.querySelector('.node-label')?.textContent.trim() === t
      )
      const mark = node?.querySelector('.session-mark')
      const st = mark && [...mark.classList].find((c) => c.startsWith('mark-'))?.slice(5)
      return st && ss.includes(st)
    },
    [title, states],
    { timeout, polling: 1000 }
  )

// task-pane env row helpers, matched by repo name (`hello —` never matches `hello2 —`)
const envAction = (repo, action) =>
  page.evaluate(
    ([r, a]) => {
      const row = [...document.querySelectorAll('.env-table tr')].find((tr) =>
        tr.querySelector('.env-cell')?.textContent.includes(`${r} —`)
      )
      ;[...(row?.querySelectorAll('.env-actions button') ?? [])]
        .find((b) => b.textContent.trim() === a)
        ?.click()
    },
    [repo, action]
  )
const waitEnvStatus = (repo, status, timeout = 120000) =>
  page.waitForFunction(
    ([r, s]) => {
      const row = [...document.querySelectorAll('.env-table tr')].find((tr) =>
        tr.querySelector('.env-cell')?.textContent.includes(`${r} —`)
      )
      return !!row?.querySelector(`.status-${s}`)
    },
    [repo, status],
    { timeout, polling: 1000 }
  )

async function newSession(repo, agent, prompt) {
  await clickTitle('new session')
  await page.waitForSelector('.modal textarea')
  await page.selectOption('.modal label:has-text("repo") select', repo)
  await page.selectOption('.modal label:has-text("agent") select', agent)
  await page.fill('.modal textarea', prompt)
  await clickText('.modal .row-buttons', 'Run now')
  await modalGone()
}

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
  // Match by the label input's value — every block's kind <select> contains a
  // "codex" option, so textContent matching would hit the wrong block.
  const block = [...document.querySelectorAll('.agent-block')].find(
    (b) => b.querySelector('.agent-label')?.value === 'codex'
  )
  const cb = block?.querySelector('input[type="checkbox"]')
  if (cb && !cb.checked) cb.click()
})
await clickText('.modal', 'Save')
await modalGone()
console.log('codex enabled')

// task
await clickTitle('new task')
await page.waitForSelector('.modal input')
await page.fill('.modal input', 'try2')
await page.click('.modal .form > button')
await modalGone()

// claude session on hello — births and provisions the env
await newSession('hello', 'claude-code', 'ping')
console.log('claude session starting...')
await waitMark('session 1', ['running', 'waiting', 'idle'])
console.log('claude session started; mark =', await sessionMark('session 1'))

// chat: prompt + auth-error reply
await page.evaluate(() => {
  const node = [...document.querySelectorAll('.session-node')].find(
    (n) => n.querySelector('.node-label')?.textContent.trim() === 'session 1'
  )
  node?.querySelector('.node-label')?.click()
})
await page.waitForSelector('.chat-log', { timeout: 15000 })
await page.waitForSelector('.entry-text', { timeout: 120000 })
await new Promise((r) => setTimeout(r, 1500))
console.log('--- claude chat ---')
console.log(await page.evaluate(() => document.querySelector('.chat-log')?.innerText))
await page.screenshot({ path: path.join(SHOT_DIR, '09-chat2.png') })

// stop claude env from the task pane
await page.evaluate(() => {
  const node = [...document.querySelectorAll('.task-node')].find((n) => n.textContent.includes('try2'))
  node?.querySelector('.node-label')?.click()
})
await page.waitForSelector('.task-pane')
await envAction('hello', 'Stop')
await waitEnvStatus('hello', 'stopped')
console.log('claude env stopped')

// codex session on hello2 (handshake check; auth may fail — that's data too)
await newSession('hello2', 'codex', 'ping')
console.log('codex session starting...')
await waitMark('session 2', ['running', 'waiting', 'idle'])
console.log('codex session started (ACP handshake OK); mark =', await sessionMark('session 2'))
await page.evaluate(() => {
  const node = [...document.querySelectorAll('.session-node')].find(
    (n) => n.querySelector('.node-label')?.textContent.trim() === 'session 2'
  )
  node?.querySelector('.node-label')?.click()
})
await page.waitForSelector('.chat-log', { timeout: 15000 })
try {
  await page.waitForSelector('.entry-text, .perm-card', { timeout: 90000 })
  await new Promise((r) => setTimeout(r, 1500))
  console.log('--- codex chat ---')
  console.log(await page.evaluate(() => document.querySelector('.chat-log')?.innerText))
} catch (e) {
  console.log('codex chat step failed:', e.message.slice(0, 200))
}
await page.screenshot({ path: path.join(SHOT_DIR, '10-codex.png') })

// stop + delete codex env (confirm auto-accepted); clone dir must be gone
await page.evaluate(() => {
  const node = [...document.querySelectorAll('.task-node')].find((n) => n.textContent.includes('try2'))
  node?.querySelector('.node-label')?.click()
})
await page.waitForSelector('.task-pane')
await envAction('hello2', 'Stop')
await waitEnvStatus('hello2', 'stopped')
await envAction('hello2', 'Delete')
await page.waitForFunction(
  () => ![...document.querySelectorAll('.env-cell')].some((c) => c.textContent.includes('hello2 —')),
  { timeout: 60000 }
)
console.log('codex env deleted; clone exists:', fs.existsSync(path.join(GURT_ROOT, 'personal', 'try2', 'hello2')))

// delete the task (confirm auto-accepted)
await page.evaluate(() => {
  const node = [...document.querySelectorAll('.task-node')].find((n) => n.textContent.includes('try2'))
  node.querySelector('button[title="delete task"]').click()
})
await page.waitForFunction(() => document.querySelectorAll('.task-node').length === 0, { timeout: 60000 })
console.log('task deleted; task dir exists:', fs.existsSync(path.join(GURT_ROOT, 'personal', 'try2')))

await page.screenshot({ path: path.join(SHOT_DIR, '11-final.png') })
await app.close()
console.log('PHASE4 DONE')
