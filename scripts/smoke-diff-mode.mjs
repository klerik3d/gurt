// Task mode switching and real host-git actions, using only temporary local repos.
// npm run build && xvfb-run -a node scripts/smoke-diff-mode.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const scratch = fs.mkdtempSync(path.join(process.env.SCRATCH ?? os.tmpdir(), 'gurt-diff-'))
const root = path.join(scratch, 'store')
const taskDir = path.join(root, 'demo', 'navigation')
const seed = path.join(scratch, 'seed')
const origin = path.join(scratch, 'origin.git')
const clone = path.join(taskDir, 'frontend')
const git = (dir, ...args) => execFileSync('git', [
  '-C', dir, '-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.test', ...args
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
fs.mkdirSync(path.join(seed, 'src'), { recursive: true })
fs.mkdirSync(taskDir, { recursive: true })
git(seed, 'init', '-b', 'main')
fs.writeFileSync(path.join(seed, 'src', 'app.ts'), 'export const mode = "sessions"\n')
fs.writeFileSync(path.join(seed, 'README.md'), '# Demo\n')
fs.writeFileSync(path.join(seed, 'unchanged.txt'), 'keep\n')
git(seed, 'add', '-A')
git(seed, 'commit', '-m', 'initial')
git(scratch, 'clone', '--bare', seed, origin)
git(scratch, 'clone', origin, clone)
git(clone, 'checkout', '-b', 'navigation')
git(scratch, 'clone', origin, path.join(taskDir, 'backend'))
git(path.join(taskDir, 'backend'), 'checkout', '-b', 'navigation')
fs.writeFileSync(path.join(clone, 'src', 'app.ts'), 'export const mode = "diff"\nexport const comments = false\n')
fs.writeFileSync(path.join(clone, 'src', 'new.ts'), 'export const added = true\n')
fs.unlinkSync(path.join(clone, 'README.md'))
fs.writeFileSync(path.join(clone, 'asset.bin'), Buffer.from([0, 1, 2, 0, 3]))
fs.writeFileSync(path.join(root, 'demo', 'workspace.json'), JSON.stringify({
  repos: [{ name: 'frontend', url: origin }, { name: 'backend', url: origin }],
  envs: [{ name: 'dev', devcontainer: '{"image":"unused"}' }]
}))
fs.writeFileSync(path.join(taskDir, 'task.json'), '{}')
fs.writeFileSync(path.join(taskDir, 'sessions.json'), JSON.stringify([{ info: {
  id: 'draft-session', workspace: 'demo', task: 'navigation', env: 'dev',
  repos: ['frontend'], title: 'Build navigation', state: 'draft'
} }]))

// Advance main after cloning: entering Diff must fetch and show the behind count.
git(seed, 'remote', 'add', 'origin', origin)
fs.writeFileSync(path.join(seed, 'upstream.txt'), 'new upstream\n')
git(seed, 'add', '-A')
git(seed, 'commit', '-m', 'advance main')
git(seed, 'push', 'origin', 'main')

const require = createRequire(path.join(appDir, 'package.json'))
const { _electron } = require('playwright-core')
const env = {
  ...process.env, GURT_ROOT: root, GURT_WELCOME: 'never',
  GIT_AUTHOR_NAME: 'Smoke', GIT_AUTHOR_EMAIL: 'smoke@example.test',
  GIT_COMMITTER_NAME: 'Smoke', GIT_COMMITTER_EMAIL: 'smoke@example.test'
}
delete env.ELECTRON_RUN_AS_NODE
// Keep layout preferences from earlier launches out of this fixture.
const app = await _electron.launch({
  executablePath: require('electron'),
  args: [appDir, '--no-sandbox', `--user-data-dir=${path.join(scratch, 'electron-profile')}`],
  env
})
const errors = []
try {
  const page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForSelector('.sb-session')
  await page.locator('.sb-session').click()
  await page.keyboard.press('Meta+3')
  await page.waitForSelector('.diff-repo-row')
  assert.equal(await page.locator('.sb-session').count(), 0, 'Command+3 opens diff mode and hides sessions')
  assert.equal(await page.locator('.sidebar .sb-head').count(), 1, 'one task header')
  assert.equal(await page.locator('.sb-head .diff-layout').count(), 1, 'layout control is in the task header')
  assert.equal(await page.locator('.sb-head button[title="Refresh changes"]').count(), 1, 'refresh is in the task header')
  assert.equal(await page.locator('.sb-task-name').innerText(), 'navigation', 'same task remains')
  assert.equal(await page.locator('.diff-repo-row').count(), 2, 'clean repos remain visible')
  assert.equal(await page.locator('.diff-file-row').count(), 0, 'repos start collapsed')
  const frontend = page.locator('.diff-repo').filter({ has: page.locator('.diff-repo-name', { hasText: 'frontend' }) })
  await page.waitForFunction(() => document.querySelector('.diff-behind.behind')?.textContent === '↓1')
  assert.equal(await frontend.locator('.diff-counts').textContent(), '+2−2')
  await frontend.locator('.diff-repo-row').click()
  assert.equal(await frontend.locator('.diff-change-group').count(), 1)
  assert.equal(await frontend.locator('button[title="src/app.ts"]').count(), 0, 'files start inside collapsed groups')
  await frontend.locator('.diff-change-group').click()
  assert.equal(await frontend.locator('.diff-file-row:not(.diff-change-group)').count(), 4)
  await frontend.locator('button[title="src/app.ts"]').click()
  await page.waitForSelector('.diff-pane .split-row.change')
  assert.match(await page.locator('.diff-pane .split').innerText(), /sessions/)
  assert.match(await page.locator('.diff-pane .split').innerText(), /comments = false/)
  assert.equal(await page.locator('.modal, .split-add, .review-foot').count(), 0, 'inline diff has no review UI')

  // The tree keeps the caret and its arrow keys walk repos and files too.
  assert.equal(await page.evaluate(() => document.activeElement?.className), 'sb-tree', 'a row click leaves focus on the tree')
  await page.keyboard.press('ArrowDown')
  assert.equal(await frontend.locator('button[title="src/new.ts"]').getAttribute('aria-pressed'), 'true', 'ArrowDown selects the next file')
  await page.keyboard.press('ArrowUp')
  assert.equal(await frontend.locator('button[title="src/app.ts"]').getAttribute('aria-pressed'), 'true', 'ArrowUp selects the previous file')
  await page.keyboard.press('ArrowLeft')
  assert.equal(await frontend.locator('.diff-change-group.cursor').count(), 1, 'ArrowLeft walks out to the group')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  assert.equal(await frontend.locator('.diff-repo-row.cursor').count(), 1, 'ArrowLeft walks out to the repo')
  await page.keyboard.press('ArrowLeft')
  assert.equal(await frontend.locator('.diff-file-row').count(), 0, 'ArrowLeft on an open repo collapses it')
  await page.keyboard.press('ArrowRight')
  assert.equal(await frontend.locator('.diff-file-row').count(), 1, 'ArrowRight expands the repo')
  await page.keyboard.press('ArrowRight')
  assert.equal(await frontend.locator('.diff-file-row.cursor').count(), 1, 'ArrowRight steps into the files')
  await page.keyboard.press('ArrowRight')
  await frontend.locator('button[title="src/app.ts"]').click()

  await page.getByRole('button', { name: 'File tree', exact: true }).click()
  assert.equal(await frontend.locator('.diff-folder').innerText(), 'src')
  assert.equal(await frontend.locator('button[title="unchanged.txt"]').count(), 0)
  assert.equal(await frontend.locator('button[title="src/app.ts"]').getAttribute('aria-pressed'), 'true')
  await frontend.locator('.diff-folder').click()
  assert.equal(await frontend.locator('button[title="src/app.ts"]').count(), 0, 'folders collapse')
  await frontend.locator('.diff-folder').click()
  await page.getByRole('button', { name: 'Unified', exact: true }).click()
  await page.waitForSelector('.diff-pane .unified')
  await page.getByRole('button', { name: 'Split', exact: true }).click()
  await page.screenshot({ path: path.join(scratch, 'diff-tree.png') })

  await frontend.locator('button[title="asset.bin"]').click()
  await page.getByText('binary file — no text diff', { exact: true }).waitFor()
  await frontend.locator('button[title="README.md"]').click()
  await page.waitForSelector('.diff-pane .split-pane.del')
  await frontend.locator('button[title="src/new.ts"]').click()
  await page.waitForSelector('.diff-pane .split-pane.add')

  // Switching back retains the selected session; switching again retains the layout.
  await page.locator('button[title^="Agents"]').click()
  assert.equal(await page.locator('.sb-session.selected').innerText(), 'Build navigation')
  await page.keyboard.press('Control+3')
  assert.equal(await page.getByRole('button', { name: 'File tree', exact: true }).getAttribute('aria-pressed'), 'true')
  await frontend.locator('.diff-repo-row').click({ button: 'right' })
  await page.getByRole('button', { name: 'Commit changes…', exact: true }).click()
  await page.locator('.commit-message').fill('Add diff mode')
  await page.locator('.modal').getByRole('button', { name: 'Commit', exact: true }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('.diff-repo')].some((r) =>
    r.querySelector('.diff-repo-name')?.textContent === 'frontend' &&
    r.getAttribute('aria-busy') === 'false' && r.querySelector('.diff-counts')?.textContent === '+0−0'))
  assert.equal(git(clone, 'log', '-1', '--format=%s'), 'Add diff mode')
  assert.equal(git(clone, 'status', '--porcelain'), '')
  await frontend.locator('.diff-change-group[title="Add diff mode"]').click()
  await frontend.locator('button[title="src/app.ts"]').click()
  await page.waitForSelector('.diff-pane .split-row.change')
  assert.match(await page.locator('.diff-pane .diff-scope').innerText(), /Commit /)
  assert.match(await page.locator('.diff-pane .split').innerText(), /sessions/)
  assert.match(await page.locator('.diff-pane .split').innerText(), /comments = false/)
  await frontend.locator('.diff-repo-row').click({ button: 'right' })
  await page.getByRole('button', { name: 'Push changes', exact: true }).click()
  await frontend.locator('.diff-repo-dot.delivered').waitFor()
  assert.equal(git(origin, 'rev-parse', 'navigation'), git(clone, 'rev-parse', 'HEAD'))

  await frontend.locator('.diff-repo-row').click({ button: 'right' })
  await page.getByRole('button', { name: 'Merge pull from main', exact: true }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('.diff-repo')].some((r) =>
    r.querySelector('.diff-repo-name')?.textContent === 'frontend' &&
    r.getAttribute('aria-busy') === 'false' && r.querySelector('.diff-behind')?.textContent === '↓0'))
  assert.equal(fs.readFileSync(path.join(clone, 'upstream.txt'), 'utf8'), 'new upstream\n')
  // Manual folding survives both mode switches and Sidebar unmounts, including hotkeys.
  await page.locator('button[title^="Agents"]').click()
  await page.locator('.sb-task .sb-chev').click()
  for (const destination of ['Diff', 'Dashboard']) {
    for (const viaKeyboard of [false, true]) {
      await page.locator(`.activitybar button[title^="${destination}"]`).click()
      if (viaKeyboard) await page.keyboard.press('Control+2')
      else await page.locator('button[title^="Agents"]').click()
      await page.waitForFunction(() => document.querySelector('.sb-task')?.getAttribute('aria-expanded') === 'false')
      assert.equal(await page.locator('.sb-session').count(), 0, `${destination} return preserves collapsed scope`)
    }
  }
  await page.locator('.sb-task .sb-chev').click()
  await page.locator('.activitybar button[title^="Dashboard"]').click()
  await page.locator('button[title^="Agents"]').click()
  await page.waitForSelector('.sb-session')
  assert.deepEqual(errors, [], 'no renderer exceptions')
  console.log(`PASS diff mode: list/tree, inline diff, session restore, commit/push/update. Screenshot: ${scratch}/diff-tree.png`)
} finally {
  await app.close()
}
