// One source of truth for the renderer-facing API. main builds a `GurtApi`
// implementation over the kernel and registers one handler per method; preload
// derives `window.gurt` from `API_METHODS`. Adding a method here is the whole
// wiring — no per-method glue in main/preload.
import type {
  AgentConfig,
  AgentsFile,
  EnvConfig,
  EnvRef,
  McpSelection,
  PromptContext,
  PromptImage,
  RepoChanges,
  RepoConfig,
  SessionInfo,
  SessionSnapshot,
  StoredProposal,
  Tree
} from './types'
import type { CredentialsFile } from './credentials'
import type { DomainEvents } from './events'
import type { McpDef } from './mcp'

export type CreateAction = 'run' | 'queue' | 'draft'

/** Editable settings of a draft session (all optional — only supplied keys change). */
export interface SessionDraftPatch {
  agent?: string
  /** Re-point the not-yet-started session onto another env definition. */
  env?: string
  /** The session's repo: a repo name, `null` to clear it, absent to leave it. */
  repo?: string | null
  autoAllow?: boolean
  gitAccess?: boolean
  mcp?: McpSelection[]
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
  addRepo(ws: string, repo: RepoConfig): Promise<void>
  discoverDevcontainer(url: string): Promise<{ path: string; content: string } | null>
  updateRepo(ws: string, repo: RepoConfig): Promise<void>
  removeRepo(ws: string, name: string): Promise<void>
  /** Register an env definition in the workspace. */
  addEnv(ws: string, env: EnvConfig): Promise<void>
  /** Update an env definition, matched by its (immutable) name. */
  updateEnv(ws: string, env: EnvConfig): Promise<void>
  /** Remove an env definition (blocked while any task has an instance of it). */
  removeEnv(ws: string, name: string): Promise<void>
  createTask(ws: string, name: string): Promise<void>
  removeTask(ws: string, name: string): Promise<void>
  taskDirtyRepos(ws: string, name: string): Promise<string[]>
  stopEnv(ref: EnvRef): Promise<void>
  /** Tear down one task's env instance (container + clone). */
  removeTaskEnv(ref: EnvRef): Promise<void>
  /** Git state of every clone of the task, computed on the host; `fetch` reaches the network. */
  getTaskChanges(ws: string, task: string, opts?: { fetch?: boolean }): Promise<RepoChanges[]>
  /** Read-only unified diff of one file (untracked shown as whole-file added). */
  getFileDiff(ws: string, task: string, repo: string, file: string): Promise<string>
  /** Read-only `git show` of one commit of the thread. */
  getCommitDiff(ws: string, task: string, repo: string, sha: string): Promise<string>
  changesCommit(ws: string, task: string, repo: string, message: string): Promise<void>
  changesPush(ws: string, task: string, repo: string): Promise<void>
  /** Newest change proposal for this env, if any — the Commit modal prefills from it. */
  latestProposal(ws: string, task: string, repo: string): Promise<StoredProposal | undefined>
  /** Open the browser at the forge's compare URL (impl: `prUrl` + `shell.openExternal`). */
  changesOpenPr(ws: string, task: string, repo: string): Promise<void>
  changesOpenVscode(ws: string, task: string, repo: string): Promise<void>
  createSession(
    ref: EnvRef,
    /** The session's repo (a repo name), or null for a repo-less draft. */
    repo: string | null,
    agent: string,
    prompt: string,
    action: CreateAction,
    mcp: McpSelection[],
    autoAllow: boolean,
    gitAccess: boolean,
    configValues: Record<string, string | boolean>
  ): Promise<SessionInfo>
  sessionRun(id: string): Promise<void>
  sessionEnqueue(id: string): Promise<void>
  sessionCancelQueue(id: string): Promise<void>
  sessionEditPrompt(id: string, text: string): Promise<void>
  /** Change a draft's settings (agent, repo, mode, git, MCP, prompt) before it starts. */
  sessionEditDraft(id: string, patch: SessionDraftPatch): Promise<void>
  sessionDelete(id: string): Promise<void>
  sessionSnapshot(id: string): Promise<SessionSnapshot | undefined>
  sessionPrompt(
    id: string,
    text: string,
    context?: PromptContext[],
    images?: PromptImage[]
  ): Promise<void>
  sessionCancel(id: string): Promise<void>
  sessionSetMode(id: string, modeId: string): Promise<void>
  /** Change a live agent-reported config option (model, effort, fast-mode, …). */
  sessionSetConfigOption(id: string, configId: string, value: string | boolean): Promise<void>
  sessionPermission(id: string, entryId: number, optionId: string): Promise<void>
  /** Ping that the user is active in this session (e.g. typing) — postpones env auto-stop. */
  sessionActivity(id: string): Promise<void>
}

/** Compile-checked to cover `GurtApi` exactly: a missing method fails the
 *  `Record` requirement, an extra one fails the `satisfies` excess check. */
const METHODS = {
  getTree: true,
  getMcpDefs: true,
  getAgents: true,
  setAgents: true,
  getAgentConfig: true,
  getCredentials: true,
  setCredentials: true,
  credentialUsedBy: true,
  createWorkspace: true,
  addRepo: true,
  discoverDevcontainer: true,
  updateRepo: true,
  removeRepo: true,
  addEnv: true,
  updateEnv: true,
  removeEnv: true,
  createTask: true,
  removeTask: true,
  taskDirtyRepos: true,
  stopEnv: true,
  removeTaskEnv: true,
  getTaskChanges: true,
  getFileDiff: true,
  getCommitDiff: true,
  changesCommit: true,
  changesPush: true,
  latestProposal: true,
  changesOpenPr: true,
  changesOpenVscode: true,
  createSession: true,
  sessionRun: true,
  sessionEnqueue: true,
  sessionCancelQueue: true,
  sessionEditPrompt: true,
  sessionEditDraft: true,
  sessionDelete: true,
  sessionSnapshot: true,
  sessionPrompt: true,
  sessionCancel: true,
  sessionSetMode: true,
  sessionSetConfigOption: true,
  sessionPermission: true,
  sessionActivity: true
} as const satisfies Record<keyof GurtApi, true>

/** Runtime method list; `api:<method>` is the IPC channel per entry. */
export const API_METHODS = Object.keys(METHODS) as readonly (keyof GurtApi)[]

/** Push channels main broadcasts to the renderer, with their payloads. */
export interface GurtEvents {
  'tree-changed': void
  /** Snapshot without `entries` — timeline deltas ride `session-log`. */
  'session-changed': SessionSnapshot
  'session-log': DomainEvents['session.log']
  'session-turn': DomainEvents['session.turn']
  'provision-log': { key: string; line: string }
}
