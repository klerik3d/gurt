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

/**
 * A user-defined agent profile: a named instance of a built-in agent *kind*
 * (see `AgentDef`) carrying its own credentials and config. Several instances of
 * one kind can coexist — e.g. two `claude-code` profiles with different tokens
 * ("work" / "home"), or an `opencode` pointed at a local model via `env`.
 */
export interface AgentInstance {
  /** Which built-in adapter to launch — references `AgentDef.id`. */
  kind: string
  /** User-facing name shown in pickers and chips. */
  label: string
  enabled: boolean
  secret: string
  /** Env var name receiving the secret; defaults to the kind's default. */
  secretEnv?: string
  /** Extra env vars injected into the adapter (base URL, provider, ...). */
  env?: Record<string, string>
  /** Default model for kinds that support a model picker (see `AgentDef.models`). */
  model?: string
}

/** agents.json — registry of agent instances, keyed by a stable instance id. */
export type AgentsFile = Record<string, AgentInstance>

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
  /** Model id for agents that support model selection (see `AgentDef.models`). */
  model?: string
  /** Auto-allow tool calls (map to a bypass/accept mode) vs. confirm each one.
   *  Chosen at session start; kept in sync when the mode is changed later. */
  autoAllow?: boolean
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

// Changes panel: the delivery thread of a (task, repo) clone —
// see docs/requirements-changes-thread.md.

export interface ChangedFile {
  /** Path relative to the repo root. */
  path: string
  /** Status letter: M/A/D/R (untracked shown as A). */
  status: string
}

/** One commit of the thread — a commit in `<default>..HEAD`. */
export interface ThreadCommit {
  /** Full SHA; the UI shows the short prefix. */
  sha: string
  subject: string
  /** Reachable from `origin/gurt/<task>`. */
  pushed: boolean
}

/** Git state of one clone, computed on the host (works with containers stopped). */
export interface RepoChanges {
  repo: string
  /** Uncommitted changes exist (staged, unstaged, or untracked). */
  dirty: boolean
  files: ChangedFile[]
  insertions: number
  deletions: number
  /** Short name of the default branch: `origin/HEAD`, fallback `main`. */
  defaultBranch: string
  /** Commits in `<default>..HEAD`, newest first. */
  commits: ThreadCommit[]
  /** The thread has landed: no commits left, or `refs/gurt/integrated` == HEAD. */
  integrated: boolean
  /** Forge compare URL — present only when the origin matches a forge and a commit is pushed. */
  prUrl?: string
}

/**
 * There is work to commit or push.
 *
 * An integrated thread is dead history: its commits are excluded, because once the
 * remote branch is pruned they all read as `local` again and would otherwise keep the
 * repo actionable forever. Uncommitted work always counts, integrated or not.
 */
export const isActionable = (r: RepoChanges): boolean =>
  r.dirty || (!r.integrated && r.commits.some((c) => !c.pushed))

/** Pushed and waiting for the remote to merge it — nothing left to do here. */
export const isDelivered = (r: RepoChanges): boolean =>
  !isActionable(r) && !r.integrated && r.commits.some((c) => c.pushed)
