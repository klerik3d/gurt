// Domain model shared between main and renderer.
import type { McpRegistryEntry } from './mcp'
import type { DomainPolicy } from './proxy'
import type { ProactiveAgentView, ProactiveConfig, ProactiveOrigin } from './proactive'
import type { SettledTurn } from './reviewLoop'
import { sanitizeDomainPolicy } from './proxy'

/** How much of an MCP server's toolset the agent may use. */
export type McpMode = 'read-only' | 'full'

/**
 * An MCP server the user picked for a session, with its granted access level.
 *
 * `id` names either a built-in (`MCP_DEFS`) or an entry of the workspace's
 * registry (`WorkspaceFile.mcpServers`) — one shape for both, resolved through
 * `mcpEntry`/`resolveMcpSelection`. The union is not closed at write time: an
 * id can stop resolving after the fact, so every reader treats an unknown one as
 * "selected but unavailable" rather than as corruption.
 *
 * `mode` is meaningful for built-ins only. gurt knows statically which of *its*
 * tools write and drops them in `read-only`; it knows nothing about an
 * upstream's tools, so a selected registry entry records `full` and the picker
 * offers it as off/on (docs/requirements-mcp-proxy.md §3.3).
 */
export interface McpSelection {
  id: string
  mode: McpMode
}

/**
 * A skill the user picked for a session (docs/requirements-skills.md §4.3).
 *
 * `name` names a directory of the workspace's skill registry
 * (`~/.gurt/<ws>/skills/<name>/`), resolved through `resolveSkillSelection`.
 * Like `McpSelection` the union is not closed at write time: a skill can be
 * deleted after the fact, so every reader treats an unknown name as "selected
 * but unavailable" rather than as corruption.
 *
 * A skill is off or on — there is no `mode` twin to `McpSelection`'s, because
 * gurt hands the agent the files and nothing about them is a capability gurt
 * grants by halves. The record shape stays a record anyway, so the two
 * selections read the same way everywhere they are handled together.
 */
export interface SkillSelection {
  name: string
}

/** ACP http-transport MCP server descriptor, passed in session/new & session/load. */
export interface AcpHttpMcpServer {
  type: 'http'
  name: string
  url: string
  headers: { name: string; value: string }[]
}

/**
 * Terminal turn report, submitted via the `gurt` MCP server's `complete` tool.
 *
 * The optional members carry `| undefined` because this is what the tool's zod
 * schema produces: it arrives as JSON, is validated, and is stored as JSON —
 * "absent" and "present but undefined" are the same value on both sides of that
 * trip, and the schema in mcp/gurtServer.ts is what actually enforces which
 * combinations are legal.
 */
export interface ChangeProposal {
  version: 1
  /** changes — working tree holds work to ship; no_changes — nothing to ship
   *  (answer, analysis, no-op); blocked — cannot finish, see reason. */
  outcome: 'changes' | 'no_changes' | 'blocked'
  /** Only with outcome=changes: the shared proposal, for every `write` repo
   *  without an entry of its own in `repos`. Then required unless `repos` is
   *  given. */
  commit?: { subject: string; body?: string | undefined } | undefined
  /** Only with outcome=changes (optional). */
  pr?: { title: string; body?: string | undefined } | undefined
  /** Only with outcome=changes: a proposal per repo, for a session that writes
   *  several (docs/requirements-repo-mounts.md §3). Each names one of the
   *  session's `write` repos, at most once. */
  repos?: RepoProposal[] | undefined
  /** Only with outcome=blocked (required then). */
  reason?: string | undefined
  notes?: string | undefined
  /** With any outcome: the executor's answers to a review loop's findings
   *  (docs/requirements-review-loop.md §4.2). The first `complete` with
   *  `changes` after a verdict must answer its open set — every finding exactly
   *  once, no unknown id; with no open set they are accepted and ignored. */
  replies?: FindingReply[] | undefined
}

/** One repo's own commit (and optional PR) texts inside a {@link ChangeProposal}. */
export interface RepoProposal {
  repo: string
  commit: { subject: string; body?: string | undefined }
  pr?: { title: string; body?: string | undefined } | undefined
}

/** Stored proposal: the artifact + host receipt time (ISO). */
export type StoredProposal = ChangeProposal & { at: string }

/** One problem a review loop's reviewer reports (docs/requirements-review-loop.md
 *  §4.1). Optional members carry `| undefined` for the same reason as
 *  {@link ChangeProposal}'s: this is what `submit_review`'s zod schema
 *  produces. */
export interface ReviewFinding {
  /** Unique in the verdict, `[A-Za-z0-9_-]{1,16}`; shown — and answered — as
   *  `R<round>.<id>` (see {@link findingRef}). */
  id: string
  /** `<repo>/<path>`, relative to /workspaces; the repo is one of the
   *  reviewer's (a host rule, `assertVerdictFits`). */
  file: string
  line?: number | undefined
  /** blocker — must not ship; major — a real defect to fix before merging;
   *  minor — worth fixing; nit — taste. */
  severity: 'blocker' | 'major' | 'minor' | 'nit'
  claim: string
  evidence?: string | undefined
  suggestion?: string | undefined
}

/** A reviewer's turn report, submitted via `submit_review` (§4.1). Advisory
 *  data, never an approval of a merge. `request_changes` carries at least one
 *  blocker or major; `approve` none. */
export interface ReviewVerdict {
  version: 1
  verdict: 'approve' | 'request_changes'
  summary: string
  findings: ReviewFinding[]
}

/** A verdict as the host records it: receipt time (ISO), the loop round of the
 *  reviewer that gave it (`SessionInfo.reviewOf.round`) and the turn it was
 *  given in (`<sessionId>:<n>`). */
export type StoredVerdict = ReviewVerdict & { at: string; round: number; turnId: string }

/** How a finding is named to the executor and in its replies: "R1.F2". */
export const findingRef = (round: number, id: string): string => `R${round}.${id}`

/** The executor's answer to one finding, inside `complete`'s `replies` (§4.2). */
export interface FindingReply {
  /** The finding's {@link findingRef}, e.g. "R1.F2". */
  findingId: string
  /** declined — won't do it; refuted — the claim is wrong. */
  resolution: 'fixed' | 'declined' | 'refuted'
  /** 1–2000 chars. */
  note: string
}

