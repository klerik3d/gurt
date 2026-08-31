// Phase 2 (clean): real provisioning through the UI — requires docker daemon.
// Session-centric flow: a container is born when a session starts, and belongs
// to that one session. Two repos are registered; one session runs on "hello" —
// only that session may own a container, and it must reach running. The prompt
// fails auth (no secret), which still proves the whole devcontainer + ACP pipe.
//
//   npm run build && SCRATCH=/tmp/gurt-smoke-prov node scripts/smoke-provisioning.mjs
//
// The repos are local bare origins, so the git half is hermetic. They carry a
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
// must live under a Docker-Desktop-shared path (/Users) for bind mounts;
// unique per run: Docker Desktop's virtiofs caches deleted paths, so reusing
// a recently-removed directory name breaks bind mounts ("source does not exist")
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

// Seed a claude-code agent (no credential — the prompt fails auth, which still
// proves the pipe). The registry starts empty otherwise.
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

const DEMO_URL = makeBareRepo('demo')
const HELLO_URL = makeBareRepo('hello')

const app = await _electron.launch({
  executablePath: electronPath,
  args: [APP_DIR, '--no-sandbox'],
  env,
  timeout: 30000
})
// stdout only: a 'data' listener on Electron's stderr keeps the pipe referenced
// and the process alive past app.close() ("Waiting for the debugger to
// disconnect…"), and all it carries here is dbus noise from the headless box.
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

await page.waitForSelector('.sidebar', { timeout: 15000 })

const modalGone = () => page.waitForSelector('.modal', { state: 'detached', timeout: 10000 })

// The two views in the activity bar. Repos, environments and clients live in
// Settings; tasks and sessions in the work view.
const openSettings = async (section) => {
  await page.click('.activitybar .ab-item[title^="Settings"]')
  await page.click(`.set-nav-item:has-text("${section}")`)
}
const openWork = () => page.click('.activitybar .ab-item[title^="Tasks & sessions"]')

/** Add a repo through Settings → Repos. */
async function addRepo(name, url) {
  await openSettings('Repos')
  await page.click('.set-head .btn-primary') // + New repo
  await page.waitForSelector('.modal:has-text("New repo")', { timeout: 5000 })
  await page.fill('.modal input[placeholder="checkout-web"]', name)
  await page.fill('.modal input[placeholder^="https://github.com"]', url)
  await page.click('.modal-foot .btn-primary') // Save
  await modalGone()
  await page.waitForSelector(`.set-row-label:text-is("${name}")`, { timeout: 5000 })
  console.log(`repo "${name}" added`)
}

/** Define an environment (name + default repo + devcontainer) in Settings. */
async function addEnv(name, repo) {
  await openSettings('Environments')
  await page.click('.set-head .btn-primary') // + New environment
  await page.waitForSelector('.modal input[placeholder="web-app"]', { timeout: 5000 })
  await page.fill('.modal input[placeholder="web-app"]', name)
  await page.click('.modal .fld:has(.seclabel:text-is("DEFAULT REPOSITORY")) .pick-row')
  await page.click(`.modal .pick-menu .menu-item:has-text("${repo}")`)
  await page.fill('.modal .jsoned textarea', DEVCONTAINER)
  await page.click('.modal-foot .btn-primary') // Save
  await modalGone()
  await page.waitForSelector(`.set-row-label:text-is("${name}")`, { timeout: 5000 })
}

// --- workspace ---------------------------------------------------------
await page.click('.tb-ws-btn')
await page.click('.menu-item:has-text("+ new workspace")')
await page.waitForSelector('.modal input', { timeout: 5000 })
await page.fill('.modal input', 'personal')
await page.click('.modal button:has-text("Create")')
await modalGone()
await page.waitForSelector('.sb-ws-name:has-text("personal")', { timeout: 5000 })

// --- repos and the one environment that will be provisioned ------------
await addRepo('demo', DEMO_URL)
await addRepo('hello', HELLO_URL)
await addEnv('hello-env', 'hello')

