# gurt

[![CI](https://github.com/klerik3d/gurt/actions/workflows/ci.yml/badge.svg)](https://github.com/klerik3d/gurt/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/klerik3d/gurt)](https://github.com/klerik3d/gurt/releases/latest)
[![Renovate enabled](https://img.shields.io/badge/renovate-enabled-brightgreen.svg)](https://renovatebot.com)

A local-first manager for dev environments and coding agents, built as an
Electron app. The name "gurt" is a transcription of the Ukrainian word «гурт»
("group").

Platforms: **macOS and Linux are the primary platforms; Windows is a candidate
(untested)**. Development happens in the devcontainer (see below).

## Project layout

Where to look in the code (the domain model itself is described below):

- `src/main/` — the Electron main process, the app's core (Node side):
  provisioning, ACP, git credentials, the MCP servers, persistence.
- `src/preload/` — the preload bridge: derives `window.gurt` from the shared
  API definition and exposes it to the renderer.
- `src/renderer/` — the React UI (renderer process).
- `src/shared/` — types shared by main and renderer, including the IPC
  contract.
- `resources/proxy/gurt-proxy.mjs` — the per-session egress/MCP proxy. Plain
  dependency-free Node, bind-mounted into a stock `node:alpine` container and
  run as-is, so it is not built with the app; its host-side contract (the
  config file it reads) is `src/main/proxy/config.ts`.

```
renderer (React)  ⇄  preload (window.gurt)  ⇄  main (kernel)
        src/renderer/       src/preload/         src/main/
                    └── src/shared/api.ts ──┘
```

Entry point and main flow: `package.json` `"main": "out/main/index.js"` is the
build of `src/main/index.ts`, which calls `registerIpc()` (`src/main/ipc.ts`);
that in turn builds the app core via `createKernel()` (`src/main/kernel.ts`).
`src/shared/api.ts` is the single source of truth for IPC — adding a method
there is the whole wiring, main and preload both derive from it.
`src/main/sessions.ts` is the heart of the session lifecycle
(start/stop/queue/persistence).

Historical specs and design notes live in [docs/](docs/README.md).

## Model

All gurt metadata lives outside the repositories, under `~/.gurt/` — a working
tree is never polluted with gurt files.

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
  `<title> (copy)`: role, env, repos, agent, MCP/skills/git/auto-allow, config
  picks and the first prompt all come along, nothing runtime-derived does. Fix the
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

Provisioning wraps the official `@devcontainers/cli` rather than driving Docker
itself: features are injected via `--additional-features`, the stored env config
via `--override-config`, identity labels via `--id-label`, secrets via
`--remote-env`. Only container discovery and stop go through the docker CLI —
with the Docker labels as the source of truth (hence the reconcile at boot).

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
5. the session's own Docker network (`gurt-s-<id>`, labelled
   `gurt.session=<id>`) and its **proxy container** are ensured, and the
   container is switched onto that network with no restart (`docker network
   connect`/`disconnect` — a converge against what the daemon reports, so a
   reused or half-attached container lands in the same place). The proxy is a
   stock `node:22-alpine` running one bind-mounted script (`gurt.proxy=<id>`),
   sitting on the session network *and* on a shared `gurt-egress` bridge, and it
   is where every MCP call and — in `internal` sessions — every byte of egress
   goes. Everything above runs on the open network, because the image build,
   the features, `postCreate` and the adapter install all need it
   (docs/requirements-mcp-proxy.md §7.3); the provisioning log records the
   switch.
6. ACP `session/new`, then the session's `startPrompt` is sent as the first
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
longer has is dropped, and a container whose session is gone is removed. Proxies
(`docker ps --filter label=gurt.proxy`) and session networks (`docker network ls
--filter label=gurt.session`) are swept by the same rule, from the same registry. A restored `started` session reattaches lazily: the first prompt runs ACP
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

## MCP servers

Two sources, one picker. **Built-ins** are gurt's own host servers (`github`
today; `gurt`, the turn contract, is always attached and never selectable).
**Registry entries** are the workspace's own remote HTTP MCP endpoints, kept in
`workspace.json` and edited in Settings → MCP servers — see
[docs/requirements-mcp-proxy.md](docs/requirements-mcp-proxy.md).

The composer's harness panel lists both, and what is picked there is the
session's scope: `SessionInfo.mcp`, persisted with the session, carried by a
duplicate, and shown as chips on the draft and as a mark in the chat header.

- A built-in is **off / read-only / full**: gurt knows statically which of *its*
  tools write, and hands the agent the smaller set in read-only.
- A registry entry is **off / on** (recorded as `full`): gurt knows nothing about
  an upstream's tools, so it does not offer a read-only it cannot enforce.
- A selected id the workspace no longer offers (a registry entry deleted behind
  the session) stays listed, marked unavailable, until the user drops it. The
  scope builders report it and route the rest; nothing narrows silently.

Two things build a scope out of that selection, and both re-read it on every
start and resume: `mcp/manager.ts` starts, restarts and stops the *host* servers
per (session, mcp id), and `proxy/config.ts` (`planProxy`) turns the same
selection into the per-session proxy's routes, where registry entries get their
credentials injected.

## Skills

A **skill** is a Claude Code skill directory — `SKILL.md` (YAML frontmatter over
a markdown body) plus whatever supporting files it references. gurt keeps a
registry of them per workspace under `~/.gurt/<ws>/skills/<name>/`, edited in
Settings → Skills — see
[docs/requirements-skills.md](docs/requirements-skills.md).

The draft's config tab lists them off / on, and what is picked there is
`SessionInfo.skills`: persisted with the session, carried by a duplicate, and
frozen once the session leaves draft — by then the files are mounted. A
workspace can switch some on for every new draft (`defaultSkills`, the row's
"enable by default").

Delivery is files, not configuration. At start the selected skills are copied
into the session's own scratch dir and bind-mounted **read-only** into its
container, linked at the agent kind's own skills directory (`AgentDef.skillsDir`
— `~/.claude/skills` for claude code, `~/.config/opencode/skills` for opencode).
A kind whose pinned CLI reads no such directory gets neither mount nor link, and
the config tab says "does not support skills" instead of offering the pickers.
A skill that was not picked is physically absent, and nothing gurt writes ever
lands in a clone. It works for every role: the mount is made before any
devcontainer lifecycle hook runs, and read-only roles have those hooks stripped.

A repository's own `.claude/skills` is the repository's — gurt does not list,
merge or disable it.

## Session network & observed traffic

The same harness panel carries a **network** control, and the pick is the
session's record (`SessionInfo.network`, persisted next to the MCP selection,
carried by a duplicate, inherited by a session an agent drafts):