/**
 * A user-defined agent profile: a named instance of a built-in agent *kind*
 * (see `AgentManifest`) carrying its config and a link to its secret. Several
 * instances of one kind can coexist — e.g. two `claude-code` profiles linked to
 * different tokens ("work" / "home"), or an `opencode` pointed at a local model
 * via `env`. The registry starts empty; the user adds instances as needed.
 */
export interface AgentInstance {
  /** Which built-in adapter to launch — references `AgentManifest.id`. */
  kind: string
  /** User-facing name shown in pickers and chips. */
  label: string
  /**
   * Link into credentials.json (a `CredentialEntry.id` of an `agent-token`),
   * never a secret — mirrors how a repo links its credential. Absent = the
   * adapter runs with no injected secret (it reports its own auth error).
   * Carries `| undefined` because unpicking a credential in Settings clears it
   * by assignment.
   */
  credentialId?: string | undefined
  /** Env var name receiving the secret; defaults to the kind's default. */
  secretEnv?: string
  /** Extra env vars injected into the adapter (base URL, provider, ...). */
  env?: Record<string, string>
  /** Native client JSON settings, materialized in the session container at launch. */
  config?: Record<string, unknown>
}

/** agents.json — registry of agent instances, keyed by a stable instance id. */
export type AgentsFile = Record<string, AgentInstance>

/**
 * Repo identity: a registered git repository of the workspace. Repos and envs
 * are separate entities now — the runtime definition lives on `EnvConfig`,
 * not here.
 */
export interface RepoConfig {
  name: string
  url: string
  /**
   * Link into credentials.json (a `CredentialEntry.id`), never a secret. Absent
   * = auto-resolve by host. The stored `url` is only the initial clone source;
   * auth and matching operate on the canonical repo identity (see `repoId.ts`).
   */
  credentialId?: string
  /**
   * gurt owns this repo's storage: a bare repository it created under
   * `~/.gurt/<ws>/repos/<name>.git`, which `url` points at
   * (docs/requirements-new-projects.md §2). Such a repo has no forge yet —
   * publishing it moves `url` to the forge and drops the flag. Absent = an
   * ordinary repo the user registered by URL.
   */
  local?: true
  /** Run by the review loop in the session container from
   *  /workspaces/<name>, e.g. `npm run lint && npm test`
   *  (docs/requirements-review-loop.md §3, §5.3). Absent = no check for this
   *  repo. Lives with the repo, not the env. */
  check?: string | undefined
  /** Defaults for a new executor draft's Review block, when this repo is its
   *  anchor; `enabled` defaults off. */
  review?: (Partial<ReviewLoopConfig> & { enabled?: boolean | undefined }) | undefined
}

/** What a clean review loop delivers (docs/requirements-review-loop.md §3, §6),
 *  lowest first: each rung includes the ones below it. `merge` is the local
 *  repos' rung, in place of push / pr. */
export type ShipRung = 'notify' | 'commit' | 'push' | 'pr' | 'merge'

export const SHIP_RUNGS: readonly ShipRung[] = ['notify', 'commit', 'push', 'pr', 'merge']

/**
 * An executor draft's Review block (`SessionInfo.review`, §3): absent = no
 * loop. Frozen when the session starts, like skills. Never part of
 * `AgentSessionRequest` — an agent can neither enable the loop nor raise the
 * ladder.
 */
export interface ReviewLoopConfig {
  /** The reviewer's agent instance. */
  agent: string
  /** The reviewer's model/effort/… picks, keyed by `SessionConfigOption.id`,
   *  from that agent's config surface — only what it reports. */
  configValues?: Record<string, string | boolean> | undefined
  /** Reviewers the loop may create; clamped to {@link REVIEW_MAX_ROUNDS}. */
  maxRounds: number
  whenClean: ShipRung
  /** With `pr`: open it as a draft. */
  draftPr: boolean
}

/** `ReviewLoopConfig.maxRounds`' bounds and default (§3). */
export const REVIEW_MAX_ROUNDS = { min: 1, max: 5, default: 2 } as const

/** A Review block's defaults when neither the anchor's `RepoConfig.review`
 *  nor the user says otherwise (§3); the reviewer agent has none — it is
 *  picked per draft. */
export const REVIEW_LOOP_DEFAULTS: Omit<ReviewLoopConfig, 'agent' | 'configValues'> = {
  maxRounds: REVIEW_MAX_ROUNDS.default,
  whenClean: 'notify',
  draftPr: true
}

/** What publishing a local repo asks for (docs/requirements-new-projects.md §6). */
export interface PublishSpec {
  /** A `git-token` credential for the forge — it creates the repo, pushes the
   *  history, and stays linked to the repo afterwards. */
  credentialId: string
  /** Repository name on the forge; defaults to the gurt repo's name. */
  remoteName?: string | undefined
  /** Organization to create it in; absent = the credential's own account. */
  owner?: string | undefined
  private: boolean
}

export interface PublishResult {
  url: string
  webUrl: string
}

/**
 * Environment definition: a named, workspace-level environment in gurt's own
 * format (docs/requirements-env-docker.md §2); gurt's copy here is the single
 * source of truth, the repo's own files are never read for it.
 * The name is the identity key and immutable (like `RepoConfig.name`).
 */
export interface EnvConfig {
  name: string
  /** Exactly one of `image` | `dockerfile`. */
  image?: string
  /** Dockerfile content. */
  dockerfile?: string
  /** Repo-relative path `dockerfile` was seeded from — provenance only. */
  dockerfilePath?: string
  /** Only with `dockerfile`. `context` is repo-root-relative (default "."),
   *  must stay inside the repo snapshot: no absolute path, no `..` escape. */
  build?: { context?: string; args?: Record<string, string>; target?: string }
  /** Container environment (`docker create --env`). */
  env?: Record<string, string>
  /** Shell script, run once when the container is created: as the container user, in the
   *  workdir, on the open network, before the network switch. */
  setup?: string
  /** Shell script, run on every container start (create and restart). */
  start?: string
  /** Default repo, seeds new sessions on this env; not a runtime binding. Read
   *  backwards too — `store.envsDefaultingToRepo` — to answer "which env does
   *  this repo run in?", the default `create_session` drafts against. */
  repo?: string
}

/**
 * Name of the one virtual env: the base image (`getBaseImage`). It is not in
 * any registry — it resolves to `{ image: <base image> }` — but it shares the
 * env name space, so the store validator reserves the name. A session on it
 * needs no repo, no setup and no Dockerfile.
 */
export const BASE_ENV_NAME = 'base'

