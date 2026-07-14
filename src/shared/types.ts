// Domain model shared between main and renderer.

export interface AgentConfig {
  enabled: boolean
  secret: string
  /** Env var name receiving the secret; defaults to the agent definition's. */
  secretEnv?: string
}

/** agents.json — registry of available agents, keyed by agent id. */
export type AgentsFile = Record<string, AgentConfig>

export interface RepoConfig {
  name: string
  url: string
  /**
   * Inline devcontainer.json content provided by the user. When empty, the
   * repo's own .devcontainer configuration is used as-is.
   */
  devcontainer: string
}

/** <workspace>/workspace.json */
export interface WorkspaceFile {
  repos: RepoConfig[]
}

export interface EnvState {
  repo: string
  /** Agent bound to this environment (agent id). */
  agent?: string
  containerId?: string
  /** Workspace folder path inside the container, needed to spawn sessions. */
  remoteWorkspaceFolder?: string
  status: 'stopped' | 'starting' | 'running' | 'error'
  error?: string
}

/** <workspace>/<task>/task.json */
export interface TaskFile {
  envs: EnvState[]
}

export interface SessionInfo {
  id: string
  envRepo: string
  task: string
  workspace: string
  title: string
  agent?: string
}

/** Full tree snapshot pushed to the renderer. */
export interface Tree {
  workspaces: {
    name: string
    repos: RepoConfig[]
    tasks: {
      name: string
      envs: (EnvState & { sessions: SessionInfo[] })[]
    }[]
  }[]
}

// Chat timeline entries, produced from ACP session/update notifications.

export interface ChatText {
  kind: 'user' | 'agent' | 'thought'
  text: string
}

export interface ChatToolCall {
  kind: 'tool'
  toolCallId: string
  title: string
  status: string
  /** ACP tool kind: read | edit | execute | search | fetch | ... */
  toolKind?: string
  /** Flattened preview of tool output/diff content. */
  detail?: string
}

export interface ChatSystem {
  kind: 'system'
  text: string
}

export interface PermissionOption {
  optionId: string
  name: string
  kind?: string
}

export interface ChatPermission {
  kind: 'permission'
  title: string
  options: PermissionOption[]
  /** optionId picked by the user (or 'auto'/'cancelled'). */
  chosen?: string
}

export type ChatEntryBase = ChatText | ChatToolCall | ChatSystem | ChatPermission
export type ChatEntry = ChatEntryBase & { id: number }

export interface SessionMode {
  id: string
  name: string
}

export interface SessionModes {
  currentModeId: string
  availableModes: SessionMode[]
}

export interface PlanEntry {
  content: string
  priority?: string
  status: string
}

export interface CommandInfo {
  name: string
  description?: string
}

export interface SessionSnapshot {
  info: SessionInfo
  entries: ChatEntry[]
  /** Agent is processing a prompt right now. */
  busy: boolean
  autoAllow: boolean
  modes?: SessionModes
  plan?: PlanEntry[]
  commands?: CommandInfo[]
}

/** One record in <workspace>/<task>/sessions.json. */
export interface PersistedSession {
  info: SessionInfo
  acpSessionId: string
  entries: ChatEntry[]
}

export interface EnvRef {
  workspace: string
  task: string
  repo: string
}
