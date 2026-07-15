// Phase 6: session-centric model + global queue + serialization.
// Proves (acceptance §7): draft never starts by itself; two queued sessions
// for the same repo run strictly one after another — the second starts only
// after the first env is stopped manually; queue/drafts survive restart.
// Uses claude sessions with no secret: the start prompt fails auth, but the
// draft→queued→starting→started transitions and serialization are observable.
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const APP_DIR = '/Users/klerik3d/workspace/personal/gurt'
const SHOT_DIR = path.join(process.env.SCRATCH ?? '/tmp', 'shots')
// unique per run: Docker Desktop caches deleted paths in virtiofs.
const GURT_ROOT = path.join(os.homedir(), `.gurt-smoke-${Date.now()}`)
console.log('GURT_ROOT:', GURT_ROOT)
fs.mkdirSync(SHOT_DIR, { recursive: true })

const require = createRequire(path.join(APP_DIR, 'package.json'))
const { _electron } = require('playwright-core')

const env = { ...process.env, GURT_ROOT }
delete env.ELECTRON_RUN_AS_NODE

const EXE = path.join(
  APP_DIR,
  'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
)

function launch() {
  return _electron.launch({ executablePath: EXE, args: [APP_DIR], env, timeout: 30000 })
}

async function open(app) {
  const page = await app.firstWindow()
  page.on('dialog', (d) => {
    console.log('[dialog]', d.type(), d.message().slice(0, 90))
    d.accept().catch(() => {})
  })
  await page.waitForSelector('.sidebar', { timeout: 15000 })
  return page
}

const clickTitle = (page, t) =>
  page.evaluate((x) => document.querySelector(`button[title="${x}"]`)?.click(), t)
const clickText = (page, scope, text) =>
  page.evaluate(
    ([sc, tx]) => {
      const b = [...document.querySelectorAll(`${sc} button`)].find(
        (b) => b.textContent.trim() === tx
      )
      b?.click()
    },
    [scope, text]
  )
const modalGone = (page) => page.waitForSelector('.modal', { state: 'detached' })

// state of the session whose title matches, read from the .session-mark class.
const sessionState = (page, title) =>
  page.evaluate((t) => {
    const node = [...document.querySelectorAll('.session-node')].find(
      (n) => n.querySelector('.node-label')?.textContent.trim() === t
    )
    const mark = node?.querySelector('.session-mark')
    if (!mark) return null
    return [...mark.classList].find((c) => c.startsWith('mark-'))?.slice(5) ?? null
  }, title)

const waitState = (page, title, states, timeout = 600000) =>
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

async function newSession(page, prompt, action) {
  await clickTitle(page, 'new session')
  await page.waitForSelector('.modal textarea')
  await page.fill('.modal textarea', prompt)
  await clickText(page, '.modal .row-buttons', action)
  await modalGone(page)
}

// ---- run --------------------------------------------------------------

let app = await launch()
app.process().stdout.on('data', (d) => process.stdout.write(`[main] ${d}`))
let page = await open(app)

// workspace + repo (ubuntu image, no repo devcontainer needed)
await clickTitle(page, 'new workspace')
await page.waitForSelector('.modal input')
await page.fill('.modal input', 'personal')
await page.click('.modal .form > button')
await modalGone(page)

await clickTitle(page, 'repos')
await page.waitForSelector('.modal')
await clickText(page, '.modal', 'Add repo')
await page.waitForSelector('.modal .repo-form input')
await page.fill('.modal .repo-form input[placeholder="name"]', 'hello')
await page.fill(
  '.modal .repo-form input[placeholder*="git url"]',
  'https://github.com/octocat/Hello-World.git'
)
await page.fill(
  '.modal .repo-form textarea',
  '{ "image": "mcr.microsoft.com/devcontainers/base:ubuntu" }'
)
await clickText(page, '.repo-form', 'Add')
await page.waitForFunction(() =>
  [...document.querySelectorAll('.repo-row')].some((r) => r.textContent.includes('hello'))
)
await page.click('.modal-header .icon-btn')
await modalGone(page)
console.log('ws + repo ready')

// task
await clickTitle(page, 'new task')
await page.waitForSelector('.modal input')
await page.fill('.modal input', 'q')
await page.click('.modal .form > button')
await modalGone(page)

