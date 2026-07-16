# gurt

Electron PoC: a local-first manager for dev environments and coding agents.
Concept background lives in [CONCEPT.md](CONCEPT.md) (the Go stack described
there is archived in `archive/`, the model mostly still applies).

## Model

- **workspace** — top-level divider, a directory in `~/.gurt/<ws>/`
- **repo** — registered per workspace: git URL + optional inline
  devcontainer.json (used via `--override-config` when the repo has none);
  add/edit/delete via the workspace "repos" modal
- **agent** — claude code / codex / opencode: on/off + secret (env var name is
  configurable per agent); ⚙ in the sidebar
- **task** — unit of work, `~/.gurt/<ws>/<task>/`, holds repo clones; deletable
- **env** — infrastructure only: a clone on branch `gurt/<task>` + a devcontainer
  per (task, repo). Agent-agnostic — several agents' adapters coexist in the one
  container. Not a tree node; managed from the task pane (start / stop / delete).
- **session** — the primary entity: (workspace, task, repo, agent, startPrompt,
  state) + chat history + optional ACP session id. States:
  `draft → queued → starting → started`.

Sidebar: workspace → task → session. A task click opens the **task pane** (env
table + this task's queued sessions). A session click opens its pane: chat when
`started`, otherwise the start prompt + actions.

### Sessions, queue, serialization

Concurrent access to one working tree is serialized through a **global FIFO
queue** (no git worktrees). Creating a session offers **Run now** / **Add to
queue** / **Save draft**:

- **draft** never runs until you run/enqueue it.
- **queued** waits in the queue; the scheduler starts an item when its target
  (task, repo) is free — i.e. the env is not starting/running. A repo frees only
  when its env is **stopped** (manual stop today; auto-stop is future work). Two
  queued sessions for one repo therefore run strictly one after another.
- **Run now** bypasses the queue and starts immediately; if another session is
  already working on that repo it confirms first (two agents, one working tree).

The queue survives restart (derived from `state: "queued"` + `queuedAt`); the
scheduler runs once after sessions are restored. A failed start drops the
session back to draft with the error shown, and does not block the queue.

## How a session starts

1. clone repo into `~/.gurt/<ws>/<task>/<repo>/` (if missing), branch `gurt/<task>`
2. `devcontainer up` (bundled `@devcontainers/cli`, spawned via Electron's own
   binary in Node mode) injecting **only** the `node` feature + gurt id-labels.
   The container is agent-agnostic; a stopped container is reused.
3. on the first connection of an agent in an env, its ACP adapter is
   npm-installed globally via `devcontainer exec` (claude:
   `@agentclientprotocol/claude-agent-acp`, codex: `@agentclientprotocol/codex-acp`,
   opencode: `opencode-ai`) — cached per (env, agent) for the app run.
4. ACP `session/new`, then the session's `startPrompt` is sent as the first
   prompt. ACP (JSON-RPC over stdio) runs through `devcontainer exec`; the agent
   secret is passed via `--remote-env <secretEnv>=<secret>`. Connections are per
   (env, agent), so different agents each get their own adapter process.

The inline devcontainer config is passed via `--override-config` — to `up`
and to every `exec` (exec re-resolves the config and fails without it).

Sessions are persisted to `<ws>/<task>/sessions.json` (info incl. state /
startPrompt / queuedAt, ACP session id, chat history) and restored on app
start. A restored `started` session reattaches lazily: the first prompt runs ACP
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

## Run

```bash
npm install
npm run dev        # requires docker daemon for env start
```

`GURT_ROOT` env var overrides `~/.gurt` (used by tests).

## Dev container

`.devcontainer/` provides a Node 20 environment for working on gurt itself.
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
