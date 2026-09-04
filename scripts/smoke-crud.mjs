// Phase 4: iteration-2 features through the real UI. Repo CRUD (add/edit/delete)
// in Settings, task create/delete in the sidebar, the per-session container
// lifecycle (stop/delete) in the task pane, and the codex adapter handshake.
// Requires docker and network (the devcontainer image is pulled).
//
//   npm run build && SCRATCH=/tmp/gurt-smoke-crud node scripts/smoke-crud.mjs
//
// Session-centric: a container is born when a session runs, and belongs to that
// one session. No agent secrets are configured, so both clients are expected to
// fail on auth — reaching that error still proves install → spawn → initialize →
// session/new end to end.
//
// The repos are local bare origins rather than github, so the git half is
// hermetic. They carry a `.devcontainer/` directory on purpose: gurt always
// passes `--additional-features`, and @devcontainers/cli 0.88 writes the
// resolved feature lockfile to `<workspace>/.devcontainer/devcontainer-lock.json`
// without creating the directory — a repo without one fails `devcontainer up`
// with ENOENT before the image is ever built.
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SHOT_DIR = path.join(process.env.SCRATCH ?? '/tmp', 'shots')
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

// The app shells out to the host's git, which needs an identity for any commit
// it makes on the clone. Supply one through the environment rather than the
// machine's global config — a fresh container has no user.email at all.
const env = {
  ...process.env,
  GURT_ROOT,
  DISPLAY: process.env.DISPLAY ?? ':99',
  GIT_AUTHOR_NAME: 'smoke',
  GIT_AUTHOR_EMAIL: 'smoke@test',
  GIT_COMMITTER_NAME: 'smoke',
  GIT_COMMITTER_EMAIL: 'smoke@test'
}
delete env.ELECTRON_RUN_AS_NODE // inherited from the VSCode extension host shell

// Seed the claude-code and codex clients (no credentials — auth errors expected).
// The registry starts empty, so both must exist before they are selectable.
fs.mkdirSync(GURT_ROOT, { recursive: true })
fs.writeFileSync(
  path.join(GURT_ROOT, 'agents.json'),
  JSON.stringify({
    'claude-code': { kind: 'claude-code', label: 'claude code' },
    codex: { kind: 'codex', label: 'codex' }
  })
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
const WORLD_URL = makeBareRepo('world')

const app = await _electron.launch({
  executablePath: electronPath,
  args: [APP_DIR, '--no-sandbox'],
  env,
  timeout: 30000
})
app.process().stdout.on('data', (d) => process.stdout.write(`[main] ${d}`))
const page = await app.firstWindow()
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text())
})

const shot = (name) => page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) })
const modalGone = () => page.waitForSelector('.modal', { state: 'detached', timeout: 10000 })

// The two views in the activity bar. Repos, environments and clients live in
// Settings; tasks and sessions in the work view.
const openSettings = async (section) => {
  await page.click('.activitybar .ab-item[title^="Settings"]')
  await page.click(`.set-nav-item:has-text("${section}")`)
}
const openWork = () => page.click('.activitybar .ab-item[title^="Tasks & sessions"]')

/** Confirms are an in-app dialog (dialog.tsx), not the OS one. */
const confirm = async () => {
  await page.waitForSelector('.dialog', { timeout: 10000 })
  await page.click('.dialog-ok')
  await page.waitForSelector('.dialog', { state: 'detached', timeout: 10000 })
}

// Sessions are named after their role ("executor", "executor 2"), and the
// sidebar row carries its status as the row title (see SESSION_DOT).
const SESSION_ROW = (title) => `.sb-session:has(.sb-session-name:text-is("${title}"))`
const sessionStatus = (title) => page.getAttribute(SESSION_ROW(title), 'title')

/**
 * Resolves when `title` reaches one of `labels`, or when the session pane shows
 * a start error — a container that never comes up would otherwise burn the
 * whole timeout on a status that is never going to move.
 */
const waitSession = async (title, labels, timeout = 900000) => {
  await page.waitForFunction(
    ([t, ls]) => {
      if (document.querySelector('.env-error')) return true
      const row = [...document.querySelectorAll('.sb-session')].find(
        (n) => n.querySelector('.sb-session-name')?.textContent.trim() === t
      )
      return !!row && ls.includes(row.getAttribute('title'))
    },
    [title, labels],
    { timeout, polling: 1000 }
  )
  return page.evaluate(() => document.querySelector('.env-error')?.innerText)
}

