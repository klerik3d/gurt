// Turn contract end-to-end (docs/requirements-turn-contract.md §7.3). Real agent
// turn through the built app: a trivial-edit session must end with a stored
// change proposal. Offline: the origin is a local bare repo (smoke7 pattern), but
// this DOES need docker + a working claude secret (the agent has to run a turn
// and call `complete`). Set GURT_SMOKE_CLAUDE_TOKEN (or CLAUDE_CODE_OAUTH_TOKEN);
// without it the script SKIPs. The Kernel.prUrl title-param path is unit-covered
// by scripts/proposal-store.test.mjs.
//
//   SCRATCH=/tmp/gurt-smoke GURT_SMOKE_CLAUDE_TOKEN=... node scripts/smoke9.mjs
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TOKEN = process.env.GURT_SMOKE_CLAUDE_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN
if (!TOKEN) {
  console.log('SKIP smoke9: set GURT_SMOKE_CLAUDE_TOKEN (or CLAUDE_CODE_OAUTH_TOKEN) + run docker')
  process.exit(0)
}

const APP_DIR = '/Users/klerik3d/workspace/personal/gurt'
const SHOT_DIR = path.join(process.env.SCRATCH ?? '/tmp', 'shots')
// unique per run under /Users (Docker-shared, virtiofs cache); roots under /Users.
const GURT_ROOT = path.join(os.homedir(), `.gurt-smoke-${Date.now()}`)
const REPO_ROOT = path.join(os.homedir(), `.gurt-smoke-repos-${Date.now()}`)
console.log('GURT_ROOT:', GURT_ROOT)
fs.mkdirSync(SHOT_DIR, { recursive: true })
fs.mkdirSync(REPO_ROOT, { recursive: true })

const require = createRequire(path.join(APP_DIR, 'package.json'))
const { _electron } = require('playwright-core')

const env = { ...process.env, GURT_ROOT }
delete env.ELECTRON_RUN_AS_NODE

const EXE = path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')

let failures = 0
const check = (cond, msg) => {
  console.log(cond ? 'OK  ' : 'FAIL', msg)
  if (!cond) failures++
}

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, '-c', 'user.email=smoke@test', '-c', 'user.name=smoke', ...args], {
    encoding: 'utf8'
  })

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

// Seed the agent + its token before launch so claude-code can run a turn. The
// secret lives in the credential store; the agent maps to it by id.
fs.mkdirSync(GURT_ROOT, { recursive: true })
fs.writeFileSync(
  path.join(GURT_ROOT, 'credentials.json'),
  JSON.stringify({
    credentials: [
      { id: 'claude-tok', label: 'claude token', kind: 'agent-token', hosts: [], data: { secret: TOKEN } }
    ]
  })
)
fs.writeFileSync(
  path.join(GURT_ROOT, 'agents.json'),
  JSON.stringify({
    'claude-code': { kind: 'claude-code', label: 'claude code', credentialId: 'claude-tok' }
  })
)

const bare = makeBareRepo('alpha')

const app = await _electron.launch({ executablePath: EXE, args: [APP_DIR], env, timeout: 30000 })
app.process().stdout.on('data', (d) => process.stdout.write(`[main] ${d}`))
const page = await app.firstWindow()
page.on('dialog', (d) => d.accept().catch(() => {}))
await page.waitForSelector('.sidebar', { timeout: 15000 })

const clickTitle = (t) =>
  page.evaluate((x) => document.querySelector(`button[title="${x}"]`)?.click(), t)
const clickText = (scope, text) =>
  page.evaluate(
    ([sc, tx]) => [...document.querySelectorAll(`${sc} button`)].find((b) => b.textContent.trim() === tx)?.click(),
    [scope, text]
  )
const modalGone = () => page.waitForSelector('.modal', { state: 'detached' })

async function nameModal(title, value) {
  await clickTitle(title)
  await page.waitForSelector('.modal input')
  await page.fill('.modal input', value)
  await page.click('.modal .form > button')
  await modalGone()
}

