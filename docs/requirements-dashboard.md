# Requirements: dashboard

Status: implemented · Owner: klerik3d · Target: gurt Electron MVP (this repo)

Key code: `src/shared/usage.ts` (the turn-ledger model), `src/main/usage.ts`
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
why §3 goes outside the protocol for it, and why the agent cards draw *only*
§3's numbers: nothing derived from the turn stream is ever drawn as "% of
limit consumed", and an agent whose provider reports nothing gets no
substitute meter. (An earlier iteration drew the published window shapes
filled with gurt's own turn counts; those read as quota without measuring it,
and were dropped.)

A refusal is the one hard signal about the actual limit, and it is treated as
such: `shared/usage.ts` matches the adapter's stop/error text against a set of
limit signatures, files that turn as `limited`, and (when the message carried a
machine-readable reset stamp) keeps it. Those turns are what marks a finished
session's card on the board as having hit a limit.

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
window keys, the fields and the labels were read out of the Claude Code binary
that `@anthropic-ai/claude-agent-sdk` ships — not guessed — and re-verified
against CLI 2.1.235. Two body shapes exist in the wild and may arrive
together: the keyed form (`five_hour: {utilization, resets_at}`, `seven_day`,
`seven_day_opus`, …) and the listed form (`limits: [{kind, percent, resets_at,
scope: {model: {display_name}}}]`), which is the newer one and the only place
model-scoped weeks ("Current week (Fable)") are reported. The parser reads
both and dedupes by window. The request mirrors what that binary makes:
`Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20`, the CLI's
own `User-Agent` (this path's edge is stricter than the published API's), a
5-second timeout.

**Why accept the fragility.** §2 is the argument: the ledger can only ever
count gurt's own turns, and a plan's windows are pooled across every Claude
surface and machine. Utilization from here is the actual number, and the only
one the card draws.

**Cadence.** Main polls every claude-code instance in the background every 3
minutes (`POLL_INTERVAL_MS`, wired in `ipc.ts` so a kernel built by a test
never inherits the timer) and announces each sweep over `usage.changed`; the
renderer answers with a cache read. The meters are current whether or not the
dashboard is open.

**How it degrades.** Every failure mode resolves to *keep the last good read*,
never a confident zero. The card does not print the failure — it shows the
windows it has, and the read's age turning yellow (past an hour) is what says
the numbers have stopped moving:

- **Rate limited (429).** Expected, not exceptional — `/usage` itself falls back
  to last-known bars, and this edge answers even an *unauthenticated* request
  with 429 rather than 401, so a persistent 429 can also mean the token is not
  being accepted. Polling is floored at one attempt per agent per minute, on
  *attempts* rather than successes, so a rejected token cannot spin; a
  `Retry-After` the response names pushes that agent's next attempt past it.
  There is deliberately no `refresh()` that bypasses the floor.
- **A 200 in a shape the parser doesn't recognize.** Treated as a shape change,
  not an empty plan: previous windows stay, an error is recorded. The parser is
  structural rather than schema-bound (it finds windows by key at any depth),
  because the exact nesting is the one detail the binary did not yield.
- **An API-key agent.** Skipped outright — a console key has no plan window,
  and asking would just collect 401s. Gated on the `sk-ant-oat` prefix, not
  attempted-and-caught. Its card shows no meters at all: per-agent, the
  dashboard shows what that agent's provider reports and nothing in its place.
- **Any non-claude-code kind.** Never polled; these windows belong to that
  plan. When codex (or another kind) grows a usage surface of its own, its
  card gets *that*, on the same principle.

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
  Unlike the notification ring, the ledger survives a relaunch.

What the ledger feeds today: the DONE column (a session appears when its last
recorded turn ended after it was last opened), the failure badges on board
cards (`errored`, `hit a limit`, `incomplete`), and the removed-agent cards of
§5. Its records keep `ctx` and cumulative `cost` for any per-agent view a card
grows later, but no meter is derived from them — see §2.

## 5. The sections

**AGENTS** — one card per agent *instance* (`agents.json`), plus one per agent
id that only the ledger still knows, marked `removed`. Each card shows what
that agent's own provider reports and nothing else. For a claude-code instance
on a subscription that is the plan meters (§3): "Current session" (the 5-hour
window), "Current week (all models)", and any model-specific week the endpoint
reports, each with % used and its reset time in the machine's timezone
("resets 6:30pm" today, "resets Aug 20 at 12am" otherwise — the wording
Claude Code's own `/usage` uses). Under the meters, the timezone and the
read's age. An instance with no such source — an API key, codex, opencode —
shows just its header; no derived numbers stand in.

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