/** Default of the app-level base image setting: the latest Node LTS on Debian
 *  13 (glibc — gurt's node runtime is a glibc build), pinned by digest.
 *  The full variant, not -slim: it sits on buildpack-deps, so it carries
 *  `ca-certificates` and git. codex's native binary verifies TLS against the
 *  system trust store only (slim has none: every request fails with
 *  "invalid peer certificate: UnknownIssuer"), and agents commit from inside
 *  the container. Bump deliberately with gurt releases
 *  (`docker manifest inspect node:26-trixie`). */
export const DEFAULT_BASE_IMAGE =
  'node:26-trixie@sha256:438603bbb5cda404b9416f0b5c8026f61501ab911760d861ec28c36b5d675725'

/** The env a new session of this workspace starts on: the workspace's
 *  `defaultEnv` when set, else the base image. */
export const defaultEnvName = (ws: Pick<WorkspaceFile, 'defaultEnv'>): string =>
  ws.defaultEnv ?? BASE_ENV_NAME

/** Env names that resolve to something other than a workspace entry. */
export const isBundledEnv = (name: string): boolean => name === BASE_ENV_NAME

/** <workspace>/workspace.json */
export interface WorkspaceFile {
  repos: RepoConfig[]
  envs: EnvConfig[]
  /** User-configured HTTP MCP servers, workspace-scoped like repos and envs
   *  (docs/requirements-mcp-proxy.md §3.1). Absent = none. */
  mcpServers?: McpRegistryEntry[]
  /** Agent-instance id (an `AgentsFile` key), used when a session in this
   *  workspace is created without an explicit `agent`. Absent = none — the
   *  spawner/caller's own choice (or none) stands. */
  defaultAgent?: string
  /** Agent-instance ids (`AgentsFile` keys) that may not be used by a session
   *  of this workspace. Keyed by instance, not by kind, so one configured
   *  instance of a kind can be allowed while another is denied. Absent/empty
   *  = every configured agent is allowed. */
  deniedAgents?: string[]
  /** Skill names (directories under `~/.gurt/<ws>/skills/`) switched on in
   *  every new draft of this workspace — the skills twin of `defaultAgent`.
   *  Seeded into the draft by the config tab, and the user's to change from
   *  there on (docs/requirements-skills.md §4.2). Absent/empty = none. The
   *  skills themselves live on disk, not here; a name that no longer resolves
   *  is the same "selected but unavailable" case a session's own selection
   *  already has to hold. */
  defaultSkills?: string[]
  /** Env definition name new sessions of this workspace default to; absent =
   *  the base image (`BASE_ENV_NAME`). Set from the env's row in Settings. */
  defaultEnv?: string
}

/**
 * stopped  — no container, or one that exists but is not up.
 * building — clone + image build, i.e. everything before the container exists.
 * post     — the container is up and its setup/start scripts are running; it
 *            is not usable yet.
 * running  — up and usable.
 *
 * `building`/`post` are runtime-only: a crash mid-provision restores as
 * `stopped` (see `readSessions`).
 */
export type ContainerStatus = 'stopped' | 'building' | 'post' | 'running' | 'error'

/**
 * The container a session owns — strictly 1:1. It is created at the session's
 * first start, stopped when the session goes idle, and destroyed with the
 * session; it is never shared with, nor inherited by, another session.
 *
 * Docker is the source of truth: every container carries the id-label
 * `gurt.session=<session id>`. This record is a cache of that, reconciled
 * against the daemon at boot (a daemon restart invalidates `status`).
 */
export interface SessionContainer {
  status: ContainerStatus
  /** Docker container id; absent until the container's `setup` has succeeded
   *  (a crash mid-setup can never leave a record naming a half-provisioned
   *  container). */
  id?: string
  /** Working directory inside the container — the agent's cwd. */
  remoteWorkspaceFolder?: string
  /** User every exec runs as: the image's `Config.User`, else root. */
  user?: string
  /** The PATH every exec carries — probed once per container id after setup. */
  path?: string
  /** Repos it was provisioned with (stamped at `up`), in the same order as
   *  `SessionInfo.repos`. The anchor drives the build + git identity; every
   *  repo is a sibling mount, read-only or not per its mode. */
  repos: string[]
  /** Last provisioning failure. Cleared by assignment on the next transition —
   *  every status change either sets it or resets it. */
  error?: string | undefined
}

/**
 * <workspace>/<task>/task.json — now only the marker that makes a directory a
 * task. Container state lives on the session that owns it ({@link SessionContainer});
 * the clones live on disk as `<task>/<repo>` and are discovered from there.
 */
export interface TaskFile {
  /** ISO timestamp the task was created. Absent on tasks made before this was
   *  recorded — `buildTree` stands in the marker file's own birth time there,
   *  so the tree always carries one. */
  createdAt?: string
  /** Legacy per-env container records, folded onto their owning session at read
   *  and dropped from disk. Never written by the current code. */
  envs?: LegacyEnvState[]
  /** Cap on sessions of this task the scheduler will run at once (see
   *  `SessionManager.scheduleSync`). Unset/0 = unlimited, today's behavior.
   *  Lets a user who expects to hit an external rate limit serialize a task's
   *  sessions instead of having most of them fail together. */
  maxConcurrentSessions?: number
  /** Present on the scope that *is* a proactive agent: it holds the agent's
   *  template draft and its run sessions, and is listed under
   *  `Tree.workspaces[].proactive` instead of among the scopes. */
  proactive?: ProactiveConfig
  /** Present on a scope a proactive agent raised — written in the same write
   *  that creates the scope, so its refs are bound exactly when it exists. */
  origin?: ProactiveOrigin
}

/** Pre-1:1 shape of a `task.json` env record — read once, migrated, discarded. */
export interface LegacyEnvState {
  env: string
  repo?: string
  session?: string
  containerId?: string
  remoteWorkspaceFolder?: string
  status: ContainerStatus
  error?: string
}

/**
 * draft   — has a start prompt, never runs until the user runs/enqueues it.
 * queued  — waiting in the global FIFO queue.
 * starting— being launched (runtime-only; a crash mid-start restores as draft).
 * started — a live chat session.
 */
export type SessionState = 'draft' | 'queued' | 'starting' | 'started'

