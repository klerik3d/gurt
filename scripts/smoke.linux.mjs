import { createRequire } from 'node:module'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SHOT_DIR = path.join(process.env.SCRATCH ?? '/tmp/gurt-smoke', 'shots')
const GURT_ROOT = path.join(process.env.SCRATCH ?? '/tmp/gurt-smoke', 'gurt-root')
fs.mkdirSync(SHOT_DIR, { recursive: true })
fs.mkdirSync(GURT_ROOT, { recursive: true })

const require = createRequire(path.join(APP_DIR, 'package.json'))
const { _electron } = require('playwright-core')
const electronPath = require('electron') // path string to the electron binary on linux

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

await page.waitForSelector('.sidebar', { timeout: 15000 })
await page.screenshot({ path: path.join(SHOT_DIR, '01-initial.png') })
console.log('initial render OK')

// The agent registry now starts empty (no seeded kinds). Confirm the modal
// opens with no rows.
await page.click('button[title="agents"]')
await page.waitForSelector('.modal', { timeout: 5000 })
await page.waitForSelector('.agent-block', { state: 'attached', timeout: 500 }).catch(() => {})
assert.equal(await page.locator('.agent-block').count(), 0, 'agent registry starts empty')
await page.screenshot({ path: path.join(SHOT_DIR, '02-agents-empty.png') })
await page.click('.modal .modal-header .icon-btn') // close
await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 })

// The agent secret lives in the credential store now. Add an `agent-token`
// credential (🔑) it will link to.
await page.click('button[title="credentials"]')
await page.waitForSelector('.modal', { timeout: 5000 })
await page.click('text=+ add credential')
const credRow = page.locator('.agent-block').last()
await credRow.locator('.agent-label').fill('claude token')
await credRow.locator('select').selectOption('agent-token')
await credRow.locator('input[type="password"]').fill('tok-work')
await page.click('button:has-text("Save")')
await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 })
console.log('agent-token credential saved OK')

// Add an agent and link it to that credential (mapping, not storing the secret).
await page.click('button[title="agents"]')
await page.waitForSelector('.modal', { timeout: 5000 })
await page.click('button.link:has-text("add agent")')
const row = page.locator('.agent-block').last()
await row.locator('.agent-label').fill('claude code work')
await row.locator('.agent-fields select').selectOption({ label: 'claude token' })
await page.screenshot({ path: path.join(SHOT_DIR, '03-agents-added.png') })
await page.click('button:has-text("Save")')
await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 })

// Reopen to confirm it round-tripped through agents.json.
await page.click('button[title="agents"]')
await page.waitForSelector('.agent-block', { timeout: 5000 })
const labels = await page.$$eval('.agent-block .agent-label', (els) => els.map((e) => e.value))
console.log('labels after save+reopen:', JSON.stringify(labels))
await page.screenshot({ path: path.join(SHOT_DIR, '04-agents-persisted.png') })

const agents = JSON.parse(fs.readFileSync(path.join(GURT_ROOT, 'agents.json'), 'utf8'))
const creds = JSON.parse(fs.readFileSync(path.join(GURT_ROOT, 'credentials.json'), 'utf8'))
console.log('--- agents.json on disk ---')
console.log(JSON.stringify(agents, null, 2))

const inst = Object.values(agents).find((a) => a.label === 'claude code work')
assert.ok(inst, 'the linked agent persisted')
assert.ok(!('secret' in inst), 'agent carries no inline secret')
const token = creds.credentials.find((c) => c.kind === 'agent-token')
assert.ok(token && token.data.secret === 'tok-work', 'the secret lives in the credential store')
assert.equal(inst.credentialId, token.id, 'agent maps to the credential by id')
console.log('agent maps to credential OK:', inst.credentialId)

await app.close()
console.log('DONE')
