# Agent brief: building workflows on gurt

You are about to build workflows (multi-step, multi-session flows) on top of
gurt. This brief is the map: what gurt is, which primitives a workflow can be
built from today, the rules you must not break, where in the code to hook in,
and how to work in this repo. Read it fully before touching code; follow the
links for depth.

## 1. What gurt is, in one paragraph

gurt is a local-first Electron app that runs coding agents (claude code,
codex, gemini, opencode) inside per-session devcontainers. Every agent talks
to gurt over **ACP** (JSON-RPC over stdio via `devcontainer exec`) and gets a
per-session host MCP server named **`gurt`** for structured output. All state
lives under `~/.gurt/` (override with `GURT_ROOT`), never inside a repo.
The core is an **Electron-free kernel** (`src/main/kernel.ts`) — importable
headless, which is exactly the seam a workflow engine should use.

```
renderer (React)  ⇄  preload (window.gurt)  ⇄  main (kernel)
        src/renderer/       src/preload/         src/main/
                    └── src/shared/api.ts ──┘   (single source of truth for IPC)
```

## 2. Domain model (the nouns a workflow manipulates)

| entity | what it is | key facts |
|---|---|---|
| workspace | `~/.gurt/<ws>/` | holds repos, envs, MCP registry, skills, agent defaults |
| repo | git URL + optional credential link | registered per workspace |
| env | devcontainer.json (+ Dockerfile) **definition** | a template; many sessions may use one |
| task | `~/.gurt/<ws>/<task>/` | unit of work; holds clones on branch `gurt/<task>` |
| clone | one working tree per (task, repo) | shared by all sessions of the task; **exclusive lock** for writers |
| session | (ws, task, env, role, repos, agent, startPrompt, state) | the primary entity; owns exactly one container |
| container | 1:1 with a session | labelled `gurt.session=<id>`; Docker is the registry |

Session states: `draft → queued → starting → started`. A failed start drops
back to `draft` with `startError`.

## 3. Roles — the building blocks of any workflow

Role is chosen at creation and drives mounts, locks and the MCP tool set
(`src/shared/types.ts` `SessionRole`; full spec in
[requirements-session-roles.md](requirements-session-roles.md)).

| role | mounts | clone lock | `complete` (turn contract) | `create_session` | repos |
|---|---|---|---|---|---|
| **executor** | read-write | holds | **yes, every turn** | no | exactly 1 |
| **researcher** | read-only | none | no | yes (incl. other tasks) | 1..N |
| **reviewer** | read-only by intent | holds | no | yes (fixer executor only) | exactly 1 |
| **operator** | none | none | no | no | exactly 0 |

Read-only = real Docker `readonly` bind mounts, not a convention.
Operator configures gurt itself through a read-only admin surface (see §6).

## 4. Primitives that already exist

These are what you compose. Do not reinvent them.

1. **Queue / serialization** (`src/main/sessions.ts`). A global FIFO; an item
   starts when its (task, repo) clone is free. Two queued sessions on one repo
   run strictly back to back; the holder's container is stopped the moment
   its turn ends if something waits behind it. Optional per-task cap:
   `setTaskMaxConcurrentSessions`. Survives restart.
2. **Turn contract — the only typed artifact today.** Every executor turn
   must end with `gurt.complete(ChangeProposal)`:
   `outcome: 'changes' | 'no_changes' | 'blocked'` + commit/PR texts or a
   reason (zod-strict). A turn that ends without it gets one automatic nudge
   (`postTurnDecision`). The host stores it and emits **`session.proposal`**.
   Spec: [requirements-turn-contract.md](requirements-turn-contract.md).
3. **`create_session` (agent-driven fan-out).** Researcher/reviewer can
   *draft* a fully configured session. A draft **never runs by itself** —
   the user launching it is the approval step, and nothing flows back to the
   spawner. Shape: `AgentSessionRequest` in `src/shared/types.ts`.
4. **Manual review → fix.** `kernel.review` (comments + review lock on a
   clone) and `kernel.launchReviewFix(...)` drafts an executor that fixes the
   open comments. Spec: [requirements-manual-review.md](requirements-manual-review.md).
5. **Changes panel = the ship stage.** Commit / push / PR are explicit user
   actions (`changesCommit`, `changesPush`, `changesOpenPr`); authenticated git
   happens only on the host via the github MCP tools. The container never
   holds credentials.
6. **Session reuse.** A follow-up prompt into a live session (`sessionPrompt`)
   keeps context and costs no container start; `sessionDuplicate` copies a
   session's config into a new draft.
7. **Domain bus** (`src/shared/events.ts`, `src/main/bus.ts`). The events a
   workflow engine reacts to:
   - `session.state` — lifecycle transitions
   - `session.turn` — `{ phase: 'started' | 'ended', final? }`
   - `session.awaiting` — agent waiting on a permission
   - `session.proposal` — a validated `ChangeProposal` landed
   - `session.deleted`, `container.status`, `provision.log`, `mcp.fail`,
     `notification.created`, `agent.turn` (usage)
8. **Notifications** (`src/main/notifications.ts`); external delivery
   (`src/main/notify-external.ts`) is a **stub** — the seam for Slack/webhook.

## 5. The rules (non-negotiable unless the owner says otherwise)

From [design-orchestration.md](design-orchestration.md) — that document is
marked **UNDER DISCUSSION, NOT approved, DO NOT IMPLEMENT**. Its direction is
still the best statement of intent; treat it as constraints, not as a work
order:

