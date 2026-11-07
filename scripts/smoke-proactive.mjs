// The Proactive mode in the real UI (docs/design-proactive-agents.md §7), no
// docker: a seeded agent (written by an older build: a per-run limit,
// deferrals) lists its kept run under it in the sidebar, and its pane shows
// the settings as a phrase with "i" hints instead of captions, its runs and
// its raised scopes; a run opens its chat inside the Proactive mode, with the
// closed-tools note above the composer; the settings, the on/off switch and
// the instructions persist to disk; its template's Config tab is locked to the
// proactive role; a raised scope's pane says where it came from, and deleting
// it drops it from the list; a new agent is created from "+".
//
// Nothing here starts a run — that needs a Docker daemon and an agent. The
// run's tools are covered headless by scripts/proactive.test.mjs.
//
//   npm run build && node scripts/smoke-proactive.mjs
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SCRATCH = process.env.SCRATCH ?? '/tmp/gurt-smoke-proactive'
const GURT_ROOT = path.join(SCRATCH, 'gurt-root')
const SHOT_DIR = path.join(SCRATCH, 'shots')
fs.rmSync(GURT_ROOT, { recursive: true, force: true })
fs.mkdirSync(SHOT_DIR, { recursive: true })

const ws = 'w'
const write = (rel, data) => {
  const file = path.join(GURT_ROOT, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}
const read = (rel) => JSON.parse(fs.readFileSync(path.join(GURT_ROOT, rel), 'utf8'))

write(`${ws}/workspace.json`, {
  repos: [{ name: 'alpha', url: 'https://github.com/o/alpha.git' }],
  envs: [{ name: 'dev', image: 'x', repo: 'alpha' }],
  defaultAgent: 'a1'
})
write('agents.json', { a1: { kind: 'claude-code', label: 'claude' } })

// A proactive agent as the manager leaves one on disk: its scope's task.json
// carries the config, sessions.json the template, proactive-state.json what it
// remembers. Its last run is recent, so switching it on starts nothing.
const now = Date.now()
const iso = (ms) => new Date(ms).toISOString()
write(`${ws}/triage/task.json`, {
  createdAt: iso(now - 86_400_000),
  proactive: {
    enabled: false,
    everyMinutes: 60,
    // An older build's per-run limit: ignored, and gone after the next save.
    maxScopesPerRun: 5,
    maxPendingScopes: 10,
    maxRunMinutes: 30,
    keepRuns: 5,
    templateId: 'tpl-1'
  }
})
write(`${ws}/triage/sessions.json`, [
  {
    info: {
      id: 'tpl-1',
      env: 'base',
      role: 'proactive',
      repos: [],
      task: 'triage',
      workspace: ws,
      title: 'template',
      agent: 'a1',
      autoAllow: true,
      state: 'draft',
      mcp: [],
      network: { internal: true },
      startPrompt: 'Watch Sentry project storefront.',
      template: true
    }
  },
  // A finished run still kept: the user may read it and talk to it.
  {
    info: {
      id: 'run-kept',
      env: 'operator',
      role: 'proactive',
      repos: [],
      task: 'triage',
      workspace: ws,
      title: 'run kept',
      agent: 'a1',
      autoAllow: true,
      state: 'started',
      mcp: [],
      network: { internal: true },
      startPrompt: 'Watch Sentry project storefront.'
    }
  }
])
write(`${ws}/triage/proactive-state.json`, {
  cursor: '2026-11-03T09:00:00Z',
  lastRunAt: iso(now - 60_000),
  runs: [
    {
      id: 'run-kept',
      startedAt: iso(now - 60_000),
      endedAt: iso(now - 30_000),
      outcome: 'finished',
      proposed: ['checkout-crash'],
      attached: [],
      summary: 'raised the checkout crash'
    },
    {
      id: 'skipped-1',
      startedAt: iso(now - 7_200_000),
      endedAt: iso(now - 7_200_000),
      outcome: 'skipped',
      proposed: [],
      attached: [],
      summary: '10 scopes waiting for you'
    },
    {
      id: 'run-gone',
      startedAt: iso(now - 86_400_000),
      endedAt: iso(now - 86_000_000),
      outcome: 'finished',
      proposed: [],
      attached: [],
      deferred: 2,
      summary: 'nothing new to raise'
    }
  ],
  // What an older build kept here; dropped on load.
  deferrals: [
    { ref: 'sentry:2', until: iso(now + 86_400_000), reason: 'low impact', run: 'run-gone', at: iso(now - 40_000) }
  ],
  tombstones: []
})
// The scope it raised, with one untouched draft.
write(`${ws}/checkout-crash/task.json`, {
  createdAt: iso(now - 50_000),
  origin: {
    agent: 'triage',
    run: 'run-gone',
    refs: ['sentry:1', 'mail:<m1@example.com>'],
    title: 'Checkout crash',
    summary: 'NullPointerException in Cart.total() since release 4.2',
    createdAt: iso(now - 50_000),
    notes: [{ at: iso(now - 45_000), agent: 'triage', run: 'run-gone', text: 'a customer reported it by mail too' }]
  }
})
write(`${ws}/checkout-crash/sessions.json`, [
  {
    info: {
      id: 'draft-1',
      env: 'dev',
      role: 'executor',
      repos: ['alpha'],
      task: 'checkout-crash',
      workspace: ws,
      title: 'fix checkout crash',
      agent: 'a1',
      state: 'draft',
      mcp: [],
      startPrompt: 'Fix the NPE in Cart.total().'
    }
  }
])

const require = createRequire(path.join(APP_DIR, 'package.json'))
const { _electron } = require('playwright-core')
const electronPath = require('electron')

const env = { ...process.env, GURT_ROOT, GURT_WELCOME: 'never', DISPLAY: process.env.DISPLAY ?? ':99' }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL

const electronProfile = fs.mkdtempSync(path.join(path.dirname(GURT_ROOT), 'electron-profile-'))
const app = await _electron.launch({
  executablePath: electronPath,
  args: [APP_DIR, '--no-sandbox', `--user-data-dir=${electronProfile}`],
  env,
  timeout: 30000
})

const page = await app.firstWindow()
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text())
})
page.on('pageerror', (e) => console.log('[pageerror]', e.message))

