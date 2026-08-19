# Requirements: dashboard

Status: implemented · Owner: klerik3d · Target: gurt Electron MVP (this repo)

Key code: `src/shared/usage.ts` (the pure accounting model), `src/main/usage.ts`
(ledger subscriber), `src/main/store.ts` (`usage.jsonl`), `src/shared/events.ts`
(`agent.turn`, `usage.changed`), `src/renderer/src/components/Dashboard.tsx`,
`src/renderer/src/reviewed.ts`. Tests: `scripts/usage.test.mjs`,
`scripts/usage-ledger.test.mjs`, `scripts/plan-usage.test.mjs`,
`scripts/dashboard-groups.test.mjs`.

## 1. Motivation

The activity bar's second tab has been a placeholder. The three questions it
has to answer, in the order a user asks them:

1. **What are my agents costing me, and how close is a limit window to
   biting?** Plan limits (a 5-hour window, a weekly one) are the practical
   constraint on a day's work, and nothing in the app showed them.
2. **What is running right now?** — across every workspace and task, not just
   the one the sidebar happens to be showing.
3. **What finished while I was elsewhere and still needs a human?**

## 2. What the ACP stream can and cannot tell us

The adapters gurt drives (`@agentclientprotocol/*`, see `shared/agents.ts`)
report per-session context usage (ACP `usage_update`) and, sometimes, a cost
figure. **None of them report the provider's remaining plan quota** — which is
why §3 goes outside the protocol for it. Within the ledger, then:

- Nothing derived from the turn stream is ever drawn as "% of limit consumed" —
  that number has exactly one honest source, and it is not this one.
- The ledger draws a published window *shape* filled with gurt's own
  observations: turns run, agent-busy time, sessions touched, and turns the
  provider refused.
- That meter's fill is **elapsed window time**, i.e. how much of the window is
  behind you. It is the fallback shown only for agents with no plan reading;
  where §3 has real utilization, the real utilization replaces it.

A refusal is the one hard signal about the actual limit, and it is treated as
such: `shared/usage.ts` matches the adapter's stop/error text against a set of
limit signatures, files that turn as `limited`, and (when the message carried a
machine-readable reset stamp) keeps it. Those turns are what makes a window
read as an overrun — in the meter, in the history strip, and in the rollups.

Matching is deliberately loose, and seeded with Claude Code's own wording:
"You've hit your session limit" (the 5-hour window), "…your weekly limit",
"…your Opus limit". A limit filed as a plain error is a silent wrong answer; a
plain error drawn as a limit sits next to its own text, one click from the
session that produced it.

Two further limits on what the ledger can mean, both worth stating plainly:

- **The windows are not gurt's.** A subscription's 5-hour and weekly windows are
  shared across models *and* across surfaces — claude.ai, Cowork, and every
  other machine draw on the same allowance. gurt sees only its own turns, so its
  count is a lower bound on what the window actually holds.
- **A better source of *volume* exists and is not wired up yet.**
  `@agentclientprotocol/claude-agent-acp` depends on
  `@anthropic-ai/claude-agent-sdk`, which runs the Claude Code CLI as a child
  process; that CLI has OpenTelemetry instrumentation and inherits the adapter's
  environment (which gurt already sets through `--remote-env`). It exports the
  same metrics under a subscription as under an API key, so turning it on would
  replace this file's proxies with exact per-request token counts
  (`claude_code.token.usage`, split input / output / cacheRead / cacheCreation).

  It would **not** answer "how much is left", and on a subscription its
  `claude_code.cost.usage` is not spend either: Claude Code computes that figure
  locally from token counts at standard list rates, and a subscriber's usage is
  included in the plan. No metric in the set reports plan usage, seat allowance,
  or either window. The only surface that does is the usage endpoint `/usage`
  itself calls — which §3 now reads.

## 3. Plan limits — the provider's own numbers

The dashboard reads the plan's real utilization from `GET /api/oauth/usage` on
`api.anthropic.com`, the call Claude Code's own `/usage` makes to draw its bars.
Key code: `src/shared/planUsage.ts` (parsing), `src/main/planUsage.ts` (polling).

