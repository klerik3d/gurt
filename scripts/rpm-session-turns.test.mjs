// RPM task 5 (t4v1): the session manager's side of RPM — classified turns
// (`SettledTurn`, `session.settled`, `lastSettled`), RPM's model tools routed
// through the per-session `gurt` server (`setRpmTools`), and the `reviewer`
// role's turn contract (`submit_review` with a nudge). t3v2 §4.1, §4.3, §5, §6.4.
//
// A headless kernel on a temp GURT_ROOT with a fake agent: `sessions.attach`
// returns a connection whose `session/prompt` runs a script, so `runPrompt`
// really runs, nudge and all. The script calls the tools the way the agent
// would — over HTTP, through the session's own `gurt` MCP server.
//
//   node --test scripts/rpm-session-turns.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { bundle } from './lib/bundle.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const S = (rel) => JSON.stringify(path.join(ROOT, rel))
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-rpm-turns-'))
process.env.GURT_ROOT = GURT_ROOT
const outfile = path.join(os.tmpdir(), `gurt-rpm-turns-${process.pid}.mjs`)
await bundle({
  stdin: {
    contents:
      `export { createKernel } from ${S('src/main/kernel.ts')}\n` +
      `export { buildGurtHttpServer, instructionsFor } from ${S('src/main/mcp/gurtServer.ts')}\n` +
      `export { rpmToolsFor, rpmInstructions } from ${S('src/rpm/core/index.ts')}`,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  outfile
})
const mod = await import(pathToFileURL(outfile).href)
const { buildGurtHttpServer, instructionsFor, rpmToolsFor, rpmInstructions } = mod

const ws = 'w'
const task = 't'
fs.mkdirSync(path.join(GURT_ROOT, ws, task), { recursive: true })
fs.writeFileSync(
  path.join(GURT_ROOT, ws, 'workspace.json'),
  JSON.stringify({
    repos: [
      { name: 'alpha', url: 'https://github.com/o/alpha.git' },
      { name: 'beta', url: 'https://github.com/o/beta.git' }
    ],
    envs: [{ name: 'dev', image: 'x', repo: 'alpha' }]
  })
)
// A user prompt snapshots the write clones first (checkpoints); give them clones.
for (const repo of ['alpha', 'beta']) execFileSync('git', ['init', '-q', path.join(GURT_ROOT, ws, task, repo)], { stdio: 'ignore' })
fs.writeFileSync(path.join(GURT_ROOT, ws, task, 'task.json'), JSON.stringify({}))
fs.writeFileSync(path.join(GURT_ROOT, 'agents.json'), JSON.stringify({}))

const servers = []
after(() => {
  for (const s of servers) s.close()
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

/** A fake `RpmTools`: real definitions and instructions from rpm/core; `call`
 *  accepts unless `refuse` is set. */
const rpmCalls = []
let refuse
const fakeTools = {
  for: (role) => rpmToolsFor(role),
  instructions: (role) => rpmInstructions(role),
  call(sessionId, name, input) {
    if (refuse) throw new Error(refuse)
    rpmCalls.push({ sessionId, name, input })
    return { payload: { accepted: input }, text: `${name}: accepted` }
  }
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
async function until(fn, what) {
  for (let i = 0; i < 300; i++) {
    const v = fn()
    if (v) return v
    await tick(15)
  }
  throw new Error(`never: ${what}`)
}

/** Wire one kernel life: no containers, a fake agent per session. */
function wire(kernel) {
  kernel.containers.reconcile = async () => {}
  kernel.containers.resolveLaunch = async () => {
    throw new Error('no containers in this test')
  }
  kernel.containers.stop = async () => {}
  kernel.containers.isRunning = async () => true
  const scripts = {}
  kernel.sessions.attach = async (s) => ({
    promptCapabilities: undefined,
    peer: {
      request: async (method, params) => {
        if (method !== 'session/prompt') return {}
        const sc = scripts[s.info.id]
        sc.n = (sc.n ?? 0) + 1
        sc.texts.push(params.prompt[0].text)
        return { stopReason: 'end_turn', ...(await sc.run(sc.n)) }
      },
      notify() {}
    }
  })
  const agent = (id, run) => (scripts[id] = { run, texts: [] })
  const settled = []
  const onDisk = []
  kernel.bus.on('session.settled', (e) => {
    settled.push(e)
    onDisk.push(rowOf(e.sessionId)?.lastSettled)
  })
  const up = []
  function started(id, repos, extra = {}) {
    // One writer per clone: the previous session's container lets the clone go.
    for (const prev of up.splice(0)) kernel.sessions.patchContainer(prev, undefined)
    up.push(id)
    kernel.sessions.restore([
      {
        info: {
          id, env: 'dev', role: 'executor', repos,
          repoModes: Object.fromEntries(repos.map((r) => [r, 'write'])),
          task, workspace: ws, title: id, agent: 'a1', state: 'started', mcp: [], startPrompt: 'x',
          ...extra
        },
        acpSessionId: `acp-${id}`,
        log: []
      }
    ])
    kernel.sessions.patchContainer(id, { status: 'running', id: `container-${id}`, remoteWorkspaceFolder: '/app', repos })
  }
  /** Send a typed prompt and wait for its logical turn to settle. */
  async function turn(id, text = 'go') {
    const before = settled.filter((e) => e.sessionId === id).length
    await kernel.sessions.prompt(id, text)
    await until(() => settled.filter((e) => e.sessionId === id).length > before, `${id} settles`)
    return settled.filter((e) => e.sessionId === id).at(-1)
  }
  return { kernel, agent, settled, onDisk, started, turn, scripts }
}

const rowOf = (id) =>
  JSON.parse(fs.readFileSync(path.join(GURT_ROOT, ws, task, 'sessions.json'), 'utf8')).find((r) => r.info.id === id)

/** The session's real `gurt` MCP server, as the agent sees it; `call` returns
 *  `{ isError, text }`. */
async function mcpOf(kernel, id) {
  const token = `tok-${id}-${servers.length}`
  const server = buildGurtHttpServer(token, kernel.sessions['gurtHooks'](kernel.sessions['sessions'].get(id)))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  servers.push(server)
  const url = `http://127.0.0.1:${server.address().port}/mcp/${token}`
  let n = 0
  const post = async (method, params) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params })
    })
    return JSON.parse(await res.text())
  }
  return {
    async call(name, args) {
      const body = await post('tools/call', { name, arguments: args })
      return { isError: body.result?.isError === true, text: body.result?.content?.[0]?.text ?? '' }
    },
    async tools() {
      return (await post('tools/list', {})).result.tools.map((t) => t.name)
    },
    async instructions() {
      const body = await post('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } })
      return body.result.instructions
    }
  }
}

