// The review loop's Review block as rules (docs/requirements-review-loop.md §3;
// acceptance §12 item 12's non-UI half): which agents are offered as reviewer,
// the cross-kind default and its same-kind fallback, what makes a block unable
// to start, the ladder per repo kind, what a new block is prefilled with, the
// status line's words — and, on a headless kernel, the same rules at the seams
// the Config tab reaches (`editDraft`, duplicate, the start gate, Settings →
// Repos' normalisation).
//
//   node --test scripts/review-block.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { loopHarness } from './lib/loop-harness.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const S = (rel) => JSON.stringify(path.join(ROOT, rel))
const outfile = path.join(os.tmpdir(), `gurt-rvblock-pure-${process.pid}.mjs`)

await bundle({
  stdin: {
    contents:
      `export * from ${S('src/shared/reviewBlock.ts')}\n` +
      `export * from ${S('src/shared/reviewStatus.ts')}\n` +
      `export { agentDef, AGENT_MANIFESTS } from ${S('src/shared/agents.ts')}\n`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})
const B = await import(pathToFileURL(outfile).href)

// A kernel on a workspace with a forge repo that carries a check and review
// defaults, a local repo and one without a check; agents of three kinds and a
// second claude-code instance.
const h = await loopHarness('review-block', {
  workspace: {
    repos: [
      { name: 'alpha', url: 'https://github.com/o/alpha.git', check: 'npm test', review: { enabled: true, maxRounds: 3, whenClean: 'push' } },
      { name: 'loc', url: '/tmp/none', local: true },
      { name: 'beta', url: 'https://github.com/o/beta.git' }
    ],
    envs: [{ name: 'dev', image: 'x', repo: 'alpha' }],
    deniedAgents: ['a6']
  },
  agents: {
    a1: { kind: 'claude-code', label: 'claude', credentialId: 'c1' },
    a2: { kind: 'codex', label: 'codex', credentialId: 'c2' },
    a3: { kind: 'pi', label: 'pi', credentialId: 'c1' },
    a4: { kind: 'claude-code', label: 'claude 2', credentialId: 'c1' },
    a5: { kind: 'gemini', label: 'gemini' },
    a6: { kind: 'opencode', label: 'opencode', credentialId: 'c1' }
  },
  credentials: [
    { id: 'c1', label: 'k', kind: 'agent-token', hosts: [], data: { secret: 'sk-aaaaaaaaaaaaaaaaaaaa' } },
    { id: 'c2', label: 'k2', kind: 'agent-token', hosts: [], data: { secret: 'sk-bbbbbbbbbbbbbbbbbbbb' } }
  ]
})
after(() => {
  h.cleanup()
  fs.rmSync(outfile, { force: true })
})

const { kernel, ref } = h
const agentsFile = JSON.parse(fs.readFileSync(path.join(h.GURT_ROOT, 'agents.json'), 'utf8'))
/** @param {string} id @param {string} [kind] @param {Record<string, string>} [data] */
const cred = (id, kind = 'agent-token', data = { secret: 'x' }) => ({ id, label: id, kind, hosts: [], data })
const claudeCfg = B.agentDef('claude-code').seedConfig
const ctx = (over = {}) => ({
  agents: agentsFile,
  deniedAgents: [],
  configs: { a1: claudeCfg, a4: claudeCfg },
  ...over
})
const block = (over = {}) => ({ agent: 'a2', maxRounds: 2, whenClean: 'notify', draftPr: true, ...over })
const executor = (over = {}) => ({ role: 'executor', agent: 'a1', ...over })

// --- the manifest field -----------------------------------------------------------

test('pi alone is marked as not receiving gurt’s MCP server', () => {
  const without = B.AGENT_MANIFESTS.filter((m) => m.acpMcp === false).map((m) => m.id)
  assert.deepEqual(without, ['pi'])
  assert.equal(B.agentReceivesMcp('pi'), false)
  assert.equal(B.agentReceivesMcp('claude-code'), true)
  assert.equal(B.agentReceivesMcp('no-such-kind'), false, 'a kind no plugin provides cannot run')
  assert.equal(B.agentReceivesMcp(undefined), false)
})

test('the reviewer picker lists agents in registry order, without pi and without the denied', () => {
  assert.deepEqual(B.reviewerCandidates(agentsFile, []), ['a1', 'a2', 'a4', 'a5', 'a6'])
  assert.deepEqual(B.reviewerCandidates(agentsFile, ['a6', 'a2']), ['a1', 'a4', 'a5'])
})

// --- the default reviewer ----------------------------------------------------------

const pick = (over = {}) =>
  B.defaultReviewer({
    executorAgent: 'a1',
    agents: agentsFile,
    deniedAgents: [],
    credentials: [cred('c1'), cred('c2')],
    ...over
  })

test('default reviewer: a different kind with a usable credential, in picker order', () => {
  assert.equal(pick(), 'a2', 'codex is the first other-kind agent with a linked credential (gemini has none)')
  assert.equal(pick({ executorAgent: 'a2' }), 'a1')
})

test('default reviewer: a credential that does not resolve, or an oauth one signed out, does not count', () => {
  // c2 is gone; gemini has no link; opencode's c1 is another kind and usable.
  assert.equal(pick({ credentials: [cred('c1')] }), 'a6')
  const signedOut = cred('c2', 'oauth', { access: 'a', refresh: '' })
  assert.equal(pick({ credentials: [cred('c1'), signedOut], deniedAgents: ['a6'] }), 'a4', 'falls back to the same kind')
  const signedIn = cred('c2', 'oauth', { access: 'a', refresh: 'r' })
  assert.equal(pick({ credentials: [cred('c1'), signedIn] }), 'a2')
  const marked = cred('c2', 'oauth', { access: 'a', refresh: 'r', signedOut: '1' })
  assert.equal(pick({ credentials: [cred('c1'), marked], deniedAgents: ['a6'] }), 'a4')
  assert.equal(pick({ credentials: [cred('c1', 'mcp-token'), cred('c2')], deniedAgents: ['a6'] }), 'a2', 'only an agent credential is one')
})

test('default reviewer: the same kind when no other kind qualifies — another instance before the executor’s own', () => {
  const none = { credentials: [], deniedAgents: ['a2', 'a5', 'a6'] }
  assert.equal(pick(none), 'a4', 'claude 2, not the executor’s own claude')
  const lone = { credentials: [], agents: { a1: agentsFile.a1 } }
  assert.equal(pick(lone), 'a1', 'the executor’s own, as the last resort')
  assert.equal(pick({ ...lone, agents: {} }), undefined, 'nothing at all')
})

test('default reviewer: pi is never one, and a pi executor has no same-kind fallback', () => {
  const onlyPi = { agents: { a3: agentsFile.a3 }, executorAgent: 'a3' }
  assert.equal(pick(onlyPi), undefined)
  assert.equal(pick({ executorAgent: 'a3', deniedAgents: ['a2', 'a5', 'a6'], credentials: [cred('c1')] }), 'a1')
})

test('default reviewer: with no executor agent yet, the first usable candidate', () => {
  assert.equal(pick({ executorAgent: undefined }), 'a1')
})

// --- validation ---------------------------------------------------------------------

test('a valid block has no problem', () => assert.equal(B.validateReviewBlock(block(), executor(), ctx()), null))

test('a pi executor is refused; pi is not accepted as the reviewer', () => {
  assert.match(B.validateReviewBlock(block(), executor({ agent: 'a3' }), ctx()), /pi does not receive gurt’s tools/)
  assert.match(B.validateReviewBlock(block({ agent: 'a3' }), executor(), ctx()), /pi does not receive gurt’s tools, so it cannot be the reviewer/)
})

test('the reviewer must exist, be allowed in the workspace and be named', () => {
  assert.match(B.validateReviewBlock(block({ agent: '' }), executor(), ctx()), /pick a reviewer/)
  assert.match(B.validateReviewBlock(block({ agent: 'zz' }), executor(), ctx()), /no longer exists/)
  assert.match(B.validateReviewBlock(block({ agent: 'a2' }), executor(), ctx({ deniedAgents: ['a2'] })), /denied in this workspace/)
})

test('only an executor session runs a loop, and it needs its own agent', () => {
  assert.match(B.validateReviewBlock(block(), executor({ role: 'researcher' }), ctx()), /executor sessions/)
  assert.match(B.validateReviewBlock(block(), executor({ agent: undefined }), ctx()), /own agent/)
})

test('the reviewer differs from the executor in agent instance or in model', () => {
  // The same instance on the same (default) model: refused until another model is picked.
  assert.match(B.validateReviewBlock(block({ agent: 'a1' }), executor(), ctx()), /same agent and model/)
  assert.equal(B.validateReviewBlock(block({ agent: 'a1', configValues: { model: 'sonnet' } }), executor(), ctx()), null)
  // The executor's pick counts as well: both on sonnet is still the same model.
  const onSonnet = executor({ configValues: { model: 'sonnet' } })
  assert.match(B.validateReviewBlock(block({ agent: 'a1', configValues: { model: 'sonnet' } }), onSonnet, ctx()), /same agent and model/)
  assert.equal(B.validateReviewBlock(block({ agent: 'a1', configValues: { model: 'opus' } }), onSonnet, ctx()), null)
  // Another instance is enough, even of the same kind and model.
  assert.equal(B.validateReviewBlock(block({ agent: 'a4' }), executor(), ctx()), null)
})

test('the same instance with no model to tell apart is refused, not guessed', () => {
  assert.match(B.validateReviewBlock(block({ agent: 'a2' }), executor({ agent: 'a2' }), ctx()), /reports no model/)
  const reported = { a2: { configOptions: [{ id: 'm', name: 'Model', category: 'model', type: 'select', currentValue: 'x', options: [{ value: 'x', name: 'X' }, { value: 'y', name: 'Y' }] }], commands: [] } }
  assert.equal(B.validateReviewBlock(block({ agent: 'a2', configValues: { m: 'y' } }), executor({ agent: 'a2' }), ctx({ configs: reported })), null)
})

test('rounds are 1–5 and the rung is on the ladder', () => {
  for (const n of [0, 6, 1.5, NaN]) assert.match(B.validateReviewBlock(block({ maxRounds: n }), executor(), ctx()), /rounds must be 1–5/)
  for (const n of [1, 5]) assert.equal(B.validateReviewBlock(block({ maxRounds: n }), executor(), ctx()), null)
  const local = B.ladderOfRepos(['loc'], [{ name: 'loc', url: 'x', local: true }])
  assert.match(B.validateReviewBlock(block({ whenClean: 'pr' }), executor(), ctx(), local), /not available for these repositories/)
  assert.equal(B.validateReviewBlock(block({ whenClean: 'merge' }), executor(), ctx(), local), null)
  assert.match(B.validateReviewBlock(block({ whenClean: 'bogus' }), executor(), ctx()), /unknown/)
})

test('repo defaults are validated without an executor: only the reviewer’s own conditions', () => {
  assert.equal(B.validateReviewBlock(block({ agent: 'a1' }), undefined, ctx()), null, 'same-agent is a draft-time question')
  assert.match(B.validateReviewBlock(block({ agent: 'a3' }), undefined, ctx()), /cannot be the reviewer/)
})

// --- the ladder -----------------------------------------------------------------------

test('the ladder follows the repos’ kinds', () => {
  const repos = [{ name: 'f', url: 'u' }, { name: 'l', url: 'p', local: true }, { name: 'g', url: 'v' }]
  assert.deepEqual(B.ladderOfRepos(['f', 'g'], repos), ['notify', 'commit', 'push', 'pr'])
  assert.deepEqual(B.ladderOfRepos(['l'], repos), ['notify', 'commit', 'merge'])
  assert.deepEqual(B.ladderOfRepos(['f', 'l'], repos), ['notify', 'commit'])
  assert.deepEqual(B.ladderOfRepos([], repos), ['notify'])
  assert.deepEqual(B.ladderOfRepos(['ghost'], repos), ['notify'], 'an unknown name is skipped')
  assert.equal(B.clampRung('push', ['notify', 'commit', 'merge']), 'commit')
  assert.equal(B.clampRung('pr', ['notify']), 'notify')
  assert.equal(B.clampRung('commit', ['notify', 'commit']), 'commit')
})

// --- prefill ------------------------------------------------------------------------------

test('a new block is prefilled from the anchor’s defaults, then the global ones', () => {
  const ladder = ['notify', 'commit', 'push', 'pr']
  assert.deepEqual(B.seedReviewBlock(undefined, 'a2', ladder), { agent: 'a2', maxRounds: 2, whenClean: 'notify', draftPr: true })
  const defaults = { enabled: true, agent: 'a4', configValues: { model: 'haiku' }, maxRounds: 4, whenClean: 'pr', draftPr: false }
  assert.deepEqual(B.seedReviewBlock(defaults, 'a2', ladder), { agent: 'a4', configValues: { model: 'haiku' }, maxRounds: 4, whenClean: 'pr', draftPr: false })
  // The reviewer comes from the fallback: its picks are not the named reviewer’s.
  assert.deepEqual(B.seedReviewBlock({ ...defaults, agent: undefined }, 'a2', ladder).configValues, undefined)
  // A rung the draft’s repos cannot deliver steps down.
  assert.equal(B.seedReviewBlock(defaults, 'a2', ['notify', 'commit', 'merge']).whenClean, 'commit')
  // No reviewer to be found: empty, so the block says "pick a reviewer".
  assert.equal(B.seedReviewBlock(undefined, undefined, ladder).agent, '')
  assert.equal(B.reviewEnabledByDefault({ enabled: true }), true)
  assert.equal(B.reviewEnabledByDefault({ maxRounds: 2 }), false)
  assert.equal(B.reviewEnabledByDefault(undefined), false)
})

test('the prefill is owed from the draft alone: no block, not switched off, an anchor whose defaults say review', () => {
  const on = { name: 'alpha', url: 'u', review: { enabled: true } }
  const due = (over) =>
    B.reviewSeedDue({ executor: true, review: undefined, reviewOff: false, anchor: on, seeded: undefined, ...over })
  assert.equal(due({}), true, 'a draft that never saw the Config tab still owes it')
  assert.equal(due({ reviewOff: true }), false, 'off is a choice the default does not undo')
  assert.equal(due({ executor: false }), false)
  assert.equal(due({ anchor: undefined }), false, 'no write repo yet')
  assert.equal(due({ anchor: { name: 'beta', url: 'u' } }), false, 'defaults that are off')
  assert.equal(due({ anchor: { name: 'beta', url: 'u', review: { maxRounds: 3 } } }), false, 'defaults without `enabled`')
  // A block that is there is the user’s unless it is still what an earlier anchor prefilled.
  const mine = block({ agent: 'a4', maxRounds: 3, configValues: { model: 'haiku', effort: 'low' } })
  assert.equal(due({ review: mine }), false, 'a block nobody here prefilled')
  assert.equal(due({ review: mine, seeded: { anchor: 'alpha', block: mine } }), false, 'the same anchor again')
  assert.equal(due({ review: mine, seeded: { anchor: 'older', block: mine } }), true, 'untouched since another anchor: swap')
  const reordered = { ...mine, configValues: { effort: 'low', model: 'haiku' } }
  assert.equal(due({ review: reordered, seeded: { anchor: 'older', block: mine } }), true, 'key order is not an edit')
  for (const edit of [{ maxRounds: 4 }, { whenClean: 'commit' }, { draftPr: false }, { agent: 'a1' }, { configValues: { model: 'sonnet', effort: 'low' } }, { configValues: undefined }])
    assert.equal(due({ review: { ...mine, ...edit }, seeded: { anchor: 'older', block: mine } }), false, `edited: ${JSON.stringify(edit)}`)
  assert.equal(due({ review: mine, seeded: { anchor: 'older', block: mine }, reviewOff: true }), false)
  assert.equal(due({ review: mine, seeded: { anchor: 'older', block: mine }, anchor: { name: 'beta', url: 'u' } }), false, 'a new anchor with review off leaves the block')
})

test('the rounds a picker offers are every integer the block allows', () => {
  assert.deepEqual([...B.REVIEW_ROUNDS], [1, 2, 3, 4, 5])
})

test('an untrusted block is shaped, never thrown on', () => {
  assert.deepEqual(B.sanitizeReviewBlock(undefined), { agent: '', maxRounds: 2, whenClean: 'notify', draftPr: true })
  assert.deepEqual(
    B.sanitizeReviewBlock({ agent: 'a1', maxRounds: 99, whenClean: 'yolo', draftPr: 'yes', configValues: { m: 'x', n: 3, ok: true } }),
    { agent: 'a1', configValues: { m: 'x', ok: true }, maxRounds: 5, whenClean: 'notify', draftPr: true }
  )
  assert.equal(B.sanitizeReviewBlock({ maxRounds: -3 }).maxRounds, 1)
})

// --- the status line -------------------------------------------------------------------------

const finding = (id, severity = 'major') => ({ id, file: 'alpha/a.ts', line: 3, severity, claim: `claim ${id}` })
const loop = (over = {}) => ({
  version: 1, executor: 'x', config: { agent: 'a2', maxRounds: 2, whenClean: 'notify', draftPr: true },
  phase: 'dormant', round: 0, redStreak: 0, repaired: false, base: {}, open: [], openAnswered: false, checks: [],
  rounds: [], fingerprints: {}, holdExtensionMs: 0, consumed: {}, intents: [], nextIntent: 1, delivered: [],
  turns: { executor: 0, reviewer: 0 }, ...over
})

test('the status line names the phase, the round and the findings; Stop loop only while live and not delivering', () => {
  const armed = B.loopLine(loop())
  assert.equal(armed.live, false)
  assert.equal(armed.stoppable, false)
  const impl = B.loopLine(loop({ deadline: '2026-01-01T00:00:00Z' }))
  assert.deepEqual([impl.live, impl.stoppable, impl.headline], [true, true, 'implementing · before round 1 of 2'])
  assert.equal(B.loopLine(loop({ phase: 'reviewing', round: 1, deadline: 'd' })).headline, 'reviewing · round 1 of 2')
  const fixing = B.loopLine(loop({ phase: 'fixing', round: 1, deadline: 'd', open: [finding('F1'), finding('F2', 'blocker')] }))
  assert.equal(fixing.headline, 'fixing · after round 1 of 2 · 2 findings')
  assert.deepEqual(fixing.findings.map((f) => f.ref), ['R1.F1', 'R1.F2'])
  const delivering = B.loopLine(loop({ phase: 'delivering', round: 1, deadline: 'd', delivered: [{ repo: 'alpha', step: 'commit', ref: 'abc123' }] }))
  assert.equal(delivering.stoppable, false, 'delivery runs to its end (§5.6)')
  assert.match(delivering.detail, /committed abc123 in alpha/)
})

test('an end shows its reason, what was delivered and what is unresolved', () => {
  const ended = (end, over = {}) => B.loopLine(loop({ phase: 'ended', round: 2, end, ...over }))
  const ready = ended({ outcome: 'ready', delivered: [{ repo: 'alpha', step: 'push', ref: 'gurt/t' }], notes: [finding('N1', 'nit')] })
  assert.deepEqual([ready.live, ready.stoppable, ready.tone, ready.headline], [false, false, 'green', 'clean after 2 rounds'])
  assert.match(ready.detail, /pushed gurt\/t in alpha · 1 minor note/)
  const exhausted = ended({ outcome: 'exhausted', open: [finding('F1', 'blocker')] })
  assert.equal(exhausted.headline, 'ended — 2 rounds used, 1 finding unresolved')
  assert.deepEqual(exhausted.findings.map((f) => f.ref), ['R2.F1'])
  const stuck = ended({ outcome: 'needs-you', reason: 'no-progress', open: [finding('F3')], delivered: [] })
  assert.equal(stuck.headline, 'ended — the executor’s fix changed nothing')
  assert.equal(stuck.tone, 'yellow')
  assert.equal(ended({ outcome: 'needs-you', reason: 'taken-over', open: [], delivered: [] }).tone, 'faint')
  const failed = ended({ outcome: 'failed', error: 'boom', delivered: [] })
  assert.deepEqual([failed.tone, failed.detail], ['red', 'boom'])
  for (const reason of Object.keys(B.END_REASON_TEXT)) assert.ok(B.END_REASON_TEXT[reason], reason)
  assert.equal(Object.keys(B.END_REASON_TEXT).length, 15)
})

// --- the seams the Config tab reaches (headless kernel) ---------------------------------------

/** A fresh executor draft on `alpha` (write), agent a1. */
function draft(over = {}) {
  const repos = over.repos ?? ['alpha']
  const info = kernel.sessions.createSession(
    ref, repos, over.agent ?? 'a1', 'implement', 'draft', [], true, over.configValues ?? {}, over.role ?? 'executor',
    undefined, undefined, Object.fromEntries(repos.map((r) => [r, 'write']))
  )
  return info.id
}
const info = (id) => kernel.sessions.snapshot(id).info

test('editDraft sets, clamps and clears the Review block; off is remembered as a choice', async () => {
  const id = draft()
  await kernel.editDraft(id, { review: { agent: 'a2', maxRounds: 99, whenClean: 'push', draftPr: false } })
  assert.deepEqual(info(id).review, { agent: 'a2', maxRounds: 5, whenClean: 'push', draftPr: false }, 'rounds clamped to 5')
  assert.equal(info(id).reviewOff, undefined)
  await kernel.editDraft(id, { review: null })
  assert.equal(info(id).review, undefined)
  assert.equal(info(id).reviewOff, true, 'the anchor’s enabled default must not switch it back on')
  await kernel.editDraft(id, { review: { agent: 'a4', maxRounds: 1, whenClean: 'commit', draftPr: true, configValues: { model: 'haiku' } } })
  assert.equal(info(id).reviewOff, undefined)
  assert.deepEqual(info(id).review.configValues, { model: 'haiku' })
})

test('a Review block is refused outside an executor draft, and a role change drops it', async () => {
  const researcher = draft({ role: 'researcher' })
  await assert.rejects(kernel.editDraft(researcher, { review: block() }), /executor sessions/)
  assert.equal(info(researcher).review, undefined)
  const id = draft()
  await kernel.editDraft(id, { review: block() })
  await assert.rejects(kernel.editDraft(id, { role: 'researcher', review: block() }), /executor sessions/)
  await kernel.editDraft(id, { role: 'researcher' })
  assert.equal(info(id).review, undefined, 'a draft that stops being an executor carries no loop')
})

test('duplicate carries the block as a copy of its own, and a block switched off stays off', async () => {
  const id = draft()
  await kernel.editDraft(id, { review: block({ configValues: { model: 'haiku' } }) })
  const copy = kernel.sessions.duplicateSession(id)
  assert.deepEqual(copy.review, info(id).review)
  assert.notEqual(copy.review, info(id).review)
  assert.notEqual(copy.review.configValues, info(id).review.configValues)
  await kernel.editDraft(id, { review: null })
  assert.equal(kernel.sessions.duplicateSession(id).reviewOff, true)
})

test('the start gate refuses a block that cannot start — the Run button’s own reasons', async () => {
  const id = draft()
  await kernel.assertReviewBlock(id) // no block: nothing to say
  await kernel.editDraft(id, { review: block({ agent: 'a1' }) })
  await assert.rejects(kernel.assertReviewBlock(id), /same agent and model/)
  await kernel.editDraft(id, { review: block({ agent: 'a1', configValues: { model: 'sonnet' } }) })
  await kernel.assertReviewBlock(id)
  await kernel.editDraft(id, { review: block({ agent: 'a3' }) })
  await assert.rejects(kernel.assertReviewBlock(id), /cannot be the reviewer/)
  await kernel.editDraft(id, { review: block({ agent: 'a2', whenClean: 'pr' }) })
  await kernel.assertReviewBlock(id)
  const local = draft({ repos: ['loc'] })
  await kernel.editDraft(local, { review: block({ whenClean: 'pr' }) })
  await assert.rejects(kernel.assertReviewBlock(local), /not available for these repositories/)
  await kernel.editDraft(local, { review: block({ whenClean: 'merge' }) })
  await kernel.assertReviewBlock(local)
  const piExec = draft({ agent: 'a3' })
  await kernel.editDraft(piExec, { review: block() })
  await assert.rejects(kernel.assertReviewBlock(piExec), /pi does not receive gurt’s tools/)
})

test('Settings → Repos: the check is trimmed and the review defaults normalised and validated', async () => {
  const repo = { name: 'r', url: 'u' }
  assert.deepEqual(await kernel.checkRepoReview('w', { ...repo, check: '  npm test  ' }), { ...repo, check: 'npm test' })
  assert.deepEqual(await kernel.checkRepoReview('w', { ...repo, check: '   ' }), repo, 'empty = no check')
  assert.deepEqual(
    await kernel.checkRepoReview('w', { ...repo, review: { enabled: true, agent: '', maxRounds: 9, whenClean: 'pr' } }),
    { ...repo, review: { enabled: true, maxRounds: 5, whenClean: 'pr' } },
    'an empty reviewer means "automatic" and is not stored'
  )
  await assert.rejects(kernel.checkRepoReview('w', { ...repo, review: { agent: 'a3' } }), /cannot be the reviewer/)
  await assert.rejects(kernel.checkRepoReview('w', { ...repo, review: { agent: 'a6' } }), /denied in this workspace/)
  await assert.rejects(kernel.checkRepoReview('w', { ...repo, review: { agent: 'nope' } }), /no longer exists/)
})

test('the store keeps a repo’s check and review across a read', async () => {
  const ws = await h.store.getWorkspace('w')
  const alpha = ws.repos.find((r) => r.name === 'alpha')
  assert.equal(alpha.check, 'npm test')
  assert.deepEqual(alpha.review, { enabled: true, maxRounds: 3, whenClean: 'push' })
})

test('the block is prefilled from the anchor repo in the UI’s own terms (defaults over the fallback)', async () => {
  const ws = await h.store.getWorkspace('w')
  const alpha = ws.repos.find((r) => r.name === 'alpha')
  const seeded = B.seedReviewBlock(alpha.review, pick(), B.ladderOfRepos(['alpha'], ws.repos))
  assert.deepEqual(seeded, { agent: 'a2', maxRounds: 3, whenClean: 'push', draftPr: true })
})

test('ended cleanup failure is visible in the status line', () => {
  const line = B.loopLine(loop({ phase: 'ended', end: {
    outcome: 'failed', error: 'check stop failed', delivered: [], cleanupPending: 'daemon unavailable'
  } }))
  assert.equal(line.headline, 'ended — cleanup pending')
  assert.equal(line.detail, 'daemon unavailable')
  assert.equal(line.tone, 'red')
})
