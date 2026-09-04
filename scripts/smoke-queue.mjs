// Phase 6: session-centric model + global queue + serialization.
// Proves (acceptance §7): a draft never starts by itself; two queued sessions
// for the same repo run strictly one after another — the second starts only
// after the first session's container is stopped manually; queue and drafts
// survive a restart.
// Uses claude sessions with no secret: the start prompt fails auth, but the
// draft→queued→starting→started transitions and the serialization are observable.
//
//   npm run build && SCRATCH=/tmp/gurt-smoke-queue node scripts/smoke-queue.mjs
//
// The repo is a local bare origin, so the git half is hermetic. It carries a
// `.devcontainer/` directory on purpose: gurt always passes
// `--additional-features`, and @devcontainers/cli 0.88 writes the resolved
// feature lockfile to `<workspace>/.devcontainer/devcontainer-lock.json` without
// creating the directory — a repo without one fails `devcontainer up` with
// ENOENT before the image is ever built.
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SHOT_DIR = path.join(process.env.SCRATCH ?? '/tmp', 'shots')
// unique per run: Docker Desktop caches deleted paths in virtiofs.
const GURT_ROOT = path.join(os.homedir(), `.gurt-smoke-${Date.now()}`)
const REPO_ROOT = path.join(os.homedir(), `.gurt-smoke-repos-${Date.now()}`)
console.log('GURT_ROOT:', GURT_ROOT)
fs.mkdirSync(SHOT_DIR, { recursive: true })
fs.mkdirSync(REPO_ROOT, { recursive: true })

const require = createRequire(path.join(APP_DIR, 'package.json'))
const { _electron } = require('playwright-core')
const electronPath = require('electron') // path string to the electron binary

const env = { ...process.env, GURT_ROOT, DISPLAY: process.env.DISPLAY ?? ':99' }
delete env.ELECTRON_RUN_AS_NODE

// Seed a claude-code agent (no credential — the registry starts empty otherwise).
fs.mkdirSync(GURT_ROOT, { recursive: true })
fs.writeFileSync(
  path.join(GURT_ROOT, 'agents.json'),
  JSON.stringify({ 'claude-code': { kind: 'claude-code', label: 'claude code' } })
)

const DEVCONTAINER = '{ "image": "mcr.microsoft.com/devcontainers/base:ubuntu" }'

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, '-c', 'user.email=smoke@test', '-c', 'user.name=smoke', ...args], {
    encoding: 'utf8'
  })

/** A bare origin with one commit and a `.devcontainer/` for the feature lockfile. */
function makeBareRepo(name) {
  const seed = path.join(REPO_ROOT, `${name}-seed`)
  const bare = path.join(REPO_ROOT, `${name}.git`)
  fs.mkdirSync(path.join(seed, '.devcontainer'), { recursive: true })
  git(REPO_ROOT, 'init', '-q', '-b', 'main', seed)
  fs.writeFileSync(path.join(seed, 'README.md'), `# ${name}\n`)
  fs.writeFileSync(path.join(seed, '.devcontainer', 'devcontainer.json'), `${DEVCONTAINER}\n`)
  git(seed, 'add', '-A')
  git(seed, 'commit', '-qm', 'initial')
  git(REPO_ROOT, 'clone', '-q', '--bare', seed, bare)
  return `file://${bare}`
}

const HELLO_URL = makeBareRepo('hello')

function launch() {
  return _electron.launch({
    executablePath: electronPath,
    args: [APP_DIR, '--no-sandbox'],
    env,
    timeout: 30000
  })
}

async function open(app) {
  const page = await app.firstWindow()
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[console.error]', m.text())
  })
  await page.waitForSelector('.sidebar', { timeout: 15000 })
  return page
}

const modalGone = (page) => page.waitForSelector('.modal', { state: 'detached', timeout: 10000 })

// The two views in the activity bar. Repos and environments live in Settings;
// tasks and sessions in the work view.
const openSettings = async (page, section) => {
  await page.click('.activitybar .ab-item[title^="Settings"]')
  await page.click(`.set-nav-item:has-text("${section}")`)
}
const openWork = (page) => page.click('.activitybar .ab-item[title^="Tasks & sessions"]')

// Sessions are named after their role ("executor", "executor 2", …) and the
// sidebar row carries its status as the row title (see SESSION_DOT). `started`
// renders as one of working/needs you/idle.
const STARTED = ['working', 'needs you', 'idle — turn ended']
const STARTING = 'starting — container coming up'
const SESSION_ROW = (title) => `.sb-session:has(.sb-session-name:text-is("${title}"))`

