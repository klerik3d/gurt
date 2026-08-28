// Which environment `create_session` drafts into (docs/requirements-session-roles.md
// §3). The rule under test: the env follows the **repo being drafted for**, not
// the spawner. A researcher parked in an ad-hoc container used to hand its own
// env to every session it drafted, silently — nothing in the request named an
// env, so nothing in the resulting draft looked wrong. Naming some other env is
// still allowed, but only out loud, via `confirmNonDefaultEnv`.
//
// No docker and no agent: `createAgentDraft` is pure bookkeeping over the
// workspace registry, the same seam session-roles.test.mjs drives.
//
//   node scripts/draft-env-default.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// GURT_ROOT must be set before the store module loads (read at import time).
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-draft-env-'))
process.env.GURT_ROOT = GURT_ROOT

const outfile = path.join(os.tmpdir(), `gurt-draft-env-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

await bundle({
  stdin: {
    contents: `export { createKernel } from ${S('src/main/kernel.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})

const m = await import(pathToFileURL(outfile).href)

after(() => {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

const ws = 'w'
const task = 't'
fs.mkdirSync(path.join(GURT_ROOT, ws, task), { recursive: true })
// alpha has exactly one env claiming it, beta none, gamma two (ambiguous).
// `adhoc` claims no repo at all — it is the container the spawner runs in, and
// the one that must never leak into a draft by itself.
fs.writeFileSync(
  path.join(GURT_ROOT, ws, 'workspace.json'),
  JSON.stringify({
    repos: [
      { name: 'alpha', url: 'https://github.com/o/alpha.git' },
      { name: 'beta', url: 'https://github.com/o/beta.git' },
      { name: 'gamma', url: 'https://github.com/o/gamma.git' }
    ],
    envs: [
      { name: 'alpha-dev', devcontainer: '{"image":"x"}', repo: 'alpha' },
      { name: 'adhoc', devcontainer: '{"image":"x"}' },
      { name: 'gamma-one', devcontainer: '{"image":"x"}', repo: 'gamma' },
      { name: 'gamma-two', devcontainer: '{"image":"x"}', repo: 'gamma' }
    ]
  })
)
fs.writeFileSync(path.join(GURT_ROOT, ws, task, 'task.json'), JSON.stringify({}))
fs.writeFileSync(path.join(GURT_ROOT, ws, 'agents.json'), JSON.stringify({}))

const kernel = m.createKernel()
// The boot reconcile drops container records Docker does not confirm; let it
// finish first (see queue-handoff.test.mjs).
await kernel.ready

// The spawner: a researcher running in `adhoc`, i.e. exactly the situation the
// old defaulting spread — its own env is nobody's default.
const spawner = kernel.sessions.createSession(
  { workspace: ws, task, env: 'adhoc' },
  ['alpha'],
  'a1',
  'hi',
  'none',
  [],
  true,
  {},
  'researcher'
)

/** Draft an executor and report the env it landed in. */
const draftEnv = async (req) => {
  const { sessionId } = await kernel.sessions.createAgentDraft(spawner.id, {
    role: 'executor',
    prompt: 'p',
    ...req
  })
  return kernel.sessions.snapshot(sessionId).info.env
}
const rejects = (req, re, label) =>
  assert.rejects(() => draftEnv(req), re, label)

// --- omitted env: the repo's default, never the spawner's -------------------
test('an omitted env resolves to the target repo’s own default', async () => {
  assert.equal(
    await draftEnv({ repos: ['alpha'] }),
    'alpha-dev',
    'the env whose `repo` names alpha — not `adhoc`, the container the spawner happens to run in'
  )
  assert.equal(spawner.env, 'adhoc', 'and the spawner is genuinely running somewhere else')
})

// --- explicit env: free when it *is* the default, gated when it is not -------
test('an explicit env matching the repo default passes unchallenged', async () => {
  assert.equal(
    await draftEnv({ repos: ['alpha'], env: 'alpha-dev' }),
    'alpha-dev',
    'naming the default out loud is the same request, so no confirmation is asked for'
  )
})

test('an explicit non-default env is rejected without the confirmation', async () => {
  await rejects(
    { repos: ['alpha'], env: 'adhoc' },
    /env "adhoc" is not the default environment of repo "alpha" \(that is "alpha-dev"\)/,
    'the mismatch itself is the error — a wrong container may not be reached by inattention'
  )
  await rejects(
    { repos: ['alpha'], env: 'adhoc' },
    /omit `env`.*confirmNonDefaultEnv: true/s,
    'and the message spells out both ways forward'
  )
  await rejects(
    { repos: ['alpha'], env: 'adhoc', confirmNonDefaultEnv: false },
    /is not the default environment/,
    'an explicit `false` confirms nothing'
  )
})

test('an explicit non-default env passes with the confirmation', async () => {
  assert.equal(
    await draftEnv({ repos: ['alpha'], env: 'adhoc', confirmNonDefaultEnv: true }),
    'adhoc',
    'deliberate is allowed — the flag is what makes it deliberate'
  )
})

// --- repos with no default env: `env` required, but nothing to confirm ------
test('a repo no env claims requires an explicit env, and takes it as-is', async () => {
  await rejects(
    { repos: ['beta'] },
    /repo "beta" is not the default repo of any environment.*pass `env`/s,
    'there is nothing to default to, so the caller has to say'
  )
  assert.equal(
    await draftEnv({ repos: ['beta'], env: 'adhoc' }),
    'adhoc',
    'and once said it stands alone — no default exists for it to contradict'
  )
})

// --- repos several envs claim: ambiguous, so the caller picks ---------------
test('a repo several envs claim requires the caller to pick one of them', async () => {
  await rejects(
    { repos: ['gamma'] },
    /repo "gamma" is the default repo of several environments \(gamma-one, gamma-two\)/,
    'an ambiguous registry is not resolved on the caller’s behalf'
  )
  assert.equal(
    await draftEnv({ repos: ['gamma'], env: 'gamma-two' }),
    'gamma-two',
    'any env from the ambiguous set is a default, so it needs no non-default confirmation'
  )
  await rejects(
    { repos: ['gamma'], env: 'adhoc' },
    /env "adhoc" is not among the default environments of repo "gamma" \("gamma-one", "gamma-two"\)/,
    'anything outside the set is still a non-default choice'
  )
  assert.equal(
    await draftEnv({ repos: ['gamma'], env: 'adhoc', confirmNonDefaultEnv: true }),
    'adhoc',
    'and is still reachable on purpose'
  )
})

// --- the invented-name checks still come first ------------------------------
test('names the agent invented are rejected as unregistered, not as env trouble', async () => {
  await rejects(
    { repos: ['nope'] },
    /repo "nope" is not registered/,
    'an unknown repo reads as unknown, not as "has no default env"'
  )
  await rejects(
    { repos: ['alpha'], env: 'nope', confirmNonDefaultEnv: true },
    /environment "nope" is not registered/,
    'and the confirmation flag does not conjure an env into existence'
  )
})

// --- scope: the interactive path is untouched -------------------------------
test('the UI creation path still takes the env it is handed', () => {
  // A human picking `adhoc` for an alpha session in the New Session modal has
  // no silent-drift problem — they can see what they picked — so `createSession`
  // keeps taking the env from its ref, no repo lookup and no confirmation.
  const info = kernel.sessions.createSession(
    { workspace: ws, task, env: 'adhoc' },
    ['alpha'],
    'a1',
    'hi',
    'draft',
    [],
    true,
    {},
    'executor'
  )
  assert.equal(info.env, 'adhoc', 'the env the caller chose, unmediated')
})