- **open** (default) — a normal bridge. The container keeps its own route out;
  `HTTP_PROXY`/`HTTPS_PROXY` point at the session proxy, so MCP and anything
  that honours them is routed and logged. This is **visibility, not
  enforcement**: a process that ignores those variables goes straight past it.
- **internal** — `gurt-s-<id>` is created `--internal`, so the daemon installs
  no route out and the proxy is the session's only egress, filtered by a
  **domain policy**: `allow` (everything permitted, everything recorded — the
  place to start), `denylist` or `allowlist`. A rule covers the host and its
  subdomains, IP literals match exactly, ports are recorded but not matched.

Under **every** mode, `allow` included and in both network modes, the proxy
refuses agent egress to this machine: loopback, link-local (169.254.x, where the
cloud metadata service lives), `host.docker.internal` and the private ranges.
The mode is a statement about the internet, not about the host. The check is on
the address a name *resolves* to — resolved once and then dialled directly, so a
name cannot answer differently between the check and the connection — and the
one way through it is the picker's **always allow** list, where `host` or
`host:port` opens exactly that target (docs/requirements-mcp-proxy.md §6.4).
Refusals show in the traffic panel under their own reason, since "edit your
allowlist" would be the wrong fix. MCP routing is outside it: an upstream in the
registry is one a human put there, and it is usually on the docker host.

