# Requirements: session-centric model + deferred sessions + global queue

Status: draft for review · Owner: klerik3d · Target: gurt Electron PoC (this repo)

This document is a work order for an implementing agent. Read `README.md`
first; the current architecture it describes is the starting point. Key
code: `src/shared/types.ts`, `src/shared/agents.ts`, `src/main/{store,provision,sessions,ipc}.ts`,
`src/renderer/src/**`. Do not change the contract described here without
asking the owner.

## 1. Motivation

Today an environment (task × repo container) is bound to one agent, and
sessions live under the env in the sidebar. We want to compare/run several
agents over the same code without cloning per agent, keep the sidebar
simple, and solve concurrent access to one working tree by **serializing
work through a queue** instead of git worktrees (worktrees stay out of
scope).

## 2. Model changes

### 2.1 Session becomes the primary entity

- Session = **(workspace, task, repo, agent, startPrompt, state)** + chat
  history + optional ACP session id.
- Env = clone + devcontainer per **(task, repo)** — infrastructure only. It
  loses its `agent` binding (`EnvState.agent` is removed) and is no longer a
  first-class node in the sidebar tree.
- The container becomes fully agent-agnostic:
  - `devcontainer up` injects only the node feature
    (`ghcr.io/devcontainers/features/node:1`). Per-agent features are
    removed from `AgentDef` (verified: `@agentclientprotocol/claude-agent-acp`
    bundles the Claude Agent SDK — the `claude-code` devcontainer feature is
    NOT needed).
  - Agent adapters are installed lazily: on the first connection of agent X
    in env E, run `npm i -g <adapter packages>` through `devcontainer exec`
    (container already running, this is seconds). Cache "installed" per
    (env, agent) for the app run; a `which <bin>` check is an acceptable
    alternative.
- ACP connections become per **(env, agent)** instead of per env. Adapters
  of different agents coexist in one container, each as its own process.

### 2.2 Session states

```
draft ──(run now / enqueue)──▶ queued ──(scheduler)──▶ starting ──▶ started
  ▲                              │
  └────────── (cancel) ──────────┘
```

- **draft** — has a start prompt, never runs until the user explicitly
  runs or enqueues it.
- **queued** — waiting in the global queue (see §3).
- **starting** — being launched: ensure env (clone / `devcontainer up`,
  reusing a stopped container), ensure adapter, ACP `session/new`, send
  `startPrompt` as the first prompt.
- **started** — a live chat session; everything that exists today applies
  (streaming, permissions, modes, plan, cancel, persistence, lazy
  `session/load` resume after app restart).
- Failures during starting put the session back to **draft** with the error
  shown in its pane (chat history keeps a system entry). It does NOT retry
  automatically and does NOT block the queue.

Creation dialog offers three actions: **Run now**, **Add to queue**,
**Save draft**. A draft's pane offers the same actions plus prompt editing;
a queued session's pane shows the prompt read-only, its queue position, and
**Cancel** (back to draft).

**Run now** bypasses the queue entirely and starts immediately. If another
session is currently working on the same (task, repo), show a confirm
dialog warning that two agents will share one working tree; on confirm,
start anyway (decision: allowed, user's risk).

## 3. Global queue + scheduler

- ONE global FIFO queue for the whole app (all workspaces). Order = enqueue
  time.
- The scheduler walks the queue in FIFO order and starts **every** item
  whose start condition currently holds (items for independent repos may
  start in the same pass; an item that starts occupies its repo immediately,
  so later items for the same repo stay queued).
- Start condition is an extensible predicate per item. **The only condition
  implemented now**: the target (task, repo) is free — its env is not
  `starting`/`running` (equivalently: no session is `starting`/working
  there and the container is down). Design the predicate as a composable
  check so future conditions (global max concurrent agents, priorities,
  time windows) slot in without reshaping the scheduler. Do NOT implement
  those now.
- Scheduler triggers: app start, enqueue, env transition to `stopped` or
  env deletion, and after a `starting` attempt fails. No polling loops.
- "An agent finished" is currently signaled ONLY by its env being stopped
  (manual stop today; auto-stop policies are future work). Document this in
  the UI (e.g. tooltip on the queued badge).
- The queue is persisted (survives app restart): derive it from session
  records (`state: "queued"` + `queuedAt` timestamp). On app start the
  scheduler runs once after sessions are restored.

## 4. Persistence

`<ws>/<task>/sessions.json` records gain:

- `agent` (already present in `SessionInfo`)
- `state`: `"draft" | "queued" | "started"` (`starting` is runtime-only; a
  crash mid-start restores as `draft`)
- `startPrompt`: string
- `queuedAt`: ISO timestamp, present while queued

Migration: existing records without `state` are treated as `started`.
`task.json` env records: drop `agent` (ignore if present).

## 5. UI

- **Sidebar tree: `workspace → task → sessions`.** A session row shows:
  status mark (draft ✎ / queued ⏳ / starting ◐ / live ●), title, and chips
  `(repo)` `(agent)`. Envs disappear from the tree.
- **Task node click → task pane** (replaces today's env pane) with:
  - environments table: repo, container status, Start/Stop/Delete buttons,
    provisioning log (the existing `provision-log` stream keyed per env);
  - the task's queued sessions in order (global positions), each with
    Cancel.
- **"+" on a task → new session dialog**: repo select, agent select
  (enabled agents only), start prompt textarea, three action buttons (§2.2).
  This replaces the separate "add env" flow — envs are created implicitly.
- **Session pane**: for `started` — the existing chat; for `draft`/`queued`
  — prompt (editable only in draft) + actions; for `starting` — read-only
  prompt + streaming provisioning/launch log.
- Workspace-level "repos" modal and ⚙ Agents stay as they are.
- Delete: sessions become deletable (any state; confirm for `started`).
  Deleting an env from the task pane keeps its sessions (they resume by
  re-provisioning on next start… NOT: they simply can be Run again — a
  started session whose container is gone shows the existing "could not
  resume" path). Deleting a task still removes everything.

## 6. Non-goals (explicitly out of scope)

- git worktrees / per-session branches
- auto-stopping an env when the agent's turn ends
- queue reordering and priorities, global concurrency limits
- forwarding host agent auth (`~/.claude`, `~/.codex`) into containers

## 7. Acceptance

1. Create sessions in all three modes; draft never starts by itself;
   queued sessions for a free repo start immediately; two queued sessions
   for the same repo run strictly one after another — the second starts
   only after the first env is stopped manually.
2. Two agents (e.g. claude + codex) can hold `started` sessions in ONE
   container (created via Run now + confirm), each talking to its own
   adapter process.
3. `devcontainer up` no longer injects agent features; first session of an
   agent in an env installs its adapter; second session of the same agent
   does not reinstall.
4. Queue and drafts survive app restart; scheduler resumes correctly.
5. Existing behavior intact: persistence/resume, permissions, modes, plan,
   commands, cancel, repo CRUD, env stop/delete from the task pane, task
   delete.

## 8. Verification

Extend the Playwright smoke suite (`archive/smokes/*.mjs` show the pattern;
run against `npm run build` output). Mind the gotchas from README:
`ELECTRON_RUN_AS_NODE` must be stripped, `GURT_ROOT` must be unique per run
(Docker Desktop stale-cache bug), roots must live under `/Users`. Without
agent secrets the chat error `Authentication required` (claude: at prompt;
codex: at session/new) still proves the pipe. A queue smoke can avoid
providing secrets entirely: use claude sessions whose start prompt fails
auth — state transitions and serialization are still observable.
