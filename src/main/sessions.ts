import { randomUUID } from 'node:crypto'
import type {
  AcpHttpMcpServer,
  AgentConfig,
  InterruptedSession,
  AgentConfigCache,
  AgentSessionRequest,
  ChangeProposal,
  ChatEntry,
  ChatEntryBase,
  ConfigSelectOption,
  EnvRef,
  FindingReply,
  McpSelection,
  SkillSelection,
  PendingPromptInfo,
  PermissionOption,
  PersistedSession,
  PromptCapabilities,
  PromptContext,
  PromptImage,
  SessionConfigOption,
  SessionContainer,
  SessionInfo,
  SessionNetwork,
  SessionLogRecord,
  SessionMode,
  SessionModes,
  RepoMode,
  ReviewLoopConfig,
  ReviewVerdict,
  SessionRole,
  SessionSnapshot,
  StoredProposal,
  StoredVerdict
} from '../shared/types'
import {
  anchorRepo,
  applyLog,
  missingRepoReason,
  normalizeRepoModes,
  repoMode,
  roleDraftsCrossTask,
  roleHasTurnContract,
  roleIsLoopOwned,
  roleReadsAdmin,
  sanitizeSessionNetwork,
  sessionRole,
  spawnableRoles,
  writeRepos
} from '../shared/types'
import { defaultAgentConfig } from '../shared/agentConfig'
import type { AgentManifest } from '../shared/agentPlugin'
import {
  AUTO_WORDS,
  MANUAL_WORDS,
  agentVocabulary,
  mcpToolOf,
  modeHas,
  type ModeWords,
  type Vocabulary
} from '../shared/agentVocabulary'
import type { CreateAction } from '../shared/api'
import { taskKey } from '../shared/keys'
import { sanitizeSkillSelection } from '../shared/skills'
import { MCP_DEFS } from '../shared/mcp'
import type { SettledTurn } from '../shared/reviewLoop'
import { isLimitReply, limitResetAt, turnOutcome, usageFields } from '../shared/usage'
import { formatResetAt, type PlanHold } from '../shared/planUsage'
import { agentMain } from './agentPlugins'
import type { Bus } from './bus'
import type { AdminHooks, ProactiveHooks } from './mcp/gurtServer'
import type { ContainerStatusReason, SessionStateReason } from '../shared/events'
import type { LaunchContext } from './containers'
import type { PiiMask } from './pii'
import { lineBuffer, spawnAcpAdapter, spawnInContainer } from './provision'
import { createAcpClient, type AcpClient } from './acpClient'
import { servePiiRewrite, stopPiiRewrite } from './piiRewrite'
import { resolveProxyPlan } from './proxy/config'
import type { ProxyConfig } from '../shared/proxy'
import { JsonRpcPeer } from './jsonrpc'
import {
  CONFIG_OPTION,
  COMMANDS_UPDATE,
  CONFIG_OPTION_UPDATE,
  INITIALIZE_RESULT,
  MODE_UPDATE,
  MODES,
  PERMISSION_REQUEST,
  PLAN_UPDATE,
  PROMPT_RESULT,
  SESSION_LOAD_RESULT,
  SESSION_NEW_RESULT,
  SESSION_UPDATE,
  SET_CONFIG_OPTION_RESULT,
  TEXT_CHUNK,
  TOOL_CALL,
  USAGE_UPDATE,
  parseOrDrop,
  type AcpToolContent
} from './acp'
import { createLogger, errCtx } from './log'

const log = createLogger('sessions')

/** Bound on ACP control-plane calls (initialize, session/new, session/load,
 *  set_config_option): they answer in seconds when the adapter is healthy, and
 *  a hung one would otherwise pin the session in `starting` forever. Never
 *  applied to `session/prompt` — a turn takes as long as it takes. */
const ACP_REQUEST_TIMEOUT_MS = 60_000

/** A signal-killed child reports `code: null`; keep the exit code non-zero and
 *  shell-conventional (128 + signum) so "it died" is never read as "it exited
 *  cleanly" — `kill -9` on an adapter must show up as 137 in `agent.exit` and
 *  `session.end`, not as a missing field. Unlisted signals fall back to 128.
 *  Pure and unit-tested (scripts/turn-contract.test.mjs). */
const SIGNUM: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGABRT: 6,
  SIGKILL: 9,
  SIGSEGV: 11,
  SIGTERM: 15
}
export const adapterExitCode = (code: number | null, signal: NodeJS.Signals | null): number =>
  code ?? (signal ? 128 + (SIGNUM[signal] ?? 0) : -1)

/**
 * Normalize ACP `SessionConfigOption[]` into our flat shape. `select` options may be
 * either a flat list or grouped under headers — we inline groups (prefixing each label
 * with its group name) so the renderer sees one flat option list. Malformed entries are
 * skipped. Returns undefined when the agent reports no config options at all.
 */
/** `kind` is the reporting session's: its plugin's `normalizeConfigOptions`
 *  gets the last word over the list; a kind without one keeps it exactly as
 *  reported. */
function normalizeConfigOptions(
  raw: unknown,
  kind?: string
): SessionConfigOption[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: SessionConfigOption[] = []
  for (const item of raw) {
    // Per entry, not per list: one option the agent reports in a shape we do
    // not recognize is skipped, the rest of its selectors still reach the UI.
    const o = CONFIG_OPTION.safeParse(item)
    if (!o.success) continue
    // Absent, not `undefined`: these records are persisted and shipped over
    // IPC, where a key present only to say "nothing" is noise.
    const common = {
      id: o.data.id,
      name: o.data.name,
      ...(o.data.description ? { description: o.data.description } : {}),
      ...(o.data.category ? { category: o.data.category } : {})
    }
    if (o.data.type === 'boolean') {
      out.push({ ...common, type: 'boolean', currentValue: !!o.data.currentValue })
    } else {
      const flat: ConfigSelectOption[] = []
      for (const entry of o.data.options ?? []) {
        if (entry.options) {
          for (const v of entry.options)
            if (v.value !== undefined)
              flat.push({
                value: v.value,
                name: `${entry.name ?? ''} · ${v.name ?? v.value}`,
                ...(v.description ? { description: v.description } : {})
              })
        } else if (entry.value !== undefined) {
          flat.push({
            value: entry.value,
            name: entry.name ?? entry.value,
            ...(entry.description ? { description: entry.description } : {})
          })
        }
      }
      out.push({
        ...common,
        type: 'select',
        currentValue: typeof o.data.currentValue === 'string' ? o.data.currentValue : '',
        options: flat
      })
    }
  }
  return agentMain(kind)?.normalizeConfigOptions?.(out) ?? out
}

/** The mode's `_meta.kind`, if it reports one. ACP's `_meta` is a free-form
 *  envelope the schema keeps but does not type, so it is read defensively —
 *  an adapter that puts a `kind` straight on the mode is honored too. */
function modeKind(raw: Record<string, unknown>): string | undefined {
  const meta = raw['_meta']
  const fromMeta =
    meta && typeof meta === 'object' ? (meta as Record<string, unknown>)['kind'] : undefined
  const kind = typeof fromMeta === 'string' ? fromMeta : raw['kind']
  return typeof kind === 'string' && kind ? kind : undefined
}

/** Normalize an ACP `session/new`/`session/load` mode report into our shape:
 *  the same modes, with `_meta.kind` lifted onto each one so mode matching can
 *  key on what a mode *is* rather than on what it happens to be called (see
 *  {@link SessionMode.kind}). Returns undefined when the agent reported none,
 *  which every caller reads as "keep what we had". */
export function normalizeModes(raw: unknown): SessionModes | undefined {
  const parsed = MODES.safeParse(raw)
  if (!parsed.success) return undefined
  return {
    currentModeId: parsed.data.currentModeId,
    availableModes: parsed.data.availableModes.map((m) => {
      const kind = modeKind(m)
      // Absent, not `undefined`: this rides IPC, where a key present only to
      // say "nothing" is noise (same rule as `normalizeConfigOptions`).
      return { id: m.id, name: m.name, ...(kind ? { kind } : {}) }
    })
  }
}

/** No words beyond the core's own — what a kind without a mode vocabulary
 *  gets. */
const PLAIN_MODES: ModeWords = agentVocabulary(undefined).modes

/**
 * Pick the ACP mode that matches a session's auto-allow preference. Modes are
 * agent-defined, so this is a best-effort match over kind/id/name (mirrors the
 * renderer's `modeVisual`), in the session's agent's own words (`words`, from
 * its plugin) on top of the core's plain ones. Returns undefined if the
 * current mode already fits or no matching mode is exposed.
 *
 * Order matters on the auto side. An adapter can list an accept-edits mode
 * *before* its auto-review one (claude-code does), so a plain name match over
 * "accept|auto" would always land on accept-edits and gurt's "auto" could
 * never be reached. The real auto mode is asked for by kind (or by the
 * literal id) first; the accept/auto-edit family is the fallback for agents
 * that expose no such mode, and a blanket bypass only for agents that expose
 * neither.
 */
export function desiredModeId(
  autoAllow: boolean,
  modes: SessionModes | undefined,
  words: ModeWords = PLAIN_MODES
): string | undefined {
  const list = modes?.availableModes
  if (!list?.length) return undefined
  const pick = (pred: (m: SessionMode) => boolean) => list.find(pred)?.id
  const target = autoAllow
    ? // "auto" = review the risky calls, auto-accept the rest. Fall back to
      // accept-edits, and to a full bypass only for agents that expose neither.
      pick((m) => !!m.kind && words.autoReviewKinds.includes(m.kind)) ??
      pick((m) => m.id === 'auto') ??
      pick((m) => modeHas(m, AUTO_WORDS)) ??
      pick((m) => modeHas(m, words.bypass))
    : pick((m) => m.id === 'default') ?? pick((m) => modeHas(m, MANUAL_WORDS))
  if (!target || target === modes!.currentModeId) return undefined
  return target
}

/** The mode a freshly (re)opened ACP session should be switched into: the
 *  user's own last pick, when the agent still offers it, and only otherwise
 *  the one derived from the auto/manual choice. Without this a reattach
 *  re-derived the mode from a bool and silently overwrote the pick on every
 *  start and every wake. Undefined = the session is already where it belongs. */
export function nextModeId(
  info: Pick<SessionInfo, 'modeId' | 'autoAllow'>,
  modes: SessionModes | undefined,
  words: ModeWords = PLAIN_MODES
): string | undefined {
  const saved = info.modeId
  if (saved && modes?.availableModes.some((m) => m.id === saved))
    return saved === modes.currentModeId ? undefined : saved
  return desiredModeId(info.autoAllow ?? true, modes, words)
}

/**
 * One ACP adapter process, owned by one session and running inside that
 * session's container. Held under the session id; `containerId` records which
 * container it was spawned into, so a connection can be recognised as belonging
 * to a container that no longer exists.
 */
interface Connection {
  peer: JsonRpcPeer
  sessionId: string
  containerId: string
  agent: string
  /** Prompt content the agent accepts, from the `initialize` response
   *  (agent-level). Unset until `initialize` answers, and an agent may report
   *  none at all. */
  promptCapabilities?: PromptCapabilities | undefined
  kill: () => void
  /** The `fs/*` + `terminal/*` handlers, for a session that masks. Their
   *  processes die with the connection. */
  client?: AcpClient | undefined
  /** Set by `detach()` right before it kills *this* adapter process — the
   *  resulting 'close' is expected, not a crash. Lives on the connection
   *  (not the session) so a session that has since reconnected to a
   *  *replacement* adapter can't have its own crash misclassified by a
   *  flag meant for the old, still-closing one — see the peer identity
   *  check the close handler already does below. */
  expectedExit?: boolean
}

/** One queued prompt, with the payload the UI never sees (the images). */
interface PendingPrompt {
  queuedAt?: string | undefined
  id: string
  text: string
  context?: PromptContext[] | undefined
  images?: PromptImage[] | undefined
  /** Put here by the app, not typed: the "continue" a limit-interrupted turn
   *  sends once its account's hold lifts (see `onLimited`), or a review loop's
   *  host message (`origin`). */
  auto?: boolean | undefined
  /** Set on the review loop's host messages (`hostPrompt`): the id of the
   *  intent that decided them (docs/requirements-review-loop.md §5.5). */
  origin?: { loop: string } | undefined
}

/**
 * What the review loop's controller tells the session manager
 * (docs/requirements-review-loop.md §5.5, §5.6, §8) — registered with
 * {@link SessionManager.setLoopHooks}. Everything below is inert while none is:
 * with no hooks the manager behaves exactly as it did before the loop existed.
 * The loop *hold* is not here: the manager owns it ({@link
 * SessionManager.holdForLoop}), so it is in place the moment the controller
 * asks, without a second source of truth to keep in step.
 */
export interface LoopHooks {
  /** The session belongs to a loop that has not ended — its executor or its
   *  reviewer. The controller resumes these by itself after a restart, so they
   *  stay out of the Resume-sessions modal and of the update-deferral. */
  owns(sessionId: string): boolean
  /** The executors of this scope whose loop is delivering (§5.6, "During
   *  delivery"): the first irreversible step has started, so what is queued on
   *  one of them — or on a session sharing a clone with one — waits until it
   *  ends. Empty = none delivering. */
  delivering(workspace: string, task: string): readonly string[]
  /** A loop of this scope has not ended, or has ended and not yet notified
   *  (§5.6): the scope and its sessions are not archived meanwhile. */
  live(workspace: string, task: string): boolean
}

/** What an interrupted session sends once its limit resets. */
export const LIMIT_CONTINUE_PROMPT = 'continue'

/**
 * How long to wait when a limit hit named no reset and no window explains it:
 * 15 minutes, doubling with each consecutive hit, capped at the 5-hour window
 * itself — so a hold that keeps being wrong never turns into a tight loop of
 * refused "continue"s.
 */
export function limitBackoffMs(strikes: number): number {
  return Math.min(5 * 60 * 60_000, 15 * 60_000 * 2 ** Math.max(0, strikes - 1))
}

/**
 * Live, mutable state of one session in this process.
 *
 * The optional members spell out `| undefined` on purpose: under
 * `exactOptionalPropertyTypes` an optional property may be *absent*, but this
 * record is long-lived and its fields are cleared by assignment — `s.modes =
 * undefined` when the adapter goes away, `s.startError = undefined` at the next
 * start. "Present and unset" is the state being modelled here, not "missing".
 */
/** One clone a session claims (see `SessionManager.claims`). */
interface Claim {
  /** `<ws>/<task>/<repo>` — the clone, shared by the task's sessions. */
  key: string
  repo: string
  /** A `write` mount; a `read-locked` one claims shared. */
  exclusive: boolean
}

interface Session {
  info: SessionInfo
  ref: EnvRef
  acpSessionId?: string | undefined
  /** The append-only log; the timeline below is its fold. */
  records: SessionLogRecord[]
  /** seq of the last appended record (monotonic from 1 per session). */
  lastSeq: number
  /** seq of the last record confirmed on disk; a flush appends the rest. */
  flushedSeq: number
  /** A log flush is awaiting its appendLog — don't start a second one. */
  flushInFlight: boolean
  /** Images attached to the draft's first prompt (memory only; see `editPrompt`). */
  startImages?: PromptImage[] | undefined
  /** Folded timeline, updated incrementally via `applyLog` on every append. */
  entries: ChatEntry[]
  nextEntryId: number
  /** Container workspace folder (agent cwd), set when the env is resolved this run.
   *  Used to turn repo-relative context paths into absolute `file://` resource links. */
  remoteCwd?: string | undefined
  busy: boolean
  interrupted?: boolean | undefined
  recovering?: boolean | undefined
  recoveryStarting?: boolean | undefined
  promptRunning?: boolean | undefined
  /** Prompts accepted while the session could not run them, oldest first — a
   *  turn was in flight, or its clone was somebody else's. Drained by
   *  {@link SessionManager.drainPending}. Persisted across restarts; see
   *  {@link PendingPromptInfo}. */
  pending: PendingPrompt[]
  /** The drain loop owns this session's turns right now — a second one would
   *  race it for the queue. */
  draining: boolean
  /** The current turn has seen its `complete` call; reset at each prompt start. */
  turnComplete: boolean
  /** Latest change proposal (outcome=changes) from a `complete` call; last wins. */
  proposal?: StoredProposal | undefined
  /** A reviewer's latest `submit_review` (docs/requirements-review-loop.md
   *  §4.1); the last call of a turn wins. Runtime only for now. */
  verdict?: StoredVerdict | undefined
  /** The logical turn in flight — a prompt plus its nudge — from `runPrompt`'s
   *  first line to its classification (§5.1). The contract tools file their
   *  artifacts here; one that lands while it is unset belongs to no turn. */
  turn?: TurnTrack | undefined
  /** Logical turns started, for `SettledTurn.turnId` (`<sessionId>:<n>`).
   *  Unlike `turns` (every `sendTurn`, reset at each container start) it only
   *  ever grows: seeded at restore from `lastSettled`, so an id is never reused
   *  across a restart. */
  turnSeq: number
  /** The last turn gurt finished classifying; persisted. */
  lastSettled?: SettledTurn | undefined
  /** The review-loop intent whose host message the drain last took off the
   *  queue (docs/requirements-review-loop.md §8, the `message` row): written
   *  with the prompt's removal from the queue and `interrupted`, in the same
   *  `sessions.json`, so a message that may already have reached the agent is
   *  never sent twice. Replaced by the next prompt the drain takes (typed
   *  ones clear it); persisted. */
  loopRan?: string | undefined
  modes?: SessionModes | undefined
  plan?: SessionSnapshot['plan'] | undefined
  commands?: SessionSnapshot['commands'] | undefined
  /** Latest context-window usage from ACP's `usage_update`, if the adapter sends it. */
  usage?: SessionSnapshot['usage'] | undefined
  /** Live agent-reported config selectors (model/effort/…), from session/new & updates. */
  configOptions?: SessionConfigOption[] | undefined
  /** The live connection knows this ACP session (created or loaded this run). */
  attached: boolean
  /** session/load in progress — drop replayed updates, we keep our own history. */
  loading: boolean
  /** Last failure that put the session back to draft. */
  startError?: string | undefined
  /** Wall clock of the current run's start, and the turns it has served — the
   *  two numbers `session.end` reports when the adapter goes away. */
  startedAt?: number | undefined
  turns: number
  /** `stopReason` of the last finished turn, for the same record. */
  lastStopReason?: string | undefined
  /** A live rate-limit event during the current turn said `rejected` — one of
   *  the limit detector's signals. Reset at each prompt start. */
  turnRejected: boolean
  /** Consecutive turns that ended on a limit — what `limitBackoffMs` doubles on. */
  limitStrikes: number
  /** entry id -> resolver of a pending permission request. */
  pendingPermissions: Map<number, (outcome: unknown) => void>
}

/** The `<n>` of a settled turn's `<sessionId>:<n>` — where a restored session's
 *  turn counter resumes, so an id is never handed out twice. */
const turnSeqOf = (turnId: string | undefined): number => {
  const n = Number(turnId?.slice(turnId.lastIndexOf(':') + 1))
  return Number.isInteger(n) && n > 0 ? n : 0
}

/** What the contract tools filed during the logical turn in flight. */
interface TurnTrack {
  id: string
  /** The turn's last `complete`, any outcome. */
  complete?: StoredProposal | undefined
  /** The turn's last `submit_review`. */
  verdict?: StoredVerdict | undefined
}

/** The wire form of a queued prompt: everything but the images, which stay
 *  here (see {@link PendingPromptInfo}). */
const pendingInfo = (p: PendingPrompt): PendingPromptInfo => ({
  id: p.id,
  text: p.text,
  ...(p.queuedAt ? { queuedAt: p.queuedAt } : {}),
  ...(p.context?.length ? { context: p.context } : {}),
  ...(p.images?.length ? { images: p.images.length } : {}),
  ...(p.auto ? { auto: true } : {}),
  ...(p.origin ? { loop: p.origin.loop } : {})
})

/** Capabilities the session manager needs from the container/mcp/store layers.
 *  Notifications ride the domain bus instead. */
