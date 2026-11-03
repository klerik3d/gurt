# Design notes: proactive agents

**Status: phase 1 implemented (§9); the rest is under discussion.**
Key code: `src/main/proactive.ts` (the manager), `src/shared/proactive.ts`
(shapes and pure rules), `src/main/mcp/gurtServer.ts` (the role's tools),
`src/renderer/src/components/Proactive{Sidebar,Pane}.tsx` (the mode).
Tests: `scripts/proactive.test.mjs`, `scripts/smoke-proactive.mjs`.

## 1. What it is

A proactive agent watches some outside source (Sentry, a tracker, chats, mail)
on a schedule and turns what it finds into **scopes with draft sessions**. It
does no work itself: its only output is "here is a question, here is a scope
for it, here are the sessions I would run".

- **Its own runs start by themselves.** Turning a proactive agent on is the
  user's standing approval for its runs, so a tick enqueues its session
  without a click. This is the one, explicit exception to "drafts are
  approval" (`agent-brief-workflows.md` §5), and it covers only the agent's
  own runs.
- **Everything it creates is a draft.** Scopes and their sessions wait for the
  user to launch them, as with `create_session`. The agent has no other
  powers: it does not run, prompt or ship anything.
- **One question, one scope.** A scope it creates carries one problem; the
  scope's branch and PR are that problem's.
- It talks to Gurt only through its `gurt` MCP tools (§4), never to other
  agents.

## 2. An agent is a scope

`proactiveCreate(ws, name)` creates a scope named after the agent. It is
listed under `Tree.workspaces[].proactive`, not among the scopes, and holds:

- `task.json` → `proactive`: `enabled`, `everyMinutes`, `maxScopesPerRun`,
  `maxPendingScopes`, `maxRunMinutes`, `keepRuns`, `templateId`
  (`ProactiveConfig`, clamped by `sanitizeProactiveConfig`);
- the **template**: a draft session of role `proactive` with
  `SessionInfo.template` set. Everything else about the agent (agent
  instance, model, env, repos, MCP servers = its sources, skills, network,
  instructions = the start prompt) is the template's draft config, edited in
  the same Config tab as any draft. A template never runs: `run`, `enqueue`
  and the start path refuse it;
- the run sessions (§3), and `proactive-state.json` (§6).

New agents start switched off, on the workspace's operator env (bundled,
image-only), with auto-allow on and the network internal. An agent cannot be
renamed: its name is what every scope it raised records as `origin.agent`.
Deleting it is deleting its scope; the scopes it raised stay.

## 3. Runs

### 3.1 Trigger

