// One source of truth for the renderer-facing API. main builds a `GurtApi`
// implementation over the kernel and registers one handler per method; preload
// derives `window.gurt` from `API_METHODS`. Adding a method here is the whole
// wiring — no per-method glue in main/preload.
import type {
  AgentConfig,
  AgentsFile,
  ChangedFile,
  DiffPair,
  DiffTarget,
  EnvConfig,
  EnvRef,
  McpSelection,
  PromptContext,
  PromptImage,
  RepoChanges,
  RepoConfig,
  ReviewComment,
  ReviewState,
  PendingPromptInfo,
  SessionInfo,
  SessionNetwork,
  SessionRole,
  SessionSnapshot,
  SkillSelection,
  StoredProposal,
  Tree
} from './types'
import type { CredentialsFile } from './credentials'
import type { SessionTraffic } from './proxy'
import type { DomainEvents } from './events'
import type { McpDef, McpProbeResult, McpRegistryEntry } from './mcp'
import type { SkillEntry } from './skills'
import type { TurnRecord } from './usage'
import type { PlanUsage } from './planUsage'
import type { NotificationPrefs, NotificationRecord } from './notifications'
import type { HotkeyMap } from './hotkeys'

export type CreateAction = 'run' | 'queue' | 'draft'

/** Where the boot restore currently is — what the footer's startup bar shows.
 *  `done` flips once the kernel is ready (or its restore failed; the app is
 *  usable either way). */
export type BootProgress = DomainEvents['boot.progress']

/** Image state of a saved env config, shown as a badge in Settings. */
export interface EnvImageStatus {
  state:
    | 'not-applicable' // config has no build section
    | 'no-repo' //         build section but no default repo to build from
    | 'invalid' //         validateEnvConfig failed
    | 'exists'
    | 'missing'
  /** For exists | missing. */
  tag?: string
  /** Remote HEAD used for the tag. */
  commit?: string
}

/** Editable settings of a draft session (all optional — only supplied keys change). */
export interface SessionDraftPatch {
  agent?: string
  /** Re-point the not-yet-started session onto another env definition. */
  env?: string
  /** What the session is for. Editable only while it is a draft — nothing has
   *  been mounted or locked yet (see `SessionRole`). */
  role?: SessionRole
  /** The session's repos (repo names, `repos[0]` is the build anchor); absent
   *  to leave them unchanged. */
  repos?: string[]
  autoAllow?: boolean
  mcp?: McpSelection[]
  /** Skills to mount when the session starts. Absent leaves them unchanged;
   *  `[]` clears the selection. A change releases the draft's container — the
   *  mount list is decided when the container is created
   *  (docs/requirements-skills.md §5.2). */
  skills?: SkillSelection[]
  /** Egress settings — the session network's `internal` flag and its domain
   *  policy. Absent leaves them unchanged. */
  network?: SessionNetwork
  startPrompt?: string
  /** Config-option picks (model, effort, …), keyed by option id. */
  configValues?: Record<string, string | boolean>
}

