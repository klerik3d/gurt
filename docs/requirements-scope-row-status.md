# Requirements: scope row status — sessions, review and delivery

Status: partial — phases 1–2 built (the strip, sessions, review, gray delivery; see §11); phase 3 planned · Target: gurt Electron MVP (this repo)

Key code: `src/renderer/src/components/ScopeRow.tsx` (`ScopeStrip`),
`src/renderer/src/scopeStatus.ts` (slot mapping),
`src/renderer/src/components/Sidebar.tsx` (scope inputs),
`src/renderer/src/status.ts` (colour grammar and mapping),
`src/renderer/src/components/icons.tsx` (icon style),
`src/shared/types.ts` (`SessionStatus`, `SessionInfo`, `RepoChanges`),
`src/rpm/core/model.ts` (`RunStatus`, `CallReason`),
`src/rpm/ui/useRpm.ts` (per-executor read for the Review tab),
`src/renderer/src/useRpmOverview.ts` (the sidebar's all-executor read, `rpmOverview`),
`src/renderer/src/components/Dashboard.tsx` (last-turn error and incomplete display).

## 1. Motivation

Scopes are collapsed by default. A collapsed row must answer “where is my
attention needed?” without opening its sessions or repositories. A fixed strip
at the right of the scope row replaces `ScopeBadge`. The UI says *scope*.
The tree model calls these rows *tasks* (`Tree.workspaces[].tasks`).

## 2. Grammar

The slots are sessions, review (RPM), delivery, in that order. Icon shape
identifies the slot and stays fixed. Colour identifies the state. Each slot
shows its most urgent state: red > yellow > green > blue > gray.

The colour rule is “will this change without the user?”

| Colour | Meaning |
| --- | --- |
| Red | Something broke and will not recover on its own. |
| Yellow | It stays this way until the user acts. |
| Green | Work is under way and will change state on its own soon. |
| Blue | It can change without the user, after a queue, a limit or someone else's work. |
| Gray | The slot applies and has nothing to report. |

## 3. Slots

### Sessions

Always present. Aggregate over the scope's sessions. Reviewers contribute
through the review slot.

| Colour | State |
| --- | --- |
| Red | Last turn errored, session has a `startError`, container is in `error`, or the turn is `incomplete` (ended without `complete` after the nudge). |
| Yellow | `awaitingInput`, idle and unseen (`SessionStatus` is `idle`) with no RPM flow continuing after it, or an agent-drafted draft (`draftedBy`) waiting to launch. |
| Green | `running` or `starting`. |
| Blue | `queued` or waiting for the plan limit (`limitedUntil`). |
| Gray | Everything else, including user-created drafts and `idle-read`. |

### Review (RPM)

Present when at least one executor in the scope has RPM enabled. Aggregate
`RunStatus` across those executors using the same urgency order.

| Colour | State |
| --- | --- |
| Red | `called` with `why` equal to `check-red`, `check-error`, `reviewer-failed` or `executor-failed`. |
| Yellow | `called` with `why` equal to `findings`, `idle-executor`, `budget`, `check-unchanged` or `executor-blocked`. |
| Green | `check`, `fix-check`, or `review` without `waitingPlan`. |
| Blue | `review` with `waitingPlan`, or `executor` while the cycle waits for fixes. |
| Gray | `passed`, `paused`, `ended`, or enabled with no run yet. |

### Delivery

| Display | State |
| --- | --- |
| Gray | At least one repo differs from its default branch. A repo qualifies when `dirty` or when `!integrated && commits.length > 0`. |
| Absent | The scope has no repos or none qualifies. |

## 4. Row behaviour

- Gray icons are visible in a tone quieter than `--dim`. An absent icon
  leaves its full slot width reserved.
- Icons are static, with no pulse or blink. Their shapes follow the style
  of the existing sidebar icons. The mockup's shapes are placeholders.
- Any yellow or red slot raises the passive scope name from `--dim` to
  `--text`.
- Each visible icon has a tooltip explaining its state in words and naming
  the relevant session, reason or repo. Delivery details include commit
  counts where applicable.
- The chevron shows whether the scope is expanded or collapsed. The strip
  stays visible in both states, with the same width and position. The row
  follows [the sidebar row geometry](design-sidebar-rows.md).

| Example | Sessions | Review | Delivery |
| --- | --- | --- | --- |
| One session needs permission and another is running. RPM is off and the repo has edits. | Yellow | Absent | Gray |
| A running session and a queued session share a scope with no RPM or repo differences. | Green | Absent | Absent |
| An executor has settled and RPM is reviewing its changes. | Gray | Green | Gray |
| A session and a reviewer are waiting for plan limits. The scope has no repo differences. | Blue | Blue | Absent |
| An executor is fixing findings and RPM is waiting for it. The repo has changes. | Green | Blue | Gray |
| An executor's last turn errored while other sessions still run. RPM is enabled and settled. The repo has changes. | Red | Gray | Gray |

## 5. Scope summary data

- The Dashboard session board derives the last turn from the usage ledger
  and renders last-turn errors and `incomplete`. The sidebar summary needs
  both signals. An active plan-limit wait is blue under the strip's rules.
- The sidebar does not map `limitedUntil` or `queueWaiting` into the
  scope summary today. Carry the wait and its explanation into the summary.
- `useRpm` reads status and configuration per executor over IPC. The
  sidebar needs a per-scope aggregate of enabled executors and their
  current states without per-executor IPC round trips on each render.
- Keep the slot mapping in one pure, unit-tested function beside the
  existing status mappings. Record the strip's colour rule in `status.ts`.

## 6. Alternatives considered

- A free-form sequence of counts and git-prompt tokens such as `~4 ↑2 ⇡`
  put too many facts on the row at once. Combinations were hard to scan.
- A delivery track of stage segments exposed several stages at once.
  Combinations across stages and repos were hard to read on one row.

## 7. Phases

1. Fixed strip, sessions mapping and gray delivery presence. Reserve the
   review slot.
2. Review mapping and the per-scope RPM aggregate.
3. Later, delivery colours for unpushed work (yellow), pushed work awaiting
   merge (blue) and conflicts (red), plus PR and CI stages. Delivery colours
   extend the mapping within the same slot.

## 8. Non-goals

- Counts or git-prompt tokens on the row, or a separate delivery icon per
  repo or stage.
- New session, review or delivery controls on the strip.
- Changes to sidebar row geometry or expand/collapse behaviour.

## 9. Acceptance

- In both themes, expand and collapse a scope. The chevron reflects the
  state and the strip stays aligned at the right of the row. Gray icons
  are visible and absent icons leave gaps in their own columns.
- With two running sessions and one waiting for permission, the sessions
  slot shows one static yellow icon. With one failed turn and two running
  sessions it shows one red icon. A running session outranks a queued one.
- A passive scope name uses `--text` with any yellow or red slot and
  returns to `--dim` when those states clear. Tooltips identify the sources
  of the displayed states.
- A dirty repo or unintegrated commits show gray delivery. After all repos
  are clean and integrated or have no commits relative to their default
  branches, the delivery icon disappears and its width stays reserved.
- In phase 2, an enabled executor with no run yields gray review. Across
  executors, a red call outranks an active review, and review waiting for
  a plan limit is blue. A scope with no enabled executor leaves the slot
  empty. An idle unseen executor with RPM continuing contributes no
  unseen-result yellow to sessions.
- Unit tests cover slot presence, colour mappings and urgency precedence.
  Check the strip in the running app in both themes.

## 10. Open questions

- Is yellow for an unseen result too noisy?
- Should an agent-drafted draft waiting to launch be yellow?

## 11. As built

### Phase 1

- Code. `src/renderer/src/scopeStatus.ts` holds the pure mapping:
  `sessionState` (one session), `sessionsSlot`, `repoDelivery` with
  `DELIVERY_TONE` and `deliverySlot`, `scopeStatus` and `scopeWantsUser`.
  `status.ts` gained `URGENCY`, `moreUrgent` and `turnFailed`, and its colour
  grammar comment now states the strip's rule. `ScopeRow.tsx` draws
  `ScopeStrip`, which replaces `ScopeBadge`. The `.task-badge` CSS is gone.
  The new icons in `icons.tsx` are `agent-head` (sessions), `review-cycle`
  (review) and `branch-out` (delivery). Tests are in
  `scripts/scope-status.test.mjs`. `scripts/smoke-files-mode.mjs` checks that
  the columns line up across the Agents, Git and Files panels.
- Wiring. App computes one `ScopeStatus` per scope and passes the same value
  to `Sidebar` (Agents, Git) and `FilesSidebar`. Archive rows have no strip.
- Sources. The last turn comes from the usage ledger through `lastTurns`
  (`reviewed.ts`). The Dashboard now uses the same helper, and both read
  failure through `turnFailed`. `startError` is read off the session
  snapshot, because main does not persist it: a failed start shows only
  from that failure until the next start or an app restart, as in the
  session pane. The container's `error`, `incomplete`, `limitedUntil` and
  `queueWaiting` come from the tree record.
- Per-session order. Each session gets one state, checked in this order
  rather than by urgency alone:
  1. a failed start, a container error or `incomplete` (red);
  2. waiting for permission (yellow);
  3. running or starting (green);
  4. queued (blue);
  5. a draft: yellow if an agent drafted it and it has not been handed off,
     gray otherwise.

  An idle session then goes through:
  1. `limitedUntil` (blue);
  2. a failed last turn (red);
  3. its RPM flow: check or review is green, a queued review blue;
  4. `queueWaiting` (blue);
  5. unseen (yellow), else gray.

  The slot then takes the most urgent session. As a result, a turn cut off
  by a limit is blue while the session waits to continue by itself, and red
  only when no wait is pending. A failed last turn is red for an idle
  session even while RPM works around it. It does not colour a session
  that is in a turn again, waiting for permission, queued or starting: the
  ledger records only finished turns, so its last record is then an
  earlier turn's. The Dashboard likewise reads it for idle sessions only.
- Phase 1 stop-gap. An idle executor's RPM flow is read in the sessions
  slot. A comment in `sessionState` marks where phase 2 moves it to the
  review slot, keeping only the "no unseen yellow while a flow continues"
  rule.
- Delivery. Each differing repo is already classified as `conflict`, `local`
  (uncommitted or unpushed) or `pushed` (awaiting merge). `DELIVERY_TONE`
  maps all three to gray, so phase 3's colours change that table only. The
  old badge's blue "actionable" dot and hollow "delivered" ring are replaced
  by this one gray slot.
- Rendering. Gray is `--faint`. The strip has three `--row-icon` columns,
  4px apart, at the right of the row after the proactive label tag. The
  review column is reserved and stays empty. Tooltips list each session
  with something to report, most urgent first, then count the quiet ones.
  The delivery tooltip lists each differing repo with its commit counts.
- Not changed. A session row's own dot keeps its grammar: an idle session
  whose last turn failed still shows the idle dot, and only the strip shows
  red.
- Checked in the running app in both themes, in the Agents and Files panels,
  with a fixture store. Green was not seen live because there was no Docker;
  the unit tests cover it. A pre-existing, unrelated failure:
  `env-image-build.test.mjs` (6 tests, no docker binary).

### Phase 2

- Data. `Rpm.overview()` (`src/rpm/main/rpm.ts`) returns one `RpmBrief`
  (`src/rpm/core/model.ts`) per executor session: `enabled` from its
  config, and `live` and `status` of its last run, through the same `view`
  and engine decoration as `rpmState`, so `waitingPlan` is the same. A
  draft executor is included. IPC exposes it as `rpmOverview()` in
  `shared/api.ts` and `main/ipc.ts`. The preload bridge is generic, so
  `preload/api.d.ts` needed no change. Its exposure is `none`: it spans every
  workspace, and an operator is scoped to one and reads `rpmState`
  instead. The renderer reads it once in `useRpmOverview`
  (`src/renderer/src/useRpmOverview.ts`) and reads it again on every `rpm`
  event. Only one read is in flight at a time, and a burst of events ends in
  one more read. The `rpm` event already covers configuration changes and a
  reviewer's plan hold (the engine's poll emits it), and now an executor
  copied by Duplicate or Recreate: the engine emits after writing the
  inherited config. App passes each
  executor's brief into the session's `SessionInput.rpm`.