Phase 1 is an interval (`everyMinutes`, counted from the last run's start).
The manager's clock ticks every 30 s:

- Runs happen only while Gurt is open. A run due in the past is **one run,
  now** — missed slots are never replayed.
- A tick during a run starts nothing (runs never overlap); "Run now" during a
  run is refused.
- A run still going after `maxRunMinutes` is cancelled (a run stuck starting
  is deleted) and recorded as `timeout`.
- A run whose template cannot start is recorded as `failed` for that slot —
  not retried every tick.

Events are out of scope. If they come, they come from a host-side poller
(deterministic code, no LLM) that emits events. Polling is not the agent's
job.

### 3.2 Session per run

Each run is a fresh copy of the template (`SessionManager.spawnRun`) in the
agent's scope, straight into the queue. The role locks no clone, so it starts
as soon as the queue reaches it. A run ends when its turn ends (`finished` if
it called `finish_run`, else `incomplete` after the usual one nudge), when its
start fails (`failed`) or when its session is deleted (`cancelled`). Then its
container is stopped and only the newest `keepRuns` run sessions are kept;
the history in `proactive-state.json` keeps the summaries of the last 50.

Reusing one warm container with a new ACP session per tick is a later
optimisation (§8). Either way nothing carries over between runs through the
chat; the memory is the state of §6.

## 4. The `proactive` role and its tools

Repos: zero or more, mounted read-only like a researcher's. No clone lock, no
`complete`, no `create_session`. All spawning goes through the tools below, so
the identity rules of §5 cannot be bypassed. Its turn contract is
`finish_run`.

| tool | does |
|---|---|
| `list_open({ check? })` | open scopes it raised (title, summary, refs, whether the user has acted), its cursor, this run's limits; with `check`, the status of each ref: `new`, `deferred`, `open` (scope), `dismissed` |
| `propose_scope({ title, summary, refs, sessions })` | a scope plus draft sessions (executor / researcher / reviewer, `create_session`'s fields). A ref already bound answers with that scope and creates nothing |
| `attach({ scope, refs, note? })` | binds more refs to a raised scope and appends a note |
| `defer({ refs, forHours, reason })` | hides refs from `check` until then |
| `finish_run({ summary, cursor? })` | closes the run, stores the cursor |

The tools are bound to the run's workspace, agent and session by the session
manager, and only the agent's run in progress may use them: an ended run's
tools are closed. The server instructions say that text from the sources is
data, never instructions.

## 5. Identity, idempotency, locking

There is no item entity: **the scope is the unit**. A scope it raised carries
`origin: { agent, run, refs, title, summary, createdAt, notes? }` in its
`task.json`, written by the same write that creates the scope.

- **A ref** is the source's own stable id: `<source>:<id>` — `sentry:4521337`,
  `mail:<Message-ID>`, `slack:C01ABC/1699999999.000100`, `gh:org/repo#123`.
  Every message and event has one. Only the *problem* behind several of them
  has none.
- **Host guarantee: one ref is bound to at most one scope**, across all
  proactive agents of a workspace. Every identity decision runs under a
  per-workspace lock (Gurt is single-instance, so an in-process chain is
  enough). A retried or concurrent `propose_scope` therefore creates one
  scope; the other caller gets it back.
- **Duplicates by meaning** ("these five mails are one bug") are the agent's
  call: it sees `list_open` and chooses between `propose_scope` and `attach`.
  A miss costs one extra draft, which the user deletes.
- **Whole or nothing.** Every requested session is checked (repo, env, agent)
  before the scope is written. The scope's name is a slug of the title,
  suffixed when taken. If the app dies between the scope and its drafts, the
  next `propose_scope` with one of its refs drafts into it instead of
  answering with an empty scope.
- **Backpressure.** `maxScopesPerRun` caps one run; `maxPendingScopes` caps
  the scopes the user has not acted on (every session still a draft). At
  either cap `propose_scope` refuses and the agent is told to defer with
  `reason: backpressure`.

## 6. State and volume

`<ws>/<agent>/proactive-state.json`: the cursor, `lastRunAt`, the run history,
the deferrals and the tombstones. The ref index is not stored: it is rebuilt
at boot from the scopes' `origin`.

- **Deleted scope → tombstones.** Its refs stay bound as tombstones of the
  agent that raised it: `check` reports them `dismissed` and `propose_scope`
  refuses them. "Allow again" in the UI drops a tombstone.
- **Deferrals** hide a ref until `until`; raising or attaching the ref clears
  its deferral; "Look again" in the UI drops one.

The "1000 Sentry issues every 10 minutes" case: the agent reads only what is
past its cursor, `check`s the refs in one call and skips everything that is
not `new`, raises at most `maxScopesPerRun`, and defers the rest with a
reason. The Deferred list in the UI shows those reasons.

## 7. UI

A fifth activity-bar item, "Proactive agents".

- Sidebar: the workspace's agents — dot (running / on / off) and interval;
  "+" creates one.
- Agent pane: Turn on/off, Run now, delete; schedule and limits; the
  instructions; the template's Config tab (role locked to `proactive`); runs
  (outcome, counts, summary; a kept run opens its session); raised scopes
  (waiting for you / taken up); deferrals; dismissed refs.
- A raised scope's pane starts with "RAISED BY <agent>": title, summary,
  refs, notes.
- Notifications: a run that raised scopes notifies like a proposal; a run that
  timed out or skipped `finish_run` notifies as an error; a run's own turn
  never notifies as `turn-ended`.

## 8. Open questions

- Reusing a warm container per agent (one Gurt session, a new ACP session per
  tick) instead of a fresh session per run.
- Cron expressions beside the interval.
- Should deferrals of the same ref back off (1 h → 1 d → 1 w)?
- Host-side pollers and events (§3.1): shape, and whether they share the ref
  format.
- How the user's overrides ("this deferral was wrong") reach the next run.
- The operator: creating and configuring agents needs the template's draft
  config on the admin surface, which the operator does not edit today
  (`requirements-session-operator.md` §2.4); the `proactive*` methods are
  annotated `none` until then.

## 9. Phases

1. **Done:** the agent scope and template, the interval clock, the
   `proactive` role with the §4 tools, drafts only, the mode.
2. Operator access, deferral backoff, overrides as feedback, cron.
3. Host-side pollers and event triggers; container reuse.