// 1) draft — must never start by itself
await newSession(page, 'draft prompt (should never run)', 'Save draft')
console.log('draft created; state =', await sessionState(page, 'session 1'))
await new Promise((r) => setTimeout(r, 4000))
const draftStill = await sessionState(page, 'session 1')
console.log('draft after 4s =', draftStill, draftStill === 'draft' ? 'OK' : 'FAIL')

// 2) two queued sessions for the SAME repo
await newSession(page, 'ping A', 'Add to queue')
await newSession(page, 'ping B', 'Add to queue')
console.log(
  'queued A/B =',
  await sessionState(page, 'session 2'),
  await sessionState(page, 'session 3')
)

// scheduler must start exactly A (session 2); B (session 3) stays queued
await waitState(page, 'session 2', ['starting', 'started'])
console.log('A started provisioning; B =', await sessionState(page, 'session 3'))
await page.screenshot({ path: path.join(SHOT_DIR, 'q1-A-starting.png') })

// A reaches started (auth error inside), B must STILL be queued (serialization)
await waitState(page, 'session 2', ['started'])
const bWhileA = await sessionState(page, 'session 3')
console.log('A started; B while A occupies repo =', bWhileA, bWhileA === 'queued' ? 'OK' : 'FAIL')

// task pane: env running + B queued at a position
await page.evaluate(() => {
  const t = [...document.querySelectorAll('.task-node .node-label')].find(
    (n) => n.textContent.trim() === 'q'
  )
  t?.click()
})
await page.waitForSelector('.task-pane')
await new Promise((r) => setTimeout(r, 500))
console.log(
  'task pane env row:',
  await page.evaluate(() => document.querySelector('.env-cell')?.innerText?.replace(/\n/g, ' '))
)
console.log(
  'task pane queue:',
  await page.evaluate(() =>
    [...document.querySelectorAll('.queue-row')].map((r) => r.innerText.replace(/\n/g, ' '))
  )
)
await page.screenshot({ path: path.join(SHOT_DIR, 'q2-taskpane.png') })

// 3) stop the env manually — the only signal that frees the repo
await clickText(page, '.env-actions', 'Stop')
await page.waitForFunction(
  () => {
    const cell = document.querySelector('.env-cell')
    return cell && /stopped/.test(cell.textContent)
  },
  { timeout: 120000, polling: 1000 }
)
console.log('env stopped; scheduler should release B')

// B now starts (reuses the stopped container + cached adapter → fast)
await waitState(page, 'session 3', ['starting', 'started'])
await waitState(page, 'session 3', ['started'])
console.log('B started after A env stopped — serialization holds')
await page.screenshot({ path: path.join(SHOT_DIR, 'q3-B-started.png') })

// 4) persistence across restart
const states1 = await page.evaluate(() =>
  [...document.querySelectorAll('.session-node')].map((n) => ({
    title: n.querySelector('.node-label')?.textContent.trim(),
    state: [...(n.querySelector('.session-mark')?.classList ?? [])]
      .find((c) => c.startsWith('mark-'))
      ?.slice(5)
  }))
)
console.log('before restart:', JSON.stringify(states1))
await app.close()

app = await launch()
app.process().stdout.on('data', (d) => process.stdout.write(`[main2] ${d}`))
page = await open(app)
await page.waitForFunction(() => document.querySelectorAll('.session-node').length >= 3, {
  timeout: 20000
})
await new Promise((r) => setTimeout(r, 1500))
const states2 = await page.evaluate(() =>
  [...document.querySelectorAll('.session-node')].map((n) => ({
    title: n.querySelector('.node-label')?.textContent.trim(),
    state: [...(n.querySelector('.session-mark')?.classList ?? [])]
      .find((c) => c.startsWith('mark-'))
      ?.slice(5)
  }))
)
console.log('after restart :', JSON.stringify(states2))
const draftSurvived = states2.find((s) => s.title === 'session 1')?.state === 'draft'
console.log('draft survived restart:', draftSurvived ? 'OK' : 'FAIL')
await page.screenshot({ path: path.join(SHOT_DIR, 'q4-restart.png') })

await app.close()
console.log('PHASE6 DONE')
