// Phase 7: task Changes panel (docs/requirements-changes-panel.md acceptance).
// Fully offline: local bare repos as origins, clones created directly in the
// task dir (no Docker, no agent secrets) — the panel is host-git only, so it
// must work with containers stopped (acceptance 4 holds by construction).
// Proves: flat list + statuses + counts + badge; commit → push clears dirty
// then ahead (asserted in the bare repo); grouped rendering for two repos with
// independent groups; "No changes" + no badge when clean; Create PR button
// only for github-style origins; diff modal.
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const APP_DIR = '/Users/klerik3d/workspace/personal/gurt'
const SHOT_DIR = path.join(process.env.SCRATCH ?? '/tmp', 'shots')
// unique per run: Docker Desktop caches deleted paths in virtiofs.
const GURT_ROOT = path.join(os.homedir(), `.gurt-smoke-${Date.now()}`)
const REPO_ROOT = path.join(os.homedir(), `.gurt-smoke-repos-${Date.now()}`)
console.log('GURT_ROOT:', GURT_ROOT)
fs.mkdirSync(SHOT_DIR, { recursive: true })
fs.mkdirSync(REPO_ROOT, { recursive: true })

const require = createRequire(path.join(APP_DIR, 'package.json'))
const { _electron } = require('playwright-core')

const env = { ...process.env, GURT_ROOT }
delete env.ELECTRON_RUN_AS_NODE

const EXE = path.join(
  APP_DIR,
  'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
)

let failures = 0
const check = (cond, msg) => {
  console.log(cond ? 'OK  ' : 'FAIL', msg)
  if (!cond) failures++
}

const git = (dir, ...args) =>
  execFileSync(
    'git',
    ['-C', dir, '-c', 'user.email=smoke@test', '-c', 'user.name=smoke', ...args],
    { encoding: 'utf8' }
  )

/** Bare origin seeded with one commit on main. */
function makeBareRepo(name) {
  const seed = path.join(REPO_ROOT, `${name}-seed`)
  const bare = path.join(REPO_ROOT, `${name}.git`)
  fs.mkdirSync(seed, { recursive: true })
  git(REPO_ROOT, 'init', seed)
  git(seed, 'checkout', '-b', 'main')
  fs.writeFileSync(path.join(seed, 'README.md'), `# ${name}\n`)
  git(seed, 'add', '-A')
  git(seed, 'commit', '-m', 'initial')
  git(REPO_ROOT, 'clone', '--bare', seed, bare)
  return bare
}

/** Clone an origin into the task dir on branch gurt/<task> — what provisioning does. */
function makeClone(bare, ws, task, repo) {
  const dir = path.join(GURT_ROOT, ws, task, repo)
  git(REPO_ROOT, 'clone', bare, dir)
  git(dir, 'checkout', '-b', `gurt/${task}`)
  return dir
}

function launch() {
  return _electron.launch({ executablePath: EXE, args: [APP_DIR], env, timeout: 30000 })
}

async function open(app) {
  const page = await app.firstWindow()
  page.on('dialog', (d) => {
    console.log('[dialog]', d.type(), d.message().slice(0, 90))
    d.accept().catch(() => {})
  })
  await page.waitForSelector('.sidebar', { timeout: 15000 })
  return page
}

const clickTitle = (page, t) =>
  page.evaluate((x) => document.querySelector(`button[title="${x}"]`)?.click(), t)
const modalGone = (page) => page.waitForSelector('.modal', { state: 'detached' })

/** Click a panel button inside the changes group of `repo` (flat: the only group). */
const clickGroupButton = (page, repo, text) =>
  page.evaluate(
    ([r, tx]) => {
      const groups = [...document.querySelectorAll('.changes-group')]
      const group =
        groups.length === 1
          ? groups[0]
          : groups.find((g) => g.querySelector('.changes-repo')?.textContent.includes(r))
      const b = [...(group?.querySelectorAll('button') ?? [])].find(
        (b) => b.textContent.trim() === tx
      )
      if (!b || b.disabled) return `not clickable: ${tx}`
      b.click()
      return null
    },
    [repo, text]
  )

/** Snapshot of the rendered changes panel for assertions. */
const panelState = (page) =>
  page.evaluate(() => {
    const section = document.querySelector('.changes-section')
    if (!section) return null
    return {
      noChanges: !!section.querySelector('.no-changes'),
      groups: [...section.querySelectorAll('.changes-group')].map((g) => ({
        repo: g.querySelector('.changes-repo')?.textContent.trim() ?? null,
        files: [...g.querySelectorAll('.file-row')].map((f) => f.textContent.trim()),
        counts: g.querySelector('.changes-counts')?.textContent.trim(),
        buttons: [...g.querySelectorAll('.changes-actions button')].map((b) => ({
          text: b.textContent.trim(),
          disabled: b.disabled
        })),
        error: g.querySelector('.changes-error')?.textContent.trim() ?? null
      })),
      badge: !!document.querySelector('.task-badge')
    }
  })