/**
 * What a session is *for* — see docs/requirements-repo-mounts.md §4 (the table
 * this replaces lived in docs/requirements-session-roles.md §2). Chosen at
 * creation (changeable while it is still a draft, never after it has started).
 * A role decides what the agent delivers and which `gurt` tools it gets —
 * never how its repos are mounted or locked, and never how many it holds:
 * that is per-repo session configuration ({@link RepoMode}).
 *
 * executor   — makes changes; ends every turn with `complete`. Needs at least
 *              one repo mounted `write` to start.
 * researcher — answers in chat, no deliverable and no turn contract; fans work
 *              out by drafting executors and researchers.
 * inspector  — the read half of the operator: reads gurt's configuration and
 *              the sessions' diagnostics through the admin *read* tools, and
 *              drafts an operator when something has to change.
 * operator   — configures gurt itself through the admin read *and write*
 *              tools of its `gurt` MCP server.
 * proactive  — one run of a proactive agent (docs/design-proactive-agents.md):
 *              its repos are always read-only context. Does no work of its
 *              own — it turns what it finds into scopes with draft sessions
 *              through its `gurt` tools, and ends every turn with `finish_run`.
 *              Never picked for an ordinary session: it exists only as a
 *              proactive agent's template and the runs copied from it.
 *
 * reviewer   — one round's review in a review loop
 *              (docs/requirements-review-loop.md §4): reads the executor's
 *              change — every repo `read`, whatever the record says — and ends
 *              every turn with `submit_review`. Never picked, never drafted:
 *              only the loop creates one, with `SessionInfo.reviewOf`.
 *
 * The former user-picked `reviewer` is gone (repo-mounts §4): its records —
 * those without `reviewOf` — migrate to a researcher whose repos are mounted
 * `write`, exactly as they were.
 */
export type SessionRole = 'executor' | 'researcher' | 'inspector' | 'operator' | 'proactive' | 'reviewer'

export const SESSION_ROLES: readonly SessionRole[] = [
  'executor',
  'researcher',
  'inspector',
  'operator',
  'proactive',
  'reviewer'
]

/** Only the review loop creates a session of this role (§4 of
 *  docs/requirements-review-loop.md): no user picks it, no agent drafts it, no
 *  duplicate or recreate copies it. */
export const roleIsLoopOwned = (role: SessionRole): boolean => role === 'reviewer'

/** The roles a user picks for an ordinary session — every one but
 *  `proactive`, which only a proactive agent's template carries, and the
 *  loop's own {@link roleIsLoopOwned} reviewer. */
export const USER_SESSION_ROLES: readonly SessionRole[] = SESSION_ROLES.filter(
  (r) => r !== 'proactive' && !roleIsLoopOwned(r)
)

/** Guard for a role arriving from outside the kernel (the renderer over IPC).
 *  An unknown string must be rejected, not silently treated as some role. */
export const isSessionRole = (v: unknown): v is SessionRole =>
  typeof v === 'string' && (SESSION_ROLES as readonly string[]).includes(v)

/** The role of a session record. Absent only on pre-roles records: a discovery
 *  session (more than one repo) was a read-only researcher by convention, and
 *  anything else an executor — the same fold `readSessions` writes back to disk
 *  once. Everything role-dependent reads through this, never `info.role`. */
export const sessionRole = (s: Pick<SessionInfo, 'role' | 'repos'>): SessionRole =>
  s.role ?? (s.repos.length > 1 ? 'researcher' : 'executor')

/**
 * How one repo of a session is mounted (docs/requirements-repo-mounts.md §2):
 *
 * write       — read-write bind, **exclusive** claim on the clone: every other
 *               claim on it waits.
 * read-locked — read-only bind, **shared** claim: excludes writers only, so the
 *               tree does not move while the session is active.
 * read        — read-only bind, no claim: sees the live tree, blocks nobody.
 */
export type RepoMode = 'write' | 'read-locked' | 'read'

export const REPO_MODES: readonly RepoMode[] = ['write', 'read-locked', 'read']

export const isRepoMode = (v: unknown): v is RepoMode =>
  typeof v === 'string' && (REPO_MODES as readonly string[]).includes(v)

/** The mode of a newly picked repo, for every role: reading is the usual case
 *  and usually wants a stable tree; writing is always an explicit pick. */
export const DEFAULT_REPO_MODE: RepoMode = 'read-locked'

/** The mode a record older than per-repo modes had through its role — the
 *  fold `readSessions` writes back to disk once (docs/requirements-repo-mounts.md
 *  §5): an executor wrote its clone, every other role read. */
export const legacyRepoMode = (role: SessionRole): RepoMode => (role === 'executor' ? 'write' : 'read')

/** Every repo of this role is mounted `read`, whatever the record says: a
 *  proactive run's are read-only context; a reviewer's are a tool set's
 *  limit, not a mount pick — it claims no clone, so it never waits on the
 *  executor whose `write` claim the loop keeps (never `read-locked`: that would
 *  deadlock, docs/requirements-review-loop.md §4). */
export const roleForcesRead = (role: SessionRole): boolean => role === 'proactive' || role === 'reviewer'

/** How `repo` is mounted in this session. A proactive run's and a reviewer's
 *  repos are always `read` ({@link roleForcesRead}). A record with no mode
 *  map at all predates per-repo modes and reads through {@link legacyRepoMode},
 *  the way {@link sessionRole} folds a missing role; within a map, a repo
 *  without an entry takes the default. Everything mount-dependent reads through
 *  this, never `info.repoModes`. */
export const repoMode = (
  s: Pick<SessionInfo, 'role' | 'repos' | 'repoModes'>,
  repo: string
): RepoMode => {
  const role = sessionRole(s)
  if (roleForcesRead(role)) return 'read'
  if (!s.repoModes) return legacyRepoMode(role)
  return s.repoModes[repo] ?? DEFAULT_REPO_MODE
}

/** The bind is read-only. */
export const repoModeIsReadOnly = (mode: RepoMode): boolean => mode !== 'write'

/** The session's repos mounted `write`, in list order. */
export const writeRepos = (s: Pick<SessionInfo, 'role' | 'repos' | 'repoModes'>): string[] =>
  s.repos.filter((r) => repoMode(s, r) === 'write')

/** The repo that builds the image and names the git identity: the first
 *  `write` repo, else the first repo; absent with no repos at all
 *  (docs/requirements-repo-mounts.md §2.2). */
export const anchorRepo = (s: Pick<SessionInfo, 'role' | 'repos' | 'repoModes'>): string | undefined =>
  writeRepos(s)[0] ?? s.repos[0]

/** Exactly one mode per repo of `repos` — the picked one when there is a valid
 *  pick, else the default. Every entrance stores this shape, so a stale key for
 *  a removed repo never lingers and a new repo never goes without a mode. */
