import { createRequire } from 'node:module'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SHOT_DIR = path.join(process.env.SCRATCH ?? '/tmp/gurt-smoke', 'shots')
const GURT_ROOT = path.join(process.env.SCRATCH ?? '/tmp/gurt-smoke', 'gurt-root')
fs.mkdirSync(SHOT_DIR, { recursive: true })
fs.rmSync(GURT_ROOT, { recursive: true, force: true })
fs.mkdirSync(GURT_ROOT, { recursive: true })

const require = createRequire(path.join(APP_DIR, 'package.json'))
const { _electron } = require('playwright-core')
const electronPath = require('electron') // path string to the electron binary on linux

const env = { ...process.env, GURT_ROOT, GURT_FORCE_PLAINTEXT: '1', DISPLAY: process.env.DISPLAY ?? ':99' }
delete env.ELECTRON_RUN_AS_NODE
// Inherited from a dev-server shell it would make the app load that server's
// (different) renderer instead of out/renderer — smoke the built one.
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

await page.waitForSelector('.sidebar', { timeout: 15000 })
await page.screenshot({ path: path.join(SHOT_DIR, '01-initial.png') })
console.log('initial render OK')

// The client registry (Settings → Clients) starts empty — no seeded kinds.
await page.click('.activitybar .ab-item[title="Settings"]')
await page.click('.set-nav-item:has-text("Clients")')
await page.waitForSelector('.tp-dashed:has-text("no clients yet")', { timeout: 5000 })
assert.equal(await page.locator('.set-row').count(), 0, 'client registry starts empty')
await page.screenshot({ path: path.join(SHOT_DIR, '02-clients-empty.png') })

// The agent secret lives in the credential store. Add an `agent-token`
// credential through the real UI (Settings → Credentials) it will link to.
await page.click('.set-nav-item:has-text("Credentials")')
await page.click('button:has-text("+ New credential")')
await page.waitForSelector('.set-card')
await page.click('.cred-type .pick-row')
await page.click('.pick-menu .menu-item:has-text("agent token")')
await page.fill('.set-card input[placeholder="GITHUB_TOKEN"]', 'claude token')
await page.fill('.set-card input[type="password"]', 'tok-work')
await page.click('.set-card button:has-text("Save")')
await page.waitForSelector('.set-row:has-text("claude token")', { timeout: 5000 })
// Secrets are masked over IPC (T3): 8 chars → bare mask, no tail.
const preview = (await page.textContent('.set-row:has-text("claude token") .cred-preview'))?.trim()
assert.equal(preview, '••••••', 'secret comes back masked over IPC')
console.log('agent-token credential saved OK')

// Add a client and link it to that credential (mapping, not storing the secret).
await page.click('.set-nav-item:has-text("Clients")')
await page.click('button:has-text("+ New client")')
await page.waitForSelector('.set-card')
await page.fill('.set-card input[placeholder="claude · personal"]', 'claude code work')
await page.click('.set-card button:has-text("none — adapter")')
await page.click('.pick-menu .menu-item:has-text("claude token")')
await page.screenshot({ path: path.join(SHOT_DIR, '03-client-added.png') })
await page.click('.set-card button:has-text("Save")')
await page.waitForSelector('.set-row:has-text("claude code work")', { timeout: 5000 })

// Reopen to confirm it round-tripped through agents.json.
await page.click('.set-row:has-text("claude code work")')
await page.waitForSelector('.set-card input[placeholder="claude · personal"]')
const label = await page.inputValue('.set-card input[placeholder="claude · personal"]')
console.log('label after save+reopen:', JSON.stringify(label))
await page.screenshot({ path: path.join(SHOT_DIR, '04-client-persisted.png') })

const agents = JSON.parse(fs.readFileSync(path.join(GURT_ROOT, 'agents.json'), 'utf8'))
const creds = JSON.parse(fs.readFileSync(path.join(GURT_ROOT, 'credentials.json'), 'utf8'))
console.log('--- agents.json on disk ---')
console.log(JSON.stringify(agents, null, 2))

const inst = Object.values(agents).find((a) => a.label === 'claude code work')
assert.ok(inst, 'the linked client persisted')
assert.ok(!('secret' in inst), 'client carries no inline secret')
const token = creds.credentials.find((c) => c.kind === 'agent-token')
assert.ok(token && token.data.secret === 'tok-work', 'the secret lives in the credential store')
assert.equal(inst.credentialId, token.id, 'client maps to the credential by id')
console.log('client maps to credential OK:', inst.credentialId)

await app.close()
console.log('DONE')
