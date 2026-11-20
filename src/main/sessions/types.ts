import type {
  AcpHttpMcpServer,
  AgentConfig,
  AgentSessionRequest,
  ChangeProposal,
  ChatEntry,
  EnvRef,
  HostBusy,
  McpSelection,
  PersistedSession,
  PromptCapabilities,
  PromptContext,
  PromptImage,
  RepoMode,
  ReviewVerdict,
  SessionConfigOption,
  SessionInfo,
  SessionLogRecord,
  SessionNetwork,
  SessionModes,
  SessionRole,
  SessionSnapshot,
  SkillSelection,
  StoredProposal,
  StoredVerdict
} from '../../shared/types'
import type { CreateAction } from '../../shared/api'
import type { SettledTurn } from '../../shared/reviewLoop'
import type { PlanHold } from '../../shared/planUsage'
import type {
  WakeLate,
  WakeOrigin,
  WatcherConfig,
  WatcherLevel
} from '../../shared/watchers'
import type { ContainerStatusReason } from '../../shared/events'
import type { ProxyConfig } from '../../shared/proxy'
import type { LaunchContext } from '../containers'
import type { AdminHooks, ProactiveHooks, WatcherToolHooks } from '../mcp/gurtServer'
import type { JsonRpcPeer } from '../jsonrpc'
import type { AcpClient } from '../acpClient'

/**
 * One ACP adapter process, owned by one session and running inside that
 * session's container. Held under the session id; `containerId` records which
 * container it was spawned into, so a connection can be recognised as belonging
 * to a container that no longer exists.
 */