// --- task --------------------------------------------------------------
await openWork()
await page.click('button[title^="New task"]')
await page.waitForSelector('.sb-newtask-menu input', { timeout: 5000 })
await page.fill('.sb-newtask-menu input', 'try-electron')
await page.press('.sb-newtask-menu input', 'Enter')
await page.waitForSelector('.sb-task-name:text-is("try-electron")', { timeout: 10000 })

// --- run a session on "hello" — this is what provisions the container ---
await page.hover('.sb-task:has(.sb-task-name:text-is("try-electron"))')
await page.click('.sb-task:has(.sb-task-name:text-is("try-electron")) .icon-sq[title="new session"]')
await page.waitForSelector('.modal:has-text("New session")', { timeout: 5000 })
// environment first: picking it seeds the session's repo from the env default
await page.click('.modal .seclabel:text-is("ENVIRONMENT") + .pick-wrap .pick-row')
await page.click('.modal .pick-menu .menu-item:has-text("hello-env")')
await page.fill('.modal .ns-prompt-input', 'Reply with exactly one word: pong')
await page.click('.modal button:has-text("Run now")')
await modalGone()
console.log('session started, provisioning...')

// Poll the session's status up to 10 min, echoing the provisioning log as it
// grows (the selected session pane shows .env-log while starting). Sessions are
// named after their role, and the sidebar row carries its status as the row
// title (see SESSION_DOT).
const STARTED = ['working', 'needs you', 'idle — turn ended']
const startedAt = Date.now()
let lastLen = 0
let status = 'starting'
let startError = ''
while (Date.now() - startedAt < 600_000) {
  await new Promise((r) => setTimeout(r, 3000))
  const state = await page.evaluate(() => ({
    status: document.querySelector('.sb-session')?.getAttribute('title') ?? '',
    log: document.querySelector('.env-log')?.innerText ?? '',
    startError: document.querySelector('.env-error')?.innerText ?? ''
  }))
  if (state.log.length > lastLen) {
    process.stdout.write(state.log.slice(lastLen))
    lastLen = state.log.length
  }
  status = state.status
  startError = state.startError
  if (STARTED.includes(status) || startError) break
}
console.log(`\n=== session status: ${status} (${Math.round((Date.now() - startedAt) / 1000)}s) ===`)
if (startError) console.log('start error:', startError)
await page.screenshot({ path: path.join(SHOT_DIR, '04-provisioned.png') })
if (!STARTED.includes(status)) {
  await closeApp(app)
  process.exit(1)
}

// task pane: exactly one container exists, it is running, and it holds "hello" —
// "demo" was never named by a session, so it got nothing
await page.click('.sb-task-name:text-is("try-electron")')
await page.waitForSelector('.task-pane', { timeout: 10000 })
await page.waitForSelector('.env-row', { timeout: 30000 })
const containers = await page.evaluate(() =>
  [...document.querySelectorAll('.env-row')].map((r) => ({
    session: r.querySelector('.env-name')?.textContent.trim(),
    repos: [...r.querySelectorAll('.tag[title^="repository "]')].map((t) => t.textContent.trim()),
    status: r.querySelector('.env-status')?.textContent.trim()
  }))
)
console.log('containers:', JSON.stringify(containers))
if (
  containers.length !== 1 ||
  containers[0].status !== 'running' ||
  containers[0].repos.join(',') !== 'hello'
) {
  console.log('FAIL: expected exactly one running container holding "hello"')
  await closeApp(app)
  process.exit(1)
}

// chat: the start prompt and the agent's reply (an auth error without a secret —
// still proves the whole ACP pipe)
await page.click('.sb-session')
await page.waitForSelector('.feed', { timeout: 15000 })
await page.waitForSelector('.msg-sys, .msg-text.markdown', { timeout: 120000 })
await new Promise((r) => setTimeout(r, 2000))
const chatText = await page.evaluate(() => document.querySelector('.feed')?.innerText)
console.log('=== chat ===\n' + chatText)
await page.screenshot({ path: path.join(SHOT_DIR, '05-chat.png') })

await closeApp(app)
console.log('PHASE2 DONE')

// Explicit: playwright-core keeps its Electron transport referenced after a
// force-killed close, so the script would otherwise sit idle at the end.
process.exit(0)
