// Native git access, UI-only (no docker): drives the credentials modal through
// the real UI → IPC → store, then checks the credential select + git-access
// toggle appear. Proves the phase-1 renderer/main wiring end to end.
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

const APP_DIR = '/Users/klerik3d/workspace/personal/gurt'
const SHOT_DIR = path.join(process.env.SCRATCH ?? '/tmp', 'shots')
const GURT_ROOT = path.join(process.env.SCRATCH ?? '/tmp', 'gurt-root')
fs.mkdirSync(SHOT_DIR, { recursive: true })

const require = createRequire(path.join(APP_DIR, 'package.json'))
const { _electron } = require('playwright-core')

const env = { ...process.env, GURT_ROOT }
delete env.ELECTRON_RUN_AS_NODE

const app = await _electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [APP_DIR],
  env,
  timeout: 30000
})

const page = await app.firstWindow()
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text())
})

await page.waitForSelector('.sidebar', { timeout: 15000 })
console.log('initial render OK')

// --- credentials modal: add a git-token entry ---
await page.click('button[title="credentials"]')
await page.waitForSelector('.modal')
await page.click('text=+ add credential')
await page.fill('.modal input[placeholder^="label"]', 'gh token')
await page.fill('.modal input[type="password"]', 'ghp_smoketest')
await page.fill('.modal input[placeholder="github.com"]', 'github.com')
await page.screenshot({ path: path.join(SHOT_DIR, 'g1-credentials.png') })
await page.getByRole('button', { name: 'Save', exact: true }).click()
await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 })

const credFile = path.join(GURT_ROOT, 'credentials.json')
const creds = JSON.parse(fs.readFileSync(credFile, 'utf8'))
assert.equal(creds.credentials.length, 1, 'one credential persisted')
assert.equal(creds.credentials[0].label, 'gh token')
assert.equal(creds.credentials[0].kind, 'git-token')
assert.deepEqual(creds.credentials[0].hosts, ['github.com'])
assert.equal(creds.credentials[0].data.secret, 'ghp_smoketest')
console.log('credential persisted OK')

// --- workspace + github repo, then the repos modal shows resolution ---
await page.click('button[title="new workspace"]')
await page.waitForSelector('.modal input')
await page.fill('.modal input', 'personal')
await page.click('.modal .form button')
await page.waitForSelector('.ws-node', { timeout: 5000 })

await page.evaluate(() => document.querySelector('button[title="repos"]').click())
await page.waitForSelector('.modal')
await page.click('text=Add repo')
await page.fill('.modal input[placeholder="name"]', 'demo')
await page.fill('.modal input[placeholder*="git url"]', 'https://github.com/octocat/Hello-World.git')
// The credential select + live resolution preview render for a github url.
await page.waitForSelector('.modal .repo-form select')
const resolutionText = await page.textContent('.modal .repo-form label:has(select) .dim')
assert.ok(/gh token/.test(resolutionText ?? ''), `resolution preview mentions the credential: ${resolutionText}`)
console.log('repo credential resolution preview OK:', resolutionText?.trim())
await page.screenshot({ path: path.join(SHOT_DIR, 'g2-repo-credential.png') })
// Add the repo (auto-match by host). ReposModal stays open (list view), so wait
// for the row, then close it via the header ✕.
await page.getByRole('button', { name: 'Add', exact: true }).click()
await page.waitForSelector('.modal .repo-row', { timeout: 5000 })
await page.click('.modal-header .icon-btn')
await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 })

// --- new-session composer: git-access toggle defaults on for a matched repo ---
await page.evaluate(() => document.querySelector('button[title="new task"]').click())
await page.waitForSelector('.modal input')
await page.fill('.modal input', 'try')
await page.click('.modal .form button')
await page.waitForSelector('.task-node', { timeout: 5000 })

await page.evaluate(() => document.querySelector('button[title="new session"]').click())
await page.waitForSelector('.modal')
// The git-access select exists and defaulted to "on" (a credential resolves).
const gitAccessOn = await page.evaluate(() => {
  const labels = [...document.querySelectorAll('.modal .form label')]
  const l = labels.find((x) => x.textContent?.trim().startsWith('git access'))
  const sel = l?.querySelector('select')
  return sel ? sel.value : null
})
assert.equal(gitAccessOn, 'on', 'git access defaults on when a credential resolves')
console.log('composer git-access default OK')
await page.screenshot({ path: path.join(SHOT_DIR, 'g3-composer.png') })

await app.close()
console.log('SMOKE PASS')