export interface Connection {
  peer: JsonRpcPeer
  sessionId: string
  containerId: string
  agent: string
  /** Prompt content the agent accepts, from the `initialize` response
   *  (agent-level). Unset until `initialize` answers, and an agent may report
   *  none at all. */
  promptCapabilities?: PromptCapabilities | undefined
  /** The adapter can `session/fork` (`sessionCapabilities.fork` in `initialize`). */
  canFork?: boolean | undefined
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
export interface PendingPrompt {
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
  origin?: { loop: string } | { limit: true; of: 'wake' | 'user' } | WakeOrigin | undefined
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
  storageFault?(sessionId: string): void
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

/**
 * What the watcher manager tells the session manager (docs/requirements-
 * watchers.md §5.1): the settings of a managed watcher, and who hears of the
 * host's own decisions. With no hooks registered, the manager behaves exactly
 * as it did before watchers existed.
 */
export interface WatcherHooks {
  /** The settings of this session's watcher; undefined = not a managed one. */
  config(sessionId: string): WatcherConfig | undefined
  /** The host ended the watcher (`expired`) or it went blind: tell the user. */
  notify(sessionId: string, level: WatcherLevel, text: string, reason: 'expired' | 'blind'): void
}

/** One clone a session claims (see `SessionManager.claims`). */
export interface Claim {
  /** `<ws>/<task>/<repo>` — the clone, shared by the task's sessions. */
  key: string
  repo: string
  /** A `write` mount; a `read-locked` one claims shared. */
  exclusive: boolean
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
export interface Session {
  info: SessionInfo
  ref: EnvRef
  acpSessionId?: string | undefined
  /** Conversation to hand the agent ahead of the next prompt — set by a rewind
   *  the adapter could not fork natively. Persisted until that prompt is sent. */
  preface?: string | undefined
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
  /** Gurt itself is working on the session between its turns — the review
   *  loop's automatic check (runtime only; see {@link SessionInfo.hostBusy}). */
  hostBusy?: HostBusy | undefined
  interrupted?: boolean | undefined
  recovering?: boolean | undefined
  recoveryStarting?: boolean | undefined
  promptRunning?: boolean | undefined
  /** The first turn ended without `complete` and its nudge turn is about to be
   *  sent: `busy` is false in that window, but the session is not idle — nothing
   *  may reap, stop or hand off its container. Set before the non-final
   *  `session.turn ended` emit, cleared at the next turn's end. */
  nudgePending?: boolean | undefined
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
  /** Where the turn in flight came from (docs/requirements-watchers.md §10):
   *  persisted beside `interrupted`, like `loopRan`. */
  ranOrigin?: 'wake' | 'user' | undefined
  /** A watcher recovered at boot with approved work only: the manager resumes
   *  it by itself, so it stays out of the Resume-sessions checklist. */
  resumeOnBoot?: boolean | undefined
  /** When the turn in flight started (watchers: a cancelled turn's own
   *  schedule is dropped, §5.3) and when the user last pressed Esc. */
  turnStartedAt?: number | undefined
  cancelledAt?: number | undefined
  /** Failed wake turns in a row (§7), and the note of the wake in flight. */
  wakeFailures?: number | undefined
  wakeNote?: string | undefined
  /** The turn in flight is the watcher's own work (a wake or the start prompt):
   *  a Stop that lands before its `session/prompt` is out cancels it (§3). */
  turnGuard?: boolean | undefined
  guardStart?: boolean | undefined
  /** The wake prompt whose queueing write is still in flight. */
  wakeWriting?: PendingPrompt | undefined
  /** Why a due wake is held right now (the late-wake wording, §5.2). */
  wakeHeld?: WakeLate | undefined
  /** A watch's poll is in flight (§6.1): no turn starts until it ends. */
  polling?: boolean | undefined
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

/** What the contract tools filed during the logical turn in flight. */
export interface TurnTrack {
  id: string
  /** The turn's last `complete`, any outcome. */
  complete?: StoredProposal | undefined
  /** The turn's last `submit_review`. */
  verdict?: StoredVerdict | undefined
}

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
      /** Present only for a watcher (docs/requirements-watchers.md §4). */
      watcher?: WatcherToolHooks
    }
  ) => Promise<AcpHttpMcpServer>
  /** A proactive run's tools, bound by the session manager to the run's own
   *  workspace, agent (= its scope) and session id — never to anything the
   *  agent says. */
  proactiveFor: (ws: string, agent: string, sessionId: string) => ProactiveHooks
  /** A watcher's tools, bound to its own workspace, scope and session id. */
  watcherFor: (ws: string, task: string, sessionId: string) => WatcherToolHooks
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
  /** Snapshot every writable clone of the session as it stands before this
   *  user entry is sent — the point a rewind to it restores. Rejects when a
   *  clone cannot be snapshotted (the turn fails before the agent is asked).
   *  Absent = no checkpoints: nothing is snapshotted. */
  snapshotCheckpoint?: (info: SessionInfo, entryId: number) => Promise<void>
  /** Rewind the session's writable clones to their snapshot at `entryId`, after
   *  saving each one's current state as a safety checkpoint (all of them durable
   *  before any clone is touched), then drop the checkpoints the rewind made
   *  obsolete. Never rejects: `notice` is the text shown to the user — what was
   *  restored, or why the files were not; `restored` says whether any clone
   *  was. Absent = no checkpoints: nothing is restored. */
  restoreCheckpoint?: (info: SessionInfo, entryId: number) => Promise<{ restored: boolean; notice: string }>
  /** Drop every checkpoint of the session in all of its repos (session deleted
   *  or retired to the archive). Absent = nothing to drop. */
  clearCheckpoints?: (info: SessionInfo) => Promise<void>
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

/** A log record before `append()` stamps its seq (distributive over the union). */
export type NewLogRecord = SessionLogRecord extends infer R
  ? R extends SessionLogRecord
    ? Omit<R, 'seq'>
    : never
  : never

export type { CreateAction }

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

export type PostTurnAction = 'none' | 'nudge' | 'incomplete'

/** How one `session/prompt` round-trip ended, as `sendTurn` reports it. */
export interface TurnResult {
  stopReason?: string | undefined
  threw: boolean
  /** Set when the limit detector claimed the turn (`withLimit`), with the
   *  reset the refusal named, if it named one. */
  limit?: { resetAt?: string | undefined } | undefined
}

/** What `runPrompt` knows of a logical turn's ending — the rest of {@link
 *  SettledTurn} is the artifacts the contract tools filed. */
export type TurnHow = Pick<SettledTurn, 'limited' | 'cancelled' | 'failed' | 'incomplete'>
