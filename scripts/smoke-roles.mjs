// The role picker and the per-repo mount modes on a draft's Config tab
// (docs/requirements-repo-mounts.md §6): repos are always multi-select, each
// with its own mode; picking a role touches neither; and role, repos and modes
// survive into `sessions.json` and back into the pane after a reload.
//
// A session is created as a bare draft and configured afterwards on its own
// Config tab (there is no New Session modal, and no Save button — every pick is
// written straight through `sessionEditDraft`).
//
// Drives the real app (Electron + the renderer), because what is under test is
// the wiring: the pickers, the mode control, the IPC payload, and what the
// Config tab reads back. No agent, no clone, no
// container, so nothing here needs docker.
//
//   npm run build && node scripts/smoke-roles.mjs
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SCRATCH = process.env.SCRATCH ?? '/tmp/gurt-smoke-roles'
const GURT_ROOT = path.join(SCRATCH, 'gurt-root')
const SHOT_DIR = path.join(SCRATCH, 'shots')
fs.rmSync(GURT_ROOT, { recursive: true, force: true })
fs.mkdirSync(SHOT_DIR, { recursive: true })

const ws = 'w'
const task = 't'
fs.mkdirSync(path.join(GURT_ROOT, ws, task), { recursive: true })
fs.writeFileSync(
  path.join(GURT_ROOT, ws, 'workspace.json'),
  JSON.stringify({
    repos: [
      { name: 'alpha', url: 'https://github.com/o/alpha.git' },
      { name: 'beta', url: 'https://github.com/o/beta.git' }
    ],
    envs: [{ name: 'dev', image: 'x', repo: 'alpha' }]
  })
)
fs.writeFileSync(
  path.join(GURT_ROOT, 'agents.json'),
  JSON.stringify({ a1: { kind: 'claude-code', label: 'claude' } })
)
fs.writeFileSync(path.join(GURT_ROOT, ws, task, 'task.json'), JSON.stringify({}))

const require = createRequire(path.join(APP_DIR, 'package.json'))
const { _electron } = require('playwright-core')
const electronPath = require('electron')

// The welcome popup opens over the main pane on a store with no sessions
// (docs/requirements-first-run.md §2.1) and its backdrop would swallow this
// smoke's first clicks. `never` is the same escape hatch a user has.
const env = { ...process.env, GURT_ROOT, GURT_WELCOME: 'never', DISPLAY: process.env.DISPLAY ?? ':99' }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL

// Isolate persisted UI state from other smoke fixtures and the user's app.
const electronProfile = fs.mkdtempSync(path.join(path.dirname(GURT_ROOT), 'electron-profile-'))
const app = await _electron.launch({
  executablePath: electronPath,
  args: [APP_DIR, '--no-sandbox', `--user-data-dir=${electronProfile}`],
  env,
  timeout: 30000
})

const page = await app.firstWindow()
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text())
})
page.on('pageerror', (e) => console.log('[pageerror]', e.message))

const shot = (name) => page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) })
/** Each field of the Config tab is a label row — the `seclabel` plus, for some,
 *  the info dot carrying its explanation — followed by its picker. Matching on
 *  the row rather than the label itself is what survives a field gaining or
 *  losing that dot. */
const row = (label) =>
  `.ns-body .seclabel-row:has(.seclabel:text-is("${label}")) + .pick-wrap .pick-row`
const ROLE_ROW = row('ROLE')
/** The role the Config tab currently shows, from the picker's own value. */
const shownRole = async () => (await page.locator(`${ROLE_ROW} .pick-value`).innerText()).trim()

// A pick is not applied when its menu closes. `DraftConfig` holds no optimistic
// copy of the draft — it renders the `info` that main pushes back — so a pick
// travels IPC → `kernel.editDraft` → `store.getWorkspace` (a disk read) →
// snapshot push before the pane shows it, while the menu closes on the click
// itself. Reading the picker straight after the menu detaches is therefore a
// race that a loaded CI runner loses. These wait for the value instead.
const untilRole = (role) =>
  page.waitForSelector(`${ROLE_ROW} .pick-value:text-is("${role}")`, { timeout: 5000 })
/** The repo rows, once they read exactly `want` (`name:mode` each, the mode
 *  as its `data-mode`) — same round-trip, same wait. */
const untilRows = (want) =>
  page.waitForFunction(
    (expected) => {
      const got = [...document.querySelectorAll('.ns-body .repo-mode-row')].map(
        (r) =>
          `${(r.querySelector('.repo-mode-name')?.innerText ?? '').trim()}:` +
          `${r.querySelector('.chip-btn.on')?.getAttribute('data-mode') ?? ''}`
      )
      return got.length === expected.length && got.every((g, i) => g === expected[i])
    },
    want,
    { timeout: 5000 }
  )

const pickRole = async (role) => {
  await page.click(ROLE_ROW)
  await page.click(`.ns-body .pick-menu .menu-item:has-text("${role}")`)
  await page.waitForSelector('.ns-body .pick-menu', { state: 'detached', timeout: 5000 })
  await untilRole(role)
}
const pickRepo = async (name) => {
  await page.click(row('REPOSITORIES'))
  await page.click(`.ns-body .pick-menu .menu-item:has-text("${name}")`)
  // Close the still-open multi-select menu.
  await page.keyboard.press('Escape')
  await page.waitForSelector('.ns-body .pick-menu', { state: 'detached', timeout: 5000 })
}
const setMode = (repo, mode) =>
  page.click(`.ns-body .repo-mode-row:has(.repo-mode-name:text-is("${repo}")) .chip-btn[data-mode="${mode}"]`)