// workspace + repo (local bare origin, inline devcontainer) + task
await nameModal('new workspace', 'personal')
await page.waitForSelector('.ws-node')
await clickTitle('repos')
await page.waitForSelector('.modal')
await clickText('.modal', 'Add repo')
await page.waitForSelector('.modal .repo-form input')
await page.fill('.modal .repo-form input[placeholder="name"]', 'alpha')
await page.fill('.modal .repo-form input[placeholder*="git url"]', bare)
await page.fill('.modal .repo-form textarea', '{ "image": "mcr.microsoft.com/devcontainers/base:ubuntu" }')
await clickText('.repo-form', 'Add')
await page.waitForFunction(() => [...document.querySelectorAll('.repo-row')].some((r) => r.textContent.includes('alpha')))
await page.click('.modal-header .icon-btn')
await modalGone()
await nameModal('new task', 't1')
await page.waitForSelector('.task-node')

// run a trivial-edit session — the agent edits, then the turn contract makes it
// call `complete` with a change proposal
await clickTitle('new session')
await page.waitForSelector('.modal textarea')
await page.selectOption('.modal label:has-text("repo") select', 'alpha')
await page.fill(
  '.modal textarea',
  'Append a line "hello from gurt" to README.md. Do not commit. Then finish the turn.'
)
await clickText('.modal .row-buttons', 'Run now')
await modalGone()
console.log('session started, provisioning + running the turn...')

// poll until the session goes idle (turn done). Up to 10 min for provisioning.
const startedAt = Date.now()
let mark = 'starting'
while (Date.now() - startedAt < 600_000) {
  await new Promise((r) => setTimeout(r, 3000))
  mark = await page.evaluate(() => {
    const m = document.querySelector('.session-node .session-mark')
    return m && [...m.classList].find((c) => c.startsWith('mark-'))?.slice(5)
  })
  if (mark === 'idle') break
  if (await page.evaluate(() => !!document.querySelector('.env-error')?.innerText)) break
}
console.log(`session mark: ${mark} (${Math.round((Date.now() - startedAt) / 1000)}s)`)
await page.screenshot({ path: path.join(SHOT_DIR, 't1-turn-done.png') })

// the proposal is persisted to sessions.json (after the 300ms persist debounce)
const sessionsFile = path.join(GURT_ROOT, 'personal', 't1', 'sessions.json')
let proposal
for (let i = 0; i < 40 && !proposal; i++) {
  await new Promise((r) => setTimeout(r, 500))
  const recs = JSON.parse(fs.readFileSync(sessionsFile, 'utf8').trim() || '[]')
  proposal = recs.map((r) => r.proposal).find(Boolean)
}
check(!!proposal, 'sessions.json holds a proposal after the turn')
check(proposal?.outcome === 'changes', `proposal outcome is "changes": ${proposal?.outcome}`)
check(!!proposal?.commit?.subject?.trim(), `commit subject is non-empty: "${proposal?.commit?.subject}"`)
check(typeof proposal?.at === 'string', 'proposal carries a receipt time (at)')

// the JSONL log has the `complete: changes — …` system entry
const sessionId = JSON.parse(fs.readFileSync(sessionsFile, 'utf8')).find((r) => r.proposal)?.info.id
const jsonl = path.join(GURT_ROOT, 'personal', 't1', 'sessions', `${sessionId}.jsonl`)
const records = fs
  .readFileSync(jsonl, 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l))
const completeEntry = records.find(
  (r) => r.type === 'entry' && r.entry.kind === 'system' && r.entry.text.startsWith('complete: changes')
)
check(!!completeEntry, `JSONL has the "complete: changes — …" entry: ${completeEntry?.entry.text}`)

// latestProposal reaches the renderer: the Commit modal prefills with the subject
await page.evaluate(() => document.querySelector('.task-node .node-label')?.click())
await page.waitForSelector('.changes-section')
await page.waitForFunction(() => {
  const b = [...document.querySelectorAll('.changes-actions button')].find((x) => x.textContent.trim() === 'Commit')
  return b && !b.disabled
}, { timeout: 15000, polling: 300 })
await page.evaluate(() =>
  [...document.querySelectorAll('.changes-actions button')].find((b) => b.textContent.trim() === 'Commit')?.click()
)
await page.waitForSelector('.modal .commit-message')
const prefill = await page.evaluate(() => document.querySelector('.modal .commit-message').value)
check(
  prefill.startsWith(proposal.commit.subject),
  `Commit modal prefills from latestProposal: "${prefill.slice(0, 60)}"`
)
await page.screenshot({ path: path.join(SHOT_DIR, 't1-commit-prefill.png') })

await app.close()
console.log(failures ? `SMOKE9 FAILED (${failures})` : 'SMOKE9 DONE')
process.exit(failures ? 1 : 0)
