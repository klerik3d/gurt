// The first-run screen in the real UI (docs/requirements-first-run.md §11
// item 6), on the machine that has nothing.
//
// This runs against an EMPTY `GURT_ROOT` and, in this devcontainer, with no
// docker daemon — which is the point. The screen a cold machine gets has to be
// legible and honest exactly there: the rows report what is actually wrong,
// the button is refused for a stated reason rather than silently doing
// nothing, and the whole thing gets out of the way once a session exists.
//
// What is NOT covered here, for want of a daemon (recorded in §11 item 7):
// Prepare pulling the two images, and either create reaching `started`. The
// sign-in button's *click* is likewise not driven — it opens the system
// browser against a real provider, which a smoke must not do; what is checked
// is that it leads, names the right provider per kind, and that the key path
// stays one click away.
//
//   npm run build && node scripts/smoke-first-run.mjs
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SCRATCH = process.env.SCRATCH ?? '/tmp/gurt-smoke-first-run'
const GURT_ROOT = path.join(SCRATCH, 'gurt-root')
const SHOT_DIR = path.join(SCRATCH, 'shots')
// A workspace and a task, and nothing else. No agent, no credential, no
// session — which is the fixture, and also an assertion in itself: first run
// is "the store has never produced a session" (§2.1), so a user who got as far
// as creating a workspace by hand and then stalled is still the user this
// screen is for. Seeding them here also keeps the smoke off the
// new-workspace/new-task modals, which have their own smokes.
fs.rmSync(GURT_ROOT, { recursive: true, force: true })
fs.mkdirSync(path.join(GURT_ROOT, 'w', 't'), { recursive: true })
fs.writeFileSync(
  path.join(GURT_ROOT, 'w', 'workspace.json'),
  JSON.stringify({ repos: [], envs: [] })
)
fs.writeFileSync(path.join(GURT_ROOT, 'w', 't', 'task.json'), JSON.stringify({}))
fs.mkdirSync(SHOT_DIR, { recursive: true })

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