const kernel = mod.createKernel()
const h = wire(kernel)
await kernel.ready
kernel.sessions.setRpmTools(fakeTools)

const REPLY = { replies: [{ id: 'F1', act: 'fixed', comment: 'fixed the null check' }] }
const REVIEW = { findings: [], verify: [{ id: 'F1', accept: true, comment: 'ok now' }] }
const CHANGES = { version: 1, outcome: 'changes', commit: { subject: 'fix' } }

test('without RpmTools there are no RPM tools; with them the executor gets reply_findings and the paragraph', async () => {
  h.started('e0', ['alpha'])
  kernel.sessions.setRpmTools(undefined)
  assert.deepEqual(await (await mcpOf(kernel, 'e0')).tools(), ['complete'])
  kernel.sessions.setRpmTools(fakeTools)
  const mcp = await mcpOf(kernel, 'e0')
  assert.deepEqual((await mcp.tools()).sort(), ['complete', 'reply_findings'])
  assert.ok((await mcp.instructions()).includes(rpmInstructions('executor')), 'RPM paragraph in the instructions')
  h.started('x0', ['alpha'], { role: 'researcher', repoModes: { alpha: 'read' } })
  assert.equal(kernel.sessions['gurtHooks'](kernel.sessions['sessions'].get('x0')).rpm, undefined, 'a researcher gets none')
  assert.ok(instructionsFor('executor', [], { rpm: 'PARA' }).includes('\n\nPARA\n\n'))
})

test('an executor turn with an RPM tool call settles with tools and outcome changes, lastSettled first', async () => {
  h.started('e1', ['alpha'])
  const mcp = await mcpOf(kernel, 'e1')
  let reply
  h.agent('e1', async () => {
    reply = await mcp.call('reply_findings', REPLY)
    await mcp.call('complete', CHANGES)
    return {}
  })
  const e = await h.turn('e1')
  assert.deepEqual(reply, { isError: false, text: 'reply_findings: accepted' })
  assert.deepEqual(e.turn, {
    sessionId: 'e1',
    turnId: 'e1:1',
    origin: 'user',
    outcome: 'changes',
    tools: [{ name: 'reply_findings', payload: { accepted: REPLY } }]
  })
  assert.deepEqual(e.ref, { workspace: ws, task, env: 'dev' })
  assert.deepEqual(h.onDisk[h.settled.indexOf(e)], e.turn, 'lastSettled was on disk when the event fired')
  assert.deepEqual(kernel.sessions.lastSettled('e1'), e.turn)
  assert.deepEqual(rpmCalls.at(-1), { sessionId: 'e1', name: 'reply_findings', input: REPLY })
})