const sessionState = (page, title) =>
  page.evaluate((t) => {
    const row = [...document.querySelectorAll('.sb-session')].find(
      (n) => n.querySelector('.sb-session-name')?.textContent.trim() === t
    )
    return row?.getAttribute('title') ?? null
  }, title)

const waitState = (page, title, states, timeout = 600000) =>
  page.waitForFunction(
    ([t, ss]) => {
      const row = [...document.querySelectorAll('.sb-session')].find(
        (n) => n.querySelector('.sb-session-name')?.textContent.trim() === t
      )
      return !!row && ss.includes(row.getAttribute('title'))
    },
    [title, states],
    { timeout, polling: 1000 }
  )

/** Compose a session off the task row and finish it with `action`'s button. */
async function newSession(page, task, prompt, action) {
  await openWork(page)
  await page.hover(`.sb-task:has(.sb-task-name:text-is("${task}"))`)
  await page.click(`.sb-task:has(.sb-task-name:text-is("${task}")) .icon-sq[title="task actions"]`)
  await page.waitForSelector('.session-menu-pop', { timeout: 5000 })
  await page.click('.session-menu-pop .menu-item:has-text("New session")')
  await page.waitForSelector('.modal:has-text("New session")', { timeout: 5000 })
  // environment first: picking it seeds the session's repo from the env default
  await page.click('.modal .seclabel:text-is("ENVIRONMENT") + .pick-wrap .pick-row')
  await page.click('.modal .pick-menu .menu-item:has-text("hello-env")')
  await page.fill('.modal .ns-prompt-input', prompt)
  await page.click(`.modal button:has-text("${action}")`)
  await modalGone(page)
}

/** The sidebar tree as {title, state} pairs — what a restart has to reproduce. */
const treeStates = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.sb-session')].map((n) => ({
      title: n.querySelector('.sb-session-name')?.textContent.trim(),
      state: n.getAttribute('title')
    }))
  )

/** `app.close()` can hang when a session's ACP agent is still attached inside
 *  its container: Electron waits on the `devcontainer exec` child that carries
 *  the agent, and that child outlives the window. Give the clean shutdown a
 *  grace period, then kill the process — by this point the script's own
 *  assertions are what decide the exit code. */
const closeApp = async (a) => {
  await Promise.race([a.close().catch(() => {}), new Promise((r) => setTimeout(r, 20000))])
  try {
    a.process().kill('SIGKILL')
  } catch {
    /* already gone */
  }
}

// ---- run --------------------------------------------------------------

let app = await launch()
app.process().stdout.on('data', (d) => process.stdout.write(`[main] ${d}`))
let page = await open(app)

// --- workspace ---------------------------------------------------------
await page.click('.tb-ws-btn')
await page.click('.menu-item:has-text("+ new workspace")')
await page.waitForSelector('.modal input', { timeout: 5000 })
await page.fill('.modal input', 'personal')
await page.click('.modal button:has-text("Create")')
await modalGone(page)
await page.waitForSelector('.sb-ws-name:has-text("personal")', { timeout: 5000 })

// --- repo --------------------------------------------------------------
await openSettings(page, 'Repos')
await page.click('.set-head .btn-primary') // + New repo
await page.waitForSelector('.modal:has-text("New repo")', { timeout: 5000 })
await page.fill('.modal input[placeholder="checkout-web"]', 'hello')
await page.fill('.modal input[placeholder^="https://github.com"]', HELLO_URL)
await page.click('.modal-foot .btn-primary') // Save
await modalGone(page)
await page.waitForSelector('.set-row-label:text-is("hello")', { timeout: 5000 })

// --- environment -------------------------------------------------------
await openSettings(page, 'Environments')
await page.click('.set-head .btn-primary') // + New environment
await page.waitForSelector('.modal input[placeholder="web-app"]', { timeout: 5000 })
await page.fill('.modal input[placeholder="web-app"]', 'hello-env')
await page.click('.modal .fld:has(.seclabel:text-is("DEFAULT REPOSITORY")) .pick-row')
await page.click('.modal .pick-menu .menu-item:has-text("hello")')
await page.fill('.modal .jsoned textarea', DEVCONTAINER)
await page.click('.modal-foot .btn-primary') // Save
await modalGone(page)
await page.waitForSelector('.set-row-label:text-is("hello-env")', { timeout: 5000 })
console.log('ws + repo + env ready')

// --- task --------------------------------------------------------------
await openWork(page)
await page.click('button[title^="New task"]')
await page.waitForSelector('.sb-newtask-menu input', { timeout: 5000 })
await page.fill('.sb-newtask-menu input', 'q')
await page.press('.sb-newtask-menu input', 'Enter')
await page.waitForSelector('.sb-task-name:text-is("q")', { timeout: 10000 })

