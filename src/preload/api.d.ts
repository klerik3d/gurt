import type {
  AgentsFile,
  EnvRef,
  RepoConfig,
  SessionInfo,
  SessionSnapshot,
  Tree
} from '../shared/types'

export type CreateAction = 'run' | 'queue' | 'draft'

export interface GurtApi {
  getTree(): Promise<Tree>
  getAgents(): Promise<AgentsFile>
  setAgents(agents: AgentsFile): Promise<void>
  createWorkspace(name: string): Promise<void>
  addRepo(ws: string, repo: RepoConfig): Promise<void>
  discoverDevcontainer(url: string): Promise<{ path: string; content: string } | null>
  updateRepo(ws: string, repo: RepoConfig): Promise<void>
  removeRepo(ws: string, name: string): Promise<void>
  createTask(ws: string, name: string): Promise<void>
  removeTask(ws: string, name: string): Promise<void>
  startEnv(ref: EnvRef): Promise<void>
  stopEnv(ref: EnvRef): Promise<void>
  removeEnv(ref: EnvRef): Promise<void>
  createSession(
    ref: EnvRef,
    agent: string,
    prompt: string,
    action: CreateAction
  ): Promise<SessionInfo>
  sessionRun(id: string): Promise<void>
  sessionEnqueue(id: string): Promise<void>
  sessionCancelQueue(id: string): Promise<void>
  sessionEditPrompt(id: string, text: string): Promise<void>
  sessionDelete(id: string): Promise<void>
  sessionSnapshot(id: string): Promise<SessionSnapshot | undefined>
  sessionPrompt(id: string, text: string): Promise<void>
  sessionCancel(id: string): Promise<void>
  sessionSetMode(id: string, modeId: string): Promise<void>
  sessionAutoAllow(id: string, v: boolean): Promise<void>
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
