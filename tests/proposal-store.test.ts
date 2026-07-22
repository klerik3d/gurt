// Pure-node test for the host-side consumption of change proposals (§5 of
// docs/requirements-turn-contract.md): a persisted proposal survives restore,
// `latestProposal` returns the newest per env, and `Kernel.prUrl` appends the
// proposed PR title/body as url-encoded query params. No docker, no agent — it
// seeds sessions.json + a github-origin clone and drives the real kernel.
import { afterAll, it } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

// GURT_ROOT must be set before the store module loads (read at import time).
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-proposal-'))
process.env.GURT_ROOT = GURT_ROOT
const { createKernel } = await import('../src/main/kernel')

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    encoding: 'utf8'
  })

const ws = 'p'
const task = 't'
const repo = 'alpha'

afterAll(() => {
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

// workspace + task metadata so buildTree/restore see the session
fs.mkdirSync(path.join(GURT_ROOT, ws, task), { recursive: true })
fs.writeFileSync(path.join(GURT_ROOT, ws, 'workspace.json'), JSON.stringify({ repos: [] }))
fs.writeFileSync(path.join(GURT_ROOT, ws, task, 'task.json'), JSON.stringify({ envs: [] }))

// a clone with a github-style origin so changes.prUrl yields a compare URL
const clone = path.join(GURT_ROOT, ws, task, repo)
fs.mkdirSync(clone, { recursive: true })
git(clone, 'init', '-q')
git(clone, 'remote', 'add', 'origin', 'https://github.com/octo/alpha.git')
git(clone, 'checkout', '-q', '-b', `gurt/${task}`)

const mkInfo = (id: string): any => ({
  id,
  envRepo: repo,
  task,
  workspace: ws,
  title: id,
  agent: 'claude-code',
  state: 'started',
  startPrompt: 'hi'
})

// two sessions of the same env; the newer `at` must win. The older one also
// carries a PR so prUrl has a title/body to encode.
const older = {
  version: 1,
  outcome: 'changes',
  commit: { subject: 'older change', body: 'older body' },
  pr: { title: 'Old PR title', body: 'body with spaces & symbols' },
  at: '2026-07-17T10:00:00.000Z'
}
const newer = {
  version: 1,
  outcome: 'changes',
  commit: { subject: 'newer change' },
  at: '2026-07-17T12:00:00.000Z'
}
fs.writeFileSync(
  path.join(GURT_ROOT, ws, task, 'sessions.json'),
  JSON.stringify([
    { info: mkInfo('sess-old'), acpSessionId: 'acp-old', proposal: older },
    { info: mkInfo('sess-new'), acpSessionId: 'acp-new', proposal: newer }
  ])
)

const kernel = createKernel()

/** restore is fire-and-forget — poll until the session shows up. */
async function awaitSnapshot(k: ReturnType<typeof createKernel>, id: string) {
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 50))
    const snap = k.sessions.snapshot(id)
    if (snap) return snap
  }
  return undefined
}

it('proposal survives restore, exposed in the snapshot', async () => {
  const snap = await awaitSnapshot(kernel, 'sess-new')
  assert.ok(snap, 'restored session must be visible')
  assert.deepEqual(snap.proposal, newer, 'snapshot carries the restored proposal')
})

it('latestProposal: newest `at` among the env sessions', () => {
  const latest = kernel.sessions.latestProposal(ws, task, repo)
  assert.deepEqual(latest, newer, 'latestProposal returns the newest proposal')
  assert.equal(
    kernel.sessions.latestProposal(ws, task, 'nonexistent'),
    undefined,
    'latestProposal is undefined for an env with no proposals'
  )
})

it('prUrl: no title param when the latest proposal has no PR', async () => {
  const urlNoPr = await kernel.prUrl(ws, task, repo)
  assert.match(urlNoPr, /github\.com\/octo\/alpha\/compare\/main\.\.\.gurt\/t/, 'compare URL shape')
  assert.ok(!urlNoPr.includes('title='), 'no title param when the latest proposal has no PR')
})

it('prUrl encodes the newest proposal PR title/body', async () => {
  // make the PR-bearing proposal the newest, re-check through a fresh kernel
  fs.writeFileSync(
    path.join(GURT_ROOT, ws, task, 'sessions.json'),
    JSON.stringify([
      {
        info: mkInfo('sess-old'),
        acpSessionId: 'acp-old',
        proposal: { ...older, at: '2026-07-17T14:00:00.000Z' }
      }
    ])
  )
  const kernel2 = createKernel()
  const snap2 = await awaitSnapshot(kernel2, 'sess-old')
  assert.ok(snap2, 'second kernel restored the PR-bearing session')
  const urlPr = await kernel2.prUrl(ws, task, repo)
  assert.ok(
    urlPr.includes(`title=${encodeURIComponent('Old PR title')}`),
    `prUrl encodes the PR title: ${urlPr}`
  )
  assert.ok(
    urlPr.includes(`body=${encodeURIComponent('body with spaces & symbols')}`),
    `prUrl encodes the PR body: ${urlPr}`
  )
})