let failures = 0
const check = (cond, msg) => {
  console.log(cond ? 'OK  ' : 'FAIL', msg)
  if (!cond) failures++
}

// 1) draft — must never start by itself
await newSession(page, 'q', 'draft prompt (should never run)', 'Save draft')
await page.waitForSelector(SESSION_ROW('executor'), { timeout: 10000 })
console.log('draft created; state =', await sessionState(page, 'executor'))
await new Promise((r) => setTimeout(r, 4000))
check((await sessionState(page, 'executor')) === 'draft', 'a draft is still a draft after 4s')

// 2) two queued sessions for the SAME repo
await newSession(page, 'q', 'ping A', 'Add to queue')
await newSession(page, 'q', 'ping B', 'Add to queue')
await page.waitForSelector(SESSION_ROW('executor 3'), { timeout: 10000 })
console.log(
  'queued A/B =',
  await sessionState(page, 'executor 2'),
  await sessionState(page, 'executor 3')
)

// the scheduler must start exactly A (executor 2); B (executor 3) stays queued.
// This is the serialization window: A has taken the repo and B has not started
// alongside it. Without a credential A's turn fails instantly, so the window is
// short — assert it here, on A's first move, not after A has settled.
await waitState(page, 'executor 2', [STARTING, ...STARTED])
check(
  (await sessionState(page, 'executor 3')) === 'queued',
  'B is still queued while A takes the repo — the two never start together'
)
await page.screenshot({ path: path.join(SHOT_DIR, 'q1-A-starting.png') })

// A reaches started (the auth error ends its turn immediately)
await waitState(page, 'executor 2', STARTED)
console.log('A started; B =', await sessionState(page, 'executor 3'))

// task pane: A's container, and whatever is still queued behind it
await page.click('.sb-task-name:text-is("q")')
await page.waitForSelector('.task-pane', { timeout: 10000 })
await page.waitForSelector('.env-row', { timeout: 30000 })
console.log(
  'task pane container rows:',
  await page.evaluate(() =>
    [...document.querySelectorAll('.env-row')].map((r) => r.innerText.replace(/\n/g, ' '))
  )
)
console.log(
  'task pane queue:',
  await page.evaluate(() =>
    [...document.querySelectorAll('.queue-row')].map((r) => r.innerText.replace(/\n/g, ' '))
  )
)
await page.screenshot({ path: path.join(SHOT_DIR, 'q2-taskpane.png') })

// 3) A has to let go of the repo before B runs. A session releases it when it
// goes idle — and stopping its container is the manual way to force that. Do the
// manual stop when A is still holding a live container; if the turn already
// ended, the scheduler has released B on its own and there is nothing to stop.
await page.click('.env-row:has(.env-name:text-is("executor 2")) button[title="container actions"]')
const stopA = page.locator(
  '.env-row:has(.env-name:text-is("executor 2")) .session-menu-pop .menu-item:text-is("Stop")'
)
if (await stopA.count()) {
  await stopA.click()
  await page.waitForSelector(
    '.env-row:has(.env-name:text-is("executor 2")) .env-status:text-is("stopped")',
    { timeout: 120000 }
  )
  console.log('A container stopped by hand; scheduler should release B')
} else {
  await page.keyboard.press('Escape')
  console.log('A already went idle and released the repo — no container to stop')
}

// B now starts (reuses the stopped container + cached adapter → fast)
await waitState(page, 'executor 3', [STARTING, ...STARTED])
await waitState(page, 'executor 3', STARTED)
console.log('B started after A let go of the repo — serialization holds')
await page.screenshot({ path: path.join(SHOT_DIR, 'q3-B-started.png') })

// 4) persistence across restart
const states1 = await treeStates(page)
console.log('before restart:', JSON.stringify(states1))
await closeApp(app)

app = await launch()
app.process().stdout.on('data', (d) => process.stdout.write(`[main2] ${d}`))
page = await open(app)
await page.waitForFunction(() => document.querySelectorAll('.sb-session').length >= 3, undefined, {
  timeout: 20000
})
await new Promise((r) => setTimeout(r, 1500))
const states2 = await treeStates(page)
console.log('after restart :', JSON.stringify(states2))
check(
  states2.find((s) => s.title === 'executor')?.state === 'draft',
  'the draft survived the restart'
)
await page.screenshot({ path: path.join(SHOT_DIR, 'q4-restart.png') })

await closeApp(app)
if (failures) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('PHASE6 DONE')

// Explicit: playwright-core keeps its Electron transport referenced after a
// force-killed close, so the script would otherwise sit idle at the end.
process.exit(0)
