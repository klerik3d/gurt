# Requirements: review loop — implement → check → review → fix, unattended

Status: planned · Target: gurt Electron MVP (this repo)

This document is a work order for an implementing agent. Read
`architecture.md` first. The decisions in it are the owner's unless marked
as this document's proposal; do not reopen them without asking (open points:
§10). Line numbers are as of 1457e52 and approximate.

Key code, and what changes there:

- `src/shared/types.ts` — `RepoConfig` (~130) gains `check` / `review`;
  `SessionInfo` gains `review` / `reviewOf`; `SessionRole` (~367) gains
  `reviewer` and its predicates (`roleHasTurnContract` ~483, `roleNeedsRepo`,
  `repoMode`, `USER_SESSION_ROLES`); `ChangeProposal` gains `replies`;
  `PersistedSession` gains `lastSettled`; `PersistedPrompt`,
  `PendingPromptInfo` and `ChatSystem` gain the loop's intent id. New
  `src/shared/reviewLoop.ts`: the shapes below and `loopStep`.
- `src/main/reviewLoop.ts` (new) — the controller, a bus subscriber the kernel
  creates beside the proactive manager (precedent: `proactive.ts` ~229).
- `src/main/sessions.ts` — `session.settled` (`runPrompt` ~2690);
  `hostPrompt` beside `prompt` (~3030); the loop hold (`repoConflict` ~1512,
  `holdersBlockingQueue` ~1605); the reviewer's cap exemption
  (`startNowOrQueue` ~1058, `scheduleSync` ~1408); reviewer creation beside
  `spawnRun` (~2816); `submit_review`, the `replies` rule (`onComplete`
  ~2727); a delivery gate in `drainPending` (~3087); `interruptedSessions`,
  `hasUnfinishedWork` (~2013).