// Task-pane CONTAINERS rows, matched by the owning session's title.
const CONTAINER_ROW = (title) => `.env-row:has(.env-name:text-is("${title}"))`
const containerAction = async (title, action) => {
  await page.click(`${CONTAINER_ROW(title)} button[title="container actions"]`)
  await page.click(`${CONTAINER_ROW(title)} .session-menu-pop .menu-item:text-is("${action}")`)
}
const waitContainerStatus = (title, status, timeout = 180000) =>
  page.waitForSelector(`${CONTAINER_ROW(title)} .env-status:text-is("${status}")`, { timeout })

/** Open the task pane of `task` (a task row selects it). */
const openTask = async (task) => {
  await openWork()
  await page.click(`.sb-task-name:text-is("${task}")`)
  await page.waitForSelector('.task-pane', { timeout: 10000 })
}

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
}

/** Open the Edit repo modal of `name` — the row's only link. */
const openRepo = async (name) => {
  await page.click(`.set-row:has(.set-row-label:text-is("${name}")) .btn-link`)
  await page.waitForSelector('.modal:has-text("Edit repo")', { timeout: 5000 })
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

/** Compose and run a session off the task row's "new session" button. */
async function newSession(task, envName, agentLabel, prompt) {
  await openWork()
  await page.hover(`.sb-task:has(.sb-task-name:text-is("${task}"))`)
  await page.click(`.sb-task:has(.sb-task-name:text-is("${task}")) .icon-sq[title="task actions"]`)
  await page.waitForSelector('.session-menu-pop', { timeout: 5000 })
  await page.click('.session-menu-pop .menu-item:has-text("New session")')
  await page.waitForSelector('.modal:has-text("New session")', { timeout: 5000 })
  // environment first: picking it seeds the session's repo from the env default
  await page.click('.modal .seclabel:text-is("ENVIRONMENT") + .pick-wrap .pick-row')
  await page.click(`.modal .pick-menu .menu-item:has-text("${envName}")`)
  await page.click('.modal .seclabel:text-is("AGENT") + .pick-wrap .pick-row')
  await page.click(`.modal .pick-menu .menu-item:has-text("${agentLabel}")`)
  await page.fill('.modal .ns-prompt-input', prompt)
  await page.click('.modal button:has-text("Run now")')
  await modalGone()
}

await page.waitForSelector('.sidebar', { timeout: 15000 })

// --- workspace ---------------------------------------------------------
await page.click('.tb-ws-btn')
await page.click('.menu-item:has-text("+ new workspace")')
await page.waitForSelector('.modal input', { timeout: 5000 })
await page.fill('.modal input', 'personal')
await page.click('.modal button:has-text("Create")')
await modalGone()
await page.waitForSelector('.sb-ws-name:has-text("personal")', { timeout: 5000 })
console.log('ws created')

// --- repo CRUD in Settings → Repos -------------------------------------
await addRepo('hello', HELLO_URL)
await addRepo('tmp', 'https://example.com/x.git')
console.log('repos added')

// edit: the name is frozen once saved, the url is not
await openRepo('tmp')
await page.fill('.modal input[placeholder^="https://github.com"]', 'https://example.com/y.git')
await page.click('.modal-foot .btn-primary') // Save
await modalGone()
await page.waitForSelector('.set-row:has(.set-row-label:text-is("tmp")) .set-row-url:has-text("example.com/y")', { timeout: 5000 })
console.log('repo edited')

// a second repo, for the codex session
await addRepo('world', WORLD_URL)

// delete: from inside the repo's own modal, behind the confirmation
await openRepo('tmp')
await page.click('.modal .btn-danger-text') // Delete
await confirm()
await modalGone()
await page.waitForSelector('.set-row-label:text-is("tmp")', { state: 'detached', timeout: 5000 })
await shot('08-repos')
console.log('repo deleted')

// --- environments ------------------------------------------------------
await addEnv('hello-env', 'hello')
await addEnv('world-env', 'world')
console.log('envs defined')

// --- task --------------------------------------------------------------
await openWork()
await page.click('button[title^="New task"]')
await page.waitForSelector('.sb-newtask-menu input', { timeout: 5000 })
await page.fill('.sb-newtask-menu input', 'try2')
await page.press('.sb-newtask-menu input', 'Enter')
await page.waitForSelector('.sb-task-name:text-is("try2")', { timeout: 10000 })
console.log('task created')

// --- claude session: births and provisions the container ---------------
await newSession('try2', 'hello-env', 'claude code', 'ping')
console.log('claude session starting...')
const claudeErr = await waitSession('executor', ['working', 'needs you', 'idle — turn ended'])
if (claudeErr) throw new Error(`claude session start failed: ${claudeErr}`)
console.log('claude session started; status =', await sessionStatus('executor'))

// chat: the prompt, and whatever the keyless agent answers (an auth error)
await page.click(SESSION_ROW('executor'))
await page.waitForSelector('.feed', { timeout: 15000 })
await page.waitForSelector('.msg-sys, .msg-text.markdown', { timeout: 180000 })
await new Promise((r) => setTimeout(r, 1500))
console.log('--- claude chat ---')
console.log(await page.evaluate(() => document.querySelector('.feed')?.innerText))
await shot('09-chat2')

// stop the claude container from the task pane
await openTask('try2')
await page.waitForSelector(CONTAINER_ROW('executor'), { timeout: 30000 })
await containerAction('executor', 'Stop')
await waitContainerStatus('executor', 'stopped')
console.log('claude container stopped')

// --- codex session on the second repo ----------------------------------
// Keyless codex refuses session/new with 'Authentication required' (every
// codex-acp version does) — reaching that error still proves the pipe end to
// end: install, spawn, initialize, session/new round-trip, error in the UI.
await newSession('try2', 'world-env', 'codex', 'ping')
console.log('codex session starting...')
const codexErr = await waitSession('executor 2', ['working', 'needs you', 'idle — turn ended'])
if (codexErr && !/Authentication required|not logged in|login/i.test(codexErr))
  throw new Error(`codex session failed unexpectedly: ${codexErr}`)
console.log(
  codexErr
    ? 'codex refused without a key at session/new (ACP pipe proven)'
    : `codex session started (ACP handshake OK); status = ${await sessionStatus('executor 2')}`
)
await openWork()
await page.click(SESSION_ROW('executor 2'))
if (codexErr) {
  // A never-started session renders the draft pane, not a timeline — the
  // error banner is the assertion.
  await page.waitForSelector('.session-pane .env-error', { timeout: 15000 })
  console.log('--- codex draft pane ---')
  console.log(await page.evaluate(() => document.querySelector('.env-error')?.innerText))
} else {
  await page.waitForSelector('.feed', { timeout: 15000 })
  try {
    await page.waitForSelector('.msg-sys, .msg-text.markdown, .perm-head', { timeout: 120000 })
    await new Promise((r) => setTimeout(r, 1500))
    console.log('--- codex chat ---')
    console.log(await page.evaluate(() => document.querySelector('.feed')?.innerText))
  } catch (e) {
    console.log('codex chat step failed:', e.message.slice(0, 200))
  }
}
await shot('10-codex')

// --- container delete: the row goes, the clone stays -------------------
await openTask('try2')
if (await page.locator(CONTAINER_ROW('executor 2')).count()) {
  await containerAction('executor 2', 'Stop')
  await waitContainerStatus('executor 2', 'stopped')
  await containerAction('executor 2', 'Delete')
  await confirm()
  await page.waitForSelector(CONTAINER_ROW('executor 2'), { state: 'detached', timeout: 120000 })
  console.log(
    'codex container deleted; clone kept:',
    fs.existsSync(path.join(GURT_ROOT, 'personal', 'try2', 'world'))
  )
} else {
  console.log('codex never provisioned a container — nothing to delete')
}

// --- task delete -------------------------------------------------------
await openWork()
await page.hover('.sb-task:has(.sb-task-name:text-is("try2"))')
await page.click('.sb-task:has(.sb-task-name:text-is("try2")) .icon-sq[title="task actions"]')
await page.waitForSelector('.session-menu-pop', { timeout: 5000 })
await page.click('.session-menu-pop .menu-item:has-text("Delete task")')
await confirm()
await page.waitForFunction(() => document.querySelectorAll('.sb-task').length === 0, undefined, {
  timeout: 120000
})
console.log('task deleted; task dir exists:', fs.existsSync(path.join(GURT_ROOT, 'personal', 'try2')))

await shot('11-final')
await app.close()
console.log('PHASE4 DONE')