export interface SessionEvents {
  /** Ensure the session's container is up and return the agent's launch context.
   *  This also ensures the session's network and proxy, and switches the
   *  container onto them, before the agent exists. */
  resolveLaunch: (sessionId: string) => Promise<LaunchContext>
  /** Install the agent's adapter packages in the session's container. */
  installAdapter: (ctx: LaunchContext) => Promise<void>
  /** Ensure the host MCP servers for this selection are up; return ACP descriptors. */
  resolveMcpServers: (
    ref: EnvRef,
    sessionId: string,
    repo: string | undefined,
    selection: McpSelection[] | undefined
  ) => Promise<AcpHttpMcpServer[]>
  /** Tear down the session's host MCP servers. */
  stopMcpServers: (sessionId: string) => void
  /** Hand the session's proxy the scope its token names (MCP routes, resolved
   *  credentials, egress policy). Called before the agent spawns, and again on
   *  every later change — the token never changes with it. */
  pushProxyScope: (sessionId: string, config: ProxyConfig) => Promise<void>
  /** Ensure the per-session `gurt` server is up; return its ACP descriptor.
   *  Attached to every session unconditionally — its tool set follows the
   *  session's role (`complete` for an executor, `create_session` for the
   *  roles that fan out; see docs/requirements-repo-mounts.md §4), and its
   *  instructions carry the session's mount table. */
  resolveGurtServer: (
    ref: EnvRef,
    sessionId: string,
    hooks: {
      role: SessionRole
      mounts: { repo: string; mode: RepoMode }[]
      onComplete: (p: ChangeProposal) => void
      onSubmitReview: (v: ReviewVerdict) => void
      onCreateSession: (req: AgentSessionRequest) => Promise<{ sessionId: string; title: string }>
      /** An executor in a review loop (`SessionInfo.review` present): selects
       *  its instructions variant (docs/requirements-review-loop.md §5.5). */
      reviewLoop?: boolean
      /** Present only for an inspector or operator session — routes its admin
       *  tools into the ws-bound admin surface
       *  (docs/requirements-session-operator.md §3). */
      admin?: AdminHooks
      /** Present only for a proactive run (docs/design-proactive-agents.md §4). */
      proactive?: ProactiveHooks
    }
  ) => Promise<AcpHttpMcpServer>
  /** A proactive run's tools, bound by the session manager to the run's own
   *  workspace, agent (= its scope) and session id — never to anything the
   *  agent says. */
  proactiveFor: (ws: string, agent: string, sessionId: string) => ProactiveHooks
  /** The admin surface for one operator session — the workspace binding of
   *  docs/requirements-session-operator.md §3.2: the session manager passes
   *  its own workspace and id, never anything the agent said. The id is the
   *  journal's author and where an `apply_held` confirmation is raised. */
  adminFor: (ws: string, sessionId: string) => AdminHooks
  /** Tear down one session's `gurt` server (session deleted). */
  stopGurtServer: (sessionId: string) => void
  /** Reject repos/env that are not registered in the workspace, or an agent the
   *  workspace denies — the check `Kernel.editDraft` runs at the IPC boundary,
   *  reused for the drafts an agent asks for through `create_session` (which
   *  bypasses that boundary). */
  checkDraftTarget: (ws: string, repos: string[], env?: string, agent?: string) => Promise<void>
  /** A review loop executor's open set (docs/requirements-review-loop.md
   *  §4.2): the `findingRef` ids ("R1.F2") its next `complete` with
   *  `changes` must answer, each exactly once. Absent, or an empty list = no
   *  open set: `replies` is accepted and ignored. */
  openFindings?: (sessionId: string) => readonly string[] | undefined
  /** Env definition names claiming this repo as their default (`EnvConfig.repo`
   *  read backwards). The source of the env a `create_session` draft runs in
   *  when it names none — see `resolveDraftEnv`. */
  defaultEnvsForRepo: (ws: string, repo: string) => Promise<string[]>
  /** Workspace's default agent (an `AgentsFile` key), used to resolve a
   *  `create_session` request that names none — see `createAgentDraft`. */
  defaultAgentForWorkspace: (ws: string) => Promise<string | undefined>
  /** Workspace's default env (`defaultEnvName`) — where a drafted session with
   *  no repo to follow runs (`resolveDraftEnv`). */
  defaultEnvForWorkspace: (ws: string) => Promise<string>
  /** Is the plan these agent instances share at its limit (`planHold` over
   *  their cached usage, at the configured threshold)? Synchronous: the
   *  scheduler asks on every pass. */
  planHold: (agents: readonly string[]) => PlanHold | undefined
  /** Make sure the task exists (create it if missing) — a draft may not land in
   *  a task directory without its `task.json` marker, so a cross-task
   *  `create_session` materializes its target first. */
  ensureTask: (ws: string, task: string) => Promise<void>
  /** Destroy the container this session owns, if any — on delete, or when a
   *  draft is re-pointed at another repo/env. The clone stays. Resolves once
   *  the container is actually gone: the delete path waits for that before
   *  removing the directories it was mounted on. Never rejects. */
  releaseContainer: (sessionId: string, reason: ContainerStatusReason) => Promise<void>
  persist: (ws: string, task: string, records: PersistedSession[]) => void | Promise<void>
  /** Persist the refreshed config surface for an agent instance (cache). */
  saveAgentConfig: (agentId: string, cfg: AgentConfig) => void
  /** Append records to the session's JSONL log (append-only, ordered).
   *  Resolves once the records are on disk — the flush cursor waits for it. */
  appendLog: (ws: string, task: string, sessionId: string, records: SessionLogRecord[]) => Promise<void>
  /** Remove the session's JSONL log (session deleted). */
  deleteLog: (ws: string, task: string, sessionId: string) => void
  /** Remove the host scratch directory a session's mounts were staged in
   *  (`.multirepo/<id>`), once its container is down. Only sessions with
   *  explicit repo mounts ever had one; removing a missing one is a no-op. */
  deleteScratch: (ws: string, task: string, sessionId: string) => void
  /** Copy this session's selected skills into its scratch dir, ready for the
   *  read-only bind provisioning adds. Answers with the selected names that
   *  resolved to nothing (docs/requirements-skills.md §5). */
  materializeSkills: (
    ws: string,
    task: string,
    sessionId: string,
    selection: readonly SkillSelection[] | undefined
  ) => Promise<{ missing: string[] }>
}

/** A persisted session plus its read (or just-migrated) JSONL log. */
export interface RestoredSession extends PersistedSession {
  log: SessionLogRecord[]
}

/** A tool call that will not change status again. */
const isTerminalToolStatus = (status: string | null | undefined): boolean =>
  status === 'completed' || status === 'failed'

/** A log record before `append()` stamps its seq (distributive over the union). */
type NewLogRecord = SessionLogRecord extends infer R
  ? R extends SessionLogRecord
    ? Omit<R, 'seq'>
    : never
  : never

export type { CreateAction }

/** The one automatic follow-up sent when a turn ends without `complete`. */
export const NUDGE_PROMPT =
  'You ended your turn without calling the `complete` tool. Call `complete` ' +
  'now with the correct outcome (changes / no_changes / blocked) and do ' +
  'nothing else.'

/** The same follow-up for a proactive run, whose terminal tool is `finish_run`
 *  (docs/design-proactive-agents.md §4). */
export const PROACTIVE_NUDGE_PROMPT =
  'You ended your turn without calling the `finish_run` tool. Call `finish_run` ' +
  'now with a short summary of this run (and the cursor to resume from, if ' +
  'any) and do nothing else.'

/** The same for a review loop's reviewer, whose terminal tool is
 *  `submit_review` (docs/requirements-review-loop.md §4). */
export const REVIEWER_NUDGE_PROMPT =
  'You ended your turn without calling the `submit_review` tool. Call ' +
  '`submit_review` now with your verdict (approve / request_changes), a ' +
  'summary and the findings, and do nothing else.'

/** The terminal tool of a role's turn contract (see `roleHasTurnContract`) —
 *  what its nudge asks for and its `incomplete` line names. */
export const contractToolFor = (role: SessionRole): string =>
  role === 'proactive' ? 'finish_run' : role === 'reviewer' ? 'submit_review' : 'complete'

/** The nudge for a role's turn contract. */
export const nudgePromptFor = (role: SessionRole): string =>
  role === 'proactive' ? PROACTIVE_NUDGE_PROMPT : role === 'reviewer' ? REVIEWER_NUDGE_PROMPT : NUDGE_PROMPT

/** What a draft takes from whoever asks for it when the request says nothing
 *  — the spawning session for `create_session`, the template for a proactive
 *  agent's `propose_scope`. */
export interface DraftInheritance {
  agent?: string | undefined
  mcp?: McpSelection[] | undefined
  autoAllow?: boolean | undefined
  configValues?: Record<string, string | boolean> | undefined
  skills?: SkillSelection[] | undefined
  network?: SessionNetwork | undefined
}

/** A draft request checked against the workspace, ready to create: the agent
 *  and env it resolved to. */
export interface PreparedDraft {
  req: AgentSessionRequest
  agent: string
  env: string
}

/**
 * The host-side rules of a `complete` call that its schema cannot carry
 * (docs/requirements-repo-mounts.md §3): every per-repo entry names one of the
 * session's `write` repos, at most once. Pure and unit-tested; the message is
 * what the agent gets back as an `isError` result.
 */
export function assertProposalFits(writes: readonly string[], p: ChangeProposal): void {
  const seen = new Set<string>()
  for (const { repo } of p.repos ?? []) {
    if (!writes.includes(repo))
      throw new Error(
        writes.length
          ? `repo "${repo}" is not mounted for write in this session — propose only for: ${writes.join(', ')}`
          : `repo "${repo}" is not mounted for write in this session — it writes no repository`
      )
    if (seen.has(repo)) throw new Error(`repo "${repo}" is named twice in \`repos\``)
    seen.add(repo)
  }
}

/**
 * The open-set rule of a `complete` with `changes` (docs/requirements-review-
 * loop.md §4.2): `replies` answers every open finding exactly once and names
 * no finding outside the set. Pure and unit-tested; the message — every
 * offending ref named — is what the agent gets back as an `isError` result.
 * An empty open set asks for nothing.
 */
export function assertRepliesAnswer(open: readonly string[], replies: readonly FindingReply[] | undefined): void {
  if (!open.length) return
  const count = new Map<string, number>()
  for (const r of replies ?? []) count.set(r.findingId, (count.get(r.findingId) ?? 0) + 1)
  const missing = open.filter((id) => !count.has(id))
  const unknown = [...count.keys()].filter((id) => !open.includes(id))
  const twice = [...count].filter(([id, n]) => n > 1 && open.includes(id)).map(([id]) => id)
  const problems = [
    ...(missing.length ? [`not answered: ${missing.join(', ')}`] : []),
    ...(unknown.length ? [`not open: ${unknown.join(', ')}`] : []),
    ...(twice.length ? [`answered more than once: ${twice.join(', ')}`] : [])
  ]
  if (problems.length)
    throw new Error(
      `\`replies\` must answer every open review finding (${open.join(', ')}) exactly once — ${problems.join('; ')}`
    )
}

/**
 * The host rule of a `submit_review` call that its schema cannot carry
 * (docs/requirements-review-loop.md §4.1): every finding's `file` is
 * `<repo>/<path>` with `<repo>` one of the session's repos — never an absolute
 * path, never a `..` out of it. Pure, like {@link assertProposalFits}.
 */
export function assertVerdictFits(repos: readonly string[], v: ReviewVerdict): void {
  for (const f of v.findings) {
    const parts = f.file.split('/')
    if (!repos.includes(parts[0] ?? '') || parts.includes('..'))
      throw new Error(
        `finding "${f.id}": file "${f.file}" names no repository of this session — write it as ` +
          `<repo>/<path> relative to /workspaces, <repo> one of: ${repos.join(', ') || '(none)'}`
      )
  }
}

/** One repo's view of a stored proposal: its own `repos` entry when it has one,
 *  else the shared commit/pr; undefined when neither applies. */
export function proposalForRepo(p: StoredProposal, repo: string): StoredProposal | undefined {
  const own = p.repos?.find((r) => r.repo === repo)
  const { repos: _repos, ...shared } = p
  if (own) return { ...shared, commit: own.commit, pr: own.pr }
  return shared.commit ? shared : undefined
}

/** True when `title` is still the auto-generated default for `role` — the
 *  bare role name, or role name + index — rather than something the user
 *  typed themselves. Used to decide whether a role change should carry the
 *  title along with it. */
export function isDefaultSessionTitle(title: string, role: SessionRole): boolean {
  return title === role || new RegExp(`^${role} \\d+$`).test(title)
}

/** A proactive agent's template never runs itself — every run is a copy of it
 *  (docs/design-proactive-agents.md §2). Checked at every entrance a start
 *  can come through. */
function assertNotTemplate(info: SessionInfo): void {
  if (info.template)
    throw new Error("this is a proactive agent's template — it never runs itself; use the agent's Run now")
}

/** A reviewer is the review loop's alone (docs/requirements-review-loop.md
 *  §4): only the loop creates one, so nothing copies it. */
function assertNotLoopOwned(info: SessionInfo): void {
  if (roleIsLoopOwned(sessionRole(info)))
    throw new Error("this is a review loop's reviewer — only the loop creates one, so it cannot be duplicated or recreated")
}

/**
 * A session the review loop's machinery may touch: a loop-enabled executor
 * (`review`) or a loop's reviewer (`reviewOf`). Everything the loop added to the
 * session manager's hot paths — the durable settled-turn record, `session.settled`,
 * `session.human` — is for these alone; every other session behaves exactly as it
 * did before the loop existed (docs/requirements-review-loop.md §13, "Fixes").
 */
export const isLoopSession = (info: Pick<SessionInfo, 'review' | 'reviewOf'>): boolean =>
  info.review !== undefined || info.reviewOf !== undefined

export type PostTurnAction = 'none' | 'nudge' | 'incomplete'

/** How one `session/prompt` round-trip ended, as `sendTurn` reports it. */
interface TurnResult {
  stopReason?: string | undefined
  threw: boolean
  /** Set when the limit detector claimed the turn (`withLimit`), with the
   *  reset the refusal named, if it named one. */
  limit?: { resetAt?: string | undefined } | undefined
}

/** What `runPrompt` knows of a logical turn's ending — the rest of {@link
 *  SettledTurn} is the artifacts the contract tools filed. */
type TurnHow = Pick<SettledTurn, 'limited' | 'cancelled' | 'failed' | 'incomplete'>

/** How a logical turn ended, from its last round-trip (its nudge, when it had
 *  one): threw, the user's Esc, another non-`end_turn` stop, or a clean end with
 *  or without the contract tool (`incomplete`, §5.1). */
function turnHow(last: TurnResult, incomplete: boolean): TurnHow {
  if (last.threw) return { failed: { stopReason: 'error' }, incomplete: false }
  if (last.stopReason === 'cancelled') return { cancelled: true, incomplete: false }
  if (last.stopReason && last.stopReason !== 'end_turn')
    return { failed: { stopReason: last.stopReason }, incomplete: false }
  return { incomplete }
}

/**
 * Decide what to do once a turn ends, from whether `complete` was seen. Pure and
 * unit-tested (scripts/turn-contract.test.mjs): only a clean `end_turn` that
 * skipped `complete` triggers healing — one nudge for a regular turn, an
 * `incomplete` mark for the nudge turn itself. A thrown prompt, a cancel, or any
 * non-`end_turn` stop never nudges.
 *
 * `hasContract` is false for the roles that are not offered `complete` at all
 * (researcher, inspector, operator): nudging them would demand a tool their `gurt` server
 * does not expose, so their turns simply end.
 */
export function postTurnDecision(o: {
  stopReason?: string | undefined
  turnComplete: boolean
  threw: boolean
  isNudge: boolean
  hasContract: boolean
  /** The turn ended on a provider limit: a nudge would only be refused too,
   *  and the session continues on its own once the limit resets. */
  limited?: boolean | undefined
}): PostTurnAction {
  if (!o.hasContract) return 'none'
  if (o.limited) return 'none'
  if (o.threw) return 'none'
  if (o.stopReason !== 'end_turn') return 'none'
  if (o.turnComplete) return 'none'
  return o.isNudge ? 'incomplete' : 'nudge'
}

export class SessionManager {
  /** One ACP adapter per session, held under the session id. */
  private connections = new Map<string, Connection>()
  /** In-flight adapter spawn per session — concurrent callers (a prompt's
   *  attach racing a config change's) must share one, or the loser's spawn
   *  leaks a second adapter process. Same shape as `installsInFlight` in
   *  containers.ts. */
  private connectsInFlight = new Map<string, Promise<Connection>>()
  /** In-flight attach per session, for the same reason one level up: two
   *  overlapping attaches would each issue their own `session/load`. */
  private attachesInFlight = new Map<string, Promise<Connection>>()
  private sessions = new Map<string, Session>()
  private persistTimers = new Map<string, NodeJS.Timeout>()
  /** Per agent-instance id, its last-known config surface (models/effort/commands/
   *  modes). Seeded from the persisted cache at restore, refreshed on every live
   *  session start/load/update — the source of truth the New Session modal reads
   *  and the fallback a detached session's snapshot uses. */
  private agentConfigs = new Map<string, AgentConfig>()
  /** Serialized form of the last cache write per agent — skips redundant saves. */
  private agentConfigWritten = new Map<string, string>()
  /** Last logged "why still queued" per session id (see `noteQueued`). */
  private queuedReasons = new Map<string, string>()
  /** Ids for queued prompts. Process-wide and monotonic — the renderer keys
   *  rows on them and cancels by them, and reusing one across sessions would
   *  make a stale cancel land on the wrong message. */
  private pendingSeq = 0
  /** Per-task cap on concurrently running sessions (`TaskFile.maxConcurrentSessions`),
   *  keyed by `taskKey(ws, task)`. Absent = unlimited. Mirrors `review.ts`'s
   *  in-memory lock set: the scheduler asks synchronously on every pass and
   *  cannot await a disk read, so this is seeded from disk at boot
   *  (`loadTaskCaps`) and kept current by every later edit (`setTaskCap`). */
  private taskCaps = new Map<string, number>()
  /** Per agent-instance id, its kind (`AgentManifest.id`) — mirrors agents.json so
   *  a seed config, a plugin's hooks and its vocabulary can resolve without a
   *  live container's launch context (see `loadAgentKinds`). */
  private agentKinds = new Map<string, string>()
  /** Per agent-instance id, the credential it runs on — the account a plan
   *  limit is pooled over. Kept beside `agentKinds`, from the same file. */
  private agentAccounts = new Map<string, string>()
  /** The one re-check armed for the earliest limit hold to lift. */
  private limitTimer: NodeJS.Timeout | undefined
  /** The review loop's controller, once it registers (`setLoopHooks`). */
  private loopHooks: LoopHooks | undefined
  /** Executors the review loop holds (docs/requirements-review-loop.md §5.5):
   *  runtime only — the controller places them again at boot, before the
   *  scheduler's first pass. */
  private loopHolds = new Set<string>()

  constructor(
    private events: SessionEvents,
    private bus: Bus,
    /** The ACP seam's masking layer (docs/requirements-pii-mask.md). Encodes the
     *  outbound prompt; the timeline keeps tokens and the chat view reveals them
     *  from the session's table. */
    private mask: PiiMask
  ) {}

  private emitState(s: Session, reason?: SessionStateReason, err?: unknown): void {
    this.bus.emit('session.state', {
      sessionId: s.info.id,
      ref: s.ref,
      state: s.info.state,
      ...(reason === undefined ? {} : { reason }),
      ...(err === undefined ? {} : { err: errCtx(err) })
    })
  }

  /** Load sessions persisted by a previous run; they reattach lazily on prompt. */
  restore(records: RestoredSession[]): void {
    for (const r of records) {
      if (this.sessions.has(r.info.id)) continue
      // A proactive run from a previous app life is over: its tools are closed
      // (only the agent's run in progress may use them), so there is nothing to
      // resume or continue — the agent's next run picks up from its cursor
      // (docs/design-proactive-agents.md §3.2).
      if (r.info.role === 'proactive') {
        r.interrupted = false
        r.pending = []
        r.info.limitedUntil = undefined
      }
      const entries = applyLog([], r.log)
      if (!r.info.lastActivityAt) {
        const at = entries.reduce((n, e) => Math.max(n, e.endAt ?? e.at ?? 0), 0)
        if (at) r.info.lastActivityAt = new Date(at).toISOString()
      }
      if (!r.info.lastContentAt) {
        const at = entries.reduce((n, e) => Math.max(n, e.endAt ?? e.at ?? 0), 0)
        if (at) r.info.lastContentAt = new Date(at).toISOString()
      }
      const lastSeq = r.log[r.log.length - 1]?.seq ?? 0
      this.sessions.set(r.info.id, {
        info: r.info,
        ref: { workspace: r.info.workspace, task: r.info.task, env: r.info.env },
        acpSessionId: r.acpSessionId,
        proposal: r.proposal,
        records: r.log,
        lastSeq,
        flushedSeq: lastSeq,
        flushInFlight: false,
        entries,
        nextEntryId: Math.max(0, ...entries.map((e) => e.id)) + 1,
        busy: false,
        pending: (r.pending ?? []).map((p) => ({ ...p, id: `p${++this.pendingSeq}` })),
        interrupted: r.interrupted,
        recovering: !!r.interrupted,
        draining: false,
        turnComplete: false,
        turns: 0,
        lastSettled: r.lastSettled,
        loopRan: r.loopRan,
        turnSeq: turnSeqOf(r.lastSettled?.turnId),
        attached: false,
        loading: false,
        pendingPermissions: new Map(),
        turnRejected: false,
        limitStrikes: 0
      })
      // Legacy records did not persist queued automatic continuations.
      const restored = this.sessions.get(r.info.id)!
      if (r.info.state === 'started' && r.info.limitedUntil && !restored.pending.length) {
        restored.pending.push({ id: `p${++this.pendingSeq}`, queuedAt: r.info.lastActivityAt ?? '', text: LIMIT_CONTINUE_PROMPT, auto: true })
      }
    }
  }

  /** Seed the in-memory config cache from the persisted one (called once at boot). */
  loadAgentConfigs(cache: AgentConfigCache): void {
    for (const [id, cfg] of Object.entries(cache)) {
      this.agentConfigs.set(id, cfg)
      this.agentConfigWritten.set(id, JSON.stringify(cfg))
    }
  }

  /** How this session's agent words its modes, tool titles and limit
   *  notices — its kind's plugin vocabulary, or the core's plain one. */
  private vocabulary(s: Session): Vocabulary {
    return agentVocabulary(this.agentKinds.get(s.info.agent ?? ''))
  }

  /** Refresh the agent-instance→kind lookup — called once at boot and again
   *  whenever agents.json is saved, so it never goes stale. */
  loadAgentKinds(agents: Record<string, { kind: string; credentialId?: string | undefined }>): void {
    this.agentKinds.clear()
    this.agentAccounts.clear()
    for (const [id, a] of Object.entries(agents)) {
      this.agentKinds.set(id, a.kind)
      if (a.credentialId) this.agentAccounts.set(id, a.credentialId)
    }
    // A re-pointed credential can move a session onto (or off) a held account.
    this.schedule()
  }

  /**
   * Why this session may not send anything to its agent right now, if it may
   * not: its own limit hit (`limitedUntil`, which survives a restart) or its
   * account's — every agent instance on the same credential draws from the
   * same plan, so a hold read through one of them holds them all.
   */
  private limitHold(s: Session): PlanHold | undefined {
    const now = Date.now()
    const own = s.info.limitedUntil && Date.parse(s.info.limitedUntil) > now
      ? { until: s.info.limitedUntil, reason: 'limit reached' }
      : undefined
    const agent = s.info.agent
    if (!agent) return own
    const account = this.agentAccounts.get(agent)
    const peers = account
      ? [...this.agentAccounts].filter(([, c]) => c === account).map(([id]) => id)
      : [agent]
    const shared = this.events.planHold(peers)
    if (!own || !shared) return own ?? shared
    // Both hold: the later end is the real one.
    if (!shared.until) return shared
    return Date.parse(shared.until) > Date.parse(own.until) ? shared : own
  }

  /** The plan hold this session would queue behind, if any — {@link limitHold}'s
   *  read-only view for the review loop, which must tell a reviewer queued
   *  `agent-limited` from one that merely waits for a slot (§5.4). */
  planHoldOf(sessionId: string): PlanHold | undefined {
    const s = this.sessions.get(sessionId)
    return s ? this.limitHold(s) : undefined
  }

  // --- review loop seams (docs/requirements-review-loop.md §5.4–§5.6) -------

  /** Register the loop's controller (or drop it with `undefined`). */
  setLoopHooks(hooks: LoopHooks | undefined): void {
    this.loopHooks = hooks
  }

