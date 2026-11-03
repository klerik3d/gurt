// Real Electron file explorer/editor, no Docker or external repos.
// npm run build && DISPLAY=:99 node scripts/smoke-files-mode.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const scratch = fs.mkdtempSync(path.join(process.env.SCRATCH ?? os.tmpdir(), 'gurt-files-ui-'))
const root = path.join(scratch, 'store')
const scope = path.join(root, 'demo', 'first')
const repo = path.join(scope, 'frontend')
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.test', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
const source = 'import { greet } from "./lib"\nexport const message = greet("hello")\n'
fs.writeFileSync(path.join(repo, 'src', 'app.ts'), source)
fs.writeFileSync(path.join(repo, 'src', 'lib.ts'), 'export function greet(name: string) { return name }\n')
fs.writeFileSync(path.join(repo, 'README.md'), '# Demo\n')
fs.writeFileSync(path.join(repo, 'config.yaml'), 'enabled: true\n')
fs.writeFileSync(path.join(repo, 'crlf.txt'), 'first\r\nsecond\r\n')
fs.writeFileSync(path.join(repo, 'binary.bin'), Buffer.from([0, 1, 0]))
git(repo, 'init', '-b', 'first')
git(repo, 'add', '-A')
git(repo, 'commit', '-m', 'initial')
fs.writeFileSync(path.join(repo, 'README.md'), '# Edited demo\n')
fs.writeFileSync(path.join(scope, 'task.json'), JSON.stringify({ createdAt: '2026-02-01T00:00:00Z' }))
fs.writeFileSync(path.join(scope, 'sessions.json'), JSON.stringify([{ info: {
  id: 'draft-session', workspace: 'demo', task: 'first', env: 'dev', repos: ['frontend'], title: 'Build files', state: 'draft'
} }]))
const second = path.join(root, 'demo', 'second')
fs.mkdirSync(second, { recursive: true })
fs.writeFileSync(path.join(second, 'task.json'), JSON.stringify({ createdAt: '2026-01-01T00:00:00Z' }))
fs.writeFileSync(path.join(root, 'demo', 'workspace.json'), JSON.stringify({
  repos: [{ name: 'frontend', url: repo }], envs: [{ name: 'dev', devcontainer: '{"image":"unused"}' }]
}))

