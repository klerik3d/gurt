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

/** Terminal turn report, submitted via the `gurt` MCP server's `complete` tool. */
export interface ChangeProposal {
  version: 1
  /** changes — working tree holds work to ship; no_changes — nothing to ship
   *  (answer, analysis, no-op); blocked — cannot finish, see reason. */
  outcome: 'changes' | 'no_changes' | 'blocked'
  /** Only with outcome=changes (required then). */
  commit?: { subject: string; body?: string }
  /** Only with outcome=changes (optional). */
  pr?: { title: string; body?: string }
  /** Only with outcome=blocked (required then). */
  reason?: string
  notes?: string
}

/** Stored proposal: the artifact + host receipt time (ISO). */
export type StoredProposal = ChangeProposal & { at: string }

/**
 * A user-defined agent profile: a named instance of a built-in agent *kind*
 * (see `AgentDef`) carrying its config and a link to its secret. Several
 * instances of one kind can coexist — e.g. two `claude-code` profiles linked to
 * different tokens ("work" / "home"), or an `opencode` pointed at a local model
 * via `env`. The registry starts empty; the user adds instances as needed.
 */
export interface AgentInstance {
  /** Which built-in adapter to launch — references `AgentDef.id`. */
  kind: string
  /** User-facing name shown in pickers and chips. */
  label: string
  /**
   * Link into credentials.json (a `CredentialEntry.id` of an `agent-token`),
   * never a secret — mirrors how a repo links its credential. Absent = the
   * adapter runs with no injected secret (it reports its own auth error).
   */
  credentialId?: string
  /** Env var name receiving the secret; defaults to the kind's default. */
  secretEnv?: string
  /** Extra env vars injected into the adapter (base URL, provider, ...). */
  env?: Record<string, string>
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
  /**
   * Link into credentials.json (a `CredentialEntry.id`), never a secret. Absent
   * = auto-resolve by host. The stored `url` is only the initial clone source;
   * auth and matching operate on the canonical repo identity (see `repoId.ts`).
   */
  credentialId?: string
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
  /** Auto-allow tool calls (map to a bypass/accept mode) vs. confirm each one.
   *  Chosen at session start; kept in sync when the mode is changed later. */
  autoAllow?: boolean
  state: SessionState
  /** MCP servers to attach when this session starts (empty/undefined = none). */
  mcp?: McpSelection[]
  /**
   * Inject native git access (credential helper + transport rewrite, and the gh
   * wrapper) into the agent process when it starts. Off = status quo: no
   * injection, the github MCP remains the delegated remote path. Fixed at the
   * first start of the (env, agent) adapter this session shares (§6).
   */
  gitAccess?: boolean
  /** First prompt, sent automatically when the session starts. */
  startPrompt: string
  /**
   * Config-option values (model, effort, fast mode, …) chosen for this session,
   * keyed by `SessionConfigOption.id`. Applied at start: `model`/`effort` ride
   * `_meta.claudeCode.options` on `session/new`, the rest are reconciled via
   * `session/set_config_option` before the first prompt. Picked from the agent's
   * cached option set (see {@link AgentConfig}); an empty/absent map means "let
   * the agent choose its defaults".
   */
  configValues?: Record<string, string | boolean>
  /** ISO timestamp, present while queued — defines global FIFO order. */
  queuedAt?: string
  /** Runtime overlay (never persisted): the agent is processing a prompt right now. */
  busy?: boolean
  /** Runtime overlay (never persisted): a permission request awaits the user's decision. */
  awaitingInput?: boolean
  /** Runtime overlay (never persisted): the turn ended without a `complete` call and the
   *  automatic nudge did not heal it — a protocol violation surfaced in the snapshot. */
  incomplete?: boolean
}

/**
 * Fine-grained status shown in the session tree — the persisted {@link SessionState}
 * split by the live runtime overlay so a `started` session reads as one of:
 *   running — the agent is working, waiting — it needs the user, idle — turn done.
 */
export type SessionStatus =
  | 'draft'
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'idle'