export interface GurtApi {
  getTree(): Promise<Tree>
  getMcpDefs(): Promise<McpDef[]>
  getAgents(): Promise<AgentsFile>
  setAgents(agents: AgentsFile): Promise<void>
  /** Cached (or hardcoded-default) config surface of an agent instance — the
   *  New Session modal reads it to offer model/effort/command choices upfront. */
  getAgentConfig(agentId: string): Promise<AgentConfig>
  getCredentials(): Promise<CredentialsFile>
  /** Replace the whole credential set; rejects if a still-linked entry was dropped. */
  setCredentials(data: CredentialsFile): Promise<void>
  /** Repos (as `ws/repo`) linking to a credential id — for delete-blocking. */
  credentialUsedBy(id: string): Promise<string[]>
  createWorkspace(name: string): Promise<void>
  /** Delete a whole workspace: every task, environment, clone and session goes with it. */
  removeWorkspace(name: string): Promise<void>
  addRepo(ws: string, repo: RepoConfig): Promise<void>
  /** Resolves credentials the same way session clones do (by registered repo,
   *  honoring a repo-linked credential), so it works for private repos too.
   *  When the found config has `build.dockerfile`, the companion Dockerfile is
   *  returned too — the env editor seeds both fields at once. */
  discoverDevcontainer(
    ws: string,
    repo: string
  ): Promise<{
    path: string
    content: string
    dockerfile?: { path: string; content: string }
  } | null>
  /** Dockerfile candidates (with content) from the repo (root +
   *  `.devcontainer/**`), loaded into the env editor's Dockerfile field —
   *  editable there after loading, not re-read from the repo. */
  discoverDockerfiles(ws: string, repo: string): Promise<{ path: string; content: string }[]>
  /** Image status of the SAVED env config (badge in Settings → Environments). */
  envImageStatus(ws: string, env: string): Promise<EnvImageStatus>
  /** Pre-build the SAVED env config's image from its default repo's HEAD; the
   *  build log streams over `provision-log` with key `env-build:<ws>/<env>`. */
  envBuildImage(ws: string, env: string): Promise<{ tag: string }>
  updateRepo(ws: string, repo: RepoConfig): Promise<void>
  removeRepo(ws: string, name: string): Promise<void>
  /** Register an env definition in the workspace. */
  addEnv(ws: string, env: EnvConfig): Promise<void>
  /** Update an env definition, matched by its (immutable) name. */
  updateEnv(ws: string, env: EnvConfig): Promise<void>
  /** Remove an env definition (blocked while any session still runs it). */
  removeEnv(ws: string, name: string): Promise<void>
  /** Set (or clear, passing `undefined`) the workspace's default agent — used
   *  to resolve a session created here without an explicit `agent`. Rejects an
   *  id the workspace's own deny-list already carries. */
  setDefaultAgent(ws: string, agentId: string | undefined): Promise<void>
  /** Replace the workspace's agent deny-list wholesale (empty = deny nothing).
   *  Rejects a list that would deny the workspace's current default agent. */
  setDeniedAgents(ws: string, agentIds: string[]): Promise<void>
  /** The workspace's user-configured MCP servers (§3.1). Built-ins are a
   *  separate, code-owned list — see `getMcpDefs`. */
  getMcpServers(ws: string): Promise<McpRegistryEntry[]>
  /** Register an MCP server in the workspace. Rejects a reserved or duplicate
   *  id, a non-http(s) url, or a credential link that is not an mcp-token. */
  addMcpServer(ws: string, entry: McpRegistryEntry): Promise<void>
  /** Update an MCP server, matched by its (immutable) id. */
  updateMcpServer(ws: string, entry: McpRegistryEntry): Promise<void>
  /** Remove an MCP server (blocked while a session's selection names it). */
  removeMcpServer(ws: string, id: string): Promise<void>
  /**
   * The workspace's skill registry, read off disk
   * (`~/.gurt/<ws>/skills/*`, docs/requirements-skills.md §4.1). An entry whose
   * `SKILL.md` is unreadable or malformed comes back carrying a `problem`
   * rather than being left out — it is still selectable, still deletable, and
   * still the thing the user has to be shown to fix.
   */
  getSkills(ws: string): Promise<SkillEntry[]>
  /** The one skill's `SKILL.md`, verbatim — what the editor opens. */
  getSkillDoc(ws: string, name: string): Promise<string>
  /** Create a skill directory with this `SKILL.md`. Rejects a bad or duplicate
   *  name, and a document whose frontmatter does not carry a matching `name`
   *  and a `description`. */
  addSkill(ws: string, name: string, doc: string): Promise<void>
  /** Rewrite a skill's `SKILL.md`, matched by its (immutable) name — renaming
   *  is not supported, the name is what a session's selection stores. Supporting
   *  files beside it are untouched. */
  updateSkill(ws: string, name: string, doc: string): Promise<void>
  /** Delete a skill directory and everything in it (blocked while a session's
   *  selection names it). */
  removeSkill(ws: string, name: string): Promise<void>
  /** Task names with a session selecting this skill — what blocks a delete, and
   *  what the confirm dialog names. */
  skillUsedBy(ws: string, name: string): Promise<string[]>
  /** Replace the workspace's default-on skill set wholesale (empty = none).
   *  Rejects a name the registry does not hold. */
  setDefaultSkills(ws: string, names: string[]): Promise<void>
  /** Point the workspace's operator sessions at one of its own envs, or back
   *  at the bundled default (`undefined`) — the operator twin of
   *  `setDefaultAgent` (docs/requirements-session-operator.md §2.2). Rejects
   *  an env the registry does not hold. */
  setOperatorEnv(ws: string, env: string | undefined): Promise<void>
  /**
   * Reinstall an `npm` entry's package: drops the install stamp, so the next
   * start resolves the spec against the registry again instead of reusing what
   * is already under `~/.gurt/mcp/<id>/`.
   *
   * This is the button behind `version: 'latest'` — the pin is deliberate
   * (docs/requirements-mcp-stdio.md §4.2), so "get a newer latest" has to be
   * something the user asks for. Like every other registry change it takes
   * effect the next time the server starts; a running process is not restarted
   * under the sessions holding it (§10).
   */
  reinstallMcpServer(ws: string, id: string): Promise<void>
  /**
   * Start this entry the way a session would, speak MCP to it, and report what
   * it answered — a local entry is installed, spawned, handshaken and stopped
   * again; a remote one is handshaken with the headers the proxy would send
   * (docs/requirements-mcp-stdio.md §4.6).
   *
   * Takes the whole entry, not an id, because the case it exists for is the
   * one where there is no id to read yet: the snippet just pasted into the
   * editor, checked before it is saved. `ws` addresses the workspace the entry
   * belongs to, like every other method here; nothing about the probe is read
   * from it — that is what makes an unsaved entry probeable.
   *
   * Never rejects for the server's own failure: the reason rides in the result
   * as a sentence for the user. It rejects only for a broken call.
   *
   * Explicitly **not** run on save. A local entry executes third-party code on
   * the host with the user's privileges (§2), so running it is a decision the
   * user makes, next to the notice that says so.
   */
  probeMcpServer(ws: string, entry: McpRegistryEntry): Promise<McpProbeResult>
  createTask(ws: string, name: string): Promise<void>
  removeTask(ws: string, name: string): Promise<void>
  /** Rename a task; stops its containers and best-effort renames its branch in every clone. */
  renameTask(ws: string, name: string, newName: string): Promise<void>
  taskDirtyRepos(ws: string, name: string): Promise<string[]>
  /** Set/clear the task's cap on concurrently running sessions (undefined or
   *  0 clears it — unlimited). */
  setTaskMaxConcurrentSessions(ws: string, name: string, max: number | undefined): Promise<void>
  /** Stop a session's container; it keeps its filesystem and resumes on next use. */
  stopContainer(sessionId: string): Promise<void>
  /** Destroy a session's container. The clone (and its uncommitted work) stays. */
  releaseContainer(sessionId: string): Promise<void>
  /** Launch VS Code, in its own window, attached to the session's running
   *  container (impl: `ContainerManager.openVscode`). Rejects if it isn't running. */
  sessionOpenVscode(sessionId: string): Promise<void>
  /** Git state of every clone of the task, computed on the host; `fetch` reaches the network. */
  getTaskChanges(ws: string, task: string, opts?: { fetch?: boolean }): Promise<RepoChanges[]>
  /** Read-only unified diff of one file (untracked shown as whole-file added). */
  getFileDiff(ws: string, task: string, repo: string, file: string): Promise<string>
  /** Read-only `git show` of one commit of the thread. */
  getCommitDiff(ws: string, task: string, repo: string, sha: string): Promise<string>
  /** Files one review target touches (see docs/requirements-manual-review.md). */
  getDiffFiles(ws: string, task: string, repo: string, target: DiffTarget): Promise<ChangedFile[]>
  /** Whole before/after content of one file — the split view aligns it renderer-side. */
  getDiffPair(
    ws: string,
    task: string,
    repo: string,
    target: DiffTarget,
    file: string
  ): Promise<DiffPair>
  /** Lock + this target's comments; comments whose file left the target are pruned. */
  getReviewState(ws: string, task: string, repo: string, target: DiffTarget): Promise<ReviewState>
  /** Locked repos of a task, as `repo → true`. A plain read: unlike
   *  `getReviewState` it never prunes, so the panel can poll it freely. */
  getReviewLocks(ws: string, task: string): Promise<Record<string, boolean>>
  /** Take/release the review lock; taking one rejects while a session holds the clone. */
  setReviewLock(ws: string, task: string, repo: string, locked: boolean): Promise<void>
  addReviewComment(
    ws: string,
    task: string,
    repo: string,
    target: DiffTarget,
    path: string,
    side: 'before' | 'after',
    line: number,
    text: string,
    /** 1-based, inclusive; omit for a single-line anchor. */
    endLine?: number
  ): Promise<ReviewComment>
  resolveReviewComment(ws: string, task: string, id: string, resolved: boolean): Promise<void>
  deleteReviewComment(ws: string, task: string, id: string): Promise<void>
  /** Draft an executor session seeded with this target's open comments plus `prompt`. */
  launchReviewFix(
    ws: string,
    task: string,
    repo: string,
    target: DiffTarget,
    prompt: string
  ): Promise<{ sessionId: string }>
  changesCommit(ws: string, task: string, repo: string, message: string): Promise<void>
  changesPush(ws: string, task: string, repo: string): Promise<void>
  /** Merge the fetched default branch into the task branch; conflicts surface as `conflicted`. */
  changesUpdateFromMain(ws: string, task: string, repo: string): Promise<void>
  /** Newest change proposal for this env, if any — the Commit modal prefills from it. */
  latestProposal(ws: string, task: string, repo: string): Promise<StoredProposal | undefined>
  /** Open the browser at the forge's compare URL (impl: `prUrl` + `shell.openExternal`). */
  changesOpenPr(ws: string, task: string, repo: string): Promise<void>
  changesOpenVscode(ws: string, task: string, repo: string): Promise<void>
  createSession(
    ref: EnvRef,
    /** The session's repos (repo names); empty for a repo-less draft. More than
     *  one is researcher-only (see `SessionInfo.repos`). */
    repos: string[],
    agent: string,
    prompt: string,
    action: CreateAction,
    mcp: McpSelection[],
    autoAllow: boolean,
    configValues: Record<string, string | boolean>,
    /** What the session is for — executor unless told otherwise. */
    role: SessionRole,
    /** Skills to mount at start (names of this workspace's registry). */
    skills: SkillSelection[],
    /** Egress settings (`internal` + the allow list). Omitted = the defaults:
     *  a normal bridge, everything allowed and logged. */
    network?: SessionNetwork
  ): Promise<SessionInfo>
  sessionRun(id: string): Promise<void>
  sessionEnqueue(id: string): Promise<void>
  sessionCancelQueue(id: string): Promise<void>
  sessionEditPrompt(id: string, text: string): Promise<void>
  /** Rename a session's display title (sidebar/pane header) — cosmetic only. */
  renameSession(id: string, title: string): Promise<void>
  /** Change a draft's settings (agent, repo, mode, MCP, prompt) before it starts. */
  sessionEditDraft(id: string, patch: SessionDraftPatch): Promise<void>
  /** Copy a session into a fresh **draft** of the same task: its role, env,
   *  repos, agent, MCP/git/auto-allow picks, config values and first prompt come
   *  along; nothing runtime-derived does (no container, no chat, no queue slot).
   *  The answer to "this one was configured wrong" — correct the copy, drop the
   *  original. Works whatever state the source is in. */
  sessionDuplicate(id: string): Promise<SessionInfo>
  /** Delete a session: its container is destroyed with it, its chat log removed.
   *  The clone (and any uncommitted work in it) stays. */
  sessionDelete(id: string): Promise<void>
  sessionSnapshot(id: string): Promise<SessionSnapshot | undefined>
  /** What this session's proxy has been seen doing — the blocked attempts the
   *  session pane leads with, and the observed hosts under them
   *  (docs/requirements-mcp-proxy.md §8). Empty, never absent: a session with
   *  no proxy yet has observed nothing, which is an answer. Live updates ride
   *  `proxy-traffic`; this is the pull for a pane that mounted after them. */
  sessionTraffic(id: string): Promise<SessionTraffic>
  sessionPrompt(
    id: string,
    text: string,
    context?: PromptContext[],
    images?: PromptImage[]
  ): Promise<void>
  sessionCancel(id: string): Promise<void>
  /** Empty this session's prompt queue and return what was in it, so the caller
   *  can put the text back in the composer instead of losing it (see
   *  {@link PendingPromptInfo}). */
  sessionClearPending(id: string): Promise<PendingPromptInfo[]>
  /** The same for one queued prompt, by id; undefined if it already ran. */
  sessionCancelPending(id: string, promptId: string): Promise<PendingPromptInfo | undefined>
  sessionSetMode(id: string, modeId: string): Promise<void>
  /** Change a live agent-reported config option (model, effort, fast-mode, …). */
  sessionSetConfigOption(id: string, configId: string, value: string | boolean): Promise<void>
  sessionPermission(id: string, entryId: number, optionId: string): Promise<void>
  /** Ping that the user is active in this session (e.g. typing) — postpones env auto-stop. */
  sessionActivity(id: string): Promise<void>
  /** Reveal `~/.gurt/logs` in the OS file manager (⌘K → "Open logs folder"). */
  openLogsFolder(): Promise<void>
  /** Manual update check (⌘K → "Check for updates"); a no-op outside packaged
   *  builds. Feedback (up to date / downloading / restart prompt / error) is
   *  a native dialog from main, not a return value — see `main/update.ts`. */
  checkForUpdates(): Promise<void>
  /** In-memory notification history (oldest first) — empty after a relaunch,
   *  see docs/requirements-notifications.md §6. */
  getNotifications(): Promise<NotificationRecord[]>
  markNotificationRead(id: string): Promise<void>
  markAllRead(): Promise<void>
  /** Per-item dismiss (§4.2) — removes the record instead of just marking it read. */
  dismissNotification(id: string): Promise<void>
  getNotificationPrefs(): Promise<NotificationPrefs>
  setNotificationPrefs(prefs: NotificationPrefs): Promise<void>
  /** User overrides for the global keyboard shortcuts, keyed by action —
   *  an action missing from the stored file uses its built-in default. */
  getHotkeys(): Promise<HotkeyMap>
  setHotkeys(map: HotkeyMap): Promise<void>
  /** The retained usage ledger, oldest first — one record per agent turn.
   *  Survives relaunches (unlike the notification ring): it is what puts a
   *  finished session on the dashboard's DONE column and marks its failures. */
  getUsage(): Promise<TurnRecord[]>
  /** Provider-reported plan limits per agent instance, cached and rate-floored
   *  in main. Calling this may poll the network; it never rejects for a failed
   *  poll — the record carries `error` and the previous windows. */
  getPlanUsage(): Promise<Record<string, PlanUsage>>
  /** Current boot-restore progress — the pull for a window that opened after
   *  some `boot-progress` pushes already fired. */
  getBootProgress(): Promise<BootProgress>
}