Two caveats the UI states where the choice is made: **setup runs open** — the
image build, the devcontainer features, `postCreate` and the adapter install all
need the network and all happen before the switch (docs/requirements-mcp-proxy.md
§7.3; the provisioning log records the boundary) — and **SSH git is
unsupported**; authenticated git is the host-side github MCP.

The proxy writes one JSON line per connection to stdout. The host tails
`docker logs -f` for the session's lifetime, folds the lines into a bounded
per-session ledger (`main/proxy/traffic.ts`) and pushes it to the renderer, which
shows **blocked attempts first** — the host, the rule that refused it, a count
and a last-seen time — with the observed domains collapsed under them. That
panel is how "why can't it reach X?" is answered without reading a log. The
ledger outlives the proxy (an idle session keeps its explanation) and dies with
the session. Hostnames and ports are all there is: no path, header, body or
token is ever recorded.

## Git credentials & authenticated git

Authenticated git happens **only on the host**, through the github MCP tools
(`git_pull`, `git_push`, `create_pull_request`). The session container never
holds or brokers a credential: it gets unauthenticated local git (status, diff,
add, commit, branch, log) plus the commit identity of the repo's credential, so
the commits it does make are attributed. See
[docs/requirements-git-access.md](docs/requirements-git-access.md) for the full
design and [docs/requirements-mcp-proxy.md](docs/requirements-mcp-proxy.md) §10
for why the container-side path was removed.

- **Credentials** (🔑 in the sidebar) live in `~/.gurt/credentials.json`, generic
  `kind` + opaque `data`, secret fields sealed with the OS keystore where one is
  available. `git-token` (PAT / fine-grained / GitLab / Gitea) and `git-host`
  (explicit opt-in to ambient host auth) are implemented. A repo links one by id
  (or auto-matches by host); the link is never a secret. The same store holds
  `agent-token` (an agent's API key) and `mcp-token` (a registry MCP server's).
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

## Run

```bash
npm run setup      # npm ci + allow-scripts + unpack the Electron binary
npm run dev        # requires docker daemon for env start
```