  /** The loop owns this session (its executor or reviewer, loop not ended). */
  private loopOwned(s: Session): boolean {
    return this.loopHooks?.owns(s.info.id) === true
  }

  /** A loop's delivery is under way on something this session touches (§5.6):
   *  what is queued here waits. Only the delivering executor itself and the
   *  sessions whose clone claims overlap its (the scheduler's own notion,
   *  {@link claims}) are held — a repo-free inspector, or a session reading
   *  another repo of the same task, is no part of the delivery and must not wait
   *  on it. */
  private deliveryActive(s: Session): boolean {
    const delivering = this.loopHooks?.delivering(s.ref.workspace, s.ref.task)
    if (!delivering?.length) return false
    const mine = this.claims(s)
    return delivering.some((id) => {
      if (id === s.info.id) return true
      const ex = this.sessions.get(id)
      return !!ex && this.claims(ex).some((c) => mine.some((m) => m.key === c.key))
    })
  }

  /**
   * Take the loop hold on an executor: it keeps its clones even with its
   * container down, nothing queues a handoff against it, and it stops counting
   * against the task cap while its container is down. Idempotent.
   *
   * **Ordering.** The hold must exist before `sendTurn` emits `session.turn`
   * `ended` for the turn it protects — the kernel's queue handoff runs on that
   * event, in the same synchronous dispatch, and would stop the container of a
   * session the loop has not classified yet. The controller therefore takes it
   * on `session.turn` `started` of the executor's first turn (the start prompt
   * included): `sendTurn` emits `started` before its first `await`, minutes
   * ahead of any `ended`, and the nudge turn's own `ended` is covered by the
   * same hold — it is never dropped between a turn and its nudge.
   */
  holdForLoop(sessionId: string): void {
    if (!this.sessions.has(sessionId)) throw new Error('unknown session')
    this.loopHolds.add(sessionId)
  }

  /** Drop the hold; true when there was one. Dropping it only stops the
   *  reservation — the executor's turn is over or not, and its container may be
   *  up with its idle timer cancelled by the keep-alive pings. Whoever releases
   *  (the kernel's `releaseLoopHold`) re-runs the idle handling and
   *  `schedule()` afterwards. */
  releaseLoopHold(sessionId: string): boolean {
    return this.loopHolds.delete(sessionId)
  }

  isLoopHeld(sessionId: string): boolean {
    return this.loopHolds.has(sessionId)
  }

  /**
   * Wake a loop executor's container without attaching its agent — the review
   * loop's check needs the clone's toolchain, not the agent (§5.3). Gated like a
   * resume (`repoConflict`; the held executor is its own clone's holder, so only
   * a foreign claim refuses it), then `resolveLaunch`: the container up, the
   * adapter installed, the proxy scope converged, credentials in place — and no
   * `session/load`. Rejecting means the check cannot run.
   */
  async ensureContainerUp(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error('unknown session')
    const conflict = this.repoConflict(s)
    if (conflict)
      throw new Error(
        `repository "${conflict.repo}" is in use by session "${conflict.holder.info.title}" — wait for it to go idle`
      )
    await this.events.resolveLaunch(sessionId)
  }

  /** The last logical turn gurt finished classifying (persisted before
   *  `session.settled`): what a booting loop replays (§8). */
  lastSettledOf(sessionId: string): SettledTurn | undefined {
    const t = this.sessions.get(sessionId)?.lastSettled
    return t && structuredClone(t)
  }

  /** The loop's message `intent` is already in this session: waiting in the
   *  queue, taken off it (the in-flight marker, {@link Session.loopRan}), or
   *  on the timeline as its `system` entry — any of the three means it is not
   *  to be sent again (§8). */
  hostPromptSeen(sessionId: string, intent: string): boolean {
    const s = this.sessions.get(sessionId)
    if (!s) return false
    return (
      s.pending.some((p) => p.origin?.loop === intent) ||
      s.loopRan === intent ||
      s.entries.some((e) => e.kind === 'system' && e.loop === intent)
    )
  }

  /** Drop the review loop's queued host messages (`origin.loop`) from this
   *  session — the loop ended and must not leave a message to run later (§5.6).
   *  Typed messages stay. Returns how many went. */
  dropHostPrompts(sessionId: string): number {
    const s = this.sessions.get(sessionId)
    if (!s) return 0
    const before = s.pending.length
    s.pending = s.pending.filter((p) => p.origin === undefined)
    const n = before - s.pending.length
    if (n) {
      this.schedulePersist(s.ref)
      this.bus.emit('session.changed', { sessionId })
    }
    return n
  }

  /** "plan limit: Current session 97% — waits for the reset at 15:00" — one
   *  wording for every place a session says it is waiting on a limit. */
  private holdText(h: PlanHold): string {
    return h.until
      ? `plan limit: ${h.reason} — waits for the reset at ${formatResetAt(h.until, Date.now())}`
      : `plan limit: ${h.reason} — waits for the next usage read below the threshold`
  }

  /**
   * Re-run the scheduler when the earliest hold is due to lift. Holds also lift
   * on fresh usage data (`usage.changed` re-runs it from the kernel); this is
   * the clock for the case nothing new arrives — a reset passing in silence.
   * A hold with no end is re-checked every minute.
   */
  private armLimitTimer(holds: PlanHold[]): void {
    clearTimeout(this.limitTimer)
    this.limitTimer = undefined
    if (!holds.length) return
    const now = Date.now()
    const due = Math.min(...holds.map((h) => (h.until ? Date.parse(h.until) - now : 60_000)))
    this.limitTimer = setTimeout(() => this.schedule(), Math.min(5 * 60_000, Math.max(1_000, due + 1_000)))
    this.limitTimer.unref?.()
  }

  /** Cached config for an agent instance, or its kind's hardcoded default. */
  agentConfig(agentId: string, kind?: string): AgentConfig {
    return this.agentConfigs.get(agentId) ?? defaultAgentConfig(kind ?? agentId)
  }

  /** Fold a started session's live surface into the agent cache and persist it
   *  (deduped). No-op for sessions without an agent id. */
  private cacheAgentConfig(s: Session): void {
    const agentId = s.info.agent
    if (!agentId) return
    const prev = this.agentConfigs.get(agentId)
    const modes = s.modes ?? prev?.modes
    const promptCapabilities = this.connections.get(s.info.id)?.promptCapabilities ?? prev?.promptCapabilities
    const cfg: AgentConfig = {
      configOptions: s.configOptions ?? prev?.configOptions ?? [],
      commands: s.commands ?? prev?.commands ?? [],
      ...(modes ? { modes } : {}),
      ...(promptCapabilities ? { promptCapabilities } : {}),
      updatedAt: new Date().toISOString()
    }
    this.agentConfigs.set(agentId, cfg)
    // Compare without the timestamp so a pure re-report doesn't churn the file.
    const key = JSON.stringify({ ...cfg, updatedAt: undefined })
    if (this.agentConfigWritten.get(agentId) === key) return
    this.agentConfigWritten.set(agentId, key)
    this.events.saveAgentConfig(agentId, cfg)
  }

  listForTask(ws: string, task: string): SessionInfo[] {
    return [...this.sessions.values()]
      .filter((s) => s.ref.workspace === ws && s.ref.task === task)
      .map((s) => this.infoWithRuntime(s))
  }

  /** First of its role in the task carries no index; each further one counts
   *  up from there. `excludeId` leaves the session being renamed itself out
   *  of the count. */
  private defaultTitleForRole(ref: EnvRef, role: SessionRole, excludeId?: string): string {
    const sameRole = this.listForTask(ref.workspace, ref.task).filter(
      (s) => s.id !== excludeId && sessionRole(s) === role
    ).length
    return sameRole === 0 ? role : `${role} ${sameRole + 1}`
  }

  /** `info` plus the non-persisted runtime overlay the tree renders as status. */
  private infoWithRuntime(s: Session): SessionInfo {
    return {
      ...s.info,
      busy: s.busy || undefined,
      awaitingInput: s.pendingPermissions.size > 0 || undefined,
      pending: s.pending.length ? s.pending.map(pendingInfo) : undefined,
      queueWaiting: s.recovering ? 'waiting for resume' : this.pendingBlocked(s) ?? (s.info.state === 'queued' ? this.queuedWaiting(s) : undefined)
    }
  }

  private queueTime(s: Session): string {
    return (s.info.state === 'queued' ? s.info.queuedAt : s.pending[0]?.queuedAt) ?? ''
  }

  private queuedSessions(): Session[] {
    return [...this.sessions.values()]
      .filter((s) => s.info.state === 'queued' || (s.info.state === 'started' && s.pending.length > 0))
      .sort((a, b) => this.queueTime(a).localeCompare(this.queueTime(b)))
  }

  /** Earlier work keeps its place on shared clones, including during a limit hold. */
  private earlierQueueItem(s: Session): Session | undefined {
    const claims = this.claims(s)
    for (const other of this.queuedSessions()) {
      if (other === s) break
      if (this.claims(other).some((a) => claims.some((b) =>
        a.key === b.key && (a.exclusive || b.exclusive)))) return other
    }
    return undefined
  }

  private queuePosition(sessionId: string): number | undefined {
    const queued = this.queuedSessions()
    const i = queued.findIndex((s) => s.info.id === sessionId)
    return i < 0 ? undefined : i + 1
  }

  /** Why a queue that has something in it is not moving, when no turn is
   *  running to explain it: the clone is somebody else's. Named, because
   *  "waiting" without a who is the thing that reads as a hang. */
  private pendingBlocked(s: Session): string | undefined {
    if (!s.pending.length || s.busy) return undefined
    const hold = s.info.state === 'started' ? this.limitHold(s) : undefined
    if (hold) return this.holdText(hold)
    const earlier = this.earlierQueueItem(s)
    if (earlier) return `waiting behind session "${earlier.info.title}"`
    if (this.deliveryActive(s)) return 'the review loop is delivering — this sends when it has finished'
    const conflict = this.repoConflict(s)
    if (!conflict) return undefined
    return `session "${conflict.holder.info.title}" has "${conflict.repo}" — this sends as soon as it lets go`
  }

  /** What a queued session is waiting for, when the answer is not the generic
   *  "its turn / its clone": an account at its limit. */
  private queuedWaiting(s: Session): string | undefined {
    const hold = this.limitHold(s)
    if (hold) return this.holdText(hold)
    const earlier = this.earlierQueueItem(s)
    return earlier ? `waiting behind session "${earlier.info.title}"` : undefined
  }

  snapshot(sessionId: string): SessionSnapshot | undefined {
    const s = this.sessions.get(sessionId)
    if (!s) return undefined
    // A started-but-detached session (e.g. restored after a restart, or an env
    // that auto-stopped) has no live surface yet — fall back to the agent cache
    // so the composer still shows its commands/modes and running one wakes it.
    const cached = s.info.agent ? this.agentConfigs.get(s.info.agent) : undefined
    // Never-run agent instance: no live surface AND no cache either — fall
    // back one step further, to the kind's hardcoded seed (e.g. claude-code's
    // model row), so the composer offers a model pick from the first draft on.
    const kind = s.info.agent ? this.agentKinds.get(s.info.agent) : undefined
    return {
      info: this.infoWithRuntime(s),
      entries: s.entries,
      busy: s.busy,
      resuming: s.loading || undefined,
      modes: s.modes ?? cached?.modes,
      plan: s.plan,
      commands: s.commands ?? cached?.commands,
      configOptions:
        s.configOptions ?? cached?.configOptions ?? (kind ? defaultAgentConfig(kind).configOptions : undefined),
      promptCapabilities: this.connections.get(sessionId)?.promptCapabilities ?? cached?.promptCapabilities,
      startError: s.startError,
      queuePosition: this.queuePosition(sessionId),
      waiting: s.info.state === 'queued' ? this.queuedWaiting(s) : undefined,
      pending: s.pending.length ? s.pending.map(pendingInfo) : undefined,
      pendingBlocked: this.pendingBlocked(s),
      proposal: s.proposal,
      usage: s.usage
    }
  }

  // --- lifecycle: create / run / enqueue / cancel / edit / delete ---------

  createSession(
    ref: EnvRef,
    repos: string[],
    agentId: string,
    startPrompt: string,
    action: CreateAction,
    mcp: McpSelection[] = [],
    autoAllow = true,
    configValues: Record<string, string | boolean> = {},
    role: SessionRole = 'executor',
    /** `undefined` = never chosen, which is what the draft's `defaultSkills`
     *  seeding keys on; `[]` = chosen to be none, which it must not overwrite
     *  (docs/requirements-skills.md §4.3). */
    skills: SkillSelection[] | undefined = undefined,
    network?: SessionNetwork,
    /** How each repo is mounted; anything missing or invalid takes the default
     *  (docs/requirements-repo-mounts.md §2). */
    repoModes?: Partial<Record<string, unknown>>
  ): SessionInfo {
    this.assertTaskWritable(ref.workspace, ref.task)
    const clean = sanitizeSessionNetwork(network)
    const modes = normalizeRepoModes(repos, repoModes)
    // Gate 1 of four (docs/requirements-repo-mounts.md §4): a session cannot
    // run or enqueue without the repo its role needs — a `write` one for an
    // executor (the UI disables those, but the IPC boundary enforces it too).
    // A draft is allowed whatever it holds.
    const missing = missingRepoReason({ role, repos, repoModes: modes })
    if ((action === 'run' || action === 'queue') && missing) throw new Error(missing)
    // Named after the role, not a flat "session N" — the role is the one thing
    // every session now declares. First of its role in the task carries no
    // index; each further one counts up from there.
    const title = this.defaultTitleForRole(ref, role)
    const info: SessionInfo = {
      id: randomUUID(),
      lastActivityAt: new Date().toISOString(),
      env: ref.env,
      role,
      repos,
      repoModes: modes,
      task: ref.task,
      workspace: ref.workspace,
      title,
      agent: agentId,
      autoAllow,
      state: 'draft',
      mcp,
      ...(skills ? { skills } : {}),
      // Sanitized here rather than at each caller: this value decides how a
      // container is wired, and it arrives from a renderer form, from an
      // agent's `create_session` (through the spawner's record) and from a
      // duplicate. The sanitizer is also the deep copy, so no two sessions
      // share a policy's domain array.
      //
      // Absent means the defaults (an open bridge, everything logged) — the
      // record only carries the setting once someone has chosen one, so a
      // session created before this existed and one created with the default
      // read the same way everywhere downstream.
      ...(clean ? { network: clean } : {}),
      startPrompt,
      ...(Object.keys(configValues).length ? { configValues } : {})
    }
    this.sessions.set(info.id, {
      info,
      ref,
      records: [],
      lastSeq: 0,
      flushedSeq: 0,
      flushInFlight: false,
      entries: [],
      nextEntryId: 1,
      busy: false,
      pending: [],
      draining: false,
      turnComplete: false,
      turns: 0,
      turnSeq: 0,
      attached: false,
      loading: false,
      pendingPermissions: new Map(),
      turnRejected: false,
      limitStrikes: 0
    })
    this.bus.emit('tree.changed', undefined)
    this.emitState(this.sessions.get(info.id)!, 'created')
    this.schedulePersist(ref)
    if (action === 'queue') this.enqueue(info.id)
    else if (action === 'run') this.startNowOrQueue(info.id)
    return info
  }

  /**
   * Run now — bypass the queue and start immediately, unless the task's
   * `maxConcurrentSessions` cap is already met: a user-initiated "run now" must
   * not blow through the same limit enqueuing exists to protect, so it falls
   * back to the queue exactly like a session the scheduler itself held back.
   */
  private startNowOrQueue(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    const cap = this.taskCaps.get(taskKey(s.ref.workspace, s.ref.task))
    if (cap !== undefined && !this.capExempt(s) && this.activeSessionCount(s.ref.workspace, s.ref.task) >= cap) {
      this.enqueue(sessionId)
      return
    }
    // Same for an account at its limit: the start would only be refused, so it
    // waits in the queue for the reset like everything else on that account.
    if (this.limitHold(s)) {
      this.enqueue(sessionId)
      return
    }
    void this.startSession(sessionId, 'user')
  }

  /** Run now — bypass the queue and start immediately (see {@link startNowOrQueue}
   *  for the one exception: a task already at its concurrency cap). */
  run(sessionId: string): void {
    this.assertSessionWritable(sessionId)
    const s = this.sessions.get(sessionId)
    if (!s || s.info.state === 'starting' || s.info.state === 'started') return
    assertNotTemplate(s.info)
    // Gate 2 (see createSession's gate 1 for the rule).
    const missing = missingRepoReason(s.info)
    if (missing) throw new Error(missing)
    this.startNowOrQueue(sessionId)
  }

  enqueue(sessionId: string): void {
    this.assertSessionWritable(sessionId)
    const s = this.sessions.get(sessionId)
    if (!s || s.info.state === 'starting' || s.info.state === 'started') return
    assertNotTemplate(s.info)
    // Gate 3 (see createSession's gate 1 for the rule).
    const missing = missingRepoReason(s.info)
    if (missing) throw new Error(missing)
    s.info.state = 'queued'
    s.info.queuedAt = new Date().toISOString()
    s.startError = undefined
    this.bus.emit('tree.changed', undefined)
    this.emitState(s, 'user')
    this.schedulePersist(s.ref)
    this.schedule()
  }