/**
 * What the operator's admin surface may do with a method
 * (docs/requirements-session-operator.md §3.1):
 *
 *   read  — exposed as an MCP tool on the operator's `gurt` server;
 *   write — exposed the same way once writes land (phase 2 of that document —
 *           until then a `write` annotation is treated as `none`);
 *   none  — never reachable by any tool name, for the reasons its §3.4 groups.
 *
 * The annotation says nothing about the renderer: every method stays on IPC
 * regardless.
 */
export type Exposure = 'read' | 'write' | 'none'

/**
 * Compile-checked to cover `GurtApi` exactly: a missing method fails the
 * `Record` requirement, an extra one fails the `satisfies` excess check — and
 * an *unannotated* method fails it too, which is the point: there is no
 * default exposure. A new API method does not compile until someone decides
 * what the agent may do with it; when that decision is unclear the answer is
 * `none` (the surface fails closed), and widening it later is a one-word diff
 * with a reviewer on it. The full rationale, method by method, is
 * docs/requirements-session-operator.md §13 question 1.
 */
const METHODS = {
  getTree: 'read', //           scoped host-side to the operator's workspace
  getMcpDefs: 'read',
  getAgents: 'read', //         credential links only; values scrubbed (§8)
  setAgents: 'write', //        wholesale replace
  getAgentConfig: 'read',
  getCredentials: 'read', //    ids, labels, kinds — no values (§5.1)
  setCredentials: 'none', //    §5.1: no write path into the credential store
  credentialUsedBy: 'read',
  createWorkspace: 'none', //   bootstrap (§10); binds the operator's authority
  removeWorkspace: 'none', //   destroys clones and their uncommitted work
  addRepo: 'write',
  discoverDevcontainer: 'read', // repo file contents, by the §2.4 exception
  discoverDockerfiles: 'read', //  repo file contents, by the §2.4 exception
  envImageStatus: 'read',
  envBuildImage: 'write',
  updateRepo: 'write',
  removeRepo: 'write',
  addEnv: 'write',
  updateEnv: 'write',
  removeEnv: 'write', //        already blocked while a session runs it
  setDefaultAgent: 'write',
  setDeniedAgents: 'write',
  getMcpServers: 'read',
  addMcpServer: 'write',
  updateMcpServer: 'write',
  removeMcpServer: 'write',
  getSkills: 'read',
  getSkillDoc: 'read',
  addSkill: 'write',
  updateSkill: 'write',
  removeSkill: 'write',
  skillUsedBy: 'read',
  setDefaultSkills: 'write',
  setOperatorEnv: 'write', //   configuring gurt is the point
  reinstallMcpServer: 'write',
  probeMcpServer: 'read', //    narrowed by kind at the host (§6): local kinds by saved id only
  createTask: 'write',
  removeTask: 'none', //        destroys clones holding uncommitted work
  renameTask: 'none', //        rewrites clones (branch renames)
  taskDirtyRepos: 'read',
  setTaskMaxConcurrentSessions: 'write',
  stopContainer: 'none', //     §2.4: does not drive other sessions
  releaseContainer: 'none', //  §2.4
  sessionOpenVscode: 'none', // host GUI
  getTaskChanges: 'read', //    counts and states, not content
  getFileDiff: 'none', //       repo content (§2.4)
  getCommitDiff: 'none', //     repo content (§2.4)
  getDiffFiles: 'none', //      repo content (§2.4)
  getDiffPair: 'none', //       repo content (§2.4)
  getReviewState: 'none', //    comments quote code
  getReviewLocks: 'read', //    why a session cannot start — diagnostics
  setReviewLock: 'none',
  addReviewComment: 'none',
  resolveReviewComment: 'none',
  deleteReviewComment: 'none',
  launchReviewFix: 'none', //   drafts a session (§2.4)
  changesCommit: 'none', //     writes to repos and remotes
  changesPush: 'none', //       writes to repos and remotes
  changesUpdateFromMain: 'none',
  latestProposal: 'none', //    repo content
  changesOpenPr: 'none', //     host browser
  changesOpenVscode: 'none', // host GUI
  createSession: 'none', //     phase 1; §13 question 2
  sessionRun: 'none', //        §2.4: does not start sessions
  sessionEnqueue: 'none', //    §2.4
  sessionCancelQueue: 'none', // §2.4
  sessionEditPrompt: 'none', // §2.4
  renameSession: 'none', //     §2.4
  sessionEditDraft: 'none', //  §2.4
  sessionDuplicate: 'none', //  §2.4
  sessionDelete: 'none', //     §2.4
  sessionSnapshot: 'read', //   narrowed: state and diagnostics, no chat (§3.2)
  sessionTraffic: 'read', //    blocked hosts — the diagnostic the operator exists for
  sessionPrompt: 'none', //     driving another agent
  sessionCancel: 'none', //     driving another agent
  sessionClearPending: 'none',
  sessionCancelPending: 'none',
  sessionSetMode: 'none',
  sessionSetConfigOption: 'none',
  sessionPermission: 'none',
  sessionActivity: 'none',
  openLogsFolder: 'none', //    host GUI
  checkForUpdates: 'none', //   native dialog / update path
  getNotifications: 'read', //  scrubbed, scoped to the operator's workspace
  markNotificationRead: 'none', // the user's own read state
  markAllRead: 'none', //       the user's own read state
  dismissNotification: 'none', // the user's own read state
  getNotificationPrefs: 'read',
  setNotificationPrefs: 'write',
  getHotkeys: 'read',
  setHotkeys: 'write',
  getUsage: 'read',
  getPlanUsage: 'read',
  getBootProgress: 'read'
} as const satisfies Record<keyof GurtApi, Exposure>