export function normalizeRepoModes(
  repos: readonly string[],
  modes: Partial<Record<string, unknown>> | undefined
): Record<string, RepoMode> {
  const out: Record<string, RepoMode> = {}
  for (const r of repos) {
    const m = modes?.[r]
    out[r] = isRepoMode(m) ? m : DEFAULT_REPO_MODE
  }
  return out
}

/** Needs at least one repository to start at all: a researcher reads one, a
 *  reviewer reviews one. An executor needs more — a `write` one (see
 *  {@link missingRepoReason}); every other role may start with none. */
export const roleNeedsRepo = (role: SessionRole): boolean =>
  role === 'executor' || role === 'researcher' || role === 'reviewer'

/** Why this session cannot start for lack of a repo, or undefined when it can.
 *  The one predicate behind every start gate and the container manager's anchor
 *  guard (docs/requirements-repo-mounts.md §4). */
export function missingRepoReason(s: Pick<SessionInfo, 'role' | 'repos' | 'repoModes'>): string | undefined {
  const role = sessionRole(s)
  if (role === 'executor' && !writeRepos(s).length)
    return s.repos.length
      ? 'an executor needs a repository mounted for write'
      : 'session has no repository'
  if (roleNeedsRepo(role) && !s.repos.length) return 'session has no repository'
  return undefined
}

/** Bound by a turn contract — offered a terminal tool and nudged when a turn
 *  ends without it: `complete` for an executor
 *  (docs/requirements-turn-contract.md), `finish_run` for a proactive run,
 *  `submit_review` for a reviewer (docs/requirements-review-loop.md §4). */
export const roleHasTurnContract = (role: SessionRole): boolean =>
  role === 'executor' || role === 'proactive' || role === 'reviewer'

/** Gets the admin surface's read tools: the inspector and the operator. */
export const roleReadsAdmin = (role: SessionRole): boolean => role === 'inspector' || role === 'operator'

/** Gets the admin surface's write tools too: the operator only. */
export const roleWritesAdmin = (role: SessionRole): boolean => role === 'operator'

/** Roles this one may draft through `create_session`: a researcher fans out to
 *  workers and further research, an inspector only to the operator that makes
 *  the change it diagnosed, everyone else to nothing (empty = the tool is not
 *  offered at all). */
export const spawnableRoles = (role: SessionRole): SessionRole[] =>
  role === 'researcher' ? ['executor', 'researcher'] : role === 'inspector' ? ['operator'] : []

/** May aim a draft at another task (`create_session`'s `task`). */
export const roleDraftsCrossTask = (role: SessionRole): boolean => role === 'researcher' || role === 'inspector'

/**
 * A draft one session's agent asked for via the `gurt` MCP server's
 * `create_session` tool. It lands in the spawner's own task and never runs by
 * itself: the user reviewing and launching it *is* the approval step (§3).
 * Anything omitted is inherited from the spawning session — `env` excepted, it
 * follows the *target repo* instead (see below).
 */
export interface AgentSessionRequest {
  role: SessionRole
  /** Repo names, any number; their order is the session's. */
  repos: string[]
  /** How each of `repos` is mounted — normalized like
   *  {@link SessionInfo.repoModes} (docs/requirements-repo-mounts.md §4). */
  repoModes?: Record<string, RepoMode>
  /** The drafted session's start prompt — its whole input. */
  prompt: string
  /** Task to draft into, created if missing; defaults to the spawner's own.
   *  Only for the roles {@link roleDraftsCrossTask} allows. */
  task?: string
  /** Display title; defaults to the usual `session N`. */
  title?: string
  /** Env definition name. Omitted, it resolves to the **target repo's own**
   *  default environment — the env whose `EnvConfig.repo` names the draft's
   *  {@link anchorRepo} (the workspace default when it has no repo) —
   *  not the spawner's. A session drafted for a repo belongs in that repo's
   *  container even when the spawner happens to run in an ad-hoc one, and
   *  inheriting the spawner's env was silent drift nobody could see. */
  env?: string
  /** Acknowledges that `env` names a container that is *not* the target repo's
   *  default. Required for such a request and rejected without it, so the wrong
   *  container can only ever be chosen on purpose, never drifted into. */
  confirmNonDefaultEnv?: boolean
  /** Agent-instance id; defaults to the spawner's. */
  agent?: string
  autoAllow?: boolean
  configValues?: Record<string, string | boolean>
  /** Skill names for the draft. Omitted, the spawner's own set is inherited —
   *  a drafted session runs with the procedures the drafting one was given
   *  unless the agent deliberately narrows them. `[]` is how it says "none"
   *  (docs/requirements-skills.md §6). */
  skills?: string[]
}

/**
 * A session's egress settings (docs/requirements-mcp-proxy.md §6.2), chosen at
 * creation and adjustable while it runs.
 *
 * The two modes differ in what they *are*. The default (`internal: false`) is a
 * normal bridge: the container has its own route out, `HTTP_PROXY` points at
 * the session proxy, and what that buys is **observability, not enforcement** —
 * a process that ignores the variables goes straight past it. `internal: true`
 * creates the session network `--internal`, so the daemon installs no route out
 * and the proxy is the only way to anything.
 *
 * `policy` is the session's allow list, evaluated by the proxy on the host (and
 * port) a request names — empty means "everything but this machine's own
 * networks", non-empty means "only these" (§6.3). It is what the open mode
 * *logs* and the internal mode *enforces*.
 */
export interface SessionNetwork {
  /** Absent reads as false; the UI nevertheless creates every new session with
   *  it *on* (App.tsx). Setup (image build, features, `postCreate`, the adapter
   *  install) always runs before this applies — see §7.3. */
  internal?: boolean
  policy?: DomainPolicy
}

/**
 * Network settings as they arrive from outside main — the renderer's form or an
 * agent's `create_session`. Undefined for anything that carries no choice, so a
 * caller that never set one leaves the session's own value alone rather than
 * overwriting it with a synthesised default.
 *
 * The internal flag is coerced, never guessed: only a literal `true` is
 * internal. A restriction has to be asked for.
 */
export function sanitizeSessionNetwork(raw: unknown): SessionNetwork | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { internal, policy } = raw as { internal?: unknown; policy?: unknown }
  const out: SessionNetwork = { internal: internal === true }
  if (policy !== undefined) out.policy = sanitizeDomainPolicy(policy)
  return out
}

