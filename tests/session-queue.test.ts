// SessionManager queue/serialization tests (no docker, no electron): the env
// layer is a fake SessionEvents implementation, the ACP adapter spawn is
// mocked so each connection talks real JSON-RPC to an in-process scriptable
// fake agent, and persistence (sessions.json + JSONL) runs through the real
// store against a temp GURT_ROOT. The postTurnDecision matrix itself is
// covered in tests/turn-contract.test.ts — here we test the wiring around it.
import { afterAll, it, vi } from 'vitest'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { agentDef } from '../src/shared/agents'
import type { AcpHttpMcpServer, ChangeProposal, EnvRef, EnvStatus } from '../src/shared/types'
import type { CreateAction, EnvContext, SessionEvents } from '../src/main/sessions'

const spawnState = vi.hoisted(() => ({
  spawn: undefined as undefined | ((session: string, ...rest: unknown[]) => unknown)
}))

// sessions.ts imports only spawnAcpAdapter from the provisioning layer.
vi.mock('../src/main/provision', () => ({
  spawnAcpAdapter: (session: string, ...rest: unknown[]) => {
    if (!spawnState.spawn) throw new Error('spawnAcpAdapter called before test setup')
    return spawnState.spawn(session, ...rest)
  }
}))

// GURT_ROOT must be set before the store module loads (read at import time).
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-session-queue-'))
process.env.GURT_ROOT = GURT_ROOT
const store = await import('../src/main/store')
const { createBus } = await import('../src/main/bus')
const { SessionManager, NUDGE_PROMPT } = await import('../src/main/sessions')

const WS = 'w'

