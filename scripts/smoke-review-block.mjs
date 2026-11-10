// The review loop's Review block on an executor draft's Config tab, in the real
// app (docs/requirements-review-loop.md §3, acceptance §12 item 12): the
// defaults and what a repo's own defaults prefill, the cross-kind default
// reviewer and the same-kind fallback, Run disabled for an identical agent and
// model (and re-enabled once another model is picked), pi neither offered as
// reviewer nor accepted as executor, the "when clean" ladder for forge, local
// and mixed repos, a copy carrying the block, and everything persisting across a
// reload. Then Settings → Repos: the check command and the review defaults,
// validated and saved.
//
// What is under test is the wiring — the pickers, the IPC payload, what the
// Config tab reads back — so nothing here needs an agent, a clone or docker.
// Run is never pressed: it is only checked for being enabled or not.
//
//   npm run build && node scripts/smoke-review-block.mjs
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SCRATCH = process.env.SCRATCH ?? '/tmp/gurt-smoke-review-block'
const GURT_ROOT = path.join(SCRATCH, 'gurt-root')
const SHOT_DIR = path.join(SCRATCH, 'shots')
fs.rmSync(GURT_ROOT, { recursive: true, force: true })
fs.mkdirSync(SHOT_DIR, { recursive: true })

const ws = 'w'
const task = 't'
fs.mkdirSync(path.join(GURT_ROOT, ws, task), { recursive: true })
const write = (rel, data) => fs.writeFileSync(path.join(GURT_ROOT, rel), JSON.stringify(data, null, 2))
write(`${ws}/workspace.json`, {
  repos: [
    // A forge repo with a check, no review defaults.
    { name: 'fx', url: 'https://github.com/o/fx.git', check: 'npm test' },
    // A forge repo with neither a check nor a reviewer named, whose defaults turn the loop on.
    { name: 'pre', url: 'https://github.com/o/pre.git', check: 'make check', review: { enabled: true, maxRounds: 3, whenClean: 'commit' } },
    { name: 'nochk', url: 'https://github.com/o/nochk.git' },
    // gurt's own repo: the local ladder (the flag is gurt's; the store reads it as written).
    { name: 'loc', url: path.join(GURT_ROOT, ws, 'repos', 'loc.git'), local: true }
  ],
  envs: [
    { name: 'dev', image: 'x', repo: 'fx' },
    { name: 'preenv', image: 'x', repo: 'pre' }
  ],
  defaultAgent: 'a1'
})
fs.writeFileSync(path.join(GURT_ROOT, ws, task, 'task.json'), JSON.stringify({}))
const cred = (id) => ({ id, label: id, kind: 'agent-token', hosts: [], data: { secret: `sk-${id}-aaaaaaaaaaaaaaaaaaaa` } })
write('credentials.json', { version: 2, credentials: [cred('c1'), cred('c2')] })
write('agents.json', {
  a1: { kind: 'claude-code', label: 'claude', credentialId: 'c1' },
  a2: { kind: 'codex', label: 'codex', credentialId: 'c2' },
  a3: { kind: 'pi', label: 'pi', credentialId: 'c1' }
})

const require = createRequire(path.join(APP_DIR, 'package.json'))
const { _electron } = require('playwright-core')
const electronPath = require('electron')

// The welcome popup opens over the main pane on a store with no sessions and
// would swallow the first clicks; `never` is a user's own escape hatch.
const env = { ...process.env, GURT_ROOT, GURT_WELCOME: 'never', GURT_FORCE_PLAINTEXT: '1', DISPLAY: process.env.DISPLAY ?? ':99' }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const electronProfile = fs.mkdtempSync(path.join(path.dirname(GURT_ROOT), 'electron-profile-'))

let app
let page
async function launch() {
  app = await _electron.launch({
    executablePath: electronPath,
    args: [APP_DIR, '--no-sandbox', `--user-data-dir=${electronProfile}`],
    env,
    timeout: 30000
  })
  page = await app.firstWindow()
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[console.error]', m.text())
  })
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  // The app restores the view it was closed in — which may be Settings.
  await page.waitForSelector('.activitybar', { timeout: 15000 })
  // Clicking the active item collapses the sidebar, so only click when it is not showing.
  if (!(await page.locator('.sidebar').isVisible())) await page.click('.activitybar .ab-item[title^="Agents"]')
  await page.waitForSelector('.sidebar', { timeout: 15000 })
  await page.waitForSelector('.sb-task', { timeout: 10000 })
}

