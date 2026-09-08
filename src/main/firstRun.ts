// The one-click first-run create (docs/requirements-first-run.md §6).
//
// Five entities — workspace, `agent-token` credential, agent instance, task,
// operator session — created eagerly, in main, behind one call.
//
// **Why one method and not five IPC calls from the welcome screen.** Three
// reasons, in order of weight:
//
//   1. The rules below are domain logic: "reuse the workspace if there is
//      one", "re-point an existing instance of that kind rather than
//      duplicating it", "what stays behind when step 3 throws". That is
//      knowledge about how `~/.gurt` is shaped, and the renderer is the wrong
//      place for another copy of it.
//   2. `setAgents` and `setCredentials` replace a whole file — there is no
//      partial update. From the renderer each would be read-all → append →
//      write-all, racing whatever a second window has open in Settings.
//   3. `getCredentials()` masks other entries' secrets, so a renderer
//      write-back sends masks where real secrets belong and relies on
//      `resolveSentinels` recognising the mask's *shape* to put them back.
//      That guard works and is carefully commented; a second caller of it is
//      how it eventually acquires a hole.
//
// **Partial failure has one rule: whatever exists afterwards is an ordinary
// entity the UI already knows how to show.** Nothing is rolled back — every
// step creates something legal and visible, and undoing them would delete the
// credential the user just pasted. The reuse rules make a second click
// idempotent apart from that credential.
//
// The *start* is deliberately not awaited and not inlined: it goes through
// `SessionManager.run`, the same path the pane's Run button takes, whose
// failure branch already lands the session back in `draft` with a
// `startError` the pane renders. There is no new state for a failed first
// start, which is the whole reason it is handed over rather than reimplemented.
import { randomUUID } from 'node:crypto'
import { agentDef } from '../shared/agents'
import type { CredentialEntry } from '../shared/credentials'
import {
  FIRST_RUN_PROMPT,
  FIRST_RUN_TASK,
  FIRST_RUN_WORKSPACE,
  type FirstRunResult
} from '../shared/doctor'
import { operatorEnvName, type AgentsFile } from '../shared/types'
import { probeAgentToken } from './agentProviders'
import { getCredentials, setCredentials } from './credentials'
import { createLogger, addSecrets } from './log'
import * as store from './store'
import type { Kernel } from './kernel'

const log = createLogger('first-run')

/** `SettingsPage`'s own rule for a new agent instance id, in the one other
 *  place instances are created: the kind (or the label's slug) with `-2`, `-3`
 *  … appended until it is free. */
function uniqueAgentId(base: string, taken: Set<string>): string {
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  return id
}

/** The workspace the first session lands in: the one the user is looking at,
 *  else the only one there is, else a fresh `default`. Never a second one when
 *  one already exists — a machine with a workspace is not a first run in the
 *  sense that matters here, it is a user who got stuck at step two. */
async function ensureWorkspace(preferred: string | undefined): Promise<string> {
  const existing = await store.listWorkspaces()
  if (preferred && existing.includes(preferred)) return preferred
  if (existing.length === 1 && existing[0]) return existing[0]
  if (existing.includes(FIRST_RUN_WORKSPACE)) return FIRST_RUN_WORKSPACE
  if (existing.length) return existing[0]!
  await store.createWorkspace(FIRST_RUN_WORKSPACE)
  return FIRST_RUN_WORKSPACE
}

/**
 * Create everything a first operator session needs, then start it.
 *
 * Returns as soon as the **draft** exists — `sessionId` is a session the tree
 * can already show. `warning` carries an `unreachable` token probe's sentence:
 * the create went ahead, because the probe runs on this host and the
 * container's route out is the session proxy's (§7.3).
 */
export async function firstRunStart(
  kernel: Kernel,
  kind: string,
  token: string,
  opts: { workspace?: string; fetchImpl?: typeof fetch } = {}
): Promise<FirstRunResult> {
  const def = agentDef(kind)
  if (!def) throw new Error(`unknown agent kind "${kind}"`)
  const secret = token.trim()
  if (!secret) throw new Error('paste the agent token first')
  // Before anything can write it, spawn with it, or quote it in an error:
  // redaction is value-based, so registering it here covers every log line
  // any of the calls below might produce. `setCredentials` feeds the redactor
  // too, but only after its own verification and write.
  addSecrets([secret])

  // Step 0: ask the provider. A refusal creates nothing — the point of doing
  // it first is that the user retypes into an unchanged machine.
  const probe = await probeAgentToken(kind, secret, opts.fetchImpl)
  if (probe.verdict === 'rejected') throw new Error(probe.detail)

  // Anything that can bring a container up waits out the boot restore, for the
  // reason `createSession`'s handler gives: a container born mid-reconcile can
  // have its record erased.
  await kernel.ready

  // 1. workspace
  const ws = await ensureWorkspace(opts.workspace)

  // 2. credential — always a new entry. An existing one's secret cannot be
  //    read from here by design, so there is nothing to compare against and
  //    nothing to reuse.
  const credential: CredentialEntry = {
    id: randomUUID(),
    label: `${def.label} token`,
    kind: 'agent-token',
    hosts: [],
    data: { secret }
  }
  const file = await getCredentials()
  await setCredentials({ credentials: [...file.credentials, credential] })

  // 3. agent instance — an existing instance of this kind is re-pointed at the
  //    new credential rather than duplicated: two claude instances differing
  //    only in which token they hold is the registry state nobody wants.
  const agents = await store.getAgents()
  const existingId = Object.keys(agents).find((id) => agents[id]?.kind === kind)
  const agentId = existingId ?? uniqueAgentId(kind, new Set(Object.keys(agents)))
  // Everything but the credential link is kept: re-pointing an instance the
  // user has already named and configured must not silently rename it or drop
  // its extra env.
  const prior = agents[agentId]
  const next: AgentsFile = {
    ...agents,
    [agentId]: {
      kind,
      label: prior?.label || def.label,
      credentialId: credential.id,
      ...(prior?.secretEnv ? { secretEnv: prior.secretEnv } : {}),
      ...(prior?.env ? { env: prior.env } : {})
    }
  }
  await store.setAgents(next)

  // 4. task
  if (!store.taskExists(ws, FIRST_RUN_TASK)) await store.createTask(ws, FIRST_RUN_TASK)

  // 5. session — an operator holds no repo, so `roleNeedsRepo` lets it through
  //    all four start gates with `repos: []`. `internal: true` matches what
  //    App.tsx gives every other new draft; the default domain policy is
  //    `allow`, so the agent reaches its provider while the proxy still
  //    refuses egress to this host.
  const wsData = await store.getWorkspace(ws)
  const info = kernel.sessions.createSession(
    { workspace: ws, task: FIRST_RUN_TASK, env: operatorEnvName(wsData) },
    [],
    agentId,
    FIRST_RUN_PROMPT,
    'draft',
    [],
    true,
    {},
    'operator',
    undefined,
    { internal: true }
  )
  log.info('first-run.created', { ws, agent: agentId, session: info.id, probe: probe.verdict })

  // Hand the start to the ordinary path and do not wait for it: a failure
  // there is a draft carrying `startError`, which is a state the pane the
  // caller is about to open already renders.
  try {
    kernel.sessions.run(info.id)
  } catch (e) {
    // `run` only throws for a gate this session cannot fail (it holds no
    // repo). Log it and leave the draft — the user has a Run button.
    log.warn('first-run.start.fail', { session: info.id, err: e })
  }
  return {
    sessionId: info.id,
    ...(probe.verdict === 'unreachable' ? { warning: probe.detail } : {})
  }
}