try {
  // --- a store with no sessions opens on the welcome screen ---
  await page.waitForSelector('.sidebar', { timeout: 15000 })
  await page.waitForSelector('.sb-task', { timeout: 10000 })
  await page.waitForSelector('.wc', { timeout: 10000 })
  // Not the old placeholder: a first-time user gets the screen with the
  // answers on it, not a logo and a keyboard shortcut.
  assert.equal(await page.locator('.placeholder').count(), 0)
  console.log('first run: welcome screen shown on an empty store OK')

  // --- the checklist rows ---
  await page.waitForSelector('.wc-row', { timeout: 10000 })
  // Wait for the probes to answer before reading the rows — the first render
  // is the "checking this machine…" placeholder.
  await page.waitForSelector('.wc-row-label', { timeout: 15000 })
  const labels = await page.locator('.wc-row-label').allInnerTexts()
  assert.deepEqual(
    labels.map((l) => l.trim()),
    ['Docker CLI', 'Docker daemon', 'Images'],
    'three rows, in the order the screen reads them'
  )
  await shot('01-welcome')
  console.log(`first run: checklist rows OK (${labels.join(', ')})`)

  // --- the machine's actual state is reported, whatever it is ---
  // This environment has no docker, so the gating rows are red and the button
  // must be refused *with the reason next to it*. On a machine that does have
  // Docker the same assertions hold with the states inverted, so the smoke is
  // not pinned to this devcontainer's shape.
  const dots = await page.locator('.wc-row .dot').evaluateAll((els) =>
    els.map((e) => e.className)
  )
  const healthy = dots[0].includes('dot-green') && dots[1].includes('dot-green')

  // --- signing in is the primary path, and it leads ---
  // The credential a user meeting gurt actually has is a login, not a string
  // (requirements-oauth-credentials.md §1), so the sign-in button is the one
  // that is visible without asking, and the key field is behind a disclosure.
  const signInBtn = page.locator('button:has-text("Sign in with")')
  await signInBtn.waitFor({ timeout: 5000 })
  assert.match(
    (await signInBtn.innerText()).trim(),
    /Claude \(Anthropic\)/,
    'claude-code leads with its own provider named'
  )
  assert.equal(await page.locator('.wc-token').count(), 0, 'no key field until asked for')
  assert.equal(
    await signInBtn.isDisabled(),
    !healthy,
    healthy ? 'a green machine can sign in' : 'a red machine cannot'
  )
  if (!healthy) {
    const hint = (await page.locator('.wc-hint').first().innerText()).trim()
    assert.match(hint, /fix the red rows/, 'a disabled button says why')
  }
  console.log('first run: sign-in is the primary path OK')

  // --- the key path is one click away, never buried ---
  await page.click('.wc-alt')
  await page.waitForSelector('.wc-token', { timeout: 5000 })
  assert.equal(await page.locator('.wc-token').getAttribute('type'), 'password')
  assert.match(
    await page.locator('.wc-token').getAttribute('placeholder'),
    /CLAUDE_CODE_OAUTH_TOKEN/,
    'says which key is wanted'
  )
  console.log('first run: the API-key path is one click away OK')

  // --- each kind leads with its own provider; opencode has none ---
  const kinds = await page.locator('.wc-kinds button').allInnerTexts()
  assert.equal(kinds.length, 4, 'claude / codex / gemini / opencode')
  await page.click('.wc-kinds button:has-text("codex")')
  assert.match((await signInBtn.innerText()).trim(), /ChatGPT \(OpenAI\)/)
  await page.click('.wc-kinds button:has-text("gemini")')
  assert.match((await signInBtn.innerText()).trim(), /Gemini \(Google\)/)

  // opencode has no verified sign-in delivery (§5.2.1 of the oauth doc), so it
  // says so and opens the key field instead of offering a button that would
  // complete a browser round-trip and then fail at session start.
  await page.click('.wc-kinds button:has-text("opencode")')
  await page.waitForSelector('.wc-token', { timeout: 5000 })
  assert.equal(await signInBtn.count(), 0, 'no sign-in button for a kind with no sign-in')
  assert.match(
    (await page.locator('.wc-start').innerText()),
    /has no sign-in/,
    'and it says why rather than silently offering only a field'
  )
  assert.match(
    await page.locator('.wc-token').getAttribute('placeholder'),
    /ANTHROPIC_API_KEY/,
    'and follows the picked kind'
  )
  console.log('first run: per-kind providers, and opencode’s honest fallback OK')
  await page.click('.wc-kinds button:has-text("claude")')

  // --- the same checklist has a permanent home in Settings ---
  await page.click('.ab-item[title^="Settings"]')
  await page.waitForSelector('.settings', { timeout: 5000 })
  await page.click('.set-nav-item:has-text("Machine")')
  await page.waitForSelector('.set-title:text-is("Machine")', { timeout: 5000 })
  await page.waitForSelector('.wc-row-label', { timeout: 15000 })
  assert.equal(
    (await page.locator('.wc-row-label').allInnerTexts()).length,
    3,
    'the same three rows, without an empty store'
  )
  await shot('02-settings-machine')
  console.log('first run: Settings → Machine shows the checklist OK')

  // --- creating a session by hand is the way out of the welcome screen ---
  await page.click('.ab-item[title^="Tasks"]')
  // Still the welcome screen: a workspace and a task are not a session, and
  // the user who created them is still the user this screen is for.
  await page.waitForSelector('.wc', { timeout: 5000 })
  assert.equal(await page.locator('.wc').count(), 1, 'a task alone does not end the first run')

  await page.click('.sb-task', { button: 'right' })
  await page.waitForSelector('.ctx-menu', { timeout: 5000 })
  await page.click('.ctx-menu .menu-item:has-text("New session")')
  await page.waitForSelector('.session-pane', { timeout: 10000 })
  console.log('first run: a draft ends the first run OK')

  // --- and the palette brings it back ---
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
  await page.waitForSelector('.palette', { timeout: 5000 })
  await page.fill('.pal-input', 'welcome')
  await page.click('.palette .pal-item:has-text("Welcome")')
  await page.waitForSelector('.wc', { timeout: 5000 })
  assert.equal(await page.locator('.session-pane').count(), 0, 'it replaced the session pane')
  await shot('03-welcome-again')
  console.log('first run: palette re-opens the welcome screen OK')

  console.log('smoke-first-run: PASS')
} finally {
  await shot('99-final').catch(() => {})
  await app.close()
}