/** Runtime method list; `api:<method>` is the IPC channel per entry. */
export const API_METHODS = Object.keys(METHODS) as readonly (keyof GurtApi)[]

/** The annotation at runtime — what the generator, the admin surface and the
 *  acceptance tests read. */
export const METHOD_EXPOSURE: Record<keyof GurtApi, Exposure> = METHODS

/** Methods annotated `read` — the admin surface must bind exactly these
 *  (`Pick<GurtApi, ReadMethod>` in main/adminSurface.ts), so annotating a
 *  method `read` without binding it is a compile error, not a silent gap. */
export type ReadMethod = {
  [K in keyof GurtApi]: (typeof METHODS)[K] extends 'read' ? K : never
}[keyof GurtApi]

/** Methods annotated `write` — phase 2's surface; generated already so the
 *  schema machinery is complete, unreachable until then. */
export type WriteMethod = {
  [K in keyof GurtApi]: (typeof METHODS)[K] extends 'write' ? K : never
}[keyof GurtApi]

/** Push channels main broadcasts to the renderer, with their payloads. */
export interface GurtEvents {
  'tree-changed': void
  /** Snapshot without `entries` — timeline deltas ride `session-log`. */
  'session-changed': SessionSnapshot
  'session-log': DomainEvents['session.log']
  'session-turn': DomainEvents['session.turn']
  'provision-log': { key: string; line: string }
  notification: NotificationRecord
  /** A session's pending notifications were marked read by something other
   *  than a panel click (opened from the sidebar, or its `awaiting` cleared)
   *  — mirrors `DomainEvents['notification.read']`. */
  'notification-read': DomainEvents['notification.read']
  /** A turn was filed (or the ledger pruned) — the dashboard refetches. */
  'usage-changed': DomainEvents['usage.changed']
  /** Boot restore progress — the footer's startup bar (see `BootProgress`). */
  'boot-progress': DomainEvents['boot.progress']
  /** One session's observed traffic changed — coalesced in main, so this is a
   *  few per second at worst even under an `npm install`. */
  'proxy-traffic': DomainEvents['proxy.traffic']
  /** The local MCP servers a session selected and did not get, with the reason
   *  — the whole set per session, an empty one clearing it. */
  'mcp-fail': DomainEvents['mcp.fail']
  /** macOS reserves ⌘`/⌘⇧` system-wide for window cycling and never delivers
   *  them to a DOM keydown handler — main reclaims them as a hidden menu
   *  accelerator (see `main/menu.ts`) and forwards here instead. 1 = next
   *  workspace, -1 = previous. Renderer-only on other platforms, where the
   *  ordinary keydown listener already catches the combination. */
  'hotkey-cycle-workspace': 1 | -1
}
