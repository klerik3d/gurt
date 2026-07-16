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
} from '../shared/types'
import type { McpDef } from '../shared/mcp'

export type CreateAction = 'run' | 'queue' | 'draft'

export interface GurtApi {
  getTree(): Promise<Tree>
  getMcpDefs(): Promise<McpDef[]>
  getAgents(): Promise<AgentsFile>
  setAgents(agents: AgentsFile): Promise<void>
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
  changesOpenPr(ws: string, task: string, repo: string): Promise<void>
  changesOpenVscode(ws: string, task: string, repo: string): Promise<void>
  createSession(
    ref: EnvRef,
    agent: string,
    prompt: string,
    action: CreateAction,
    mcp: McpSelection[],
    autoAllow: boolean
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
  onTreeChanged(cb: () => void): () => void
  onSessionChanged(cb: (snapshot: SessionSnapshot) => void): () => void
  onProvisionLog(cb: (event: { key: string; line: string }) => void): () => void
}

declare global {
  interface Window {
    gurt: GurtApi
  }
}

export {}
