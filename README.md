# gurt

Electron MVP: a local-first manager for dev environments and coding agents.
Concept background lives in [CONCEPT.md](CONCEPT.md) (the Go stack described
there is archived in `archive/`; the model mostly still applies).

## Model

- **workspace** — top-level divider, a directory in `~/.gurt/<ws>/`
- **repo** — registered per workspace: git URL + optional credential link;
  add/edit/delete via Settings → Repos
- **agent** — an instance of a built-in kind (claude code / codex / gemini /
  opencode).
  The registry starts empty; add instances as needed via ⚙ in the sidebar. Each
  maps to its secret by linking an `agent-token` credential (never storing it
  inline, like a repo's credential link); env var name + extra env are per-agent
- **task** — unit of work, `~/.gurt/<ws>/<task>/`, holds repo clones; deletable
- **env** — a workspace entity and purely a *definition*: a mandatory
  devcontainer.json (+ companion Dockerfile when it has `build`), stored
  entirely in gurt and seeded from the repo's own files (then edited in gurt —
  the repo is never the source of truth at runtime). It is a template, not an
  instance: any number of sessions may run the same env at once.
- **container** — owned by exactly one session, 1:1. Created at that session's
  first start, stopped when it goes idle, destroyed with it; never shared with
  or inherited by another session. Docker is the registry (every container
  carries the id-label `gurt.session=<id>`), and the record on the session is a
  cache reconciled against the daemon at boot. Managed from the task pane
  (stop / delete).
- **clone** — `~/.gurt/<ws>/<task>/<repo>/` on branch `gurt/<task>`, shared by
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
  [docs/requirements-session-roles.md](docs/requirements-session-roles.md):
  - **executor** — today's worker: one repo, read-write, holds the clone
    exclusively, ends every turn with `complete` (the turn contract below).
  - **researcher** — read-only, locks nothing (so it never blocks and is never
    blocked), no deliverable and no turn contract; the only role that may hold
    several repos at once. Answers in chat.
  - **reviewer** — judges one clone's *uncommitted* changes: read-only, but
    holding the clone lock so nothing can move under it. Its verdict is plain
    chat text and gates nothing.

  Read-only means Docker `readonly` bind mounts, not a convention. A researcher
  and a reviewer are also offered `create_session` instead of `complete`: it
  **drafts** another session in the same task (a fixer executor, a reviewer),
  fully configured. A draft never runs by itself — the user reviewing and
  launching it is the approval step — and nothing flows back to the spawner.

