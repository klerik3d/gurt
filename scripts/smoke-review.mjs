// Manual review through the real UI (docs/requirements-manual-review.md §7).
// Fully offline: a local bare origin, a clone written straight into the task
// dir (that's all provisioning does for host-git purposes), no Docker, no
// agent secrets. Drives the built app.
//
// Proves: the split view aligns before/after and folds a long unchanged run,
// which expands on click; word-level highlighting on a rewritten line; the
// lock toggle reaches review.json and blocks a session start with an inline
// error, and unlocking releases it; comments persist and survive a reload;
// Launch fix drafts a session whose start prompt carries the open comments.
//
//   npm run build && node scripts/smoke-review.mjs
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SCRATCH = process.env.SCRATCH ?? '/tmp/gurt-smoke-review'
const SHOT_DIR = path.join(SCRATCH, 'shots')
const GURT_ROOT = path.join(SCRATCH, 'gurt-root')
const REPO_ROOT = path.join(SCRATCH, 'repos')
for (const d of [GURT_ROOT, REPO_ROOT]) fs.rmSync(d, { recursive: true, force: true })
for (const d of [SHOT_DIR, GURT_ROOT, REPO_ROOT]) fs.mkdirSync(d, { recursive: true })

const WS = 'acme'
const TASK = 'review-task'
const REPO = 'alpha'

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, '-c', 'user.email=s@t', '-c', 'user.name=s', ...args], {
    encoding: 'utf8'
  })

