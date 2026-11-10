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
  > **Superseded in part** by `requirements-review-loop.md`: a review loop's
  > reviewer sessions are a second exception — enabling an executor draft's
  > Review block is the standing approval for them.
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

- `task.json` → `proactive`: `enabled`, `everyMinutes`, `maxPendingScopes`,
  `maxRunMinutes`, `keepRuns`, `templateId` (`ProactiveConfig`, clamped by
  `sanitizeProactiveConfig`, which drops unknown keys — an older build's
  `maxScopesPerRun` goes with the next save);
- the **template**: a draft session of role `proactive` with
  `SessionInfo.template` set. Everything else about the agent (agent
  instance, model, env, repos, MCP servers = its sources, skills, network,
  instructions = the start prompt) is the template's draft config, edited in
  the same Config tab as any draft. A template never runs: `run`, `enqueue`
  and the start path refuse it;
- the run sessions (§3), and `proactive-state.json` (§6).

New agents start switched off, on the workspace's default env (the base
image unless one is set), with auto-allow on and the network internal. An agent cannot be
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
- **A run due while the user's inbox is full is skipped.** If the agent
  already has `maxPendingScopes` scopes waiting for the user (§5) when a run
  falls due, the host starts no session: it records the slot as `skipped`
  ("N scopes waiting for you") and tries again an interval later. Skips in a
  row fold into one history entry and never notify. "Run now" is the user's
  explicit ask and starts regardless.

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
| `list_open({ check? })` | open scopes it raised (title, summary, refs, whether the user has acted), its cursor, how many more scopes it may raise (`limits.canRaise`); with `check`, the status of each ref: `new` or `open` (with its scope) |
| `propose_scope({ title, summary, refs, sessions })` | a scope plus draft sessions (executor / researcher, `create_session`'s fields — repos as `{ name, mode }`). A ref already bound answers with that scope and creates nothing. Refused at the limit (§5) |
| `attach({ scope, refs, note? })` | binds more refs to a raised scope and appends a note |
| `finish_run({ summary, cursor? })` | closes the run, stores the cursor |

There is no "not now" tool: what does not need doing is simply left, and
what the user never wants raised is excluded in the agent's instructions,
which the server instructions tell it to respect.

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
- **Host guarantee: while a scope exists, each of its refs is bound to it
  alone**, across all proactive agents of a workspace. Every identity
  decision runs under a per-workspace lock (Gurt is single-instance, so an
  in-process chain is enough). A retried or concurrent `propose_scope`
  therefore creates one scope; the other caller gets it back.
- **Duplicates by meaning** ("these five mails are one bug") are the agent's
  call: it sees `list_open` and chooses between `propose_scope` and `attach`.
  A miss costs one extra draft, which the user deletes.
- **Whole or nothing.** Every requested session is checked (repo, env, agent)
  before the scope is written. The scope's name is a slug of the title,
  suffixed when taken. If the app dies between the scope and its drafts, the
  next `propose_scope` with one of its refs drafts into it instead of
  answering with an empty scope.
- **One limit.** `maxPendingScopes` caps the scopes of this agent waiting for
  the user (every session still a draft). At the limit a due run is skipped
  by the host (§3.1); during a run `propose_scope` succeeds while fewer are
  waiting and refuses after. Refused, the agent raises nothing more and calls
  `finish_run` **without moving its cursor past the items it could not
  raise**, so the next run sees them again. Attaching is never limited. The
  user makes room by launching or deleting scopes.

## 6. State and volume

`<ws>/<agent>/proactive-state.json`: the cursor, `lastRunAt` and the run
history. The ref index is not stored: it is rebuilt at boot from the scopes'
`origin`. (An older build also kept deferrals and tombstones there; they are
dropped on load.)

- **Deleting a raised scope frees its refs.** Nothing is remembered: a later
  run may raise the same ref again. Recurring noise the user does not want is
  handled where it belongs — an exclusion in the agent's instructions, or a
  filter at the source.

The "1000 Sentry issues every 10 minutes" case: the agent reads only what is
past its cursor, `check`s the refs in one call and skips everything that is
`open`, raises while it may, and when `propose_scope` refuses it finishes
with the cursor left before the rest. While the user's inbox stays full the
host skips the runs outright, so a busy source costs no sessions.

## 7. UI

A fifth activity-bar item, "Proactive agents".

- Sidebar: the workspace's agents, each a container like a scope — dot
  (running / on / off) and interval — with its kept runs nested under it,
  newest first (outcome dot, start time, scopes raised). "+" creates one.
- Clicking an agent opens its pane; clicking a run opens its chat **inside
  the Proactive mode**, in the ordinary session view (the mode does not
  switch to Sessions, whose sidebar does not list the agent). Notifications
  and the Runs list open a run in the same place. The composer stays: talking
  to a finished run is how the user tunes the instructions. Above the
  composer of an ended run one line says its gurt tools are closed (it can
  talk, not raise scopes).
- Agent pane: Turn on/off, Run now, delete; the settings as a phrase —
  "Run every [60] min · at most [10] waiting scopes (now 3/10)" — with run
  timeout and runs kept under a collapsed "Advanced"; the instructions; the
  template's Config tab (role locked to `proactive`); the run history
  (outcome, counts, summary; a kept run opens its chat); the raised scopes
  that still exist, each "waiting for you" or "in progress", paged with "show
  more". Explanations sit behind "i" marks, not caption lines.
- A raised scope's pane starts with "RAISED BY <agent>": title, summary,
  refs, notes.
- Notifications: a run that raised scopes notifies like a proposal; a run that
  timed out or skipped `finish_run` notifies as an error; a run's own turn
  never notifies as `turn-ended`; a skipped slot never notifies.

## 8. Open questions

- Reusing a warm container per agent (one Gurt session, a new ACP session per
  tick) instead of a fresh session per run.
- Cron expressions beside the interval.
- Host-side pollers and events (§3.1): shape, and whether they share the ref
  format.
- Whether exclusions deserve structure beyond the instructions' prose (a
  per-agent list of refs or patterns the user can edit) if prose proves too
  loose for recurring noise.
- The operator: creating and configuring agents needs the template's draft
  config on the admin surface, which the operator does not edit today
  (`requirements-session-operator.md` §2.4); the `proactive*` methods are
  annotated `none` until then.

## 9. Phases

1. **Done:** the agent scope and template, the interval clock, the
   `proactive` role with the §4 tools, drafts only, the mode.
2. Operator access, structured exclusions (if needed), cron.
3. Host-side pollers and event triggers; container reuse.