/** Wait until the rendered panel matches the spec (only the given keys are checked). */
const waitPanel = (page, spec, timeout = 15000) =>
  page.waitForFunction(
    (want) => {
      const section = document.querySelector('.changes-section')
      if (!section) return false
      const groups = [...section.querySelectorAll('.changes-group')].map((g) => ({
        repo: g.querySelector('.changes-repo')?.textContent.trim() ?? null,
        files: g.querySelectorAll('.file-row').length,
        buttons: [...g.querySelectorAll('.changes-actions button')].map((b) => ({
          text: b.textContent.trim(),
          disabled: b.disabled
        }))
      }))
      if (want.groups !== undefined && groups.length !== want.groups) return false
      if (want.flat !== undefined && (groups.length !== 1 || (groups[0].repo === null) !== want.flat))
        return false
      if (want.files0 !== undefined && groups[0]?.files !== want.files0) return false
      if (want.anyGroupEmpty && !groups.some((g) => g.files === 0)) return false
      if (want.noChanges !== undefined && !!section.querySelector('.no-changes') !== want.noChanges)
        return false
      if (want.badge !== undefined && !!document.querySelector('.task-badge') !== want.badge)
        return false
      if (want.pushEnabled !== undefined) {
        const push = groups[0]?.buttons.find((b) => b.text === 'Push')
        if (!push || push.disabled === want.pushEnabled) return false
      }
      if (want.hasPr !== undefined) {
        const has = !!groups[0]?.buttons.some((b) => b.text === 'Create PR')
        if (has !== want.hasPr) return false
      }
      return true
    },
    spec,
    { timeout, polling: 500 }
  )

// ---- run --------------------------------------------------------------

const bareAlpha = makeBareRepo('alpha')
const bareBeta = makeBareRepo('beta')

const app = await launch()
app.process().stdout.on('data', (d) => process.stdout.write(`[main] ${d}`))
const page = await open(app)

// workspace + task via UI (creates the dirs the clones go into)
await clickTitle(page, 'new workspace')
await page.waitForSelector('.modal input')
await page.fill('.modal input', 'personal')
await page.click('.modal .form > button')
await modalGone(page)
await clickTitle(page, 'new task')
await page.waitForSelector('.modal input')
await page.fill('.modal input', 't1')
await page.click('.modal .form > button')
await modalGone(page)
console.log('ws + task ready')

// 1) one dirty repo → flat panel, statuses, counts, badge
const alphaDir = makeClone(bareAlpha, 'personal', 't1', 'alpha')
fs.appendFileSync(path.join(alphaDir, 'README.md'), 'changed by agent\n')
fs.writeFileSync(path.join(alphaDir, 'hello.txt'), 'hello\nworld\n')

await page.evaluate(() => {
  const t = [...document.querySelectorAll('.task-node .node-label')].find(
    (n) => n.textContent.trim() === 't1'
  )
  t?.click()
})
await page.waitForSelector('.changes-section')
await waitPanel(page, { groups: 1, files0: 2 })
let s = await panelState(page)
check(s.groups.length === 1 && s.groups[0].repo === null, 'flat rendering, no repo header')
check(
  s.groups[0].files.some((f) => f.startsWith('M') && f.includes('README.md')),
  'README.md listed as M'
)
check(
  s.groups[0].files.some((f) => f.startsWith('A') && f.includes('hello.txt')),
  'untracked hello.txt listed as A'
)
check(/2 files · \+1\s*−0/.test(s.groups[0].counts.replace(/\s+/g, ' ')), `counts: ${s.groups[0].counts}`)
check(s.badge, 'sidebar badge shown for dirty repo')
check(!s.groups[0].buttons.some((b) => b.text === 'Create PR'), 'no Create PR for non-github origin')
check(
  s.groups[0].buttons.find((b) => b.text === 'Commit')?.disabled === false,
  'Commit enabled while dirty'
)
await page.screenshot({ path: path.join(SHOT_DIR, 'c1-flat-dirty.png') })