const shot = (name) => page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) })
const row = (label) => `.ns-body .seclabel-row:has(.seclabel:text-is("${label}")) + .pick-wrap .pick-row`
const BLOCK = '.ns-body .review-block'
const PROBLEM = `${BLOCK} [data-testid="review-problem"]`
const chips = (aria) => `${BLOCK} [aria-label="${aria}"] .chip-btn`
const T = { timeout: 5000 }

const sessionsFile = path.join(GURT_ROOT, ws, task, 'sessions.json')
const records = () => (fs.existsSync(sessionsFile) ? JSON.parse(fs.readFileSync(sessionsFile, 'utf8')) : [])
/** Persistence is debounced — poll the file for the record. */
async function persisted(id, pred, label) {
  for (let i = 0; i < 60; i++) {
    const r = records().find((x) => x.info.id === id)
    if (r && pred(r.info)) return r.info
    await new Promise((res) => setTimeout(res, 50))
  }
  throw new Error(`sessions.json never showed: ${label}`)
}

const newSession = async () => {
  await page.click('.sb-task', { button: 'right' })
  await page.waitForSelector('.ctx-menu', T)
  await page.click('.ctx-menu .menu-item:has-text("New session")')
  await page.waitForSelector('.session-pane .tab-bar', { timeout: 10000 })
  await openConfig()
}
const openConfig = async () => {
  await page.click('.tab-btn:has-text("Config")')
  await page.waitForSelector('.ns-body', T)
}
const openChat = () => page.click('.tab-btn:has-text("Chat")')
const sessionId = async () => {
  // The selected row is the newest one; its id is what sessions.json holds
  // (written on a debounce, so poll).
  for (let i = 0; i < 60; i++) {
    const title = (await page.locator('.sb-session.selected .sb-session-name').first().innerText()).trim()
    const hit = records().find((r) => r.info.title === title)
    if (hit) return hit.info.id
    await new Promise((res) => setTimeout(res, 50))
  }
  return undefined
}
const pickEnv = async (name) => {
  await page.click(row('ENVIRONMENT'))
  await page.click(`.ns-body .pick-menu .menu-item:has-text("${name}")`)
  await page.waitForSelector('.ns-body .pick-menu', { state: 'detached', timeout: 5000 })
}
const pickRepo = async (name) => {
  await page.click(row('REPOSITORIES'))
  await page.click(`.ns-body .pick-menu .menu-item:has-text("${name}")`)
  await page.keyboard.press('Escape')
  await page.waitForSelector('.ns-body .pick-menu', { state: 'detached', timeout: 5000 })
}
const setMode = (repo, mode) =>
  page.click(`.ns-body .repo-mode-row:has(.repo-mode-name:text-is("${repo}")) .chip-btn[data-mode="${mode}"]`)
const untilMode = (repo, mode) =>
  page.waitForSelector(`.ns-body .repo-mode-row:has(.repo-mode-name:text-is("${repo}")) .chip-btn.on[data-mode="${mode}"]`, T)

const loop = (which) => page.click(`${BLOCK} [aria-label="review loop"] .chip-btn:text-is("${which}")`)
const reviewerShown = async () => (await page.locator(`${BLOCK} .pick-row .pick-value`).first().innerText()).trim()
const untilReviewer = (name) => page.waitForSelector(`${BLOCK} .pick-row .pick-value:has-text("${name}")`, T)
const pickReviewer = async (name) => {
  await page.click(`${BLOCK} .pick-row`)
  await page.click(`${BLOCK} .pick-menu .menu-item:has-text("${name}")`)
  await page.waitForSelector(`${BLOCK} .pick-menu`, { state: 'detached', timeout: 5000 })
  await untilReviewer(name)
}
const untilRungs = (want) =>
  page.waitForFunction(
    (expected) => {
      const got = [...document.querySelectorAll('.ns-body .review-block [aria-label="when clean"] .chip-btn')].map((b) => b.innerText.trim())
      return got.length === expected.length && got.every((g, i) => g === expected[i])
    },
    want,
    T
  )
