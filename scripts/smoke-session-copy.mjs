// Duplicating and deleting a session from the UI: the sidebar row's hover
// actions and the session pane's ⋯ menu.
//
// Drives the real app (Electron + the renderer), because what is under test is
// the wiring: the row action has to appear on hover and not swallow the row's
// own click, the copy has to land in the tree already selected and carrying the
// source's prompt, and the pane's menu has to offer the same two actions to a
// session whose pane is not the draft body.
//
// Sessions are seeded as drafts straight into GURT_ROOT — no agent, no clone,
// no container, so nothing here needs docker.
//
//   npm run build && node scripts/smoke-session-copy.mjs
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SCRATCH = process.env.SCRATCH ?? '/tmp/gurt-smoke-session-copy'
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
    repos: [{ name: 'alpha', url: 'https://github.com/o/alpha.git' }],
    envs: [{ name: 'dev', devcontainer: '{"image":"x"}', repo: 'alpha' }]
  })
)
fs.writeFileSync(path.join(GURT_ROOT, ws, 'agents.json'), JSON.stringify({}))
fs.writeFileSync(path.join(GURT_ROOT, ws, task, 'task.json'), JSON.stringify({}))
const draft = (id, title, prompt) => ({
  info: {
    id,
    env: 'dev',
    role: 'executor',
    repos: ['alpha'],
    task,
    workspace: ws,
    title,
    state: 'draft',
    autoAllow: false,
    startPrompt: prompt
  }
})
const sessionsFile = path.join(GURT_ROOT, ws, task, 'sessions.json')
fs.writeFileSync(
  sessionsFile,
  JSON.stringify([draft('s-alpha', 'Alpha', 'fix the login bug'), draft('s-bravo', 'Bravo', 'hi')])
)

const require = createRequire(path.join(APP_DIR, 'package.json'))
const { _electron } = require('playwright-core')
const electronPath = require('electron')

const env = { ...process.env, GURT_ROOT, DISPLAY: process.env.DISPLAY ?? ':99' }
delete env.ELECTRON_RUN_AS_NODE

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
const titles = () => page.locator('.sb-session-name').allInnerTexts()
const selected = () => page.locator('.sb-session.selected .sb-session-name').innerText()
const row = (title) => page.locator(`.sb-session:has-text("${title}")`)

try {
  await page.waitForSelector('.sidebar', { timeout: 15000 })
  await page.waitForSelector('.sb-session', { timeout: 10000 })
  assert.deepEqual(await titles(), ['Alpha', 'Bravo'], 'both seeded drafts are in the tree')

  // --- the row's duplicate button ---
  // Hidden until the row is hovered, so the hover is part of the flow, not a
  // convenience: clicking it without one would be clicking something invisible.
  await row('Alpha').hover()
  await shot('01-row-hover')
  await row('Alpha').locator('button[title="duplicate as draft"]').click()
  await page.waitForFunction(() => document.querySelectorAll('.sb-session').length === 3, null, {
    timeout: 5000
  })
  assert.deepEqual(
    await titles(),
    ['Alpha', 'Bravo', 'Alpha (copy)'],
    'the copy joins the task, named after its source'
  )
  assert.match(await selected(), /Alpha \(copy\)/, 'the copy is selected — it exists to be edited')
  // The copy's pane is the draft body, prefilled with the source's prompt.
  assert.equal(
    await page.locator('.draft-prompt').inputValue(),
    'fix the login bug',
    'the copy carries the first prompt'
  )
  assert.equal(
    await page.locator('.draft-settings .tag', { hasText: 'git' }).count(),
    1,
    'the copy carries the git-access setting'
  )
  await shot('02-copy')
  console.log('the row action copies a session into a draft OK')

  // --- the same, from the pane header's ⋯ menu ---
  await page.click('.session-pane .session-menu button')
  await page.waitForSelector('.session-menu-pop', { timeout: 5000 })
  await shot('03-pane-menu')
  await page.click('.session-menu-pop .menu-item:has-text("Duplicate as draft")')
  await page.waitForFunction(() => document.querySelectorAll('.sb-session').length === 4, null, {
    timeout: 5000
  })
  assert.match(await selected(), /Alpha \(copy\) \(copy\)/, 'the menu copies the open session')
  console.log('the pane menu copies the open session OK')

  // --- delete from the pane menu, confirmation included ---
  await page.click('.session-pane .session-menu button')
  await page.click('.session-menu-pop .menu-item:has-text("Delete session")')
  await page.waitForSelector('.dialog', { timeout: 5000 })
  assert.equal(await page.locator('.dialog-title').innerText(), 'Delete session')
  await shot('04-delete-confirm')
  await page.click('.dialog-ok')
  await page.waitForFunction(() => document.querySelectorAll('.sb-session').length === 3, null, {
    timeout: 5000
  })
  assert.deepEqual(await titles(), ['Alpha', 'Bravo', 'Alpha (copy)'], 'the copy of the copy is gone')
  console.log('the pane menu deletes the open session OK')

  // --- delete from the row's trash button ---
  await row('Alpha (copy)').hover()
  await row('Alpha (copy)').locator('button[title="delete session"]').click()
  await page.waitForSelector('.dialog', { timeout: 5000 })
  await page.click('.dialog-ok')
  await page.waitForFunction(() => document.querySelectorAll('.sb-session').length === 2, null, {
    timeout: 5000
  })
  assert.deepEqual(await titles(), ['Alpha', 'Bravo'], 'the tree is back to the two seeded drafts')
  await shot('05-deleted')
  console.log('the row action deletes a session OK')

  // The changes reach disk, not just the tree in memory (300ms debounce).
  let persisted = null
  for (let i = 0; i < 40; i++) {
    persisted = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'))
    if (persisted.length === 2) break
    await new Promise((r) => setTimeout(r, 100))
  }
  assert.deepEqual(
    persisted.map((r) => r.info.id),
    ['s-alpha', 's-bravo'],
    'sessions.json holds exactly the surviving sessions'
  )
  console.log('the copies and deletes are persisted OK')

  console.log('smoke-session-copy: PASS')
} catch (e) {
  await shot('99-failure').catch(() => {})
  console.error('smoke-session-copy: FAIL')
  console.error(e)
  console.error('shots in', SHOT_DIR)
  process.exitCode = 1
} finally {
  await app.close().catch(() => {})
}
