// The operator role in the real UI (docs/requirements-session-operator.md
// §12 item 9, the docker-free half): the role is selectable on a draft's
// Config tab, picking it clears and disables the repository picker, the env
// defaults to the bundled operator env (or the workspace's `operatorEnv`),
// Run is not blocked on a repository, and the role round-trips through
// `sessions.json` and a reload.
//
// The other half of item 9 — the session actually reaching `started` with no
// clone — needs a Docker daemon and is recorded in that document's §12 item
// 10 as not verifiable in this environment. The `applyHeld` confirmation is
// phase 2 and lands with it.
//
//   npm run build && node scripts/smoke-operator.mjs
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SCRATCH = process.env.SCRATCH ?? '/tmp/gurt-smoke-operator'
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
    envs: [{ name: 'dev', devcontainer: '{"image":"x"}', repo: 'alpha' }],
    // Seeded into the bare draft by the Config tab, so the only thing that
    // could gate Run below is the repository — which is the assertion.
    defaultAgent: 'a1'
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
const row = (label) =>
  `.ns-body .seclabel-row:has(.seclabel:text-is("${label}")) + .pick-wrap .pick-row`
const ROLE_ROW = row('ROLE')
const untilRole = (role) =>
  page.waitForSelector(`${ROLE_ROW} .pick-value:text-is("${role}")`, { timeout: 5000 })
const pickRole = async (role) => {
  await page.click(ROLE_ROW)
  await page.click(`.ns-body .pick-menu .menu-item:has-text("${role}")`)
  await page.waitForSelector('.ns-body .pick-menu', { state: 'detached', timeout: 5000 })
  await untilRole(role)
}
const openConfig = async () => {
  await page.click('.tab-btn:has-text("Config")')
  await page.waitForSelector('.ns-body', { timeout: 5000 })
}
const envValue = async () =>
  (await page.locator(`${row('ENVIRONMENT')} .pick-value`).innerText()).trim()

const sessionsFile = path.join(GURT_ROOT, ws, task, 'sessions.json')
async function persisted(pred, label) {
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(sessionsFile)) {
      const records = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'))
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

  // --- the operator role is selectable ---
  await pickRole('operator')
  await shot('01-operator')
  console.log('operator: selectable in the role picker OK')

  // --- the repository picker is disabled and holds nothing ---
  const repoRow = `.ns-body .seclabel-row:has(.seclabel:text-is("REPOSITORY")) + .pick-row`
  await page.waitForSelector(`${repoRow}[disabled]`, { timeout: 5000 })
  const repoText = (await page.locator(repoRow).innerText()).trim()
  assert.match(repoText, /an operator holds none/, 'the disabled row says why')
  console.log('operator: repo picker disabled OK')

  // --- the env defaulted to the bundled operator env ---
  assert.equal(await envValue(), 'operator', 'env defaults to the bundled operator env')
  console.log('operator: bundled env default OK')

  // --- zero repos persisted; Run not blocked on a repository ---
  const rec = await persisted(
    (r) => r.info.role === 'operator' && r.info.env === 'operator',
    'the operator draft'
  )
  assert.deepEqual(rec.info.repos, [], 'zero repos on disk — the definition, not a default')
  await page.click('.tab-btn:has-text("Chat")')
  await page.fill('.draft-prompt', 'why does my env not build?')
  const runBtn = page.locator('button:has-text("Run now")')
  // Run must not be disabled for want of a repository (a repo-less start is
  // this role's normal path); actually clicking it would need Docker.
  assert.equal(await runBtn.isDisabled(), false, 'Run is not blocked on a repository')
  await shot('02-run-enabled')
  console.log('operator: Run enabled with zero repos OK')

  // --- the role survives a reload ---
  await page.reload()
  await page.waitForSelector('.sb-session', { timeout: 15000 })
  await page.click('.sb-session >> nth=0')
  await openConfig()
  await untilRole('operator')
  assert.equal(await envValue(), 'operator', 'env comes back too')
  await shot('03-reloaded')
  console.log('operator: reload OK')

  console.log('SMOKE PASS')
} catch (e) {
  console.error('SMOKE FAIL')
  console.error(e)
  process.exitCode = 1
  await shot('99-failure')
} finally {
  await app.close()
}