const require = createRequire(path.join(appDir, 'package.json'))
const { _electron } = require('playwright-core')
const env = { ...process.env, GURT_ROOT: root, GURT_WELCOME: 'never' }
delete env.ELECTRON_RUN_AS_NODE
const options = { executablePath: require('electron'), args: [appDir, '--no-sandbox', `--user-data-dir=${path.join(scratch, 'profile')}`], env }
let app = await _electron.launch(options)
const errors = []
try {
  let page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.waitForSelector('.sb-session')
  const scopeRow = (name) => page.locator('.sidebar:visible .sb-task').filter({ hasText: new RegExp(`^${name}$`) })
  const switchMode = async (mode) => {
    const button = page.locator(`.activitybar button[title^="${mode}"]`)
    if (await button.getAttribute('aria-pressed') !== 'true') await button.click()
  }
  const scopeHeight = (await scopeRow('first').boundingBox()).height
  await scopeRow('first').locator('.task-badge:not(.badge-delivered)').waitFor()
  await page.locator('.sb-session').click()
  await page.keyboard.press('Control+5')
  await page.getByRole('tree', { name: 'Scope files' }).waitFor()
  assert.equal(await page.locator('.sb-session:visible, .diff-repo-row:visible').count(), 0)
  const row = (title) => page.getByRole('tree', { name: 'Scope files' }).locator(`[role="treeitem"][title="${title}"]`)
  assert.equal(await page.locator('.files-sidebar .sb-ws').innerText(), 'Scopes', 'same header as other scope panels')
  assert.equal(await row('first').locator('svg').count(), 1, 'scope shows only its chevron')
  const normalColor = await row('first').locator('.sb-task-name').evaluate((el) => getComputedStyle(el).color)
  assert.equal(normalColor, 'rgb(163, 160, 153)', 'scope uses the muted name color')
  const scopeNames = () => page.locator('.sidebar:visible .sb-task-name').allTextContents()
  const filter = () => page.locator('.sidebar:visible').getByRole('textbox', { name: 'Filter scopes (regular expression)' })
  assert.equal(await filter().getAttribute('placeholder'), null, 'scope filter has no placeholder text')
  await page.locator('.files-sidebar button[title="Collapse all"]').click()
  let scopeSpacing
  for (const mode of ['Agents', 'Diff', 'Files']) {
    await switchMode(mode)
    const first = await scopeRow('first').boundingBox()
    const second = await scopeRow('second').boundingBox()
    assert.equal(first.height, scopeHeight, `${mode}: same scope row height`)
    assert.equal(second.height, scopeHeight)
    const spacing = second.y - first.y
    if (scopeSpacing === undefined) scopeSpacing = spacing
    assert.equal(spacing, scopeSpacing, `${mode}: same spacing between collapsed scopes`)
    assert.equal(await scopeRow('first').getAttribute('aria-expanded'), 'false')
    assert.equal(await scopeRow('second').getAttribute('aria-expanded'), 'false')
    assert.equal(await scopeRow('first').locator('.task-badge:not(.badge-delivered)').count(), 1, `${mode}: shared blue change indicator`)
  }
  await page.locator('.files-sidebar button[title="Expand all"]').click()
  for (const mode of ['Files', 'Agents', 'Diff']) {
    await switchMode(mode)
    assert.equal(await scopeRow('first').getAttribute('aria-expanded'), 'true')
    await scopeRow('first').locator('.sb-task-name').click()
    for (const destination of ['Agents', 'Diff', 'Files']) {
      await switchMode(destination)
      assert.equal(await scopeRow('first').getAttribute('aria-expanded'), 'false', `${mode} name click folds the scope in ${destination}`)
    }
    await scopeRow('first').locator('.sb-task-name').click()
    assert.equal(await scopeRow('first').getAttribute('aria-expanded'), 'true', 'name click also unfolds the scope')
  }
  await page.locator('.files-sidebar button[title^="Sort scopes"]').click()
  await page.locator('.files-sidebar .sb-sort-menu .menu-item').filter({ hasText: /^Created$/ }).click()
  assert.deepEqual(await scopeNames(), ['second', 'first'], 'files mode offers creation sorting')
  await page.locator('.files-sidebar .sb-sort-menu .menu-item').filter({ hasText: /^Newest first$/ }).click()
  assert.deepEqual(await scopeNames(), ['first', 'second'])
  await page.locator('.files-sidebar button[title^="Sort scopes"]').click()
  await filter().fill('^SECOND$')
  assert.deepEqual(await scopeNames(), ['second'], 'filter is a case-insensitive regex')
  for (const mode of ['Diff', 'Agents', 'Files']) {
    await page.locator(`.activitybar button[title^="${mode}"]`).click()
    assert.equal(await filter().inputValue(), '^SECOND$', 'filter survives mode switches')
    assert.deepEqual(await scopeNames(), ['second'])
  }
  await filter().fill('[')
  await page.locator('.files-sidebar [role="alert"]').waitFor()
  assert.equal(await filter().getAttribute('aria-invalid'), 'true')
  assert.deepEqual(await scopeNames(), ['first', 'second'], 'invalid regex leaves scopes visible')
  await filter().fill('^missing$')
  await page.locator('.files-sidebar').getByText('No matching scopes', { exact: true }).waitFor()
  await filter().press('Escape')
  assert.equal(await filter().inputValue(), '')
  assert.deepEqual(await scopeNames(), ['first', 'second'])
  await page.locator('.activitybar button[title^="Agents"]').click()
  assert.match(await page.locator('.sidebar button[title^="Sort scopes"]').getAttribute('title'), /Created, Newest first/, 'sort is shared across modes')
  await page.locator('.sb-session').click()
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  assert.equal(await row('first').getAttribute('aria-expanded'), 'true', 'scope folding is shared with Agents')
  await row('frontend').click()
  await row('frontend/src').click()
  await row('frontend/src/app.ts').click()
  const editor = () => page.locator('.files-pane .cm-content')
  await editor().waitFor()
  await page.waitForFunction(() => document.querySelector('.file-statusbar')?.textContent?.includes('TypeScript'))
  await page.waitForFunction(() => [...document.querySelectorAll('.cm-line span')].some((span) => getComputedStyle(span).color !== getComputedStyle(span.parentElement).color))
  assert.match(await editor().innerText(), /greet/)
  await row('frontend/src/app.ts').click()
  assert.equal(await page.getByRole('tab').count(), 1, 'opening twice reuses tab')
  await row('frontend/README.md').click()
  assert.equal(await page.getByRole('tab').count(), 2)
  await page.getByRole('tab', { name: 'app.ts' }).click()
  await editor().click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('// unsaved work')
  await page.waitForSelector('.file-dirty')

  // Both editor content and undo history survive modes, scopes and dashboard.
  await page.getByRole('button', { name: 'Diff', exact: true }).click()
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  assert.match(await editor().innerText(), /unsaved work/)
  await page.locator('button[title^="Agents"]').click()
  assert.equal(await page.locator('.sb-session.selected').innerText(), 'Build files', 'same-scope browsing preserves agent selection')
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await row('second').click()
  assert.equal(await page.getByRole('tab').count(), 0, 'tabs belong to their scope')
  if (await row('first').getAttribute('aria-expanded') !== 'true') await row('first').click()
  else await row('frontend/src/app.ts').click()
  assert.match(await editor().innerText(), /unsaved work/)
  await page.locator('.activitybar button[title^="Dashboard"]').click()
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  assert.match(await editor().innerText(), /unsaved work/)
  await editor().click()
  await page.keyboard.press('Control+z')
  await page.waitForFunction(() => !document.querySelector('.cm-content')?.textContent?.includes('unsaved work'))
  await page.keyboard.press('Control+Shift+z')
  await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('unsaved work'))
  await page.keyboard.press('Control+s')
  await page.waitForFunction(() => !document.querySelector('.file-dirty'))
  assert.match(fs.readFileSync(path.join(repo, 'src', 'app.ts'), 'utf8'), /unsaved work/)

  // Cancelled close keeps the buffer; confirmed close removes it.
  await editor().click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\n// throw away')
  // Electron must cancel window close when the native unsaved-changes dialog
  // chooses Keep editing. Stub only the dialog's answer, not the unload event.
  await app.evaluate(({ BrowserWindow, dialog }) => new Promise((resolve) => {
    const original = dialog.showMessageBoxSync
    dialog.showMessageBoxSync = () => 0
    const window = BrowserWindow.getAllWindows()[0]
    window.webContents.once('will-prevent-unload', () => { dialog.showMessageBoxSync = original; resolve(true) })
    window.close()
  }))
  assert.match(await editor().innerText(), /throw away/, 'cancelled app close retains unsaved buffers')
  await page.getByRole('button', { name: 'Close frontend/src/app.ts', exact: true }).click()
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click()
  assert.equal(await page.getByRole('tab', { name: /app.ts/ }).count(), 1)
  await page.getByRole('button', { name: 'Close frontend/src/app.ts', exact: true }).click()
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
  assert.equal(await page.getByRole('tab', { name: /app.ts/ }).count(), 0)
  await row('frontend/src/app.ts').click()
  await editor().waitFor()
  assert.doesNotMatch(await editor().innerText(), /throw away/)

  // Place cursor on imported call and follow the real TypeScript definition.
  await editor().click()
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Home')
  for (let i = 0; i < 'export const message = gr'.length; i++) await page.keyboard.press('ArrowRight')
  await page.keyboard.press('F12')
  await page.waitForFunction(() => document.querySelector('.file-tab.active')?.textContent?.includes('lib.ts'))
  assert.match(await editor().innerText(), /export function greet/)
  // Open the tab menu without moving the caret off the resolved symbol.
  await page.getByRole('tab', { name: 'lib.ts', exact: true }).click({ button: 'right' })
  await page.getByRole('button', { name: 'Find references · Shift+F12', exact: true }).click()
  await page.waitForSelector('.file-location')
  assert.match(await page.locator('.file-navigation').innerText(), /src\/app.ts/)
  await page.locator('.file-location').filter({ hasText: 'src/app.ts:2' }).click()
  await page.waitForFunction(() => document.querySelector('.file-tab.active')?.textContent?.includes('app.ts'))
  await page.getByRole('button', { name: 'Close navigation results' }).click()
  await editor().click()
  await page.keyboard.press('Control+End')
  const caret = await page.locator('.file-statusbar').innerText()
  await page.getByRole('tab', { name: 'lib.ts', exact: true }).click()
  await page.getByRole('tab', { name: 'app.ts', exact: true }).click()
  await page.waitForFunction((expected) => document.querySelector('.file-statusbar')?.innerText === expected, caret)
  assert.equal(await page.locator('.file-statusbar').innerText(), caret, 'returning to a tab restores the cursor after navigation')

  // External edits must never be overwritten by a stale save.
  await editor().click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\n// local edit')
  fs.writeFileSync(path.join(repo, 'src', 'app.ts'), source + '// agent edit\n')
  await page.keyboard.press('Control+s')
  await page.getByRole('alert').filter({ hasText: 'changed on disk' }).waitFor()
  assert.match(fs.readFileSync(path.join(repo, 'src', 'app.ts'), 'utf8'), /agent edit/)
  await editor().click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('button', { name: /^Reload ·/ }).click()
  await page.getByRole('button', { name: 'Reload', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('agent edit'))
  assert.doesNotMatch(await editor().innerText(), /local edit/)

  await row('frontend/config.yaml').click()
  await page.waitForFunction(() => document.querySelector('.file-statusbar')?.textContent?.includes('YAML'))
  await row('frontend/binary.bin').click()
  await page.getByRole('alert').filter({ hasText: 'Binary file' }).waitFor()
  await page.getByRole('button', { name: 'Close frontend/binary.bin', exact: true }).click()

  await row('frontend/crlf.txt').click()
  await editor().click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('third')
  await page.keyboard.press('Control+s')
  await page.waitForFunction(() => !document.querySelector('.file-dirty'))
  assert.equal(fs.readFileSync(path.join(repo, 'crlf.txt'), 'utf8'), 'first\r\nsecond\r\nthird')
  await page.screenshot({ path: path.join(scratch, 'files-mode.png') })
  await page.locator('button[title^="Agents"]').click()
  await page.locator('.sb-session').click()
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await row('first').locator('.sb-chev').click()
  await switchMode('Diff')
  assert.equal(await scopeRow('first').getAttribute('aria-expanded'), 'false')
  await switchMode('Files')
  assert.equal(await row('first').getAttribute('aria-expanded'), 'false', 'an active file does not unfold its scope on mode switch')

  // Restore file identities, mode, active file and folder expansion after restart.
  await app.close()
  app = await _electron.launch(options)
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('tree', { name: 'Scope files' }).waitFor()
  assert.equal(await row('first').getAttribute('aria-expanded'), 'false', 'shared scope folding survives restart with an active tab')
  assert.match(await page.locator('.files-sidebar button[title^="Sort scopes"]').getAttribute('title'), /Created, Newest first/, 'sort survives restart')
  await page.locator('.cm-content').waitFor()
  assert.match(await page.locator('.file-tab.active').innerText(), /crlf.txt/)
  assert.match(await page.locator('.cm-content').innerText(), /third/)
  assert.deepEqual(errors, [], 'no renderer errors')
  console.log(`PASS files mode: explorer, tabs, editor history, save/conflict, navigation, syntax, CRLF, restart. Screenshot: ${scratch}/files-mode.png`)
} finally { await app.close() }
