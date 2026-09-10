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
// It ends by relaunching with `GURT_WELCOME=always` against a store that now
// has a session and a stored `never` — the leg the setting exists for.
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
  // A popup, over the main pane rather than in place of it: a first-time user
  // gets the screen with the answers on it, and the pane they will be left
  // with once they skip it is already behind it.
  assert.equal(await page.locator('.wc-backdrop').count(), 1, 'it opens as a popup')
  assert.equal(await page.locator('.placeholder').count(), 1, 'over the pane, not instead of it')
  console.log('first run: welcome screen shown on an empty store OK')

  // --- the checklist draws complete, then fills in (§3.5) ---
  // All three rows exist before any probe has answered — the list is static
  // knowledge, so the screen is never a spinner over an empty box.
  await page.waitForSelector('.wc-row', { timeout: 10000 })
  const labels = await page.locator('.wc-row-label').allInnerTexts()
  assert.deepEqual(
    labels.map((l) => l.trim()),
    ['Docker CLI', 'Docker daemon', 'Images'],
    'three rows, in the order the screen reads them, from the first frame'
  )
  await shot('01-welcome-sweeping')

  // Every row settles: none is left `pending`, and exactly one row at a time
  // is `checking` on the way there.
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.wc-row').length === 3 &&
      !document.querySelector('.wc-row.wc-pending, .wc-row.wc-checking'),
    undefined,
    { timeout: 20000 }
  )
  // A settled row carries a state class and a detail; a passing one carries
  // the tick. (On this machine the docker rows fail, so only assert the
  // shape that holds either way.)
  const settled = await page.locator('.wc-row').evaluateAll((els) =>
    els.map((e) => ({
      cls: e.className,
      detail: e.querySelector('.wc-row-detail')?.textContent?.trim() ?? '',
      tick: !!e.querySelector('.wc-tick')
    }))
  )
  for (const r of settled) {
    assert.match(r.cls, /wc-(ok|warn|fail)/, `row settled: ${r.cls}`)
    assert.ok(r.detail.length > 0, 'a settled row says what it found')
    assert.equal(r.tick, /wc-ok/.test(r.cls), 'the tick marks "done and fine", nothing else')
  }
  await shot('02-welcome-settled')
  console.log(`first run: checklist sweeps and settles OK (${labels.join(', ')})`)

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

  // --- it can be skipped, and the skip lasts the run ---
  await page.keyboard.press('Escape')
  await page.waitForSelector('.wc', { state: 'detached', timeout: 5000 })
  assert.equal(await page.locator('.placeholder').count(), 1, 'skipping lands on the pane behind')
  // A skip is about this launch: the store still has no session, so the rule
  // that showed it has not changed, and only the skip is holding it closed.
  await page.click('.ab-item[title^="Tasks"]')
  assert.equal(await page.locator('.wc').count(), 0, 'and it stays closed until asked for')

  // ⌘K reaches it under every mode — that is the guarantee the checkbox is
  // safe to tick against.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
  await page.waitForSelector('.palette', { timeout: 5000 })
  await page.fill('.pal-input', 'welcome')
  await page.click('.palette .pal-item:has-text("Welcome")')
  await page.waitForSelector('.wc', { timeout: 5000 })
  console.log('first run: Esc skips the popup, ⌘K brings it back OK')

  // --- "don't show this again" is the mode, written from the popup ---
  const again = page.locator('.wc-again input')
  assert.equal(await again.isChecked(), false, 'not ticked on a default (`auto`) store')
  await again.check()
  await shot('02-welcome-dont-show')
  // Unticking restores what was there rather than assuming a value, so the
  // pair of clicks is a no-op — asserted through Settings below, which reads
  // the same stored mode.
  await again.uncheck()
  await page.click('.modal-head .icon-sq')
  await page.waitForSelector('.wc', { state: 'detached', timeout: 5000 })
  console.log('first run: the popup writes the welcome mode OK')

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
  // One heading, not two: the section header is the heading here, and the
  // checklist's own is suppressed (`heading={null}`).
  assert.equal(
    await page.locator('.wc-check-head').count(),
    0,
    'the checklist does not stack a second heading under the section title'
  )
  await shot('03-settings-machine')
  console.log('first run: Settings → Machine shows the checklist OK')

  // --- creating a session by hand is the way out of the welcome screen ---
  await page.click('.ab-item[title^="Tasks"]')
  await page.click('.sb-task', { button: 'right' })
  await page.waitForSelector('.ctx-menu', { timeout: 5000 })
  await page.click('.ctx-menu .menu-item:has-text("New session")')
  await page.waitForSelector('.session-pane', { timeout: 10000 })
  console.log('first run: a draft ends the first run OK')

  // --- and the palette brings it back, over whatever is open ---
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
  await page.waitForSelector('.palette', { timeout: 5000 })
  await page.fill('.pal-input', 'welcome')
  await page.click('.palette .pal-item:has-text("Welcome")')
  await page.waitForSelector('.wc', { timeout: 5000 })
  await shot('03-welcome-again')
  console.log('first run: palette re-opens the welcome screen OK')

  // Skipping it hands the user back to where they were, not to an empty pane.
  await page.keyboard.press('Escape')
  await page.waitForSelector('.wc', { state: 'detached', timeout: 5000 })

  // --- the mode is a setting, and it lives beside the checklist ---
  await page.click('.ab-item[title^="Settings"]')
  await page.click('.set-nav-item:has-text("Machine")')
  await page.waitForSelector('.set-row:has-text("Welcome screen")', { timeout: 5000 })
  const modeRow = page.locator('.set-row:has-text("Welcome screen")')
  assert.equal(
    (await modeRow.locator('.btn-link.active').innerText()).replace(' ✓', '').trim(),
    'auto',
    'tick-then-untick in the popup left the stored mode where it was'
  )
  assert.deepEqual(
    (await modeRow.locator('.btn-link').allInnerTexts()).map((t) => t.replace(' ✓', '').trim()),
    ['auto', 'always', 'never'],
    'three modes, in the order the doc lists them'
  )
  await modeRow.locator('.btn-link:has-text("never")').click()
  await page.waitForSelector('.set-row:has-text("Welcome screen") .btn-link.active:has-text("never")', {
    timeout: 5000
  })
  await shot('04-welcome-mode')
  console.log('first run: the mode picker persists OK')
} finally {
  await shot('99-final').catch(() => {})
  await app.close()
}

// --- GURT_WELCOME: the screen on a store that is well past its first run ----
//
// The store now has a session and the mode on disk is `never`, so nothing
// would show the screen. This is the leg the setting exists for: a demo
// machine that wants the screen every launch, and a smoke that needs to reach
// it without emptying the store.
const forced = await _electron.launch({
  executablePath: electronPath,
  args: [APP_DIR, '--no-sandbox'],
  env: { ...env, GURT_WELCOME: 'always' },
  timeout: 30000
})
try {
  const p2 = await forced.firstWindow()
  await p2.waitForSelector('.sidebar', { timeout: 15000 })
  await p2.waitForSelector('.sb-task', { timeout: 10000 })
  await p2.waitForSelector('.wc', { timeout: 10000 })
  await p2.screenshot({ path: path.join(SHOT_DIR, '05-forced.png') })
  console.log('first run: GURT_WELCOME=always overrides a stored `never` OK')

  console.log('smoke-first-run: PASS')
} finally {
  await forced.close()
}
