# gurt

Electron PoC: local-first manager for dev environments and coding agents.
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
- **env** — (task, repo) pair bound to one agent: clone on branch
  `gurt/<task>` + devcontainer; start / stop / delete (delete removes the
  container, the clone and the sessions)
- **session** — an ACP session with the env's agent inside its container

Sidebar: workspace → task → env → session. Main pane: chat.

## How an env starts

1. clone repo into `~/.gurt/<ws>/<task>/<repo>/` (if missing), branch `gurt/<task>`
2. `devcontainer up` (bundled `@devcontainers/cli`, spawned via Electron's own
   binary in Node mode) with injected features: `node` + the env agent's
   runtime feature (claude: `anthropics/devcontainer-features/claude-code`),
   gurt id-labels
3. the agent's ACP adapter is npm-installed globally in the container
   (claude: `@agentclientprotocol/claude-agent-acp`, codex:
   `@agentclientprotocol/codex-acp`, opencode: `opencode-ai`)
4. sessions talk ACP (JSON-RPC over stdio) through `devcontainer exec`; the
   agent secret is passed via `--remote-env <secretEnv>=<secret>`

The inline devcontainer config is passed via `--override-config` — to `up`
and to every `exec` (exec re-resolves the config and fails without it).

Sessions are persisted to `<ws>/<task>/sessions.json` (info + ACP session id
+ chat history) and restored into the tree on app start. The agent process is
respawned lazily: the first prompt to a restored session runs ACP
`session/load` with the stored id (claude `--resume` under the hood). The
agent's own session state lives inside the container, so resume survives an
app restart but not a container recreation.

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

## Smoke tests

```bash
npm run build
SCRATCH=/tmp/gurt-smoke node scripts/smoke.mjs    # UI only, no docker
SCRATCH=/tmp/gurt-smoke node scripts/smoke2.mjs   # provisioning + ACP session
SCRATCH=/tmp/gurt-smoke node scripts/smoke3.mjs   # session persistence across restart
SCRATCH=/tmp/gurt-smoke node scripts/smoke4.mjs   # CRUD + stop/delete + codex handshake
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