test('a refused call is isError and is not filed; a call outside a turn is refused', async () => {
  h.started('e2', ['alpha'])
  const mcp = await mcpOf(kernel, 'e2')
  let res
  h.agent('e2', async () => {
    refuse = 'F9: no such finding in this run'
    res = await mcp.call('reply_findings', REPLY)
    refuse = undefined
    await mcp.call('complete', { version: 1, outcome: 'blocked', reason: 'need a key' })
    return {}
  })
  const e = await h.turn('e2')
  assert.deepEqual(res, { isError: true, text: 'F9: no such finding in this run' })
  assert.deepEqual(e.turn.tools, [])
  assert.equal(e.turn.outcome, 'blocked')
  assert.equal(e.turn.reason, 'need a key')
  const outside = await mcp.call('reply_findings', REPLY)
  assert.equal(outside.isError, true)
  assert.match(outside.text, /no turn is running/)
})

test('a prompt with origin { rpm: key } settles as rpm with its key', async () => {
  h.started('e3', ['alpha'])
  h.agent('e3', async () => (kernel.sessions['onComplete']('e3', { version: 1, outcome: 'no_changes' }), {}))
  const s = kernel.sessions['sessions'].get('e3')
  s.pending.push({ id: 'p-rpm', text: 'findings for you', auto: true, origin: { rpm: 'k-7' } })
  const before = h.settled.length
  await kernel.sessions['drainPending'](s)
  await until(() => h.settled.length > before, 'e3 settles')
  const e = h.settled.at(-1)
  assert.equal(e.turn.origin, 'rpm')
  assert.equal(e.turn.key, 'k-7')
  assert.equal(e.turn.outcome, 'no_changes')
  assert.equal(e.turn.turnId, 'e3:1')
})

test('an executor turn without complete, even after the nudge, settles incomplete', async () => {
  h.started('e4', ['alpha'])
  h.agent('e4', async () => ({}))
  const e = await h.turn('e4')
  assert.equal(e.turn.outcome, 'incomplete')
  assert.equal(h.scripts.e4.n, 2, 'prompt + nudge, one logical turn')
})

test('a reviewer is nudged for submit_review; its accepted call completes the turn', async () => {
  h.started('r1', ['alpha', 'beta'], { role: 'reviewer', repoModes: { alpha: 'write' }, reviewerOf: { executor: 'e1', key: 'k-r1' } })
  const info = kernel.sessions.snapshot('r1').info
  assert.equal(info.reviewerOf.key, 'k-r1')
  const hooks = kernel.sessions['gurtHooks'](kernel.sessions['sessions'].get('r1'))
  assert.deepEqual(hooks.mounts.map((m) => m.mode), ['read', 'read'], 'every repo read, whatever the record says')
  const mcp = await mcpOf(kernel, 'r1')
  assert.deepEqual(await mcp.tools(), ['submit_review'])
  h.agent('r1', async (n) => {
    if (n === 2) await mcp.call('submit_review', REVIEW)
    return {}
  })
  const e = await h.turn('r1')
  assert.match(h.scripts.r1.texts[1], /`submit_review`/, 'the nudge asks for submit_review')
  assert.equal(e.turn.outcome, 'no_changes')
  assert.deepEqual(e.turn.tools, [{ name: 'submit_review', payload: { accepted: REVIEW } }])

  h.started('r2', ['alpha'], { role: 'reviewer', reviewerOf: { executor: 'e1', key: 'k-r2' } })
  h.agent('r2', async () => ({}))
  const n = await h.turn('r2')
  assert.equal(n.turn.outcome, 'incomplete', 'no submit_review even after the nudge')
  const texts = kernel.sessions.snapshot('r2').entries.filter((x) => x.kind === 'system').map((x) => x.text)
  assert.ok(texts.includes('turn ended without submit_review'))
})

test('only a manager makes a reviewer: Duplicate and Recreate refuse', () => {
  assert.throws(() => kernel.sessions.duplicateSession('r1'), /only RPM creates one/)
  assert.throws(() => kernel.sessions.recreateSession('r1'), /only RPM creates one/)
})