/** Identity and location shown when offering to resume work after restart. */
export type InterruptedSession = Pick<SessionInfo, 'id' | 'title' | 'workspace' | 'task'>

/**
 * One session's record: persisted (minus the runtime overlays) and broadcast to
 * the renderer. A few members spell out `| undefined` — those are the ones the
 * session manager *clears* on a live record (`queuedAt` when the queue lets go,
 * the overlays when a turn ends). Everything else is absent-or-set.
 */
export interface SessionInfo {
  /** Runtime queue summary, including messages to an already started session. */
  pending?: PendingPromptInfo[] | undefined
  queueWaiting?: string | undefined
  /** Durable activity/read stamps used by the archive policy. */
  lastActivityAt?: string | undefined
  lastContentAt?: string | undefined
  archiveSeenAt?: string | undefined
  id: string
  /** The env this session runs on — an `EnvConfig.name`. */
  env: string
  /** What this session is for (see {@link SessionRole}). Absent on pre-roles
   *  records — read it through {@link sessionRole}, never directly. */
  role?: SessionRole
  /** The session's repos (first entry seeded from the env's default,
   *  changeable while a draft, fixed at start), any number of them, each
   *  mounted at `/workspaces/<name>`. The build anchor is {@link anchorRepo}. */
  repos: string[]
  /** How each of `repos` is mounted (docs/requirements-repo-mounts.md §2):
   *  exactly the keys of `repos`, kept so at every entrance. Absent only on
   *  records older than per-repo modes, which `readSessions` folds once — read
   *  it through {@link repoMode}, never directly. */
  repoModes?: Record<string, RepoMode>
  task: string
  workspace: string
  title: string
  agent?: string
  /** Auto-allow tool calls (map to a bypass/accept mode) vs. confirm each one.
   *  Chosen at session start; kept in sync when the mode is changed later. */
  autoAllow?: boolean
  /** The ACP mode the user last picked for this session (`SessionMode.id`).
   *  `autoAllow` says only auto-or-manual, and deriving a mode from that bool
   *  is guesswork over an agent-defined list — it cannot tell claude-code's
   *  "Accept edits" from its "Auto". So the pick itself is persisted and
   *  restored verbatim on every `session/new`/`session/load`; the derivation
   *  is only the fallback for a session that has never chosen one (or whose
   *  agent no longer offers it). Cleared when the draft's auto/manual chip is
   *  set again — that is the user re-choosing at the coarser level. */
  modeId?: string | undefined
  state: SessionState
  /** MCP servers to attach when this session starts (empty/undefined = none). */
  mcp?: McpSelection[]
  /** Skills mounted into the container when this session starts (empty/undefined
   *  = none). Chosen while the session is a draft and frozen at start: the files
   *  are bind-mounted, so there is nothing to change on a live session
   *  (docs/requirements-skills.md §2). Absent means "never chosen" — which is
   *  what the draft's `defaultSkills` seeding keys on — while `[]` means the
   *  user chose none and is not re-seeded. */
  skills?: SkillSelection[]
  /** Egress settings for this session's network (absent = the defaults:
   *  a normal bridge, everything allowed and logged). */
  network?: SessionNetwork
  /** First prompt, sent automatically when the session starts. */
  startPrompt: string
  /**
   * Config-option values (model, effort, fast mode, …) chosen for this session,
   * keyed by `SessionConfigOption.id`. Applied at start: what the adapter reads
   * from `_meta` rides that on `session/new` (the kind's plugin says what:
   * `sessionMeta` — claude-code's model/effort), the rest are reconciled via
   * `session/set_config_option` before the first prompt. Picked from the agent's
   * cached option set (see {@link AgentConfig}); an empty/absent map means "let
   * the agent choose its defaults". Cleared by assignment when an edit empties
   * the map.
   */
  configValues?: Record<string, string | boolean> | undefined
  /** The container this session owns, 1:1. Absent until its first start. */
  container?: SessionContainer
  /** ISO timestamp, present while queued — defines global FIFO order. */
  queuedAt?: string | undefined
  /** ISO instant a provider limit that cut this session's last turn off is
   *  expected to lift. Present while the session waits to send "continue" on
   *  its own; persisted, so a restart keeps waiting rather than resending. */
  limitedUntil?: string | undefined
  /** Runtime overlay (never persisted): the agent is processing a prompt right now. */
  busy?: boolean | undefined
  /** Runtime overlay (never persisted): a permission request awaits the user's decision. */
  awaitingInput?: boolean | undefined
  /** Runtime overlay (never persisted): the turn ended without a `complete` call and the
   *  automatic nudge did not heal it — a protocol violation surfaced in the snapshot. */
  incomplete?: boolean | undefined
  /** Runtime overlay (never persisted): the user has looked at this session since its
   *  last turn ended, which splits `idle` into `idle-read`. */
  seen?: boolean | undefined
  /** A proactive agent's template (docs/design-proactive-agents.md §2): a draft
   *  that never runs itself — each run starts a copy of it. Not carried by
   *  copies. */
  template?: boolean
  /** An executor's Review block (docs/requirements-review-loop.md §3): present
   *  = the session runs in a review loop. Frozen at start; the user's standing
   *  approval for the reviewers and the delivery it runs. */
  review?: ReviewLoopConfig | undefined
  /** An executor draft whose Review block the user switched off on purpose:
   *  the anchor repo's `review.enabled` default does not switch it back on
   *  (the `skills: []` precedent, docs/requirements-skills.md §4.2). Cleared
   *  when a block is set. Carried by copies with `review`. */
  reviewOff?: true | undefined
  /** Present only on a loop's reviewer (§4), which only the loop creates: the
   *  executor it reviews, the round it is (1-based) and the loop intent that
   *  created it — how a restart adopts it instead of creating another (§8). */
  reviewOf?: { executor: string; round: number; intent: string } | undefined
}

/**
 * The live overlay the renderer keeps per session id, outside the tree snapshot:
 * `busy`/`awaitingInput` carry `| undefined` because they are read off a
 * {@link SessionSnapshot}, which reports "not busy" as an unset field, while
 * `seen` is the window's own read-state bookkeeping.
 */
export interface SessionActivity {
  busy?: boolean | undefined
  awaitingInput?: boolean | undefined
  seen?: boolean | undefined
}

/**
 * Fine-grained status shown in the session tree — the persisted {@link SessionState}
 * split by the live runtime overlay so a `started` session reads as one of:
 *   running — the agent is working, waiting — it needs the user, idle — turn done
 *   and still unseen, idle-read — turn done and the user has looked at it.
 */
