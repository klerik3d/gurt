// The left sidebar holds still: the scrollbar never narrows its rows, the
// accordion mode (on by default) keeps only the active scope open, and
// switching Agents / Git / Files never moves the active scope's row a pixel.
// npm run build && DISPLAY=:99 node scripts/smoke-scope-anchor.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const scratch = fs.mkdtempSync(path.join(process.env.SCRATCH ?? os.tmpdir(), 'gurt-anchor-'))
const root = path.join(scratch, 'store')
const scopes = Array.from({ length: 30 }, (_, i) => `s${String(i).padStart(2, '0')}`)
fs.mkdirSync(path.join(root, 'demo'), { recursive: true })
fs.writeFileSync(path.join(root, 'demo', 'workspace.json'), JSON.stringify({ repos: [], envs: [{ name: 'dev', image: 'unused' }] }))
// One long scope, for a header scrolled far out of view.
{
  const dir = path.join(root, 'demo', 'zz-long')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ createdAt: '2026-01-02T00:00:00Z' }))
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify(Array.from({ length: 60 }, (_, k) => ({ info: {
    id: `long-${k}`, workspace: 'demo', task: 'zz-long', env: 'dev', repos: [], title: `long session ${k}`, state: 'draft'
  } }))))
}
for (const [n, name] of scopes.entries()) {
  const dir = path.join(root, 'demo', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ createdAt: `2026-01-01T00:00:${String(n).padStart(2, '0')}Z` }))
  // Sessions only in every other scope: Agents, Git and Files then differ in
  // how much sits above any given scope once everything is expanded.
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify(n % 2 ? [] : Array.from({ length: 4 }, (_, k) => ({ info: {
    id: `${name}-${k}`, workspace: 'demo', task: name, env: 'dev', repos: [], title: `${name} session ${k}`, state: 'draft'
  } }))))
}