const shot = (name) => page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) })
async function until(pred, label) {
  for (let i = 0; i < 60; i++) {
    try {
      if (pred()) return
    } catch {
      // not written yet
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`never: ${label}`)
}

try {
  await page.waitForSelector('.activitybar', { timeout: 15000 })
  await page.click('button[aria-label="Proactive agents"]')
  await page.waitForSelector('.pa-row:has-text("triage")', { timeout: 10000 })

  // The agent is a container: its kept run is listed under it, the history's
  // skips and collected runs are not.
  assert.equal(await page.locator('.pa-run-row').count(), 1, 'one kept run in the sidebar')

  // The agent's pane: the settings read as a phrase, explanations behind "i".
  await page.click('.pa-row:has-text("triage")')
  await page.waitForSelector('.task-pane .chat-title:has-text("triage")', { timeout: 5000 })
  assert.equal(await page.locator('.task-pane .seclabel:text-is("RUNS")').count(), 0)
  await page.waitForSelector('.pa-phrase:has-text("Cron"):has-text("now 1/10")', { timeout: 5000 })
  assert.equal(await page.locator('.task-pane .tp-sec-hint').count(), 0, 'no grey captions')
  assert.ok((await page.locator('.task-pane .info-dot').count()) >= 4, 'hints sit behind "i" marks')
  await page.waitForSelector('.pa-scope:has-text("Checkout crash"):has-text("waiting for you")', { timeout: 5000 })
  for (const gone of ['DEFERRED', 'DISMISSED'])
    assert.equal(await page.locator(`.seclabel:text-is("${gone}")`).count(), 0, `no ${gone} section`)
  // Timeout and runs kept wait under "Advanced".
  assert.equal(await page.locator('input[aria-label="runs kept"]').count(), 0)
  await page.click('.pa-advanced')
  await page.waitForSelector('input[aria-label="runs kept"]', { timeout: 5000 })
  await page.waitForSelector('input[aria-label="run timeout (minutes)"]', { timeout: 5000 })
  console.log('proactive: seeded agent, runs, raised scopes, phrase settings OK')

  // The template's Config: role locked to proactive, env the base image.
  const roleRow = '.ns-body .seclabel-row:has(.seclabel:text-is("ROLE")) + .pick-row'
  await page.waitForSelector(`${roleRow}[disabled]:has-text("proactive")`, { timeout: 5000 })
  const envRow = '.ns-body .seclabel-row:has(.seclabel:text-is("ENVIRONMENT")) + .pick-wrap .pick-value'
  assert.equal((await page.locator(envRow).innerText()).trim(), 'base')
  await shot('01-agent')
  await page.locator('.seclabel:text-is("RAISED SCOPES")').scrollIntoViewIfNeeded()
  await shot('01b-runs')
  console.log('proactive: template config locked to the role OK')

  // Settings persist to task.json.
  const every = page.locator('input[aria-label="cron schedule"]')
  await every.fill('*/15 * * * *')
  await every.press('Enter')
  await until(() => read(`${ws}/triage/task.json`).proactive.cron === '*/15 * * * *', 'cron persisted')
  assert.equal('maxScopesPerRun' in read(`${ws}/triage/task.json`).proactive, false, 'the old per-run limit is dropped')
  // Keep the on/off check independent of the wall clock: */15 can already
  // be due since the seeded last run, making the header say 'running now'.
  const futureCron = `0 0 1 ${(new Date().getMonth() + 1) % 12 + 1} *`
  await every.fill(futureCron)
  await every.press('Enter')
  await until(() => read(`${ws}/triage/task.json`).proactive.cron === futureCron, 'future cron persisted')
  await page.click('button:has-text("Turn on")')
  await until(() => read(`${ws}/triage/task.json`).proactive.enabled === true, 'enabled')
  await page.locator('.pa-head-status').filter({ hasText: futureCron }).waitFor({ timeout: 5000 })
  await page.click('button:has-text("Turn off")')
  await until(() => read(`${ws}/triage/task.json`).proactive.enabled === false, 'disabled')
  assert.equal(read(`${ws}/triage/task.json`).proactive.templateId, 'tpl-1', 'the template id survives an update')
  console.log('proactive: schedule and on/off persist OK')

  // Instructions are the template's start prompt.
  const instructions = page.locator('.tp-section:has(.seclabel:text-is("INSTRUCTIONS")) textarea')
  await instructions.fill('Watch Sentry project storefront and checkout.')
  await page.click('.chat-title')
  await until(
    () => read(`${ws}/triage/sessions.json`)[0].info.startPrompt === 'Watch Sentry project storefront and checkout.',
    'instructions saved'
  )
  console.log('proactive: instructions persist OK')

  // A run opens its chat inside the Proactive mode, under its agent — not in
  // the Sessions mode, whose sidebar does not list the agent.
  await page.click('.pa-run-row')
  await page.waitForSelector('.pa-run-row.selected', { timeout: 5000 })
  await page.waitForSelector('.composer-note:has-text("its gurt tools are closed")', { timeout: 10000 })
  assert.equal(await page.locator('button[aria-label="Proactive agents"][aria-pressed="true"]').count(), 1, 'still in the Proactive mode')
  assert.equal(await page.locator('.task-pane .chat-title:has-text("triage")').count(), 0, 'the agent pane gave way to the run')
  await shot('01c-run')
  await page.click('.pa-row:has-text("triage")')
  await page.waitForSelector('.task-pane .chat-title:has-text("triage")', { timeout: 5000 })
  console.log('proactive: a run opens inside the mode, closed-tools note OK')

  // A raised scope says where it came from.
  await page.click('.queue-row .queue-title:has-text("Checkout crash")')
  await page.waitForSelector('.task-pane .seclabel:has-text("RAISED BY TRIAGE")', { timeout: 5000 })
  await page.waitForSelector('.tp-origin-refs .tag:has-text("mail:<m1@example.com>")', { timeout: 5000 })
  await page.waitForSelector('.tp-origin-note:has-text("a customer reported it by mail too")', { timeout: 5000 })
  await shot('02-raised-scope')
  console.log('proactive: raised scope shows its origin OK')

  // Deleting a raised scope is closing it: its row just goes.
  await page.click('button[aria-label="Proactive agents"]')
  await page.click('.pa-row:has-text("triage")')
  await page.waitForSelector('.pa-scope:has-text("Checkout crash")', { timeout: 5000 })
  await page.evaluate((w) => window.gurt.removeTask(w, 'checkout-crash'), ws)
  await page.waitForSelector('.tp-section:has(.seclabel:text-is("RAISED SCOPES")) .tp-dashed', { timeout: 5000 })
  assert.equal(await page.locator('.pa-scope').count(), 0)
  await page.waitForSelector('.pa-phrase:has-text("now 0/10")', { timeout: 5000 })
  console.log('proactive: a deleted raised scope leaves the list OK')

  // A new agent from "+" (still in the Proactive mode).
  await page.click('button[aria-label="New proactive agent"]')
  await page.fill('.modal-body .input', 'mail-watch')
  await page.click('.modal-foot button:has-text("Create")')
  await page.waitForSelector('.task-pane .chat-title:has-text("mail-watch")', { timeout: 10000 })
  await until(() => read(`${ws}/mail-watch/task.json`).proactive.templateId, 'new agent on disk')
  const tpl = read(`${ws}/mail-watch/task.json`).proactive.templateId
  await until(() => read(`${ws}/mail-watch/sessions.json`).some((r) => r.info.id === tpl && r.info.template), 'template persisted')
  await shot('03-new-agent')
  console.log('proactive: new agent created OK')

  console.log('SMOKE PASS')
} catch (e) {
  console.error('SMOKE FAIL')
  console.error(e)
  process.exitCode = 1
  await shot('99-failure')
} finally {
  await app.close()
}