  /** Cancel a queued session — back to draft. */
  cancelQueue(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s || s.info.state !== 'queued') return
    s.info.state = 'draft'
    s.info.queuedAt = undefined
    this.bus.emit('tree.changed', undefined)
    this.emitState(s, 'user')
    this.schedulePersist(s.ref)
  }

  editPrompt(sessionId: string, text: string, images?: PromptImage[]): void {
    this.assertSessionWritable(sessionId)
    const s = this.sessions.get(sessionId)
    if (!s || s.info.state !== 'draft') return
    s.info.startPrompt = text
    // Kept in memory only: a draft's images are not worth bloating the persisted
    // session file with megabytes of base64.
    s.startImages = images?.length ? images : undefined
    this.bus.emit('session.changed', { sessionId })
    this.schedulePersist(s.ref)
  }

  /**
   * Edit a draft's settings before it starts. A draft has no env or connection
   * yet, so re-pointing its repo/agent/role is safe — the (env, agent) adapter
   * is resolved only at start, and so are the repos' mounts and locks. Only
   * supplied keys change; unknown ids and non-draft sessions are ignored (which
   * is what makes the role immutable for everything that has run).
   */
  editDraft(
    sessionId: string,
    patch: {
      agent?: string
      env?: string
      role?: SessionRole
      repos?: string[]
      repoModes?: Record<string, RepoMode>
      autoAllow?: boolean
      mcp?: McpSelection[]
      skills?: SkillSelection[]
      network?: SessionNetwork
      startPrompt?: string
      configValues?: Record<string, string | boolean>
      review?: ReviewLoopConfig | null
    }
  ): void {
    this.assertSessionWritable(sessionId)
    const s = this.sessions.get(sessionId)
    if (!s || s.info.state !== 'draft') return
    if (patch.agent !== undefined) {
      // The agent pick is structural, full stop: the mount list depends on the
      // kind even with no skill selected, now that every kind carries its own
      // (possibly empty) `historyPaths` (`AgentManifest`, containers.ts) — switching
      // to or from a kind with a non-empty one changes what gets mounted. A
      // failed start can have left a container provisioned against the old
      // kind's mount list, so any agent change releases it
      // (docs/requirements-agent-history.md §4.2). A draft's history directory
      // is empty and unstarted, so nothing live is ever orphaned by this — a
      // started session cannot reach here, since it cannot change agent.
      if (patch.agent !== s.info.agent) void this.events.releaseContainer(s.info.id, 'user')
      s.info.agent = patch.agent
    }
    if (patch.autoAllow !== undefined) {
      s.info.autoAllow = patch.autoAllow
      // Setting the coarse chip again *is* the user re-choosing, so an earlier
      // fine-grained pick stops outranking it — a draft that has one (a start
      // that failed after its first mode change) would otherwise ignore the
      // chip it was just given and come back up in the old mode.
      s.info.modeId = undefined
    }
    if (patch.mcp !== undefined) s.info.mcp = patch.mcp
    // Takes effect at the next start: the network flag decides how the session's
    // own network is created, and a live one cannot be edited in place (§7.2).
    // Sanitized like the create path — same value, same untrusted sources.
    if (patch.network !== undefined)
      s.info.network = sanitizeSessionNetwork(patch.network) ?? { internal: false }
    if (patch.startPrompt !== undefined) s.info.startPrompt = patch.startPrompt
    if (patch.configValues !== undefined)
      s.info.configValues = Object.keys(patch.configValues).length ? patch.configValues : undefined
    // The Review block (docs/requirements-review-loop.md §3): a draft's own,
    // frozen the moment it leaves draft like every other pick here. A block
    // turns the loop on; `null` turns it off *on purpose*, which the anchor's
    // `review.enabled` default must not undo.
    if (patch.review !== undefined) {
      if (patch.review === null) {
        s.info.review = undefined
        s.info.reviewOff = true
      } else {
        s.info.review = { ...patch.review, ...(patch.review.configValues ? { configValues: { ...patch.review.configValues } } : {}) }
        s.info.reviewOff = undefined
      }
    }
    // absent leaves repos unchanged; never touches the env. Re-pointing repos,
    // their modes, env or role releases the draft's container if a failed
    // start left one — it was provisioned for the old target (a mode decides
    // whether its bind is read-only, so it is as structural as the repo set
    // itself, docs/requirements-repo-mounts.md §2). A repo the patch keeps
    // keeps its mode unless the patch names a new one; a new repo without one
    // takes the default.
    if (patch.repos !== undefined || patch.repoModes !== undefined) {
      const repos = patch.repos ?? s.info.repos
      const modes = normalizeRepoModes(repos, {
        ...Object.fromEntries(s.info.repos.map((r) => [r, repoMode(s.info, r)])),
        ...patch.repoModes
      })
      const changed =
        repos.length !== s.info.repos.length ||
        repos.some((r, i) => r !== s.info.repos[i] || modes[r] !== repoMode(s.info, r))
      if (changed) void this.events.releaseContainer(s.info.id, 'user')
      s.info.repos = repos
      s.info.repoModes = modes
    }
    if (patch.role !== undefined) {
      // The role governs the tool set alone — never the repos, their modes or
      // the env (§4) — but the proactive role reads every repo as `read`, so
      // a change can still re-mount: release whatever a failed start left.
      const prevRole = sessionRole(s.info)
      if (patch.role !== prevRole) void this.events.releaseContainer(s.info.id, 'user')
      // The title still reads as the auto-generated default (e.g. "executor",
      // untouched by the user) — carry it along to the new role instead of
      // leaving it stuck reading like the old one.
      if (isDefaultSessionTitle(s.info.title, prevRole))
        s.info.title = this.defaultTitleForRole(s.ref, patch.role, s.info.id)
      s.info.role = patch.role
      // The Review block is an executor's (docs/requirements-review-loop.md
      // §3): a draft that stops being one drops it rather than carry a loop
      // that nothing would run (`Kernel.editDraft` already refuses a block in
      // a patch that makes the draft something else).
      if (patch.role !== 'executor') {
        s.info.review = undefined
        s.info.reviewOff = undefined
      }
    }
    // Structural like repos/env/role, not a runtime knob: the skills bind is
    // part of the container's mount list, decided when it is created. A failed
    // start can have left one provisioned against the previous selection, so a
    // change here has to release it (docs/requirements-skills.md §5.2).
    if (patch.skills !== undefined) {
      const before = (s.info.skills ?? []).map((k) => k.name).join('\u0000')
      const after = patch.skills.map((k) => k.name).join('\u0000')
      if (before !== after) void this.events.releaseContainer(s.info.id, 'user')
      // `[]` is written as `[]`, not cleared: it is the user saying "none", and
      // clearing it back to absent would have the draft re-seed the workspace's
      // defaults over the choice they just made.
      s.info.skills = patch.skills
    }
    if (patch.env !== undefined && patch.env !== s.info.env) {
      void this.events.releaseContainer(s.info.id, 'user')
      s.info.env = patch.env
      s.ref = { ...s.ref, env: patch.env }
    }
    this.bus.emit('tree.changed', undefined)
    this.bus.emit('session.changed', { sessionId })
    this.schedulePersist(s.ref)
  }

  /**
   * Copy a session into a fresh **draft** of the same task. Everything the user
   * configured comes along — role, env, repos, agent, MCP/git/auto-allow, the
   * config picks and the first prompt — and nothing runtime-derived does: a
   * draft has no container, no chat, no ACP session and no queue slot, whatever
   * state the source is in. That is what makes this the fix for a session
   * configured wrong: correct the copy, then delete the original (or leave it,
   * they share nothing but the clone every session of the task shares anyway).
   */
  duplicateSession(sessionId: string): SessionInfo {
    const source = this.sessions.get(sessionId)?.info
    if (!source) throw new Error('unknown session')
    assertNotLoopOwned(source)
    const info = this.draftFrom(source)
    // The copy is recognisable as one instead of taking the next free
    // role-index name — the source is usually still in the tree right above it.
    this.renameSession(info.id, `${source.title} (copy)`)
    log.info('session.duplicated', { s: info.id, from: sessionId })
    return info
  }

  /**
   * Turn a session that has left draft back into one — "I launched it, then
   * saw it was set up wrong". The run is discarded whole (container, adapter,
   * host servers, queued prompts, chat log, mount scratch, agent history): this
   * is {@link duplicateSession} followed by {@link deleteSession}, with the
   * draft keeping the original's title and its place in the task.
   *
   * A new id rather than a reset of the old record, on purpose: everything the
   * run owned is keyed by the session id, and much of it is torn down
   * asynchronously — the container release (and the scratch/history directory
   * removed only once it is down), an in-flight log append, a start still
   * awaiting its container. Reusing the id would let any of those land on the
   * fresh draft (old chat records appended to its new log, its first start
   * mounting a scratch dir about to be deleted). A new id makes the result
   * exactly a freshly created draft with that configuration, and lets the
   * delete path — the one already trusted with a session in any state,
   * busy or starting included — do all of the teardown.
   *
   * Refused for a draft: there is no run to discard, and the "fresh" draft
   * would only lose the draft's in-memory start images.
   */
  recreateSession(sessionId: string): SessionInfo {
    this.assertSessionWritable(sessionId)
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error('unknown session')
    if (s.info.state === 'draft') throw new Error('session is already a draft')
    assertNotLoopOwned(s.info)
    const source = s.info
    const at = [...this.sessions.keys()].indexOf(sessionId)
    const info = this.draftFrom(source)
    this.renameSession(info.id, source.title)
    this.deleteSession(sessionId)
    // Back into the original's slot (the tree lists a task's sessions in this
    // map's order), so the row does not jump to the bottom of its task. Before
    // the debounced persist fires, so sessions.json keeps that order too.
    const fresh = this.sessions.get(info.id)
    if (fresh) {
      const rest = [...this.sessions].filter(([id]) => id !== info.id)
      rest.splice(at, 0, [info.id, fresh])
      this.sessions = new Map(rest)
      this.bus.emit('tree.changed', undefined)
    }
    log.info('session.recreated', { s: info.id, from: sessionId })
    return info
  }

  /** A fresh draft of the same task carrying everything the user configured on
   *  `source`, and nothing runtime-derived (see {@link duplicateSession}). */
  private draftFrom(source: SessionInfo): SessionInfo {
    const copy = this.createSession(
      { workspace: source.workspace, task: source.task, env: source.env },
      [...source.repos],
      source.agent ?? '',
      source.startPrompt,
      'draft',
      source.mcp ? [...source.mcp] : [],
      source.autoAllow ?? true,
      { ...(source.configValues ?? {}) },
      sessionRole(source),
      // Copied element by element, and `undefined` kept as `undefined`: the
      // records are the copy's own, and a source that deliberately chose no
      // skills must not have the workspace's defaults seeded back into its copy.
      source.skills?.map((k) => ({ ...k })),
      // Through the sanitizer, which is also the deep copy: the two sessions
      // must not share a policy's domain array.
      sanitizeSessionNetwork(source.network),
      Object.fromEntries(source.repos.map((r) => [r, repoMode(source, r)]))
    )
    // The Review block comes along (docs/requirements-review-loop.md §3), as
    // a copy of its own; a block switched off on purpose stays off.
    if (source.review)
      copy.review = { ...source.review, ...(source.review.configValues ? { configValues: { ...source.review.configValues } } : {}) }
    if (source.reviewOff) copy.reviewOff = true
    return copy
  }

  /**
   * Delete a session in any state — including one that is running or still
   * starting, which is the whole point: a session configured wrong is usually
   * noticed after it has begun. Everything the session owns goes with it (its
   * container, its adapter, its host servers, its chat log, its mount scratch);
   * the clone and the uncommitted work in it deliberately stay, since a clone
   * outlives every session of its task.
   */
  deleteSession(sessionId: string): void {
    this.assertSessionWritable(sessionId)
    const s = this.sessions.get(sessionId)
    if (!s) return
    for (const resolve of s.pendingPermissions.values())
      resolve({ outcome: { outcome: 'cancelled' } })
    // The container is bound to this session — take it down with the session.
    // Before the record goes: the container manager finds the container through
    // this map, so a session dropped first would leave its container orphaned
    // until the next boot reconcile.
    const { workspace, task } = s.ref
    void this.events
      .releaseContainer(sessionId, 'session-deleted')
      // Only once the container is gone: its bind mounts are staged inside that
      // directory, so removing it any earlier races the daemon.
      .then(() => this.events.deleteScratch(workspace, task, sessionId))
    this.sessions.delete(sessionId)
    this.loopHolds.delete(sessionId)
    // Its correspondence table goes with it — the tokens it produced end here.
    this.mask.drop(sessionId)
    stopPiiRewrite(sessionId)
    this.events.deleteLog(s.ref.workspace, s.ref.task, sessionId)
    this.events.stopGurtServer(sessionId)
    this.bus.emit('session.deleted', { sessionId })
    this.schedulePersist(s.ref)
    this.bus.emit('tree.changed', undefined)
    // Its clone may now be free — let the next queued session take it.
    this.schedule()
  }

  // --- scheduler ----------------------------------------------------------

  /**
   * Walk the global FIFO queue and start every item whose start condition
   * currently holds. Items for independent repos may start in one pass; a repo
   * occupied by a just-started item keeps its later items queued.
   */
  schedule(): void {
    this.scheduleSync()
  }

  private scheduleSync(): void {
    const queued = this.queuedSessions()
    // A pass may start several items; record each started item's clone claims
    // (key → exclusive?) so a later item over the same clone stays queued. A
    // blocked item reserves its claims here too: FIFO by clone, so nothing
    // behind it overtakes it on any of them (docs/requirements-repo-mounts.md
    // §2.1) — a stream of readers cannot starve a waiting writer.
    const claimed = new Map<string, boolean>()
    const reserve = (claims: Claim[]): void => {
      for (const c of claims) claimed.set(c.key, c.exclusive || claimed.get(c.key) === true)
    }
    // Same idea, per task: a pass may start several items of a capped task, so
    // each start counts against the cap for the rest of this same pass rather
    // than only against `activeSessionCount`'s (pre-pass) snapshot.
    const startedThisPass = new Map<string, number>()
    const still = new Set<string>()
    const holds: PlanHold[] = []
    for (const s of queued) {
      if (this.frozenTasks.has(taskKey(s.ref.workspace, s.ref.task))) continue
      // Reserve the shared clones while waiting; independent work can still run.
      const hold = this.limitHold(s)
      if (hold) {
        still.add(s.info.id)
        holds.push(hold)
        this.noteQueued(s, 'agent-limited', hold.until)
        reserve(this.claims(s))
        continue
      }
      if (s.info.state === 'started') {
        reserve(this.claims(s))
        void this.drainPending(s)
        continue
      }
      const tkey = taskKey(s.ref.workspace, s.ref.task)
      const cap = this.taskCaps.get(tkey)
      if (cap !== undefined && !this.capExempt(s)) {
        const running = this.activeSessionCount(s.ref.workspace, s.ref.task) + (startedThisPass.get(tkey) ?? 0)
        if (running >= cap) {
          still.add(s.info.id)
          this.noteQueued(s, 'task-at-cap')
          continue
        }
      }
      // An exempt start still counts for the sessions behind it in this pass.
      const start = (): void => {
        if (cap !== undefined) startedThisPass.set(tkey, (startedThisPass.get(tkey) ?? 0) + 1)
        this.queuedReasons.delete(s.info.id)
        void this.startSession(s.info.id, 'scheduler')
      }
      if (missingRepoReason(s.info)) {
        // Still waiting too — kept in `still` so the cleanup below doesn't
        // erase the reason and re-log it on every schedule() pass.
        still.add(s.info.id)
        this.noteQueued(s, 'no-repo')
        continue
      }
      // A session whose repos are all `read` (or that holds none) claims no
      // clone — start it unconditionally, same pass, no FIFO contention to
      // resolve. Anything else takes all of its claims or none.
      const claims = this.claims(s)
      if (claims.some((c) => claimed.has(c.key) && (c.exclusive || claimed.get(c.key) === true))) {
        still.add(s.info.id)
        reserve(claims)
        this.noteQueued(s, 'repo-claimed-this-pass')
        continue
      }
      const conflict = this.repoConflict(s)
      if (conflict) {
        still.add(s.info.id)
        reserve(claims)
        this.noteQueued(s, 'repo-held', conflict.holder.info.id)
        continue
      }
      reserve(claims)
      start()
    }
    // Forget the reason of anything no longer waiting, so a session that queues
    // again later reports why from scratch.
    for (const id of [...this.queuedReasons.keys()]) {
      if (still.has(id)) continue
      this.queuedReasons.delete(id)
      // The pane may be showing a limit wait that just ended.
      this.bus.emit('session.changed', { sessionId: id })
    }
    this.armLimitTimer(holds)
  }

  /**
   * "Why is this still queued" — logged at INF, but only when the answer
   * changes: `schedule()` runs on every container transition, and repeating an
   * unchanged reason would bury the transitions themselves.
   */
  private noteQueued(s: Session, reason: string, by?: string): void {
    const key = `${reason}:${by ?? ''}`
    if (this.queuedReasons.get(s.info.id) === key) return
    this.queuedReasons.set(s.info.id, key)
    log.info('session.queued', { s: s.info.id, reason, by })
    // The pane spells some of these out (`waiting`) — it has to hear of a change.
    this.bus.emit('session.changed', { sessionId: s.info.id })
  }

  /** The clones a session claims — `(task, repo)`, shared by every session of
   *  the task that picked that repo: exclusive for a `write` mount, shared for a
   *  `read-locked` one, none for `read` (docs/requirements-repo-mounts.md §2.1).
   *  Empty for a session that holds no repo or only reads live trees. */
  private claims(s: Session): Claim[] {
    const out: Claim[] = []
    for (const repo of s.info.repos) {
      const mode = repoMode(s.info, repo)
      if (mode === 'read') continue
      out.push({ key: `${taskKey(s.ref.workspace, s.ref.task)}/${repo}`, repo, exclusive: mode === 'write' })
    }
    return out
  }

  /**
   * The other session currently holding one of this session's clones in a way
   * that excludes it, and which clone — readers–writer per clone: two claims
   * conflict when at least one of them is exclusive.
   *
   * A clone is one working tree shared by every session of the task that picked
   * that repo. "Holding it" means mid-start, or owning a container that is up:
   * an idle session whose container has been auto-stopped holds nothing and
   * releases the repo for the next one — which is how a task runs a series of
   * sessions against the same repo without deleting the finished ones.
   *
   * The env is *not* a constraint. Each session owns its container, so any
   * number of sessions may run the same env definition at once.
   */
  private repoConflict(s: Session): { holder: Session; repo: string } | undefined {
    const mine = this.claims(s)
    if (!mine.length) return undefined
    for (const o of this.sessions.values()) {
      if (o.info.id === s.info.id || !this.holdsClone(o)) continue
      for (const theirs of this.claims(o)) {
        const c = mine.find((m) => m.key === theirs.key)
        if (c && (c.exclusive || theirs.exclusive)) return { holder: o, repo: c.repo }
      }
    }
    return undefined
  }

  /** {@link repoConflict}'s holder alone — for the callers that only ask "may
   *  this session touch its clones right now". */
  private repoHolder(s: Session): Session | undefined {
    return this.repoConflict(s)?.holder
  }

  /** "Able to touch its clone / count against its task's cap": mid-start, or
   *  owning a container that is up. An idle session whose container has been
   *  auto-stopped holds nothing — shared by {@link holdsClone} and {@link
   *  activeSessionCount}. */
  private isActive(s: Session): boolean {
    const live = s.info.container?.status
    const busyContainer = live === 'building' || live === 'post' || live === 'running'
    return s.info.state === 'starting' || busyContainer
  }

  /** {@link isActive}, or held by the review loop: a held executor keeps its
   *  claims with its container down (docs/requirements-review-loop.md §5.5), so
   *  no other session takes the clone out from under a loop that will wake it.
   *  Deliberately not what the task cap counts — held with its container down
   *  it costs no slot — nor what the queue handoff may stop. */
  private holdsClone(s: Session): boolean {
    return this.isActive(s) || this.loopHolds.has(s.info.id)
  }

  /** Sessions of `(ws, task)` currently active (see {@link isActive}) —
   *  what a `maxConcurrentSessions` cap counts against. */
  private activeSessionCount(ws: string, task: string): number {
    let n = 0
    for (const o of this.sessions.values())
      if (o.ref.workspace === ws && o.ref.task === task && this.isActive(o)) n++
    return n
  }

  /** A review loop's reviewer never waits on its scope's
   *  `maxConcurrentSessions` (docs/requirements-review-loop.md §5.4): the idle
   *  executor it reviews still occupies a slot, so at a cap of 1 it would queue
   *  forever. It still counts as active for every other session. */
  private capExempt(s: Session): boolean {
    return roleIsLoopOwned(sessionRole(s.info))
  }

  /** Seed the per-task cap cache from disk. Called once at boot, before the
   *  scheduler's first pass — mirrors `review.load()`. */
  loadTaskCaps(entries: { ws: string; task: string; max?: number | undefined }[]): void {
    this.taskCaps.clear()
    for (const { ws, task, max } of entries)
      if (max) this.taskCaps.set(taskKey(ws, task), max)
  }

  /** Set or clear one task's cap (0/undefined = unlimited) after an edit is
   *  persisted, and re-run the scheduler — raising or clearing a cap may free
   *  sessions the queue was holding back. */
  setTaskCap(ws: string, task: string, max: number | undefined): void {
    const key = taskKey(ws, task)
    if (max) this.taskCaps.set(key, max)
    else this.taskCaps.delete(key)
    this.schedule()
  }

  /**
   * The session currently claiming this clone, addressed by (task, repo) rather
   * than by another session — a writer before any reader. Same "able to touch
   * it" rule as {@link repoConflict}: an idle session whose container is down
   * holds nothing and is not reported — unless the review loop holds it
   * ({@link holdsClone}).
   */
  repoHolderFor(ws: string, task: string, repo: string): SessionInfo | undefined {
    const want = `${taskKey(ws, task)}/${repo}`
    let reader: SessionInfo | undefined
    for (const o of this.sessions.values()) {
      if (!this.holdsClone(o)) continue
      const c = this.claims(o).find((k) => k.key === want)
      if (c?.exclusive) return o.info
      if (c) reader ??= o.info
    }
    return reader
  }

  /**
   * Sessions whose live container is the only thing keeping a queued session
   * off its clone *or* off its task's `maxConcurrentSessions` slot, and which
   * are not themselves working — the environments nobody is claiming right
   * now. The queue handoff (kernel.ts) stops these immediately rather than
   * letting them sit out the idle grace period, which is what turns "waiting
   * for a repo/slot" from ten minutes into seconds.
   *
   * A holder that is mid-start or mid-turn is doing real work and is never
   * listed: the queue waits for it exactly as before. Empty queue → empty list,
   * so with nothing waiting the plain idle policy applies untouched.
   *
   * The task-cap half is deliberately loose, same as the repo half: any idle
   * running session of a capped task with something queued is listed, whether
   * or not stopping it actually clears *this* queued item's way (it may be
   * blocked by something else too) — an idle container was
   * headed down on its own regardless, so reaping it a little early never
   * costs anything.
   */
  holdersBlockingQueue(): string[] {
    // clone key → wanted exclusively? A holder blocks only a claim it conflicts
    // with: a reader is never reaped for another reader.
    const wantedRepos = new Map<string, boolean>()
    const want = (s: Session): void => {
      for (const c of this.claims(s)) wantedRepos.set(c.key, c.exclusive || wantedRepos.get(c.key) === true)
    }
    const wantedTasks = new Set<string>()
    for (const s of this.sessions.values()) {
      if (s.info.state !== 'queued') {
        // A started session with a prompt waiting on a clone somebody else is
        // sitting on is queueing in everything but the state: it wants exactly
        // what a queued draft wants, and the same handoff is what gives it.
        // Without this its message waits out the idle grace period instead.
        if (s.pending.length && !s.busy && this.repoHolder(s)) want(s)
        continue
      }
      want(s)
      const tkey = taskKey(s.ref.workspace, s.ref.task)
      // A queued reviewer waits for a plan hold at most, never for a slot, so
      // it must not make the handoff stop its executor for one.
      if (this.taskCaps.has(tkey) && !this.capExempt(s)) wantedTasks.add(tkey)
    }
    if (!wantedRepos.size && !wantedTasks.size) return []
    const out: string[] = []
    for (const o of this.sessions.values()) {
      // A queued holder is the scheduler's business, not the reaper's: it owns
      // a container it is about to start into.
      if (o.info.state === 'queued' || o.info.state === 'starting' || o.busy) continue
      // The loop's executor keeps its container up for the check and the next
      // turn (docs/requirements-review-loop.md §5.5) — a handoff would stop it.
      if (this.loopHolds.has(o.info.id)) continue
      // Only a fully-up container is stoppable — one still building/post is
      // mid-provision, and `starting` above already covers its session.
      if (o.info.container?.status !== 'running') continue
      const tkey = taskKey(o.ref.workspace, o.ref.task)
      const blocks = this.claims(o).some(
        (c) => wantedRepos.has(c.key) && (c.exclusive || wantedRepos.get(c.key) === true)
      )
      if (blocks || wantedTasks.has(tkey)) out.push(o.info.id)
    }
    return out
  }

  /**
   * Say so when a selected MCP server did not make it into the descriptors the
   * agent is about to receive — the scope the session got is not the scope the
   * user picked, and the difference is otherwise invisible from the outside.
   *
   * Both sources are routed now (built-ins through gurt's host listeners,
   * registry entries straight from the proxy), so landing here means the id did
   * not resolve at all: the workspace no longer offers it, or its credential
   * refused to resolve — an unresolvable credential blocks, it never falls back
   * to an unauthenticated call. `attachMcp` logs the reason immediately above.
   *
   * Rides the session's provisioning log, where the rest of "what happened on
   * the way up" is written.
   */
  private noteUnattachedMcp(s: Session, attached: AcpHttpMcpServer[]): void {
    for (const sel of s.info.mcp ?? []) {
      if (attached.some((m) => m.name === sel.id)) continue
      this.bus.emit('provision.log', {
        key: s.info.id,
        line: `[mcp] "${sel.id}" is selected but is not in this session's scope — the agent will not see it`
      })
    }
  }

  /**
   * Everything the agent needs to reach an MCP server, in the order it has to
   * happen (docs/requirements-mcp-proxy.md §4.3, §5.3):
   *
   *   1. gurt's own host listeners come up (`github`, `gurt`), each on its own
   *      port with its own token — the `host` upstreams of the scope below;
   *   2. the scope is built from the session's selection resolved against the
   *      workspace registry and the credential store, and *pushed to the proxy*;
   *   3. the descriptors the agent receives are returned — every one of them a
   *      `http://gurt-proxy:8100/mcp/<token>/<id>` URL.
   *
   * So the session container holds a URL and an opaque token, and never an MCP
   * credential, never a host token, and never an upstream address (§2). It runs
   * before the adapter is spawned, on both the start and the resume path, which
   * is also what makes a scope edit mid-session take effect on the next attach.
   */
  private async attachMcp(s: Session, ctx: LaunchContext): Promise<AcpHttpMcpServer[]> {
    const hosted = [
      ...(await this.events.resolveMcpServers(s.ref, s.info.id, anchorRepo(s.info), s.info.mcp)),
      await this.events.resolveGurtServer(s.ref, s.info.id, this.gurtHooks(s))
    ]
    // A masking session's MCP traffic is rewritten at the proxy (§9.2) through
    // the host's endpoint; any other session's is forwarded as it always was.
    let piiUrl: string | undefined
    if (this.maskEnabled()) piiUrl = await servePiiRewrite(s.info.id, this.mask)
    else stopPiiRewrite(s.info.id)
    const plan = await resolveProxyPlan(s.ref, s.info.id, ctx.proxy.token, s.info.mcp, {
      piiUrl,
      // One URL per built-in, because gurt still runs one listener per (session,
      // mcp id); §10.4 collapses these into a single `hostMcpUrl`.
      hostMcpUrls: Object.fromEntries(hosted.map((m) => [m.name, m.url])),
      network: s.info.network,
      proxyBase: ctx.proxy.base
    })
    for (const line of plan.errors)
      this.bus.emit('provision.log', { key: s.info.id, line: `[mcp] ${line}` })
    await this.events.pushProxyScope(s.info.id, plan.config)
    this.noteUnattachedMcp(s, plan.mcpServers)
    return plan.mcpServers
  }

  /**
   * Stage this session's skills on the host, and say on its provision log which
   * selected names resolved to nothing.
   *
   * Reported rather than thrown, the way `resolveProxyPlan`'s errors are: a
   * skill deleted behind a draft is the user's to notice and fix, and refusing
   * to start over it would strand the session on a problem the picker already
   * shows as an error row (docs/requirements-skills.md §4.4).
   */
  private async materializeSkills(s: Session): Promise<void> {
    if (!s.info.skills?.length) return
    const { missing } = await this.events.materializeSkills(
      s.ref.workspace,
      s.ref.task,
      s.info.id,
      s.info.skills
    )
    for (const name of missing)
      this.bus.emit('provision.log', {
        key: s.info.id,
        line: `[skills] "${name}" is not in this workspace's registry — not mounted`
      })
  }

  /** Provision (if needed), open the ACP session, and send the start prompt. */
  private async startSession(sessionId: string, by: 'user' | 'scheduler'): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s || s.info.state === 'starting' || s.info.state === 'started') return
    this.bus.emit('session.activity', { sessionId: s.info.id })
    s.info.state = 'starting'
    s.info.queuedAt = undefined
    s.startError = undefined
    s.startedAt = Date.now()
    s.turns = 0
    this.bus.emit('tree.changed', undefined)
    this.emitState(s, by)
    this.bus.emit('session.changed', { sessionId })
    try {
      // Gate 4: every start path funnels here, so the gate is checked once,
      // here — the scheduler pre-checks it to pick queue items, "Run now"
      // doesn't need to. Only the roles that need a repo are refused one-less.
      const missing = missingRepoReason(s.info)
      if (missing) throw new Error(missing)
      assertNotTemplate(s.info)
      const conflict = this.repoConflict(s)
      if (conflict)
        throw new Error(
          `repository "${conflict.repo}" is in use by session "${conflict.holder.info.title}" — queue this one instead`
        )
      // Before the container is resolved: `resolveLaunch` provisions it, and
      // the read-only bind it adds points at the directory this call fills
      // (docs/requirements-skills.md §5). Re-run on every start, so a skill
      // edited in Settings between two starts of the same draft is delivered as
      // it is now.
      await this.materializeSkills(s)
      const ctx = await this.events.resolveLaunch(s.info.id)
      s.remoteCwd = ctx.remoteWorkspaceFolder
      // Before the adapter, not after: the agent must never observe a proxy
      // that has no scope, and its environment names that proxy from its first
      // instruction.
      const mcpServers = await this.attachMcp(s, ctx)
      const conn = await this.connection(s, ctx)
      // Picks the adapter reads from `_meta` (model/effort, for one that does)
      // ride it so the very first turn already runs on them; any other picks
      // (e.g. fast mode) are reconciled below, before the prompt.
      const meta = this.startMeta(ctx.agent, s.info.configValues)
      const result = await conn.peer.request(
        'session/new',
        {
          cwd: ctx.remoteWorkspaceFolder,
          mcpServers,
          ...(meta ? { _meta: meta } : {})
        },
        SESSION_NEW_RESULT,
        { timeoutMs: ACP_REQUEST_TIMEOUT_MS }
      )
      s.acpSessionId = result.sessionId
      s.modes = normalizeModes(result.modes) ?? s.modes
      s.configOptions = normalizeConfigOptions(result.configOptions, ctx.agent.id)
      s.attached = true
      s.info.state = 'started'
      await this.applyStartConfig(s, conn)
      this.cacheAgentConfig(s)
      await this.applyAutoAllow(s, conn)
      this.bus.emit('tree.changed', undefined)
      this.emitState(s, by)
      this.schedulePersist(s.ref)
      const startImages = s.startImages
      s.startImages = undefined
      await this.runPrompt(s, s.info.startPrompt, undefined, startImages)
    } catch (e) {
      // Deleted while the start was in flight (the user saw the misconfigured
      // session go up and pulled it). The delete already took down everything
      // that existed by then, and the container manager removes one that came
      // up after it — so there is no state left to fail into, and nothing to
      // announce about a session the tree no longer has.
      if (this.sessions.get(sessionId) !== s) return
      const message = e instanceof Error ? e.message : String(e)
      s.info.state = 'draft'
      s.info.queuedAt = undefined
      s.startError = message
      this.push(s, { kind: 'system', text: `start failed: ${message}` })
      this.bus.emit('tree.changed', undefined)
      this.emitState(s, 'start-failed', e)
      this.schedulePersist(s.ref)
      // A failed start must not block the queue — let the next item try.
      this.schedule()
    }
  }

  // --- connections --------------------------------------------------------

  /**
   * Drop everything this session's container backs: the ACP adapter running
   * inside it and the host MCP servers pointed at its clone. Called by the
   * container manager immediately *before* the container is stopped or removed,
   * which is the whole reason nothing container-derived can go stale — there is
   * one such path, and it runs first.
   */
  detach(sessionId: string): void {
    const conn = this.connections.get(sessionId)
    const s = this.sessions.get(sessionId)
    // Only a live adapter's death is "expected" here — with no connection,
    // there is nothing about to close, so this call is not the cause of one.
    if (conn) {
      conn.expectedExit = true
      conn.kill()
    }
    this.events.stopMcpServers(sessionId)
    if (s) s.attached = false
  }

  /** Read a session's persisted info (the container manager's view of it). */
  sessionInfo(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId)?.info
  }

  /** Every live session's info — the boot reconcile and task teardown walk these. */
  allSessions(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info)
  }

  /**
   * Write the session's container record. The container manager owns the
   * contents; the session owns the storage, since the container is a field of
   * the session and is persisted and deleted with it.
   */
  patchContainer(sessionId: string, container: SessionContainer | undefined): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    if (container) s.info.container = container
    else delete s.info.container
    this.bus.emit('session.changed', { sessionId })
    this.schedulePersist(s.ref)
  }

  /** Forget sessions of a whole task without persisting (task dir is removed).
   *  A pending debounced persist for the task is cancelled first: the container
   *  teardown that precedes this schedules one (a session's container record is
   *  cleared), and left alone it fires after the directory is gone — silently
   *  resurrecting the deleted task with an empty sessions.json. */
  dropTaskSessions(ws: string, task: string): void {
    const key = taskKey(ws, task)
    clearTimeout(this.persistTimers.get(key))
    this.persistTimers.delete(key)
    for (const [id, s] of this.sessions) {
      if (s.ref.workspace !== ws || s.ref.task !== task) continue
      this.detach(id)
      this.events.stopGurtServer(id)
      this.mask.drop(id)
      stopPiiRewrite(id)
      this.sessions.delete(id)
      this.loopHolds.delete(id)
      this.bus.emit('session.deleted', { sessionId: id })
    }
    this.bus.emit('tree.changed', undefined)
  }

  /** Same as {@link dropTaskSessions}, scaled up to every task in the
   *  workspace — the whole workspace directory is about to go. */
  dropWorkspaceSessions(ws: string): void {
    const prefix = `${ws}/`
    for (const [key, timer] of this.persistTimers) {
      if (!key.startsWith(prefix)) continue
      clearTimeout(timer)
      this.persistTimers.delete(key)
    }
    for (const [id, s] of this.sessions) {
      if (s.ref.workspace !== ws) continue
      this.detach(id)
      this.events.stopGurtServer(id)
      this.mask.drop(id)
      stopPiiRewrite(id)
      this.sessions.delete(id)
      this.loopHolds.delete(id)
      this.bus.emit('session.deleted', { sessionId: id })
    }
    this.bus.emit('tree.changed', undefined)
  }

  /** Live sessions of the task, projected to their persisted shape. */
  private recordsFor(ws: string, task: string): PersistedSession[] {
    return this.sessionsFor(ws, task).map((s) => {
      const info = { ...s.info }
      // `starting` is runtime-only; persist it as draft (crash-safe).
      if (info.state === 'starting') {
        info.state = 'draft'
        info.queuedAt = undefined
      }
      // `incomplete` is a runtime overlay — never persisted.
      delete info.incomplete
      return {
        info,
        acpSessionId: s.acpSessionId,
        proposal: s.proposal,
        ...(s.lastSettled ? { lastSettled: structuredClone(s.lastSettled) } : {}),
        ...(s.loopRan ? { loopRan: s.loopRan } : {}),
        interrupted: s.interrupted,
        pending: structuredClone(s.pending)
      }
    })
  }

  private sessionsFor(ws: string, task: string): Session[] {
    const key = taskKey(ws, task)
    return [...this.sessions.values()].filter((s) => taskKey(s.ref.workspace, s.ref.task) === key)
  }

  private async persistNow(s: Session): Promise<void> {
    await this.events.persist(s.ref.workspace, s.ref.task, this.recordsFor(s.ref.workspace, s.ref.task))
  }

  /** Wait for buffered state and history before an intentional update restart. */
  async flushForRestart(): Promise<void> {
    await this.flushSessions([...this.sessions.values()])
  }

  async flushTask(ws: string, task: string): Promise<void> {
    const key = taskKey(ws, task)
    clearTimeout(this.persistTimers.get(key))
    this.persistTimers.delete(key)
    await this.flushSessions(this.sessionsFor(ws, task))
  }

  private async flushSessions(sessions: Session[]): Promise<void> {
    for (const s of sessions) {
      await this.persistNow(s)
      while (s.flushInFlight) await new Promise((resolve) => setTimeout(resolve, 10))
      this.flushLog(s)
      while (s.flushInFlight) await new Promise((resolve) => setTimeout(resolve, 10))
      if (s.flushedSeq < s.lastSeq) throw new Error('Could not save session history before restart')
    }
  }

  private frozenTasks = new Set<string>()

  assertTaskWritable(ws: string, task: string): void {
    if (this.frozenTasks.has(taskKey(ws, task))) throw new Error('Scope is being archived')
  }

  private assertSessionWritable(id: string): void {
    const s = this.sessions.get(id)
    if (s) this.assertTaskWritable(s.ref.workspace, s.ref.task)
  }

  async withTaskFrozen<T>(ws: string, task: string, action: () => Promise<T>): Promise<T> {
    this.assertTaskWritable(ws, task)
    this.frozenTasks.add(taskKey(ws, task))
    try { return await action() } finally { this.frozenTasks.delete(taskKey(ws, task)) }
  }

  noteTaskActivity(ws: string, task: string): void {
    const sessions = this.sessionsFor(ws, task)
    if (!sessions.length) return
    for (const s of sessions) s.info.lastActivityAt = new Date().toISOString()
    this.schedulePersist(sessions[0]!.ref)
  }

  taskHasPendingWork(ws: string, task: string): boolean {
    // A live review loop is work too: nothing is queued or running at the
    // moment of a check, but the loop owns the clones (§5.6).
    if (this.loopHooks?.live(ws, task) === true) return true
    return this.sessionsFor(ws, task).some((s) => s.busy || s.draining || s.loading || s.promptRunning ||
      s.pendingPermissions.size > 0 || s.pending.length > 0 || s.recovering ||
      s.info.state === 'starting' || s.info.state === 'queued' || !!s.info.limitedUntil || !!s.startImages?.length)
  }

  /** Archive retirement preserves the log/history until the archive is verified. */
  dropArchivedSession(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    this.detach(id)
    this.events.stopGurtServer(id)
    this.mask.drop(id)
    stopPiiRewrite(id)
    this.sessions.delete(id)
    this.loopHolds.delete(id)
    this.schedulePersist(s.ref)
    this.bus.emit('session.deleted', { sessionId: id })
    this.bus.emit('tree.changed', undefined)
  }

  setArchiveRead(marks: Record<string, string>): void {
    for (const [id, stamp] of Object.entries(marks)) {
      const s = this.sessions.get(id)
      if (!s || this.frozenTasks.has(taskKey(s.ref.workspace, s.ref.task))) continue
      s.info.archiveSeenAt = stamp === 'unread' ? undefined :
        Number.isFinite(Date.parse(stamp)) ? stamp : s.info.archiveSeenAt
      this.schedulePersist(s.ref)
    }
  }

  interruptedSessions(): InterruptedSession[] {
    // A loop's sessions are resumed by its controller (docs/requirements-review-
    // loop.md §8): enabling the loop was the approval, so no modal asks again.
    return [...this.sessions.values()].filter((s) => s.recovering && s.info.state === 'started' && !this.loopOwned(s))
      .map(({ info }) => ({ id: info.id, title: info.title, workspace: info.workspace, task: info.task }))
  }

  hasUnfinishedWork(): boolean {
    // Not a loop's own: an update restart does not wait for a loop, whose
    // controller resumes it afterwards (§8).
    return [...this.sessions.values()].some((s) => !this.loopOwned(s) && (s.busy || s.draining || s.loading || s.promptRunning ||
      s.pendingPermissions.size > 0 || s.pending.length > 0 || s.recovering ||
      s.info.state === 'starting' || s.info.state === 'queued' || !!s.info.limitedUntil))
  }

  async resumeInterrupted(id: string): Promise<void> {
    const s = this.sessions.get(id)
    if (!s?.recovering || s.recoveryStarting || s.info.state !== 'started') return
    s.recoveryStarting = true
    const previous = [...s.pending]
    const wasInterrupted = s.interrupted
    try {
      if (s.interrupted) {
        s.pending.unshift({
          id: `p${++this.pendingSeq}`,
          auto: true,
          queuedAt: s.pending[0]?.queuedAt ?? new Date().toISOString(),
          text: 'The application restarted during your previous turn. Resume the unfinished task using the existing conversation. First inspect the current state: actions may already have completed. Do not repeat completed actions. Request any necessary permissions again.'
        })
      }
      s.interrupted = false
      await this.persistNow(s)
      s.recovering = false
      void this.drainPending(s)
    } catch (err) {
      s.pending = previous
      s.interrupted = wasInterrupted
      throw err
    } finally {
      s.recoveryStarting = false
    }
  }

  private schedulePersist(ref: EnvRef): void {
    const key = taskKey(ref.workspace, ref.task)
    clearTimeout(this.persistTimers.get(key))
    this.persistTimers.set(
      key,
      setTimeout(() => {
        void Promise.resolve(this.events.persist(ref.workspace, ref.task, this.recordsFor(ref.workspace, ref.task)))
          .catch((err: unknown) => log.error('session.persist.fail', { err }))
        // Flush each session's unflushed log tail (the JSONL is append-only).
        for (const s of this.sessionsFor(ref.workspace, ref.task)) this.flushLog(s)
      }, 300)
    )
  }

  /**
   * Point every live session of the task at its new name and persist under it —
   * the caller has already moved the task's directory (with its `sessions.json`
   * and logs) there on disk. Any pending debounced persist under the old name is
   * dropped first: left alone it would fire 300ms later, find no sessions under
   * the old key, and write an empty `sessions.json` into a directory that is
   * gone. Surviving adapters are killed rather than re-pointed — each was
   * spawned against the old workspace path and cannot follow the move; sessions
   * re-attach on their next prompt.
   */
  renameTask(ws: string, oldTask: string, newTask: string): void {
    clearTimeout(this.persistTimers.get(taskKey(ws, oldTask)))
    this.persistTimers.delete(taskKey(ws, oldTask))
    for (const s of this.sessions.values())
      if (s.ref.workspace === ws && s.ref.task === oldTask) this.detach(s.info.id)
    for (const s of this.sessions.values()) {
      if (s.ref.workspace !== ws || s.ref.task !== oldTask) continue
      s.ref = { ...s.ref, task: newTask }
      s.info.task = newTask
      s.info.lastActivityAt = new Date().toISOString()
      s.attached = false
    }
    void Promise.resolve(this.events.persist(ws, newTask, this.recordsFor(ws, newTask)))
      .catch((err: unknown) => log.error('session.persist.fail', { err }))
    this.bus.emit('tree.changed', undefined)
  }

  /** Rename a session's display title (sidebar/pane header) — cosmetic only. */
  renameSession(sessionId: string, title: string): void {
    this.assertSessionWritable(sessionId)
    const s = this.sessions.get(sessionId)
    const trimmed = title.trim()
    if (!s || !trimmed || trimmed === s.info.title) return
    s.info.title = trimmed
    s.info.lastActivityAt = new Date().toISOString()
    this.bus.emit('tree.changed', undefined)
    this.bus.emit('session.changed', { sessionId })
    this.schedulePersist(s.ref)
  }

  /** Append the unflushed log tail; `flushedSeq` advances only once the write is
   *  confirmed, so a failed append is retried by the next flush instead of being
   *  silently dropped. One flush per session at a time keeps the tail ordered. */
  private flushLog(s: Session): void {
    if (s.flushInFlight || s.lastSeq <= s.flushedSeq) return
    const upTo = s.lastSeq
    const tail = s.records.filter((r) => r.seq > s.flushedSeq)
    s.flushInFlight = true
    void this.events
      .appendLog(s.ref.workspace, s.ref.task, s.info.id, tail)
      .then(
        () => {
          s.flushedSeq = upTo
        },
        (e: unknown) =>
          log.error('internal.fail', { site: 'session-log-append', s: s.info.id, err: e })
      )
      .then(() => {
        s.flushInFlight = false
        // Records that landed mid-flight (or joined a failed batch) flush now; a
        // failed batch alone waits for the next persist tick. Never resurrect a
        // deleted session's file.
        if (this.sessions.get(s.info.id) === s && s.lastSeq > upTo) this.flushLog(s)
      })
  }

  /**
   * The session's ACP adapter, spawned on first use. A cached connection is
   * reused only while it still belongs to the session's *current* container: a
   * container that was replaced took its adapter process with it, and the id
   * comparison is what makes that impossible to miss. Concurrent callers share
   * one in-flight spawn — `resolveLaunch` coalesces the container ensure, so
   * they hold the same launch context.
   */
  private connection(s: Session, ctx: LaunchContext): Promise<Connection> {
    const key = s.info.id
    const cached = this.connections.get(key)
    if (cached && cached.containerId === ctx.containerId) return Promise.resolve(cached)
    const inflight = this.connectsInFlight.get(key)
    if (inflight) return inflight
    const p = this.connectionUncoalesced(s, ctx)
    this.connectsInFlight.set(key, p)
    p.finally(() => this.connectsInFlight.delete(key)).catch(() => {})
    return p
  }

  private async connectionUncoalesced(s: Session, ctx: LaunchContext): Promise<Connection> {
    const key = s.info.id
    const existing = this.connections.get(key)
    if (existing && existing.containerId === ctx.containerId) return existing
    if (existing) this.connections.delete(key)

    await this.events.installAdapter(ctx)

    const child = spawnAcpAdapter(
      ctx.exec,
      ctx.agent,
      ctx.secret,
      ctx.secretEnv,
      // The proxy variables go last, so a session's sandbox is not something an
      // agent's own env config can talk its way out of (§4.5).
      { ...ctx.env, ...ctx.proxy.env },
      ctx.gitIdentityEnv
    )
    const spawnedAt = Date.now()
    log.info('agent.spawn', {
      s: key,
      cmd: ctx.agent.bin,
      pid: child.pid,
      c: ctx.containerId,
      // Names only — the adapter's argv and env carry the agent's secret, and
      // "which variables were injected" is the whole diagnostic value anyway.
      env: [
        ...(ctx.secret ? [ctx.secretEnv] : []),
        ...Object.keys(ctx.env ?? {}),
        ...Object.keys(ctx.proxy.env),
        ...Object.keys(ctx.gitIdentityEnv ?? {})
      ]
    })
    // The adapter's own diagnostics: the reason a start fails is almost always
    // here, so it goes to the session's provisioning log — which the bus tap
    // routes to `logs/session-<id>.log`, line-buffered and redacted per line.
    // Same `lineBuffer` provision.ts's own child processes use, so a secret
    // split across two `data` chunks is never forwarded in halves here either.
    const stderrBuf = lineBuffer((line) =>
      this.bus.emit('provision.log', { key, line: `[agent] ${line}` })
    )
    child.stderr.on('data', (d: Buffer) => stderrBuf.push(d))
    const peer = new JsonRpcPeer(
      child,
      (err) => log.error('internal.fail', { site: 'agent-process', s: key, pid: child.pid, err }),
      key
    )
    // Built now (not after `initialize` resolves) so the close handler below —
    // which can fire before `initialize` ever comes back — closes over the
    // same object `detach()` marks, rather than reading a variable that may
    // not be assigned yet.
    const conn: Connection = {
      peer,
      sessionId: key,
      containerId: ctx.containerId,
      agent: ctx.agent.id,
      kill: () => child.kill()
    }
    child.on('close', (code, signal) => {
      // The last line is often the one that explains the exit — an unterminated
      // remainder must not be dropped just because no further '\n' is coming.
      stderrBuf.flush()
      const ms = Date.now() - spawnedAt
      log.info('agent.exit', {
        s: key,
        pid: child.pid,
        code: adapterExitCode(code, signal),
        signal: signal ?? undefined,
        ms
      })
      // Only clear the slot if it still holds *this* process — a replaced
      // container's adapter must not evict its successor on its way out.
      if (this.connections.get(key)?.peer === peer) this.connections.delete(key)
      conn.client?.dispose()
      const expected = conn.expectedExit === true
      const dead = this.sessions.get(key)
      // Captured before anything below resets it — "was this session doing
      // something" at the moment the adapter actually died, for §2's "while
      // running/waiting" rule (an idle session's container going down
      // out-of-band is not a crash mid-work).
      const wasLive = !!dead && (dead.busy || dead.pendingPermissions.size > 0)
      if (dead) {
        dead.attached = false
        const wasAwaiting = dead.pendingPermissions.size > 0
        for (const resolve of dead.pendingPermissions.values())
          resolve({ outcome: { outcome: 'cancelled' } })
        dead.pendingPermissions.clear()
        if (wasAwaiting)
          this.bus.emit('session.awaiting', {
            sessionId: dead.info.id,
            ref: dead.ref,
            awaiting: false
          })
        if (dead.busy) {
          dead.busy = false
          this.push(dead, { kind: 'system', text: 'agent process exited' })
        }
        // The in-flight `session/prompt` of a busy session rejects with the peer,
        // so its runPrompt still emits the `session.turn` ended the idle policy needs.
        // The adapter is what makes a session live: its exit ends this run, and
        // the record carries the run's shape (turns, wall time, how it died).
        log.info('session.end', {
          s: key,
          turns: dead.turns,
          ms: dead.startedAt ? Date.now() - dead.startedAt : ms,
          stopReason: dead.lastStopReason,
          exitCode: adapterExitCode(code, signal)
        })
      }
      // Covers a session that was NOT busy: the auto-stop policy re-evaluates it
      // on adapter death even when no turn end will ever fire.
      this.bus.emit('session.adapterExited', { sessionId: key, expected, wasLive })
    })

    peer.onNotification('session/update', (params) => this.onSessionUpdate(params))
    peer.onRequest('session/request_permission', (params) => this.onPermission(params))

    // The client methods — only for a session that masks. Advertising them is
    // what makes an agent route its file access and commands through gurt, where
    // the PII barrier can reach them (docs/requirements-pii-mask.md §9); a
    // session that does not mask keeps its agent doing both for itself, exactly
    // as before.
    const barrier = this.maskEnabled()
    if (barrier) {
      conn.client = createAcpClient({
        session: key,
        agent: ctx.agent.id,
        cwd: s.remoteCwd ?? ctx.remoteWorkspaceFolder,
        exec: (argv, env) => spawnInContainer(ctx.exec, argv, env),
        encode: (text) => this.mask.encode(key, text),
        reveal: (text) => this.mask.decode(key, text)
      })
      for (const [method, handler] of Object.entries(conn.client.handlers))
        peer.onRequest(method, handler)
    }

    let init
    try {
      init = await peer.request(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: barrier, writeTextFile: barrier },
            terminal: barrier,
            // Opt in to boolean config options so agents may expose native toggles
            // (e.g. Claude's "Fast mode") instead of degrading them to a select.
            session: { configOptions: { boolean: {} } }
          }
        },
        INITIALIZE_RESULT,
        { timeoutMs: ACP_REQUEST_TIMEOUT_MS }
      )
    } catch (e) {
      // The process is up but never became an ACP peer (hung, or spoke garbage)
      // — it would outlive this failed connect as an orphan inside the
      // container. Its exit is expected: this kill *is* the cleanup.
      conn.expectedExit = true
      conn.kill()
      throw e
    }

    conn.promptCapabilities = init.agentCapabilities?.promptCapabilities
    // The session may have been deleted while the adapter was coming up. Its
    // `detach` found no connection to kill (this one did not exist yet), so
    // this process is the one thing that would outlive it — and caching it
    // would leak a connection nobody can reach.
    if (this.sessions.get(key) !== s) {
      conn.expectedExit = true
      conn.kill()
      throw new Error('session no longer exists')
    }
    this.connections.set(key, conn)
    this.cacheAgentConfig(s)
    return conn
  }

  /** Reconnect a session: spawn the adapter if needed and session/load.
   *  Concurrent callers share one in-flight attach — a prompt and a config
   *  change on a detached session would otherwise both `session/load`. */
  private attach(s: Session): Promise<Connection> {
    const cached = this.connections.get(s.info.id)
    if (cached && s.attached) return Promise.resolve(cached)
    const inflight = this.attachesInFlight.get(s.info.id)
    if (inflight) return inflight
    const p = this.attachUncoalesced(s)
    this.attachesInFlight.set(s.info.id, p)
    p.finally(() => this.attachesInFlight.delete(s.info.id)).catch(() => {})
    return p
  }

  private async attachUncoalesced(s: Session): Promise<Connection> {
    const existing = this.connections.get(s.info.id)
    if (existing && s.attached) return existing
    // We're going to re-open the session (resolveLaunch wakes the container, then
    // session/load). Raise the "resuming" indicator NOW — before the slow
    // container wake — so the UI reads "resuming…" for the whole reattach rather
    // than "thinking…" until the container is up and only then flipping. Resuming
    // is a live indicator (snapshot.resuming), never chat history.
    const resuming = !s.attached
    if (resuming) {
      s.loading = true
      this.bus.emit('session.changed', { sessionId: s.info.id })
    }
    try {
      // Waking a session brings its container back up on the shared clone, so it
      // is gated exactly like a start — otherwise a resume could put two live
      // containers on one working tree.
      const conflict = this.repoConflict(s)
      if (conflict)
        throw new Error(
          `repository "${conflict.repo}" is in use by session "${conflict.holder.info.title}" — wait for it to go idle`
        )
      const ctx = await this.events.resolveLaunch(s.info.id)
      s.remoteCwd = ctx.remoteWorkspaceFolder
      // Same ordering as a start: the resumed session's proxy is a *new*
      // container with no scope, so the scope is pushed before the adapter that
      // will use it. A session that is still attached kept both, and re-pushing
      // is what a scope edit does — not what a reconnect does.
      const mcpServers = s.attached ? [] : await this.attachMcp(s, ctx)
      const conn = await this.connection(s, ctx)
      if (!s.attached) {
        if (!s.acpSessionId) throw new Error('session was never started')
        try {
          // Same `_meta` a start sends to `session/new`: an adapter may only
          // offer a pinned pick (a model, say) when launched with it pinned.
          // Without this, a reload brings up an adapter whose picker forgot
          // the pin, and the next `session/set_config_option` for it is
          // rejected as an invalid value.
          const meta = this.startMeta(ctx.agent, s.info.configValues)
          const result = await conn.peer.request(
            'session/load',
            {
              sessionId: s.acpSessionId,
              cwd: ctx.remoteWorkspaceFolder,
              mcpServers,
              ...(meta ? { _meta: meta } : {})
            },
            SESSION_LOAD_RESULT,
            { timeoutMs: ACP_REQUEST_TIMEOUT_MS }
          )
          s.modes = normalizeModes(result.modes) ?? s.modes
          s.configOptions =
            normalizeConfigOptions(result.configOptions, ctx.agent.id) ?? s.configOptions
          s.attached = true
          // Same reconciliation a start does, for picks `_meta` above can't
          // carry (e.g. fast mode): a resumed adapter otherwise comes back on
          // its own defaults and the session silently changes them the first
          // time its container has been asleep — the pick is still shown, but
          // a different value answers the next turn.
          await this.applyStartConfig(s, conn)
          this.cacheAgentConfig(s)
          await this.applyAutoAllow(s, conn)
        } catch (e) {
          this.push(s, {
            kind: 'system',
            text: `could not resume (${e instanceof Error ? e.message : String(e)}) — create a new session`
          })
          throw e
        }
      }
      return conn
    } finally {
      if (resuming) {
        s.loading = false
        this.bus.emit('session.changed', { sessionId: s.info.id })
      }
    }
  }

  /**
   * Whether this session's prompts are masked right now. Masking is global
   * (Settings → Masking): every session masks while a detector backend resolves
   * and none does while it does not (§5.1's "nothing is masked while no backend
   * is selected").
   *
   * The timeline itself holds the *tokenized* text — what the agent saw and
   * wrote — and the chat view substitutes reals from the session's table when
   * it renders (so its open/closed toggle is a pure view setting, and nothing
   * on disk but the table ever holds a real value). Tool calls the agent makes
   * through MCP servers are a separate seam (§7).
   */
  private maskEnabled(): boolean {
    return this.mask.ready()
  }

  /** Build the ACP prompt content blocks: the message text, a `resource_link` for
   *  every attached context item, and an `image` block per attached image (only sent
   *  when the agent advertised `promptCapabilities.image`). Context paths are resolved
   *  against the container workspace folder so the agent gets an absolute `file://` uri. */
  private promptBlocks(
    s: Session,
    text: string,
    context?: PromptContext[],
    images?: PromptImage[]
  ): unknown[] {
    const blocks: unknown[] = [{ type: 'text', text }]
    for (const c of context ?? []) {
      const uri = c.path.startsWith('git:')
        ? c.path
        : `file://${c.path.startsWith('/') ? c.path : `${s.remoteCwd ?? '.'}/${c.path}`}`
      blocks.push({ type: 'resource_link', uri, name: c.name })
    }
    for (const img of images ?? [])
      blocks.push({ type: 'image', mimeType: img.mimeType, data: img.data })
    return blocks
  }

  /**
   * Run one prompt turn end-to-end: push its timeline entry (a `user` message or,
   * for the nudge, a `system` line), reset the turn-complete flag, run
   * `session/prompt`, and surface a non-`end_turn` stop or a thrown error. Returns
   * the raw turn outcome the enforcement decision consumes.
   */
  private async sendTurn(
    s: Session,
    text: string,
    entryKind: 'user' | 'system',
    isNudge: boolean,
    context?: PromptContext[],
    images?: PromptImage[],
    /** The review loop's intent id, when this turn is one of its host messages
     *  (shown as a `system` entry that carries it). */
    loop?: string
  ): Promise<TurnResult> {
    this.bus.emit('session.activity', { sessionId: s.info.id })
    // The one outbound seam (§2.1): from here on the agent only ever sees
    // tokens, and the timeline records the same tokenized text — the chat view
    // reveals it from the table. A detector that is down must end the turn with
    // a visible error, never silently send the cleartext; the error is held
    // until the `try` below so it is reported like any other turn failure.
    let outbound = text
    let maskError: Error | undefined
    if (this.maskEnabled()) {
      try {
        outbound = await this.mask.encode(s.info.id, text)
      } catch (e) {
        maskError = e instanceof Error ? e : new Error(String(e))
      }
    }
    this.push(s, loop === undefined ? { kind: entryKind, text: outbound } : { kind: 'system', text: outbound, loop })
    // Prompt start: the turn is incomplete until `complete` fires; clear any
    // prior violation overlay.
    s.turnComplete = false
    s.turnRejected = false
    s.info.incomplete = undefined
    s.busy = true
    s.turns++
    // Where this turn's own entries start — the limit detector reads the
    // agent's reply from here on.
    const firstEntry = s.nextEntryId
    this.bus.emit('session.changed', { sessionId: s.info.id })
    this.bus.emit('session.turn', { sessionId: s.info.id, ref: s.ref, phase: 'started' })
    const startedAt = Date.now()
    // Defaults to "threw" (→ final=true) so an unexpected throw between here and
    // the assignments below never reports a user-visible turn end as non-final.
    let outcome: TurnResult = { threw: true }
    // What the accounting record reports as the turn's ending — a non-`end_turn`
    // stop or the thrown error's message, i.e. exactly the text the limit
    // detector needs to tell "the plan said no" from "the code broke".
    let detail: string | undefined
    s.interrupted = true
    try {
      await this.persistNow(s)
    } catch (err) {
      s.busy = false
      s.recovering = true
      throw err
    }
    try {
      if (maskError) throw maskError
      const conn = await this.attach(s)
      const result = await conn.peer.request(
        'session/prompt',
        {
          sessionId: s.acpSessionId,
          prompt: this.promptBlocks(s, outbound, context, images)
        },
        PROMPT_RESULT
      )
      const reason = result.stopReason ?? undefined
      s.lastStopReason = reason
      if (reason && reason !== 'end_turn') {
        this.push(s, { kind: 'system', text: `stopped: ${reason}` })
        detail = reason
      }
      outcome = this.withLimit(s, { stopReason: reason, threw: false }, detail, firstEntry)
      return outcome
    } catch (e) {
      s.lastStopReason = 'error'
      log.warn('turn failed', { s: s.info.id, err: e })
      detail = e instanceof Error ? e.message : String(e)
      this.push(s, { kind: 'system', text: `error: ${detail}` })
      outcome = this.withLimit(s, { threw: true }, detail, firstEntry)
      return outcome
    } finally {
      s.busy = false
      s.interrupted = false
      await this.persistNow(s)
      this.bus.emit('session.changed', { sessionId: s.info.id })
      this.schedulePersist(s.ref)
      this.reportTurn(s, startedAt, outcome, detail)
      // False only for the nudge turn's own boundary — the healing follow-up
      // runPrompt is about to send, not the user-visible end of the turn. See
      // the `final` field on `session.turn` in shared/events.ts.
      const final = this.decideTurn(s, outcome, isNudge) !== 'nudge'
      this.bus.emit('session.turn', { sessionId: s.info.id, ref: s.ref, phase: 'ended', final })
    }
  }

  /**
   * File one finished round-trip with the usage ledger. Accounting only: it
   * never touches session state, and a kind it cannot resolve (an agent deleted
   * from the registry mid-run) is recorded with an empty kind rather than
   * dropped — the turn happened either way, and a card that shows it under
   * "unknown agent" beats a window that silently under-counts.
   */
  private reportTurn(
    s: Session,
    startedAt: number,
    outcome: TurnResult,
    detail?: string
  ): void {
    const agent = s.info.agent ?? ''
    const resetAt = outcome.limit?.resetAt
    this.bus.emit('agent.turn', {
      ts: new Date().toISOString(),
      agent,
      kind: this.agentKinds.get(agent) ?? '',
      sessionId: s.info.id,
      workspace: s.ref.workspace,
      task: s.ref.task,
      ms: Date.now() - startedAt,
      outcome: outcome.limit ? 'limited' : turnOutcome({ ...outcome, detail }, this.vocabulary(s).limits),
      ...usageFields(s.usage),
      ...(detail ? { detail } : {}),
      ...(resetAt ? { resetAt } : {})
    })
  }

  /** Post-turn decision for this session: `postTurnDecision` with the role's
   *  contract folded in — a researcher or inspector is never offered `complete`, so
   *  it is never nudged for skipping it. */
  private decideTurn(s: Session, outcome: TurnResult, isNudge: boolean): PostTurnAction {
    return postTurnDecision({
      ...outcome,
      limited: !!outcome.limit,
      turnComplete: s.turnComplete,
      isNudge,
      hasContract: roleHasTurnContract(sessionRole(s.info))
    })
  }

  /**
   * The limit detector: did the provider, not the code, end this turn? Three
   * signals, any one of which is enough —
   *
   *   - a live rate-limit event during the turn said `rejected`;
   *   - the thrown error / non-`end_turn` stop reads like a limit
   *     (`turnOutcome`'s patterns, unchanged);
   *   - the agent's whole reply is a short limit notice — some adapters answer
   *     a refused turn with one ("You've hit your limit · resets 3pm") as
   *     ordinary text and a clean `end_turn`, which neither of the above would
   *     see.
   *
   * The last two read the session's agent's own wording (its plugin's
   * `limits`) on top of the generic patterns.
   *
   * Logged with the signal that fired, so a miss or a false hit can be traced
   * back to what the adapter actually sent.
   */
  private withLimit(s: Session, outcome: TurnResult, detail: string | undefined, firstEntry: number): TurnResult {
    const reply = s.entries
      .flatMap((e) => (e.id >= firstEntry && e.kind === 'agent' ? [e.text] : []))
      .join('\n')
    const limits = this.vocabulary(s).limits
    const signal = s.turnRejected
      ? 'rate-limit-event'
      : turnOutcome({ ...outcome, detail }, limits) === 'limited'
        ? 'error-text'
        : isLimitReply(reply, limits)
          ? 'agent-reply'
          : undefined
    if (!signal) return outcome
    const resetAt = limitResetAt(detail, limits) ?? limitResetAt(reply, limits)
    log.info('turn.limited', { s: s.info.id, agent: s.info.agent, signal, resetAt })
    return { ...outcome, limit: { ...(resetAt ? { resetAt } : {}) } }
  }

  /**
   * A turn ended on a limit. Settle when it is expected to lift — the reset
   * the refusal named, else the account's own hold, else a growing backoff —
   * record that on the session (persisted, so a restart still waits) and on
   * the account (so nothing else on it starts into the same refusal), and
   * queue the "continue" that resumes the work once it lifts. A message the
   * user already queued behind this turn goes instead: it *is* the
   * continuation, and sending both would answer one turn twice.
   */
  private onLimited(s: Session, limit: { resetAt?: string | undefined }): string {
    s.limitStrikes++
    const now = Date.now()
    const named = limit.resetAt && Date.parse(limit.resetAt) > now ? limit.resetAt : undefined
    const until =
      named ??
      this.limitHold(s)?.until ??
      new Date(now + limitBackoffMs(s.limitStrikes)).toISOString()
    if (s.info.agent) this.bus.emit('agent.limited', { agent: s.info.agent, until })
    // A proactive run is not continued after the reset: its turn has ended, and
    // with it the run and its tools. The account hold above still applies; the
    // agent's next scheduled run starts once the queue lets it.
    if (sessionRole(s.info) === 'proactive') {
      this.push(s, { kind: 'system', text: `limit reached — this run ends here (resets ${formatResetAt(until, now)})` })
      return until
    }
    s.info.limitedUntil = until
    if (!s.pending.length)
      s.pending.push({ id: `p${++this.pendingSeq}`, queuedAt: new Date().toISOString(), text: LIMIT_CONTINUE_PROMPT, auto: true })
    this.push(s, {
      kind: 'system',
      text: `limit reached — continues on its own after the reset (${formatResetAt(until, now)})`
    })
    this.schedulePersist(s.ref)
    // Arms the clock for the reset.
    this.schedule()
    return until
  }

  /** A turn the provider accepted: whatever limit was on record is over. */
  private clearLimited(s: Session): void {
    s.limitStrikes = 0
    if (!s.info.limitedUntil) return
    s.info.limitedUntil = undefined
    this.schedulePersist(s.ref)
  }

  /**
   * Send a user prompt, then enforce the turn contract. A turn that ends cleanly
   * without a `complete` call is a protocol violation: because the ACP session is
   * still alive, one automatic follow-up (`NUDGE_PROMPT`) costs seconds and usually
   * heals it. A nudge turn that still skips `complete` marks the session
   * `incomplete` and gives up — no second nudge. Roles without the contract
   * (researcher, inspector, operator) skip all of this: their turns just end.
   */
  private async runPrompt(
    s: Session,
    text: string,
    context?: PromptContext[],
    images?: PromptImage[],
    loop?: string
  ): Promise<void> {
    s.promptRunning = true
    // The logical turn: this prompt and its nudge (docs/requirements-review-
    // loop.md §5.1). Opened before the first await so the contract tools can
    // file into it once a round-trip is busy; closed in the `finally`, whatever
    // happened. Only a loop session has one — the record, its write and its
    // event are the loop's, and any other session's turn ends as it always did.
    const turn: TurnTrack | undefined = isLoopSession(s.info)
      ? { id: `${s.info.id}:${++s.turnSeq}` }
      : undefined
    s.turn = turn
    // Until the body says how it ended, it threw.
    let how: TurnHow = { failed: { stopReason: 'error' }, incomplete: false }
    try {
      const first = await this.sendTurn(s, text, 'user', false, context, images, loop)
      if (first.limit) {
        how = { limited: { until: this.onLimited(s, first.limit) }, incomplete: false }
        return
      }
      if (!first.threw) this.clearLimited(s)
      if (this.decideTurn(s, first, false) !== 'nudge') {
        how = turnHow(first, false)
        return
      }
      const second = await this.sendTurn(s, nudgePromptFor(sessionRole(s.info)), 'system', true)
      if (second.limit) {
        how = { limited: { until: this.onLimited(s, second.limit) }, incomplete: false }
        return
      }
      const incomplete = this.decideTurn(s, second, true) === 'incomplete'
      if (incomplete) {
        this.push(s, { kind: 'system', text: `turn ended without ${contractToolFor(sessionRole(s.info))}` })
        s.info.incomplete = true
        this.bus.emit('session.changed', { sessionId: s.info.id })
        this.schedulePersist(s.ref)
      }
      how = turnHow(second, incomplete)
    } finally {
      // An ordinary session drops `promptRunning` right here, with no write and
      // no event in between, exactly as before the loop (it is the update
      // deferral's and the drain's gate); only a loop session pays for the
      // settled-turn record (`settleTurn` drops it after its write).
      if (turn) await this.settleTurn(s, turn, how)
      else s.promptRunning = false
      // Whatever was typed while this turn ran goes next. A no-op when the drain
      // loop is what called this (it owns `draining` and continues on its own) —
      // this is here for the one turn it does not drive, the start prompt.
      void this.drainPending(s)
    }
  }

  /**
   * The end of a logical turn, once gurt has classified how it ended
   * (docs/requirements-review-loop.md §5.1, §8): record it as `lastSettled` and
   * persist it, *then* emit `session.settled` — the bus replays nothing, so a
   * loop that misses the event reads the record at boot. A failed write is
   * logged and the event still goes out: the live loop must not hang on a disk
   * error, and only the replay after a crash is lost.
   *
   * A deleted session settles to nobody (`session.deleted` is its event).
   * `promptRunning` drops after the write and before the emit, so a subscriber
   * that queues a host message from the handler finds the session free.
   */
  private async settleTurn(s: Session, turn: TurnTrack, how: TurnHow): Promise<void> {
    if (s.turn === turn) s.turn = undefined
    const settled: SettledTurn = {
      turnId: turn.id,
      ...(turn.complete ? { complete: turn.complete } : {}),
      ...(turn.verdict ? { verdict: turn.verdict } : {}),
      ...how
    }
    s.lastSettled = settled
    try {
      await this.persistNow(s)
    } catch (err) {
      log.error('session.persist.fail', { err })
    }
    s.promptRunning = false
    if (this.sessions.get(s.info.id) === s)
      this.bus.emit('session.settled', { sessionId: s.info.id, ref: s.ref, turn: settled })
  }

  /**
   * A `complete` call landed for this session (via the per-session `gurt` MCP
   * server). Records the turn as complete, stores a proposal when there is work to
   * ship, adds a system timeline line, and — for outcome=changes — emits
   * `session.proposal`, the seam the committer stage consumes. Fires even outside a
   * busy turn (a benign late POST): the proposal/events still update.
   */
  private onComplete(sessionId: string, p: ChangeProposal): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    // Before anything is recorded: a refused call is the agent's to correct
    // (an `isError` tool result), not a turn that completed.
    assertProposalFits(writeRepos(s.info), p)
    // §4.2 of docs/requirements-review-loop.md: the first `complete` with
    // `changes` after a verdict answers its open set. Which set is open — and
    // when the settled turn carrying the replies closes it — is the loop's to
    // say; without one, `replies` is accepted and ignored.
    if (p.outcome === 'changes') assertRepliesAnswer(this.events.openFindings?.(sessionId) ?? [], p.replies)
    // A loop session's tool call counts only inside a round-trip (§5.1): one
    // landing outside `busy` — a straggler of the previous turn while the next
    // prompt is still being masked, or in the gap before the nudge — belongs to
    // no turn, so it neither completes the turn nor is filed in it. An ordinary
    // session has no logical turn and keeps counting every call.
    const inTurn = s.turn !== undefined && s.busy
    if (!s.turn || inTurn) s.turnComplete = true
    const stored: StoredProposal = { ...p, at: new Date().toISOString() }
    // The logical turn's artifact (§5.1): the last call of the turn wins, any
    // outcome. The turn spans a prompt and its nudge, but only their round-trips
    // take calls.
    if (s.turn && inTurn) s.turn.complete = stored
    let text: string
    if (p.outcome === 'changes') {
      s.proposal = stored
      const subjects = [
        ...(p.commit ? [p.commit.subject] : []),
        ...(p.repos ?? []).map((r) => `${r.repo}: ${r.commit.subject}`)
      ]
      text = `complete: changes — ${subjects.join('; ')}`
    } else if (p.outcome === 'blocked') {
      text = `complete: blocked — ${p.reason ?? ''}`
    } else {
      text = 'complete: no_changes'
    }
    // push emits session.log + session.changed + schedulePersist.
    this.push(s, { kind: 'system', text })
    if (p.outcome === 'changes' && s.proposal)
      this.bus.emit('session.proposal', { sessionId, ref: s.ref, proposal: s.proposal })
  }

  /**
   * A reviewer's `submit_review` landed (docs/requirements-review-loop.md
   * §4.1): the turn is complete and its verdict stored — the last call of a
   * turn wins — filed under the round the reviewer is (`reviewOf`) and the
   * turn it came in. Validates and returns at once (§2): the loop reads the
   * verdict when the turn settles, never inside this call.
   */
  private onSubmitReview(sessionId: string, v: ReviewVerdict): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    // Before anything is recorded, like `complete`'s repo rule: a refused call
    // is the agent's to correct.
    assertVerdictFits(s.info.repos, v)
    // As in `onComplete`: only a call inside a round-trip belongs to the turn
    // (§5.1) — a stale approval landing while the next prompt is masked must
    // not survive a nudge the agent then ignores.
    const open = s.turn !== undefined && s.busy ? s.turn : undefined
    if (!s.turn || open) s.turnComplete = true
    s.verdict = {
      ...v,
      at: new Date().toISOString(),
      round: s.info.reviewOf?.round ?? 0,
      // The logical turn's id (`SettledTurn.turnId`); a call outside a
      // round-trip carries the one before the turn in flight (`turnSeq` already
      // counts that one) and is never filed under it.
      turnId: open?.id ?? `${sessionId}:${s.turn ? s.turnSeq - 1 : s.turnSeq}`
    }
    if (open) open.verdict = s.verdict
    const n = v.findings.length
    this.push(s, {
      kind: 'system',
      text:
        v.verdict === 'approve'
          ? 'submit_review: approve'
          : `submit_review: request_changes — ${n} finding${n === 1 ? '' : 's'}`
    })
  }

  /** What the session's `gurt` server may do on its behalf: the role (which
   *  decides its tool set and instructions) plus the callbacks that route into
   *  this manager. Rebuilt on every start/attach, so a re-ensured server always
   *  talks to the live session record. */
  private gurtHooks(s: Session): {
    role: SessionRole
    mounts: { repo: string; mode: RepoMode }[]
    onComplete: (p: ChangeProposal) => void
    onSubmitReview: (v: ReviewVerdict) => void
    onCreateSession: (req: AgentSessionRequest) => Promise<{ sessionId: string; title: string }>
    reviewLoop?: boolean
    admin?: AdminHooks
    proactive?: ProactiveHooks
  } {
    const role = sessionRole(s.info)
    return {
      role,
      mounts: s.info.repos.map((repo) => ({ repo, mode: repoMode(s.info, repo) })),
      onComplete: (p) => this.onComplete(s.info.id, p),
      onSubmitReview: (v) => this.onSubmitReview(s.info.id, v),
      onCreateSession: (req) => this.createAgentDraft(s.info.id, req),
      // A loop executor's instructions say gurt checks, reviews and ships
      // (docs/requirements-review-loop.md §5.5); frozen at start like the role.
      ...(s.info.review ? { reviewLoop: true } : {}),
      // The workspace is bound here, from the session's own record — the one
      // parameter the agent can never express (§3.2 of
      // docs/requirements-session-operator.md).
      // Which half of the surface it gets is the server's to apply, from the
      // role (`roleWritesAdmin`).
      ...(roleReadsAdmin(role) ? { admin: this.events.adminFor(s.ref.workspace, s.info.id) } : {}),
      // Same binding for a proactive run: the agent is the scope the run lives
      // in, never a name the run supplies.
      ...(role === 'proactive' ? { proactive: this.proactiveHooks(s) } : {})
    }
  }

  /** A proactive run's tools, bound to its own workspace, agent and session.
   *  `finish_run` is its turn contract: it satisfies the nudge the way
   *  `complete` does an executor's. */
  private proactiveHooks(s: Session): ProactiveHooks {
    const id = s.info.id
    const inner = this.events.proactiveFor(s.ref.workspace, s.ref.task, id)
    return {
      ...inner,
      finishRun: async (input) => {
        const result = await inner.finishRun(input)
        const live = this.sessions.get(id)
        if (live) {
          live.turnComplete = true
          this.push(live, { kind: 'system', text: `finish_run — ${input.summary}` })
        }
        return result
      }
    }
  }

  /** Mark a draft as a proactive agent's template (docs/design-proactive-
   *  agents.md §2): it never runs itself. */
  markTemplate(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error('unknown session')
    s.info.template = true
    this.bus.emit('session.changed', { sessionId })
    this.schedulePersist(s.ref)
  }

  /** Start one run of a proactive agent: a copy of its template, in the
   *  template's own scope, titled `title`, straight into the queue — enabling
   *  the agent was the approval for its runs (§1). */
  spawnRun(templateId: string, title: string): SessionInfo {
    const t = this.sessions.get(templateId)
    if (!t?.info.template) throw new Error('the proactive agent has no template')
    const info = this.draftFrom(t.info)
    this.renameSession(info.id, title)
    this.enqueue(info.id)
    return info
  }

  /**
   * Create one round's reviewer for a loop executor and enqueue it, as
   * {@link spawnRun} starts a proactive run (docs/requirements-review-loop.md
   * §5.4): in the executor's scope, with its env and inheritance
   * ({@link inheritanceOf}: auto-allow, skills, network, MCP) but the Review
   * block's agent and config values; the executor's repos, all `read`; every
   * built-in MCP server capped at `read-only` (no `git_push` /
   * `create_pull_request`); `reviewOf` naming the intent; the title
   * `review <round> — <executor title>`; and the caller's prompt, which is the
   * reviewer's whole input.
   *
   * Persisted *before* it is enqueued, so a crash between the two leaves a
   * draft carrying `reviewOf.intent` that the next boot adopts instead of
   * creating a second reviewer (§8). Exempt from the scope's cap
   * ({@link capExempt}); still subject to its account's plan hold.
   */
  async createReviewer(
    executorId: string,
    req: { round: number; intent: string; prompt: string }
  ): Promise<SessionInfo> {
    const ex = this.sessions.get(executorId)
    if (!ex) throw new Error('unknown session')
    const block = ex.info.review
    if (!block) throw new Error('this session is not in a review loop')
    const inherit = this.inheritanceOf(ex.info)
    const info = this.createSession(
      ex.ref,
      [...ex.info.repos],
      block.agent,
      req.prompt,
      'draft',
      (inherit.mcp ?? []).map((m) => (MCP_DEFS.some((d) => d.id === m.id) ? { ...m, mode: 'read-only' as const } : { ...m })),
      inherit.autoAllow ?? true,
      { ...(block.configValues ?? {}) },
      'reviewer',
      inherit.skills?.map((k) => ({ ...k })),
      sanitizeSessionNetwork(inherit.network),
      Object.fromEntries(ex.info.repos.map((r) => [r, 'read' as const]))
    )
    info.reviewOf = { executor: executorId, round: req.round, intent: req.intent }
    this.renameSession(info.id, `review ${req.round} — ${ex.info.title}`)
    await this.persistNow(this.sessions.get(info.id)!)
    this.enqueue(info.id)
    return info
  }

  /**
   * `create_session` (§3): one session's agent drafts another. The new session
   * lands in the spawner's own task, inherits everything the request leaves out
   * (the env excepted — see `resolveDraftEnv`), and stays a **draft** — the user
   * reviewing, editing or launching it *is* the approval step, which is why
   * there is no spawn-graph limit, depth control or flow management to enforce
   * here. Nothing flows back to the spawner beyond the id of the draft it just
   * created.
   */
  async createAgentDraft(
    spawnerId: string,
    req: AgentSessionRequest
  ): Promise<{ sessionId: string; title: string }> {
    const spawner = this.sessions.get(spawnerId)
    if (!spawner) throw new Error('unknown session')
    const from = sessionRole(spawner.info)
    const allowed = spawnableRoles(from)
    if (!allowed.includes(req.role))
      throw new Error(
        allowed.length
          ? `a ${from} session may only draft: ${allowed.join(', ')}`
          : `a ${from} session may not draft sessions`
      )
    const task = req.task?.trim() || spawner.ref.task
    // Belt and braces with the tool schema, which offers `task` only to the
    // roles allowed to use it.
    if (task !== spawner.ref.task && !roleDraftsCrossTask(from))
      throw new Error(`a ${from} session may only draft into its own task`)
    const inherit = this.inheritanceOf(spawner.info)
    const prepared = await this.prepareDraft(spawner.ref.workspace, req, inherit)
    // The task name is agent-input too: `ensureTask` validates it and creates
    // the `task.json` marker if missing — the session's first persist would
    // otherwise mkdir its way into a directory that is not a task (invisible
    // in the tree; see the same invariant at the IPC create boundary).
    if (task !== spawner.ref.task) await this.events.ensureTask(spawner.ref.workspace, task)
    const info = this.createPreparedDraft(spawner.ref.workspace, task, prepared, inherit)
    log.info('session.drafted', { s: info.id, by: spawnerId, role: req.role, task })
    // A draft is a to-do for the user, and the spawner's own feed is where they
    // are looking right now — the tree row alone is easy to miss. A cross-task
    // draft names its task, since the row is not even in this task's subtree.
    const where = task !== spawner.ref.task ? ` in task "${task}"` : ''
    this.push(spawner, { kind: 'system', text: `create_session: drafted ${req.role} "${info.title}"${where}` })
    return { sessionId: info.id, title: info.title }
  }

  /** What a draft requested by this session inherits (see {@link DraftInheritance}). */
  inheritanceOf(info: SessionInfo): DraftInheritance {
    return {
      agent: info.agent,
      mcp: info.mcp,
      autoAllow: info.autoAllow,
      configValues: info.configValues,
      skills: info.skills,
      network: info.network
    }
  }

  /**
   * Check a draft request against the workspace and resolve its agent and env,
   * creating nothing — so a caller with several requests can refuse all of them
   * before the first one lands (a proactive agent's `propose_scope`).
   */
  async prepareDraft(ws: string, req: AgentSessionRequest, inherit: DraftInheritance): Promise<PreparedDraft> {
    // Normalized before anything reads it: the env follows the anchor, and the
    // anchor follows the modes.
    req = { ...req, repoModes: normalizeRepoModes(req.repos, req.repoModes) }
    // Explicit request wins; absent that, the workspace's own default (if any)
    // beats inheriting the spawner's — a workspace that configured a default
    // has made a choice for everything drafted into it, not just for sessions
    // that name no agent of their own. Only with neither does the spawner's
    // agent stand, as before.
    const agent = req.agent ?? (await this.events.defaultAgentForWorkspace(ws)) ?? inherit.agent
    if (!agent) throw new Error('no agent to draft with — this session has none either')
    // Repo/env/agent names come from an agent, so they are untrusted the same
    // way the renderer's are; a draft naming a repo that does not exist, or an
    // agent the workspace denies, would only fail much later, at the user's
    // launch. Checked *before* the env is resolved, since resolving reads the
    // repo back out of the registry — an invented repo has to read as "not
    // registered", not as "has no default env".
    await this.events.checkDraftTarget(ws, req.repos, req.env, agent)
    const env = await this.resolveDraftEnv(ws, req)
    return { req, agent, env }
  }

  /** Create a draft {@link prepareDraft} has already checked. The task must
   *  exist. */
  createPreparedDraft(ws: string, task: string, prepared: PreparedDraft, inherit: DraftInheritance): SessionInfo {
    const { req, agent, env } = prepared
    const info = this.createSession(
      { workspace: ws, task, env },
      req.repos,
      agent,
      req.prompt,
      'draft',
      inherit.mcp ? [...inherit.mcp] : [],
      req.autoAllow ?? inherit.autoAllow ?? true,
      req.configValues ?? inherit.configValues ?? {},
      req.role,
      // Inherited when the request says nothing, replaced outright when it does
      // — including with `[]`, which is how an agent asks for none
      // (docs/requirements-skills.md §6). The names were validated at the tool
      // boundary; one that does not resolve stays in the draft as an error row,
      // which is where a user can act on it.
      req.skills ? sanitizeSkillSelection(req.skills) : inherit.skills?.map((k) => ({ ...k })),
      // Inherited, never chosen: a session running internal cannot draft one
      // with open egress (§6.2), and `AgentSessionRequest` has no field to ask
      // with — a rule the agent cannot express is one it cannot argue about.
      sanitizeSessionNetwork(inherit.network),
      req.repoModes
    )
    // `renameSession` mutates the same info object createSession stored.
    if (req.title?.trim()) this.renameSession(info.id, req.title)
    return info
  }

  /**
   * Which environment a `create_session` draft runs in. The answer follows the
   * **repo being drafted for**, never the spawner: a researcher parked in some
   * ad-hoc container drafts sessions for repos all day, and inheriting its own
   * env handed every one of them the wrong container silently — nothing in the
   * request said "env", so nothing in the result looked wrong either.
   *
   * So: the env is the one claiming this repo as its default (`EnvConfig.repo`,
   * read backwards). Naming a different one is allowed but never implicit —
   * `confirmNonDefaultEnv` has to say so, which is what makes the wrong
   * container a decision rather than an oversight. The interactive New Session
   * flow (`createSession`) keeps its own defaulting: a human picking an env in
   * the modal sees what they picked.
   *
   * Two shapes have no default to speak of, and both end at the same place —
   * the caller names the env:
   *  - **no env claims the repo**: there is nothing to default to, so `env` is
   *    required. Once given it stands on its own; there is no default for it to
   *    contradict, so no confirmation to ask for.
   *  - **several envs claim it**: the registry is ambiguous, so an omitted
   *    `env` cannot be resolved for the caller. Any env *from that set* is then
   *    taken as-is — none of them is more "the" default than the others, and
   *    demanding a non-default confirmation for a genuine default would teach
   *    the agent to set the flag by reflex, which is the one habit this guard
   *    cannot survive. Anything outside the set still needs the flag.
   */
  private async resolveDraftEnv(ws: string, req: AgentSessionRequest): Promise<string> {
    // The repo the env follows is the draft's anchor — its first `write` repo,
    // else its first (docs/requirements-repo-mounts.md §2.2). A draft with no
    // repo has nothing to follow: it takes what it names, else the workspace's
    // default env, the way a fresh draft in the UI does.
    const repo = anchorRepo({ role: req.role, repos: req.repos, ...(req.repoModes ? { repoModes: req.repoModes } : {}) })
    if (!repo) return req.env ?? (await this.events.defaultEnvForWorkspace(ws))
    const defaults = await this.events.defaultEnvsForRepo(ws, repo)
    if (!req.env) {
      const [only, ...rest] = defaults
      if (only && !rest.length) return only
      throw new Error(
        defaults.length
          ? `repo "${repo}" is the default repo of several environments (${defaults.join(', ')}) — ` +
            'pass `env` naming the one this session should run in'
          : `repo "${repo}" is not the default repo of any environment, so there is nothing to ` +
            'default to — pass `env` naming the one this session should run in'
      )
    }
    if (defaults.includes(req.env) || !defaults.length || req.confirmNonDefaultEnv) return req.env
    const named = defaults.map((e) => `"${e}"`).join(', ')
    throw new Error(
      defaults.length > 1
        ? `env "${req.env}" is not among the default environments of repo "${repo}" (${named}) — ` +
          'name one of those, or pass `confirmNonDefaultEnv: true` if running it elsewhere is deliberate'
        : `env "${req.env}" is not the default environment of repo "${repo}" (that is ${named}) — ` +
          'omit `env` to draft into the repo\'s default, or pass `confirmNonDefaultEnv: true` if ' +
          'running it elsewhere is deliberate'
    )
  }

  /** Newest stored proposal for this (task, repo) among the sessions that
   *  *write* it (all outcome=changes), resolved to that repo — its own entry
   *  when it has one, else the shared commit/pr (docs/requirements-repo-mounts.md
   *  §3). A proposal with neither for this repo does not count. */
  latestProposal(ws: string, task: string, repo: string): StoredProposal | undefined {
    let best: StoredProposal | undefined
    for (const s of this.sessions.values()) {
      if (s.ref.workspace !== ws || s.ref.task !== task) continue
      if (!s.info.repos.includes(repo) || repoMode(s.info, repo) !== 'write') continue
      const p = s.proposal && proposalForRepo(s.proposal, repo)
      if (!p) continue
      if (!best || p.at > best.at) best = p
    }
    return best
  }

  /** No session sharing this env is busy or mid-start. */
  isSessionIdle(sessionId: string): boolean {
    const s = this.sessions.get(sessionId)
    if (!s) return false
    return !s.busy && s.info.state !== 'starting'
  }

  /** Ping from the UI (e.g. typing in the composer) — postpones a pending auto-stop. */
  activity(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    if (this.frozenTasks.has(taskKey(s.ref.workspace, s.ref.task))) return
    s.info.lastActivityAt = new Date().toISOString()
    this.schedulePersist(s.ref)
    this.bus.emit('session.activity', { sessionId: s.info.id })
  }

  async prompt(
    sessionId: string,
    text: string,
    context?: PromptContext[],
    images?: PromptImage[]
  ): Promise<void> {
    this.assertSessionWritable(sessionId)
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error('unknown session')
    if (s.info.state !== 'started') throw new Error('session is not started')
    // Everything goes through the queue, including the send that could have run
    // straight away — that is what keeps "one turn at a time" structural rather
    // than a rule each caller has to remember. Overlapping prompts would share
    // `turnComplete`, so a `complete` for one turn could silently satisfy the
    // other (and both could nudge).
    //
    // Resolves once the prompt is *accepted*, not once it has run: a queued one
    // may wait minutes for the clone, and the caller (the composer) needs its
    // message cleared now. What happened to it afterwards is the timeline's to
    // tell, and a failed turn writes itself there.
    const id = `p${++this.pendingSeq}`
    // What the user types now is the continuation an interrupted session was
    // going to send on its own — it replaces the automatic "continue".
    const queuedAt = s.pending.find((p) => p.auto)?.queuedAt ?? new Date().toISOString()
    s.pending = s.pending.filter((p) => !p.auto)
    s.pending.push({
      id,
      queuedAt,
      text,
      ...(context?.length ? { context } : {}),
      ...(images?.length ? { images } : {})
    })
    await this.persistNow(s)
    s.recovering = false
    // A person typed: the review loop reads it as a takeover
    // (docs/requirements-review-loop.md §5.6). After the message is accepted
    // and before it runs, so the loop ends first and the message then runs as
    // any other. Never from `hostPrompt` — the loop's own messages are not a
    // human act. Only a loop session says so (`human`): anyone else's prompt
    // adds no bus event.
    this.human(s, 'prompt')
    void this.drainPending(s)
    // Still queued after the drain had its synchronous chance at it: nothing
    // else is going to announce it. A drain already in flight returns at its
    // own guard without a word, and the turn it is waiting behind may run for
    // minutes — the pane has to show the message now, not then. When the drain
    // *did* take it, `sendTurn` has already emitted for the turn it started.
    if (s.pending.some((p) => p.id === id)) {
      this.bus.emit('session.changed', { sessionId: s.info.id })
      // A waiting prompt wants the clone exactly like a queued draft does, and
      // the handoff only ever runs off a signal. Without this one the holder is
      // already idle — its turn ended before the message was typed — so nothing
      // else will fire, and the message sits out the whole grace period.
      this.bus.emit('session.promptQueued', { sessionId: s.info.id })
    }
  }

  /** A person acted on a loop session (§5.6): tell the controller. Silent for
   *  every other session — no loop reads it, and an ordinary session's bus
   *  traffic stays what it was before the loop. */
  private human(s: Session, did: 'prompt' | 'cancel'): void {
    if (isLoopSession(s.info)) this.bus.emit('session.human', { sessionId: s.info.id, ref: s.ref, did })
  }

  /**
   * The review loop's message to its executor — red checks, findings, the
   * proposal repair (docs/requirements-review-loop.md §5.5). Queued exactly like
   * a typed prompt (persisted, run by {@link drainPending} one turn at a time)
   * with three differences: it is `auto`, so a typed message or a stop drops it
   * (`prompt`, `clearPending`); its turn shows as a `system` entry carrying
   * `intent`; and it never clears `recovering` nor emits `session.human` — a
   * session waiting to be resumed stays so, and the loop's own message is not a
   * human act. Resolves once persisted, like `prompt`.
   *
   * The intent id makes it idempotent: asking again for an id that is already
   * waiting does nothing.
   */
  async hostPrompt(sessionId: string, text: string, intent: string): Promise<void> {
    this.assertSessionWritable(sessionId)
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error('unknown session')
    if (s.info.state !== 'started') throw new Error('session is not started')
    if (s.pending.some((p) => p.origin?.loop === intent)) return
    const id = `p${++this.pendingSeq}`
    s.pending.push({ id, text, auto: true, origin: { loop: intent } })
    await this.persistNow(s)
    void this.drainPending(s)
    // As in `prompt`: still waiting after the drain's synchronous chance — a
    // turn in flight, a recovering session, a delivery in progress.
    if (s.pending.some((p) => p.id === id)) this.bus.emit('session.changed', { sessionId: s.info.id })
  }

  /**
   * Run everything this session has waiting, one turn at a time, for as long as
   * it can: a queue that empties into a session whose clone was taken away
   * mid-drain stops where it is and waits to be called again (`schedule()`).
   *
   * Never rejects — it is called for its effect from event handlers and from
   * the tail of every turn, and a rejected floating promise here would be a
   * crash the user could not connect to anything they did.
   */
  private async drainPending(s: Session): Promise<void> {
    if (s.draining || s.recovering) return
    s.draining = true
    let consumed = false
    try {
      // `busy` covers the one turn this loop does not own: the start prompt,
      // which `startSession` runs directly. `repoHolder` is case two — the
      // clone is elsewhere, and attaching would only fail with it.
      // Case three: the account is at its limit — what is waiting would only be
      // refused, so it stays put until the hold lifts (`schedule()` again).
      // Case four: a review loop is delivering in this scope — its steps are
      // irreversible, so a typed message waits and runs after the loop has
      // ended (docs/requirements-review-loop.md §5.6, "During delivery"); the
      // controller calls `schedule()` when it does.
      while (
        s.pending.length &&
        !s.busy &&
        s.info.state === 'started' &&
        !this.repoHolder(s) &&
        !this.earlierQueueItem(s) &&
        !this.limitHold(s) &&
        !this.deliveryActive(s)
      ) {
        const next = s.pending.shift()!
        consumed = true
        s.interrupted = true
        // Beside `interrupted`, in the same write as the prompt's removal (§8).
        s.loopRan = next.origin?.loop
        await this.runPrompt(s, next.text, next.context, next.images, next.origin?.loop)
      }
    } catch (e) {
      log.error('internal.fail', { site: 'pending-drain', s: s.info.id, err: e })
    } finally {
      s.draining = false
      // One emit for both endings: the queue is empty, or it is stuck and the
      // pane has to say why.
      this.bus.emit('session.changed', { sessionId: s.info.id })
      if (consumed) this.schedule()
    }
  }

  /** Take everything out of the queue and hand it back — the composer puts the
   *  text (and chips) where it came from, so stopping a session never eats what
   *  was typed behind it. Images are dropped; see {@link PendingPromptInfo}. */
  clearPending(sessionId: string): PendingPromptInfo[] {
    const s = this.sessions.get(sessionId)
    if (!s?.pending.length) return []
    // Stopping the session stops its automatic continuation too; the "continue"
    // itself was never typed, so it does not go back to the composer.
    const out = s.pending.filter((p) => !p.auto).map(pendingInfo)
    s.pending = []
    this.schedulePersist(s.ref)
    this.dropAutoContinue(s)
    this.bus.emit('session.changed', { sessionId })
    this.schedule()
    // The composer's stop with something queued — a loop's message included —
    // is the user withdrawing it (§5.6: "cancels the loop's queued message").
    this.human(s, 'cancel')
    return out
  }

  /** The same for one entry, by id (a row's own cancel). Returns it so that
   *  one, too, can go back to the composer rather than just vanishing. */
  cancelPending(sessionId: string, promptId: string): PendingPromptInfo | undefined {
    const s = this.sessions.get(sessionId)
    if (!s) return undefined
    const i = s.pending.findIndex((p) => p.id === promptId)
    if (i < 0) return undefined
    const [gone] = s.pending.splice(i, 1)
    this.schedulePersist(s.ref)
    // Cancelling the automatic "continue" is "do not resume this one by
    // yourself": the session-level hold goes with it (the account's stays).
    if (gone?.auto) this.dropAutoContinue(s)
    this.bus.emit('session.changed', { sessionId })
    this.schedule()
    this.human(s, 'cancel')
    return gone && !gone.auto ? pendingInfo(gone) : undefined
  }

  private dropAutoContinue(s: Session): void {
    if (!s.info.limitedUntil) return
    s.info.limitedUntil = undefined
    this.schedulePersist(s.ref)
  }

  /**
   * Esc: cancel the running turn and any open permission request. A person's
   * act by default, announced as `session.human` (docs/requirements-review-loop.md
   * §5.6); the host cancelling a turn on its own account (a proactive run's
   * timeout, the review loop's deadline) passes `by: 'host'` and is not.
   */
  cancel(sessionId: string, by: 'user' | 'host' = 'user'): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    if (by === 'user') this.human(s, 'cancel')
    const conn = this.connections.get(s.info.id)
    if (s.acpSessionId) conn?.peer.notify('session/cancel', { sessionId: s.acpSessionId })
    const wasAwaiting = s.pendingPermissions.size > 0
    for (const resolve of s.pendingPermissions.values())
      resolve({ outcome: { outcome: 'cancelled' } })
    s.pendingPermissions.clear()
    if (wasAwaiting)
      this.bus.emit('session.awaiting', { sessionId: s.info.id, ref: s.ref, awaiting: false })
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    this.assertSessionWritable(sessionId)
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error('unknown session')
    const conn = this.connections.get(s.info.id)
    if (!conn) throw new Error('agent is not running — send a prompt first')
    await conn.peer.request('session/set_mode', { sessionId: s.acpSessionId, modeId })
    if (s.modes) s.modes.currentModeId = modeId
    // The pick itself is what a reattach restores — the bool below only drives
    // the auto/manual tag and is far too coarse to rebuild a mode from.
    s.info.modeId = modeId
    // Keep the persisted preference in step so a later reattach restores this choice.
    const mode = s.modes?.availableModes.find((m) => m.id === modeId)
    const picked = { id: mode?.id ?? modeId, name: mode?.name ?? '' }
    if (modeHas(picked, [...this.vocabulary(s).modes.bypass, ...AUTO_WORDS])) s.info.autoAllow = true
    else if (modeHas(picked, MANUAL_WORDS)) s.info.autoAllow = false
    this.bus.emit('session.changed', { sessionId })
    this.schedulePersist(s.ref)
  }

  /**
   * gurt's own confirmation for an operator's `apply_held`
   * (docs/requirements-session-operator.md §4.3) — the one prompt auto-allow
   * cannot reach. It is raised here, not through ACP, so neither the
   * gurt-tools blanket allow in `onPermission` nor a bypass mode ever sees
   * it; it rides the timeline as a permission entry so the decision is on the
   * record afterwards. No timeout and no default: a cancelled turn, a dead
   * adapter or a deleted session resolves it as "no", and an app restart
   * leaves nothing to resume — every exit fails closed.
   */
  confirmHeld(sessionId: string, title: string, detail: string): Promise<{ ok: boolean; entryId: number }> {
    const s = this.sessions.get(sessionId)
    if (!s) return Promise.resolve({ ok: false, entryId: -1 })
    const entry = this.push(s, {
      kind: 'permission',
      title,
      detail,
      options: [
        { optionId: 'apply', name: 'Apply', kind: 'allow_once' },
        { optionId: 'reject', name: 'Keep held', kind: 'reject_once' }
      ]
    })
    return new Promise((resolve) => {
      s.pendingPermissions.set(entry.id, (outcome) => {
        const o = (outcome as { outcome?: { outcome?: string; optionId?: string } }).outcome
        resolve({ ok: o?.outcome === 'selected' && o.optionId === 'apply', entryId: entry.id })
      })
      if (s.pendingPermissions.size === 1)
        this.bus.emit('session.awaiting', { sessionId: s.info.id, ref: s.ref, awaiting: true })
    })
  }

  respondPermission(sessionId: string, entryId: number, optionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    const resolve = s.pendingPermissions.get(entryId)
    if (!resolve) return
    s.pendingPermissions.delete(entryId)
    const entry = s.entries.find((e) => e.id === entryId)
    if (entry && entry.kind === 'permission')
      this.append(s, { type: 'patch', id: entryId, patch: { chosen: optionId } })
    resolve({ outcome: { outcome: 'selected', optionId } })
    if (s.pendingPermissions.size === 0)
      this.bus.emit('session.awaiting', { sessionId, ref: s.ref, awaiting: false })
    this.bus.emit('session.changed', { sessionId })
    this.schedulePersist(s.ref)
  }

  private bySessionId(acpSessionId: string): Session | undefined {
    return [...this.sessions.values()].find((s) => s.acpSessionId === acpSessionId)
  }

  /** The ONE writer of the session log: assigns seq, applies, announces, persists. */
  private append(s: Session, record: NewLogRecord): void {
    s.info.lastActivityAt = new Date().toISOString()
    s.info.lastContentAt = s.info.lastActivityAt
    const rec = { ...record, seq: ++s.lastSeq }
    s.records.push(rec)
    s.entries = applyLog(s.entries, [rec])
    this.bus.emit('session.log', { sessionId: s.info.id, records: [rec] })
    // A streaming text delta changes nothing outside the timeline, and the
    // timeline rides session.log — skip the per-chunk snapshot broadcast.
    if (rec.type !== 'append') this.bus.emit('session.changed', { sessionId: s.info.id })
    this.schedulePersist(s.ref)
  }

  private push(s: Session, entry: ChatEntryBase): ChatEntry {
    const full = { ...entry, id: s.nextEntryId++, at: Date.now() }
    this.append(s, { type: 'entry', entry: full })
    return full
  }

  /** Build the `_meta` passed to `session/new` and `session/load` from a
   *  draft's chosen config — the kind's plugin says what its adapter reads
   *  (`sessionMeta`). Returns undefined when there is nothing to forward. */
  private startMeta(
    agent: AgentManifest,
    configValues: Record<string, string | boolean> | undefined
  ): Record<string, unknown> | undefined {
    if (!configValues) return undefined
    return agentMain(agent.id)?.sessionMeta?.(configValues)
  }

  /** Reconcile a freshly-opened session against the draft's chosen config values:
   *  for every pick whose live current value differs, push it via
   *  `session/set_config_option`. Runs before the first prompt so the turn uses
   *  the intended settings even for options `_meta` can't carry (e.g. fast mode).
   *  Best-effort — a rejected option is logged, not fatal. */
  private async applyStartConfig(s: Session, conn: Connection): Promise<void> {
    const values = s.info.configValues
    if (!values) return
    for (const [configId, value] of Object.entries(values)) {
      const opt = s.configOptions?.find((o) => o.id === configId)
      // Skip when the option isn't offered here or already holds the value.
      if (!opt || opt.currentValue === value) continue
      try {
        await this.pushConfigOption(s, conn, configId, value)
      } catch (e) {
        this.push(s, {
          kind: 'system',
          text: `could not set ${configId}: ${e instanceof Error ? e.message : String(e)}`
        })
      }
    }
  }

  /** Issue one `session/set_config_option` and adopt the echoed option set. The
   *  agent may rewrite sibling options (picking a model swaps its effort levels),
   *  so we replace `s.configOptions` wholesale from the response. */
  private async pushConfigOption(
    s: Session,
    conn: Connection,
    configId: string,
    value: string | boolean
  ): Promise<void> {
    const params =
      typeof value === 'boolean'
        ? { sessionId: s.acpSessionId, configId, type: 'boolean', value }
        : { sessionId: s.acpSessionId, configId, value }
    const res = await conn.peer.request('session/set_config_option', params, SET_CONFIG_OPTION_RESULT, {
      timeoutMs: ACP_REQUEST_TIMEOUT_MS
    })
    const next = normalizeConfigOptions(res.configOptions, this.agentKinds.get(s.info.agent ?? ''))
    if (next) s.configOptions = next
  }

  /** Change a live agent-reported config option (model, effort, fast-mode, …) via
   *  ACP `session/set_config_option`. Also records the choice on the draft-time
   *  `configValues` so it survives a detach and re-applies on the next start, and
   *  refreshes the agent cache with the new option set. */
  async setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<void> {
    this.assertSessionWritable(sessionId)
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error('unknown session')
    // A sleeping session is woken first — attach brings the container up and
    // session/loads, with the usual "resuming…" indicator and repo-clone gate —
    // so the change applies to the live agent and is validated by it right now,
    // exactly like a change on a running session.
    const conn = await this.attach(s)
    try {
      await this.pushConfigOption(s, conn, configId, value)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // The agent validates a pick against what its own picker currently
      // offers — and that list may only contain a model the CLI wasn't
      // launched pinned to (claude-code's does, see `startMeta`) once this
      // session's adapter has been restarted with it already set. Recording
      // the choice anyway means the next `session/new`/`session/load` sends
      // it via `_meta` and the agent comes up already offering it, instead of
      // the pick silently reverting.
      if (/invalid value/i.test(message)) {
        s.info.configValues = { ...s.info.configValues, [configId]: value }
        this.schedulePersist(s.ref)
        throw new Error(
          `agent does not offer ${configId} ${value} in this session; it will be pinned on the next start`,
          { cause: e }
        )
      }
      throw e
    }
    s.info.configValues = { ...s.info.configValues, [configId]: value }
    // Confirm the change in the timeline. Failures already leave system entries
    // ("could not set …"); a success was only visible as the popup's highlight,
    // which is gone the moment the popup closes — and the switch itself is
    // history: it changes how everything below it in the feed should be read.
    // Read names from the post-push option set — the agent may have rewritten it.
    const opt = s.configOptions?.find((o) => o.id === configId)
    const picked = opt?.options?.find((o) => o.value === value)?.name
    const shown = picked ?? (typeof value === 'boolean' ? (value ? 'on' : 'off') : value)
    this.push(s, { kind: 'system', text: `${opt?.name ?? configId} → ${shown}` })
    this.cacheAgentConfig(s)
    this.bus.emit('session.changed', { sessionId })
    this.schedulePersist(s.ref)
  }

  /** Switch the freshly (re)opened ACP session into the mode it belongs in —
   *  the user's own last pick, or the one implied by the session-start
   *  auto/manual choice (see {@link nextModeId}). Best-effort: unknown mode
   *  sets are left alone. */
  private async applyAutoAllow(s: Session, conn: Connection): Promise<void> {
    if (!s.acpSessionId) return
    const target = nextModeId(s.info, s.modes, this.vocabulary(s).modes)
    if (!target) return
    try {
      await conn.peer.request('session/set_mode', { sessionId: s.acpSessionId, modeId: target })
      if (s.modes) s.modes.currentModeId = target
      // The mode chips read `modes.currentModeId`; a start/reattach that lands
      // in a different mode than the last snapshot showed has to say so, or the
      // popup keeps highlighting the mode the session left behind. (claude-code
      // also sends `current_mode_update` for this — an agent that does not is
      // exactly the case this covers.)
      this.cacheAgentConfig(s)
      this.bus.emit('session.changed', { sessionId: s.info.id })
    } catch (e) {
      this.push(s, {
        kind: 'system',
        text: `could not set mode: ${e instanceof Error ? e.message : String(e)}`
      })
    }
  }

  /** Flatten ACP tool-call content blocks into a plain-text preview. Tokens stay
   *  tokens here, like every other inbound field — the chat view reveals them. */
  private toolDetail(content: AcpToolContent | undefined): string | undefined {
    if (!content?.length) return undefined
    const parts: string[] = []
    for (const c of content) {
      if (c.type === 'diff') {
        parts.push(`--- ${c.path ?? ''}\n${c.newText ?? ''}`.slice(0, 2000))
      } else if (c.type === 'content' && c.content?.type === 'text') {
        parts.push((c.content.text ?? '').slice(0, 2000))
      }
    }
    return parts.length ? parts.join('\n') : undefined
  }

  /**
   * A `session/update` notification. The envelope says which session and which
   * variant; each variant parses its own payload, so an adapter that changes
   * the shape of one update (or sends one gurt has never heard of) costs that
   * update only — the timeline around it keeps flowing.
   */
  private onSessionUpdate(params: unknown): void {
    const p = parseOrDrop(SESSION_UPDATE, params, 'session/update')
    if (!p?.update) return
    const s = this.bySessionId(p.sessionId)
    if (!s || s.loading) return
    const raw = p.update
    switch (raw.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const u = parseOrDrop(TEXT_CHUNK, raw, raw.sessionUpdate)
        const kind = raw.sessionUpdate === 'agent_message_chunk' ? 'agent' : 'thought'
        const received = u?.content?.type === 'text' ? (u.content.text ?? '') : ''
        if (!received) return
        // Inbound text goes onto the timeline exactly as the agent wrote it,
        // tokens included: a token split across two chunks is whole again in the
        // accumulated entry, and the chat view reveals it at render time.
        const text = received
        const last = s.entries[s.entries.length - 1]
        if (last && last.kind === kind) {
          this.append(s, { type: 'append', id: last.id, text, at: Date.now() })
        } else {
          this.push(s, { kind, text })
        }
        break
      }
      case 'tool_call': {
        const u = parseOrDrop(TOOL_CALL, raw, 'tool_call')
        if (!u) return
        const detail = this.toolDetail(u.content)
        this.push(s, {
          kind: 'tool',
          toolCallId: u.toolCallId,
          title: u.title ?? u.kind ?? 'tool call',
          status: u.status ?? 'pending',
          ...(u.kind ? { toolKind: u.kind } : {}),
          ...(detail ? { detail } : {}),
          ...(isTerminalToolStatus(u.status) ? { endAt: Date.now() } : {})
        })
        break
      }
      case 'tool_call_update': {
        const u = parseOrDrop(TOOL_CALL, raw, 'tool_call_update')
        if (!u) return
        const entry = s.entries.find((e) => e.kind === 'tool' && e.toolCallId === u.toolCallId)
        if (entry && entry.kind === 'tool') {
          const detail = this.toolDetail(u.content)
          this.append(s, {
            type: 'patch',
            id: entry.id,
            patch: {
              ...(u.status ? { status: u.status } : {}),
              ...(u.title ? { title: u.title } : {}),
              ...(detail ? { detail } : {}),
              ...(isTerminalToolStatus(u.status) && entry.endAt == null ? { endAt: Date.now() } : {})
            }
          })
        }
        break
      }
      case 'plan': {
        const u = parseOrDrop(PLAN_UPDATE, raw, 'plan')
        if (!u) return
        s.plan = u.entries.map((e) => ({
          content: e.content,
          ...(e.priority ? { priority: e.priority } : {}),
          status: e.status
        }))
        this.bus.emit('session.changed', { sessionId: s.info.id })
        break
      }
      case 'available_commands_update': {
        const u = parseOrDrop(COMMANDS_UPDATE, raw, 'available_commands_update')
        if (!u) return
        s.commands = u.availableCommands.map((c) => ({
          name: c.name,
          ...(c.description ? { description: c.description } : {})
        }))
        this.cacheAgentConfig(s)
        this.bus.emit('session.changed', { sessionId: s.info.id })
        break
      }
      case 'current_mode_update': {
        const u = parseOrDrop(MODE_UPDATE, raw, 'current_mode_update')
        if (!u) return
        if (s.modes) s.modes.currentModeId = u.currentModeId
        else s.modes = { currentModeId: u.currentModeId, availableModes: [] }
        this.cacheAgentConfig(s)
        this.bus.emit('session.changed', { sessionId: s.info.id })
        break
      }
      case 'config_option_update': {
        const u = parseOrDrop(CONFIG_OPTION_UPDATE, raw, 'config_option_update')
        if (!u) return
        s.configOptions =
          normalizeConfigOptions(u.configOptions, this.agentKinds.get(s.info.agent ?? '')) ??
          s.configOptions
        this.cacheAgentConfig(s)
        this.bus.emit('session.changed', { sessionId: s.info.id })
        break
      }
      case 'usage_update': {
        const u = parseOrDrop(USAGE_UPDATE, raw, 'usage_update')
        if (!u) return
        const agent = s.info.agent
        const usageMeta = agent ? agentMain(this.agentKinds.get(agent))?.usageMeta : undefined
        if (agent && usageMeta) {
          // Plan state some adapters attach to their usage reports.
          const state = usageMeta(u._meta ?? undefined)
          if (state.rejected && s.busy) s.turnRejected = true
          if (state.windows.length || state.overage !== undefined || state.rejected !== undefined)
            this.bus.emit('agent.planUsage', { agent, ...state })
        }
        s.usage = { used: u.used, size: u.size, ...(u.cost ? { cost: u.cost } : {}) }
        this.bus.emit('session.changed', { sessionId: s.info.id })
        break
      }
      default:
        break // user_message_chunk — we add our own copy of the prompt
    }
  }

  /** Permission requests are always interactive — use session modes (e.g. a
   *  bypass/accept-edits mode) to reduce how often the agent asks. */
  private onPermission(params: unknown): unknown {
    const p = parseOrDrop(PERMISSION_REQUEST, params, 'session/request_permission')
    // A request we cannot read is one the user can never answer: refuse it
    // rather than leave the agent waiting on a prompt that was never shown.
    if (!p) return { outcome: { outcome: 'cancelled' } }
    const s = this.bySessionId(p.sessionId)
    const options: PermissionOption[] = p.options.map((o) => ({
      optionId: o.optionId,
      name: o.name ?? o.optionId,
      ...(o.kind ? { kind: o.kind } : {})
    }))
    const title = p.toolCall?.title ?? 'permission request'
    if (!s) return { outcome: { outcome: 'cancelled' } }

    // The gurt tools are our own plumbing: every turn must end with `complete`,
    // and `create_session` only ever produces an inert draft the user still has
    // to launch — that launch *is* the approval step, so a permission prompt
    // here is pure friction (and a walked-away session would hang on it).
    // Always allow, no timeline entry. Recognized by the session's agent's own
    // MCP tool-title format (its plugin's `toolTitles`).
    if (mcpToolOf(title, this.vocabulary(s).toolTitles)?.server === 'gurt') {
      const allow =
        options.find((o) => o.kind === 'allow_once') ??
        options.find((o) => o.kind?.startsWith('allow'))
      if (allow) return { outcome: { outcome: 'selected', optionId: allow.optionId } }
    }

    const entry = this.push(s, { kind: 'permission', title, options })
    return new Promise((resolve) => {
      s.pendingPermissions.set(entry.id, resolve)
      if (s.pendingPermissions.size === 1)
        this.bus.emit('session.awaiting', { sessionId: s.info.id, ref: s.ref, awaiting: true })
    })
  }
}
