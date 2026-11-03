# Requirements: plan limits gate launches and resume interrupted sessions

Status: implemented · Target: gurt Electron MVP (this repo)

Follow-up to `docs/requirements-dashboard.md`, which reads each account's plan
windows. This document makes those numbers *decide* things: an account at its
limit gets no new work, and a session a limit cut off picks up again by itself.
Key code: `src/shared/planUsage.ts` (`planHold`, `LimitSettings`),
`src/main/planUsage.ts` (live-event and poll parsing, `peek`),
`src/main/sessions.ts` (`limitHold`, `withLimit`, `onLimited`), `src/main/kernel.ts`
(the `planHold` hook, `setLimitSettings`).

## 1. When an account is held

- **Per account, not per agent.** A plan is pooled over its credential, so every
  agent instance on the same `credentialId` shares one hold. Whichever of them
  read the plan last speaks for all of them.
- **Simple metrics.** Every window counts the same, model-scoped weeks included.
  If that turns out to hold sessions back needlessly, it gets refined then.
- **Threshold.** A window at or past `thresholdPercent` holds the account
  (Settings → Clients, one global value, default 95, range 50–100;
  `~/.gurt/limits.json`). Below 100 on purpose: a long task started at 99% is
  cut off mid-way, and Codex's numbers come from a poll that runs every 3 minutes.
- **Until the reset, with a check on top.**
  - A window whose `resetsAt` has passed stops counting, even before a fresh
    read comes in.
  - A window with no reset counts only while its read is fresh.
  - A fresher read lifts the hold before the reset time, for example after an
    early OpenAI reset. `usage.changed` re-runs the scheduler, and a timer
    re-runs it when the earliest hold is due to lift.
- **Overage lifts the hold.** Anthropic extra usage (switched on and not spent),
  Codex credits, or a live event whose `overageStatus` is allowed.
- **A stated refusal always holds,** overage or not, until its own reset. That is
  a live event with `status: rejected`, or a turn the limit detector claimed
  (§3), recorded on the account via `agent.limited`.

## 2. What a hold does

- **Launch.** The draft pane has a single **Run**, and it goes through the queue.
  It starts at once when nothing is in the way, and otherwise waits instead of
  failing. `run()` on main falls back to the queue on a held account, the same
  way it already does for a task at its concurrency cap.
- **Queue.** A held item is skipped and keeps its place. It claims neither its
  clone nor a slot under its task's cap, so items on other accounts move on.
  The pane says why it is waiting (`SessionSnapshot.waiting`).
- **Queued messages** of a started session wait the same way (`drainPending`).
  `pendingBlocked` names the limit and the reset.

## 3. Interrupted sessions continue on their own

- **Detection** (`withLimit`). Any of these marks a turn as a limit hit:
  - a live rate-limit event during the turn said `rejected`;
  - the thrown error or the non-`end_turn` stop reads like a limit;
  - the agent's whole reply is a short limit notice. Claude Code answers a
    refused turn with plain text and a clean `end_turn`.

  Each hit is logged as `turn.limited` with the signal that fired, so a miss or
  a false hit can be traced to what the adapter actually sent. The exact shape
  Claude Code's ACP adapter uses for a refusal has not been captured yet, which
  is why all three signals are kept.
- **No nudge.** A limit hit is never followed by the `complete` nudge. The nudge
  would be refused too.
- **The resume** (`onLimited`). The session records `limitedUntil`, which is
  persisted. The value is the reset the refusal named, else the account's own
  hold, else a backoff: 15 minutes, doubling with each consecutive hit, capped
  at 5 hours. The session then queues an automatic `continue`, shown as `auto`
  in the message queue. When the hold lifts, the message is sent.
  - A restart puts the `continue` back.
  - A message the user typed meanwhile replaces it.
  - Cancelling the row (or Esc) withdraws the resume.
  - A turn the provider accepts clears the record.

## 4. Not done (yet)

- **Keep the clone for the interrupted session.** While a cut-off session waits
  (hours, possibly), its container idles out and its clone is released. The
  next queued session on the same repo then starts on top of a half-done
  working tree. Better: the limit-interrupted session keeps a claim on its clone
  until it continues. The claim has to be **visible** (the waiting session and
  the blocked ones say so) and **releasable** by hand, so a dead resume cannot
  block a repo forever.
- Model-aware windows (an Opus week holding only Opus sessions), and switching
  to another model instead of waiting.
- Notifications for "hit a limit" and "continued after the reset".