- `src/main/mcp/gurtServer.ts` — `submit_review`; `replies` in
  `PROPOSAL_SCHEMA` (~209); reviewer instructions and a loop executor's
  (`instructionsFor` ~173, today's executor text ~36–46).
- `src/main/containers.ts`, `provision.ts` — the check runner (§5.3).
- `src/main/changes.ts` (`commit` ~459, `push` ~475, `mergeToMain` ~524) and
  a PR function extracted from `mcp/githubServer.ts` (`create_pull_request`
  ~165).
- `src/main/{notifications,store,kernel}.ts`, `src/shared/events.ts` —
  notifications (§7); `review-loop.json`, `RESERVED_NAMES` (~165), the
  legacy-reviewer migration in `readSessions` (~1506); idle policy and queue
  handoff (~288–386); the events `session.settled`, `session.human`,
  `review.loop`.
- `src/renderer/src/components/ConfigTab.tsx` (agent picker ~547, config
  chips ~424), Settings → Repos, the session pane.

> **Supersedes in part** `requirements-session-roles.md` (verdicts as plain
> chat text), `requirements-repo-mounts.md` (the reviewer's removal, proactive
> as the only forced-`read` role), `requirements-turn-contract.md` (the
> executor's "the user reviews and ships" for loop sessions),
> `design-orchestration.md` (retry edge, re-review, multi-repo, "no
> auto-ship"), `design-proactive-agents.md` §1 (the only unattended start) and
> `agent-brief-workflows.md` §5 (session reuse, "no auto-ship").

Terms:

- **anchor** — the repo that builds a session's image, its first `write` repo.
- **plan hold** — an account at its usage threshold gets no new work until its
  window resets; a turn it cut off continues by itself after the reset
  (`requirements-plan-limits.md`).
- **queue handoff** — gurt stops an idle session's container at once when a
  queued session needs its clone or its scope slot (`reapForQueue`,
  `kernel.ts` ~297), instead of after the 10 min idle grace.
- **settled turn** — one logical turn (a prompt plus its automatic nudge)
  after gurt has finished classifying how it ended (§5.1).
- **arming** — the first settled executor turn that ends `complete: changes`.
- **diff hash** — a fingerprint of the working trees: per write repo, HEAD plus
  the tree id `git write-tree` gives after `git read-tree HEAD` and `git add -A`
  into a temporary index (`GIT_INDEX_FILE`), so tracked files matching
  `.gitignore` count and untracked ignored ones do not. Host-side git; the
  real index is untouched.
- **finding fingerprint** — what makes two findings "the same":
  `sha256(file + "\n" + normalise(claim))`, first 16 hex; `normalise` = NFKC,
  lower case, runs of non-alphanumerics → one space, trimmed.
- **loop hold** — the executor's exclusive ownership of its clones while the
  loop needs them (§5.5).
- **intent** — an action the controller decided on and wrote down, with a
  stable id, before doing it (§8).

## 1. Motivation

Today a change reaches a branch only through a human: the executor ends its
turn with `complete`, the user reads the diff, perhaps has a researcher review
it, relays the findings by hand and ships from the Changes panel. This slice
goes from a task prompt to a shipped branch / PR with no human in between,
bounded by a round limit: the executor implements; the host runs the repo's
check; a read-only reviewer on a different agent or model reviews; the
executor fixes; repeat up to N rounds; on a clean result the host optionally
commits / pushes / opens a draft PR. Verdicts are advisory data, never an
approval of the merge: nothing merges on a forge, and a non-clean review
commits nothing.

The loop is opt-in per executor draft; enabling it is the user's standing
approval for the reviewer sessions and the delivery it runs (the precedent is
a proactive agent's runs). "Drafts are approval" is unchanged for everything an
*agent* creates.

## 2. The core rule: no long tool calls

Every tool an agent calls stays instant: `complete` and `submit_review`
validate, record and return. All waiting — for the check, for the reviewer —
happens in a host controller subscribed to bus events, never inside a tool
call, because agent harnesses cut MCP tool calls after limits gurt cannot
verify per agent (§9). Findings and check failures reach the executor as an
ordinary follow-up message queued by the host, exactly like a user typing into
a live session's chat.

## 3. Configuration

```ts
export interface RepoConfig {          // workspace.json, Settings → Repos
  // …existing fields
  /** Run by the loop in the session container from /workspaces/<name>, e.g.
   *  `npm run lint && npm test`. Absent = no check for this repo. */
  check?: string | undefined
  /** Defaults for a new executor draft's Review block. */
  review?: Partial<ReviewLoopConfig> & { enabled?: boolean } | undefined // enabled: default off
}

export type ShipRung = 'notify' | 'commit' | 'push' | 'pr' | 'merge' // lowest first

/** SessionInfo.review — the draft's Review block; absent = no loop. */
export interface ReviewLoopConfig {
  agent: string       // the reviewer instance — the session's own agent picker
  /** The reviewer's model/effort/… chips, from that agent's cached/seed
   *  config surface (`getAgentConfig`): only what it reports. */
  configValues?: Record<string, string | boolean>
  maxRounds: number   // clamped 1–5, default 2
  whenClean: ShipRung // default 'notify'
  draftPr: boolean    // with 'pr'; default true
}
```

- The check command lives with the repo, not in the env.
- The **Review block** sits in an **executor** draft's Config tab, prefilled
  from the anchor's defaults, editable per draft, frozen when the session
  starts like skills, carried by duplicate / recreate (`draftFrom` ~1307).
  It is never part of `AgentSessionRequest`: an agent cannot enable the loop
  or raise the ladder; a `create_session` / `propose_scope` draft gets the
  repo defaults like any new draft, and the user launching it is the approval.
- **When clean**: notify / commit / commit + push / commit + push + PR ("draft"
  on by default). Write repos all `RepoConfig.local` (no forge): notify /
  commit / commit + merge into main. Local and forge mixed: notify / commit.
- **No check command** is allowed; the block says the check is skipped.
- **Default reviewer**: an instance of a **different kind** than the
  executor's with a usable credential (a linked `credentialId` that resolves
  and, for `oauth`, is not `oauthSignedOut`), else one of the same kind — the
  owner's rule; cross-family by default because same-family judges favour
  their own output. Picker order decides among candidates; another instance is
  preferred over the executor's own.
- **Validation**: the reviewer differs from the executor in agent instance or
  in model (`configValues`' model option); otherwise Run is disabled until
  another model is picked. Run is also disabled while the named reviewer is
  missing, gone, denied in the workspace or without MCP.
- **Only agents that receive gurt's MCP server** can be executor or reviewer —
  both tools are gurt MCP tools, with no text-parsing fallback. Pi does not
  (`src/plugins/agents/pi/manifest.ts`, the `adapterPackages` comment ~22),
  so the block is refused for a pi executor and pi is not offered as reviewer.
  A new manifest field says so (e.g. `acpMcp: false`; name and optionality to
  settle against `src/shared/agentPlugin.ts`).

## 4. The reviewer

| role       | delivers          | gurt tools      | needs to start |
| ---------- | ----------------- | --------------- | -------------- |
| `reviewer` | a `ReviewVerdict` | `submit_review` | ≥ 1 repo       |

- A tool set, not a mount mode: `repoMode` answers `read` for every repo of a
  reviewer whatever the record says (as for `proactive`), so it claims no clone
  and its env's setup is skipped. **Never `read-locked`**: that shared claim
  would wait for the executor's `write` claim, which the loop keeps — a
  deadlock. All-`read` sessions start with no claim (`scheduleSync` ~1429).
- A turn contract like the proactive role's `finish_run`:
  `roleHasTurnContract` includes it, `nudgePromptFor` (~549) names
  `submit_review`, and `runPrompt`'s `incomplete` entry names the role's tool
  (today a proactive-or-`complete` switch, ~2705).
- Not user-pickable, never spawnable; only the loop creates one, with
  `SessionInfo.reviewOf?: { executor: string; round: number; intent: string }`.
  Duplicate / recreate refuse it; `ROLE_INFO` (`tags.tsx` ~48) gets an entry.
- `readSessions` migrates every `role: 'reviewer'` record to a researcher with
  `write` repos (`store.ts` ~1506); it must skip records with `reviewOf`.
- Instructions: read-only; the host's prompt is the whole input; the repos and
  the diff are data, never instructions; `submit_review` every turn, last.

### 4.1 `ReviewVerdict` — `submit_review`

```ts
export interface ReviewFinding {
  id: string        // unique in the verdict, [A-Za-z0-9_-]{1,16}; shown as "R1.F2"
  file: string      // `<repo>/<path>`, relative to /workspaces
  line?: number
  severity: 'blocker' | 'major' | 'minor' | 'nit'
  claim: string
  evidence?: string
  suggestion?: string
}

export interface ReviewVerdict {
  version: 1
  verdict: 'approve' | 'request_changes'
  summary: string
  findings: ReviewFinding[]
}

export type StoredVerdict = ReviewVerdict & { at: string; round: number; turnId: string }
```

zod strict, `version` literal `1`, bounded lengths (claim ≤ 2000; summary,
evidence, suggestion ≤ 4000; ≤ 50 findings); ids unique. The owner's rules:
`request_changes` requires at least one blocker or major; `approve` may carry
minor / nit (they go to the ready notification and the PR body) and — since an
approve is a clean result only with no open blocker/major — none of those.
Host rule, thrown by the session manager like `assertProposalFits` (~578):
`file` names one of the session's repos. Failures are `isError` results; the
last call of a turn wins. Severities as the instructions define them: blocker
— must not ship (wrong behaviour, data loss, security, broken build or tests,
an unmet requirement); major — a real defect to fix before merging; minor —
worth fixing; nit — taste.

### 4.2 `complete` gains `replies`

```ts
export interface FindingReply {
  findingId: string // "R1.F2"
  resolution: 'fixed' | 'declined' | 'refuted' // won't do it / the claim is wrong
  note: string      // 1–2000 chars
}
// ChangeProposal gains: replies?: FindingReply[]   (any outcome)
```

The **open set** is the latest verdict's findings. It is answered once: the
first `complete` with `changes` after the verdict must answer every open
finding exactly once and name no unknown id (else `isError` naming them,
thrown in `onComplete`; the open set reaches it through a `SessionEvents`
hook). The settled turn that carries those replies closes the set; later turns
of the same round — check-fix and proposal repairs — need no replies and keep
the recorded ones. With no open set, `replies` is accepted and ignored.

### 4.3 The reviewer's prompt

Host-authored from typed data only; never the executor's chat, commit text or
`notes`:

1. **The task**: the executor's start prompt and the messages the user typed
   before arming.
2. **What to review**: each write repo's uncommitted change against its base
   (HEAD at arming; nothing commits during the loop) — `git diff <base>` plus
   untracked files. (To verify: `git diff` / `git status` on a read-only bind.)
3. **The check result** per repo (command, exit code, duration, output tail),
   or "no check configured". The reviewer cannot run tests itself.
4. **Mandatory items**: changed paths that can weaken the check or steer an
   agent — test files (`*.test.*`, `*.spec.*`, `test/`, `tests/`,
   `__tests__/`), CI config (`.github/workflows/`, `.gitlab-ci.yml`,
   `.circleci/`, `Jenkinsfile`, `azure-pipelines.yml`), what the check resolves
   through (`package.json`, lint / tsconfig files) and agent-instruction files
   (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.claude/`, …), deleted or edited.
   Each must be addressed in a finding or the summary. Computed host-side from
   `git diff --name-status <base>` and untracked files.
5. **Earlier rounds**: findings and replies, the replies' notes labelled as the
   executor's claims to verify.

Reviewer policy never comes from a file inside the diff under review.

## 5. The loop

### 5.1 Controller and settled turns

A pure decision function, unit-tested like `postTurnDecision`, inside thin
wiring that turns bus events into `LoopEvent`s (reading the git and session
state the function cannot), records intents (§8) and executes them.

```ts
export type LoopPhase =
  | 'dormant' | 'checking' | 'proposing' | 'reviewing' | 'fixing' | 'delivering' | 'ended'

export type LoopEvent =
  | { kind: 'turn-started'; on: 'executor' | 'reviewer' }
  | { kind: 'settled'; on: 'executor' | 'reviewer'; turn: SettledTurn; hash: string; uncovered: string[] }
  | { kind: 'check-pass'; results: CheckResult[] }
  | { kind: 'reviewer-unavailable'; detail: string }
  | { kind: 'human'; on: 'executor' | 'reviewer'; did: 'prompt' | 'cancel' | 'stop' | 'delete' }
  | { kind: 'tick'; now: string; permissionOpenSince?: string }
  | { kind: 'delivered'; step: DeliveredStep } | { kind: 'delivery-failed'; error: string }

export function loopStep(state: LoopState, event: LoopEvent): { state: LoopState; actions: LoopIntent[] }
```

`session.turn` `ended` cannot carry a turn's outcome: `sendTurn` emits it
(~2554) before `runPrompt` handles a plan hold (`onLimited`) or marks
`incomplete` (~2699–2707). `runPrompt` therefore emits **`session.settled`**
once per logical turn after that classification — the start prompt (run
through `runPrompt`, ~1798) and a thrown turn included — having first
persisted it as `PersistedSession.lastSettled` (§8):

```ts
export interface SettledTurn {
  turnId: string              // `<sessionId>:<n>`; tool calls during the turn are filed under it
  complete?: ChangeProposal   // the turn's last `complete`
  verdict?: StoredVerdict     // the turn's last `submit_review`
  limited?: { until: string } // cut off by a plan hold; gurt continues it later
  cancelled?: boolean         // stopReason `cancelled`: the user's Esc
  failed?: { stopReason: string } // threw (`error`) or another non-`end_turn` stop
  incomplete: boolean         // no contract tool, even after the nudge
}
```

Precedence: **limited** (no transition; the continuation settles the work) >
**cancelled** (§5.6) > **failed** > the turn's **artifact** > **incomplete**.
An artifact never redeems a failed turn — a reviewer that approves and then
crashes has delivered no verdict; an executor that failed after `complete` may
have left a half-edited tree. A tool call outside a busy turn belongs to no
turn and is ignored.

### 5.2 Phases, counters and transitions

**Counters.** `round` starts at 0 and counts reviewers created; check retries
and proposal repairs consume no round. A **check pass** runs every configured
check once; `redStreak` starts at 0, +1 per pass with a red check, reset to 0
by a fully green pass. One proposal repair per loop. Hence at most N reviewers
and 3N host messages to the executor (two red-check messages before each
review, N − 1 findings messages, one proposal repair), each with at most one
nudge.

**Replies across rounds.** Each fingerprint records the rounds in which it was
answered `fixed`, re-raised after that, and — for a blocker — `declined`, as
sets of round numbers: an answer is counted once per verdict, however many
check-fix turns follow it. **Oscillation**: a fingerprint re-raised after
`fixed` in two different rounds. **Disagreement**: a blocker declined in two
different rounds; both sides are shown. Both need 3 rounds or more.

**Deadline.** 120 min (a host constant), absolute and persisted. It starts
when a dormant executor's turn starts — the start prompt included — and runs
through arming to the end; a dormant `no_changes` settle hands the session
back to the user and clears it. Every wait counts, app-down time included;
plan holds that stop the loop's own sessions extend it, by 24 h at most in
total. While it runs, a permission request open on a loop session for 15 min
also ends the loop. Either expiry first cancels the executor's running turn
(`cancel`), stops the check's container (§5.3) and deletes a running reviewer.
**Delivery is exempt from both expiries, by design**: in phase `delivering` a
tick past the deadline, or a permission request open for 15 min, does nothing
— the steps are short and time-bounded (§5.6), and an irreversible half-delivery
is worse than a late one.

"Live" = every phase but `ended` and an idle `dormant` (delivering is live, but exempt from the two expiries). Ends are **needs-you**
with the reason shown unless marked otherwise.

| phase | event | result |
| --- | --- | --- |
| dormant | executor turn starts | take the loop hold (§5.5); start the deadline |
| dormant | settles `changes` | arm: record base, `lastHash`; uncovered repos → proposing (repair message); else → checking |
| dormant | settles `no_changes` | release the hold, clear the deadline; an ordinary `turn-ended` (§7) |
| dormant, fixing, proposing | settles `blocked` / failed / incomplete | end `executor-blocked` / `executor-error` / `executor-incomplete` |
| checking | green pass, or nothing configured | `round` + 1 → reviewing, `reviewedHash = lastHash` |
| checking | red pass | `redStreak` < 3 → fixing (red message, `fixFrom = lastHash`); = 3 → end `check-red` |
| fixing | settles `changes` | disagreement → end; else hash = `fixFrom` → end `no-progress`; else uncovered → proposing; else → checking |
| fixing | settles `no_changes` | end `no-progress` |
| proposing | settles `changes` | no repo uncovered → checking (no diff-progress test: this turn only supplies commit texts); else end `missing-proposal` |
| proposing | settles `no_changes` | end `missing-proposal` |
| reviewing | reviewer settles with a verdict | hash ≠ `reviewedHash` → end `tree-moved`; oscillation → end; `approve` → delivering, or end `ready` at notify; `request_changes` with `round` = maxRounds → end `exhausted`; else → fixing (findings message, `fixFrom = reviewedHash`, a new open set) |
| reviewing | reviewer failed, incomplete, failed to start, not started in time | end `reviewer-unavailable` |
| delivering | every step done / a step fails | end `ready` / `delivery-failed` |
| live, before delivering | a human acts (§5.6) | end `taken-over` / `cancelled` |
| live, not delivering | deadline passed / permission open 15 min | end `time-cap` / `permission-wait` |
| delivering | deadline passed / permission open 15 min | nothing: delivery is exempt from both expiries (§5.6) |
| any | controller fault: an exception, a check that cannot run or be stopped, unreadable state | end `failed` |

"No progress" is the owner's rule as decided — an unchanged diff after a fix
round stops the loop whatever the replies say — so a round that only declines
or refutes ends `no-progress`. A proposal repair is not a fix round: it only
supplies commit texts, so it is exempt.

```ts
export type EndReason =
  | 'no-progress' | 'oscillation' | 'disagreement' | 'executor-blocked' | 'executor-incomplete'
  | 'executor-error' | 'check-red' | 'missing-proposal' | 'reviewer-unavailable' | 'tree-moved'
  | 'time-cap' | 'permission-wait' | 'delivery-failed' | 'taken-over' | 'cancelled'

export interface DeliveredStep { repo: string; step: 'commit' | 'push' | 'pr' | 'merge'; ref: string }

export type LoopEnd =
  | { outcome: 'ready'; delivered: DeliveredStep[]; notes: ReviewFinding[] } // final minor/nit
  | { outcome: 'exhausted'; open: ReviewFinding[] }
  | { outcome: 'needs-you'; reason: EndReason; detail?: string; open: ReviewFinding[]; delivered: DeliveredStep[] }
  | { outcome: 'failed'; error: string; delivered: DeliveredStep[] }
```

### 5.3 Check

Each write repo's `check`, one after another, in the executor's container, as
the container user, in `/workspaces/<repo>`, through the login shell like the
env's `setup` (`runScript` ~1106). Not through `dockerExec` as it stands: it
accumulates all of stdout (~759–769), and its timeout kills only the host's
docker CLI, which is not relied on to stop anything in the container.

- **Execution**: a plain `docker exec` of the login shell as the container
  user, in `/workspaces/<repo>`. Nothing else runs in the container and nothing
  is written there: no wrapper, no pid file, no process group.
- **Bounded capture**: the host keeps a ring of the last 60 lines, each cut at
  500 chars, ≤ 8 KB, and nothing else; stdout is never accumulated.
- **Killing a check = stopping the executor's container.** Nothing inside a
  container the agent controls can be trusted to supervise a process there (a
  pid file, a process group or a probe can be forged, raced or escaped with
  `setsid`). So on the 20 min timeout, on a cancel, on any end of the loop
  while a check runs, and for a leftover found at boot (an intent `check` that
  was running when the app died): `docker stop`, then confirm with a separate
  `docker inspect` that it is not running. Only then does the loop send a
  message, start a reviewer or release its hold. The container restarts through
  the existing attach path when the next host message needs it. A check that
  finishes by itself needs no termination. A stop that cannot be confirmed is a
  distinct outcome (`unconfirmed`): the controller keeps the hold and retries
  (not the same as ending the loop).
- **The residual boundary**: a descendant that detaches (`setsid`, a detached
  node child) and outlives a *normally finished* check is not contained — gurt
  does not look for it. What catches it modifying the clone is the `tree-moved`
  rule (§5.2, §6): the tree hash at the verdict must equal the reviewed hash.
- A container that is down at check time is woken through the gated path a
  resume uses; the loop hold keeps the clone free for it (to verify: a wake
  that runs `resolveLaunch` without attaching the agent).

### 5.4 The reviewer session

Created in the executor's scope and started as `spawnRun` (~2816) starts a
proactive run:

- the executor's env and inheritance (`inheritanceOf` ~2871: auto-allow,
  skills, network) with the block's agent and config values; the executor's
  repos, all `read`; its MCP selection with every built-in capped at
  `read-only` (no `git_push` / `create_pull_request`); `reviewOf`; title
  `review <round> — <executor title>`; §4.3's prompt. Persisted before it is
  enqueued.
- **Exempt from the scope's `maxConcurrentSessions` cap** — in
  `startNowOrQueue`, `scheduleSync`'s cap check and `holdersBlockingQueue`'s
  task half: the idle executor's container counts against the cap, so at cap
  1 the reviewer would queue forever, and a queued reviewer would trigger the
  queue handoff on the executor. It still counts as active for other sessions.
- Subject to its account's plan hold: it queues `agent-limited`, read through
  a new public `SessionManager.planHoldOf` (`limitHold` ~807 is private).
- **Bounded start**: not `started` within 15 min, held by a plan whose reset
  falls after that, or a start failure → end `reviewer-unavailable`.
- Fresh every round: independence; §4.3's typed history gives convergence.
  Once it settles its container is stopped (`containers.stop(id, 'idle')`, as
  the proactive `finishRun`); the session stays as the record of the review.

### 5.5 Host messages and the loop hold

**Host messages** — red checks, findings, the proposal repair — go through a
new `SessionManager.hostPrompt(sessionId, text, intent)`: a pending prompt
`{ auto: true, origin: { loop: intent } }`, persisted like a typed one
(`prompt` ~3059), run by `drainPending` one turn at a time, shown as a
`system` entry (the nudge's kind) carrying the intent id; dropped when the
user types or stops (`prompt` and `clearPending` drop `auto` items); never
clearing `recovering`, unlike `prompt`. The findings message is built from the
verdict's typed fields only, never from the reviewer's chat:

```
gurt review loop — round 1 of 2: the reviewer requested changes.
<summary>

R1.F1 [major] api/src/auth.ts:42
  claim: …   evidence: …   suggestion: …

Fix what you agree with, then call `complete` again (outcome "changes") with
`replies`: one { findingId, resolution: "fixed" | "declined" | "refuted", note }
for EVERY finding above.
```

The red message gives the command, exit code and output tail; the repair
message names the repos whose changes have no commit text (`proposalForRepo`
~594 finds none; `assertProposalFits` checks membership, not coverage) and
asks only for a `complete` with a `repos` entry or a shared `commit` for them.

**Executor instructions.** A loop session's executor instructions replace
"the user reviews and ships them" (`gurtServer.ts` ~42–46) with: gurt checks
and reviews the work after `complete`, may send findings to answer in
`replies`, and ships the result itself — never commit, push or open a PR.

**The loop hold** — taken when a dormant executor's turn starts, kept until a
dormant `no_changes` settle or the loop's end:

- **Before the turn ends**: it is in place before `sendTurn` emits
  `session.turn` `ended`, so the queue handoff, which runs on that event
  (`kernel.ts` ~358–366), never stops a container whose turn the loop has not
  classified yet — the nudge turn included.
- **Reservation**: `repoConflict`, `scheduleSync` and `repoHolderFor` treat a
  held session as holding its claims even with its container down, and
  `holdersBlockingQueue` never lists it. No other session takes the clone; the
  executor's own resume is unaffected; with its container down it does not
  count against the task cap. A container that stops anyway (a crash, a
  Docker or app restart) is woken by the check or restarted by the next host
  message through the attach path (`attachUncoalesced` ~2342). A *recreated*
  container keeps the agent's state only for kinds with `historyPaths`
  (claude-code today); for the others the resume fails → `executor-error`.
  This is stricter than the decision's fallback (a message waiting while
  another session holds the clone): none can.
- **Keep-alive**: the controller pings `activity` (~3021) every 60 s so the
  container stays up for the check and the next turn (`IDLE_STOP_MS` is 10
  min, `containers.ts` ~225).
- **Release**: drop the hold, then run the executor through the kernel's idle
  handling (`noteIdle` when idle, then the queue handoff) and `schedule()` —
  the pings cancelled its idle timer, and no turn end may follow to arm a new
  one (only `noteIdle` does, `containers.ts` ~1079).
- **Not covered**: a human editing the clone from a host terminal; the
  `tree-moved` checks catch a change between a review and its verdict or
  delivery, not one made before a hash is taken.

### 5.6 A human takes over

| while the loop is live and not delivering, the user… | end |
| --- | --- |
| types into the executor's chat or the reviewer's | `taken-over` |
| presses Esc on either, stops the container from the scope pane, cancels the loop's queued message, clicks "stop loop" | `cancelled` |
| deletes the executor or the reviewer | `cancelled` |

No auto-resume; nothing is committed (the owner's rule). The reviewer's chat is
this document's addition: a steered reviewer is no longer independent. The
end is written at once; a running check is killed by stopping the executor's
container (confirmed, §5.3) and a running reviewer deleted. Archiving the scope or either session is refused
while the loop is live; autoarchive skips the scope. Detection: a new
`session.human` event from `prompt`, `cancel` (~3155) and `cancelPending` —
called today only from IPC (`ipc.ts` ~448–454) and, for `cancel`, by a
proactive run's timeout, never on a loop session — and never from
`hostPrompt`; plus `container.status` `stopped` with reason `user` (only the
scope pane's stop uses it, `ipc.ts` ~320) and `session.deleted`.

**During delivery — this document's proposal, for the owner to confirm (§10).**
Delivery steps are irreversible, so the cancellation boundary is the start of
the first step. Before it, the owner's rule holds: nothing is committed. Once
it has started, delivery runs to its end — every step is short and
time-bounded (push 120 s, `changes.ts` ~26; `gh` 120 s) — and human acts are
applied after it, and the deadline and the permission wait (§5.2) are suspended
for it the same way: a typed message waits in the queue (a delivery gate in
`drainPending`, beside `repoHolder`) and runs after the loop has ended; Esc
and the container stop have nothing to interrupt, since delivery runs on the
host; deleting the executor removes the session while delivery finishes on the
clone, which outlives it. The alternative — stopping between steps — leaves a
partial delivery on a takeover, which the rule forbids.

## 6. Delivery

Host side only; no credential ever enters a container. Only on a clean result
(green check, `approve`), after re-checking that the hash is still
`reviewedHash` (else `tree-moved`) and that every changed write repo has a
commit text (else `delivery-failed` with nothing done). Each rung includes the
ones below it; all commits first, then pushes, then PRs or merges:

1. **commit** — with the latest proposal's text for that repo (subject, blank
   line, body) through `changes.commit`, `--no-verify`; a clean repo is
   skipped.
2. **push** — `changes.push` (`push -u --no-verify origin <task branch>`).
3. **pr** — a host function extracted from the github MCP tool
   `create_pull_request` (push, then `gh pr create` with the forge env from
   `forgeCliEnv`), with `--draft` per the block; the MCP tool then calls it
   too. Title and body from the proposal's `pr`, else its commit text, plus the
   final minor/nit findings as a short "Review notes" list. GitHub only today.
4. **merge** — local repos, instead of push / pr: `changes.mergeToMain`
   (`push --no-verify origin HEAD:<default>`).

**Unattended host git (decided, §10).** The clone's `.git` is the agent's to
write, so everything the loop runs on the host — the diff hash, the reviewer's
diff and status, every step above — goes through `changes.git` with an
`unattended` access (`git/harden.ts`): **no git hook runs in a loop's
delivery, by design** (`core.hooksPath` is an empty host-owned directory, and
commit and push pass `--no-verify`), and the clone's program-running config
(`core.fsmonitor`, `filter.*`, `core.sshCommand`, credential helpers, gpg
programs, `remote.*.uploadpack` …) is replaced by the host's own value of the
same key, or an inert one. The repo's `check` command (§5.3) is the quality
gate, not its hooks; a per-repo opt-in to run them can be a later feature.
**HEAD must be the task branch**: before the first commit (every changed repo)
and again in each step, else `delivery-failed` (`wrong-branch`) with nothing
committed or pushed from the wrong branch — the `push` rung pushes
`origin <task branch>`, the MCP tool `HEAD`, and `gh pr create` takes its head
from the current branch, which agree only there.

A failing step — a failed `git commit`, a rejected push, `gh` — stops delivery and
ends `delivery-failed` (needs-you, the owner's rule). That is a failure after
a clean review: nothing is rolled back, and the end lists exactly the
completed steps (commit SHAs, branches, the PR URL) and the failing one with
its output tail. Nothing on a forge is ever merged.

## 7. Notifications

No new type. `ready` → `proposal` ("review loop clean after 2 rounds —
<subject>", what was delivered, the minor/nit count); `exhausted` and every
needs-you reason, `taken-over` and `cancelled` included → `awaiting`, with the
reason and the unresolved findings; `failed` → `error`.

`session.proposal` keeps firing on every `complete` with changes (`onComplete`
~2750) — the fact "a proposal landed". The subscriber (`notifications.ts`
~111–131) leaves a session with `info.review` to the controller until its loop
has ended: it skips `session.proposal` and `turn-ended` for it and maps the
controller's `review.loop` event, which carries what each settled turn or end
calls for — an ordinary `turn-ended` for a dormant `no_changes` turn, the
mapping above for an end. After the end the session notifies as any other.
Reviewers never notify `turn-ended` (the proactive precedent, ~127).
Permission waits and faults of either session notify as today.

## 8. Persistence and recovery

`<ws>/<task>/review-loop.json` (precedent: `proactive-state.json`), keyed by
executor id, created when a loop-enabled executor starts, kept until it is
deleted; it joins `RESERVED_NAMES.repo`.

```ts
export interface CheckResult { repo: string; command: string; code: number; ms: number; tail: string[]; timedOut?: boolean }

export type LoopIntent = { id: string } & (
  | { kind: 'check'; repos: string[] }
  | { kind: 'message'; text: string }
  | { kind: 'reviewer'; round: number }
  | { kind: 'stop-reviewer' | 'delete-reviewer' | 'cancel-turn'; sessionId: string }
  | { kind: 'deliver'; repo: string; step: DeliveredStep['step']; head: string } // HEAD before it
  | { kind: 'end'; end: LoopEnd })

export interface LoopState {
  version: 1
  executor: string
  config: ReviewLoopConfig            // frozen copy
  phase: LoopPhase
  round: number
  redStreak: number
  repaired: boolean                   // the one proposal repair is used
  base: Record<string, string>        // write repo → HEAD at arming
  lastHash?: string
  fixFrom?: string
  reviewedHash?: string
  open: ReviewFinding[]
  openAnswered: boolean
  checks: CheckResult[]
  reviewer?: string
  rounds: { round: number; verdict?: StoredVerdict; replies?: FindingReply[] }[]
  fingerprints: Record<string, { fixedIn: number[]; reraisedIn: number[]; blockerDeclinedIn: number[] }>
  deadline?: string
  holdExtensionMs: number
  consumed: Record<string, string>    // session id → last settled turnId consumed
  intents: LoopIntent[]               // decided, not yet confirmed done
  delivered: DeliveredStep[]
  turns: { executor: number; reviewer: number }
  end?: LoopEnd
  notified?: boolean
}
```

**Settled turns are durable inputs.** `runPrompt` persists
`PersistedSession.lastSettled` before it emits `session.settled`; the bus is
synchronous and replays nothing (`bus.ts`). The controller writes `consumed`
in the same state write as the transition the turn caused. At boot, a loop
session whose `lastSettled.turnId` is past `consumed` is replayed through
`loopStep` before anything else — so a reviewer that finished, or an executor
fix that settled, just before a crash is never waited on again.

**Intents.** The state with an intent is written and synced before the effect
starts, and the outcome when it returns; recovery assumes neither and looks.
The controller's bookkeeping is exactly-once: every intent is consumed once.
External effects are not transactional; they are made safe to look for and to
repeat:

| intent | found at boot by | done when | if not |
| --- | --- | --- | --- |
| `message` | its id on the pending prompt, on an in-flight marker `sessions.json` writes beside `interrupted` together with the prompt's removal from the queue, or on the `system` entry | any of the three | enqueue it |
| `reviewer` | `reviewOf.intent`, persisted before the enqueue | a session has it — adopt it | create it |
| `check` | the intent itself (a `check` still unconfirmed at boot was running when the app died) | never: the executor's container is stopped and confirmed not running (§5.3), then the check reruns | run it |
| `deliver` commit | HEAD vs the intent's `head` | HEAD moved and its tree is the reviewed tree | commit |
| `deliver` push / merge | a fetch | `origin/<branch>` (merge: the default branch) contains HEAD — equal, or advanced since by someone else (reported) | push / merge; a diverged remote is rejected as non-fast-forward → `delivery-failed` |
| `deliver` pr | `gh pr view <branch>` | an open PR exists | open it (`gh` refuses a second PR for a branch) |
| `cancel-turn`, stop / delete reviewer | the session | no turn running / container down / session gone | do it |
| `end` | `notified` | notified and cleanup durably confirmed | emit, then mark `notified`; release only after confirmed cleanup (storage faults retain the hold) |

The notification ring is in memory: emit before persisting `notified`, deduping
by end intent id within one process. A crash before emission re-announces at
boot; a crash after emission but before marking may re-announce in the new
ring. Exhausted settled-write retries end `failed` (`store`) without emitting
an undurable input. Unreadable loop history is quarantined and ends `failed`
(`state-unreadable`), never reconstructed; both faults retain their holds.

**Boot**, in order: load every loop and register the loop holds before the
scheduler's first pass; replay unconsumed settled turns; end loops past their
deadline; reconcile intents; resume. Loop-owned work does not wait for a human:
an executor or reviewer of a loop that has not ended, restored `recovering`
(~755), is resumed by the controller (`resumeInterrupted` ~2024) and left out
of the Resume-sessions modal (`interruptedSessions`) — enabling the loop is the
approval. A reviewer restored to draft (it was `starting`) is enqueued again,
its start bound restarted.

## 9. Alternatives considered

**`complete` as a blocking call returning the check / review result** —
rejected: every harness would have to tolerate a multi-minute MCP tool call,
which nobody can verify per agent, and the check alone can run for minutes.
The owner's findings, recorded as given and not re-verified from this
repository: Codex's per-server `tool_timeout_sec` defaults to 60 s (applying
it to a server arriving through ACP `mcpServers` via codex-acp is
undocumented); the Claude Code binary gurt ships (2.1.303) has an idle limit
reset by progress notifications (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`) and a
hard per-call limit (`MCP_TOOL_TIMEOUT`); Gemini and opencode are unverified.
Gurt's proxy does not cut long calls (`gurt-proxy.mjs` ~805).

## 10. Open questions and risks

- **The delivery boundary** (§5.6) is this document's proposal: a takeover
  after the first delivery step is applied after delivery. The owner to
  confirm, or to choose stopping between steps and accept a partial delivery.
- **A check's descendants are not contained once the check finished
  normally** (§5.3): killing a check is stopping the container, and a normal
  exit stops nothing. A detached process that outlives it keeps running; only
  `tree-moved` (the verdict's hash against the reviewed one) catches it
  changing the clone, and a process that leaves the clone alone goes unnoticed.
- **The check runs repo code** in the sandboxed container from trusted
  config, but `npm test` is defined in the diff — hence the mandatory items.
  May an operator write `check` / `review`? Its held fields
  (`requirements-session-operator.md` §4.1) cover only host execution.
- **Test weakening** is surfaced, not enforced; a verdict that must address
  each mandatory item is open. **The reviewer cannot run tests**; a writable
  scratch over a read-only mount (`requirements-repo-mounts.md` §7) would
  change that.
- **Host git on a container-writable clone — decided: neutralise, for
  everything the loop runs on the host** (§6). The clone's `.git` sits in the
  executor's read-write bind, so `.git/hooks`, `.git/config` (`core.hooksPath`,
  `core.fsmonitor`, a `filter.<name>.clean` driver with `.gitattributes`,
  `diff.external` / textconv, `core.sshCommand`, a credential helper,
  `remote.<n>.uploadpack`, a gpg program, `protocol.ext.allow`,
  `core.worktree`) would otherwise run on the host as the desktop user, now
  without a human. `git/harden.ts` pins them on every call: hooks off (an empty
  host-owned `core.hooksPath`; `--no-verify` on commit and push — so
  **delivery runs no hook**), `diff` / `show` / `log` with `--no-ext-diff
  --no-textconv`, `fetch` / `push` with `--upload-pack` / `--receive-pack`
  (first-wins keys a `-c` cannot override), `GIT_PROXY_COMMAND` and
  `GIT_WORK_TREE` for the two the environment must override, and every filter
  the clone names replaced as a whole — each from the HOST's scopes (system,
  global, `-c`) when they set the key (a host git-lfs filter, ssh command or
  credential helper keeps working), else an inert default. The same pairs ride
  GIT_CONFIG_PARAMETERS so `gh`'s own git calls are held to them. It fails
  closed: a git without `--show-scope` (< 2.26), or a name containing `=` (it
  cannot ride in a `-c`), refuses to run. **Residue, accepted**: it is a
  deny-list; the clone's `remote.origin.url` / `url.*.insteadOf` still choose
  where a push goes; the config is read just before each call, so an agent
  still running in the container could write a driver in between (the loop
  holds the executor, but a container's background process is not stopped);
  an agent-replaced `.git` (a gitlink to another repository) is not detected.
  **The Changes panel's host git and the github MCP tools (`git_push`,
  `create_pull_request`) share the exposure and are NOT changed here** (a human
  is present at the panel; the tools are the agent's own request).
- **Agent-instruction files** in the reviewer's cwd are loaded by its harness;
  whether each kind can turn that off is to verify.
- **Fingerprints are exact**; a fresh reviewer paraphrases, so oscillation and
  disagreement may be undercounted. **`refuted` blockers** do not count toward
  disagreement as decided.
- **An `internal` session's check** reaches out only through the proxy.
- **Prompt-cache expiry** during a long review makes the next fix turn more
  expensive. Noted, not solved.

## 11. Non-goals / later

- A race of several executors.
- PR-watch after the PR is open.
- Per-round snapshots / rollback.
- Findings overlaid on the Diff panel.
- Per-stage recipes / bindings, and Quick / Standard / Deep presets.
- A review journal in the PR body (note only).
- Evidence-bearing findings.
- Agent-driven orchestration.
- The manual review removed in a29dda0 (ReviewModal, `review.json`, comments)
  is not resurrected.
- Also not in this pass: re-arming a loop on the same session, per-repo review
  instructions, configurable timeouts and caps, forges other than GitHub.

## 12. Acceptance

Pure node, no docker, on the harness of `scripts/queue-handoff.test.mjs`
(headless `createKernel`, temp `GURT_ROOT`, a stubbed container stop), unless
stated otherwise. Each test covers its section; the scenarios named are the
ones easy to get wrong.

1. `npm run typecheck`, `npx eslint .`, `agent-agnostic-core.test.mjs`.
2. `review-loop-step.test.mjs` — §5.2's table and counters: red retries
   consume no round; a green pass resets the streak; a decline repeated on a
   check-fix turn counts once; a proposal repair with an unchanged tree goes
   on; settled-turn precedence; the deadline from the start prompt, cleared by
   a dormant `no_changes`, extended by plan holds up to 24 h.
3. `review-loop-controller.test.mjs` — §5.1 and §5.4–5.6 on real bus events:
   `session.settled` after `incomplete` and the plan hold are set; host
   messages as `system` entries; the findings message without reviewer chat;
   user takeover ends the loop, drops its queued message, deletes the reviewer;
   no re-arm.
4. `review-loop-queue.test.mjs` — the executor is kept alive and its claim not
   lost: a writer queued before the first turn ends — through its nudge — gets
   no handoff; the reviewer starts while the executor holds `write` and under a
   scope cap of 1; after the end the idle timer is re-armed and the writer
   starts.
5. `review-loop-check.test.mjs` — the runner, plain node on the host behind a
   fake exec: unbounded output stays bounded; timeout and cancel stop the
   container and confirm it with an inspect; an unconfirmable stop is the
   distinct `unconfirmed`.
6. `notifications.test.mjs` (extended) — §7, including the dormant
   `turn-ended` and a single `proposal` at `ready`.
7. `review-loop-delivery.test.mjs` — local bare origins: each rung (a recording
   `gh` shim for the PR); nothing committed on any end before delivery; a
   second repo's failing commit (git's own: a stale `index.lock`; hooks do not
   run) → `delivery-failed` listing the first commit; a hostile clone (hooks,
   `core.hooksPath`, fsmonitor, a filter, `diff.external` / textconv, an
   uploadpack, a gpg program, `core.worktree`, `ext::`) runs nothing on the host
   through the hash, the reviewer's diff and every rung; HEAD off the task
   branch → `wrong-branch`; a typed message during delivery runs only after it.
8. `review-loop-recovery.test.mjs` — the kernel dropped and re-created on the
   same `GURT_ROOT`: around every intent (before it is written, before its
   effect, before its outcome) and between a settle and its consumption — one
   effect, and a finished reviewer is not waited on again; a remote advanced
   after a push is reported, not pushed again; holds in place before the first
   schedule. An end emits once per process; an unmarked emission may recur
   after restart because the old notification ring is gone.
9. `gurt-mcp.test.mjs` (extended) — the reviewer's tool set and the verdict
   rules; `replies` while an open set is unanswered, and after.
10. `turn-contract.test.mjs` (extended) — the reviewer's nudge and `incomplete`.
11. `session-roles.test.mjs`, `repo-mounts.test.mjs` (updated) — the reviewer
    role; the migration skips records with `reviewOf`.
12. `npm run build && node scripts/smoke-review-block.mjs` — the Config tab's
    Review block: defaults, the cross-kind default reviewer and the same-kind
    fallback, Run disabled for an identical agent and model, no pi offered,
    the ladder for forge and local repos, persistence across reload.
13. The rest of `scripts/*.test.mjs` passes unmodified.
14. **Not verified here** (no Docker daemon): a cross-family loop with real
    agents, the reviewer unable to write its clone, and a check stopped by
    `docker stop` inside a real container.

## 13. As built

**Deviations from the spec, all slices** (details under each slice):

- Settled turns carry a `turnId` of their own (a per-session logical-turn counter), not slice 1's `s.turns`; `LoopEvent` gained `now` / `heads` / `changed` and a `fault` event; `LoopState` gained `nextIntent` and `plan` (slice 2, 3).
- The loop hold is owned by the session manager and taken on `session.turn` `started`; there is no hold intent and no "is held" hook (slice 2, 3).
- (Slice 4's check pid file and leftover probe are gone: Fix 2.) Delivery's `push` rung pushes `origin <task branch>` where the MCP tool pushes `HEAD`: Fix 5 asserts HEAD is the task branch first. Host git hooks on the clone do not run, and the clone's program-running config is pinned (slice 5, Fix 5).
- Slice 1 left `store.getWorkspace` dropping `check` / `review`; slice 6 fixed it. The generated admin tools accepted both fields from slice 1 on; slice 8 makes the operator's writes of them a refusal.
- Pre-existing failures, unrelated: `env-image-build.test.mjs` (no docker binary) and one `proxy-server.test.mjs` test.

### Slice 1

- `openFindings?(sessionId)` (a `SessionEvents` hook, unset by the kernel) returns the open set as refs (`string[]`, "R1.F2"), built with the new `findingRef(round, id)` in `types.ts`. The checker `assertRepliesAnswer` runs only on a `complete` with `changes`; other outcomes accept `replies` unchecked. `replies` stay on the stored proposal, even when there is no open set.
- `submit_review` stores `Session.verdict` (runtime only). `turnId` is `<id>:<s.turns>`, but `s.turns` counts every `sendTurn`, the nudge included, and resets to 0 on each container start. So these ids are not unique across restarts. Slice 3 must define the settled `turnId` itself. `round` is `reviewOf.round ?? 0`.
- Role predicates: `roleForcesRead` (proactive, reviewer) is used by `repoMode` and the ConfigTab mode buttons. `roleIsLoopOwned` (reviewer) is used by `USER_SESSION_ROLES`, IPC `createSession`, `kernel.editDraft` (a draft can't become a reviewer or stop being one), duplicate and recreate. ConfigTab shows the role row fixed for any role that isn't user-pickable.
- Setup skip: nothing new was needed, because `skipSetup` follows the read-only anchor's `repoMode`. The proactive clone *refresh* (`ensureClone(…, refresh)`, `containers.ts` ~413) is deliberately left proactive-only: on the executor's uncommitted clone it would refuse to run or move the tree.
- `instructionsFor(role, mounts, { reviewLoop })`: `GurtHooks.reviewLoop` comes from `!!info.review` and is part of `shapeOf`. `draftFrom` does not carry `review` yet; that belongs to the Review-block slice.
- `adminTools.generated.ts` was regenerated, so the operator's `add_repo`/`update_repo` now accept `check`/`review`. Whether an operator may write them is still open (§10), and nothing is held.
- Bounds this spec left out: `file` ≤ 1000 chars, `line` a positive integer, `findingId` matches `^R\d{1,3}\.[A-Za-z0-9_-]{1,16}$`, `replies` ≤ 50.

### Slice 2

- `src/shared/reviewLoop.ts` holds the shapes, the constants (`REVIEW_LOOP`), `loopStep`, the texts and the prompt. Events beyond §5.1: `turn-started` and `settled` carry `now`, because `loopStep` reads no clock. `settled` also carries `heads` (write repo → HEAD; arming records them as `base`) and `changed` (repos that differ from base; approval delivers exactly these). A new `{ kind: 'fault'; error }` event covers the controller-fault row. `LoopState` gains `nextIntent` (intent ids are `<executor>.<n>`) and `plan` (the delivery steps decided at approval).
- No hold or release intent: the hold is `loopIsLive(state)`, or ended with `!notified`. A dormant `no_changes` settle shows up only as the deadline being cleared; the controller turns that into the ordinary `turn-ended`. No intent terminates a check: the `end` intent covers it (§5.3). The controller sets `state.reviewer` once it creates or adopts the reviewer. `loopStep` clears it each round and ignores reviewer settles while it is unset or whose `turnId` does not start with `<reviewer>:`. If a `reviewer` intent is still unconfirmed at the end, the controller must delete that session itself.
- Readings taken: a running dormant turn counts as live, so a message the user types during the first turn ends the loop `taken-over` (the spec read literally; the owner may want otherwise, see §4.3.1). A cancelled dormant settle ends `cancelled`. In `delivering`, ticks and human acts are ignored, so the deadline never cuts a delivery short (§5.6). "Both need 3 rounds" is a consequence of the rules, not an extra guard.
- Plan-hold extension = `until − now` of the limited settle, capped at 24 h in total. The total resets when a dormant `no_changes` clears the deadline. §6's tree-moved re-check is done at the reviewer's settle, and an approve with `uncovered` repos ends `delivery-failed` before any step. A re-check failing right before the first step has no event of its own: report it as `delivery-failed`.
- Agent-instruction paths: the core names only `AGENTS.md`. Each kind's own files come from a new optional manifest field `AgentManifest.instructionPaths` (filled for claude-code, codex, gemini and opencode, not checked against the pinned CLIs). `sha256Hex` is now exported from `envConfig.ts`. Its comment cites `scripts/env-config.test.mjs`, which does not exist; `review-loop-step.test.mjs` checks the hash against node:crypto instead.
- The findings message puts claim, evidence and suggestion on separate indented lines; §5.5's sketch had them on one. Long text stays readable this way.
- Pre-existing failures, identical on a clean 1457e52: `env-image-build.test.mjs` (6 tests, no docker binary) and one `proxy-server.test.mjs` test.

### Slice 3

- Public surface for the controller. `SessionManager`: `setLoopHooks(LoopHooks | undefined)` with `LoopHooks = { owns(sessionId), delivering(workspace, task) }` (the only thing the controller registers; `owns` keeps a loop's executor and reviewer out of `interruptedSessions` / `hasUnfinishedWork`, `delivering` is the §5.6 gate in `drainPending`, which the controller lifts by calling `schedule()` after the end); `holdForLoop(id)` / `releaseLoopHold(id): boolean` / `isLoopHeld(id)`; `hostPrompt(id, text, intent): Promise<void>` (idempotent per intent id); `createReviewer(executorId, { round, intent, prompt }): Promise<SessionInfo>`; `planHoldOf(id)`; `cancel(id, by = 'user' | 'host')`. `Kernel.releaseLoopHold(id)` = drop, `idle()` (`noteIdle`, then the queue handoff), `schedule()`. Events: `session.settled { sessionId, ref, turn: SettledTurn }`, `session.human { sessionId, ref, did: 'prompt' | 'cancel' }`.
- The hold is owned by the manager, not queried through a hook (the spec's "is this session held" hook was folded into `holdForLoop`; the boot sequence of §8 then calls it for every live loop before the first `schedule()`). Ordering: take it on the executor's `session.turn` `started` (emitted before `sendTurn`'s first await); one hold covers the nudge's own `ended`. `repoConflict`, `repoHolderFor` and thus `scheduleSync` read `holdsClone` (active or held); `activeSessionCount` still reads `isActive`, so a held executor with its container down costs no slot; `holdersBlockingQueue` skips it.
- `turnId` is `<sessionId>:<turnSeq>`, a counter of logical turns that only grows and resumes from `lastSettled` after a restart; `submit_review` now uses it (slice 1's `s.turns` was per `sendTurn` and reset at each start). The one slice-1 assertion that set `live.turns = 3` (`repo-mounts.test.mjs`) now sets `live.turnSeq = 3`. "A busy turn" is read as the whole logical turn (prompt + nudge); a `complete` / `submit_review` outside it is stored as before but belongs to no settle. `incomplete` is the mark `runPrompt` already set; a proactive run's plan-hold settle also carries `limited` although it is not continued.
- `session.settled` is emitted after `await persistNow` (a failed write is logged and the event still goes out), after `promptRunning` drops, and not at all for a session deleted meanwhile. `runPrompt`'s tail therefore waits for one extra persist.
- `session.human` is also emitted from `clearPending` when it removed something (the composer's stop with an idle executor and the loop's message queued sends no `cancel`), and `cancel(id, 'host')` does not emit; `proactive.ts`'s timeout now passes `'host'`. The controller must use `'host'` for its own deadline cancel.
- Spec claims checked: `container.status` `stopped` / `user` and `session.deleted` already reach subscribers. But `ContainerManager.stopTask` (a task rename) also stops with `user`, and `release` (IPC `releaseContainer`) emits no `container.status` at all. Test coverage for the stop is the emitter only (the teardown needs docker).
- `PendingPrompt` / `PersistedPrompt` carry `origin: { loop }`; `PendingPromptInfo` and `ChatSystem` a flat `loop` (intent id). Reviewer creation persists (`persistNow`) before `enqueue`; the cap exemption is `capExempt` (role predicate) in `startNowOrQueue`, `scheduleSync` and the task half of `holdersBlockingQueue`; an exempt start still counts for later sessions of the same pass. Tests share `scripts/lib/loop-harness.mjs` (fake `session/prompt` through `sessions.attach`).

### Slice 4

- Surface (`src/main/reviewCheck.ts`, no electron or session imports; the container is injected) — as of Fix 2, §5.3's rule: `new CheckRunner(deps)` with `deps = { exec(argv, cwd): ExecChild, ensureContainerUp(), stopContainer(), containerRunning(): Promise<boolean | null>, options? }` (real wiring: `ContainerManager.spawnExec(id, argv, cwd)` / `isRunning(id)`, `containers.stop`). `run({ intent, repo, command }): Promise<CheckRun>` never rejects; `cancel(intent)` stops the container and confirms it (a no-op `ok` when that intent is not running); `stopContainer()` is the same stop for a leftover at boot. `CheckRun` = `finished` | `stopped` (`reason` `timeout` / `cancel`; a timeout has `timedOut: true`, code −1) | `unconfirmed` (`reason`, `detail`, `result`: the container could not be confirmed stopped) | `failed-to-run` (`error`: a controller fault). A `stopped`/`cancel` is not a result.
- Wake without the agent: possible. `ContainerManager.resolveLaunch(id)` (public) = `ensure` + adapter install + proxy scope/network convergence + credential files, and never connects the agent (`attachUncoalesced` is what calls `connection` / `session/load`). The bare `containers.ensure(id)` is lighter but skips the proxy network convergence (an `internal` session would run the check on the open network) and leaves the skills-link debt for `installAdapter`, so use `resolveLaunch`. Neither applies the `repoConflict` gate (`ensure`'s own comment says the scheduler's gate is separate), so `ensureContainerUp` must be a new `SessionManager` method: the gate with `holdsClone` (the held executor is its own holder), then `resolveLaunch`. Slice 6 adds it. `isContainerUp` = the record's `container.status === 'running'`: a stopped container needs no exec to be "confirmed gone".
- The check is the login shell (`loginShell` from provision.ts, i.e. the `runScript` shell) run by `docker exec` as the container user; its exit code is the exec's (a command not found is 127: the host cannot tell it from "no shell"). Originally a node wrapper and a process-group control script ran in the container; both, the pid file and the boot scan are gone (Fix 2).
- Deviations: none left of slice 4's (the pid-file record, `/proc` liveness, the post-exit probe and `finished.leftover` went with the machinery, Fix 2). A cancel that arrives before the exec exists (container waking) wins and stops nothing.
- Capture is `LineRing` (60 lines × 500 chars, ≤ 8 KB by UTF-8 bytes; ANSI codes and C0 controls stripped, `\r` redraws keep the last). stdout and stderr share one ring, so lines of the two streams interleave by arrival, not strictly in order. Constants: `CHECK_TAIL`; timeout `REVIEW_LOOP.checkTimeoutMs`; all other timings in `CheckOptions` (grace 10 s, poll 500 ms, confirm 10 s, control exec 15 s).
- Not verified here: a real `docker stop` / `docker inspect` of the executor's container, and that the restart through the attach path resumes the agent afterwards (only host node and stubs).

### Slice 5

- Surface. `src/main/treeHash.ts`: `diffHash(ws, task, writeRepos): Promise<string>`, `repoTree(ws, task, repo): {head, tree}`, `parseDiffHash(hash)`. The hash is a sorted JSON list of `[repo, HEAD, tree]` (parseable on purpose: the commit probe needs one repo's reviewed tree; `loopStep` only compares strings), serialized per clone via `changes.serialized`, which `changes.ts` now exports with `git`, `revParse`, `defaultBranch`, `branchFor`, `FETCH_TIMEOUT_MS`. `ladderFor(repos)` is in `src/shared/reviewLoop.ts` (`Pick<RepoConfig,'local'>[]`; `pr` is offered for any forge repo, the PR step itself refuses a non-GitHub host).
- `src/main/delivery.ts`: `checkDeliveryPreconditions(ctx, writeRepos)` (throws `DeliveryError` `tree-moved` | `no-commit-text`, nothing done; call it first, and map a failure to `delivery-failed` — slice 2 has no event for a tree-moved right before the first step), then `deliverStep(ctx, { repo, step, head })` per `deliver` intent, resolving a `DeliveredStep & { note?, found? }` (`found` = the recovery probe already saw the effect; `note` = "nothing to commit" / "origin/<b> advanced to …", to report at the end). `ctx = { ws, task, reviewedHash, proposalFor(repo), draftPr, notes }`; `proposalFor` is `SessionManager.latestProposal(ws, task, repo)`. `deliverAll(ctx, rung, writeRepos)` runs §6 end to end without persistence (what the test drives; the controller records an intent per step instead). A failing step throws `DeliveryError { kind, repo, step, tail, delivered }`; its `message` is the text for `delivery-failed` and lists the completed steps (`withDelivered` is how a caller adds its own list). Kinds: `tree-moved`, `no-commit-text`, `commit-failed`, `push-failed`, `non-fast-forward`, `pr-failed`, `merge-failed`.
- `head` is the intent's: a commit's HEAD before it (= `base[repo]`), a later step's the commit it ships. Push, pr and merge fail `tree-moved` when HEAD is no longer `head`; the commit step also fails it when the working tree is not the reviewed tree, or HEAD moved to a commit whose tree is not (found = moved *and* equal tree, §8). A clean repo's commit is skipped (`ref` = HEAD, note); `deliveryPlan` already leaves unchanged repos out. (Slice 5 as first built ran the clone's hooks on commit; Fix 5 turned them off, so no hook rewrites files during a delivery commit.)
- PR: `src/main/git/pullRequest.ts` holds `openPullRequest(ws, repo, dir, { title, body, draft, push })` (push `HEAD` then `gh pr create`; `push: false` for the loop, whose push rung ran), `findOpenPullRequest` (`gh pr view <branch> --json url,state`; only `OPEN` counts, "no pull requests found" is none, any other `gh` failure is an error), and the moved `runHost` / `forgeCliEnv` / `withHostPath`. The MCP tool calls `openPullRequest` with no draft and the same refusals and texts. Title/body per repo: the proposal's `pr`, else its commit text, plus "Review notes" (≤ 10 final minor/nit findings whose `file` starts with `<repo>/` — other repos' PRs do not carry them).
- Push/merge probes `fetch origin` first (a failed fetch is logged and the push/merge then reports the real problem); "contains HEAD" = `rev-list --count <remote>..HEAD` is 0. A diverged remote branch is refused before pushing (never forced); a merge behind main is `non-fast-forward` from `mergeToMain`'s own check. `DeliveryError.tail` is `run()`'s message, which keeps only the last 3 output lines of the failing command.
- Spec details: the `push` rung pushes `origin <task branch>` (`changes.push`) while the MCP tool pushes `HEAD`; the same only on the task branch, which delivery asserts (Fix 5). Not verified: a managed (`git-token`) credential path through `gh` (`GH_TOKEN`) and a real GitHub — tests use an ambient `git-host` credential and a recording `gh` shim on PATH.

### Slice 6

- Surface. `src/main/reviewLoop.ts`: `createReviewLoop(deps)` → `ReviewLoopController` (`load`, `start`/`stop`, `tick`, `state`, `stopLoop`, `openFindings`, `owns`, `delivering`, `dropScope`/`dropWorkspace`, `idle` for tests); the kernel builds it beside the proactive manager (`Kernel.reviewLoop`), registers `LoopHooks`, wires `SessionEvents.openFindings`, and takes `createKernel({ reviewLoop: { clock } })` as the one test seam for time. New: `review.loop` (`{ sessionId, ref, notice }`, `ReviewLoopNotice` = `turn-ended` | `end` with `LoopEnd`, `rounds`, `subject`), `GurtApi.reviewLoopState` / `reviewLoopStop` (both `none`: the state quotes the diff, which the operator cannot read), `SessionManager.ensureContainerUp` (the gate with `holdsClone`, then `resolveLaunch`) and `dropHostPrompts`, `ContainerManager.spawnExec`, `store.readReviewLoops` / `writeReviewLoops` (`review-loop.json` reserved).
- Shape. A transition is synchronous (`apply` = `loopStep` + swap in memory), so the hold is taken inside the `session.turn` `started` handler; only the facts of a settled turn (diff hash, heads, `changed`, `uncovered`) are gathered asynchronously, per loop in order. Intents run as background tasks that report back with an event, so a human act, "stop loop" or the tick lands while a check runs; the state with the intents is persisted before the first effect, an intent is confirmed (removed) after its outcome, and `check-pass` / `delivered` are applied before their intent is confirmed (at-least-once, for slice 7 to reconcile).
- Gap in slice 1 found and fixed: `store.getWorkspace` rebuilt every repo from a whitelist and silently dropped `check` and `review`, so nothing could ever be read back. Both are read now (`review` through a small sanitiser).
- Readings taken. The reviewer's diff is `git diff <base> <tree>` with the tree `diffHash` hashed (temporary index), so it holds exactly what a commit would record; untracked files are relabelled from that diff for §4.3 item 4; hooks, textconv and external diff drivers are off; cut at 150 000 characters per repo with a note (the reviewer's mount is readable). The user's earlier messages are the `user` entries of the log after the first (the start prompt; tokenised when masking is on). The reviewer is matched to its round by `reviewOf` if its settle beats the controller's own record of it (`adopt`). Stopping a settled reviewer's container uses reason `idle`, a check's container stop (§5.3) uses `idle` too: only `user` reads as a human. "Stop loop" ends first, then cancels the running turn (host), and refuses while delivering; the end also drops the loop's queued messages.
- For slice 7. Wired already, because a live loop without them is unsafe: `session.human` / `container.status` `user` / `session.deleted` → `human` events, and `tick` (deadline, 15 min permission wait, the reviewer's start bound: 15 min, a plan hold past it, or a fall back to draft). `tick()` is public and the clock injectable. Left for slice 7, which did them (see its section): replay of `lastSettled`, intent reconciliation, the stop of a leftover check's container, resuming `recovering` loop sessions, the notifications mapping of `review.loop`, refusing to archive a live loop. At the end of slice 6, `load` read the files and ended a loop found running `failed` (`orphan`), because nothing could resume it yet; slice 7's recovery replaced that. `end` emits `review.loop`, sets `notified`, then releases the hold; a deleted executor's ended loop is forgotten, a delivering one when its delivery ends.
- Earlier tests touched: `loop-harness.mjs` takes `workspace`, `credentials` and `kernel` options and exports `store` / `api`; `review-loop-queue.test.mjs` sets the Review block only where it creates the reviewer (the real controller now takes any loop-enabled executor into a loop by itself); `ipc-opaque-args.test.mjs` lists the two new id-only methods.

### Slice 8

- Surface. Pure, tested in plain node (`scripts/review-block.test.mjs`): `src/shared/reviewBlock.ts` — `agentReceivesMcp`, `reviewerCandidates`, `defaultReviewer`, `validateReviewBlock`, `modelOf`, `seedReviewBlock`, `sanitizeReviewBlock`, `clampRung` / `clampRounds`, `ladderOfRepos` (`ladderFor` stayed in `reviewLoop.ts`, slice 5, and is re-exported), `RUNG_LABEL`; `src/shared/reviewStatus.ts` — `loopLine` (the status line as data) and `END_REASON_TEXT`. The manifest field is `AgentManifest.acpMcp?: boolean` (absent = receives; `false` for pi only). `SessionDraftPatch.review` is `ReviewLoopConfig | null` (`null` = off on purpose); `SessionInfo.reviewOff` remembers that choice. `Kernel.editDraft` shapes the block and refuses it outside an executor draft; `Kernel.assertReviewBlock` is the start gate (run by the IPC `sessionRun` / `sessionEnqueue`) and `Kernel.checkRepoReview` normalises and validates a repo's `check` / `review` on the IPC `addRepo` / `updateRepo`. No `GurtApi` method was added.
- The block is prefilled once per draft, when the executor's agent, the credentials and an anchor (the first `write` repo) are known and the anchor's `review.enabled` is set. A draft the user switched off (`reviewOff`) or edited is not prefilled again; changing role away from executor drops the block. `RepoConfig.review.agent` unset means "automatic": the default-reviewer rule runs per draft, and a named reviewer that has since gone is kept and flagged (Run disabled) instead of being silently replaced. `defaultReviewer` reads "usable credential" as an `agent-token` / `oauth` entry that the link resolves to, not signed out (the renderer sees the masked store, which `oauthSignedOut` reads correctly); within the same kind, another instance (one that can authenticate first) comes before the executor's own, which is the last resort.
- Validation reads (§3): the same instance on the same model is refused; when the agent's config surface reports no model at all (every kind but claude-code has no seed) the same instance is refused too, because the two cannot be told apart — another instance is the way out. The model is the pick, else what the agent reports through its option view. A rung the repos' ladder does not offer is a problem (shown, Run disabled), not silently lowered; only a fresh prefill steps down (`clampRung`). Repo defaults are validated without an executor: only the reviewer's own conditions and the repo kind's ladder.
- Settings → Repos: the `check` input and the defaults (on by default, reviewer, rounds, when clean, draft PR); the reviewer's model chips are not offered there (a stored `configValues` of a named reviewer is kept). **The open question of §10 is settled conservatively: the operator may not write `check` or `review`.** Not held (no confirmation diff conveys "this repo now ships on its own"): `update_repo` / `add_repo` changing either are refused with a sentence naming Settings → Repos, and a write that leaves them as they are lands (`adminWrites.ts`, `scripts/review-block-operator.test.mjs`). The generated tool schema still lists both fields; a model learns of the refusal from the answer.
- Session pane: `ReviewLoopLine` above the chat of a started loop executor and of its reviewers (phase, "round r of N", the findings count while a fix is due, the end's reason and the unresolved findings, the delivered steps) with "Stop loop" (confirm, then `reviewLoopStop`; hidden when the loop is not live or is delivering). The executor's pane re-reads when its snapshot is pushed (the controller emits `session.changed` on every transition) and every 4 s; a reviewer's pane only by the poll. The reviewer's role mark is an eye icon in the scope tree's row (`reviewOf` sessions); the titles are the controller's. A queued / starting session has no line.
- Smoke: `scripts/smoke-review-block.mjs`, in addition to §12 item 12's list: the Run button's reason, a duplicate carrying the block, a named reviewer that is gone, off staying off, an executor-only block, Settings → Repos, and — from a hand-written finished `review-loop.json` — the status line and the reviewer's mark. A *live* loop's line (and Stop loop) is not exercised there: it needs docker and agents (a loop found running at boot is resumed by `recover`, slice 7). It is not in `run-smoke.mjs`'s docker-free list; run it by hand.
- Spec errors / readings. §3's "Run is also disabled while the named reviewer is … without MCP" and "no pi offered" are one rule in code (`reviewerCandidates`), plus the executor-side refusal. §3's "draft-PR checkbox" appears only for the `pr` rung. §3's reading of "the executor's own model" for a draft with no pick is the agent's reported default. The spec names no "when clean" step for an executor with no write repo yet: only `notify` is offered and the block says so.

### Slice 7

- Boot is two calls in `restoreSessions`: `reviewLoop.load` (read the files, take the loop holds of live loops and of ended-not-notified ones, before anything else) and `reviewLoop.recover()` (replay unconsumed settles → deadline `tick` → reconcile the intents that were on disk at load → resume), both before the first `schedule()`, so a reviewer of an expired loop is never started to be deleted. `recover` awaits the quick part; a re-run check and a delivery step carry on in the background (`idle()` waits). The slice-6 `orphan` end is gone. A reviewer created but not recorded is adopted by `reviewOf.intent`/round before the replay; a loop-enabled executor with `lastSettled` and no loop file gets its loop created. Reconciliation per kind is `reconcileOne`; the leftover-check stop (`stopLeftoverCheck`, Fix 2) runs per loop holding a `check` intent with a container up.
- The `message` row's in-flight marker did not exist: `PersistedSession.loopRan` is the intent whose prompt the drain last took off the queue, written with the removal and `interrupted`. It is replaced by the next prompt taken (not cleared at the settle, since the log flushes separately from `sessions.json`). Found = pending, marker or `system` entry (`hostPromptSeen`). A message so found is not resent; its interrupted turn is resumed by the controller with the restart prompt.
- Deviations. (1) `end` writes `notified` BEFORE emitting `review.loop` (the §8 table notifies first): a crash between loses one notification instead of repeating it; the intent is confirmed last, after the release, so a restart reruns the idempotent tail. (2) Recovering the first delivery commit skips the §6 hash precondition when HEAD already moved (the hash includes HEAD, so it can never match after the commit); `deliverStep`'s own probe then says found or `tree-moved`. (3) The commit texts are kept in memory once delivery starts, so deleting the executor mid-delivery (§5.6) still commits with its text; after a restart with the executor gone the loop is dropped at `load` as before. (4) `DeliveredStep.note` (only when a recovery found the step done: "already committed", "origin/… advanced to … after our …") rides the end and the notification. (5) `LoopHooks.live` makes `taskHasPendingWork` true while a loop is live or ended-not-notified (archive/auto-archive refuse; `archive.ts` names the loop).
- Notifications: `createNotifications(bus, prefs, info, loopSpeaksFor)`; the kernel passes `reviewLoop.notifiesThrough` (Review block, executor, loop not ended-and-notified). `loopEndNotification` is the §7 mapping (exported, tested). An end that lands while a turn is open claims that turn, so no extra `turn-ended`. Slice 8: `review.loop` / `reviewLoopState` already carry everything; `LoopState.intents` non-empty on an ended loop means its tail is still running.
- A recreated container: for a kind without `historyPaths` the resume's `session/load` fails (`attachUncoalesced` throws "could not resume"), the turn settles `failed` and the loop ends `executor-error`; only the stub of that failure is tested (the history mount is `usesHistoryMounts`, not verifiable without docker).
- Spec errors: §12 item 8 and the work order cite `session-recovery.test.mjs` as re-creating a kernel; it only builds a `SessionManager`. The recovery test instead copies the data root at a chosen instant (`h.image()`, a crash image) and boots a second kernel on the copy (`h.boot`, a fresh module instance per boot since `GURT_ROOT` is read at load), with a post-receive hook in the origin and (since Fix 5, which switched clone hooks off) a `git` shim on PATH (`scripts/lib/git-gate.mjs`) gating the dead kernel's shared-origin effects. Esc/stop/typing during delivery are ignored by `loopStep` and the typed message runs after the end only because the end's `schedule()` lifts the gate (the controller test restores the real `schedule` for it).

### Fixes

#### Fix 1

- **Ordinary sessions are unchanged.** A session with neither `review` nor `reviewOf` (`isLoopSession`) has no logical-turn record, no `lastSettled` write, no `session.settled` and no `session.human`: `runPrompt` drops `promptRunning` in its `finally` exactly as on main (no extra awaited write, so the drain, the update deferral and queued follow-ups wait as before) and `prompt` / `clearPending` / `cancelPending` / a user `cancel` add no bus event. Loop sessions keep §5.1 / §8 / §5.6 as written; the tests that watched settles and `session.human` on bare sessions (`session-settled`, `host-prompt`) now give them an inert `reviewOf` mark. `ordinary-session-unchanged.test.mjs` pins main's event list and write count for a normal, nudged, plan-held, thrown and incomplete turn (captured from main's `sessions.ts`).
- **The delivery gate is per clone.** `LoopHooks.delivering(ws, task)` returns the delivering executors' ids; `deliveryActive` holds those sessions and any whose clone claims overlap theirs (`claims`, the scheduler's notion), so a repo-free inspector or a session on another repo drains its queue meanwhile.
- **A contract call belongs to a turn only inside a busy round-trip** (§5.1). `onComplete` / `onSubmitReview` of a loop session file the artifact — and count the turn complete — only while `busy`; the logical turn (prompt + nudge) still spans both round-trips, but a call landing while the next prompt is masked, between the first round-trip and its nudge, or during the round-trip's closing write is stored as before and filed nowhere, so a stale approval cannot outlive an omitted tool. A call outside a turn is stamped with the id before the turn in flight.

#### Fix 2

- **Check containment = stopping the container** (reviewer C; (a) a missing pid file read as "gone", (b) a `setsid` descendant outliving the group, (c) the unauthenticated pid record, (d) `writeFileSync` following a symlink in `/tmp` — all confirmed against the old code; the whole class is gone because nothing in the container supervises anything now). `reviewCheck.ts` runs the login shell by plain `docker exec` (`exec(argv, cwd)`); timeout, cancel, any end of the loop during a check and an intent `check` found at boot go through `stopContainer()` + `containerRunning()` (a real `docker inspect`: `ContainerManager.isRunning`, `dockerInspectRunning`, tri-state — an unanswered inspect is not "stopped"). The wrapper, `CTL_SOURCE`, pid files, the post-exit probe/`leftover` and the boot scan were deleted; the module and its test went from 1093 to 662 lines.
- `CheckRun.unconfirmed` (now with `reason`) is the typed outcome for an unconfirmable stop; the controller still ends `failed` on it (`executeCheck`) or logs it (`executeEnd`) — hold-and-retry is fix round 3. `spawnExec` takes the `cwd`; the leftover-at-boot stop is `stopLeftoverCheck` (gated on the container record saying running, as before).
- Residual boundary documented in §5.3 and §10; `tree-moved` between "check passed" and the verdict was already tested (`a reviewed tree that moves before the verdict …`, controller test). Tests: the check test rewritten; the controller and recovery tests' exec fakes are now the login shell under host node, killed by the harness's `containers.stop` stub (`inContainer`), plus new "stopping a running check = stopping the executor's container" and the boot "stops the executor's container, then the check reruns".

#### Fix 3

- Finding 1 **confirmed** (the cited swallowed stop moved in Fix 2; `executeEnd` still logged an unconfirmed cancellation and released). §5.3 now retains the check intent and reservation until termination is confirmed; retries make a fresh daemon stop/inspect, including labelled containers whose executor record was deleted. Regressions: `review-loop-controller.test.mjs` “deleted checking executor…” and `containers-lifecycle.test.mjs` “review cleanup stops…”.
- Finding 2 **confirmed**. End cleanup retries on normal ticks with exponential backoff capped at five minutes and one in-flight attempt; `end.cleanupPending` carries the failure, shown in the session status line. Persistence failure rolls back the notification marker; the completed tail is persisted before release. Regressions: controller “end cleanup throwing…” / “end persistence failure…” and `review-block.test.mjs` “ended cleanup failure…”.
- Finding 3 **confirmed**. Reservations store clone claims independently of session records; deletion preserves them, and delivery gating reads those stored claims. Regressions: controller deletion with queued writers during checking and delivery, plus `review-loop-queue.test.mjs` “a deleted executor retains…”. The former queue expectation was changed because immediate removal contradicted §5.5–§5.6 and allowed an unreviewed writer before delivery finished.
- Finding 4 **confirmed**. §5.6/§8 delivery persists per-repo commit/PR proposals alongside the existing reviewed hash and final findings before effects; load retains delivering or unconfirmed-intent loops without their executor and restores holds from stored repos. Regressions: `review-loop-recovery.test.mjs` “deleted executor after commit recovers push/pr exactly once” (commit, deletion, crash image, fresh kernel, one push/PR and one end). This supersedes Slice 7 deviation (3)'s memory-only proposals and discarded delivery.
- All regressions were checked with this round's relevant production changes temporarily removed: assertions failed; the changes were restored. No earlier working-tree work was reverted, and nothing was committed, pushed or submitted as a PR.
- Validation: `npm run typecheck` and `npx eslint .` passed; all 121 touched-file tests passed on the final run (an earlier concurrent run hit the existing keep-alive test's timeout; it passed in the full suite and the isolated rerun). `npm test`: 1,074 passed, one skipped, seven known failures only (six Docker-dependent `env-image-build` cases and the `proxy-server` MCP-routing case).

#### Fix 4

- Finding 1 **confirmed**: §8 now emits before marking `notified`, with process-local dedupe by end intent id; supersedes Slice 7 deviation (1). Recovery tests “before the notification” and “crash after emission before its mark” assert one observation across a pre-emission crash and one entry per lifetime after an unmarked emission. The former at-most-once test codified notification loss and was corrected because the ring is not durable.
- Finding 2 **confirmed**: loop-only settled writes retry three times; exhaustion suppresses the event, discards the undurable in-memory artifact, and faults `failed: store` with its reservation retained. Controller tests “settled persistence fails 2 times” / “3 times” cover recovery and exhaustion.
- Finding 3 **confirmed**: store reads distinguish absence from invalid JSON/record shapes (including nested fields), retain a quarantine copy, and fail the affected scope closed with durable `state-unreadable` tombstones and holds before scheduling. Recovery tests “unreadable loop state” cover syntax, record and nested corruption, plus lost executor records (a scope reservation); no reviewer is recreated. Copying preserves the corrupt source until tombstones land, closing the quarantine/restart gap.
- Finding 4 **confirmed**: §8 end-row notify/release/idempotency expectations were rechecked; controller “end persistence failure” now asserts emission before the failed mark and exactly one notice after retry. Recovery asserts normal release and empty intents; storage-fault tests assert retained holds and no duplicate notice on tick.
- Regression checks: this round’s production edits were temporarily removed against the saved starting tree; all seven selected regression cases failed, then the edits were restored; the additional deleted-executor/syntax case also failed with its scope-reservation fallback temporarily removed. Earlier rounds were preserved; no commit, push or PR was performed by this agent.

- Validation on the current shared tree: `npm run typecheck`, `npx eslint .`, and all 100 focused tests passed. Full `npm test`: 1,094 passed, one skipped, seven known failures only (six Docker-dependent `env-image-build` cases and the `proxy-server` MCP-routing case).

#### Fix 5

- **Host git hardening — confirmed** (reviewer C): the clone's config and hooks ran on the host in the hash, the reviewer's diff and every step (reproduced: hooks, `core.hooksPath`, fsmonitor, a filter, `diff.external` / textconv, `remote.origin.uploadpack`, a gpg program, `ext::`, `core.worktree`). `src/main/git/harden.ts` (§6, §10) is the one helper: `HostGitAccess.unattended` (`unattendedGitAccessForRepo`) makes `changes.git()` read the clone's config (`config --list --show-scope -z`) and pin its program-running keys to the host's value or an inert one on every call; hooks are off by an empty `core.hooksPath` plus `--no-verify`; `diff` gets `--no-ext-diff --no-textconv`, `fetch` / `push` the `--upload-pack` / `--receive-pack` flags (`-c` cannot override those first-wins keys), `core.gitProxy` / `core.worktree` their env variables; `gh` gets the same pairs in GIT_CONFIG_PARAMETERS. **Delivery now runs no git hook, by design** (§6). Tests: `review-loop-delivery.test.mjs` "hostile clone" (every rung, the worktree, the pins, host values surviving, the `=` refusal), the controller's hostile-clone loop test; the clone-hook gates of the controller and recovery tests became a `git` shim (`scripts/lib/git-gate.mjs`).
- **`HEAD` is the task branch — confirmed (unverified claim held up)**: `expectBranch` before the first commit (all changed repos) and in each step, `wrong-branch` otherwise. Test: "HEAD must be the task branch" (two cases, delivery test).
- **Delivery vs the expiries — confirmed, resolved in the spec**: §5.2 / §5.6 now say delivery is exempt from the deadline and the permission wait; `review-loop-step.test.mjs` pins it. §13's stale "Slice 7 is not in the tree" bullet is deleted; §5.3, §6, §10 and §12 item 7 agree with Fix 2 and this fix.
- Shared exposure, not changed: the Changes panel's host git and the github MCP tools (§10).

#### Fix 6

- **The prefill is the draft's, not the Config tab's — confirmed** (reviewer C2; the old smoke always opened Config). `useReviewBlock(tree, info, true)` in `NonStartedPane` writes the anchor's defaults into any complete executor draft whichever tab shows, and holds Run (`problem`: "applying the repository’s review defaults…", or the failure) until the block is in; `reviewSeedDue` (shared, pure) keeps `reviewOff` and never overwrites an edit, and swaps an untouched block only when the anchor changes (`seeded` remembers what was prefilled). This supersedes Slice 8's "prefilled once per draft". Tests: `review-block.test.mjs` "the prefill is owed from the draft alone…"; smoke 10a (drafts written with agent/env/repo and no block, Config never opened: block saved, Run gated like an explicit block) and the anchor-swap case.
- **Local create dropped `check` / `review` — confirmed.** `saveRepo` (`settings/repoSave.ts`) makes the second write (`updateRepo` on the entry `createLocalRepo` returned) and the modal closes only after it; if it fails the modal stays open as an edit of the created repo with the error, so a retry updates. Tests: `review-loop-ui.test.mjs` (create + update, failure keeps `created`, retry never re-creates); smoke creates a local repo with defaults in the modal.
- **Poll order — confirmed in the code** (no ordering guard; the IPC did not reorder in practice, so the test uses deferred reads). `pollLatest` drops an answer older than one already shown. Test: `review-loop-ui.test.mjs`.
- **Reviewer picker keyboard — confirmed.** Items are `<button onClick>`, the row has `aria-haspopup` / `aria-expanded`, focus returns to it (opt-in `PickRow accessible`); smoke drives Enter / Tab / Enter / Escape. The neighbouring pickers (env, repo, agent, role, repos’ credential menu) keep the same mouse-only gap.
- **Shared `ChoiceGroup`** replaces the on/off, rounds, rung and repo-default chip rows (ConfigTab −35 lines, ReposSection −32, component +45); `useReviewBlock` also owns the credentials read and the one memoised reviewer list.

#### Rebase onto main (98ac9fa)

- **The rebase** onto `origin/main` 98ac9fa (#142–#147, on top of 1457e52) was already finished and pushed when this round began. It finished at 10:42:45, and the push updated `origin/execute-review` at 10:44:16. This agent did neither. Its commits stand as they are: e409cc3 (from ea70d74, the only pick that conflicted), 4a49d74, cac7efb and d384311. The last three are clean picks, with trees identical to a re-run cherry-pick. The pick of ea70d74 was replayed with `git merge-tree` and compared with e409cc3, and all five conflicts keep both sides:
  - the pi manifest has `acpMcp: false` with its comment, and main's `pi-coding-agent@1.5.0`;
  - `drainPending` checks `!earlierQueueItem`, `!limitHold` and `!deliveryActive`;
  - `pendingBlocked`, `clearPending` and `cancelPending` keep both checks and both calls.

  This round changed two of those orders, in the working tree:
- **`pendingBlocked`: the loop's gates before the place in the queue.** The order is now: plan hold, delivery (§5.6), another executor's loop hold (§5.5), `earlierQueueItem`, clone holder. A delivery runs to its end and a loop hold lasts until the loop lets go, whatever position a message has in the queue. An earlier item on the same clone waits for the same gate, so "waiting behind" would name a session that cannot move either. Once the gate lifts, FIFO decides. The rebase had put main's check first. That broke Fix 1's delivery-gate test: the `read-locked` reader of the delivering clone said `waiting behind session "g1"`.
- **`clearPending` / `cancelPending`: `human` before `schedule()`.** The rebase had main's `schedule()` first. The scheduler pass starts sessions and drains queues synchronously, and their `session.state` / `session.turn` events must reach the controller after the human act that came first. This is the same order `prompt` uses: it announces, then drains. A session without a loop emits nothing here, so the order makes no difference to it. Test: `host-prompt.test.mjs` "withdrawing a queued message tells the loop before the scheduler acts on the freed queue".
- **(a) The loop hold against main's FIFO by clone: deadlock confirmed and fixed.** Main's `earlierQueueItem` made a held executor's own prompt wait behind a session queued on its clone during the loop, and that session waited for the hold. Both waited until the deadline. The deadlock occurs whenever the executor's own prompt carries a later `queuedAt` than the queued session:
  - the restart prompt of its interrupted turn (`resumeInterrupted`), including after an app restart;
  - the continuation of a plan-held turn.

  The work order's exact sequence (reviewing, then a session queued, then `request_changes`) did not deadlock, by accident: `hostPrompt` gives the loop's messages no `queuedAt`, so the executor sorts first (`queueTime` is `''`).
  - **Fix.** A loop-held executor's `earlierQueueItem` skips every session whose claims collide with its own hold. That session cannot start before the release anyway. After the release, FIFO applies again: the queued session starts, after the queue handoff stops the executor.
  - **Texts.** A wait on a loop hold is now named on both sides: `the review loop of session "X" holds "alpha" — this starts when the loop lets go` for a queued session (`queuedWaiting`), and `… this sends when the loop lets go` for a waiting message (`pendingBlocked`). When the executor is deleted, the text says "a review loop". Before this, a queued session showed no reason, and the executor's own message could say `waiting behind session "<the queued one>"`.
  - **Tests.**
    - `review-loop-queue.test.mjs` "a held executor's own work (…)": four cases (restart prompt or continuation, against a `write` or a `read-locked` session). Without the fix each fails with "never: … own work ran".
    - `review-loop-controller.test.mjs` "a write / read-locked session queued on the clone while the loop reviews…": the work order's scenario end to end. Without this round's change it fails only on the texts.
    - `review-loop-recovery.test.mjs` "message in flight at the crash, a writer queued on the clone before it…": across a kernel drop and re-create. Without the fix the interrupted turn never resumes.
- **(b) Restart recovery against host messages: no production change was needed beyond (a).** Main restores `recovering` only for an interrupted turn, and adds the limit continuation only to an empty queue. So a loop message still queued at the crash is not `recovering`. The boot's first scheduler pass (`restoreSessions`, right after `reviewLoop.recover()`) sends it; the controller's `resumeInterrupted` returns at once. §8's reconciliation still finds the message in the queue and does not re-send it. A message already in flight is found by `loopRan` and resumed with one restart prompt. The recovery tests' `schedule` stub did nothing, so "message — before its outcome" hung. The stub now keeps the pass's drain half and simulates only the starts. That test also asserts that no restart prompt and no extra continuation are sent. A typed message still drops the loop's `auto` messages (main's `prompt` filters `auto`), as §5.5 asks. The restart form of (a) was the real break, and the (a) fix covers it.
- **(c) The durable JSON writer: already in use, nothing changed.** `review-loop.json` goes through `store.writeReviewLoops`, which calls the store's per-file chained `writeJson`; main's #145 made that `writeJsonDurable`. `sessions.json`, which carries `lastSettled` and `loopRan`, goes the same way. The loop writes no other JSON. The quarantine copy `review-loop.json.corrupt-<ms>` is a raw `fs.copyFile` (not JSON, and its source stays until the tombstones land), and git writes its own temporary index.
- **(d) #143 / #144: they compile and pass, nothing changed.** `gurtServer.ts` uses main's `listenEphemeral`, and the loop's instructions, `replies` and `submit_review` sit beside it. All of #143's version bumps are kept. `acpMcp: false` is on pi only, and `instructionPaths` is on claude-code, codex, gemini and opencode.
- **Tests made stale by main, updated.**
  - `ordinary-session-unchanged.test.mjs` pinned the old main's event lists. They were recaptured from 98ac9fa's `sessions.ts`: a main-only harness ran the same five scenarios, and main and this branch give identical traces. n3 gains one `session.changed`, and n4 and n5 lose one each. The cause is main's scheduler: the plan-held n3 reports its wait once (`noteQueued`) instead of emitting from a drain on every pass.
  - `session-settled.test.mjs`: the plan-held s5 moves to `beta`. Its continuation keeps its FIFO place on its clone, so every later test on `alpha` waited behind it.
- **Validation.** Each regression test above was checked with its production change temporarily removed: it failed. The change was then restored. Results:
  - `npm run typecheck` and `npx eslint .` pass.
  - The full `npm test` on the rebased commits alone: 1,123 tests, 1,105 passed, one skipped, 17 failed. The seven known failures, plus the ten tests this round fixed.
  - The full `npm test` with this round's changes: 1,131 tests, 1,123 passed, one skipped, and only the seven known failures (six docker-dependent `env-image-build` cases and the `proxy-server` MCP-routing case).

  Nothing was committed, pushed or rebased by this round.
