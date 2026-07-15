// Domain model shared between main and renderer.

/** How much of an MCP server's toolset the agent may use. */
export type McpMode = 'read-only' | 'full'

/** An MCP server the user picked for a session, with its granted access level. */
export interface McpSelection {
  id: string
  mode: McpMode
}

/** ACP http-transport MCP server descriptor, passed in session/new & session/load. */
export interface AcpHttpMcpServer {
  type: 'http'
  name: string
  url: string
  headers: { name: string; value: string }[]
}

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

export type EnvStatus = 'stopped' | 'starting' | 'running' | 'error'

/**
 * An environment is pure infrastructure: a clone + devcontainer per (task, repo).
 * It is agent-agnostic — different agents' adapters coexist in the one container.
 */
export interface EnvState {
  repo: string
  containerId?: string
  /** Workspace folder path inside the container, needed to spawn sessions. */
  remoteWorkspaceFolder?: string
  status: EnvStatus
  error?: string
}

/** <workspace>/<task>/task.json */
export interface TaskFile {
  envs: EnvState[]
}

/**
 * draft   — has a start prompt, never runs until the user runs/enqueues it.
 * queued  — waiting in the global FIFO queue.
 * starting— being launched (runtime-only; a crash mid-start restores as draft).
 * started — a live chat session.
 */
export type SessionState = 'draft' | 'queued' | 'starting' | 'started'

export interface SessionInfo {
  id: string
  envRepo: string
  task: string
  workspace: string
  title: string
  agent?: string
  state: SessionState
  /** MCP servers to attach when this session starts (empty/undefined = none). */
  mcp?: McpSelection[]
  /** First prompt, sent automatically when the session starts. */
  startPrompt: string
  /** ISO timestamp, present while queued — defines global FIFO order. */
  queuedAt?: string
}

/** Full tree snapshot pushed to the renderer. */
export interface Tree {
  workspaces: {
    name: string
    repos: RepoConfig[]
    tasks: {
      name: string
      /** Infrastructure environments (shown in the task pane, not the tree). */
      envs: EnvState[]
      /** Sessions of this task, primary tree nodes. */
      sessions: SessionInfo[]
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

/**
 * A piece of context the user attaches to a prompt in the composer. Sent to the
 * agent as an ACP `resource_link` content block alongside the message text.
 * `path` is a repo-relative (or absolute) path for file/folder context, or a
 * `git:` pseudo-uri (e.g. `git:diff`) for git context.
 */
export interface PromptContext {
  name: string
  path: string
}

export interface SessionSnapshot {
  info: SessionInfo
  entries: ChatEntry[]
  /** Agent is processing a prompt right now. */
  busy: boolean
  modes?: SessionModes
  plan?: PlanEntry[]
  commands?: CommandInfo[]
  /** Last failure that put the session back to draft. */
  startError?: string
  /** 1-based position in the global queue, present while queued. */
  queuePosition?: number
}

/**
 * One record in <workspace>/<task>/sessions.json. `acpSessionId` is present only
 * once the session has started; `starting` is never persisted (restores as draft).
 */
export interface PersistedSession {
  info: SessionInfo
  acpSessionId?: string
  entries: ChatEntry[]
}

export interface EnvRef {
  workspace: string
  task: string
  repo: string
}
