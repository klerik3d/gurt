// The one-click first-run create (src/main/firstRun.ts,
// docs/requirements-first-run.md §6), over an empty `GURT_ROOT`.
//
// Five entities have to appear with the right names and links, a second click
// has to reuse rather than litter, and — the two properties that are not about
// convenience at all:
//
//   - **The token lands in `credentials.json` and nowhere else.** Not on the
//     session, not in `agents.json` (which holds a link, never a secret), and
//     not in any log file. `addSecrets` runs before anything can write it, so
//     even an error quoting it is redacted.
//   - **A failed start is an ordinary draft.** The start is handed to
//     `SessionManager.run`, whose failure branch already sets `state: 'draft'`
//     and `startError`. There is no half-state for the UI to fail to render,
//     which is the whole reason the start is handed over rather than inlined.
//
// No docker (a stub that refuses instantly stands in for the daemon, so the
// path is identical on a CI runner that has one) and no network (`fetch` is a
// parameter).
//
//   node scripts/first-run.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

// Read at import time by store.ts — set before the bundle loads.
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-first-run-'))
process.env.GURT_ROOT = GURT_ROOT
// No OS keystore in a plain node process; without this the credential module
// would try to reach electron's safeStorage.
process.env.GURT_FORCE_PLAINTEXT = '1'

// Same stub as operator-role.test.mjs: on a machine WITH a daemon the start
// would run a real `devcontainer up` against a fake image, which is slow,
// networked, and fails only after a pull. A stub that refuses instantly makes
// the path identical everywhere.
const stubBin = path.join(GURT_ROOT, 'stub-bin')
fs.mkdirSync(stubBin, { recursive: true })
fs.writeFileSync(path.join(stubBin, 'docker'), '#!/bin/sh\necho "no daemon" >&2\nexit 1\n', {
  mode: 0o755
})
process.env.PATH = `${stubBin}${path.delimiter}${process.env.PATH}`

const OPERATOR_ENV_FILE = path.join(GURT_ROOT, 'bundled-operator-env.json')
fs.writeFileSync(OPERATOR_ENV_FILE, JSON.stringify({ image: 'node:22-test' }))
process.env.GURT_OPERATOR_ENV = OPERATOR_ENV_FILE

