// Phase 5: focused codex-in-gurt test. Run one codex session (its container is
// provisioned on start), verify the session header names codex, and expect an
// auth error — reaching it still proves the whole pipe: install, spawn,
// initialize, session/new round-trip, error surfaced in the UI.
//
//   npm run build && SCRATCH=/tmp/gurt-smoke-codex node scripts/smoke-codex.mjs
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

// Seed the codex agent (no credential — auth error expected). The registry
// starts empty, so it must be added before it is selectable.
fs.mkdirSync(GURT_ROOT, { recursive: true })
fs.writeFileSync(
  path.join(GURT_ROOT, 'agents.json'),
  JSON.stringify({ codex: { kind: 'codex', label: 'codex' } })
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

const app = await _electron.launch({
  executablePath: electronPath,
  args: [APP_DIR, '--no-sandbox'],
  env,
  timeout: 30000
})
app.process().stdout.on('data', (d) => process.stdout.write(`[main] ${d}`))
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

const page = await app.firstWindow()
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text())
})

const modalGone = () => page.waitForSelector('.modal', { state: 'detached', timeout: 10000 })

// The two views in the activity bar. Repos and environments live in Settings;
// tasks and sessions in the work view.
const openSettings = async (section) => {
  await page.click('.activitybar .ab-item[title="Settings"]')
  await page.click(`.set-nav-item:has-text("${section}")`)
}
const openWork = () => page.click('.activitybar .ab-item[title="Tasks & sessions"]')

await page.waitForSelector('.sidebar', { timeout: 15000 })

// --- workspace ---------------------------------------------------------
await page.click('.sb-ws-btn')
await page.click('.menu-item:has-text("+ new workspace")')
await page.waitForSelector('.modal input', { timeout: 5000 })
await page.fill('.modal input', 'p')
await page.click('.modal button:has-text("Create")')
await modalGone()
await page.waitForSelector('.sb-ws-name:has-text("p")', { timeout: 5000 })

// --- repo --------------------------------------------------------------
await openSettings('Repos')
await page.click('.set-head .btn-primary') // + New repo
await page.waitForSelector('.modal:has-text("New repo")', { timeout: 5000 })
await page.fill('.modal input[placeholder="checkout-web"]', 'hello')
await page.fill('.modal input[placeholder^="https://github.com"]', HELLO_URL)
await page.click('.modal-foot .btn-primary') // Save
await modalGone()
await page.waitForSelector('.set-row-label:text-is("hello")', { timeout: 5000 })

// --- environment -------------------------------------------------------
await openSettings('Environments')
await page.click('.set-head .btn-primary') // + New environment
await page.waitForSelector('.modal input[placeholder="web-app"]', { timeout: 5000 })
await page.fill('.modal input[placeholder="web-app"]', 'hello-env')
await page.click('.modal .fld:has(.seclabel:text-is("DEFAULT REPOSITORY")) .pick-row')
await page.click('.modal .pick-menu .menu-item:has-text("hello")')
await page.fill('.modal .jsoned textarea', DEVCONTAINER)
await page.click('.modal-foot .btn-primary') // Save
await modalGone()
await page.waitForSelector('.set-row-label:text-is("hello-env")', { timeout: 5000 })

// --- task --------------------------------------------------------------
await openWork()
await page.click('button[title="New task · ⌘⇧N"]')
await page.waitForSelector('.sb-newtask-menu input', { timeout: 5000 })
await page.fill('.sb-newtask-menu input', 't')
await page.press('.sb-newtask-menu input', 'Enter')
await page.waitForSelector('.sb-task-name:text-is("t")', { timeout: 10000 })

// --- codex session — this is what provisions the container -------------
await page.hover('.sb-task:has(.sb-task-name:text-is("t"))')
await page.click('.sb-task:has(.sb-task-name:text-is("t")) .icon-sq[title="new session"]')
await page.waitForSelector('.modal:has-text("New session")', { timeout: 5000 })
// environment first: picking it seeds the session's repo from the env default
await page.click('.modal .seclabel:text-is("ENVIRONMENT") + .pick-wrap .pick-row')
await page.click('.modal .pick-menu .menu-item:has-text("hello-env")')
await page.click('.modal .seclabel:text-is("AGENT") + .pick-wrap .pick-row')
await page.click('.modal .pick-menu .menu-item:has-text("codex")')
await page.fill('.modal .ns-prompt-input', 'ping')
await page.click('.modal button:has-text("Run now")')
await modalGone()
console.log('provisioning codex container...')

// Sessions are named after their role, and the sidebar row carries its status
// as the row title (see SESSION_DOT).
const STARTED = ['working', 'needs you', 'idle — turn ended']
await page.waitForFunction(
  (ss) => {
    if (document.querySelector('.env-error')) return true
    const row = document.querySelector('.sb-session')
    return !!row && ss.includes(row.getAttribute('title'))
  },
  STARTED,
  { timeout: 600000, polling: 2000 }
)
// Keyless codex refuses session/new with 'Authentication required' (every
// codex-acp version does) — that outcome still proves the whole pipe: install,
// spawn, initialize, session/new round-trip, error surfaced in the UI. Any
// other start error is a real failure.
const startErr = await page.evaluate(() => document.querySelector('.env-error')?.innerText)
if (startErr && !/Authentication required|not logged in|login/i.test(startErr)) {
  console.log('SESSION START FAILED:', startErr)
  await closeApp(app)
  process.exit(1)
}
console.log(
  startErr
    ? 'codex refused without a key at session/new (ACP pipe proven)'
    : 'codex session started (ACP handshake OK)'
)

// open the session; the header pill must name codex (right session opened)
await page.click('.sb-session')
await page.waitForSelector('.chat-head', { timeout: 15000 })
const header = await page.evaluate(() => document.querySelector('.chat-head')?.innerText)
console.log('session header:', JSON.stringify(header))
if (!header.includes('codex')) {
  console.log('WRONG SESSION OPENED')
  await closeApp(app)
  process.exit(1)
}
if (startErr) {
  // A never-started session renders the draft pane, not a timeline — the
  // error banner is the assertion.
  console.log('--- codex draft pane ---')
  console.log(await page.evaluate(() => document.querySelector('.env-error')?.innerText))
} else {
  await page.waitForSelector('.msg-sys, .msg-text.markdown, .perm-head', { timeout: 120000 })
  await new Promise((r) => setTimeout(r, 1500))
  console.log('--- codex chat ---')
  console.log(await page.evaluate(() => document.querySelector('.feed')?.innerText))
}
await page.screenshot({ path: path.join(SHOT_DIR, '10-codex.png') })
await closeApp(app)
console.log('PHASE5 DONE')

// Explicit: playwright-core keeps its Electron transport referenced after a
// force-killed close, so the script would otherwise sit idle at the end.
process.exit(0)
