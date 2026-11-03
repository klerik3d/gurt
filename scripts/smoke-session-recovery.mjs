// Resume popup: scope identity, keyboard navigation, deferred work and partial
// failures. Only the resume command is stubbed; startup restores real records.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const scratch = fs.mkdtempSync(path.join(process.env.SCRATCH ?? os.tmpdir(), 'gurt-recovery-ui-'))
const root = path.join(scratch, 'store')
const sessions = [
  { id: 'first', workspace: 'personal', task: 'git-mode', title: 'Update repository navigation' },
  { id: 'retry', workspace: 'work', task: 'git-mode', title: 'Update repository navigation' },
  { id: 'later', workspace: 'work', task: 'session-recovery', title: 'Make the resume popup clearer and more consistent with the rest of the application' }
]
for (const session of sessions) {
  const taskDir = path.join(root, session.workspace, session.task)
  fs.mkdirSync(taskDir, { recursive: true })
  fs.writeFileSync(path.join(root, session.workspace, 'workspace.json'), JSON.stringify({
    repos: [], envs: [{ name: 'dev', devcontainer: '{"image":"unused"}' }]
  }))
  fs.writeFileSync(path.join(taskDir, 'task.json'), '{}')
  fs.writeFileSync(path.join(taskDir, 'sessions.json'), JSON.stringify([{
    info: { ...session, state: 'started', env: 'dev', repos: [] },
    acpSessionId: `agent-${session.id}`, interrupted: true, log: []
  }]))
}
const require = createRequire(path.join(appDir, 'package.json'))
const { _electron } = require('playwright-core')
const env = { ...process.env, GURT_ROOT: root, GURT_WELCOME: 'never' }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const app = await _electron.launch({
  executablePath: require('electron'),
  args: [appDir, '--no-sandbox', `--user-data-dir=${path.join(scratch, 'profile')}`], env
})
let page
try {
  // Test the interaction without starting agents or Docker containers.
  await app.evaluate(({ ipcMain }) => {
    let failNext = true
    ipcMain.removeHandler('api:resumeInterruptedSession')
    ipcMain.handle('api:resumeInterruptedSession', async (_event, id) => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      if (id === 'retry' && failNext) {
        failNext = false
        throw new Error('Could not save session; try again')
      }
    })
  })
  page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const dialog = page.getByRole('dialog', { name: 'Resume sessions', exact: true })
  await dialog.waitFor()
  assert.equal(await dialog.locator('.recovery-session').count(), 3)
  for (const session of sessions) {
    const row = dialog.locator('.recovery-session').filter({ hasText: `${session.workspace}` }).filter({ hasText: session.task })
    assert.equal(await row.count(), 1, 'workspace and scope disambiguate identical titles')
    assert.ok((await row.innerText()).includes(session.title))
  }
  assert.equal(await dialog.locator('input:checked').count(), 3)
  await dialog.getByRole('button', { name: 'Clear selection', exact: true }).click()
  assert.equal(await dialog.getByRole('button', { name: 'Resume selected', exact: true }).isEnabled(), false)
  await dialog.getByRole('button', { name: 'Select all', exact: true }).click()
  await page.screenshot({ path: path.join(scratch, 'resume-sessions.png') })

  await dialog.getByRole('button', { name: 'Resume selected (3)', exact: true }).focus()
  await page.keyboard.press('Tab')
  assert.equal(await dialog.getByTitle('close', { exact: true }).evaluate((el) => el === document.activeElement), true)
  await page.keyboard.press('Shift+Tab')
  assert.equal(await dialog.getByRole('button', { name: 'Resume selected (3)', exact: true }).evaluate((el) => el === document.activeElement), true)
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'resume (3)', exact: true }).click()
  await dialog.waitFor()
  const deferred = dialog.locator('.recovery-session').filter({ hasText: 'session-recovery' })
  await deferred.getByRole('checkbox').uncheck()
  await dialog.getByRole('button', { name: 'Resume selected (2)', exact: true }).click()
  await dialog.getByRole('status').waitFor()
  assert.equal(await dialog.getByRole('button', { name: 'Later', exact: true }).isEnabled(), false)
  assert.equal(await dialog.getByTitle('close', { exact: true }).isEnabled(), false)
  await page.keyboard.press('Escape')
  assert.equal(await dialog.isVisible(), true)
  await dialog.getByRole('alert').waitFor()
  assert.match(await dialog.getByRole('alert').innerText(), /work \/ git-mode/)
  assert.doesNotMatch(await dialog.getByRole('alert').innerText(), /api:resumeInterruptedSession/)
  assert.equal(await dialog.locator('.recovery-session').count(), 2, 'successful sessions leave the list after a partial failure')
  assert.equal(await dialog.locator('input:checked').count(), 1, 'only failed selections remain selected')
  await page.screenshot({ path: path.join(scratch, 'resume-error.png') })
  await dialog.getByRole('button', { name: 'Resume selected (1)', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'resume (1)', exact: true }).click()
  await dialog.waitFor()
  assert.equal(await dialog.locator('.recovery-session').count(), 1)
  assert.match(await dialog.innerText(), /session-recovery/)
  await dialog.getByRole('button', { name: 'Later', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  assert.deepEqual(errors, [])
  console.log(`PASS session recovery popup: scope, selection, keyboard, partial failure and retry. Screenshots: ${scratch}`)
} catch (e) {
  await page?.screenshot({ path: path.join(scratch, 'failure.png') }).catch(() => {})
  console.error(`Recovery UI artifacts: ${scratch}`)
  throw e
} finally {
  await app.close()
}
