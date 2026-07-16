// One source of truth for the renderer-facing API. main builds a `GurtApi`
// implementation over the kernel and registers one handler per method; preload
// derives `window.gurt` from `API_METHODS`. Adding a method here is the whole
// wiring — no per-method glue in main/preload.
import type {
  AgentsFile,
  EnvRef,
  McpSelection,
  PromptContext,
  PromptImage,
  RepoChanges,
  RepoConfig,
  SessionInfo,
  SessionSnapshot,
  Tree
} from './types'
import type { CredentialsFile } from './credentials'
import type { McpDef } from './mcp'

export type CreateAction = 'run' | 'queue' | 'draft'

export interface GurtApi {
  getTree(): Promise<Tree>
  getMcpDefs(): Promise<McpDef[]>
  getAgents(): Promise<AgentsFile>
  setAgents(agents: AgentsFile): Promise<void>
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
  createTask(ws: string, name: string): Promise<void>
  removeTask(ws: string, name: string): Promise<void>
  taskDirtyRepos(ws: string, name: string): Promise<string[]>
  startEnv(ref: EnvRef): Promise<void>
  stopEnv(ref: EnvRef): Promise<void>
  removeEnv(ref: EnvRef): Promise<void>
  /** Git state of every clone of the task, computed on the host; `fetch` reaches the network. */
  getTaskChanges(ws: string, task: string, opts?: { fetch?: boolean }): Promise<RepoChanges[]>
  /** Read-only unified diff of one file (untracked shown as whole-file added). */
  getFileDiff(ws: string, task: string, repo: string, file: string): Promise<string>
  /** Read-only `git show` of one commit of the thread. */
  getCommitDiff(ws: string, task: string, repo: string, sha: string): Promise<string>
  changesCommit(ws: string, task: string, repo: string, message: string): Promise<void>
  changesPush(ws: string, task: string, repo: string): Promise<void>
  /** Open the browser at the forge's compare URL (impl: `prUrl` + `shell.openExternal`). */
  changesOpenPr(ws: string, task: string, repo: string): Promise<void>
  changesOpenVscode(ws: string, task: string, repo: string): Promise<void>
  createSession(
    ref: EnvRef,
    agent: string,
    prompt: string,
    action: CreateAction,
    mcp: McpSelection[],
    autoAllow: boolean,
    gitAccess: boolean
  ): Promise<SessionInfo>
  sessionRun(id: string): Promise<void>
  sessionEnqueue(id: string): Promise<void>
  sessionCancelQueue(id: string): Promise<void>
  sessionEditPrompt(id: string, text: string): Promise<void>
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
  getCredentials: true,
  setCredentials: true,
  credentialUsedBy: true,
  createWorkspace: true,
  addRepo: true,
  discoverDevcontainer: true,
  updateRepo: true,
  removeRepo: true,
  createTask: true,
  removeTask: true,
  taskDirtyRepos: true,
  startEnv: true,
  stopEnv: true,
  removeEnv: true,
  getTaskChanges: true,
  getFileDiff: true,
  getCommitDiff: true,
  changesCommit: true,
  changesPush: true,
  changesOpenPr: true,
  changesOpenVscode: true,
  createSession: true,
  sessionRun: true,
  sessionEnqueue: true,
  sessionCancelQueue: true,
  sessionEditPrompt: true,
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
  'session-changed': SessionSnapshot
  'provision-log': { key: string; line: string }
}