**Provenance.** This endpoint is not part of the published API. The path, the
window keys (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`),
the fields (`utilization`, `resets_at`) and the labels were read out of the
Claude Code binary that `@anthropic-ai/claude-agent-sdk` ships — not guessed.
The request mirrors what that binary makes: `Authorization: Bearer <token>`,
`anthropic-beta: oauth-2025-04-20`, a 5-second timeout.

**Why accept the fragility.** §2 is the argument: the ledger can only ever
count gurt's own turns, and a plan's windows are pooled across every Claude
surface and machine. Utilization from here is the actual number. It supersedes
the derived session window on the card; the ledger keeps the half this endpoint
has no view of — turns, active time, and per-session attribution.

**How it degrades.** Every failure mode resolves to *keep the last good read and
say so*, never to a confident zero:

- **Rate limited (429).** Expected, not exceptional — `/usage` itself falls back
  to last-known bars. Polling is floored at one attempt per agent per minute,
  on *attempts* rather than successes, so a rejected token cannot spin. There is
  deliberately no `refresh()` that bypasses the floor.
- **A 200 in a shape the parser doesn't recognize.** Treated as a shape change,
  not an empty plan: previous windows stay, an error is recorded. The parser is
  structural rather than schema-bound (it finds windows by key at any depth),
  because the exact nesting is the one detail the binary did not yield.
- **An API-key agent.** Skipped outright with a reason — a console key has no
  plan window, and asking would just collect 401s. Gated on the `sk-ant-oat`
  prefix, not attempted-and-caught.
- **Any non-claude-code kind.** Never polled; these windows belong to that plan.

**Unverified detail.** `utilization` is read as a percent (0–100), which is how
it reads in the CLI's string table but could not be confirmed without a live
response. The raw value is kept on every window and shown on hover, so a 0–1
fraction would be visible on the first render rather than silently drawn as 1%.

## 4. The ledger

`~/.gurt/usage.jsonl` — host-wide, not per workspace: the limits it accounts
for belong to the agent's credential, which every workspace shares. One line
per finished `session/prompt` round-trip (`TurnRecord`), append-only.

- **Producer.** `SessionManager.sendTurn` emits `agent.turn` in its `finally`,
  next to the existing `session.turn` ended. The turn-contract nudge is a
  round-trip of its own and is filed like any other — it costs the same quota.
- **Consumer.** `createUsageLedger` (wired in `kernel.ts` beside the
  notifications subscriber) appends, keeps an in-memory copy, and emits
  `usage.changed`.
- **Retention.** 63 days — nine weekly windows, so the eight-bar history strip
  never runs short. Pruned at load, and thereafter only once the ledger has
  drifted a full day past retention, so a busy day doesn't rewrite the file on
  every turn.
- **Lifetime.** Records outlive the session that produced them: deleting a
  session does not delete its turns, because the quota was spent either way.
  Unlike the notification ring, the ledger survives a relaunch — the windows it
  draws span days.

A window is modelled only when gurt can locate its start. The **5-hour session
window** qualifies: it is session-based — it opens with a turn and resets five
hours later — so the first turn not covered by the previous window anchors it
exactly. The **weekly window does not** and is deliberately absent from the
model: a plan's weekly limit resets "at a fixed time each week that is assigned
to your account", unchanged by when you started using Claude, and that anchor is
not derivable from anything gurt observes. Rolling 7 days from the first turn
would drift from the real cycle and report a confidently wrong reset time, so
the dashboard shows a trailing 7-day rollup and says in the tooltip that the
plan's own window is elsewhere.

Everything else gets rollups and an explicit note rather than a guessed window:
`opencode` (per-token API key, no window at all), `codex` (plan windows never
verified against a published source), and anything hand-added to `agents.json`.

## 5. The sections

**AGENTS** — one card per agent *instance* (`agents.json`), plus one per agent
id that only the ledger still knows, marked `removed`: turns of a deleted
instance are spent quota, and dropping them would quietly under-count the
window they landed in. Each card carries, per limit window: the window's
bounds and reset countdown, the meter, turns / active time / context peak /
cost / limit hits, and an eight-window history strip (bar height = turns, red =
a refusal landed there). Below that, 24h and 7d rollups and the last-turn age.

Cost is aggregated as the **rise** of the adapter's cumulative per-session
counter inside the window, not as a sum of samples. Context is aggregated as a
**peak**: it drops on compaction, so summing it would be meaningless.

**SESSIONS** — a board per workspace, three columns wide, keyed to the same dot
grammar as the sidebar (`status.ts`):

| Column | Holds | Ordered by |
|---|---|---|
| `DRAFT / QUEUE` | `queued`, `draft` | queue position, then task and title |
| `IN PROGRESS` | `waiting`, `running`, `starting` | urgency, then task and title |
| `DONE` | `idle`, unreviewed only | newest finish first |

The columns read as a session's own lifecycle left to right: not started yet,
moving, finished. Inside the first column `queued` sits above `draft` despite
the label's order — a queued session is next to run and carries a real
position, a draft has not been launched at all.

`DONE` is bounded by review, not by time: a finished session appears only while
it is unreviewed — it ran a turn this install recorded, and that turn ended
after the session was last opened. Reviewing it is what takes it off the board,
which keeps the column a to-do list rather than an ever-growing archive. A
session that never ran a turn here (restored from an older install, or never
started) is not on the board at all.

Grouping is by **workspace**, and the fold takes the whole band — all three
columns at once — behind the same chevron the sidebar uses, so the gesture
reads the same across the app. Column headers live *inside* each band rather
than once at the top of the section: each workspace is then self-contained,
which is also what keeps the labels attached to their columns when the grid
reflows to fewer columns on a narrow pane. The fold is persisted, which the
sidebar's is not — this pane unmounts on every switch to Work, and a fold that
undoes itself each visit is worse than no fold.

Bands are ordered by urgency, never by size: a workspace leads on the best rank
it holds, so one session waiting on a permission outranks a workspace sitting
on five drafts, and a workspace whose rows have all finished sorts last. Rows
rank across the whole workspace rather than bucketing by task first — a task
boundary in between would push the session that needs you back down its column.
A folded band still reports itself ("1 needs you · 2 running · 1 to review"),
so folding hides detail and never news.

Cards are two lines, because a third of a pane is not enough for one: title on
top; task, state and what the session left behind underneath. The workspace
comes from the band header, so a card carries only its task name, and clicking
that opens the task rather than the session. In `DONE` a card also shows an
`incomplete` tag when the turn contract was violated, the failure when the turn
ended in an error or a limit, and the task's `+n −n` when its clone actually
holds work — the clone's own state being the honest signal, since a session can
end a clean turn and leave nothing to review. `reviewed` per card and `all
reviewed` per column clear rows without opening them.

A running card shows how long it has been in its current turn when that turn
started while the window was open; main does not persist turn starts, and
inventing one would misreport.

## 6. What "reviewed" means

A per-session "seen at" mark in `localStorage` (`src/renderer/src/reviewed.ts`),
set whenever the session is opened — the same act that clears its notifications
(§4.2 of the notifications spec) clears it from this list.

Deliberately renderer-local: it is a property of *this user at this screen*,
not of the session, and nothing in the kernel should start branching on whether
a human has read something. Worst case (a cleared store) re-surfaces finished
sessions for one pass; it is never wrong about the work itself. A session that
has never run a turn this install recorded is simply not part of the list.

## 7. Non-goals

- Acting on a limit: no throttling, no queue-pausing, no model switching when a
  window fills. The dashboard reports; the scheduler is unchanged.
- Per-model or per-token cost breakdown — the adapters report one figure, if
  any, and splitting it would be invention.
- Charts beyond the meter and the history strip; no date-range picker.
- Acting on a session from the dashboard beyond opening it and marking it
  reviewed.
