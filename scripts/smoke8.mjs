// Native git access, UI-only (no docker): drives Settings → Credentials
// through the real UI → IPC → store, then checks the repo credential
// resolution note and the composer's harness credential note.
//
// Secrets are masked over IPC now (T3), so this smoke also asserts the mask
// round-trip: the renderer never sees plaintext, an untouched secret survives
// a label-only edit, and that edit does not re-verify against the forge (the
// seeded token is fake — a verification request would fail the save).
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SHOT_DIR = path.join(process.env.SCRATCH ?? '/tmp', 'shots')
const GURT_ROOT = path.join(process.env.SCRATCH ?? '/tmp', 'gurt-root')
fs.mkdirSync(SHOT_DIR, { recursive: true })
fs.rmSync(GURT_ROOT, { recursive: true, force: true })
fs.mkdirSync(GURT_ROOT, { recursive: true })

// Seed a git-token with a stamped identity: a label-only save must keep the
// secret and skip forge re-verification (sameSecret + identity → no network).
fs.writeFileSync(
  path.join(GURT_ROOT, 'credentials.json'),
  JSON.stringify(
    {
      version: 2,
      credentials: [
        {
          id: 'gh-tok',
          label: 'gh token',
          kind: 'git-token',
          hosts: ['github.com'],
          data: {
            username: 'octocat',
            secret: 'ghp_smoketest',
            gitName: 'Octo Cat',
            gitEmail: 'octo@example.com'
          }
        }
      ]
    },
    null,
    2
  ) + '\n'
)

const require = createRequire(path.join(APP_DIR, 'package.json'))
const { _electron } = require('playwright-core')

const env = { ...process.env, GURT_ROOT, GURT_FORCE_PLAINTEXT: '1' }
delete env.ELECTRON_RUN_AS_NODE
// Inherited from a dev-server shell it would make the app load that server's
// (different) renderer instead of out/renderer — smoke the built one.
delete env.ELECTRON_RENDERER_URL

// ELECTRON overrides the binary — needed when this checkout's node_modules
// was installed for another platform (e.g. inside a linux container).
const app = await _electron.launch({
  executablePath:
    process.env.ELECTRON ??
    path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
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

const openSettings = async (section) => {
  await page.click('.activitybar .ab-item[title="Settings"]')
  await page.click(`.set-nav-item:has-text("${section}")`)
}
const openWork = () => page.click('.activitybar .ab-item[title="Tasks & sessions"]')

// --- credentials: the stored secret is served masked, never plaintext ---
await openSettings('Credentials')
await page.waitForSelector('.set-row .cred-preview')
const preview = (await page.textContent('.set-row .cred-preview'))?.trim()
assert.equal(preview, '••••••test', `collapsed row shows the mask, got: ${preview}`)
assert.ok(!(await page.content()).includes('ghp_smoketest'), 'plaintext secret never reaches the renderer')
await page.screenshot({ path: path.join(SHOT_DIR, 'g1-credentials.png') })

// --- label-only edit: keeps the stored secret, skips forge re-verification ---
await page.click('.set-row:has-text("gh token")')
await page.waitForSelector('.set-card input[type="password"]')
assert.equal(await page.inputValue('.set-card input[type="password"]'), '', 'secret input opens empty')
assert.equal(
  await page.getAttribute('.set-card input[type="password"]', 'placeholder'),
  '••••••test',
  'mask is the placeholder for a stored secret'
)
await page.fill('.set-card input[placeholder="GITHUB_TOKEN"]', 'gh token 2')
await page.click('.set-card button:has-text("Save")')
await page.waitForSelector('.set-row:has-text("gh token 2")', { timeout: 5000 })

const credFile = path.join(GURT_ROOT, 'credentials.json')
let creds = JSON.parse(fs.readFileSync(credFile, 'utf8'))
assert.equal(creds.credentials.length, 1, 'one credential persisted')
assert.equal(creds.credentials[0].label, 'gh token 2')
assert.equal(creds.credentials[0].data.secret, 'ghp_smoketest', 'label-only edit kept the secret')
console.log('label-only edit OK (secret unchanged, no re-verification)')

// --- add an agent-token through the UI (not forge-verified, unlike git-token) ---
await page.click('button:has-text("+ New credential")')
await page.waitForSelector('.set-card')
await page.click('.cred-type .pick-row')
await page.click('.pick-menu .menu-item:has-text("agent token")')
await page.fill('.set-card input[placeholder="GITHUB_TOKEN"]', 'claude token')
await page.fill('.set-card input[type="password"]', 'tok-work-12345')
await page.click('.set-card button:has-text("Save")')
await page.waitForSelector('.set-row:has-text("claude token")', { timeout: 5000 })

creds = JSON.parse(fs.readFileSync(credFile, 'utf8'))
const agentTok = creds.credentials.find((c) => c.kind === 'agent-token')
assert.ok(agentTok, 'agent-token persisted')
assert.equal(agentTok.data.secret, 'tok-work-12345', 'plaintext on disk under GURT_FORCE_PLAINTEXT')
assert.ok(!('sealed' in agentTok), 'no sealed blob under GURT_FORCE_PLAINTEXT')
const agentPreview = (
  await page.textContent('.set-row:has-text("claude token") .cred-preview')
)?.trim()
assert.equal(agentPreview, '••••••2345', 'saved secret comes back masked')
console.log('credential persisted OK')

// --- workspace + repo: the repo modal shows the credential resolution ---
await openWork()
await page.click('.sb-ws-btn')
await page.click('.menu-item:has-text("+ new workspace")')
await page.waitForSelector('.modal input')
await page.fill('.modal input', 'personal')
await page.click('.modal button:has-text("Create")')
await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 })

await openSettings('Repos')
await page.click('button:has-text("+ New repo")')
await page.waitForSelector('.modal')
await page.fill('.modal input[placeholder="checkout-web"]', 'demo')
await page.fill(
  '.modal input[placeholder^="https://github.com"]',
  'https://github.com/octocat/Hello-World.git'
)
await page.waitForSelector('.modal .env-access-note')
const note = (await page.textContent('.modal .env-access-note'))?.trim()
assert.ok(/auto → gh token 2/.test(note ?? ''), `resolution note mentions the credential: ${note}`)
console.log('repo credential resolution note OK:', note)
await page.screenshot({ path: path.join(SHOT_DIR, 'g2-repo-credential.png') })
await page.click('.modal button:has-text("Save")')
await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 })
await page.waitForSelector('.set-row:has-text("demo")', { timeout: 5000 })

// --- composer: harness config shows the resolved credential for the repo ---
await openWork()
await page.click('button[title="New task · ⌘⇧N"]')
await page.fill('input[placeholder="task name"]', 'try')
await page.press('input[placeholder="task name"]', 'Enter')
await page.waitForSelector('.sb-task', { timeout: 5000 })

await page.evaluate(() => document.querySelector('button[title="new session"]').click())
await page.waitForSelector('.modal')
// Pick the repo (sessions default to none), then open Harness config.
await page.click('.modal .chip-dashed:has-text("no repository")')
await page.click('.modal .menu-item:has-text("demo")')
await page.click('.modal .hc-head')
await page.waitForSelector('.modal .hc .hc-note')
const credNote = (await page.textContent('.modal .hc .hc-note'))?.trim()
assert.equal(credNote, 'credential: gh token 2', `harness shows the managed credential: ${credNote}`)
console.log('composer credential note OK')
await page.screenshot({ path: path.join(SHOT_DIR, 'g3-composer.png') })
await page.click('.modal button[title="close"]')
await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 })

await app.close()
console.log('SMOKE PASS')