`GURT_ROOT` env var overrides `~/.gurt` (used by tests). `GURT_LOG=debug|info|warn|error`
sets the log level — the app writes `~/.gurt/logs/gurt.log` (⌘K → "Open logs
folder"); see [docs/logging.md](docs/logging.md).

## Packaging (alpha builds)

```bash
npm run dist         # macOS → release/gurt-<version>-arm64.dmg + release/mac-arm64/gurt.app
npm run dist:linux   # Linux → release/gurt-<version>.AppImage + .deb
```

Release artifacts (built by `.github/workflows/release.yml` on version tags)
are the dmg plus the AppImage/deb — all unsigned.

Config lives in `electron-builder.yml`. Builds are **unsigned**: they run on the
machine that produced them, but a Mac that downloads the dmg will refuse to open
it until the quarantine flag is cleared:

```bash
xattr -dr com.apple.quarantine /Applications/gurt.app
```

The devcontainer CLI is kept outside `app.asar` (`asarUnpack`) because gurt
spawns it as a child process — only Electron's own fs can read from an asar.

## Auto-update

Packaged builds carry [electron-updater](https://www.electron.build/auto-update),
wired in `src/main/update.ts`. Checks are user-initiated only (⌘K → "Check for
updates") — there is no background poll — and feedback is a native dialog, not
UI in the app itself: up to date, downloading, a restart prompt once the update
lands, or an error. `electron-builder.yml`'s `publish` block points the default
feed at this repo's GitHub Releases, matching `.github/workflows/release.yml`
(which uploads the `latest*.yml` manifests alongside the installers — without
those, electron-updater has nothing to compare versions against).

Auto-update only works for the **AppImage** target on Linux (the deb ships too,
but upgrades through apt/dpkg, not this — `checkForUpdates()` short-circuits with
a dialog if it isn't running as the AppImage, so it never falls back to shelling
out to `sudo dpkg -i`, which electron-updater will otherwise attempt and which
just hangs or fails outside a desktop with a polkit agent). macOS auto-update
needs the `zip` target (also configured) and, unverified so far here, a signed
build — these are alpha builds and `identity: null` (see above), so treat mac
auto-update as best-effort until that changes.

**Testing the whole loop locally, before pushing a tag:**

```bash
# 1. Build and set aside the "old" version an installed user would be running.
npm run dist:linux
cp release/gurt-<old-version>-arm64.AppImage /tmp/gurt-old.AppImage

# 2. Bump the version in package.json, rebuild — release/ now has the "new"
#    installer plus an updated release/latest-linux*.yml pointing at it.
npm run dist:linux

# 3. Serve release/ as the update feed.
npx http-server release -p 8384    # or: python3 -m http.server 8384 -d release

# 4. Run the old build with the feed overridden to your local server (this is
#    the one thing that only exists for this loop — GURT_UPDATE_URL isn't read
#    anywhere else) and trigger a check from the running app (⌘K → "Check for
#    updates"). It downloads the new AppImage, verifies its sha512 against the
#    manifest, and replaces /tmp/gurt-old.AppImage in place.
GURT_UPDATE_URL=http://127.0.0.1:8384 /tmp/gurt-old.AppImage
```

`GURT_UPDATE_URL` swaps the baked-in GitHub provider for a `generic` one at
runtime (`autoUpdater.setFeedURL`) — nothing about the build config changes, so
this is safe to leave set only for the one test run. Running the *unpacked*
`release/linux-arm64-unpacked/gurt` binary instead of the real `.AppImage` also
works for exercising the check-and-download path, but electron-updater then has
no `APPIMAGE` env var to tell it how it was installed and falls back to the
deb/sudo path above — always test through the actual `.AppImage` file.

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

Smoke scripts drive the built app with Playwright through the real UI and
screenshot into `$SCRATCH/shots`; run `npm run build` first. Without agent
secrets the chat shows an auth error — that still proves the ACP pipe. The
scripts strip `ELECTRON_RUN_AS_NODE` (shells spawned from a VSCode extension
host inherit it and it makes Electron start as plain Node). The list below is
the full set (`ls scripts/smoke*.mjs`).

```bash
npm run build
SCRATCH=/tmp/gurt-smoke node scripts/smoke.mjs    # UI only, no docker
SCRATCH=/tmp/gurt-smoke node scripts/smoke-provisioning.mjs   # provisioning + ACP session
SCRATCH=/tmp/gurt-smoke node scripts/smoke-persistence.mjs    # session persistence across restart
SCRATCH=/tmp/gurt-smoke node scripts/smoke-crud.mjs           # CRUD + stop/delete + codex handshake
SCRATCH=/tmp/gurt-smoke node scripts/smoke-codex.mjs          # codex-in-gurt handshake
SCRATCH=/tmp/gurt-smoke node scripts/smoke-queue.mjs          # session queue: draft/serialization/restart
SCRATCH=/tmp/gurt-smoke node scripts/smoke-changes.mjs        # Changes panel delivery thread, no docker (local bare repos)
SCRATCH=/tmp/gurt-smoke node scripts/smoke-review.mjs         # manual review: split diff, comments, lock toggle, Launch fix, no docker (local bare repos)
SCRATCH=/tmp/gurt-smoke node scripts/smoke-git-credentials.mjs # credentials CRUD + repo resolution note, no docker
# turn contract end-to-end (docker + a working claude secret; SKIPs without one):
SCRATCH=/tmp/gurt-smoke GURT_SMOKE_CLAUDE_TOKEN=… node scripts/smoke-turn-contract.mjs
node scripts/smoke-delete-row.mjs                 # sidebar Del/⌫: confirm, delete, move the selection, no docker
node scripts/smoke-session-copy.mjs               # duplicate/delete from the row actions and the pane menu, no docker
node scripts/smoke-roles.mjs                      # session roles: the picker, the repo select it drives, persistence, no docker
node scripts/smoke-newtask.mjs                    # header "+" creates a task inline — no modal, no stray session, no docker
node scripts/smoke-deleted-task.mjs               # a deleted task stays deleted: selection cleared, no dir resurrected by a late persist, no docker
node scripts/smoke-logging.mjs                    # app log: startup banner, IPC wrapper, renderer transport, no docker (an unreachable daemon is logged as "unavailable")
node scripts/smoke.linux.mjs                      # linux variant of smoke.mjs: client registry + agent-token credential linkage over a plaintext store, no docker
```

Unit tests are pure node — no Electron, no Playwright, no docker; the TS under
test is bundled on the fly with esbuild. `npm test` runs every
`scripts/*.test.mjs` (currently 46) and is the canonical way to run them; a single
file can also be run directly. A few, to show what they cover:

```bash
npm test                               # all of scripts/*.test.mjs
node scripts/git-logic.test.mjs        # git contract: repo identity, credential resolution, rewrites, forge
node scripts/session-log.test.mjs      # append-only session log + legacy migration
node scripts/gurt-mcp.test.mjs         # the `gurt` MCP server: `complete` validation + the per-role tool set
node scripts/session-roles.test.mjs    # session roles: locks, (role, repos) rules, create_session gating, migration
node scripts/turn-contract.test.mjs    # turn contract: the post-turn nudge/incomplete decision matrix
node scripts/proposal-store.test.mjs   # turn contract: proposal restore, latestProposal, Kernel.prUrl params
node scripts/env-config.test.mjs       # env normal form: JSONC parse/validation, envImageTag identity, migration
node scripts/mcp-registry.test.mjs     # workspace MCP registry: validation, built-in/registry lookup, store CRUD, mcp-token links
node scripts/mcp-selection.test.mjs    # per-session MCP selection: persistence over both sources, scope resolution, a deleted entry
node scripts/skills-selection.test.mjs # per-session skills: the on-disk registry, selection/inheritance/defaults, what gets materialized
node scripts/proxy-policy.test.mjs     # session proxy: the domain matcher, the policy modes, route/config parsing
node scripts/proxy-server.test.mjs     # session proxy, live: MCP routing + credential injection, CONNECT, config reload
node scripts/proxy-config.test.mjs     # host side of the proxy contract: scope + ACP descriptors, and what never reaches the container
node scripts/proxy-traffic.test.mjs    # observed traffic: the proxy's JSON lines → the blocked/allowed lists the session pane shows
node scripts/session-network.test.mjs  # per-session network mode: persistence, restore, sanitization, what a copy or a drafted session inherits
node scripts/session-delete-container.test.mjs  # deleting a session takes its container down with it
node scripts/session-duplicate.test.mjs # duplicating a session: what a copy carries, and what it never does
node scripts/log.test.mjs              # app log: writer, rotation, sanitization, redaction, drop accounting
```


## Docker Desktop gotchas (macOS)

- Bind mounts require Docker-shared paths; `~/.gurt` (under `/Users`) is fine,
  `/tmp` is not.
- Deleting a directory and recreating it at the same path can leave a stale
  virtiofs cache in the Docker VM — mounts then fail with "bind source path
  does not exist" even though the path exists. Smoke tests use a unique root
  per run for this reason; if it bites the real `~/.gurt` after env
  delete/re-add, restart Docker Desktop.

## License

Licensed under the [Apache License 2.0](LICENSE). The project name and logo
are not covered by this license. Contributions require signing the
[CLA](CLA.md) — see [CONTRIBUTING.md](CONTRIBUTING.md).