const WRITE_NOTE = '.ns-body .hc-note:has-text("no repository mounted for write")'
const pickEnv = async (name) => {
  await page.click(row('ENVIRONMENT'))
  await page.click(`.ns-body .pick-menu .menu-item:has-text("${name}")`)
  await page.waitForSelector('.ns-body .pick-menu', { state: 'detached', timeout: 5000 })
}
/** Open the draft's Config tab — a session's pane lands on Chat. */
const openConfig = async () => {
  await page.click('.tab-btn:has-text("Config")')
  await page.waitForSelector('.ns-body', { timeout: 5000 })
}
const sessionsFile = path.join(GURT_ROOT, ws, task, 'sessions.json')
const sessions = () => JSON.parse(fs.readFileSync(sessionsFile, 'utf8'))
/** Persistence is debounced (300ms) — poll the file for the expected record. */
async function persisted(pred, label) {
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(sessionsFile)) {
      const records = sessions()
      if (records.length && pred(records[0])) return records[0]
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`sessions.json never showed: ${label}`)
}

try {
  await page.waitForSelector('.sidebar', { timeout: 15000 })
  await page.waitForSelector('.sb-task', { timeout: 10000 })
  // The row's actions live behind its right-click menu.
  await page.click('.sb-task', { button: 'right' })
  await page.waitForSelector('.ctx-menu', { timeout: 5000 })
  await page.click('.ctx-menu .menu-item:has-text("New session")')
  await page.waitForSelector('.session-pane .tab-bar', { timeout: 10000 })
  await openConfig()

  // --- default role, and the hint that explains it ---
  assert.equal(await shownRole(), 'executor', 'a new session defaults to executor')
  await shot('01-executor')

  // A bare draft has no repository; picking an env seeds it from that env's
  // default, mounted read-locked — the default for every role.
  assert.equal(await page.locator('.ns-body .repo-mode-row').count(), 0, 'a bare draft starts with no repository')
  await pickEnv('dev')
  await untilRows(['o/alpha:read-locked'])
  await page.waitForSelector(WRITE_NOTE, { timeout: 5000 })
  console.log('executor: seeded read-locked, Run blocked until something is writable OK')

  // Writing is an explicit pick, per repo.
  await setMode('o/alpha', 'write')
  await untilRows(['o/alpha:write'])
  await page.waitForSelector(WRITE_NOTE, { state: 'detached', timeout: 5000 })
  // Any role holds any number of repos: a second pick adds, it does not replace.
  await pickRepo('beta')
  await untilRows(['o/alpha:write', 'o/beta:read-locked'])
  await shot('01-modes')
  // The advanced panel opens, and offers no git-access toggle for any role —
  // the container broker is gone (docs/requirements-mcp-proxy.md §10.2).
  await page.click('.ns-body .subfold:has-text("advanced")')
  await page.waitForSelector('.ns-body .hc-foot', { timeout: 5000 })
  assert.equal(
    await page.locator('.ns-body .seclabel:text-is("GIT ACCESS")').count(),
    0,
    'no role is offered a native git toggle any more'
  )
  await page.click('.ns-body .subfold:has-text("advanced")') // collapse again
  console.log('executor: multi-repo with per-repo modes OK, no git-access toggle')

  // --- the role touches neither the repos nor their modes ---
  await pickRole('researcher')
  assert.equal(await shownRole(), 'researcher')
  await untilRows(['o/alpha:write', 'o/beta:read-locked'])
  await setMode('o/beta', 'read')
  await untilRows(['o/alpha:write', 'o/beta:read'])
  await shot('02-researcher')
  console.log('researcher: repos and modes kept across the role pick OK')

  // --- every pick went straight to disk; no Save button was involved ---
  await page.click('.tab-btn:has-text("Chat")')
  await page.fill('.draft-prompt', 'review the uncommitted changes')
  await page.click('.chat-title') // blur -> sessionEditPrompt
  const rec = await persisted(
    (r) => r.info.role === 'researcher' && r.info.startPrompt === 'review the uncommitted changes',
    'the researcher draft'
  )
  assert.deepEqual(rec.info.repos, ['alpha', 'beta'], 'both repos are persisted, in order')
  assert.deepEqual(rec.info.repoModes, { alpha: 'write', beta: 'read' }, 'with their modes')
  assert.equal(rec.info.env, 'dev', 'as is the environment picked alongside them')
  await shot('03-draft')
  console.log('role, repos and modes persisted without a save step OK')

  // --- and come back on the Config tab after a reload ---
  await page.reload()
  await page.waitForSelector('.sb-session', { timeout: 15000 })
  await page.click('.sb-session >> nth=0')
  await openConfig()
  await untilRole('researcher')
  await untilRows(['o/alpha:write', 'o/beta:read'])

  // --- an operator may hold repos too; removing one is its row's × ---
  await pickRole('operator')
  await untilRows(['o/alpha:write', 'o/beta:read'])
  await page.click('.ns-body .repo-mode-row:has(.repo-mode-name:text-is("o/beta")) .chip-x')
  await untilRows(['o/alpha:write'])
  await persisted(
    (r) => r.info.role === 'operator' && r.info.repos.length === 1 && r.info.repoModes?.alpha === 'write',
    'the edited operator draft'
  )
  await shot('04-edited')
  console.log('draft role edit + repo removal OK')

  console.log('SMOKE PASS')
} catch (e) {
  console.error('SMOKE FAIL')
  console.error(e)
  process.exitCode = 1
  await shot('99-failure')
} finally {
  await app.close()
}