- Presence. Only executors with RPM on count, for presence and for the
  colour. One whose RPM was just turned off leaves the slot at once, even
  though its run lasts to its next boundary. The slot is absent when no
  executor in the scope has RPM on, and its column stays reserved.
- Mapping. `reviewTone` and `CALL_TONE` in `scopeStatus.ts` implement the
  §3 table. `reviewSlot` takes the most urgent executor. Its tooltip lists
  every counted executor, most urgent first, with `statusLine`
  (`rpm/ui/labels.ts`, reached through `rpm/ui`), or "review on — no run
  yet". This list does not count quiet executors the way the sessions slot
  does, because a scope has few and "Passed" or "Paused" is worth reading.
  `statusLine` now takes only `status` and `live`.
- Stop-gap moved. In the sessions slot, an idle executor with a check or
  review `flow` is gray and no longer green or blue, and an unseen result
  does not turn it yellow. A waiting message (`queueWaiting`, blue) is now
  checked before the flow, so a gray flow cannot hide it. In the phase 1
  per-session order for idle sessions, step 3 is now "a waiting message
  (blue)" and step 4 is "its RPM flow (gray)". `FLOW_DOT` still marks the
  session's own dot.
- Tests. `scripts/scope-status.test.mjs` covers each `RunStatus` and
  `CallReason` tone, presence (off with a live run is absent), precedence
  across executors, tooltips, the flow now reading gray in sessions, and
  the mockup's combined rows. `scripts/rpm-wiring.test.mjs` covers
  `overview()` on the kernel and the method's exposure.
  `scripts/rpm-engine.test.mjs` covers the event after a copy.
- Checked in the running app in both themes with a fixture store of four
  scopes, each with one executor. RPM off left the review column empty. RPM
  on with no run was gray. A review in progress was green, and the
  executor's sessions slot was gray. A `check-red` call was red and raised
  the scope name. Turning RPM off and on through IPC removed and restored
  the gray icon on the `rpm` event alone.
