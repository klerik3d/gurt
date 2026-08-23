# Requirements: one container per session

Status: implemented · Owner: klerik3d · Target: gurt Electron MVP (this repo)

Key code: `src/main/containers.ts`, `src/main/sessions.ts`,
`src/main/kernel.ts`, `src/main/store.ts`, `src/shared/types.ts`,
`src/shared/keys.ts`.

Supersedes the container-ownership model of
`requirements-env-repo-split.md` (§ env instances, start gate) and the key
inventory of `requirements-stable-keys.md`. Those documents describe the
env-instance model this one replaces; the parts of them not about container
ownership still hold.

## 1. Motivation

A container used to belong to an *env instance* — one slot per `(task, env)`,
recorded in `task.json` and reused by successive sessions. A session claimed the
slot, and the next session tore down the "leftover" container to take it.

Everything derived from a container, though, was keyed by the env's *name*:
the ACP adapter (`connKey = ws/task/env::agent`), the installed-adapter flag,
the git shims, the broker, the MCP servers. Names outlive containers. So each
of the seven teardown paths had to remember, by hand, to invalidate each of
those caches, and each remembered a different subset — replacing a container
left a live adapter process wired to a container that no longer existed. The
resulting failure was `start failed: agent process exited` with no diagnostic:
`session/new` went to a dead `devcontainer exec` pipe.

The bug is not the missing invalidation. It is that a logical key was used to
address a physical resource.

## 2. Decisions

- **A container belongs to exactly one session, 1:1.** It is created at that
  session's first start, stopped when the session goes idle, and destroyed with
  the session. It is never shared with, inherited by, or handed over to another
  session. `SessionContainer` is a field of `SessionInfo`, persisted and deleted
  with it; `TaskFile.envs` is gone and `task.json` is only the task marker.

- **An env is a definition, not an instance.** `workspace.envs` says which
  devcontainer.json to build. Any number of sessions may run the same env at
  once, each owning its own container. `EnvRef` addresses no infrastructure.

- **Container-derived state is keyed by container id.** The installed-adapter
  set and the git-shim set (`containers.ts`) key on the id Docker minted; the
  ACP `Connection` records the container it was spawned into and is reused only
  while that id still matches. Ids are never reused, so a record keyed by one
  cannot address the container that replaced it — stale reuse is
  unrepresentable, not merely avoided. Host services that serve one container
  (git broker, MCP servers, the `gurt` server) key by session id.

- **One teardown path.** `ContainerManager.teardown(session, 'stop' | 'remove')`
  is the only way a container comes down. It calls `deps.detach(session)` first
  — killing the ACP adapter and the session's MCP servers — then `forget`s the
  container-keyed caches, then stops or removes. `stop` keeps the filesystem
  (the session resumes into the same container, install caches still valid);
  `remove` drops the record entirely.

- **The clone is the thing that must not overlap.** `<task>/<repo>` is one
  working tree shared by every session of the task that picked that repo, and it
  outlives all of them (it holds their uncommitted work). So a repo is exclusive
  across the task: `SessionManager.repoHolder` returns the session holding it,
  where holding means *mid-start, or owning a container that is provisioning
  (`building`/`post`) or running*. An idle session whose container auto-stopped holds nothing and
  releases the repo for the next session — which is how a task runs a series of
  sessions against one repo without deleting the finished ones.

  The env is **not** a gate predicate. The check runs on start *and* on resume:
  waking a session brings its container back up on the shared clone, so an
  ungated resume could put two live containers on one working tree.

- **Docker is the registry.** Containers carry `gurt.session=<session id>` (they
  always did — only the bookkeeping was env-scoped). `ContainerManager.reconcile`
  runs at boot: a record describing a container the daemon no longer has is
  dropped, a stale `running` is corrected, and a container whose session is gone
  is removed. `dockerSessionContainers` returns `null` — not an empty map — when
  the daemon cannot be reached, so "could not ask" never reads as "there are
  none" and wipes every record.

- **A half-provisioned container is never adopted.** The devcontainer CLI runs
  the create-time hooks (`onCreate`/`updateContent`/`postCreateCommand`) only
  when it creates the container. One that fails — a flaky `npm install` is the
  common one — leaves a container behind, and the next `up` finds it by
  id-label, skips those hooks as already run and reports success: the session
  starts against a workspace whose install never finished, and the user reads it
  as "it works on the second try". So `devcontainerUp` removes the container a
  failed create-time hook leaves, retries once in a fresh one (the fault is
  usually a transient registry error), and otherwise fails naming the hook and
  quoting its output — the CLI's own message is only the shell line it ran
  (`Command failed: /bin/sh -c npm install`). For the same reason `ensure`
  removes any container carrying the session's id-label that its record cannot
  name before calling `up`: a start killed mid-hook (app quit, machine slept)
  leaves exactly such a container, and it is a rebuild, not an inheritance.

- **Idle auto-stop is per session** (`ContainerManager.noteIdle`), not per env.
  A container coming down re-runs the scheduler: its clone may now be free.
- **The queue overrides the grace period** (`kernel.ts`'s queue handoff, over
  `SessionManager.holdersBlockingQueue`). An idle container whose clone a queued
  session needs is stopped at once (`reason: queue`) rather than after the grace
  period — otherwise the scheduler, which only advances on a container coming
  down, would stall the queue for the whole ten minutes. Triggers are the same
  idle transitions (turn end, awaiting cleared, adapter exit, failed start),
  plus enqueue and the boot restore. Nothing mid-turn or mid-start is ever
  reaped, and an empty queue leaves the policy exactly as it was. A stop that
  fails re-arms the grace period it was cutting short — the handoff degrades to
  the old timing, never to a queue waiting on a container nothing will retry.

## 3. Non-goals

- Sharing one container between sessions, for any reason.
- Concurrent sessions on one clone (a worktree-per-session model would be the
  way to get that; it is not this change).
- Reviving `EnvState` as a persisted entity.

## 4. Migration

`readSessions` folds legacy `task.json` env records onto the session named by
`EnvState.session` — that binding already existed, it was just stored on the
wrong entity — then writes `task.json` as `{}`. A record naming no live session
describes a container nobody can claim: it is dropped, and the boot reconcile
removes the container. Clones are no longer recorded at all; `store.taskClones`
discovers them on disk, since the directory *is* the fact.

## 5. Acceptance

1. Starting a second session in a task whose previous session has finished
   succeeds — the original failure of this document's §1.
2. `node scripts/session-repo-gate.test.mjs` passes: a repo is exclusive, an env
   is not, an auto-stopped session releases its repo, and the queue advances
   when it does.
3. `node scripts/env-split-migration.test.mjs` passes: legacy container records
   land on their owning session, orphans are dropped, write-back happens once.
4. `node scripts/provision-hook-retry.test.mjs` passes: a create-time hook that
   fails once is retried in a *fresh* container (the failed one is removed, not
   adopted), one that keeps failing fails the start with the hook named and its
   output quoted, and any other failure is untouched — one attempt, the CLI's
   own message, nothing removed.
5. The rest of `scripts/*.test.mjs` still passes; `npm run typecheck` and
   `npm run build` are clean.
6. No entity key outside `keys.ts`, and nothing container-bound keyed by a name:
   `grep -rn 'envKey\|connKey' src` returns nothing.