// --- an origin, a clone, and an edit to review ------------------------------
const seed = path.join(REPO_ROOT, 'seed')
const bare = path.join(REPO_ROOT, 'alpha.git')
fs.mkdirSync(seed)
git(REPO_ROOT, 'init', '-q', '-b', 'main', seed)
// 40 lines so the run between the two edits is long enough to fold.
const base = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i}`).join('\n') + '\n'
fs.writeFileSync(path.join(seed, 'app.ts'), base)
git(seed, 'add', '-A')
git(seed, 'commit', '-qm', 'initial')
git(REPO_ROOT, 'clone', '-q', '--bare', seed, bare)

const clone = path.join(GURT_ROOT, WS, TASK, REPO)
fs.mkdirSync(path.dirname(clone), { recursive: true })
git(REPO_ROOT, 'clone', '-q', bare, clone)
git(clone, 'checkout', '-q', '-b', TASK)
// One rewritten line (word-level highlight), one inserted line (padding), and
// an untracked file — the three shapes the split view has to render.
fs.writeFileSync(
  path.join(clone, 'app.ts'),
  base.replace('const v5 = 5', 'const v5 = 500').replace('const v35 = 35', 'const extra = 1\nconst v35 = 35')
)
fs.writeFileSync(path.join(clone, 'fresh.ts'), 'export const fresh = true\n')

fs.writeFileSync(
  path.join(GURT_ROOT, WS, 'workspace.json'),
  JSON.stringify({
    repos: [{ name: REPO, url: bare }],
    envs: [{ name: 'dev', devcontainer: '{"image":"alpine"}', repo: REPO }]
  })
)
fs.writeFileSync(path.join(GURT_ROOT, WS, TASK, 'task.json'), JSON.stringify({}))
fs.writeFileSync(
  path.join(GURT_ROOT, 'agents.json'),
  JSON.stringify({ a1: { kind: 'claude-code', label: 'claude' } })
)

const require = createRequire(path.join(APP_DIR, 'package.json'))
const { _electron } = require('playwright-core')
const electronPath = require('electron')

const env = { ...process.env, GURT_ROOT, DISPLAY: process.env.DISPLAY ?? ':99' }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL

let failures = 0
const check = (cond, msg) => {
  console.log(cond ? 'OK  ' : 'FAIL', msg)
  if (!cond) failures++
}
const reviewJson = () => {
  const f = path.join(GURT_ROOT, WS, TASK, 'review.json')
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { locked: {}, comments: [] }
}
const sessionsJson = () => {
  const f = path.join(GURT_ROOT, WS, TASK, 'sessions.json')
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : []
}

/** Persists are debounced, so a UI assertion can land before the file does. */
async function sessionsUntil(pred, what) {
  for (let i = 0; i < 60; i++) {
    const records = sessionsJson()
    if (pred(records)) return records
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`sessions.json never satisfied: ${what}`)
}

const app = await _electron.launch({
  executablePath: electronPath,
  args: [APP_DIR, '--no-sandbox'],
  env,
  timeout: 30000
})
const page = await app.firstWindow()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
page.on('console', (m) => m.type() === 'error' && console.log('[console.error]', m.text()))

try {
  await page.waitForSelector('.sidebar', { timeout: 15000 })
  await page.click(`.sb-task-name:has-text("${TASK}")`)
  await page.waitForSelector('.changes-block', { timeout: 10000 })
  await page.screenshot({ path: path.join(SHOT_DIR, '01-changes.png') })

  // --- open the review surface --------------------------------------------
  await page.click('.changes-actions button:has-text("Review")')
  await page.waitForSelector('.review', { timeout: 10000 })
  const fileRows = page.locator('.review-file')
  await fileRows.first().waitFor({ timeout: 5000 })
  check((await fileRows.count()) === 2, 'the file list has the edited and the untracked file')

  // --- the split view ------------------------------------------------------
  await page.waitForSelector('.split-row', { timeout: 5000 })
  const foldBefore = await page.locator('.split-fold').count()
  check(foldBefore > 0, 'a long unchanged run is folded')
  const foldText = await page.locator('.split-fold').first().textContent()
  check(/\d+ unchanged lines/.test(foldText ?? ''), `the fold says what it hides: ${foldText?.trim()}`)

  // A rewritten line is paired onto one row, with the changed word highlighted.
  check((await page.locator('.split-word').count()) > 0, 'word-level highlighting on a rewrite')
  const rewrite = page.locator('.split-row.change', { has: page.locator('.split-word') }).first()
  check(
    (await rewrite.locator('.split-pane.del .split-code').textContent())?.includes('v5 = 5'),
    'the before-pane holds the old line'
  )
  check(
    (await rewrite.locator('.split-pane.add .split-code').textContent())?.includes('v5 = 500'),
    'the after-pane holds the new one, on the same row'
  )
  // An inserted line pads the other side rather than shifting it.
  check((await page.locator('.split-pane.pad').count()) > 0, 'an insertion pads the before-side')
  await page.screenshot({ path: path.join(SHOT_DIR, '02-split.png') })

  const rowsFolded = await page.locator('.split-row').count()
  await page.locator('.split-fold').first().click()
  await page.waitForFunction(
    (n) => document.querySelectorAll('.split-row').length > n,
    rowsFolded,
    { timeout: 5000 }
  )
  check(
    (await page.locator('.split-row').count()) > rowsFolded,
    'clicking a fold expands it in place'
  )
  console.log('split view OK')

  // --- the lock ------------------------------------------------------------
  // Commenting is gated on it, so the affordance is absent until it is taken.
  check((await page.locator('.split-add').count()) === 0, 'no comment affordance while unlocked')
  await page.click('.review-diff-head button:has-text("Lock for review")')
  await page.waitForSelector('.review-diff-head .tag-accent', { timeout: 5000 })
  check(!!reviewJson().locked[REPO], 'the lock reached review.json')
  check((await page.locator('.split-add').count()) > 0, 'locking reveals the comment affordance')
  // Hidden until its row is hovered — the gutter stays quiet while reading.
  check(
    !(await page.locator('.split-add').first().isVisible()),
    'the comment affordance is hover-only'
  )
  await page.screenshot({ path: path.join(SHOT_DIR, '03-locked.png') })

  // --- comments ------------------------------------------------------------
  // The `+` only shows on row hover, so the gutter stays quiet while reading.
  const target = page.locator('.split-row.change', { has: page.locator('.split-word') }).first()
  await target.hover()
  await target.locator('.split-pane.add .split-add').click()
  await page.waitForSelector('.split-composer textarea', { timeout: 5000 })
  await page.fill('.split-composer textarea', 'why 500 and not a named constant?')
  await page.click('.split-composer button:has-text("Comment")')
  await page.waitForSelector('.split-note', { timeout: 5000 })
  const stored = reviewJson().comments
  check(stored.length === 1, 'the comment persisted to review.json')
  check(stored[0]?.side === 'after' && stored[0]?.line > 0, 'it carries a real anchor')
  check(
    (await page.textContent('.review-foot-count'))?.includes('1 open comment'),
    'the footer counts it'
  )
  await page.screenshot({ path: path.join(SHOT_DIR, '04-comment.png') })

  // Resolving it takes it out of the open count without deleting it.
  await page.click('.split-note input[type="checkbox"]')
  await page.waitForSelector('.split-note.resolved', { timeout: 5000 })
  check(
    (await page.textContent('.review-foot-count'))?.includes('0 open comments'),
    'a resolved comment leaves the open count'
  )
  check(reviewJson().comments.length === 1, 'and is kept, not deleted')
  await page.click('.split-note input[type="checkbox"]')
  await page.waitForSelector('.split-note:not(.resolved)', { timeout: 5000 })
  console.log('comments OK')

  // --- the lock blocks an agent -------------------------------------------
  await page.click('.modal-head .icon-sq')
  await page.waitForSelector('.review', { state: 'detached', timeout: 5000 })
  check((await page.locator('.changes-group-head .tag-accent, .tp-sec-head .tag-accent').count()) > 0,
    'the panel shows the repo as locked')

  await page.hover(`.sb-task:has(.sb-task-name:text-is("${TASK}"))`)
  await page.click(`.sb-task:has(.sb-task-name:text-is("${TASK}")) button[title="new session"]`)
  await page.waitForSelector('.modal:has-text("New session")', { timeout: 5000 })
  await page.fill('textarea[placeholder="What should the agent do?"]', 'do the fix')
  await page.click('.modal .btn-primary:has-text("Run now")')
  // The gate rejects the start, so the session falls back to a draft carrying
  // the reason — the same path a repo conflict takes.
  await page.waitForSelector('text=locked for review', { timeout: 15000 })
  check(true, 'a Run-now start is refused with "locked for review"')
  const blocked = (await sessionsUntil((r) => r.length === 1, 'the blocked session')).at(-1).info
  check(blocked.state === 'draft', 'the blocked session stayed a draft')
  await page.screenshot({ path: path.join(SHOT_DIR, '05-blocked.png') })

  // --- launch fix ----------------------------------------------------------
  await page.click(`.sb-task-name:has-text("${TASK}")`)
  await page.waitForSelector('.changes-block', { timeout: 10000 })
  await page.click('.changes-actions button:has-text("Review")')
  await page.waitForSelector('.split-note', { timeout: 10000 })
  const before = sessionsJson().length
  await page.fill('.review-prompt', 'keep the change minimal')
  await page.click('.review-foot button:has-text("Launch fix")')
  await page.waitForSelector('.review-ok', { timeout: 10000 })

  const drafted = await sessionsUntil((r) => r.length === before + 1, 'the drafted fix session')
  check(drafted.length === before + 1, 'a session was drafted')
  const fix = drafted[drafted.length - 1].info
  check(fix.state === 'draft', 'it is a draft — the user approves it')
  check(fix.role === 'executor' && fix.repos[0] === REPO, 'an executor on the reviewed repo')
  check(
    fix.startPrompt.includes('why 500 and not a named constant?'),
    'the open comment rode into the start prompt'
  )
  check(/app\.ts:\d+/.test(fix.startPrompt), 'anchored at file:line')
  check(fix.startPrompt.trimEnd().endsWith('keep the change minimal'), 'the free text comes last')

  // Launching changes neither the lock nor the comments.
  check(!!reviewJson().locked[REPO], 'launching did not unlock')
  check(reviewJson().comments.every((c) => !c.resolved), 'launching did not resolve anything')
  await page.screenshot({ path: path.join(SHOT_DIR, '06-launched.png') })
  console.log('launch fix OK')

  // --- unlock releases the clone ------------------------------------------
  await page.click('.review-diff-head button:has-text("Unlock")')
  await page.waitForSelector('.review-diff-head .tag:not(.tag-accent)', { timeout: 5000 })
  check(!reviewJson().locked[REPO], 'unlocking cleared it on disk')
  console.log('unlock OK')
} catch (e) {
  failures++
  console.log('FAIL', e.message)
  await page.screenshot({ path: path.join(SHOT_DIR, 'error.png') }).catch(() => {})
} finally {
  await app.close()
}

console.log(failures ? `smoke-review: ${failures} FAILURES` : 'smoke-review: DONE')
assert.equal(failures, 0)
