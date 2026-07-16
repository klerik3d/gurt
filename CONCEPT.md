# gurt — Concept

Local-first manager for dev environments and coding agents, modeled on the
Code section of the Claude app (anything not specified here follows that UX).
A Go daemon serves a web board; the frontend stays primitive for now and will
be reworked later.

## Core model

- **Workspace** — top-level divider (`work`, `personal`, ...). Owns the repo
  registry and its metadata.
- **Repo** — registered per workspace: git URL + devcontainer source, which is
  either a file inside the repo or a gurt template. All gurt metadata lives
  outside the repo; working trees are never polluted with gurt files.
- **Task** — unit of work inside a workspace, with its own directory
  `~/.gurt/<workspace>/<task>/`. Holds clones of repos and their environments.
- **Environment** — identity is the pair **(task, repo)**; at most one running
  environment per pair. Its attribute is a **type** (`local` | `dev` | ...):
  a named set of environment variables, plus a reserved slot for future
  dependency orchestration (port-forwards for `dev`, local DB for `local`,
  etc. — not implemented now, only anticipated by the model).
- **Services** — processes provisioned into every environment: `vsc`
  (VS Code web) always; `claude` agent on demand.

## Directory layout

```
~/.gurt/
  templates/<name>/devcontainer.json     # gurt devcontainer templates
  features/<name>/                       # gurt-shipped local features (vsc, ...)
  <workspace>/workspace.json             # repo registry + env types
  <workspace>/<task>/task.json           # task metadata
  <workspace>/<task>/<repo>/             # clone
  <workspace>/<task>/.agent/<repo>/      # claude session data (mounted into container)
```

`workspace.json` sketch:

```json
{
  "name": "personal",
  "repos": [
    {
      "name": "myapp",
      "url": "git@github.com:me/myapp.git",
      "devcontainer": { "source": "repo", "path": ".devcontainer/devcontainer.json" },
      "envTypes": {
        "local": { "env": { "APP_ENV": "local" } },
        "dev":   { "env": { "APP_ENV": "dev" } }
      }
    }
  ]
}
```

(`devcontainer.source` may also be `{ "source": "template", "name": "go-1.24" }`.)

## Environment lifecycle

`start(task, repo, type)`:

1. Clone if missing into `~/.gurt/<ws>/<task>/<repo>/`; auto-create branch
   `gurt/<task>`. The same repo in two tasks = two independent clones
   (worktrees — later).
2. If a container for (task, repo) is already running:
   - same type → **attach** (reconnect UI and services, recreate nothing);
   - different type → **error**; stopping is always a manual action (something
     may be running inside).
3. Compose the **effective devcontainer config in memory** (via
   go-devcontainer, lossless):
   - base = repo's devcontainer file or a gurt template (`--override`-style,
     the clone stays untouched);
   - injected gurt features: `vsc`, `claude` (registry features where they
     exist, otherwise gurt-shipped local features);
   - `containerEnv` from the selected env type;
   - gurt labels: `gurt.workspace`, `gurt.task`, `gurt.repo`, `gurt.envtype`.
4. Build image and run container via the library's `runner` (see
   `docs/go-devcontainer-requirements.md` §6), which also runs lifecycle
   commands.
5. Start services; expose `vsc` on an allocated host port.

**State recovery.** Docker labels are the source of truth. On daemon start it
resyncs running environments from labels; any state file is only a cache.

## Services

### vsc

Injected as an on-the-fly devcontainer feature. Concrete server is a
placeholder for now (openvscode-server as the working option; Microsoft's
`code serve-web` / tunnels tie us to MS builds and accounts). Board shows a
`vsc` button per running environment → `http://localhost:<port>/` with a
connection token.

### claude agent

- Binary arrives the same way — as a feature (an official `claude-code`
  devcontainer feature exists).
- Credentials are injected additionally (shared OAuth token; where it is
  stored is not important yet).
- Session data lives in `~/.gurt/<ws>/<task>/.agent/<repo>/` mounted into the
  container, so history and `--resume` survive container recreation.
- Chat: the daemon runs `claude` inside the container with
  `--input-format stream-json --output-format stream-json` over docker exec;
  the board talks to the daemon over WebSocket. The UI renders messages,
  agent **status** (idle / working / awaiting permission), and **activity**
  (tool calls) — closer to the VS Code / Claude app chat than to a terminal.
- **Permissions**: allow/deny buttons in the chat for permission requests,
  plus switching permission modes (plan / edit / auto) via the control
  protocol.

## Board (MVP)

- Navigate workspaces → tasks → environments.
- Add repo (URL + devcontainer source), create task.
- Start/attach environment (pick repo + type); clear error when another type
  is running.
- Per running environment: `vsc` button, claude chat with status/activity,
  permission buttons, mode switch.
- Local only for now — no auth.

## Engine boundary

gurt does **not** shell out to the devcontainer CLI and does not drive
Docker for environments itself: devcontainer spec logic *and its execution*
belong to `github.com/klerik3d/go-devcontainer` (`plan` produces data, the
`runner` package executes it — see `docs/go-devcontainer-requirements.md`
§6). gurt keeps only policy: the overlay it composes (vsc/claude features,
env-type variables, gurt labels), attach/reuse rules on top of the runner's
discovery, and its services. Until the runner exists, gurt develops against
a stub of that boundary.

**Interim (2026-07-09):** to start faster, the first implementation of the
`Engine` interface (`internal/engine/devcli`) wraps the official
`devcontainer` CLI installed on the host — with no go-devcontainer
dependency at all. The CLI composes the config itself: injected features via
`--additional-features`, gurt templates via `--override-config`, env-type
variables via `--remote-env` (exec-level for now), identity labels via
`--id-label`; discovery and stop go through the docker CLI. Known gap:
publishing the vsc port when the config is repo-owned (no `appPort` without
touching the file) — solved by a docker-level forwarder or template-baked
ports, decided when vsc lands. The runner-based implementation replaces
devcli when the library is ready — the `Engine` interface is the seam that
stays.

## Out of scope (for now)

Diff view and PR creation, per-type dependency orchestration, secrets
management, remote board access/auth, git worktrees, docker-compose configs,
automatic environment shutdown.