export type SessionStatus =
  | 'draft'
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'idle'
  | 'idle-read'

/** Collapse (persisted state + runtime overlay) into the status the tree renders. */
export function sessionStatus(s: SessionInfo): SessionStatus {
  if (s.state !== 'started') return s.state // draft | queued | starting
  if (s.awaitingInput) return 'waiting'
  if (s.busy) return 'running'
  return s.seen ? 'idle-read' : 'idle'
}

/** Full tree snapshot pushed to the renderer. */
export interface Tree {
  workspaces: {
    name: string
    repos: RepoConfig[]
    /** Environment definitions (listed in Settings and the New Session modal). */
    envs: EnvConfig[]
    /** Agent instance id used when a session here is created without an
     *  explicit `agent` — see `WorkspaceFile.defaultAgent`. */
    defaultAgent?: string
    /** Agent instance ids not allowed in this workspace — see
     *  `WorkspaceFile.deniedAgents`. */
    deniedAgents?: string[]
    /** Skill names switched on in every new draft here — see
     *  `WorkspaceFile.defaultSkills`. */
    defaultSkills?: string[]
    /** Env new sessions default to — see `WorkspaceFile.defaultEnv`. */
    defaultEnv?: string
    tasks: {
      name: string
      /** ISO timestamp the task was created — see {@link TaskFile.createdAt}.
       *  Always present here (backfilled from the filesystem when the file has
       *  none); the sidebar orders by it. */
      createdAt: string
      /** Repos with a clone in this task (discovered on disk). A clone outlives
       *  the sessions that used it — it holds their uncommitted work. */
      repos: string[]
      /** Sessions of this task, primary tree nodes. Each carries its own
       *  container, so the task has no infrastructure of its own. */
      sessions: SessionInfo[]
      /** Cap on concurrently running sessions of this task (see {@link TaskFile}).
       *  Absent = unlimited. */
      maxConcurrentSessions?: number
      /** The proactive agent that raised this scope (see {@link TaskFile}). */
      origin?: ProactiveOrigin
    }[]
    /** Proactive agents of this workspace. Their scopes (template + runs) are
     *  not among `tasks`. */
    proactive: ProactiveAgentView[]
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
  /** Set when gurt itself ran this, not the model — the review loop's
   *  automatic check and its reviewer launch. The value says which ("auto-check
   *  · api"). The chat draws it as its own block, never in the model's tool strip. */
  host?: string
}

/** What the review loop reports into the executor's chat besides a tool block:
 *  a verdict, a hand-over to the user, a delivery step. */
export interface LoopNote {
  tone: 'info' | 'ok' | 'warn' | 'error'
  /** The verdict's findings, when the note is one. */
  findings?: { ref: string; severity: ReviewFinding['severity']; file: string; line?: number; claim: string }[]
}

export interface ChatSystem {
  kind: 'system'
  text: string
  /** The review loop's intent id when this is a host message it queued
   *  (`SessionManager.hostPrompt`, docs/requirements-review-loop.md §5.5, §8)
   *  — how a restart finds a message it already delivered. */
  loop?: string
  /** Set on the review loop's own notes (docs/requirements-review-loop.md §5):
   *  the chat draws these as gurt's, apart from the model's words. */
  note?: LoopNote
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
  /** What exactly is being confirmed, rendered by the host — set on gurt's own
   *  confirmations (an operator's `apply_held`, docs/requirements-session-
   *  operator.md §4.3), never on an agent's ACP permission request. */
  detail?: string
}

export type ChatEntryBase = (ChatText | ChatToolCall | ChatSystem | ChatPermission) & {
  /** When the entry was created (epoch ms). Absent on logs from before it existed. */
  at?: number
  /** When it finished: the last streamed chunk of a text/thought, the terminal
   *  status of a tool call. Absent while still going. */
  endAt?: number
}
export type ChatEntry = ChatEntryBase & { id: number }

// Append-only session log. The chat timeline is a fold over these records;
// the same fold runs in main (derive state) and in the renderer (apply deltas).

export type SessionLogRecord =
  /** New timeline entry; `entry.id` is unique and ascending per session. */
  | { seq: number; type: 'entry'; entry: ChatEntry }
  /** Streaming text delta appended to a ChatText entry. */
  | { seq: number; type: 'append'; id: number; text: string; at?: number }
  /** In-place update of a tool call / permission entry. */
  | {
      seq: number
      type: 'patch'
      id: number
      patch: { status?: string; title?: string; detail?: string; chosen?: string; endAt?: number }
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
      if (e && 'text' in e)
        out[i] = { ...e, text: e.text + r.text, ...(r.at != null ? { endAt: r.at } : {}) }
    } else if (r.type === 'patch') {
      const i = index.get(r.id)
      const target = i == null ? undefined : out[i]
      if (i == null || !target) continue
      const defined = Object.fromEntries(
        Object.entries(r.patch).filter(([, v]) => v !== undefined)
      )
      out[i] = { ...target, ...defined }
    }
    // other record types: ignored
  }
  return out
}