const activeChip = async (aria) => (await page.locator(`${chips(aria)}.on`).allInnerTexts()).map((t) => t.trim())
const untilActive = (aria, text) =>
  page.waitForSelector(`${chips(aria)}.on:text-is("${text}")`, T)
const runBtn = '.draft-body .row-buttons .btn-primary'

try {
  await launch()

  // === 1. a draft with a forge anchor: the loop is off, then on with the defaults ===
  await newSession()
  const id1 = await sessionId()
  assert.ok(id1, 'the new draft is in sessions.json')
  await pickEnv('dev')
  await setMode('o/fx', 'write')
  await untilMode('o/fx', 'write')
  await page.waitForSelector(`${BLOCK} [aria-label="review loop"] .chip-btn.on:text-is("off")`, T)
  assert.equal(await page.locator(`${BLOCK} .pick-row`).count(), 0, 'off: no reviewer, rounds or ladder are drawn')
  console.log('executor draft: Review block present and off by default OK')

  await loop('on')
  await untilReviewer('codex')
  console.log(`default reviewer is another kind with a usable credential: ${await reviewerShown()} OK`)
  await untilActive('review rounds', '2')
  await untilRungs(['notify', 'commit', 'commit + push', 'commit + push + PR'])
  assert.deepEqual(await activeChip('when clean'), ['notify'])
  assert.equal(await page.locator(`${BLOCK} .hc-note:has-text("no check configured")`).count(), 0, 'fx has a check')
  await shot('01-block-on')
  console.log('defaults: 2 rounds, notify, forge ladder OK')

  // A second write repo without a check: the note names it.
  await pickRepo('nochk')
  await setMode('o/nochk', 'write')
  await untilMode('o/nochk', 'write')
  await page.waitForSelector(`${BLOCK} .hc-note:has-text("no check configured for o/nochk"), ${BLOCK} .hc-note:has-text("no check configured for nochk")`, T)
  assert.match(await page.locator(`${BLOCK} .hc-note:has-text("no check configured")`).innerText(), /the check is skipped/)
  await page.click('.ns-body .repo-mode-row:has(.repo-mode-name:text-is("o/nochk")) .chip-x')
  await page.waitForSelector(`${BLOCK} .hc-note:has-text("no check configured")`, { state: 'detached', timeout: 5000 })
  console.log('"no check configured - the check is skipped" note OK')

  // === 2. Run disabled for an identical agent and model ===
  await pickReviewer('claude')
  await page.waitForSelector(PROBLEM, T)
  assert.match(await page.locator(PROBLEM).innerText(), /same agent and model/)
  await openChat()
  await page.fill('.draft-prompt', 'implement the thing')
  await page.click('.chat-title') // blur -> sessionEditPrompt
  await page.waitForSelector('[data-testid="run-blocked"]', T)
  assert.ok(await page.locator(runBtn).isDisabled(), 'Run is disabled for the same agent and model')
  assert.match(await page.locator('[data-testid="run-blocked"]').innerText(), /same agent and model/)
  await shot('02-run-blocked')
  console.log('Run disabled for an identical agent and model, with the reason shown OK')

  await openConfig()
  await page.click(`${BLOCK} .hc-block:has(.seclabel:text-is("MODEL")) .chip-btn:text-is("Sonnet")`)
  await page.waitForSelector(PROBLEM, { state: 'detached', timeout: 5000 })
  await openChat()
  await page.waitForSelector(runBtn, T)
  await page.waitForFunction((sel) => !document.querySelector(sel).disabled, runBtn, T)
  console.log('another model on the same agent: Run enabled again OK')

  // === 3. pi is not offered as reviewer, and a pi executor is refused ===
  await openConfig()
  await page.click(`${BLOCK} .pick-row`)
  const offered = (await page.locator(`${BLOCK} .pick-menu .menu-item`).allInnerTexts()).map((t) => t.trim())
  await page.keyboard.press('Escape')
  await page.mouse.click(5, 5)
  assert.ok(offered.some((t) => t.includes('claude')) && offered.some((t) => t.includes('codex')), `offered: ${offered}`)
  assert.ok(!offered.some((t) => /\bpi\b/.test(t)), `pi is not offered as a reviewer: ${offered}`)
  await page.waitForSelector(`${BLOCK} .pick-menu`, { state: 'detached', timeout: 5000 })
  await page.click(row('AGENT'))
  await page.click('.ns-body .pick-menu .menu-item:has-text("pi")')
  await page.waitForSelector(PROBLEM, T)
  assert.match(await page.locator(PROBLEM).innerText(), /pi does not receive gurt’s tools/)
  await openChat()
  await page.waitForSelector('[data-testid="run-blocked"]', T)
  assert.ok(await page.locator(runBtn).isDisabled(), 'Run is disabled for a pi executor with a loop')
  console.log('pi: not offered as reviewer, refused as executor OK')
  await openConfig()
  await page.click(row('AGENT'))
  await page.click('.ns-body .pick-menu .menu-item:has-text("claude")')
  await page.waitForSelector(PROBLEM, { state: 'detached', timeout: 5000 })

  // === 4. rounds, the rung and the draft-PR box persist, across a reload ===
  await page.click(`${chips('review rounds')}[data-rounds="4"]`)
  await untilActive('review rounds', '4')
  await page.click(`${chips('when clean')}[data-rung="pr"]`)
  await page.waitForSelector(`${BLOCK} .rv-check input`, T)
  assert.ok(await page.locator(`${BLOCK} .rv-check input`).isChecked(), 'a draft PR is the default')
  await page.click(`${BLOCK} .rv-check input`)
  const saved = await persisted(
    id1,
    (i) => i.review?.maxRounds === 4 && i.review.whenClean === 'pr' && i.review.draftPr === false,
    'the edited block'
  )
  assert.deepEqual(saved.review, {
    agent: 'a1',
    configValues: { model: 'sonnet' },
    maxRounds: 4,
    whenClean: 'pr',
    draftPr: false
  })
  await page.reload()
  await page.waitForSelector('.sb-session', { timeout: 15000 })
  await page.click('.sb-session >> nth=0')
  await openConfig()
  await untilReviewer('claude')
  await untilActive('review rounds', '4')
  await untilActive('when clean', 'commit + push + PR')
  assert.equal(await page.locator(`${BLOCK} .rv-check input`).isChecked(), false)
  await page.waitForSelector(`${BLOCK} .hc-block:has(.seclabel:text-is("MODEL")) .chip-btn.on:text-is("Sonnet")`, T)
  await shot('03-after-reload')
  console.log('block persisted across a reload (reviewer, model, rounds, rung, draft PR) OK')

  // === 5. a copy carries the block ===
  await openChat()
  await page.click('.draft-body .row-buttons .btn:has-text("Duplicate")')
  await page.waitForFunction(() => document.querySelectorAll('.sb-session').length === 2, null, T)
  await openConfig()
  await untilReviewer('claude')
  await untilActive('review rounds', '4')
  await untilActive('when clean', 'commit + push + PR')
  console.log('duplicate carries the Review block OK')

  // === 6. the ladder for local and mixed repos ===
  await newSession()
  await pickRepo('loc')
  await setMode('loc', 'write')
  await untilMode('loc', 'write')
  await page.waitForSelector(`${BLOCK} [aria-label="review loop"]`, T)
  await loop('on')
  await untilRungs(['notify', 'commit', 'commit + merge into main'])
  console.log('local repos: notify / commit / commit + merge into main OK')
  await pickRepo('fx')
  await setMode('o/fx', 'write')
  await untilMode('o/fx', 'write')
  await untilRungs(['notify', 'commit'])
  console.log('local and forge mixed: notify / commit OK')
  await shot('04-ladders')

  // === 7. a repo whose defaults turn the loop on prefills the block ===
  await newSession()
  const id3 = await sessionId()
  await pickEnv('preenv')
  await setMode('o/pre', 'write')
  await untilMode('o/pre', 'write')
  await untilReviewer('codex')
  await untilActive('review rounds', '3')
  await untilActive('when clean', 'commit')
  console.log('anchor defaults (enabled, 3 rounds, commit) prefill the block OK')
  // Off is a choice: it is remembered, and the default does not switch it back on.
  await loop('off')
  await persisted(id3, (i) => i.review === undefined && i.reviewOff === true, 'a block switched off')
  await page.reload()
  await page.waitForSelector('.sb-session', { timeout: 15000 })
  const title3 = records().find((r) => r.info.id === id3).info.title
  await page.click(`.sb-session:has(.sb-session-name:text-is("${title3}"))`)
  await openConfig()
  await page.waitForSelector(`${BLOCK} [aria-label="review loop"] .chip-btn.on:text-is("off")`, T)
  await page.waitForTimeout(500)
  assert.equal(await page.locator(`${BLOCK} .pick-row`).count(), 0, 'still off after a reload')
  console.log('off stays off after a reload OK')

  // === 8. a researcher draft has no Review block ===
  await page.click(row('ROLE'))
  await page.click('.ns-body .pick-menu .menu-item:has-text("researcher")')
  await page.waitForSelector(BLOCK, { state: 'detached', timeout: 5000 })
  console.log('Review block is an executor-only block OK')

  // === 9. Settings → Repos: the check and the review defaults ===
  await page.click('.activitybar .ab-item[title^="Settings"]')
  await page.click('.set-nav-item:has-text("Repos")')
  await page.click('.set-row:has(.set-row-label:text-is("fx")) .btn-link')
  await page.waitForSelector('.modal:has-text("Edit repo")', T)
  assert.equal(await page.inputValue('.modal input[placeholder="npm run lint && npm test"]'), 'npm test')
  await page.fill('.modal input[placeholder="npm run lint && npm test"]', '  npm run lint && npm test  ')
  await page.click('.modal [aria-label="review loop on by default"] .chip-btn:has-text("on by default")')
  await page.click('.modal [aria-label="default reviewer"] .chip-btn:text-is("codex")')
  await page.click('.modal [aria-label="default review rounds"] .chip-btn:text-is("4")')
  const modalRungs = (await page.locator('.modal [aria-label="default when clean"] .chip-btn').allInnerTexts()).map((t) => t.trim())
  assert.deepEqual(modalRungs, ['notify', 'commit', 'commit + push', 'commit + push + PR'], 'a forge repo’s ladder')
  await page.click('.modal [aria-label="default when clean"] .chip-btn:text-is("commit + push + PR")')
  await shot('05-repo-defaults')
  await page.click('.modal-foot .btn-primary')
  await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 })
  const fx = JSON.parse(fs.readFileSync(path.join(GURT_ROOT, ws, 'workspace.json'), 'utf8')).repos.find((r) => r.name === 'fx')
  assert.equal(fx.check, 'npm run lint && npm test', 'the check is stored trimmed')
  assert.deepEqual(fx.review, { enabled: true, agent: 'a2', maxRounds: 4, whenClean: 'pr' })
  // A local repo is offered its own ladder.
  await page.click('.set-row:has(.set-row-label:text-is("loc")) .btn-link')
  await page.waitForSelector('.modal:has-text("Edit repo")', T)
  const localRungs = (await page.locator('.modal [aria-label="default when clean"] .chip-btn').allInnerTexts()).map((t) => t.trim())
  assert.deepEqual(localRungs, ['notify', 'commit', 'commit + merge into main'])
  // pi cannot be the default reviewer: it is not even offered.
  const offeredDefaults = (await page.locator('.modal [aria-label="default reviewer"] .chip-btn').allInnerTexts()).map((t) => t.trim())
  assert.ok(!offeredDefaults.some((t) => /\bpi\b/.test(t)), `pi is not offered as a default reviewer: ${offeredDefaults}`)
  await page.click('.modal-foot .btn:has-text("Cancel")')
  console.log('Settings → Repos: check and review defaults saved, ladder per kind, pi not offered OK')

  // === 10. the same-kind fallback (a second launch over other agents) ===
  await app.close()
  write('agents.json', {
    a1: { kind: 'claude-code', label: 'claude', credentialId: 'c1' },
    a4: { kind: 'claude-code', label: 'claude two', credentialId: 'c1' },
    // another kind, but nothing to sign in with: it does not count
    a5: { kind: 'codex', label: 'codex bare' }
  })
  // A scope holding a finished loop, written the way the controller leaves it:
  // an executor, the second round's reviewer, and review-loop.json.
  const t2 = path.join(GURT_ROOT, ws, 't2')
  fs.mkdirSync(t2, { recursive: true })
  fs.writeFileSync(path.join(t2, 'task.json'), JSON.stringify({}))
  const base = { workspace: ws, task: 't2', env: 'dev', repos: ['fx'], agent: 'a1', state: 'started', mcp: [], startPrompt: 'do it' }
  const open = [{ id: 'F1', file: 'fx/src/auth.ts', line: 42, severity: 'blocker', claim: 'the token is compared with ==' }]
  fs.writeFileSync(
    path.join(t2, 'sessions.json'),
    JSON.stringify([
      { info: { ...base, id: 'ex1', role: 'executor', repoModes: { fx: 'write' }, title: 'ship it', review: { agent: 'a4', maxRounds: 2, whenClean: 'commit', draftPr: true } }, acpSessionId: 'acp-ex1', log: [] },
      { info: { ...base, id: 'rv1', role: 'reviewer', repoModes: { fx: 'read' }, title: 'review 2 — ship it', agent: 'a4', reviewOf: { executor: 'ex1', round: 2, intent: 'ex1.3' } }, acpSessionId: 'acp-rv1', log: [] }
    ])
  )
  write(`${ws}/t2/review-loop.json`, {
    ex1: {
      version: 1, executor: 'ex1', config: { agent: 'a4', maxRounds: 2, whenClean: 'commit', draftPr: true },
      phase: 'ended', round: 2, redStreak: 0, repaired: false, base: { fx: 'abc' }, open, openAnswered: false, checks: [],
      rounds: [], fingerprints: {}, holdExtensionMs: 0, consumed: {}, intents: [], nextIntent: 4, delivered: [],
      turns: { executor: 2, reviewer: 2 }, notified: true,
      end: { outcome: 'exhausted', open }
    }
  })
  await launch()
  // fx still names the reviewer saved above (codex, a2), which this registry
  // no longer has: the block it prefills says so, and Run stays off.
  await newSession()
  await pickEnv('dev')
  await setMode('o/fx', 'write')
  await untilMode('o/fx', 'write')
  await page.waitForSelector(PROBLEM, T)
  assert.match(await page.locator(PROBLEM).innerText(), /the reviewer “a2” no longer exists/)
  await pickReviewer('claude two')
  await page.waitForSelector(PROBLEM, { state: 'detached', timeout: 5000 })
  console.log('a named default reviewer that is gone is reported, not silently replaced OK')

  // A repo with no defaults: the default reviewer is chosen by the rule.
  await newSession()
  await pickRepo('nochk')
  await setMode('o/nochk', 'write')
  await untilMode('o/nochk', 'write')
  await loop('on')
  await untilReviewer('claude two')
  console.log('no other kind with a credential: another instance of the same kind is the default OK')

  // === 11. the loop's status line, and its reviewer in the scope tree ===
  const t2row = page.locator('.sb-task:has(.sb-task-name:text-is("t2"))')
  await t2row.waitFor(T)
  if ((await t2row.getAttribute('aria-expanded')) !== 'true') await t2row.locator('.sb-chev').click()
  await page.waitForSelector('.sb-session-name:text-is("ship it")', T)
  assert.equal(await page.locator('.sb-session:has(.sb-session-name:text-is("review 2 — ship it")) [data-role="reviewer"]').count(), 1, 'the reviewer carries its role mark')
  assert.equal(await page.locator('.sb-session:has(.sb-session-name:text-is("ship it")) [data-role="reviewer"]').count(), 0, 'the executor does not')
  await page.click('.sb-session:has(.sb-session-name:text-is("ship it"))')
  await page.waitForSelector('.rv-line', T)
  assert.equal(await page.locator('[data-testid="loop-headline"]').innerText(), 'ended — 2 rounds used, 1 finding unresolved')
  assert.match(await page.locator('.rv-findings').innerText(), /R2\.F1\s*blocker\s*fx\/src\/auth\.ts:42\s*the token is compared with ==/)
  assert.equal(await page.locator('.rv-line button:has-text("Stop loop")').count(), 0, 'an ended loop has nothing to stop')
  await shot('07-loop-ended')
  await page.click('.sb-session:has(.sb-session-name:text-is("review 2 — ship it"))')
  await page.waitForSelector('.rv-line .rv-line-title:has-text("reviewer of round 2")', T)
  console.log('loop status line on the executor and its reviewer, reviewer role mark in the tree OK')
  await shot('06-same-kind')

  console.log('SMOKE PASS')
} catch (e) {
  console.error('SMOKE FAIL')
  console.error(e)
  process.exitCode = 1
  await shot('99-failure').catch(() => {})
} finally {
  await app.close().catch(() => {})
}
