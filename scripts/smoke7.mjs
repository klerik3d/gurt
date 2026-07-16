// Phase 7: task Changes panel = delivery thread (docs/requirements-changes-thread.md).
// Fully offline: local bare repos as origins, clones created directly in the task
// dir (no Docker, no agent secrets) — the panel is host-git only, so it must work
// with containers stopped (acceptance 6 holds by construction).
// Proves: Uncommitted block → commit moves the change into the branch block as
// `local` (nothing vanishes) → push flips it to `pushed` + hollow badge; grouped
// rendering with independent groups; merge on the remote → "No changes"; squash +
// remote branch deletion → integrated (refs/gurt/integrated), and a new commit
// reopens the thread; unreachable origin → silent fetch failure, last-known refs,
// Commit still works; Create PR only for a GitHub-style origin.
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

/** A commit landing on the origin's default branch with a fresh SHA — a squash merge. */
function squashOntoDefault(bare, name, message) {
  const tmp = path.join(REPO_ROOT, `${name}-land-${Date.now()}`)
  git(REPO_ROOT, 'clone', bare, tmp)
  fs.writeFileSync(path.join(tmp, 'squashed.txt'), `${message}\n`)
  git(tmp, 'add', '-A')
  git(tmp, 'commit', '-m', message)
  git(tmp, 'push', 'origin', 'main')
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

/**
 * Click a panel button by text in `repo`'s group (flat: the only group), once it is
 * enabled; returns null on success. Panel actions refresh asynchronously, so the
 * button we want is often still disabled on arrival.
 */
async function clickGroupButton(page, repo, text) {
  // Runs in the page: locate the button, click it when `click` is set.
  const find = ([r, tx, click]) => {
    const groups = [...document.querySelectorAll('.changes-group')]
    const group =
      groups.length === 1
        ? groups[0]
        : groups.find((g) => g.querySelector('.changes-repo')?.textContent.includes(r))
    const b = [...(group?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent.trim() === tx
    )
    if (click) b?.click()
    return !!b && !b.disabled
  }
  try {
    await page.waitForFunction(find, [repo, text, false], { timeout: 15000, polling: 300 })
  } catch {
    return `not clickable: ${text}`
  }
  await page.evaluate(find, [repo, text, true])
  return null
}

/** Commit through the modal, accepting the prefilled message. */
async function commitVia(page, repo) {
  check((await clickGroupButton(page, repo, 'Commit')) === null, `${repo}: Commit clickable`)
  await page.waitForSelector('.modal input')
  await page.evaluate(() =>
    [...document.querySelectorAll('.modal .row-buttons button')]
      .find((b) => b.textContent.trim() === 'Commit')
      ?.click()
  )
  await modalGone(page)
}

/** Snapshot of the rendered changes panel for assertions. */
const panelState = (page) =>
  page.evaluate(() => {
    const section = document.querySelector('.changes-section')
    if (!section) return null
    const badge = document.querySelector('.task-badge')
    return {
      noChanges: !!section.querySelector('.no-changes'),
      groups: [...section.querySelectorAll('.changes-group')].map((g) => ({
        repo: g.querySelector('.changes-repo')?.textContent.trim() ?? null,
        blocks: [...g.querySelectorAll('.block-head')].map((b) => b.textContent.trim()),
        files: [...g.querySelectorAll('.file-row')].map((f) => f.textContent.trim()),
        counts: g.querySelector('.changes-counts')?.textContent.trim() ?? null,
        commits: [...g.querySelectorAll('.commit-row')].map((c) => ({
          sha: c.querySelector('.commit-sha')?.textContent.trim(),
          subject: c.querySelector('.commit-subject')?.textContent.trim(),
          state: c.querySelector('.commit-state')?.textContent.trim()
        })),
        buttons: [...g.querySelectorAll('.changes-actions button')].map((b) => ({
          text: b.textContent.trim(),
          disabled: b.disabled
        })),
        error: g.querySelector('.changes-error')?.textContent.trim() ?? null
      })),
      badge: badge ? (badge.classList.contains('badge-delivered') ? 'hollow' : 'filled') : null
    }
  })

/** Wait until the rendered panel matches the spec (only the given keys are checked). */
const waitPanel = (page, spec, timeout = 20000) =>
  page.waitForFunction(
    (want) => {
      const section = document.querySelector('.changes-section')
      if (!section) return false
      const groups = [...section.querySelectorAll('.changes-group')].map((g) => ({
        repo: g.querySelector('.changes-repo')?.textContent.trim() ?? null,
        files: g.querySelectorAll('.file-row').length,
        states: [...g.querySelectorAll('.commit-state')].map((c) => c.textContent.trim()),
        buttons: [...g.querySelectorAll('.changes-actions button')].map((b) => ({
          text: b.textContent.trim(),
          disabled: b.disabled
        }))
      }))
      const badgeEl = document.querySelector('.task-badge')
      const badge = badgeEl
        ? badgeEl.classList.contains('badge-delivered')
          ? 'hollow'
          : 'filled'
        : null
      if (want.groups !== undefined && groups.length !== want.groups) return false
      if (want.flat !== undefined && (groups.length !== 1 || (groups[0].repo === null) !== want.flat))
        return false
      if (want.files0 !== undefined && groups[0]?.files !== want.files0) return false
      if (want.states0 !== undefined && groups[0]?.states.join(',') !== want.states0) return false
      if (want.noChanges !== undefined && !!section.querySelector('.no-changes') !== want.noChanges)
        return false
      if (want.badge !== undefined && badge !== want.badge) return false
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

/** Wait until `repo`'s own group matches the spec — `waitPanel` only sees the first. */
const waitRepo = (page, repo, spec, timeout = 20000) =>
  page.waitForFunction(
    ([r, want]) => {
      const groups = [...document.querySelectorAll('.changes-group')]
      const g =
        groups.length === 1
          ? groups[0]
          : groups.find((x) => x.querySelector('.changes-repo')?.textContent.includes(r))
      if (!g) return false
      const states = [...g.querySelectorAll('.commit-state')].map((c) => c.textContent.trim())
      if (want.states !== undefined && states.join(',') !== want.states) return false
      if (want.files !== undefined && g.querySelectorAll('.file-row').length !== want.files)
        return false
      return true
    },
    [repo, spec],
    { timeout, polling: 300 }
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

// 1) one dirty repo → flat panel, Uncommitted block, statuses, counts, filled badge
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
check(s.groups[0].blocks.join(',') === 'Uncommitted', `only the Uncommitted block: ${s.groups[0].blocks}`)
check(
  s.groups[0].files.some((f) => f.startsWith('M') && f.includes('README.md')),
  'README.md listed as M'
)
check(
  s.groups[0].files.some((f) => f.startsWith('A') && f.includes('hello.txt')),
  'untracked hello.txt listed as A'
)
check(/2 files · \+1\s*−0/.test(s.groups[0].counts.replace(/\s+/g, ' ')), `counts: ${s.groups[0].counts}`)
check(s.badge === 'filled', `filled badge for dirty repo: ${s.badge}`)
check(!s.groups[0].buttons.some((b) => b.text === 'Create PR'), 'no Create PR for non-github origin')
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

// 3) commit → the change MOVES into the branch block as `local`; nothing vanishes
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
await waitPanel(page, { groups: 1, states0: 'local', pushEnabled: true })
s = await panelState(page)
check(
  s.groups[0].blocks.length === 1 && s.groups[0].blocks[0] === 'On gurt/t1 · 1 commit not in main',
  `branch block header: ${s.groups[0].blocks}`
)
check(s.groups[0].commits[0].subject === 'gurt: t1', `commit subject: ${s.groups[0].commits[0].subject}`)
check(!s.groups[0].files.length, 'Uncommitted block gone after commit')
check(s.badge === 'filled', 'badge stays filled while a local commit exists')
await page.screenshot({ path: path.join(SHOT_DIR, 'c3-committed.png') })

// 4) click the commit → read-only `git show` modal
await page.evaluate(() => document.querySelector('.commit-row')?.click())
await page.waitForSelector('.diff-view')
await page.waitForFunction(() => document.querySelector('.diff-view')?.textContent.includes('+'))
const showText = await page.evaluate(() => document.querySelector('.diff-view').textContent)
check(
  showText.includes('gurt: t1') && showText.includes('+hello'),
  'commit modal shows `git show` output'
)
await page.screenshot({ path: path.join(SHOT_DIR, 'c4-commit-show.png') })
await page.click('.modal-header .icon-btn')
await modalGone(page)

// 5) push → `pushed`, hollow badge, Push disabled; the bare repo has the branch
check((await clickGroupButton(page, 'alpha', 'Push')) === null, 'Push clickable')
await waitPanel(page, { groups: 1, states0: 'pushed', badge: 'hollow', pushEnabled: false })
console.log('OK   pushed commit reads `pushed`, badge hollow, Push disabled')
const bareLog = git(bareAlpha, 'log', '--oneline', 'gurt/t1')
check(bareLog.includes('gurt: t1'), `bare repo has the pushed commit: ${bareLog.trim()}`)
s = await panelState(page)
check(!s.groups[0].buttons.some((b) => b.text === 'Create PR'), 'still no Create PR (non-github origin)')
await page.screenshot({ path: path.join(SHOT_DIR, 'c5-pushed.png') })

// 6) github-style origin → Create PR; unreachable host must not break the panel
git(alphaDir, 'remote', 'set-url', 'origin', 'git@github.invalid:klerik3d/alpha.git')
await clickTitle(page, 'refresh changes')
await waitPanel(page, { groups: 1, hasPr: true })
s = await panelState(page)
check(
  s.groups[0].buttons.find((b) => b.text === 'Create PR')?.disabled === false,
  'Create PR enabled for a github origin with a pushed commit'
)
check(s.groups[0].error === null, 'failed fetch to the github host renders no error UI')
check(s.groups[0].commits[0].state === 'pushed', 'last-known refs kept when fetch fails')
await page.screenshot({ path: path.join(SHOT_DIR, 'c6-github-pr.png') })
git(alphaDir, 'remote', 'set-url', 'origin', bareAlpha)
await clickTitle(page, 'refresh changes')
await waitPanel(page, { groups: 1, hasPr: false })
console.log('OK   Create PR gone again for a non-github origin')

// 7) two repos → grouped rendering; commit/push in one group leaves the other alone
const betaDir = makeClone(bareBeta, 'personal', 't1', 'beta')
fs.appendFileSync(path.join(betaDir, 'README.md'), 'beta change\n')
fs.appendFileSync(path.join(alphaDir, 'README.md'), 'second round\n')
await clickTitle(page, 'refresh changes')
await waitPanel(page, { groups: 2 })
s = await panelState(page)
check(
  s.groups.map((g) => g.repo).join(',').includes('alpha') &&
    s.groups.map((g) => g.repo).join(',').includes('beta'),
  `grouped rendering with repo headers: ${s.groups.map((g) => g.repo).join(', ')}`
)
await page.screenshot({ path: path.join(SHOT_DIR, 'c7-grouped.png') })

await commitVia(page, 'beta')
check((await clickGroupButton(page, 'beta', 'Push')) === null, 'beta Push clickable')
await waitRepo(page, 'beta', { states: 'pushed' })
s = await panelState(page)
const alphaGroup = s.groups.find((g) => g.repo.includes('alpha'))
check(
  alphaGroup.files.some((f) => f.includes('README.md')),
  'alpha still dirty after beta commit/push (independent groups)'
)
check(git(bareBeta, 'log', '--oneline', 'gurt/t1').includes('gurt: t1'), 'beta bare got the branch')
check(s.badge === 'filled', 'badge filled while alpha is dirty')

// deliver alpha's second round too → both repos delivered, badge hollow
await commitVia(page, 'alpha')
check((await clickGroupButton(page, 'alpha', 'Push')) === null, 'alpha Push clickable')
await waitPanel(page, { groups: 2, badge: 'hollow' })
console.log('OK   both repos delivered → hollow badge, thread still rendered')
await page.screenshot({ path: path.join(SHOT_DIR, 'c8-delivered.png') })

// 8) merge alpha into the remote default → its thread empties by ancestry
git(bareAlpha, 'update-ref', 'refs/heads/main', git(bareAlpha, 'rev-parse', 'gurt/t1').trim())
await clickTitle(page, 'refresh changes')
await waitPanel(page, { flat: true })
s = await panelState(page)
check(s.groups.length === 1, 'merged repo dropped out of the panel')
check(s.badge === 'hollow', 'badge still hollow (beta delivered)')

// 9) squash-merge beta + delete the remote branch → integrated via refs/gurt/integrated
const betaHead = git(betaDir, 'rev-parse', 'HEAD').trim()
squashOntoDefault(bareBeta, 'beta', 'squashed: gurt/t1')
git(bareBeta, 'update-ref', '-d', 'refs/heads/gurt/t1')
await clickTitle(page, 'refresh changes')
await waitPanel(page, { noChanges: true, badge: null })
console.log('OK   squash + branch deletion → "No changes", no badge')
check(
  git(betaDir, 'rev-parse', 'refs/gurt/integrated').trim() === betaHead,
  'refs/gurt/integrated recorded at HEAD in the clone'
)
await page.screenshot({ path: path.join(SHOT_DIR, 'c9-integrated.png') })

// 10) a new commit reopens the thread
fs.appendFileSync(path.join(betaDir, 'README.md'), 'after the merge\n')
git(betaDir, 'add', '-A')
git(betaDir, 'commit', '-m', 'gurt: reopen')
await clickTitle(page, 'refresh changes')
await waitPanel(page, { flat: true, badge: 'filled' })
s = await panelState(page)
check(
  s.groups[0].commits.some((c) => c.subject === 'gurt: reopen' && c.state === 'local'),
  'new commit reopens the thread as local'
)
await page.screenshot({ path: path.join(SHOT_DIR, 'c10-reopened.png') })

// 11) unreachable origin: fetch fails silently, last-known refs render, Commit works
fs.renameSync(bareBeta, `${bareBeta}-moved`)
fs.appendFileSync(path.join(betaDir, 'README.md'), 'offline edit\n')
await clickTitle(page, 'refresh changes')
await waitPanel(page, { flat: true, files0: 1 })
s = await panelState(page)
check(s.groups[0].error === null, 'unreachable origin renders no error UI')
check(s.groups[0].commits.length > 0, 'thread still rendered from last-known refs')
await commitVia(page, 'beta')
await waitPanel(page, { flat: true, files0: 0 })
s = await panelState(page)
check(s.groups[0].error === null, 'Commit works offline')
check(
  s.groups[0].commits.some((c) => c.subject === 'gurt: t1'),
  'offline commit landed in the thread'
)
await page.screenshot({ path: path.join(SHOT_DIR, 'c11-offline.png') })

await app.close()
console.log(failures ? `PHASE7 FAILED (${failures})` : 'PHASE7 DONE')
process.exit(failures ? 1 : 0)