export interface SessionMode {
  id: string
  name: string
  /** `_meta.kind` as the agent reports it, lifted out of the envelope by the
   *  session manager's mode normalizer. Ids and names are agent-defined and
   *  overlap badly ("Accept edits" vs. "Auto"), but the kind is the one thing
   *  that carries intent across adapters — an auto-review mode reports the
   *  same kind whatever it is called (the agent plugin's
   *  `modes.autoReviewKinds`) — so mode matching keys on it first. */
  kind?: string
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
  image?: boolean | undefined
  audio?: boolean | undefined
  embeddedContext?: boolean | undefined
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
  /** What prompts the agent accepts (images, …) — kept so a draft or stopped
   *  session still knows without a live connection. */
  promptCapabilities?: PromptCapabilities
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

/**
 * A prompt the user has sent that the session could not take yet, as the UI
 * sees it (`SessionSnapshot.pending`).
 *
 * Two things put a prompt here: a turn already running, and a session whose
 * clone another session is sitting on (the queue handoff stops an idle
 * container out from under it — see `holdersBlockingQueue`). Both are waits,
 * not errors, so the composer accepts the message and this is where it stands
 * until the session is free.
 *
 * Persisted on main. Only an interrupted turn requires confirmation after restart; queued work keeps its place.
 */
export interface PendingPromptInfo {
  queuedAt?: string | undefined
  id: string
  text: string
  /** Context chips attached to it — carried so taking the prompt back out of
   *  the queue can put them back in the composer with the text. */
  context?: PromptContext[]
  /** How many images ride with it. The images themselves stay on main: they
   *  are base64, and this rides every `session-changed` broadcast. Taking the
   *  prompt back out of the queue therefore drops them — the row says so. */
  images?: number
  /** Queued by the app, not typed: the "continue" a session cut off by a
   *  limit sends once the limit resets. Cancelling it cancels the resume. */
  auto?: true
  /** The review loop's intent id when the app queued it for the loop
   *  (`SessionManager.hostPrompt`, docs/requirements-review-loop.md §5.5);
   *  always with `auto`. */
  loop?: string
}

/** Context-window usage, from ACP's `usage_update` session/update variant.
 *  Not every adapter sends it (e.g. codex-acp doesn't yet). */
export interface SessionUsage {
  /** Tokens currently occupying the context window. */
  used: number
  /** Context window size, in tokens. */
  size: number
  cost?: { amount: number; currency: string }
}

/**
 * A session projected for the renderer. Transport only: built in one place from
 * the live record and sent over IPC, never persisted. Its optional members
 * spell out `| undefined` because that is how they are produced — an unset
 * field is "known to be nothing" here, not "missing" — and because
 * `session-changed` deliberately clears `entries` by assigning undefined.
 */
export interface SessionSnapshot {
  info: SessionInfo
  /** Full folded timeline — present from `session:snapshot` only; the per-change
   *  `session-changed` broadcast omits it (deltas ride the `session-log` event). */
  entries?: ChatEntry[] | undefined
  /** Agent is processing a prompt right now. */
  busy: boolean
  /** `session/load` in flight — the UI shows a live "resuming" indicator. */
  resuming?: boolean | undefined
  modes?: SessionModes | undefined
  plan?: PlanEntry[] | undefined
  commands?: CommandInfo[] | undefined
  /** Live agent-reported config selectors (model, effort, …). */
  configOptions?: SessionConfigOption[] | undefined
  /** What content the agent accepts in prompts, for gating composer affordances. */
  promptCapabilities?: PromptCapabilities | undefined
  /** Last failure that put the session back to draft. */
  startError?: string | undefined
  /** 1-based position in the global queue, present while queued. */
  queuePosition?: number | undefined
  /** What a queued session is waiting for, when it is more than its turn or
   *  its clone — its account is at its plan limit. */
  waiting?: string | undefined
  /** Prompts accepted but not yet run, oldest first — see {@link PendingPromptInfo}. */
  pending?: PendingPromptInfo[] | undefined
  /** Why the queue is not moving although no turn is running: the session's
   *  clone is somebody else's right now, or its account is at its limit. Absent while a turn is in flight —
   *  then the reason is simply `busy`. */
  pendingBlocked?: string | undefined
  /** Latest change proposal from a `complete` call (outcome=changes), if any. */
  proposal?: StoredProposal | undefined
  /** Latest context-window usage reported by the agent, if the adapter sends it. */
  usage?: SessionUsage | undefined
}

/**
 * One record in <workspace>/<task>/sessions.json. `acpSessionId` is present only
 * once the session has started; `starting` is never persisted (restores as draft).
 * The timeline lives in the per-session JSONL log, not here.
 */
export interface PersistedPrompt {
  queuedAt?: string | undefined
  id: string
  text: string
  context?: PromptContext[] | undefined
  images?: PromptImage[] | undefined
  auto?: boolean | undefined
  /** Who queued an `auto` prompt, when it was not gurt's own "continue": the
   *  review loop, by the id of the intent that decided it
   *  (docs/requirements-review-loop.md §5.5, §8). */
  origin?: { loop: string } | undefined
}

export interface PersistedSession {
  interrupted?: boolean | undefined
  pending?: PersistedPrompt[] | undefined
  info: SessionInfo
  acpSessionId?: string | undefined
  /** Latest change proposal (outcome=changes) submitted via `complete`; last one wins. */
  proposal?: StoredProposal | undefined
  /** The last logical turn gurt finished classifying
   *  (docs/requirements-review-loop.md §5.1, §8) — written before
   *  `session.settled` is emitted, so a loop that missed the event (the app
   *  went down between the two) can replay it at boot. */
  lastSettled?: SettledTurn | undefined
  /** The review-loop intent whose host message was last taken off the queue
   *  (docs/requirements-review-loop.md §8): the in-flight marker. */
  loopRan?: string | undefined
  /** Legacy pre-log format; migrated to the JSONL log on restore. */
  entries?: ChatEntry[] | undefined
}

/**
 * Where a session sits: its task, plus the env *definition* it runs. Since a
 * container belongs to one session, this addresses no infrastructure of its own
 * — several sessions of a task may share one `EnvRef` and still own separate
 * containers. Host resources are keyed by session id, never by this.
 */
export interface EnvRef {
  workspace: string
  task: string
  /** The env definition this session runs — an `EnvConfig.name`. */
  env: string
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
  /** Reachable from `origin/<task>`. */
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
  /** The repo is local to gurt (`RepoConfig.local`): no forge, so the thread
   *  is delivered by merging into the default branch, not by a pull request. */
  local?: true
  /** Commits on `<default>` not yet in this branch — the "update from main" signal. */
  behind: number
  /** A prior update-from-main merge left conflicts unresolved (`MERGE_HEAD` present). */
  conflicted: boolean
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

/**
 * What a diff view reads. `uncommitted` is the working tree against HEAD (the
 * Changes panel's Uncommitted block); `commit` is one thread commit against its
 * parent. Nothing else is diffable — these are exactly the two things the
 * panel already renders.
 */
export type DiffTarget = { kind: 'uncommitted' } | { kind: 'commit'; sha: string }

/** A target as one string, for keying per-diff state (the working tree vs. one commit). */
export const targetKey = (t: DiffTarget): string =>
  t.kind === 'commit' ? `commit:${t.sha}` : 'uncommitted'

/**
 * The two sides of one file, as whole content. Line alignment, folding and
 * intraline highlighting are computed in the renderer — the host stays out of
 * the diff business and returns what git has. An added file's `before` (and a
 * deleted file's `after`) is '', not a missing key: the split view renders it
 * as an empty pane rather than a special case.
 */
export type DiffPair =
  | { binary: false; before: string; after: string }
  | { binary: true }