/** Collapse (persisted state + runtime overlay) into the status the tree renders. */
export function sessionStatus(s: SessionInfo): SessionStatus {
  if (s.state !== 'started') return s.state // draft | queued | starting
  if (s.awaitingInput) return 'waiting'
  if (s.busy) return 'running'
  return 'idle'
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

// Append-only session log. The chat timeline is a fold over these records;
// the same fold runs in main (derive state) and in the renderer (apply deltas).

export type SessionLogRecord =
  /** New timeline entry; `entry.id` is unique and ascending per session. */
  | { seq: number; type: 'entry'; entry: ChatEntry }
  /** Streaming text delta appended to a ChatText entry. */
  | { seq: number; type: 'append'; id: number; text: string }
  /** In-place update of a tool call / permission entry. */
  | {
      seq: number
      type: 'patch'
      id: number
      patch: { status?: string; title?: string; detail?: string; chosen?: string }
    }

/**
 * Pure fold used by BOTH main (derive entries) and renderer (apply deltas).
 * Returns a new array; the input is not mutated. Unknown `id`s and unknown
 * record types are ignored (forward compatibility); a re-delivered `entry`
 * record replaces the entry with the same id instead of duplicating it.
 */
export function applyLog(entries: ChatEntry[], records: SessionLogRecord[]): ChatEntry[] {
  const out = entries.slice()
  const index = new Map<number, number>()
  out.forEach((e, i) => index.set(e.id, i))
  for (const r of records) {
    if (r.type === 'entry') {
      const i = index.get(r.entry.id)
      if (i == null) {
        index.set(r.entry.id, out.length)
        out.push(r.entry)
      } else {
        out[i] = r.entry
      }
    } else if (r.type === 'append') {
      const i = index.get(r.id)
      if (i == null) continue
      const e = out[i]
      if ('text' in e) out[i] = { ...e, text: e.text + r.text }
    } else if (r.type === 'patch') {
      const i = index.get(r.id)
      if (i == null) continue
      const defined = Object.fromEntries(
        Object.entries(r.patch).filter(([, v]) => v !== undefined)
      )
      out[i] = { ...out[i], ...defined } as ChatEntry
    }
    // other record types: ignored
  }
  return out
}

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
 * ACP prompt capabilities (from `initialize` → `agentCapabilities.promptCapabilities`).
 * Baseline text + resource-link is always supported; these are the opt-in extras. The
 * composer gates the matching affordances (e.g. image attach) on them.
 */
export interface PromptCapabilities {
  image?: boolean
  audio?: boolean
  embeddedContext?: boolean
}

/** One selectable value of a `select` config option. */
export interface ConfigSelectOption {
  value: string
  name: string
  description?: string
}

/**
 * A live, agent-reported session configuration selector (ACP `SessionConfigOption`),
 * reported by `session/new` / `session/load` and updated via `config_option_update`.
 * Changed through `session/set_config_option`. `category` is a UX hint:
 * `'model' | 'model_config' | 'thought_level' | 'mode'` or an agent-specific string.
 */
export interface SessionConfigOption {
  id: string
  name: string
  description?: string
  category?: string
  type: 'select' | 'boolean'
  /** select → the selected option's value id; boolean → the toggle state. */
  currentValue: string | boolean
  /** Present for `type: 'select'` — flattened (any option groups are inlined). */
  options?: ConfigSelectOption[]
}

/**
 * The last-known configuration surface of an agent instance — the selectors and
 * commands it reports, cached so the New Session modal can offer model/effort/
 * command choices *before* a container is up (getting them live requires an
 * expensive `session/new` inside the env). Seeded from a hardcoded default
 * (see `defaultAgentConfig`) and refreshed on every real session start/load, so
 * the cache is the source of truth the UI reads.
 */
export interface AgentConfig {
  /** Live-reported config selectors (model, effort, fast mode, …). */
  configOptions: SessionConfigOption[]
  /** Slash commands the agent exposes. */
  commands: CommandInfo[]
  /** Permission/interaction modes, when reported. */
  modes?: SessionModes
  /** ISO timestamp of the last refresh from a live session; absent for a seed. */
  updatedAt?: string
}

/** agent-config-cache.json — per agent-instance id (see `AgentInstance`). */
export type AgentConfigCache = Record<string, AgentConfig>

/** An image the user attached to a prompt — sent as an ACP `image` content block. */
export interface PromptImage {
  name: string
  /** e.g. `image/png`. */
  mimeType: string
  /** Base64-encoded bytes (no data-uri prefix). */
  data: string
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
  /** Full folded timeline — present from `session:snapshot` only; the per-change
   *  `session-changed` broadcast omits it (deltas ride the `session-log` event). */
  entries?: ChatEntry[]
  /** Agent is processing a prompt right now. */
  busy: boolean
  /** `session/load` in flight — the UI shows a live "resuming" indicator. */
  resuming?: boolean
  modes?: SessionModes
  plan?: PlanEntry[]
  commands?: CommandInfo[]
  /** Live agent-reported config selectors (model, effort, …). */
  configOptions?: SessionConfigOption[]
  /** What content the agent accepts in prompts, for gating composer affordances. */
  promptCapabilities?: PromptCapabilities
  /** Last failure that put the session back to draft. */
  startError?: string
  /** 1-based position in the global queue, present while queued. */
  queuePosition?: number
  /** Latest change proposal from a `complete` call (outcome=changes), if any. */
  proposal?: StoredProposal
}

/**
 * One record in <workspace>/<task>/sessions.json. `acpSessionId` is present only
 * once the session has started; `starting` is never persisted (restores as draft).
 * The timeline lives in the per-session JSONL log, not here.
 */
export interface PersistedSession {
  info: SessionInfo
  acpSessionId?: string
  /** Latest change proposal (outcome=changes) submitted via `complete`; last one wins. */
  proposal?: StoredProposal
  /** Legacy pre-log format; migrated to the JSONL log on restore. */
  entries?: ChatEntry[]
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