/** Wrap the session manager's durable write for one session. */
function stubWrite(id, fn) {
  const real = kernel.sessions['persistNow'].bind(kernel.sessions)
  kernel.sessions['persistNow'] = (s) => (s.info.id === id ? fn(s, real) : real(s))
  return () => delete kernel.sessions['persistNow']
}

test('no session.settled until lastSettled is durable: a failing write holds the event', async () => {
  h.started('e5', ['alpha'])
  let failing = false
  // Only the settle's own write fails (the turn is closed, its record set).
  const restore = stubWrite('e5', async (s, real) => {
    if (failing && s.turn === undefined && s.lastSettled?.turnId === 'e5:1') throw new Error('disk full')
    return real(s)
  })
  h.agent('e5', async () => {
    kernel.sessions['onComplete']('e5', CHANGES)
    failing = true // the settle's write fails from here on
    return {}
  })
  const before = h.settled.length
  await kernel.sessions.prompt('e5', 'go')
  await tick(400)
  assert.equal(h.settled.length, before, 'no event while the write fails')
  failing = false
  const e = await until(() => h.settled.slice(before).find((x) => x.sessionId === 'e5'), 'e5 settles once the write lands')
  assert.deepEqual(h.onDisk[h.settled.indexOf(e)], e.turn, 'on disk when it fired')
  restore()
})

test('a prompt typed while the start prompt settles waits for that turn', async () => {
  h.started('e6', ['alpha'])
  let delayed = false
  const restore = stubWrite('e6', async (s, real) => {
    if (s.lastSettled?.turnId === 'e6:1' && !delayed) {
      delayed = true
      await tick(300) // the settle's write is slow
    }
    return real(s)
  })
  let seenAtSecond
  h.agent('e6', async (n) => {
    if (n === 1) {
      kernel.sessions['onComplete']('e6', CHANGES)
      setTimeout(() => void kernel.sessions.prompt('e6', 'typed'), 30)
    } else {
      seenAtSecond = h.settled.filter((x) => x.sessionId === 'e6').map((x) => x.turn.turnId)
      kernel.sessions['onComplete']('e6', { version: 1, outcome: 'no_changes' })
    }
    return {}
  })
  // `startSession` runs the start prompt outside the drain loop.
  void kernel.sessions['runPrompt'](kernel.sessions['sessions'].get('e6'), 'the start prompt')
  await until(() => h.settled.filter((x) => x.sessionId === 'e6').length === 2, 'both turns settle')
  assert.deepEqual(seenAtSecond, ['e6:1'], 'the typed turn started only after the first settled')
  assert.deepEqual(h.settled.filter((x) => x.sessionId === 'e6').map((x) => [x.turn.turnId, x.turn.origin, x.turn.outcome]), [
    ['e6:1', 'user', 'changes'],
    ['e6:2', 'user', 'no_changes']
  ])
  assert.equal(h.scripts.e6.texts[1], 'typed')
  restore()
})

/**
 * A keyed RPM turn that calls `reply_findings` and is then cut by a limit,
 * through the real queue. `other`: what else gets queued — the user types
 * 'before' (while the keyed turn runs) or 'after' (once it is cut), or 'rpm'
 * (another RPM message queued while it runs). Then the hold lifts and the
 * queue drains on its own. Returns the settled turns after the cut one and
 * the texts the agent got.
 */
