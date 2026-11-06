# Gurt architecture

How Gurt is put together: the domain model, how a session starts, and what each
subsystem (MCP, skills, network, git credentials, masking) actually does. For
running, testing and packaging Gurt, see [development.md](development.md). For
what Gurt is, see the [README](../README.md).

**Task and scope are the same thing.** The UI calls the unit of work a
*scope*; the code, the IPC API, the on-disk layout (`~/.gurt/<ws>/<task>/`) and
the older documents in this folder call it a *task*. This page keeps the code's
word where it names a path or a field.

## Project layout

Where to look in the code (the domain model itself is described below):

- `src/main/` — the Electron main process, the app's core (Node side):
  provisioning, ACP, git credentials, the MCP servers, persistence.
- `src/preload/` — the preload bridge: derives `window.gurt` from the shared
  API definition and exposes it to the renderer.
- `src/renderer/` — the React UI (renderer process).
- `src/shared/` — types shared by main and renderer, including the IPC
  contract.
- `src/plugins/agents/` — the agent plugins: everything specific to one coding
  agent (see [Agents](#agents) below). The rest of `src/` is the *core* and
  names no agent.
- `resources/proxy/gurt-proxy.mjs` — the per-session egress/MCP proxy. Plain
  dependency-free Node, bind-mounted into a stock, digest-pinned `node:22-alpine`
  container and run as-is, so it is not built with the app; its contract (the
  config file it reads) is `src/shared/proxy.ts`, written by
  `src/main/proxy/config.ts`.

```
renderer (React)  ⇄  preload (window.gurt)  ⇄  main (kernel)
        src/renderer/       src/preload/         src/main/
                    └── src/shared/api.ts ──┘
```

Entry point and main flow: `package.json` `"main": "out/main/index.js"` is the
build of `src/main/index.ts`, which calls `registerIpc()` (`src/main/ipc.ts`);
that in turn builds the app core via `createKernel()` (`src/main/kernel.ts`).
`src/shared/api.ts` is the single source of truth for IPC — adding a method
there, plus its implementation in `ipc.ts` and its operator-exposure annotation
in `METHODS` (a compile error until it has one), is the whole wiring; preload
derives from it.
`src/main/sessions.ts` is the heart of the session lifecycle
(start/stop/queue/persistence).

Historical specs and design notes live in this folder — see its [index](README.md).

### Agents

Each coding agent gurt can run — a *kind*: `claude-code`, `codex`, `gemini`,
`opencode`, `pi` — is one folder under `src/plugins/agents/<id>/`
([requirements-agent-plugins.md](requirements-agent-plugins.md)):

- `manifest.ts` — pure, JSON-compatible data: label, vendor, icon, the pinned
  adapter packages and launch command, the secret env var, which sign-in it
  uses, its skills and history directories, its native config file, seed
  config, and the vocabulary its adapter speaks (MCP tool titles, mode words,
  limit wording, plan windows). The provenance notes for each value sit next
  to it.
- `shared.ts` (optional) — pure code main and the renderer both run (how its
  config options are presented).
- `main.ts` (optional) — main-process hooks: launch env, the OAuth client it
  borrows and its native auth file, the token probe, the ACP `_meta` it reads
  and writes, plan-usage polling.

The core reaches a plugin only through the two list files beside the folders —
`src/plugins/agents/index.ts` (manifests and shared hooks; main and renderer,
read through `src/shared/agents.ts`) and `src/plugins/agents/main.ts`
(main-only hooks, read through `src/main/agentPlugins.ts`) — against the
contract in `src/shared/agentPlugin.ts`. The engines stay in the core and run
on what the plugins declare: provisioning, the OAuth flow and refresh, the
token probe's verdicts, plan-usage polling and holds, the mode picker, the
limit detector, the tool-title reader. A missing field or hook means the kind
does not have that feature, and the core behaves exactly as for a kind it knows
nothing about. Three gates keep it that way: an ESLint rule on resolved
import paths (`scripts/lib/agent-plugin-boundaries.mjs`: a plugin imports only
the contract, its own folder and npm packages, and nothing but the main list
imports a plugin's `main.ts`; the core imports only the list files; the
renderer never the main list); `scripts/agent-plugin-boundaries.test.mjs`,
which walks the import graph from the renderer and `src/shared` and fails if it
reaches a main half or `src/main`; and `scripts/agent-agnostic-core.test.mjs`,
which fails on any agent name in a core literal, identifier or regex. The
registry refuses at load a list it cannot read unambiguously (a kind or
sign-in declared twice, a main half without a manifest).

**Adding an agent** is one folder plus its entry in the list files: write
`src/plugins/agents/<id>/manifest.ts` (an `AgentManifest`; the id is persisted
— never rename one), add `shared.ts`/`main.ts` only for what data cannot say,
then import and list it in `src/plugins/agents/index.ts` — and, with a
`main.ts`, in `src/plugins/agents/main.ts`. List order is picker order; the
first entry is the default kind. `scripts/agent-fixture.test.mjs` runs a
data-only sixth agent through the real core paths;
`scripts/agent-plugins.test.mjs` pins the registry's ids and data.

## Model

All Gurt metadata lives outside the repositories, under `~/.gurt/` — a working
tree is never polluted with Gurt files.

- **workspace** — top-level divider, a directory in `~/.gurt/<ws>/`
- **repo** — registered per workspace: git URL + optional credential link;
  add/edit/delete via Settings → Repos. A **local** repo is one Gurt created
  itself — a bare repo under `~/.gurt/<ws>/repos/`, made from the draft's repo
  picker ("new local repository…") or Settings — for a project with no forge
  yet: tasks deliver into it with **Merge into main**, and **Publish to
  GitHub…** later moves it to a forge.
  See [requirements-new-projects.md](requirements-new-projects.md)
- **agent** — an instance of a built-in kind (claude code / codex / gemini /
  opencode / pi).
  The registry starts empty and is global (Settings → Clients; Settings →
  Agent access picks which a workspace may use and its default); add instances
  as needed — several of one kind are allowed. Each
  maps to its secret by linking an `agent-token` or `oauth` credential (never storing it
  inline, like a repo's credential link); env var name + extra env are per-agent
- **task** — unit of work, `~/.gurt/<ws>/<task>/`, holds repo clones; deletable.
  The UI calls it a **scope**
- **env** — a workspace entity and purely a *definition*, in Gurt's own format
  ([requirements-env-docker.md](requirements-env-docker.md)): an `image` or a
  `dockerfile` (+ build context/args/target), container `env`, and a `setup` and
  a `start` script. It is stored entirely in Gurt and written in Gurt (the
  editor can load a root Dockerfile of the repo into its field); Gurt reads no
  devcontainer.json, and the repo is never the source of truth at runtime. It is a template, not an
  instance: any number of sessions may run the same env at once.
  One env is virtual rather than defined: `base`, the app-level base image
  (`~/.gurt/images.json`, default `node:<LTS>-trixie` pinned by digest — not
  -slim, which lacks `ca-certificates` and git). It is the default of every
  new session, offered to every role, and runs any repo.
  A workspace can make one of its own envs the default instead (`defaultEnv`).
- **container** — owned by exactly one session, 1:1. Created at that session's
  first start, stopped when it goes idle, destroyed with it; never shared with
  or inherited by another session. Docker is the registry (every container
  carries the id-label `gurt.session=<id>`), and the record on the session is a
  cache reconciled against the daemon at boot. Managed from the task pane
  (stop / delete).
- **clone** — `~/.gurt/<ws>/<task>/<repo>/` on a branch named after the task
  (`<task>`), shared by
  every session of the task that picked that repo, and outliving all of them
  (it holds their uncommitted work). Because it is one working tree, a repo is
  **exclusive**: only one session of the task may hold it at a time — where
  "hold" means mid-start or owning a live container, and only for the roles
  that take the lock (an executor and a reviewer; a researcher mounts the repo
  read-only and holds nothing). An idle session whose
  container has stopped releases it for the next one — and while something is
  queued for that repo, the stop happens the moment the holder's turn ends
  instead of after the idle grace period.
- **session** — the primary entity: (workspace, task, env, role, repo, agent,
  startPrompt, state) + its container + chat history + optional ACP session id.
  States: `draft → queued → starting → started`.
- **role** — what a session is *for*, chosen at creation (editable while it is
  still a draft) and driving its mounts, its clone lock and its tool set
  instead of being inferred from repo count. See
  [requirements-session-roles.md](requirements-session-roles.md):
  - **executor** — today's worker: one repo, read-write, holds the clone
    exclusively, ends every turn with `complete` (the turn contract below).
  - **researcher** — read-only, locks nothing (so it never blocks and is never
    blocked), no deliverable and no turn contract; the only role that may hold
    several repos at once. Answers in chat.
  - **reviewer** — judges one clone's *uncommitted* changes, holding the
    clone lock so nothing can move under it. Its verdict is plain chat text and
    gates nothing. Its clone is currently mounted **writable** — a stopgap so
    it can install dependencies and run tests against the diff (see the comment
    at the `readonly` flag in `src/main/containers.ts`); it is still offered no
    `complete`.
  - **operator** — configures Gurt itself: holds no repository, mounts
    nothing, locks nothing, and reads and edits the workspace configuration through
    admin tools on its `gurt` MCP server (`src/main/adminSurface.ts`,
    `src/main/adminWrites.ts`): every write carries the entity's revision,
    credential re-links are refused, and fields that would run code on the host
    are held until the user confirms. It runs in the workspace's default env
    (by default the base image); the first-run screen starts one. See
    [requirements-session-operator.md](requirements-session-operator.md).
  - **proactive** — one run of a proactive agent: zero or more repos,
    read-only, locks nothing. It does no work itself; its `gurt` tools raise
    scopes with draft sessions, and it ends every turn with `finish_run`. Never
    picked for an ordinary session (see Proactive agents below).

  Read-only means Docker `readonly` bind mounts, not a convention — and today
  only the researcher gets them. A researcher
  and a reviewer are also offered `create_session` instead of `complete`: it
  **drafts** another session in the same task (a fixer executor, a reviewer),
  fully configured. A draft never runs by itself — the user reviewing and
  launching it is the approval step — and nothing flows back to the spawner.

Sidebar: task → session, for the workspace chosen in the title-bar switcher. A
task click opens the **task pane** (its git changes, the containers of its
sessions, and its queue with the max-concurrent cap). A session click opens its
pane, with Chat / Config / Logs tabs; role, env, repos, MCP, skills and network
are fixed once a session leaves draft.

### Scope terminals

The narrow right activity bar is available in Scope and Git modes (the
activity bar's **Agents** and **Diff** views). Its terminal
button (default **⌘/Ctrl+4**, configurable in Settings → Hotkeys) toggles a
resizable terminal panel. Opening it creates the first shell for the selected
scope if needed; **+** adds another terminal and each tab's **×** closes it.
Tabs sit in the panel header, start as **Terminal 1**, **Terminal 2**, and can be
renamed with a double-click or **F2**. **Enter** saves and **Escape** cancels.
Shells start on the host in `~/.gurt/<workspace>/<scope>/`.

Switching scopes, workspaces, agent environments or views, and hiding the panel,
keeps each shell running with its screen, scrollback and unfinished input intact.
Terminals live only for the current application run: quitting closes them, and
no terminal session or screen is restored at startup. Deleting a scope or
workspace closes its terminals and discards their in-memory state. This uses
xterm.js in the renderer and node-pty in the main process; terminal input and
output are excluded from application logs and from the agent tool surface.

Both sidebars toggle on a repeated activity-bar click or shortcut. **⌘/Ctrl+2**
and **⌘/Ctrl+3** show/hide the left Scope and Git sidebar respectively; selecting
a different mode opens its sidebar. The central view stays open when its sidebar
is hidden.

### Duplicate / delete

A session set up wrong is usually noticed once it is already running, so both
ways out are offered in every state — from the sidebar row's right-click menu, from the
draft/queued/starting pane, and from the ⋯ menu in the pane header (the only one
a chat has):

- **recreate as draft…** discards a launched session's run and makes a fresh
  draft with the same title in the same tree slot.
- **duplicate** copies the session into a new **draft** of the same task, named
  `<title> (copy)`: role, env, repos, agent, MCP/skills/network/auto-allow,
  config picks and the first prompt all come along, nothing runtime-derived does. Fix the
  setting that was wrong, then run it.
- **delete** removes the session in any state — running or mid-start included —
  and everything it owns: its container, adapter, host servers, chat log, mount
  scratch (`.multirepo/<id>/`, incl. agent history) and PII table. The clone and its uncommitted work stay, since a clone outlives every
  session of its task.

### Sessions, queue, serialization

Concurrent access to one working tree is serialized through a **global FIFO
queue** (no git worktrees). A new session is a draft from the start, configured
on its Config tab (edits save by themselves); its pane offers a single **Run**,
enabled once a prompt, env, repo (not for an operator) and agent are set. Run
always goes through the queue: it starts at once when nothing is in the way, and
otherwise waits instead of failing:

- **draft** never runs until you run/enqueue it. A session that was `starting`
  when the app died restores as a draft.
- **queued** waits in the queue; the scheduler starts an item when its target
  (task, repo) is free — i.e. no session is starting or holding a live container
  on that clone. A repo frees when its holder's container comes down, and with
  something queued behind it that is immediate: the holder's turn ends, its
  container is stopped (`reason: queue`), and the next item starts. Two queued
  sessions for one repo therefore run strictly one after another, back to back.
  A holder that is mid-turn or mid-start is never cut off — the queue waits for
  it — and with an empty queue containers stay up for the usual idle grace
  period (10 minutes), ready for a follow-up prompt. Researchers and operators
  claim no clone and start as soon as the queue reaches them.
- **`run()` on main** (no longer behind a button; tests and internal callers)
  starts immediately only if the clone is free. If another session holds it,
  the start is refused ("queue this one instead"); if the task is at its
  `maxConcurrentSessions` cap, or its account is at its plan limit, the session
  is queued instead.
- **plan limits** — an account (credential) with a plan window at the usage
  threshold (Settings → Clients) gets no new work. Its queued drafts and the
  queued messages of its started sessions wait for the reset, or for a fresh
  read, extra usage or credits. A session a limit cut off sends "continue" on
  its own afterwards. See requirements-plan-limits.md.
- **per-task cap** (`maxConcurrentSessions` in `task.json`, the "max
  concurrent" field on the queue; unset = unlimited) holds queued items until a
  slot frees, and the handoff stops idle containers of a capped task.
- **follow-up prompts** to a `started` session wait in a per-session pending
  queue while another session holds the clone, and drive the same handoff.

The queue survives restart (derived from `state: "queued"` + `queuedAt`); the
scheduler runs once after sessions are restored. A failed start drops the
session back to draft with the error shown, and does not block the queue.

### Proactive agents

A proactive agent ([design-proactive-agents.md](design-proactive-agents.md))
is a scope of its own, listed in the **Proactive agents** mode instead of
among the scopes: its `task.json` holds the schedule and limits, its template
draft (role `proactive`) holds everything else, and every run is a copy of
the template that enqueues itself. A run reads its sources through its MCP
servers and calls `propose_scope` / `attach`; the scopes it raises carry
`origin.refs` in their `task.json`, and while a scope exists each of its refs
is bound to it alone in the workspace (deleting the scope frees them). What a
run raises is always a draft, and one limit — scopes waiting for the user —
caps it: at the limit a due run is skipped and `propose_scope` refuses. Runs
happen only while Gurt is open, never overlap, and are cancelled past their
timeout.

## How a session starts

Provisioning drives the docker CLI directly; there is no wrapper in between.
The Docker labels are the source of truth (hence the reconcile at boot), and
every container step addresses the **container id** in the session record —
never a lookup by label. A container left by an unfinished start, or one made
by an older build, is removed before a new one is created.

1. clone repo into `~/.gurt/<ws>/<task>/<repo>/` (if missing), branch `<task>`
   (an existing `origin/<task>` is continued rather than forked again)
2. the image. An `image` env is pulled when it is not in the local store (the
   output streams to the provisioning log). A `dockerfile` env is built first:
   a temporary snapshot of the clone at HEAD (`git archive` — the working clone
   is never touched) is the build context (`build.context`, repo-root-relative
   and confined to the snapshot); the Dockerfile itself is written to a scratch
   dir outside it and passed with `-f`; `docker build` runs with the env's
   args/target. Images are tagged by content (repo url + commit + Dockerfile +
   build config), so an unchanged env is reused, including one pre-built from
   Settings → Environments (the `build` button there, with an exists/missing
   badge per env) — a pre-build uses the default repo's remote HEAD, so it is
   reused only while the clone's HEAD is that commit. Superseded env images are
   removed after each build (`gurt.kind=env-image` labels).
3. gurt's **Node runtime**: adapters are npm packages and need Node whatever
   the image carries, so a pinned `node:<LTS>-bookworm-slim` image is copied
   once into a docker volume (`gurt-node-<digest>-<arch>`, labelled
   `gurt.kind=node-runtime`; refilled if its `.gurt-ready` marker is missing)
   and mounted read-only at `/opt/gurt/node` in every container. It is a glibc
   build: musl/Alpine env images are unsupported.
4. `docker create` + `start` on Docker's default bridge: labels
   `gurt.session=<id>`, `gurt.managed=1`, `gurt.runtime=docker`; `--init` and a
   keep-alive entrypoint (the image's own ENTRYPOINT/CMD does not run); the env's
   `env`; the mounts — every repo, one or several, read-write or read-only by role,
   at `/workspaces/<name>` (so file paths do not depend on the repo count), plus
   skills `/gurt/skills` (read-only), history `/gurt/history`, the node volume.
   The container belongs to the starting session; its own stopped container is
   restarted in place (`docker start`), another session's is never taken.
5. in order, on the open network: the user is the image's `Config.User`, else root
   (set it in the Dockerfile) and, on a Linux host, a non-root user's uid/gid is
   aligned with the host's so files written into the clone are the host user's;
   the env's **`setup`** script runs once (as that user, in the workdir, through
   the user's login shell; skipped for read-only roles) — a failure removes the
   container and retries once in a fresh one, then fails with the output tail;
   the container id is written to the session record only *after* setup
   succeeded; the **`start`** script runs on every start (create and restart);
   then the exec `PATH` is probed once per container (`$SHELL -lic`, with gurt's
   node and npm bins *appended*, so the project's toolchain wins) and cached on
   the record.
6. on the first connection into a container, the session's ACP adapter is
   npm-installed globally (`NPM_CONFIG_PREFIX=$HOME/.gurt/npm`, by gurt's npm) via
   `docker exec` — the packages and the launch command are the kind's
   manifest's (`adapterPackages`, `bin`, `binArgs` in
   `src/plugins/agents/<id>/manifest.ts`), all pinned to exact versions — cached
   per **container id**, so a container that is stopped and restarted keeps its
   install and a replaced one reinstalls; a version marker in the container
   triggers a reinstall when a pin changes. The adapter is launched with gurt's
   own node (`/opt/gurt/node/bin/node <resolved script>`; a bin that is not JS is
   exec'd directly).
7. the session's own Docker network (`gurt-s-<id>`, labelled
   `gurt.session=<id>`) and its **proxy container** are ensured, and the
   container is switched onto that network with no restart (`docker network
   connect`/`disconnect` — a converge against what the daemon reports, so a
   reused or half-attached container lands in the same place). The proxy is a
   stock `node:22-alpine` running one bind-mounted script (`gurt.proxy=<id>`),
   sitting on the session network *and* on a shared `gurt-egress` bridge, and it
   is where every MCP call and — in `internal` sessions — every byte of egress
   goes. Everything above runs on the open network, because the image build,
   the `setup` script and the adapter install all need it
   (requirements-mcp-proxy.md §7.3); the provisioning log records the
   switch. An `internal` session verifies its isolation after the switch and
   fails the start if it cannot be confirmed.
8. ACP `session/new`, then the session's `startPrompt` is sent as the first
   prompt. ACP (JSON-RPC over stdio) runs through `docker exec -i`; **secrets
   never ride in argv**: the agent secret, the proxy variables, the git identity
   and the launch env are passed as `-e NAME` with the values in the docker
   client's own environment (an oauth sign-in for a kind whose plugin names a
   native auth file — codex, gemini — is written as that file instead, piped
   through stdin, with the env var left unset). One adapter process per session,
   held under the session id and tagged with the container it was spawned
   into — a connection cannot outlive that container.

Selected skills are bind-mounted read-only at `/gurt/skills` and linked into the
agent's home; the agent's history is bind-mounted at `/gurt/history`. For
read-only roles the `setup` script is skipped.

Sessions are persisted to `<ws>/<task>/sessions.json` (info incl. state /
startPrompt / queuedAt / its container record, ACP session id, latest proposal)
and restored on app start; the chat history is an append-only
`<ws>/<task>/sessions/<id>.jsonl`. `task.json` marks a directory as a task and
carries its `createdAt` and `maxConcurrentSessions`. At boot the restored container records are reconciled against
`docker ps --filter label=gurt.session`: one describing a container the daemon no
longer has is dropped, a record's container id and running/stopped status are
corrected, a container without the `gurt.runtime=docker` label (made by the
devcontainer-CLI era) is removed and its record reset — the session recreates it
on its next start — and a container whose session is gone is removed — unless the session
store is degraded or reads as empty while containers exist, in which case the
sweep is skipped. Proxies
(`docker ps --filter label=gurt.proxy`) and session networks (`docker network ls
--filter label=gurt.session`) are swept by the same rule, from the same registry. A restored `started` session reattaches lazily: the first prompt runs ACP
`session/load` with the stored id (claude `--resume` under the hood). Resume survives an app restart; for claude code it also survives a container
recreation and a repo-set change, because its history (`.claude/projects`,
`.claude/todos`) is bind-mounted from `.multirepo/<id>/history` and its project
dir name is pinned to the session id. For the other kinds (`historyPaths` empty)
the agent's own state lives in the container and does not survive recreation.

## ACP coverage in the chat

- streaming agent/thought text, tool calls with kind/status and expandable
  output (text + diffs)
- permission requests as inline buttons (allow/reject options from the
  agent); Gurt's own `mcp__gurt__*` tools are always allowed. The draft's
  Config tab picks **auto / manual** per session — `auto` switches the ACP
  session into the agent's auto/accept mode, it does not answer prompts itself
- **Esc** → `session/cancel` (the chat header shows "esc to stop"; queued
  prompts go back to the composer); stop reasons surfaced
- session modes and config options (model, effort, boolean options such as
  fast mode) → chips in the composer's ⚙ "Session settings" popup and the
  Config tab, applied with `session/set_config_option`; blanket-bypass modes
  are hidden
- agent plan as a pinned, expandable progress bar above the composer
- available slash commands in a filterable `/` menu
- composer extras: a visible prompt queue (each item can be taken back), image
  attachments, "Add context" for files and folders, dictation

Client fs read/write and client-side terminals (`src/main/acpClient.ts`) are
advertised in the ACP handshake only for a masking session (see PII / secret
masking below); otherwise they are declared unsupported and agents use their
own tools inside the container.

A turn that ends without `complete` gets one automatic nudge, then the session
is marked `incomplete` (researcher and reviewer have no turn contract). MCP
does not reach the `pi` kind yet — pi-acp ignores ACP `mcpServers` — so `gurt`
and `complete` never arrive there and its turns end `incomplete`
(`src/plugins/agents/pi/manifest.ts`).

## MCP servers

Two sources, one picker. **Built-ins** are Gurt's own host servers (`github`
today; `gurt`, the turn contract, is always attached and never selectable).
**Registry entries** are the workspace's own MCP servers, kept in
`workspace.json` and edited in Settings → MCP servers: remote HTTP endpoints
(see [requirements-mcp-proxy.md](requirements-mcp-proxy.md)) and local stdio
servers — an npm package or a command — that Gurt runs **on the host**,
unsandboxed, behind a stdio↔HTTP bridge (see
[requirements-mcp-stdio.md](requirements-mcp-stdio.md)).

The draft's Config tab (advanced → MCP servers) lists both, and what is picked there is the
session's scope: `SessionInfo.mcp`, persisted with the session, carried by a
duplicate, and shown as chips on the draft and as a mark in the chat header.

- A built-in is **off / read-only / full**: Gurt knows statically which of *its*
  tools write, and hands the agent the smaller set in read-only.
- A registry entry is **off / on** (recorded as `full`): Gurt knows nothing about
  an upstream's tools, so it does not offer a read-only it cannot enforce.
- A selected id the workspace no longer offers (a registry entry deleted behind
  the session) stays listed, marked unavailable, until the user drops it. The
  scope builders report it and route the rest; nothing narrows silently.

Two things build a scope out of that selection, and both re-read it on every
start and resume: `mcp/manager.ts` starts, restarts and stops the *host* servers
per (session, mcp id), and `proxy/config.ts` (`planProxy`) turns the same
selection into the per-session proxy's routes, where remote (http) entries get
their credentials injected; local (npm/command) entries get theirs resolved
into the child process's environment by `mcp/manager.ts`. npm entries are
installed under `~/.gurt/mcp/<id>/` and reinstalled only when the version
changes. Every registry entry has a "start it and see" probe (handshake, plus
`tools/list` with a transcript for local kinds), and a local server that fails
to start does not fail the session — the chat shows a banner.

The github built-in registers its write tools (`git_push`,
`create_pull_request`) only in **full** mode; `create_pull_request` also
pushes, and refuses for a gurt-local repo.

## Skills

A **skill** is a Claude Code skill directory — `SKILL.md` (YAML frontmatter over
a markdown body) plus whatever supporting files it references. Gurt keeps a
registry of them per workspace under `~/.gurt/<ws>/skills/<name>/`, edited in
Settings → Skills — see
[requirements-skills.md](requirements-skills.md).

The draft's config tab lists them off / on, and what is picked there is
`SessionInfo.skills`: persisted with the session, carried by a duplicate, and
frozen once the session leaves draft — by then the files are mounted. A
workspace can switch some on for every new draft (`defaultSkills`, the row's
"enable by default").

Delivery is files, not configuration. At start the selected skills are copied
into the session's own scratch dir and bind-mounted **read-only** into its
container, linked at the agent kind's own skills directory (`AgentManifest.skillsDir`
— `~/.claude/skills` for claude code, `~/.agents/skills` for codex,
`~/.gemini/skills` for gemini, `~/.config/opencode/skills` for opencode,
`~/.pi/agent/skills` for pi).
A kind whose pinned CLI reads no such directory would get neither mount nor
link, and the config tab would say "does not support skills" instead of
offering the pickers — no current kind is in that case.
A skill that was not picked is physically absent, and nothing Gurt writes ever
lands in a clone. It works for every role: the mount is made before any
`setup` script runs, and read-only roles skip that script.

A repository's own `.claude/skills` is the repository's — Gurt does not list,
merge or disable it.

## Session network & observed traffic

The draft's Config tab carries a **network** control (the composer's network
button shows the mode and opens the traffic popup), and the pick is the
session's record (`SessionInfo.network`, persisted next to the MCP selection,
carried by a duplicate, inherited by a session an agent drafts). Like the MCP
selection, skills and role, it can only be edited on a draft and applies at the
next start; to change it later, duplicate the session.

- **internal** (default for new sessions, including the first-run operator) —
  `gurt-s-<id>` is created `--internal`, so the daemon installs no route out
  and the proxy is the session's only egress.
- **open** — a normal bridge, and what a record with no network setting runs
  as. The container keeps its own route out; `HTTP_PROXY`/`HTTPS_PROXY` point
  at the session proxy, so MCP and anything that honours them is routed,
  logged and filtered by the same policy. This is **visibility, not
  enforcement**: a process that ignores those variables goes straight past it.

The policy is one **allow list** (`DomainPolicy` in `src/shared/proxy.ts`),
evaluated on the target a `CONNECT` names — never a path, since Gurt does not
terminate TLS. An entry is `host` or `host:port`: the host half covers the host
and its subdomains, an IP literal matches exactly, a bare host covers every port
and `host:port` only that port. Older `allow` / `denylist` / `allowlist` /
`alwaysAllow` records are migrated into the one list.

- **empty** (the default) — everything outward is allowed and recorded, except
  the built-in denylist: loopback, link-local (169.254.x, where the cloud
  metadata service lives), `host.docker.internal` and the private ranges. That
  list is about the machine Gurt runs on, not the internet. The check is on the
  address a name *resolves* to — resolved once and then dialled at the vetted
  address, so a name cannot answer differently between the check and the
  connection (requirements-mcp-proxy.md §6.4).
- **non-empty** — *only* what it names is allowed, and the built-in denylist is
  not consulted. A listed entry is dialled by name exactly as written, with no
  address vetting and no pinning — reaching `internal.corp.com` in 192.168.x is
  what such an entry is for; a user who distrusts a name writes the IP literal.

MCP routing is outside the policy: an upstream in the registry is one a human
put there, and it is usually on the docker host.

Two caveats the UI states where the choice is made: **setup runs open** — the
image build, the `setup` script and the adapter install all
need the network and all happen before the switch (requirements-mcp-proxy.md
§7.3; the provisioning log records the boundary) — and **SSH git is
unsupported** in internal mode; authenticated git is the host-side github MCP.

The proxy writes one JSON line per connection to stdout. The host tails
`docker logs -f` for the session's lifetime (picking up the last 500 lines on
attach), folds the lines into a bounded per-session ledger (`main/proxy/traffic.ts`,
up to 100 hosts per list) and pushes it to the renderer, which
shows **blocked attempts first** — the host, the rule that refused it, a count
and a last-seen time — with the observed domains collapsed under them. That
panel is how "why can't it reach X?" is answered without reading a log. The
ledger outlives the proxy (an idle session keeps its explanation) and dies with
the session. Hostnames and ports are all there is: no path, header, body or
token is ever recorded.

The per-session proxy scope files — the one place a resolved MCP credential is
at rest outside the credential store — live under `~/.gurt/proxy/` (0700/0600)
and are mounted into the proxy container only.

## Git credentials & authenticated git

Authenticated git happens **only on the host**: through the github MCP tools
(`git_pull`, `git_push`, `create_pull_request`) for the agent, and through the
Changes panel / Diff view (commit, push, Create PR) for the user. The session container never
holds or brokers a credential: it gets unauthenticated local git (status, diff,
add, commit, branch, log) plus the commit identity of the repo's credential, so
the commits it does make are attributed. See
[requirements-git-access.md](requirements-git-access.md) for the full
design and [requirements-mcp-proxy.md](requirements-mcp-proxy.md) §10
for why the container-side path was removed.

- **Credentials** (Settings → Credentials) live in `~/.gurt/credentials.json`, generic
  `kind` + opaque `data`, secret fields sealed with the OS keystore where one is
  available. `git-token` (PAT / fine-grained; GitHub and GitHub Enterprise hosts today —
  only a GitHub forge provider exists to verify it, so a GitLab or Gitea token is
  rejected at save with "no forge provider matches its hosts") and `git-host`
  (explicit opt-in to ambient host auth) are implemented. A repo links one by id
  (or auto-matches by host); the link is never a secret. The same store holds
  `agent-token` (an agent's API key), `mcp-token` (a registry MCP server's),
  `oauth` (browser sign-in tokens for agents and MCP servers) and
  `pii-detector` (a remote masking analyzer).
- A gurt-local repo (a bare origin under `~/.gurt/<ws>/repos/`) uses a fourth
  host-git mode, `local`: no auth, push and pull allowed.
- Ambient host auth is **never a fallback**. When nothing resolves, remote
  operations are blocked with a clear error rather than quietly reaching the
  machine's ssh keys or `gh` login — and ambient ssh is shut off with a failing
  `GIT_SSH_COMMAND` on every managed or blocked call.
- The contract is **git's own extension points**, never a forge API: a host
  credential helper forwards fills to a loopback-only **broker** that answers
  from the store, and `url.<base>.insteadOf` rewrites make the transport follow
  the *credential* (a token repo pushes over https even if it was cloned over
  ssh). Delivered as `-c key=value` argv on the one git call — nothing is
  written into the clone or any global config, and the secret never leaves the
  broker's per-request response.
- A `git-token` is verified against its forge at save time; the owner's
  name/email is stamped on the entry and is what authors managed commits.
  Forge-specific behavior (the host `gh`, GitHub App minting later) lives behind
  interchangeable **forge providers**.

GitHub App tokens (`git-app`) reuse the same provider seam; the kind appears in
the editor but is not wired to the runtime. SSH is not a supported credential
kind — an entry left over from when it was resolves as an error telling you to
replace it with a token.

## PII / secret masking

A global setting (Settings → Masking; no engine selected is off), not a
per-session one: every session masks while an engine is configured. It sits on the
**ACP seam**: the prompt text going out to the agent is scanned and every entity
found is replaced with a `[type:N]` token (`[email:1]`, `[us_ssn:2]`) — the type
the agent needs, an ordinal per type, nothing else. What each token stands for
lives in a per-session table on the host. The timeline holds the tokenized text,
and the chat view substitutes the real values from the table when it renders;
an eye toggle in the composer bar switches between real values and what the
agent sees. See [requirements-pii-mask.md](requirements-pii-mask.md).

- **No cryptography.** The table is `~/.gurt/pii-tables/<session>.json`
  (`{"v":1,"tokens":{"email":{"1":"…"}}}`, owner-only, outside every container
  mount), written before the prompt that uses a new token is sent. It lives as
  long as the session and is deleted with it; tokens survive an app restart
  because the table does. Ordinals are never reused, and the same value is the
  same token for the whole session.
- **Detection** is pluggable behind one `detect(text) -> spans` interface.
  Settings → Masking picks the backend: `built-in` (regex + checksum, in
  process) or `presidio` (a local docker sidecar Gurt runs, or a remote analyzer
  given by URL, optionally linked to a `pii-detector` credential for the URL/API
  key). No backend selected *is* off.
  For presidio you pick the languages, the spaCy model size, a minimum score and
  the entity types; any language/model other than English-large is a derived
  image Gurt builds once. A TEST field masks a sample with the active engine.
- **Patterns are not vendored.** The built-in detector runs whichever public
  collection you pick — CommonRegex, Presidio's own patterns, gitleaks' rules
  — fetched at runtime from a **pinned commit/tag** (never a branch), adapted by
  a small per-source parser, and cached under `~/.gurt/pii-patterns/`. The
  network is only touched on first selection or an explicit **update** in
  Settings → Masking.
- **Fails closed.** If the detector is unavailable (a sidecar still building,
  say), the turn ends with a visible error and nothing is sent unmasked.

For a masking session Gurt also advertises the ACP `fs/*` and `terminal/*`
client methods and answers them itself in the container, encoding what it hands
the agent and revealing what the agent sends (requirements doc §9.1) — whether
an adapter routes its file access and commands through them is up to the
adapter; `acp.client.call` in the log shows which do.

MCP traffic is rewritten at the session proxy, which asks the host to reveal
what goes to a server and encode what comes back (§9.2); a message that cannot
be rewritten is refused, never forwarded.

Out of scope: free-text NER in the built-in detector, arbitrary HTTPS the agent
opens itself, and anything an agent does inside its container without going
through Gurt.


Client-specific JSON settings: [Claude Code attribution and OpenCode/OpenRouter](client-config.md).
