// The role picker in the New Session modal (docs/requirements-session-roles.md
// §7): picking a role, what it does to the repository picker, and that the role
// survives into `sessions.json` and back into the draft pane.
//
// Drives the real app (Electron + the renderer), because what is under test is
// the wiring: the picker, the single/multi-select switch it drives, the IPC
// payload, and the tag the draft pane reads back. No agent, no clone, no
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
const ROLE_ROW = '.modal .seclabel:text-is("ROLE") + .pick-wrap .pick-row'
/** The role the modal currently shows, from the picker's own value. */
const shownRole = async () => (await page.locator(`${ROLE_ROW} .pick-value`).innerText()).trim()
const pickRole = async (role) => {
  await page.click(ROLE_ROW)
  await page.click(`.modal .pick-menu .menu-item:has-text("${role}")`)
}
const repoChips = () => page.locator('.modal .chip-tag').allInnerTexts()
const pickRepo = async (name) => {
  await page.click('.modal .seclabel:text-is("REPOSITORY") + .pick-wrap .pick-row')
  await page.click(`.modal .pick-menu .menu-item:has-text("${name}")`)
  // Close the still-open multi-select menu.
  await page.keyboard.press('Escape')
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
  await page.evaluate(() => document.querySelector('button[title="new session"]').click())
  await page.waitForSelector('.modal')

  // --- default role, and the hint that explains it ---
  assert.equal(await shownRole(), 'executor', 'a new session defaults to executor')
  await shot('01-executor')

  // An executor works in exactly one clone: a second pick replaces the first.
  assert.deepEqual(await repoChips(), ['o/alpha'], 'seeded from the env default')
  await pickRepo('beta')
  assert.deepEqual(await repoChips(), ['o/beta'], 'an executor pick replaces the repo')
  // Its GIT ACCESS toggle is offered (single, read-write clone).
  await page.click('.modal .hc-head')
  await page.waitForSelector('.modal .hc .seclabel:text-is("GIT ACCESS")', { timeout: 5000 })
  console.log('executor: single-select repo + git access OK')

  // --- researcher: multi-select, no git access ---
  await pickRole('researcher')
  assert.equal(await shownRole(), 'researcher')
  await pickRepo('alpha')
  assert.deepEqual(await repoChips(), ['o/beta', 'o/alpha'], 'a researcher accumulates repos')
  assert.equal(
    await page.locator('.modal .hc .seclabel:text-is("GIT ACCESS")').count(),
    0,
    'a read-only role is not offered the git broker'
  )
  await shot('02-researcher')
  console.log('researcher: multi-select, no git access OK')

  // --- leaving the researcher role drops the extra repos ---
  await pickRole('reviewer')
  assert.deepEqual(await repoChips(), ['o/beta'], 'a reviewer keeps a single clone')
  await shot('03-reviewer')

  // --- the role rides the create call and comes back on the draft ---
  await page.fill('.modal .ns-prompt-input', 'review the uncommitted changes')
  await page.click('.modal button:has-text("Save draft")')
  await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 })
  await page.waitForSelector('.draft-settings', { timeout: 10000 })
  const rec = await persisted((r) => r.info.role === 'reviewer', 'the reviewer draft')
  assert.equal(rec.info.role, 'reviewer', 'the role is persisted on the session')
  assert.deepEqual(rec.info.repos, ['beta'], 'with its single repo')
  assert.equal(rec.info.gitAccess, false, 'and no git access')
  const tag = await page.locator('.draft-settings .tag-ico').first().innerText()
  assert.equal(tag.trim(), 'reviewer', 'the draft pane shows the role')
  await shot('04-draft')
  console.log('role persisted + shown on the draft OK')

  // --- editing the draft can still change the role (nothing has run) ---
  await page.click('.draft-settings button:has-text("Edit settings")')
  await page.waitForSelector('.modal')
  assert.equal(await shownRole(), 'reviewer', 'the edit modal opens on the saved role')
  await pickRole('executor')
  await page.click('.modal button:has-text("Save")')
  await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 })
  await page.waitForFunction(
    () => document.querySelector('.draft-settings .tag-ico')?.textContent?.includes('executor'),
    null,
    { timeout: 5000 }
  )
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