async function cutStep(id, account, other) {
  h.started(id, ['alpha'], { agent: account })
  const mcp = await mcpOf(kernel, id)
  const s = kernel.sessions['sessions'].get(id)
  h.agent(id, async (n) => {
    if (n === 1) {
      await mcp.call('reply_findings', REPLY)
      if (other === 'before') await kernel.sessions.prompt(id, 'typed before')
      if (other === 'rpm' || other === 'rpm+typed') s.pending.push({ id: `p2-${id}`, text: 'another step', auto: true, origin: { rpm: `k2-${id}` } })
      throw new Error('429 too many requests — limit will reset in 2 hours')
    }
    await mcp.call('complete', CHANGES)
    return {}
  })
  s.pending.push({ id: `p-${id}`, text: 'findings for you', auto: true, origin: { rpm: `k-${id}` } })
  const before = h.settled.length
  void kernel.sessions['drainPending'](s)
  const cut = await until(() => h.settled.slice(before).find((x) => x.sessionId === id), 'the limited turn settles')
  assert.equal(cut.turn.outcome, 'limited')
  assert.equal(cut.turn.key, `k-${id}`)
  const carried = { origin: 'rpm', key: `k-${id}`, tools: [{ name: 'reply_findings', payload: { accepted: REPLY } }] }
  assert.deepEqual(rowOf(id).carry, carried, 'the cut step is on disk with lastSettled (survives a restart)')
  if (other === 'after' || other === 'rpm+typed') await kernel.sessions.prompt(id, 'typed after')
  assert.equal(s.pending[0].text, 'continue', 'the cut step’s continue is first in the queue')
  assert.equal(s.pending[0].continues, true)
  // The account's hold lifts; the scheduler drains the queue.
  const realHold = kernel.sessions['limitHold']
  kernel.sessions['limitHold'] = () => undefined
  s.info.limitedUntil = undefined
  void kernel.sessions['drainPending'](s)
  const want = other === 'rpm+typed' ? 4 : other ? 3 : 2
  await until(() => h.settled.slice(before).filter((x) => x.sessionId === id).length === want, 'the queue drains')
  kernel.sessions['limitHold'] = realHold
  const [, done, next, last] = h.settled.slice(before).filter((x) => x.sessionId === id)
  assert.deepEqual(
    { origin: done.turn.origin, key: done.turn.key, outcome: done.turn.outcome, tools: done.turn.tools },
    { ...carried, outcome: 'changes' },
    'the continue finishes the step: its key, and the calls from before the limit'
  )
  assert.equal(s.carry, undefined, 'and spends the carry')
  return { next: next?.turn, last: last?.turn, texts: h.scripts[id].texts.slice(1) }
}

test('a keyed RPM turn cut by a limit: the continue finishes the step, with its calls', async () => {
  const r = await cutStep('e7', 'a7')
  assert.deepEqual(r.texts, ['continue'])
})

test('a message typed while the keyed turn runs waits behind its continue and is a user turn', async () => {
  const r = await cutStep('e8', 'a8', 'before')
  assert.deepEqual(r.texts, ['continue', 'typed before'])
  assert.deepEqual([r.next.origin, r.next.key, r.next.tools], ['user', undefined, []])
})

test('a message typed after the limit keeps the continue and is a user turn of its own', async () => {
  const r = await cutStep('e9', 'a9', 'after')
  assert.deepEqual(r.texts, ['continue', 'typed after'])
  assert.deepEqual([r.next.origin, r.next.key, r.next.tools], ['user', undefined, []])
})

test('another RPM message queued meanwhile keeps its own key', async () => {
  const r = await cutStep('e10', 'a10', 'rpm')
  assert.deepEqual(r.texts, ['continue', 'another step'])
  assert.deepEqual([r.next.origin, r.next.key, r.next.tools], ['rpm', 'k2-e10', []])
})

test('typing keeps a queued RPM message: continue, RPM message and typed message settle in order', async () => {
  const r = await cutStep('e11', 'a11', 'rpm+typed')
  assert.deepEqual(r.texts, ['continue', 'another step', 'typed after'])
  assert.deepEqual([r.next.origin, r.next.key], ['rpm', 'k2-e11'], 'the RPM message keeps its own key')
  assert.deepEqual([r.last.origin, r.last.key, r.last.tools], ['user', undefined, []], 'the typed message is a user turn')
})

test('after a restart lastSettled is in place and turn ids go on', async () => {
  process.env.GURT_ROOT = GURT_ROOT
  const mod2 = await import(`${pathToFileURL(outfile).href}?boot=2`)
  const k2 = mod2.createKernel()
  const h2 = wire(k2)
  await k2.ready
  // Only e1 holds a clone now.
  for (const id of k2.sessions['sessions'].keys()) if (id !== 'e1') k2.sessions.patchContainer(id, undefined)
  const e1 = k2.sessions.lastSettled('e1')
  assert.equal(e1?.turnId, 'e1:1')
  assert.deepEqual(e1.tools, [{ name: 'reply_findings', payload: { accepted: REPLY } }])
  assert.equal(k2.sessions.snapshot('r1').info.role, 'reviewer', 'an RPM reviewer is not migrated away')
  assert.equal(k2.sessions.snapshot('r1').info.reviewerOf.key, 'k-r1')
  h2.agent('e1', async () => (k2.sessions['onComplete']('e1', CHANGES), {}))
  const s = k2.sessions['sessions'].get('e1')
  s.info.state = 'started'
  const e = await h2.turn('e1')
  assert.equal(e.turn.turnId, 'e1:2', 'the counter resumes, no id is reused')
})