Sidebar: workspace → task → session. A task click opens the **task pane** (the
containers of its sessions + this task's queued sessions). A session click opens
its pane: chat when `started`, otherwise the start prompt + actions.

### Duplicate / delete

A session set up wrong is usually noticed once it is already running, so both
ways out are offered in every state — from the sidebar row (hover), from the
draft/queued/starting pane, and from the ⋯ menu in the pane header (the only one
a chat has):

- **duplicate** copies the session into a new **draft** of the same task, named
  `<title> (copy)`: role, env, repos, agent, MCP/git/auto-allow, config picks
  and the first prompt all come along, nothing runtime-derived does. Fix the
  setting that was wrong, then run it.
- **delete** removes the session in any state — running or mid-start included —
  and everything it owns: its container, its adapter, its host servers, its chat
  log. The clone and its uncommitted work stay, since a clone outlives every
  session of its task.

### Sessions, queue, serialization

Concurrent access to one working tree is serialized through a **global FIFO
queue** (no git worktrees). Creating a session offers **Run now** / **Add to
queue** / **Save draft**:

- **draft** never runs until you run/enqueue it.
- **queued** waits in the queue; the scheduler starts an item when its target
  (task, repo) is free — i.e. no session is starting or holding a live container
  on that clone. A repo frees when its holder's container comes down, and with
  something queued behind it that is immediate: the holder's turn ends, its
  container is stopped (`reason: queue`), and the next item starts. Two queued
  sessions for one repo therefore run strictly one after another, back to back.
  A holder that is mid-turn or mid-start is never cut off — the queue waits for
  it — and with an empty queue containers stay up for the usual idle grace
  period, ready for a follow-up prompt.
- **Run now** bypasses the queue and starts immediately; if another session is
  already working on that repo it confirms first (two agents, one working tree).

The queue survives restart (derived from `state: "queued"` + `queuedAt`); the
scheduler runs once after sessions are restored. A failed start drops the
session back to draft with the error shown, and does not block the queue.

## How a session starts

1. clone repo into `~/.gurt/<ws>/<task>/<repo>/` (if missing), branch `gurt/<task>`
2. when the env's devcontainer has a `build` section, the image is built first:
   a temporary snapshot of the clone at HEAD (`git archive` — the working clone
   is never touched) gets the env's devcontainer.json + Dockerfile written into
   its `.devcontainer/`, then `docker build` runs with the config's
   args/target. Images are tagged by content (repo url + commit + Dockerfile +
   build config), so an unchanged env is reused, including one pre-built from
   Settings → Environments (the `build` button there, with an exists/missing
   badge per env).
3. `devcontainer up` (bundled `@devcontainers/cli`, spawned via Electron's own
   binary in Node mode) injecting **only** the `node` feature + gurt id-labels.
   The container belongs to the starting session (`gurt.session=<id>`); its own
   stopped container is restarted in place, another session's is never taken.
4. on the first connection into a container, the session's ACP adapter is
   npm-installed globally via `devcontainer exec` (claude:
   `@agentclientprotocol/claude-agent-acp`, codex: `@agentclientprotocol/codex-acp`,
   gemini: `@google/gemini-cli` (run as `gemini --experimental-acp`),
   opencode: `opencode-ai`) — cached per **container id**, so a container that is
   stopped and restarted keeps its install and a replaced one reinstalls.
5. ACP `session/new`, then the session's `startPrompt` is sent as the first
   prompt. ACP (JSON-RPC over stdio) runs through `devcontainer exec`; the agent
   secret is passed via `--remote-env <secretEnv>=<secret>`. One adapter process
   per session, held under the session id and tagged with the container it was
   spawned into — a connection cannot outlive that container.

The materialized env config (the stored devcontainer.json, with `build`
replaced by the built `image` tag when present) is ALWAYS passed via
`--override-config` — to `up` and to every `exec` (exec re-resolves the
config and fails without it).

Sessions are persisted to `<ws>/<task>/sessions.json` (info incl. state /
startPrompt / queuedAt / its container record, ACP session id, chat history) and
restored on app start; `task.json` is now only the marker that makes a directory
a task. At boot the restored container records are reconciled against
`docker ps --filter label=gurt.session`: one describing a container the daemon no
longer has is dropped, and a container whose session is gone is removed. A restored `started` session reattaches lazily: the first prompt runs ACP
`session/load` with the stored id (claude `--resume` under the hood). The agent's
own session state lives inside the container, so resume survives an app restart
but not a container recreation.

## ACP coverage in the chat

- streaming agent/thought text, tool calls with kind/status and expandable
  output (text + diffs)
- permission requests as inline buttons (allow/reject options from the
  agent); per-session **auto-allow** toggle
- **Stop** button → `session/cancel`; stop reasons surfaced
- session modes (plan/edit/auto etc.) → selector in the chat header
- agent plan rendered as a checklist panel
- available slash commands rendered as chips under the input

Not implemented (declared unsupported in the ACP handshake): client fs
read/write and client-side terminals — agents fall back to their own tools
inside the container.

## Native git access

Optional per-session (`git access` toggle in the composer; default on when a
credential resolves for the repo). When on, the agent gets **native** git in the
container — `git push`, `gh`, submodule fetches — instead of delegating remote
ops to the github MCP. See [docs/requirements-git-access.md](docs/requirements-git-access.md)
for the full design. Phase 1 (this slice) covers the HTTPS path:

- **Credentials** (🔑 in the sidebar) live in `~/.gurt/credentials.json`, generic
  `kind` + opaque `data`. Phase 1 implements `git-token` (PAT / fine-grained /
  GitLab / Gitea) and `git-host` (ambient). A repo links one by id (or
  auto-matches by host); the link is never a secret. Agent secrets are the same
  store's `agent-token` kind — an agent links one by id (no host matching); old
  inline `agents.json` secrets migrate into it on first launch.
- The contract is **git's own extension points**, never a forge API: an in-container
  credential-helper shim forwards to a host **broker** (one per session, like the
  MCP servers) that answers from the store; `url.<base>.insteadOf` rewrites make the
  transport follow the *credential* (a token repo pushes over https even if cloned
  over ssh). All injected via `GIT_CONFIG_*` env into the agent process only —
  nothing is written into the clone or the container's global config, and secrets
  never leave the broker's per-request responses.
- Forge-specific behavior (the `gh` wrapper, GitHub App minting later) lives behind
  interchangeable **forge providers**; the github provider also injects the
  github-cli devcontainer feature at env-up. Host-side git (clone, the Changes
  panel's fetch/push) uses the same resolution, so it works with no ambient auth.

SSH keys (phase 2) and GitHub App tokens + agent-secret migration (phase 3) reuse
the same broker/shim/provider seams; their credential kinds appear in the modal but
are not wired to the runtime yet.

## Run

```bash
npm ci && npx allow-scripts
npm run dev        # requires docker daemon for env start
```

`GURT_ROOT` env var overrides `~/.gurt` (used by tests). `GURT_LOG=debug|info|warn|error`
sets the log level — the app writes `~/.gurt/logs/gurt.log` (⌘K → "Open logs
folder"); see [docs/logging.md](docs/logging.md).

## Packaging (alpha builds)

```bash
npm run dist       # → release/gurt-<version>-arm64.dmg + release/mac-arm64/gurt.app
```

Config lives in `electron-builder.yml`. Builds are **unsigned**: they run on the
machine that produced them, but a Mac that downloads the dmg will refuse to open
it until the quarantine flag is cleared:

```bash
xattr -dr com.apple.quarantine /Applications/gurt.app
```

The devcontainer CLI is kept outside `app.asar` (`asarUnpack`) because gurt
spawns it as a child process — only Electron's own fs can read from an asar.

## Dev container

`.devcontainer/` provides a Node 22 environment for working on gurt itself.
Because gurt provisions *child* dev containers at runtime, the container ships
**Docker-in-Docker** (the inner daemon shares its filesystem, so clones under
`GURT_ROOT` bind-mount into the children). Electron runs headless on an Xvfb
display (`:99`), started automatically — `xvfb-run` is not needed. Reopen the
folder in the container, then `npm run dev` or the smoke scripts work as above.
The full docker-provisioning smokes are heavy nested-in-nested; the UI-only
`smoke.mjs` is the light check.

## Smoke tests

```bash
npm run build
SCRATCH=/tmp/gurt-smoke node scripts/smoke.mjs    # UI only, no docker
SCRATCH=/tmp/gurt-smoke node scripts/smoke2.mjs   # provisioning + ACP session
SCRATCH=/tmp/gurt-smoke node scripts/smoke3.mjs   # session persistence across restart
SCRATCH=/tmp/gurt-smoke node scripts/smoke4.mjs   # CRUD + stop/delete + codex handshake
SCRATCH=/tmp/gurt-smoke node scripts/smoke5.mjs   # codex-in-gurt handshake
SCRATCH=/tmp/gurt-smoke node scripts/smoke6.mjs   # session queue: draft/serialization/restart
SCRATCH=/tmp/gurt-smoke node scripts/smoke7.mjs   # Changes panel delivery thread, no docker (local bare repos)
SCRATCH=/tmp/gurt-smoke node scripts/smoke8.mjs   # native git access: credentials CRUD + resolution + composer toggle, no docker
# turn contract end-to-end (docker + a working claude secret; SKIPs without one):
SCRATCH=/tmp/gurt-smoke GURT_SMOKE_CLAUDE_TOKEN=… node scripts/smoke9.mjs
node scripts/smoke-delete-row.mjs                 # sidebar Del/⌫: confirm, delete, move the selection, no docker
node scripts/smoke-session-copy.mjs               # duplicate/delete from the row actions and the pane menu, no docker
node scripts/smoke-roles.mjs                      # session roles: the picker, the repo select it drives, persistence, no docker
node scripts/smoke-logging.mjs                    # app log: startup banner, IPC wrapper, renderer transport, needs docker
```

Docker-free unit tests (pure node, bundled on the fly with esbuild):

```bash
node scripts/git-logic.test.mjs        # git contract: repo identity, credential resolution, rewrites, forge
node scripts/session-log.test.mjs      # append-only session log + legacy migration
node scripts/gurt-mcp.test.mjs         # the `gurt` MCP server: `complete` validation + the per-role tool set
node scripts/session-roles.test.mjs    # session roles: locks, (role, repos) rules, create_session gating, migration
node scripts/turn-contract.test.mjs    # turn contract: the post-turn nudge/incomplete decision matrix
node scripts/proposal-store.test.mjs   # turn contract: proposal restore, latestProposal, Kernel.prUrl params
node scripts/env-config.test.mjs       # env normal form: JSONC parse/validation, envImageTag identity, migration
node scripts/session-delete-container.test.mjs  # deleting a session takes its container down with it
node scripts/session-duplicate.test.mjs # duplicating a session: what a copy carries, and what it never does
node scripts/log.test.mjs              # app log: writer, rotation, sanitization, redaction, drop accounting
```

All drive the built app with Playwright through the real UI and screenshot
into `$SCRATCH/shots`. Without agent secrets the chat shows an auth error —
that still proves the ACP pipe. The scripts strip `ELECTRON_RUN_AS_NODE`
(shells spawned from a VSCode extension host inherit it and it makes Electron
start as plain Node).

## Docker Desktop gotchas (macOS)

- Bind mounts require Docker-shared paths; `~/.gurt` (under `/Users`) is fine,
  `/tmp` is not.
- Deleting a directory and recreating it at the same path can leave a stale
  virtiofs cache in the Docker VM — mounts then fail with "bind source path
  does not exist" even though the path exists. Smoke tests use a unique root
  per run for this reason; if it bites the real `~/.gurt` after env
  delete/re-add, restart Docker Desktop.
