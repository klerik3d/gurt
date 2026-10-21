// Real PTY + Electron: panel toggles, per-scope lifetime, and deletion cleanup.
// npm run build && xvfb-run -a node scripts/smoke-terminal.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const scratch = fs.mkdtempSync(path.join(process.env.SCRATCH ?? os.tmpdir(), 'gurt-terminal-smoke-'))
const root = path.join(scratch, 'store')
for (const ws of ['demo', 'other']) {
  for (const task of ['alpha', 'beta']) {
    const dir = path.join(root, ws, task)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'task.json'), '{}')
  }
  fs.writeFileSync(path.join(root, ws, 'workspace.json'), JSON.stringify({ repos: [], envs: [] }))
}
const require = createRequire(path.join(appDir, 'package.json'))
const { _electron } = require('playwright-core')
const env = { ...process.env, GURT_ROOT: root, GURT_WELCOME: 'never', GURT_LOG: 'debug', SHELL: process.env.GURT_SMOKE_SHELL ?? '/bin/bash' }
delete env.ELECTRON_RUN_AS_NODE
const app = await _electron.launch({
  executablePath: require('electron'),
  args: [appDir, '--no-sandbox', `--user-data-dir=${path.join(scratch, 'profile')}`], env
})
const errors = []
let page
try {
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  page.setDefaultTimeout(15000)
  // IPC predicates return promises; retry their resolved values explicitly.
  const waitFor = async (check, arg) => {
    const deadline = Date.now() + 15000
    while (!await page.evaluate(check, arg)) {
      if (Date.now() >= deadline) throw new Error(`Timed out: ${check}`)
      await delay(25)
    }
  }
  await page.waitForSelector('.sb-task-name')
  await waitFor(async () => (await window.gurt.getBootProgress()).done)
  const scope = (name) => page.locator('.sb-task-name').filter({ hasText: new RegExp(`^${name}$`) })
  const list = () => page.evaluate(() => window.gurt.terminalList())
  const snapshot = (id) => page.evaluate((id) => window.gurt.terminalSnapshot(id), id)
  const output = (id, text) => waitFor(async ([id, text]) =>
    (await window.gurt.terminalSnapshot(id)).data.includes(text), [id, text])
  await scope('alpha').click()
  assert.equal(await page.locator('.activitybar-right').count(), 1)
  await page.keyboard.press('Control+4')
  await page.waitForSelector('.terminal-sidebar .xterm-helper-textarea:focus')
  const a = (await list())[0]
  assert.equal(a.task, 'alpha')
  assert.equal(a.title, 'Terminal 1')
  assert.equal(await page.locator('.terminal-header [role="tab"]').count(), 1, 'tabs belong to the header')
  assert.equal(await page.locator('.terminal-header').locator('..').locator(':scope > .terminal-tabs').count(), 0)
  await page.getByRole('tab', { name: 'Terminal 1', exact: true }).dblclick()
  await page.getByRole('textbox', { name: 'Terminal name', exact: true }).fill('Server')
  await page.keyboard.press('Enter')
  await waitFor(async (id) => (await window.gurt.terminalSnapshot(id)).info.title === 'Server', a.id)
  await page.getByRole('tab', { name: 'Server', exact: true }).focus()
  await page.keyboard.press('F2')
  await page.getByRole('textbox', { name: 'Terminal name', exact: true }).fill('Discarded')
  await page.keyboard.press('Escape')
  assert.equal((await snapshot(a.id)).info.title, 'Server', 'Escape cancels the rename')
  await page.locator('.terminal-session:not([hidden]) .xterm-helper-textarea').focus()
  await page.keyboard.type("export KEEP=present; printf 'cwd:%s\\n' \"$PWD\"\n")
  await output(a.id, `cwd:${path.join(root, 'demo', 'alpha')}`)
  // A half-typed command must still be in the same shell after navigation.
  await page.keyboard.type("printf 'kept:%s\\n' \"$KEEP\"")
  await page.keyboard.press('Control+4')
  assert.equal(await page.locator('.terminal-sidebar').isVisible(), false)
  await page.keyboard.press('Control+4')
  await page.waitForSelector('.terminal-sidebar .xterm-helper-textarea:focus')
  await page.keyboard.press('Enter')
  await output(a.id, 'kept:present')
  assert.equal((await list()).length, 1, 'toggle reuses the shell')
  await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  assert.equal(await page.locator('.terminal-sidebar').isVisible(), false)
  await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  await page.waitForSelector('.terminal-sidebar .xterm-helper-textarea:focus')

  // Both left modes toggle on repeated shortcut/click, even from terminal focus.
  await page.keyboard.press('Control+2')
  assert.equal(await page.locator('.sidebar').isVisible(), false)
  await page.keyboard.press('Control+2')
  assert.equal(await page.locator('.sidebar').isVisible(), true)
  await page.getByTitle('Agents · Ctrl+2', { exact: true }).click()
  assert.equal(await page.locator('.sidebar').isVisible(), false)
  await page.keyboard.press('Control+3')
  assert.equal(await page.locator('.sidebar').isVisible(), true)
  await page.getByRole('button', { name: 'Diff', exact: true }).click()
  assert.equal(await page.locator('.sidebar').isVisible(), false)
  assert.equal(await page.locator('.terminal-sidebar').isVisible(), true)
  assert.equal((await list())[0].id, a.id)
  await page.keyboard.press('Control+3')
  assert.equal(await page.locator('.sidebar').isVisible(), true)
  await page.keyboard.press('Control+2')

  await page.getByRole('button', { name: 'New terminal', exact: true }).click()
  await waitFor(async () => (await window.gurt.terminalList()).length === 2)
  const second = (await list())[1]
  await scope('beta').click()
  await waitFor(async () => (await window.gurt.terminalList()).length === 3)
  await scope('alpha').click()
  await page.waitForSelector('.terminal-sidebar .xterm-helper-textarea:focus')
  assert.equal(await page.locator('.terminal-tab.active [role=tab]').innerText(), 'Terminal 2', 'active tab is remembered per scope')
  assert.equal((await snapshot(a.id)).info.exitCode, null)
  assert.equal((await snapshot(a.id)).info.title, 'Server', 'renamed title survives scope switching')
  await page.getByRole('tab').first().click()
  await page.waitForSelector('.terminal-sidebar .xterm-helper-textarea:focus')
  assert.ok((await page.locator('.terminal-session:not([hidden])').innerText()).includes('kept:present'), 'screen survives scope switch')
  fs.mkdirSync(path.join(scratch, 'shots'), { recursive: true })
  await page.screenshot({ path: path.join(scratch, 'shots', 'terminal-header.png') })

  // Another workspace uses another scope; returning preserves the first shell.
  await page.locator('.tb-ws-btn').click()
  await page.locator('.tb-ws-menu .menu-item').filter({ hasText: 'other' }).click()
  await scope('alpha').click()
  await waitFor(async () => (await window.gurt.terminalList()).length === 4)
  await page.locator('.tb-ws-btn').click()
  await page.locator('.tb-ws-menu .menu-item').filter({ hasText: 'demo' }).click()
  await scope('alpha').click()
  await page.waitForSelector('.terminal-sidebar .xterm-helper-textarea:focus')
  await page.keyboard.type("printf 'again:%s\\n' \"$KEEP\"\n")
  await output(a.id, 'again:present')

  const before = (await snapshot(a.id)).info.cols
  const handle = page.locator('.terminal-sidebar').locator('xpath=preceding-sibling::div[contains(@class,"sidebar-resizer")][1]')
  const rect = await handle.boundingBox()
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
  await page.mouse.down()
  await page.mouse.move(rect.x - 100, rect.y + rect.height / 2)
  await page.mouse.up()
  await waitFor(async ([id, before]) => (await window.gurt.terminalSnapshot(id)).info.cols > before, [a.id, before])

  await page.keyboard.press('Control+1')
  assert.equal(await page.locator('.activitybar-right').count(), 0)
  assert.equal(await page.locator('.terminal-sidebar').isVisible(), false)
  await page.keyboard.press('Control+0')
  assert.equal(await page.locator('.activitybar-right').count(), 0)
  await page.locator('.set-nav-item').filter({ hasText: /^Hotkeys$/ }).click()
  const terminalHotkey = page.locator('.set-row').filter({ has: page.getByText('Toggle terminal', { exact: true }) })
  await terminalHotkey.getByRole('button', { name: 'change', exact: true }).click()
  await page.keyboard.press('Control+2')
  await page.waitForSelector('.hotkey-conflict')
  assert.equal(await page.locator('.settings').count(), 1, 'recording a shortcut must not activate navigation')
  await page.locator('.hotkey-conflict').getByRole('button', { name: 'cancel', exact: true }).click()
  await terminalHotkey.getByRole('button', { name: 'change', exact: true }).click()
  await page.keyboard.press('Control+5')
  await waitFor(async () => (await window.gurt.getHotkeys()).toggleTerminal.code === 'Digit5')
  await page.keyboard.press('Control+2')
  await page.waitForSelector('.terminal-sidebar .xterm-helper-textarea:focus')
  assert.equal((await list()).length, 4)
  await page.keyboard.press('Control+5')
  assert.equal(await page.locator('.terminal-sidebar').isVisible(), false)
  await page.keyboard.press('Control+5')
  await page.waitForSelector('.terminal-sidebar .xterm-helper-textarea:focus')
  await page.keyboard.down('Control')
  await page.waitForSelector('.activitybar-right .ab-badge')
  assert.equal(await page.locator('.activitybar-right .ab-badge').innerText(), '5')
  await page.keyboard.up('Control')
  await page.evaluate((id) => window.gurt.terminalClose(id), second.id)
  assert.equal((await list()).length, 3)
  await page.evaluate(() => window.gurt.removeTask('demo', 'alpha'))
  await waitFor(async () => !(await window.gurt.terminalList()).some((s) => s.workspace === 'demo' && s.task === 'alpha'))
  await page.waitForSelector('.terminal-session', { state: 'attached' })
  assert.equal((await list()).length, 2)
  await page.evaluate(() => window.gurt.removeWorkspace('other'))
  assert.equal((await list()).length, 1, 'workspace removal closes its terminals')
  assert.deepEqual(errors, [])
  console.log('PASS terminal UI, PTY state, shortcuts, resize, scope/workspace cleanup')
} catch (error) {
  if (page) {
    fs.mkdirSync(path.join(scratch, 'shots'), { recursive: true })
    await page.screenshot({ path: path.join(scratch, 'shots', 'terminal-failure.png') }).catch(() => {})
    const snapshots = await page.evaluate(async () => Promise.all((await window.gurt.terminalList()).map((s) => window.gurt.terminalSnapshot(s.id)))).catch(() => [])
    fs.writeFileSync(path.join(scratch, 'shots', 'terminal-snapshots.json'), JSON.stringify(snapshots, null, 2))
  }
  console.error(`Smoke artifacts: ${scratch}`)
  throw error
} finally {
  await app.close()
}
const log = fs.readFileSync(path.join(root, 'logs', 'gurt.log'), 'utf8')
assert.ok(!log.includes('export KEEP=present'), 'terminal commands are not logged, even at debug')
