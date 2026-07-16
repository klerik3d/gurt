import { createRequire } from 'node:module'
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

// Open the Agents modal (⚙) — the surface this change rewrote.
await page.click('button[title="agents"]')
await page.waitForSelector('.agent-block', { timeout: 5000 })
await page.screenshot({ path: path.join(SHOT_DIR, '02-agents-initial.png') })
const kinds = await page.$$eval('.agent-block select', (sels) =>
  sels.map((s) => Array.from(s.options).map((o) => o.value))
)
console.log('agent rows:', kinds.length, 'kind options per row:', kinds[0])

// Add a second claude instance ("claude code work") to prove multi-instance.
await page.click('button.link:has-text("add agent")')
const newRow = page.locator('.agent-block').last()
await newRow.locator('.agent-label').fill('claude code work')
await newRow.locator('.agent-fields input[type="password"]').fill('tok-work')
await page.screenshot({ path: path.join(SHOT_DIR, '03-agents-added.png') })

// Save, then reopen to confirm it round-tripped through agents.json.
await page.click('button:has-text("Save")')
await page.waitForSelector('.agent-block', { state: 'detached', timeout: 5000 }).catch(() => {})
await page.click('button[title="agents"]')
await page.waitForSelector('.agent-block', { timeout: 5000 })
const labels = await page.$$eval('.agent-block .agent-label', (els) => els.map((e) => e.value))
console.log('labels after save+reopen:', JSON.stringify(labels))
await page.screenshot({ path: path.join(SHOT_DIR, '04-agents-persisted.png') })

const raw = fs.readFileSync(path.join(GURT_ROOT, 'agents.json'), 'utf8')
console.log('--- agents.json on disk ---')
console.log(raw)

await app.close()
console.log('DONE')