afterAll(async () => {
  // let the debounced persist timers land before removing their target dir
  await new Promise((r) => setTimeout(r, 400))
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

// --- scriptable in-process ACP agent ---------------------------------------

interface PromptResult {
  stopReason?: string
}
interface AgentScript {
  /** Handle one session/prompt turn (index counts from 0). Default: report
   *  `complete: no_changes` through the gurt hook, then end the turn. */
  onPrompt?: (index: number, params: any) => PromptResult | Promise<PromptResult>
  onCancel?: () => void
}

/** Per gurt-session-id script; set right after createSession (before the
 *  async start flow reaches the agent). */
const scripts = new Map<string, AgentScript>()
/** The per-session gurt `complete` callback, captured from resolveGurtServer. */
const completeHooks = new Map<string, (p: ChangeProposal) => void>()
/** One fake agent per session (connections are per session's container). */
const agents = new Map<string, FakeAgent>()

class FakeAgent {
  readonly child: any
  readonly prompts: any[] = []
  readonly sessionNews: any[] = []
  readonly cancels: any[] = []
  private readonly stdout = new PassThrough()
  private buf = ''
  private nextAcp = 0

  constructor(private owner: string) {
    const child = new EventEmitter() as any
    child.stdout = this.stdout
    child.stderr = new PassThrough()
    child.stdin = {
      write: (chunk: unknown) => {
        this.onChunk(String(chunk))
        return true
      }
    }
    child.kill = () => child.emit('close')
    this.child = child
  }

  private respond(id: number, result: unknown): void {
    this.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
  }

  private onChunk(chunk: string): void {
    this.buf += chunk
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (line) void this.handle(JSON.parse(line))
    }
  }

  private async handle(msg: any): Promise<void> {
    switch (msg.method) {
      case 'initialize':
        return this.respond(msg.id, {
          agentCapabilities: { promptCapabilities: { image: true } }
        })
      case 'session/new':
        this.sessionNews.push(msg.params)
        return this.respond(msg.id, { sessionId: `acp-${this.owner}-${++this.nextAcp}` })
      case 'session/load':
      case 'session/set_mode':
      case 'session/set_config_option':
        return this.respond(msg.id, {})
      case 'session/prompt': {
        const index = this.prompts.length
        this.prompts.push(msg.params)
        const onPrompt =
          scripts.get(this.owner)?.onPrompt ??
          (() => {
            // a well-behaved agent reports its outcome before ending the turn
            completeHooks.get(this.owner)?.({ version: 1, outcome: 'no_changes' })
            return { stopReason: 'end_turn' }
          })
        return this.respond(msg.id, await onPrompt(index, msg.params))
      }
      case 'session/cancel': // notification — no response
        this.cancels.push(msg.params)
        scripts.get(this.owner)?.onCancel?.()
        return
      default:
        if (msg.id !== undefined) return this.respond(msg.id, {})
    }
  }
}

spawnState.spawn = (session) => {
  const agent = new FakeAgent(session)
  agents.set(session, agent)
  return agent.child
}

// --- fake env layer + real persistence -------------------------------------

interface FakeInstance {
  ws: string
  task: string
  session: string
  env: string
  repo?: string
  status: EnvStatus
}
const envStates: FakeInstance[] = []
const resolveEnvCalls: { session: string; repo?: string; gitAccess: boolean }[] = []
const releaseEnvCalls: EnvRef[] = []
const stopGurtCalls: string[] = []
/** Repo names whose env resolution fails (models clone/up failures). */
const failRepos = new Map<string, string>()

const events: SessionEvents = {
  resolveEnv: async (ref, repo, _agentId, gitAccess): Promise<EnvContext> => {
    resolveEnvCalls.push({ session: ref.session, repo, gitAccess })
    if (!repo) throw new Error('session has no repository')
    const fail = failRepos.get(repo)
    if (fail) throw new Error(fail)
    let inst = envStates.find((e) => e.session === ref.session)
    if (!inst) {
      inst = { ws: ref.workspace, task: ref.task, session: ref.session, env: ref.env, status: 'stopped' }
      envStates.push(inst)
    }
    inst.env = ref.env
    inst.repo = repo
    inst.status = 'running'
    return {
      agent: agentDef('claude-code')!,
      session: ref.session,
      remoteWorkspaceFolder: `/workspaces/${repo}`,
      hostWorkspaceFolder: `/host/${repo}`,
      configArgs: [],
      secret: 's3cret',
      secretEnv: 'TOKEN'
    }
  },
  installAdapter: async () => {},
  resolveMcpServers: async (): Promise<AcpHttpMcpServer[]> => [],
  stopMcpServers: () => {},
  resolveGurtServer: async (_ref, sessionId, onComplete): Promise<AcpHttpMcpServer> => {
    completeHooks.set(sessionId, onComplete)
    return { type: 'http', name: 'gurt', url: 'http://gurt.test', headers: [] }
  },
  stopGurtServer: (sessionId) => {
    stopGurtCalls.push(sessionId)
  },
  releaseEnv: (ref) => {
    releaseEnvCalls.push(ref)
    const i = envStates.findIndex((e) => e.session === ref.session)
    if (i >= 0) envStates.splice(i, 1)
  },
  taskEnvStates: async (ws, task) =>
    envStates
      .filter((e) => e.ws === ws && e.task === task)
      .map(({ session, env, repo, status }) => ({ session, env, repo, status })),
  persist: (ws, task, records) => {
    store.writeSessions(ws, task, records).catch(() => {})
  },
  saveAgentConfig: () => {},
  appendLog: (ws, task, sessionId, records) => store.appendSessionLog(ws, task, sessionId, records),
  deleteLog: (ws, task, sessionId) => {
    store.deleteSessionLog(ws, task, sessionId).catch(() => {})
  }
}

const bus = createBus()
const proposalEvents: { sessionId: string; proposal: unknown }[] = []
bus.on('session.proposal', (p) => proposalEvents.push({ sessionId: p.sessionId, proposal: p.proposal }))

const mgr = new SessionManager(events, bus)

// --- helpers ---------------------------------------------------------------

const create = (
  task: string,
  action: CreateAction,
  opts: { repo?: string | null; prompt?: string } = {}
) =>
  mgr.createSession(
    { workspace: WS, task, env: 'env1' },
    opts.repo === undefined ? 'alpha' : opts.repo,
    'agent-1',
    opts.prompt ?? 'do the thing',
    action
  )

/** The instance's turn is over and its env stopped — the repo is free again. */
function freeRepo(sessionId: string): void {
  const inst = envStates.find((e) => e.session === sessionId)
  if (inst) inst.status = 'stopped'
  mgr.schedule()
}

const state = (id: string) => mgr.snapshot(id)?.info.state
const entries = (id: string) => mgr.snapshot(id)?.entries ?? []
const hasSystemEntry = (id: string, text: string) =>
  entries(id).some((e) => e.kind === 'system' && e.text.includes(text))
const promptText = (p: any): string => p.prompt?.[0]?.text

async function waitFor<T>(fn: () => T | undefined | false, what: string, timeoutMs = 3000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const started = (id: string) => state(id) === 'started' && mgr.snapshot(id)?.busy === false

const readSessionsFile = (task: string): any[] | undefined => {
  try {
    return JSON.parse(fs.readFileSync(path.join(GURT_ROOT, WS, task, 'sessions.json'), 'utf8'))
  } catch {
    return undefined
  }
}
const jsonlPath = (task: string, id: string) =>
  path.join(GURT_ROOT, WS, task, 'sessions', `${id}.jsonl`)

// --- tests -----------------------------------------------------------------

it('a draft is created inert and persisted; run/enqueue demand a repo', async () => {
  const info = create('t1', 'draft')
  assert.equal(info.state, 'draft')
  assert.equal(mgr.snapshot(info.id)?.info.startPrompt, 'do the thing')
  assert.equal(resolveEnvCalls.filter((c) => c.session === info.id).length, 0, 'a draft never provisions')

  // the IPC boundary enforces the repo requirement, not just the UI
  assert.throws(() => create('t1', 'run', { repo: null }), /session has no repository/)
  assert.throws(() => create('t1', 'queue', { repo: null }), /session has no repository/)
  const repoless = create('t1', 'draft', { repo: null })
  assert.throws(() => mgr.run(repoless.id), /session has no repository/)
  assert.throws(() => mgr.enqueue(repoless.id), /session has no repository/)

  const persisted = await waitFor(
    () => readSessionsFile('t1')?.find((r) => r.info.id === info.id),
    'draft persisted to sessions.json'
  )
  assert.equal(persisted.info.state, 'draft')
  assert.equal(persisted.info.startPrompt, 'do the thing')
})

it('run → started: env resolved, ACP session opened with the gurt server, start prompt sent', async () => {
  const info = create('t2', 'run')
  await waitFor(() => started(info.id), 'session started')

  const calls = resolveEnvCalls.filter((c) => c.session === info.id)
  assert.deepEqual(calls, [{ session: info.id, repo: 'alpha', gitAccess: false }])

  const agent = agents.get(info.id)!
  assert.equal(agent.sessionNews.length, 1)
  assert.equal(agent.sessionNews[0].cwd, '/workspaces/alpha', 'session/new runs in the container cwd')
  assert.ok(
    agent.sessionNews[0].mcpServers.some((s: any) => s.name === 'gurt'),
    'the turn-contract server is attached unconditionally'
  )
  assert.equal(promptText(agent.prompts[0]), 'do the thing', 'startPrompt is the first turn')
  assert.ok(hasSystemEntry(info.id, 'complete: no_changes'))
  assert.equal(mgr.snapshot(info.id)?.promptCapabilities?.image, true)

  // run() on a started session is a no-op — no double start
  mgr.run(info.id)
  await sleep(50)
  assert.equal(resolveEnvCalls.filter((c) => c.session === info.id).length, 1)

  // a follow-up prompt rides the existing attached connection
  await mgr.prompt(info.id, 'follow-up')
  assert.equal(agent.prompts.length, 2)
  assert.equal(promptText(agent.prompts[1]), 'follow-up')
  assert.equal(resolveEnvCalls.filter((c) => c.session === info.id).length, 1, 'no re-provision on attach')

  // persisted record carries the ACP session id and the started state
  const persisted = await waitFor(
    () => {
      const r = readSessionsFile('t2')?.find((x) => x.info.id === info.id)
      return r?.acpSessionId ? r : undefined
    },
    'started session persisted'
  )
  assert.equal(persisted.info.state, 'started')
  assert.match(persisted.acpSessionId, /^acp-/)
  const log = await waitFor(() => {
    try {
      return fs.readFileSync(jsonlPath('t2', info.id), 'utf8')
    } catch {
      return undefined
    }
  }, 'JSONL log flushed')
  const first = JSON.parse(log.split('\n')[0])
  assert.equal(first.type, 'entry')
  assert.deepEqual(first.entry, { id: 1, kind: 'user', text: 'do the thing' })
})

it('the repo is the only gate: same-repo sessions queue, same-env/other-repo sessions start', async () => {
  const a = create('t3', 'run')
  await waitFor(() => started(a.id), 'A started')

  // B wants the repo A's instance occupies → queued
  const b = create('t3', 'queue')
  await sleep(60)
  assert.equal(state(b.id), 'queued')

  // C runs on the SAME env definition but another repo → starts immediately
  const c = create('t3', 'queue', { repo: 'beta' })
  await waitFor(() => started(c.id), 'C started')
  assert.equal(state(b.id), 'queued', 'B still waits for its repo')
  assert.equal(mgr.snapshot(b.id)?.queuePosition, 1)

  // A's env stops → the repo frees → B drains
  freeRepo(a.id)
  await waitFor(() => started(b.id), 'B started after the repo freed')
})

it('the queue drains in FIFO order, one same-repo session per free window', async () => {
  const a = create('t4', 'run')
  await waitFor(() => started(a.id), 'A started')
  const b = create('t4', 'queue')
  await sleep(5) // distinct queuedAt timestamps define the FIFO order
  const d = create('t4', 'queue')
  await sleep(60)
  assert.equal(state(b.id), 'queued')
  assert.equal(state(d.id), 'queued')

  freeRepo(a.id)
  await waitFor(() => started(b.id), 'B started first')
  await sleep(60)
  assert.equal(state(d.id), 'queued', 'D keeps waiting while B occupies the repo')

  freeRepo(b.id)
  await waitFor(() => started(d.id), 'D started last')

  const order = resolveEnvCalls
    .filter((c) => [a.id, b.id, d.id].includes(c.session))
    .map((c) => c.session)
  assert.deepEqual(order, [a.id, b.id, d.id], 'strict FIFO per repo')
})

it('a failed start falls back to draft with startError and can be re-run', async () => {
  failRepos.set('alpha', 'clone exploded')
  const info = create('t5', 'run')
  await waitFor(() => state(info.id) === 'draft' && mgr.snapshot(info.id)?.startError, 'back to draft')
  assert.equal(mgr.snapshot(info.id)?.startError, 'clone exploded')
  assert.ok(hasSystemEntry(info.id, 'start failed: clone exploded'))

  failRepos.delete('alpha')
  mgr.run(info.id)
  await waitFor(() => started(info.id), 'recovered on the next run')
  assert.equal(mgr.snapshot(info.id)?.startError, undefined, 'a new start clears the error')
})

it('cancelQueue returns the session to draft; the scheduler never picks it up again', async () => {
  const a = create('t6', 'run')
  await waitFor(() => started(a.id), 'A started')
  const b = create('t6', 'queue')
  await sleep(30)
  assert.equal(state(b.id), 'queued')

  mgr.cancelQueue(b.id)
  assert.equal(state(b.id), 'draft')
  assert.equal(mgr.snapshot(b.id)?.info.queuedAt, undefined)
  assert.equal(mgr.snapshot(b.id)?.queuePosition, undefined)

  freeRepo(a.id)
  await sleep(60)
  assert.equal(state(b.id), 'draft', 'a cancelled session stays a draft')
})

it('draft edits: prompt and repo/env re-point (releasing the instance); non-drafts are immune', async () => {
  const draft = create('t7', 'draft')
  mgr.editPrompt(draft.id, 'new prompt')
  assert.equal(mgr.snapshot(draft.id)?.info.startPrompt, 'new prompt')

  const before = releaseEnvCalls.length
  mgr.editDraft(draft.id, { repo: 'beta' })
  assert.equal(mgr.snapshot(draft.id)?.info.repo, 'beta')
  assert.equal(releaseEnvCalls.length, before + 1, 're-pointing the repo releases the instance')
  assert.equal(releaseEnvCalls[before].session, draft.id)

  mgr.editDraft(draft.id, { env: 'env2' })
  assert.equal(mgr.snapshot(draft.id)?.info.env, 'env2')
  assert.equal(releaseEnvCalls.length, before + 2, 're-pointing the env releases the instance')

  mgr.editDraft(draft.id, { repo: null })
  assert.equal(mgr.snapshot(draft.id)?.info.repo, undefined, 'null clears the repo')

  // a started session ignores draft edits entirely
  const live = create('t7', 'run')
  await waitFor(() => started(live.id), 'live session started')
  mgr.editPrompt(live.id, 'nope')
  mgr.editDraft(live.id, { repo: 'beta', agent: 'other' })
  const info = mgr.snapshot(live.id)!.info
  assert.equal(info.startPrompt, 'do the thing')
  assert.equal(info.repo, 'alpha')
  assert.equal(info.agent, 'agent-1')
})

it('nudge flow: a turn that skips `complete` gets exactly one nudge, which heals it', async () => {
  const info = create('t8', 'run')
  scripts.set(info.id, {
    onPrompt: (index) => {
      if (index === 0) return { stopReason: 'end_turn' } // violation: no complete call
      completeHooks.get(info.id)?.({ version: 1, outcome: 'no_changes' })
      return { stopReason: 'end_turn' }
    }
  })
  const agent = await waitFor(() => agents.get(info.id), 'agent spawned')
  await waitFor(() => agent.prompts.length === 2 && !mgr.snapshot(info.id)?.busy, 'nudge turn done')

  assert.equal(promptText(agent.prompts[1]), NUDGE_PROMPT)
  assert.ok(
    entries(info.id).some((e) => e.kind === 'system' && e.text === NUDGE_PROMPT),
    'the nudge is a system timeline entry, not a user message'
  )
  assert.ok(hasSystemEntry(info.id, 'complete: no_changes'))
  assert.equal(mgr.snapshot(info.id)?.info.incomplete, undefined, 'healed — no violation overlay')
})

it('nudge flow: a nudge that still skips `complete` marks the session incomplete, no third prompt', async () => {
  const info = create('t9', 'run')
  scripts.set(info.id, { onPrompt: () => ({ stopReason: 'end_turn' }) }) // never completes
  const agent = await waitFor(() => agents.get(info.id), 'agent spawned')
  await waitFor(
    () => agent.prompts.length === 2 && mgr.snapshot(info.id)?.info.incomplete,
    'incomplete mark'
  )
  await sleep(100)
  assert.equal(agent.prompts.length, 2, 'one nudge only — never a second')
  assert.ok(hasSystemEntry(info.id, 'turn ended without complete'))
})

it('complete(changes) stores the proposal and emits session.proposal', async () => {
  const info = create('t10', 'run')
  scripts.set(info.id, {
    onPrompt: () => {
      completeHooks.get(info.id)?.({
        version: 1,
        outcome: 'changes',
        commit: { subject: 'add feature' }
      })
      return { stopReason: 'end_turn' }
    }
  })
  await waitFor(() => started(info.id), 'turn finished')

  const proposal = mgr.snapshot(info.id)?.proposal
  assert.ok(proposal, 'proposal stored on the session')
  assert.equal(proposal.outcome, 'changes')
  assert.equal(proposal.commit?.subject, 'add feature')
  assert.ok(proposal.at, 'host receipt time stamped')
  assert.deepEqual(mgr.latestProposal(WS, 't10', 'alpha'), proposal)
  assert.ok(hasSystemEntry(info.id, 'complete: changes — add feature'))
  const evt = proposalEvents.find((e) => e.sessionId === info.id)
  assert.deepEqual(evt?.proposal, proposal, 'the committer seam sees the proposal')
})

it('one turn at a time: busy sessions reject prompts; cancel ends the turn without a nudge', async () => {
  const info = create('t11', 'run')
  let finishPrompt: ((r: PromptResult) => void) | undefined
  scripts.set(info.id, {
    onPrompt: () => new Promise<PromptResult>((resolve) => (finishPrompt = resolve)),
    onCancel: () => finishPrompt?.({ stopReason: 'cancelled' })
  })
  await waitFor(() => mgr.snapshot(info.id)?.busy, 'turn in flight')

  await assert.rejects(mgr.prompt(info.id, 'overlap'), /session is busy/)
  const draft = create('t11', 'draft', { repo: 'beta' })
  await assert.rejects(mgr.prompt(draft.id, 'x'), /session is not started/)
  await assert.rejects(mgr.prompt('nope', 'x'), /unknown session/)

  const agent = agents.get(info.id)!
  mgr.cancel(info.id)
  await waitFor(() => !mgr.snapshot(info.id)?.busy, 'turn ended by cancel')
  assert.equal(agent.cancels.length, 1, 'session/cancel reached the agent')
  assert.ok(hasSystemEntry(info.id, 'stopped: cancelled'))
  await sleep(100)
  assert.equal(agent.prompts.length, 1, 'a cancelled turn is never nudged')
  assert.equal(state(info.id), 'started', 'cancel does not change the session state')
})

it('deleteSession releases the env, stops the gurt server and removes the JSONL log', async () => {
  const info = create('t12', 'run')
  await waitFor(() => started(info.id), 'session started')
  await waitFor(() => fs.existsSync(jsonlPath('t12', info.id)), 'log on disk')

  mgr.deleteSession(info.id)
  assert.equal(mgr.snapshot(info.id), undefined)
  assert.ok(stopGurtCalls.includes(info.id))
  assert.ok(
    releaseEnvCalls.some((r) => r.session === info.id),
    'the session-bound instance goes down with the session'
  )
  await waitFor(() => !fs.existsSync(jsonlPath('t12', info.id)), 'log removed')
  await waitFor(() => {
    const records = readSessionsFile('t12')
    return records !== undefined && records.length === 0
  }, 'sessions.json rewritten without the session')
})