// 2) diff modal: untracked file shown as whole-file added
await page.evaluate(() => {
  const f = [...document.querySelectorAll('.file-path')].find((n) =>
    n.textContent.includes('hello.txt')
  )
  f?.click()
})
await page.waitForSelector('.diff-view')
await page.waitForFunction(() => document.querySelector('.diff-view')?.textContent.includes('+'))
const diffText = await page.evaluate(() => document.querySelector('.diff-view').textContent)
check(diffText.includes('+hello') && diffText.includes('+world'), 'diff modal shows added lines')
await page.screenshot({ path: path.join(SHOT_DIR, 'c2-diff-modal.png') })
await page.click('.modal-header .icon-btn')
await modalGone(page)

// 3) commit (prefilled message) → dirty clears, push becomes enabled, badge stays
check((await clickGroupButton(page, 'alpha', 'Commit')) === null, 'Commit clickable')
await page.waitForSelector('.modal input')
const prefill = await page.evaluate(() => document.querySelector('.modal input').value)
check(prefill === 'gurt: t1', `commit message prefilled: "${prefill}"`)
await page.evaluate(() =>
  [...document.querySelectorAll('.modal .row-buttons button')]
    .find((b) => b.textContent.trim() === 'Commit')
    ?.click()
)
await modalGone(page)
await waitPanel(page, { groups: 1, files0: 0, pushEnabled: true })
s = await panelState(page)
check(
  s.groups[0].buttons.find((b) => b.text === 'Commit')?.disabled === true,
  'Commit disabled after commit'
)
check(s.badge, 'badge stays while unpushed commits exist')
await page.screenshot({ path: path.join(SHOT_DIR, 'c3-committed.png') })

// 4) push → panel clean, badge gone, bare repo got the branch
check((await clickGroupButton(page, 'alpha', 'Push')) === null, 'Push clickable')
await waitPanel(page, { noChanges: true, badge: false })
console.log('OK   panel shows "No changes" and badge is gone after push')
const bareLog = git(bareAlpha, 'log', '--oneline', 'gurt/t1')
check(bareLog.includes('gurt: t1'), `bare repo has the pushed commit: ${bareLog.trim()}`)
await page.screenshot({ path: path.join(SHOT_DIR, 'c4-pushed.png') })

// 5) two dirty repos → grouped rendering; actions stay per-group
const betaDir = makeClone(bareBeta, 'personal', 't1', 'beta')
fs.appendFileSync(path.join(alphaDir, 'README.md'), 'second round\n')
fs.appendFileSync(path.join(betaDir, 'README.md'), 'beta change\n')
await clickTitle(page, 'refresh changes')
await waitPanel(page, { groups: 2 })
s = await panelState(page)
check(
  s.groups.map((g) => g.repo).join(',').includes('alpha') &&
    s.groups.map((g) => g.repo).join(',').includes('beta'),
  `grouped rendering with repo headers: ${s.groups.map((g) => g.repo).join(', ')}`
)
await page.screenshot({ path: path.join(SHOT_DIR, 'c5-grouped.png') })

// commit + push beta only — alpha's group must be untouched
check((await clickGroupButton(page, 'beta', 'Commit')) === null, 'beta Commit clickable')
await page.waitForSelector('.modal input')
await page.evaluate(() =>
  [...document.querySelectorAll('.modal .row-buttons button')]
    .find((b) => b.textContent.trim() === 'Commit')
    ?.click()
)
await modalGone(page)
await waitPanel(page, { groups: 2, anyGroupEmpty: true })
check((await clickGroupButton(page, 'beta', 'Push')) === null, 'beta Push clickable')
// beta clean & pushed → drops out; alpha alone again → flat
await waitPanel(page, { flat: true })
s = await panelState(page)
check(
  s.groups[0].files.some((f) => f.includes('README.md')),
  'alpha still dirty after beta commit/push (independent groups)'
)
check(git(bareBeta, 'log', '--oneline', 'gurt/t1').includes('gurt: t1'), 'beta bare got the branch')
check(s.badge, 'badge still on (alpha dirty)')
await page.screenshot({ path: path.join(SHOT_DIR, 'c6-beta-pushed.png') })

// 6) github-style origin → Create PR button appears
git(alphaDir, 'remote', 'set-url', 'origin', 'git@github.com:klerik3d/alpha.git')
await clickTitle(page, 'refresh changes')
await waitPanel(page, { groups: 1, hasPr: true })
s = await panelState(page)
// alpha is fully pushed (remote branch == HEAD), only dirty — PR is possible
check(
  s.groups[0].buttons.find((b) => b.text === 'Create PR')?.disabled === false,
  'Create PR enabled for github origin with pushed branch'
)
await page.screenshot({ path: path.join(SHOT_DIR, 'c7-github-pr.png') })

await app.close()
console.log(failures ? `PHASE7 FAILED (${failures})` : 'PHASE7 DONE')
process.exit(failures ? 1 : 0)
