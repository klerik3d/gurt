// The role picker on a draft's Config tab (docs/requirements-session-roles.md
// §7): picking a role, what it does to the repository picker, and that the role
// survives into `sessions.json` and back into the pane after a reload.
//
// A session is created as a bare draft and configured afterwards on its own
// Config tab (there is no New Session modal, and no Save button — every pick is
// written straight through `sessionEditDraft`).
//
// Drives the real app (Electron + the renderer), because what is under test is
// the wiring: the picker, the single/multi-select switch it drives, the IPC
// payload, and what the Config tab reads back. No agent, no clone, no
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
    envs: [{ name: 'dev', devcontainer: '{"image":"x"}', repo: 'alpha' }]
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

const env = { ...process.env, GURT_ROOT, DISPLAY: process.env.DISPLAY ?? ':99' }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL

const app = await _electron.launch({
  executablePath: electronPath,
  args: [APP_DIR, '--no-sandbox'],
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
/** The repo chips, once they read exactly `want` — same round-trip, same wait.
 *  A researcher's chips now live below the pick row with a remove "×" on each
 *  (too many overran the row); strip it so the label comparison doesn't care
 *  which role rendered the chip. */
const stripChipX = (s) => s.replace(/\s*×\s*$/, '').trim()
const untilChips = (want) =>
  page.waitForFunction(
    (expected) => {
      const got = [...document.querySelectorAll('.ns-body .chip-tag')].map((e) =>
        (e.innerText ?? '').replace(/\s*×\s*$/, '').trim()
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
const repoChips = () =>
  page
    .locator('.ns-body .chip-tag')
    .allInnerTexts()
    .then((ts) => ts.map(stripChipX))
const pickRepo = async (name) => {
  await page.click(row('REPOSITORY'))
  await page.click(`.ns-body .pick-menu .menu-item:has-text("${name}")`)
  // Close the still-open multi-select menu.
  await page.keyboard.press('Escape')
  await page.waitForSelector('.ns-body .pick-menu', { state: 'detached', timeout: 5000 })
}
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

  // A bare draft has no environment yet; picking one seeds the session repo
  // from that env's default. An executor works in exactly one clone, so a
  // second pick replaces the first.
  assert.deepEqual(await repoChips(), [], 'a bare draft starts with no repository')
  await pickEnv('dev')
  await untilChips(['o/alpha'])
  assert.deepEqual(await repoChips(), ['o/alpha'], 'seeded from the env default')
  await pickRepo('beta')
  await untilChips(['o/beta'])
  assert.deepEqual(await repoChips(), ['o/beta'], 'an executor pick replaces the repo')
  // The advanced panel opens, and offers no git-access toggle for any role —
  // the container broker is gone (docs/requirements-mcp-proxy.md §10.2).
  await page.click('.ns-body .hc-head')
  await page.waitForSelector('.ns-body .hc-body', { timeout: 5000 })
  assert.equal(
    await page.locator('.ns-body .hc .seclabel:text-is("GIT ACCESS")').count(),
    0,
    'no role is offered a native git toggle any more'
  )
  await page.click('.ns-body .hc-head') // collapse again
  console.log('executor: single-select repo OK, no git-access toggle')

  // --- researcher: multi-select ---
  await pickRole('researcher')
  assert.equal(await shownRole(), 'researcher')
  await pickRepo('alpha')
  await untilChips(['o/beta', 'o/alpha'])
  assert.deepEqual(await repoChips(), ['o/beta', 'o/alpha'], 'a researcher accumulates repos')
  await shot('02-researcher')
  console.log('researcher: multi-select OK')

  // --- leaving the researcher role drops the extra repos ---
  await pickRole('reviewer')
  await untilChips(['o/beta'])
  assert.deepEqual(await repoChips(), ['o/beta'], 'a reviewer keeps a single clone')
  await shot('03-reviewer')

  // --- every pick went straight to disk; no Save button was involved ---
  await page.click('.tab-btn:has-text("Chat")')
  await page.fill('.draft-prompt', 'review the uncommitted changes')
  await page.click('.chat-title') // blur -> sessionEditPrompt
  const rec = await persisted(
    (r) => r.info.role === 'reviewer' && r.info.startPrompt === 'review the uncommitted changes',
    'the reviewer draft'
  )
  assert.equal(rec.info.role, 'reviewer', 'the role is persisted on the session')
  assert.deepEqual(rec.info.repos, ['beta'], 'with its single repo')
  assert.equal(rec.info.env, 'dev', 'as is the environment picked alongside it')
  await shot('04-draft')
  console.log('role persisted without a save step OK')

  // --- and comes back on the Config tab after a reload ---
  await page.reload()
  await page.waitForSelector('.sb-session', { timeout: 15000 })
  await page.click('.sb-session >> nth=0')
  await openConfig()
  await untilRole('reviewer')
  assert.equal(await shownRole(), 'reviewer', 'the Config tab reopens on the saved role')
  await untilChips(['o/beta'])
  assert.deepEqual(await repoChips(), ['o/beta'], 'and on the saved repo')

  // --- editing the draft can still change the role (nothing has run) ---
  await pickRole('executor')
  assert.equal(await shownRole(), 'executor')
  await persisted((r) => r.info.role === 'executor', 'the edited role')
  await shot('05-edited')
  console.log('draft role edit OK')

  console.log('SMOKE PASS')
} catch (e) {
  console.error('SMOKE FAIL')
  console.error(e)
  process.exitCode = 1
  await shot('99-failure')
} finally {
  await app.close()
}