- **Agents never talk to each other.** Inter-stage data = typed artifacts
  submitted through host MCP tools, validated server-side (zod), stored in the
  task store, surfaced as bus events. Never pass one agent's chat to another.
- **Stage type ≠ stage binding.** The contract (input artifacts → output
  schema) is fixed in the kernel; who executes it (agent, env, model) is
  config.
- **No universal pipeline / no workflow language.** Named templates per task
  kind (`change`, `pr-review`, `analyze`), pipelines are *data* (a state
  machine in the store), loops are retry edges with `maxRounds`. No DAGs, no
  conditionals.
- **Session reuse:** continuity → same session (fix rounds); independence →
  fresh session (re-review, to avoid anchoring).
- **No auto-ship.** Commit / push / PR always sit behind an explicit user
  action. Approval gates are explicit stages.
- **Drafts are approval.** Anything an agent spawns is a draft until a human
  runs it. Do not add a path that auto-runs agent-authored sessions.
- **Fail closed.** New `GurtApi` methods must be annotated `read | write |
  none` in `METHODS` (`src/shared/api.ts`); when unsure, `none`.
- **Operator boundary** ([requirements-session-operator.md](requirements-session-operator.md)):
  only `read` admin tools are registered; it cannot start/drive sessions,
  read repo content, or touch credentials. Do not turn the operator into an
  orchestrator without a doc change.
- **Security invariants:** no credential values cross into containers or
  tool results; `credentialId` / credential-bearing `url` are never written by
  an agent; devcontainer host-execution fields (`initializeCommand`, `mounts`,
  `runArgs`, `privileged`, `capAdd`) are held for user confirmation.

**Before implementing any piece of orchestration, get the owner to turn it
into a `docs/requirements-*.md`.** That is how work is authorized here.

## 6. Where to hook in (code map)

| need | file |
|---|---|
| compose kernel, cross-cutting ops | `src/main/kernel.ts` (`createKernel()`, `Kernel`) |
| session lifecycle, queue, scheduler, turn nudge, permissions | `src/main/sessions.ts` |
| containers / provisioning | `src/main/containers.ts`, `src/main/provision.ts` |
| per-session `gurt` MCP tools (`complete`, `create_session`, admin reads) | `src/main/mcp/gurtServer.ts` |
| new typed artifact (e.g. `ReviewVerdict`) | type in `src/shared/types.ts`, zod schema + tool in `gurtServer.ts`, storage via `store.ts`, event in `src/shared/events.ts` |
| bus | `src/main/bus.ts`, events in `src/shared/events.ts` |
| IPC to UI | add the method to `src/shared/api.ts` (that is the whole wiring) + annotate exposure; regenerate `adminTools.generated.ts` (`scripts/gen-admin-tools.mjs`) |
| persistence layout | `src/main/store.ts` (`~/.gurt/<ws>/<task>/sessions.json`, `task.json`, `workspace.json`) |
| review state | `src/main/review.ts` |
| UI | `src/renderer/src/components/` (e.g. `TaskPane.tsx`) |

Headless usage pattern: see the unit tests that call `createKernel()` —
`scripts/queue-handoff.test.mjs`, `scripts/proposal-store.test.mjs`,
`scripts/operator-role.test.mjs`. They show how to drive the kernel without
Electron, with `GURT_ROOT` pointing at a temp dir.

**Not yet there (do not assume it):** `ReviewVerdict` artifact, pipeline
state machine, templates, external API / CLI to gurt (the only drivers are
the UI over IPC and agents over the `gurt` MCP), real external notifications,
operator write tools.

## 7. How to work in this repo

- Specs are work orders: `docs/requirements-*.md`. Read the relevant ones
  first; each lists its key code. Don't change a contract a doc marks
  "do not change without asking the owner".
- Commands:
  ```bash
  npm run setup        # once
  npm run typecheck && npm run lint
  npm test             # all scripts/*.test.mjs — pure node, no docker
  npm run build        # before any smoke
  SCRATCH=/tmp/gurt-smoke node scripts/smoke-queue.mjs   # Playwright smokes, see README
  ```
  New behaviour gets a `scripts/<name>.test.mjs`; UI flows get a smoke.
- Style: match surrounding code — dense "why" comments referencing doc
  sections (`§3.2`), role behaviour read through predicates
  (`sessionRole()`, `roleNeedsRepo()`, `roleHasTurnContract()`), never off
  the raw field.
- Git: branch off `main`, PRs to `klerik3d/gurt`. Commits are authored as
  `klerik3d <4738416+klerik3d@users.noreply.github.com>`; push via
  `git@github.com-personal:klerik3d/gurt.git` (the default identity/SSH key
  has no access).
- macOS Docker Desktop: bind mounts need shared paths (`~/.gurt` fine, `/tmp`
  not); use a unique `GURT_ROOT` per test run.

## 8. Reading order

1. [README.md](../README.md) — model, start sequence, MCP, network, git.
2. [design-orchestration.md](design-orchestration.md) — the intended direction.
3. [requirements-session-roles.md](requirements-session-roles.md)
4. [requirements-turn-contract.md](requirements-turn-contract.md)
5. [requirements-session-queue.md](requirements-session-queue.md),
   [requirements-event-bus.md](requirements-event-bus.md),
   [requirements-kernel.md](requirements-kernel.md)
6. [requirements-manual-review.md](requirements-manual-review.md),
   [requirements-session-operator.md](requirements-session-operator.md)
7. `src/main/kernel.ts`, then `src/main/sessions.ts`.