const outfile = path.join(os.tmpdir(), `gurt-first-run-${process.pid}.mjs`)
await bundle({
  stdin: {
    contents:
      `export { createKernel } from ${S('src/main/kernel.ts')}\n` +
      `export { firstRunStart } from ${S('src/main/firstRun.ts')}\n` +
      `export { getCredentials } from ${S('src/main/credentials.ts')}\n` +
      `export { getAgents, listWorkspaces } from ${S('src/main/store.ts')}\n` +
      `export { FIRST_RUN_PROMPT, FIRST_RUN_TASK, FIRST_RUN_WORKSPACE } from ${S('src/shared/doctor.ts')}\n` +
      `export { OPERATOR_ENV_NAME } from ${S('src/shared/types.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  external: ['electron'],
  outfile
})
const m = await import(pathToFileURL(outfile).href)

after(() => {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

const TOKEN = 'sk-first-run-secret-value-0001'
const TOKEN2 = 'sk-first-run-secret-value-0002'

/** A provider that answers with one status and never touches the network. */
const answering = (status) => async () => ({ status, ok: status >= 200 && status < 300 })
/** A provider that throws — the offline case. */
const offline = async () => {
  throw new Error('ENOTFOUND')
}

/** Wait for the start to have run and settled the session one way or another. */
async function settled(kernel, id) {
  for (let i = 0; i < 200; i++) {
    const snap = kernel.sessions.snapshot(id)
    if (snap && (snap.startError || snap.info.state === 'started')) return snap
    await new Promise((r) => setTimeout(r, 25))
  }
  return kernel.sessions.snapshot(id)
}

const kernel = m.createKernel()
await kernel.ready

// --- the five entities ------------------------------------------------------

test('one call creates the workspace, credential, agent, task and operator session', async () => {
  assert.deepEqual(await m.listWorkspaces(), [], 'starting from an empty ~/.gurt')

  const { sessionId, warning } = await m.firstRunStart(kernel, 'claude-code', TOKEN, {
    fetchImpl: answering(200)
  })
  assert.equal(warning, undefined, 'an accepted token has nothing to warn about')

  // 1. workspace
  assert.deepEqual(await m.listWorkspaces(), [m.FIRST_RUN_WORKSPACE])

  // 2. credential — an agent-token, holding the secret
  const creds = (await m.getCredentials()).credentials
  assert.equal(creds.length, 1)
  assert.equal(creds[0].kind, 'agent-token')
  assert.match(creds[0].label, /token/)

  // 3. agent instance — linked by id, never carrying the secret inline
  const agents = await m.getAgents()
  const ids = Object.keys(agents)
  assert.equal(ids.length, 1)
  assert.equal(agents[ids[0]].kind, 'claude-code')
  assert.equal(agents[ids[0]].credentialId, creds[0].id)
  assert.equal(JSON.stringify(agents).includes(TOKEN), false, 'agents.json holds a link, not a secret')

  // 4 + 5. task and session
  const snap = kernel.sessions.snapshot(sessionId)
  assert.equal(snap.info.task, m.FIRST_RUN_TASK)
  assert.equal(snap.info.workspace, m.FIRST_RUN_WORKSPACE)
  assert.equal(snap.info.role, 'operator')
  assert.deepEqual(snap.info.repos, [], 'an operator holds no repository — that is the role')
  assert.equal(snap.info.env, m.OPERATOR_ENV_NAME, 'the bundled env, which needs no repo and no setup')
  assert.equal(snap.info.agent, ids[0])
  assert.equal(snap.info.startPrompt, m.FIRST_RUN_PROMPT)
  assert.equal(snap.info.network?.internal, true, 'the same default every other new draft gets')
  assert.equal(snap.info.title, 'operator')
})

// --- the token stays where it was put ---------------------------------------

test('the token is in credentials.json and in nothing else', async () => {
  const inFile = (rel) => {
    const p = path.join(GURT_ROOT, rel)
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').includes(TOKEN) : false
  }
  assert.equal(inFile('credentials.json'), true, 'it has to be somewhere')
  assert.equal(inFile('agents.json'), false)
  assert.equal(
    inFile(path.join(m.FIRST_RUN_WORKSPACE, m.FIRST_RUN_TASK, 'sessions.json')),
    false,
    'the session references the agent, which references the credential'
  )
  assert.equal(inFile(path.join(m.FIRST_RUN_WORKSPACE, 'workspace.json')), false)

  // And in no log file. `addSecrets` runs first thing in firstRunStart, so a
  // failure message quoting the token is redacted before it is written — this
  // is the property that makes "one crossing" true rather than aspirational.
  const logs = path.join(GURT_ROOT, 'logs')
  for (const f of fs.existsSync(logs) ? fs.readdirSync(logs) : [])
    assert.equal(
      fs.readFileSync(path.join(logs, f), 'utf8').includes(TOKEN),
      false,
      `${f} carries the token`
    )
})

// --- a failed start is an ordinary draft ------------------------------------

test('the start failing leaves an ordinary draft carrying its error', async () => {
  // The docker stub refuses, so the start dies in the container manager. What
  // the user must find is the state the session pane already renders.
  const { sessionId } = await m.firstRunStart(kernel, 'codex', TOKEN2, {
    fetchImpl: answering(200)
  })
  const snap = await settled(kernel, sessionId)
  assert.equal(snap.info.state, 'draft', 'not a half-state the UI cannot show')
  assert.ok(snap.startError, 'the reason is on the session, where the pane reads it')
  assert.equal(snap.startError.includes(TOKEN2), false)
  assert.equal(snap.info.queuedAt, undefined)
})

// --- a second click reuses -------------------------------------------------

test('a second run reuses the workspace, the task and the agent instance', async () => {
  const before = await m.getAgents()
  const { sessionId } = await m.firstRunStart(kernel, 'claude-code', TOKEN2, {
    fetchImpl: answering(200)
  })
  const after = await m.getAgents()

  assert.deepEqual(await m.listWorkspaces(), [m.FIRST_RUN_WORKSPACE], 'no second workspace')
  assert.deepEqual(
    Object.keys(after).filter((id) => after[id].kind === 'claude-code'),
    Object.keys(before).filter((id) => before[id].kind === 'claude-code'),
    'an existing instance of that kind is re-pointed, not duplicated'
  )
  // The credential IS new: an existing entry's secret cannot be read from
  // here, so there is nothing to compare a paste against.
  const claudeId = Object.keys(after).find((id) => after[id].kind === 'claude-code')
  const creds = (await m.getCredentials()).credentials
  assert.equal(after[claudeId].credentialId, creds.at(-1).id, 're-pointed at the new token')

  const snap = kernel.sessions.snapshot(sessionId)
  assert.equal(snap.info.task, m.FIRST_RUN_TASK)
  // Titles come free from `defaultTitleForRole`: the first of a role in the
  // task is bare, each further one counts up. (Which number depends on how
  // many sessions the tests above left in this task — the property is that it
  // is not a second bare "operator".)
  assert.match(snap.info.title, /^operator \d+$/, 'a further operator in the task counts up')
})

// --- the token probe's three outcomes at this boundary ----------------------

test('a rejected token creates nothing at all', async () => {
  const wsBefore = await m.listWorkspaces()
  const agentsBefore = JSON.stringify(await m.getAgents())
  const credsBefore = (await m.getCredentials()).credentials.length

  await assert.rejects(
    () => m.firstRunStart(kernel, 'codex', 'definitely-wrong', { fetchImpl: answering(401) }),
    /rejected this token/
  )

  assert.deepEqual(await m.listWorkspaces(), wsBefore)
  assert.equal(JSON.stringify(await m.getAgents()), agentsBefore)
  assert.equal((await m.getCredentials()).credentials.length, credsBefore, 'no orphan credential')
})

test('an unreachable provider does NOT block — it creates, and warns', async () => {
  // The probe runs on this host; a container's route out is its own proxy's.
  // Refusing here would turn a working setup into a dead end.
  const { sessionId, warning } = await m.firstRunStart(kernel, 'gemini', TOKEN2, {
    fetchImpl: offline
  })
  assert.ok(sessionId)
  assert.match(warning, /continuing without checking/)
  assert.equal(kernel.sessions.snapshot(sessionId).info.role, 'operator')
})

test('an unknown kind is refused before anything is written', async () => {
  const credsBefore = (await m.getCredentials()).credentials.length
  await assert.rejects(
    () => m.firstRunStart(kernel, 'not-an-agent', TOKEN2, { fetchImpl: answering(200) }),
    /unknown agent kind/
  )
  await assert.rejects(
    () => m.firstRunStart(kernel, 'codex', '   ', { fetchImpl: answering(200) }),
    /paste the agent token/
  )
  assert.equal((await m.getCredentials()).credentials.length, credsBefore)
})