const require = createRequire(path.join(appDir, 'package.json'))
const { _electron } = require('playwright-core')
const env = { ...process.env, GURT_ROOT: root, GURT_WELCOME: 'never' }
delete env.ELECTRON_RUN_AS_NODE
const app = await _electron.launch({
  executablePath: require('electron'),
  args: [appDir, '--no-sandbox', `--user-data-dir=${path.join(scratch, 'profile')}`],
  env
})
const errors = []
try {
  const page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1200, 700))
  await page.waitForSelector('.sb-task')
  const frames = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const tree = () => page.locator('.sidebar:visible .sb-tree')
  const scopeRow = (name) => page.locator(`.sidebar:visible .sb-task[data-scope="${name}"]`)
  const expanded = () => page.locator('.sidebar:visible .sb-task[aria-expanded="true"]').evaluateAll((rows) => rows.map((r) => r.dataset.scope))
  const switchMode = async (mode) => {
    await page.locator(`.activitybar button[title^="${mode}"]`).click()
    await tree().waitFor()
    await frames()
  }
  const top = async (name) => (await scopeRow(name).boundingBox()).y

  // Accordion mode is the default; with nothing selected every scope is folded.
  const focus = page.locator('.sidebar:visible button[aria-label="Only the active scope open"]')
  assert.equal(await focus.getAttribute('aria-pressed'), 'true', 'accordion mode is on by default')
  assert.deepEqual(await expanded(), [], 'no active scope, every scope folded')

  // The gutter: rows are as wide with a scrollbar as without one.
  const overflowing = () => tree().evaluate((el) => el.scrollHeight > el.clientHeight)
  const rowWidth = async () => (await scopeRow('s00').boundingBox()).width
  assert.equal(await overflowing(), true, 'fixture overflows the tree')
  const scrolledWidth = await rowWidth()
  const filter = page.locator('.sidebar:visible').getByRole('textbox', { name: 'Filter scopes (regular expression)' })
  await filter.fill('^s00$')
  await frames()
  assert.equal(await overflowing(), false)
  assert.equal(await rowWidth(), scrolledWidth, 'the scrollbar appearing does not narrow the rows')
  await filter.fill('')

  // Selecting a scope opens it and folds the rest — in every mode.
  await scopeRow('s04').locator('.sb-task-name').click()
  assert.deepEqual(await expanded(), ['s04'])
  await page.locator('.sb-session').first().click()
  await scopeRow('s20').scrollIntoViewIfNeeded()
  const before = await top('s20')
  await scopeRow('s20').locator('.sb-task-name').click()
  await frames()
  assert.deepEqual(await expanded(), ['s20'], 'the newly active scope opens, the previous one folds')
  assert.equal(await top('s20'), before, 'folding the previous scope above does not move the clicked one')

  // Mode switches: the active row stays on its pixel.
  const checkStill = async (label, modes) => {
    const y = await top('s20')
    for (const mode of modes) {
      await switchMode(mode)
      assert.equal(await top('s20'), y, `${label}: the active scope stays put entering ${mode}`)
    }
  }
  await tree().evaluate((el) => { el.scrollTop = el.scrollHeight })
  await frames()
  await checkStill('accordion, scrolled to the end', ['Diff', 'Files', 'Agents', 'Files', 'Diff', 'Agents'])
  for (const mode of ['Diff', 'Files']) {
    await switchMode(mode)
    assert.deepEqual(await expanded(), ['s20'], `${mode}: only the active scope open`)
    await page.screenshot({ path: path.join(scratch, `scope-anchor-${mode.toLowerCase()}.png`) })
  }
  await switchMode('Agents')

  // Opening another scope by hand makes it the active one: never two open.
  await scopeRow('s21').locator('.sb-chev').click()
  await frames()
  assert.deepEqual(await expanded(), ['s21'], 'the chevron of another scope activates it')
  assert.match(await page.locator('.task-pane').innerText(), /s21/)
  await page.locator('.sidebar:visible button[title="Collapse all"]').click()
  assert.equal(await page.locator('.sidebar:visible button[title^="Expand all"]').isDisabled(), true, 'no Expand all in accordion mode')
  await scopeRow('s20').locator('.sb-task-name').click()
  await frames()
  assert.deepEqual(await expanded(), ['s20'])

  // With accordion off and everything expanded, the content above the active
  // scope differs by mode — the row still holds.
  await focus.click()
  assert.equal(await focus.getAttribute('aria-pressed'), 'false')
  await page.locator('.sidebar:visible button[title="Collapse all"]').click()
  await page.locator('.sidebar:visible button[title="Expand all"]').click()
  await frames()
  assert.equal((await expanded()).length, scopes.length + 1)
  await tree().evaluate((el) => {
    const row = el.querySelector('[data-scope="s20"]')
    el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientHeight / 2
  })
  await frames()
  await checkStill('all expanded, mid-list', ['Diff', 'Files', 'Agents', 'Files', 'Diff', 'Agents'])
  // s20 last, so the end of the list still shows it.
  await filter.fill('^s(1\\d|20)$')
  await tree().evaluate((el) => { el.scrollTop = el.scrollHeight })
  await frames()
  await checkStill('all expanded, scrolled to the end', ['Files', 'Diff', 'Agents'])
  await filter.fill('')

  // Less above the row in the new mode than the scroll can take away: s00's
  // four sessions in Agents are one line in Git and Files.
  await scopeRow('s01').locator('.sb-task-name').click()
  await tree().evaluate((el) => { el.scrollTop = 0 })
  await frames()
  const s01 = await top('s01')
  for (const mode of ['Diff', 'Files', 'Agents']) {
    await switchMode(mode)
    assert.equal(await top('s01'), s01, `scrolled to the top: s01 stays put entering ${mode}`)
  }

  // A tree that fits in the new mode, yet scrolled in the old one.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1200, 450))
  await filter.fill('^s(00|02|04|06)$')
  await scopeRow('s06').locator('.sb-task-name').click()
  await scopeRow('s06').locator('.sb-task-name').click()
  await frames()
  assert.equal(await overflowing(), true, 'four scopes with sessions overflow a short window')
  await tree().evaluate((el) => { el.scrollTop = el.scrollHeight })
  await frames()
  const s06 = await top('s06')
  await switchMode('Diff')
  assert.equal(await top('s06'), s06, 'the row holds where the new tree would fit')
  await switchMode('Agents')
  assert.equal(await top('s06'), s06)
  await filter.fill('')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1200, 700))
  await scopeRow('s20').scrollIntoViewIfNeeded()
  await scopeRow('s20').locator('.sb-task-name').click()
  await scopeRow('s20').locator('.sb-task-name').click()
  await frames()

  // A header scrolled far out of view is not held there: the new mode shows it.
  await filter.fill('^zz-long$')
  await scopeRow('zz-long').locator('.sb-task-name').click()
  await scopeRow('zz-long').locator('.sb-task-name').click()
  await tree().evaluate((el) => { el.scrollTop = el.scrollHeight })
  await frames()
  const inView = (name) => tree().evaluate((el, name) => {
    const box = el.getBoundingClientRect()
    const at = el.querySelector(`[data-scope="${name}"]`).getBoundingClientRect()
    return at.top >= box.top && at.bottom <= box.bottom
  }, name)
  assert.equal(await inView('zz-long'), false, 'the long scope\'s header is scrolled away')
  for (const mode of ['Diff', 'Files']) {
    await switchMode(mode)
    assert.equal(await inView('zz-long'), true, `${mode}: the active scope shows, not a padded blank`)
  }
  await switchMode('Agents')
  await filter.fill('')
  await scopeRow('s20').scrollIntoViewIfNeeded()
  await scopeRow('s20').locator('.sb-task-name').click()
  await scopeRow('s20').locator('.sb-task-name').click()
  await frames()

  // Hiding and re-showing the sidebar keeps the row too.
  const y = await top('s20')
  await page.locator('.activitybar button[title^="Agents"]').click()
  await page.locator('.activitybar button[title^="Agents"]').click()
  await tree().waitFor()
  await frames()
  assert.equal(await top('s20'), y, 'the row survives the sidebar being hidden and shown')

  await page.screenshot({ path: path.join(scratch, 'scope-anchor.png') })
  assert.deepEqual(errors, [], 'no renderer exceptions')
  console.log(`PASS scope anchor: gutter, accordion default, still active scope across modes. Screenshot: ${scratch}/scope-anchor.png`)
} catch (e) {
  const page = await app.firstWindow()
  await page.screenshot({ path: path.join(scratch, 'failure.png') }).catch(() => {})
  console.error(`UI smoke artifacts: ${scratch}`)
  throw e
} finally {
  await app.close()
}
