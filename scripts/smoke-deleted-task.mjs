// Deleting a task must fully retire it: no leftover selection pointing at it,
// and no directory resurrected on disk by a late persist.
//
// Regression for: after deleting a task, the new-session modal (⌘N) was
// pre-filled with the deleted task's name (the selection was never cleared), and
// a session created from there landed in the deleted task's re-created directory
// — invisible in the tree, because the resurrected dir had sessions.json but no
// task.json. Two bugs caused it: the stale selection, and a debounced persist
// (scheduled by the container teardown) that fired after the task dir was
// removed.
//
//   npm run build && node scripts/smoke-deleted-task.mjs
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SCRATCH = process.env.SCRATCH ?? '/tmp/gurt-smoke-deleted-task'
const GURT_ROOT = path.join(SCRATCH, 'gurt-root')
const SHOT_DIR = path.join(SCRATCH, 'shots')
fs.rmSync(GURT_ROOT, { recursive: true, force: true })
fs.mkdirSync(SHOT_DIR, { recursive: true })

const ws = 'w'
const task = 't'
fs.mkdirSync(path.join(GURT_ROOT, ws, task), { recursive: true })
fs.writeFileSync(
  path.join(GURT_ROOT, ws, 'workspace.json'),
  JSON.stringify({
    repos: [{ name: 'alpha', url: 'https://github.com/o/alpha.git' }],
    envs: [{ name: 'dev', devcontainer: '{"image":"x"}', repo: 'alpha' }]
  })
)
fs.writeFileSync(
  path.join(GURT_ROOT, 'agents.json'),
  JSON.stringify({ opencode: { kind: 'opencode', label: 'opencode' } })
)
fs.writeFileSync(path.join(GURT_ROOT, ws, task, 'task.json'), JSON.stringify({}))
fs.writeFileSync(
  path.join(GURT_ROOT, ws, task, 'sessions.json'),
  JSON.stringify([
    {
      info: {
        id: 's-old',
        env: 'dev',
        repo: 'alpha',
        task,
        workspace: ws,
        title: 'Old',
        state: 'draft',
        startPrompt: 'hi'
      }
    }
  ])
)

const require = createRequire(path.join(APP_DIR, 'package.json'))
const { _electron } = require('playwright-core')
const electronPath = require('electron')

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

const shot = (name) => page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) })
const diskTasks = () =>
  fs.readdirSync(path.join(GURT_ROOT, ws)).filter((d) => d !== 'workspace.json')
// The breadcrumb's workspace segment is now its own flex child (the titlebar
// switcher button), so innerText's line-break-per-block-box rule inserts
// newlines around it — collapse to spaces for a plain-text comparison.
const crumbText = async () => (await page.locator('.tb-crumb').innerText()).replace(/\s+/g, ' ').trim()

try {
  await page.waitForSelector('.sidebar', { timeout: 15000 })
  await page.waitForSelector('.sb-task', { timeout: 10000 })

  // Delete the task behind the confirmation.
  await page.click('.sb-task-name:has-text("t")')
  await page.hover('.sb-task')
  await page.click('.sb-task .icon-sq[title="delete task"]')
  await page.waitForSelector('.dialog', { timeout: 5000 })
  await page.click('.dialog-ok')
  await page.waitForFunction(() => document.querySelectorAll('.sb-task').length === 0, null, {
    timeout: 10000
  })
  assert.deepEqual(diskTasks(), [], 'the deleted task dir is gone from disk')
  assert.equal(await crumbText(), ws, 'the selection of the deleted task is dropped')
  console.log('task deleted from tree and disk OK')

  // Open the new-session modal. It must NOT prefill the deleted task — the
  // stale selection was cleared, and the deleted dir stays gone.
  await page.keyboard.press('Control+n')
  await page.waitForSelector('.modal:has-text("New session")', { timeout: 5000 })
  const taskValue = await page.locator('.ns-body .pick-value').first().innerText()
  assert.equal(taskValue, 'no tasks yet', 'modal does not prefill the deleted task')
  await new Promise((r) => setTimeout(r, 700)) // a late persist would show up here
  assert.deepEqual(diskTasks(), [], 'the deleted task dir is not resurrected on modal open')
  await shot('01-modal-no-stale-task')
  console.log('modal is not pre-filled with the deleted task OK')

  // Create a new task inline and run a session on it.
  await page.click('.ns-body .pick-row:has-text("TASK")')
  await page.waitForSelector('.pick-menu', { timeout: 5000 })
  assert.deepEqual(
    await page.locator('.pick-menu .menu-item').allInnerTexts(),
    ['+ new task'],
    'the picker only offers creating a fresh task'
  )
  await page.click('.pick-menu .menu-item:has-text("+ new task")')
  await page.waitForSelector('.menu-item-input input', { timeout: 5000 })
  await page.fill('.menu-item-input input', 'n')
  await page.press('.menu-item-input input', 'Enter')
  await page.waitForSelector('.menu-item-input', { state: 'detached', timeout: 5000 })
  assert.equal(
    await page.locator('.ns-body .pick-value').first().innerText(),
    'n',
    'the new task is selected right away'
  )
  await page.fill('.ns-prompt-input', 'do something')
  await page.click('.modal .btn-primary:has-text("Run now")')
  await page.waitForSelector('.modal', { state: 'detached', timeout: 8000 })
  await new Promise((r) => setTimeout(r, 800))

  // The session must land in the NEW task, and the deleted task must stay gone.
  assert.deepEqual(diskTasks(), ['n'], 'only the new task exists on disk')
  assert.ok(fs.existsSync(path.join(GURT_ROOT, ws, 'n', 'task.json')), 'new task has task.json')
  const recs = JSON.parse(
    fs.readFileSync(path.join(GURT_ROOT, ws, 'n', 'sessions.json'), 'utf8')
  )
  assert.equal(recs.length, 1, 'the session was persisted under the new task')
  assert.equal(recs[0].info.task, 'n', 'the session belongs to the new task')
  // Pruning a dead selection must not touch a fresh one: the new session is
  // selected one tree refresh before it shows up in the tree.
  assert.equal(
    await page.locator('.sb-session.selected').count(),
    1,
    'the new session is selected, not pruned as unknown to the tree'
  )
  assert.match(await crumbText(), /w \/ n · /, 'the new session pane is open')
  await shot('02-session-in-new-task')
  console.log('session created under the new task, not the deleted one OK')

  console.log('smoke-deleted-task: PASS')
} catch (e) {
  await shot('99-failure').catch(() => {})
  console.error('smoke-deleted-task: FAIL')
  console.error(e)
  console.error('shots in', SHOT_DIR)
  process.exitCode = 1
} finally {
  await app.close().catch(() => {})
}
