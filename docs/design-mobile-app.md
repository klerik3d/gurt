# Design notes: the Gurt mobile app

Status: draft for discussion — nothing implemented · Primary design document
for the mobile client of remote access

This is the broad design document for the phone app: what it is for, what it
can do in which phase, how it should look and behave, and the things that are
easy to forget. The transport, crypto and pairing underneath are in
`requirements-remote-access.md` and `requirements-remote-protocol.md`.

> **Decided by the owner.** The mobile app is a native app written in React
> Native (Expo, development builds), distributed through the App Store and
> Google Play, in its own repository `gurt-mobile`. It is its own small UI on
> a small, stable, versioned remote API — *not* the desktop renderer served
> to a phone and not a mirror of `GurtApi`. The remote-access documents are
> reconciled with this. The function list in §3 is the API's scope: a method
> exists because a screen here needs it. Push is native (APNs, FCM), sent by
> the shared relay.

## 1. What it is, and what it is not

**It is the desk, while you are away from it.** Gurt runs agents that work
for minutes or hours and then stop: on a permission prompt, at the end of a
turn, on a plan limit, on an error. Today each of those stops waits for the
user to walk back to the computer. The app exists to make those stops cost
ten seconds from wherever the user is.

Four verbs, in order of importance:

1. **Unblock** — answer the permission prompt the agent is stuck on.
2. **Know** — what is running, what needs me, what finished, what failed.
3. **Steer** — read what the agent did and send the next instruction, or stop
   it.
4. **Ship** — later phases: act on a finished change (commit, push, PR).

**It is not** a second desktop. Configuring Gurt (envs, repos, MCP servers,
skills, credentials, network policy, masking), editing code and terminals
stay on the computer. Reviewing a change does not: diffs are readable on the
phone (phase 2), because "ship" starts with a look at what is shipped. The
app should feel finished at its size, not like the desktop with parts
missing.

## 2. Moments it is designed for

Each moment names the screen that serves it (§4) and the phase (§3).

| # | Moment | What the user wants | Screen | Phase |
|---|---|---|---|---|
| M1 | Phone buzzes: "an agent needs you" | See exactly what is asked, answer, put the phone away | Push → Permission sheet | 1 |
| M2 | Coffee break: "how is it going?" | One glance: running / needs me / done / failed | Inbox, Sessions | 1 |
| M3 | A turn ended | Read the agent's last answer and send the next instruction | Session | 1 |
| M4 | The agent is going the wrong way | Stop the turn now; say what to do instead | Session | 1 |
| M5 | Something failed or hit a plan limit | Know why, and whether it continues by itself | Inbox, Session | 1 |
| M6 | The agent proposed a change | See the commit message and the diff stat; commit and push, or open the PR | Proposal | 2 |
| M7 | A proactive agent raised new scopes overnight | Triage the drafts: run, leave, discard | Inbox | 2 |
| M8 | An idea on the go | Start a session from a draft or a short prompt | New session | 3 |
| M9 | The computer is asleep or Gurt is closed | Understand that, instead of an endless spinner | Host status | 1 |
| M10 | The phone is lost | Cut it off from the desktop | Desktop Settings | 1 |

## 3. Functional scope by phase

The domain is Gurt's: **workspace → scope → session**. The app uses the
desktop's words ("scope", "session", "needs you"), never new ones.

### 3.1 Phase 1 — unblock, know, steer

- **Pairing and hosts.** Pair by scanning the desktop's QR code; name shown
  for the host; "unpair this device" from the phone.
- **Host status, always visible.** Connected / reconnecting / host offline
  (computer asleep or Gurt closed) / relay unreachable / device revoked
  (§6.4).
- **Inbox ("Needs you").** Everything waiting for the user, newest first:
  permission prompts, errors, sessions stopped by a plan limit, finished
  turns not yet seen. Each item opens the right session at the right place.
  Mark read, mark all read.
- **Sessions.** Grouped by workspace and scope, with the desktop's status
  (draft, queued, starting, working, needs you, idle, seen), the agent, the
  role, and one line of the latest activity. Filter: all / active / needs
  you.
- **Session screen:**
  - the chat: user and agent messages (Markdown), thoughts collapsed, tool
    calls as compact rows (kind, title, status) that expand to their
    preview;
  - the agent's plan (todo list) when it reports one;
  - live streaming while a turn runs;
  - queue position and the reason a session is waiting (clone busy, plan
    limit);
  - prompts waiting in the session's queue, each cancellable;
  - context usage when the agent reports it.
- **Permission prompt.** The agent's question with its full detail (command,
  path, diff preview), and its options exactly as the agent offers them.
  Answered on the phone → gone on the desktop, and the reverse.
- **Composer.** Send a message to a started session; while a turn runs, it
  queues, as on the desktop. Long text, paste, OS dictation. A draft
  survives leaving the screen.
- **Stop.** Cancel the running turn.
- **Push notifications.** For `awaiting`, `error` and (opt-in) `proposal`
  and `turn-ended`, mirroring the desktop's notification settings with a
  "phone" column. Tapping one deep-links into the session.
- **Settings (phone side).** Notifications per type, app lock (§5.6),
  paired hosts, about (versions of app, Gurt and protocol).

### 3.2 Phase 2 — ship and triage

- **Run drafts**, enqueue, cancel a queued session.
- **Proposal screen**: the change proposal from the agent's `complete` call —
  commit message, PR title and body, the files changed with line counts.
  Actions: commit, push, open PR, merge to main for a local repo. Each runs
  on the host with the host's git credentials, behind a confirmation.
- **Diff review** of a proposal, file by file: the file list with line
  counts, then one file's hunks fetched when opened and rendered in a
  virtualised view so a large diff does not stall the phone; long lines
  scroll sideways, unchanged context collapses. Repo content does reach the
  phone (encrypted in transit, on a phone screen): decided as wanted, since
  without it the proposal cannot be reviewed. It follows the app lock (§5.6).
  Phase 2 diffs are **read-only**: line comments that go to the agent as
  the next prompt, as in the desktop's manual review
  (`requirements-manual-review.md`), are not in scope for now. The user
  writes remarks to the agent as an ordinary message in the composer.
- **Real values for masked text**, on demand (§5.6).
- **Proactive triage**: scopes raised by proactive agents, with their drafts;
  run, leave, discard.
- **Images in a prompt**: a photo or screenshot, when the agent accepts
  images.
- **Mode and model** of a session (the agent's modes and config options),
  with a confirmation for any mode that widens auto-approval.
- **Plan limits**: each agent account's usage and reset time (the
  dashboard's cards, read-only).
- **Interrupted sessions** after a Gurt restart: resume.

### 3.3 Phase 3 and later

- New session from scratch (pick scope, role, agent, write the prompt).
- Several hosts on one phone (home and work machine), with a host switcher.
- Tablet layout: list and session side by side.
- Reviewer verdicts and "Launch fix" from a review.

### 3.4 Never on the phone

Credentials and sign-in, env and devcontainer settings, the MCP registry,
skills, network policy and allow lists, masking settings and the masking
table, terminals, file editing, Docker cleanup, app updates, workspace and
scope deletion, the remote-access settings themselves. If the user needs one
of these, the app says "on your computer" — it does not hide that the thing
exists.

## 4. Screens

Bottom navigation, three tabs: **Inbox · Sessions · Settings**. The inbox is
the start screen.

| Screen | Content | Primary action |
|---|---|---|
| Pairing | Camera for the QR code | Scan |
| Pair confirm | The six-digit code, "confirm on your computer" | — (waits) |
| Inbox | Needs-you items grouped by kind; host status bar | Open item |
| Sessions | Workspace → scope → session tree, status dots, filter | Open session |
| Session | Header (name, status, agent, role), chat, plan, queue, composer | Send / Stop |
| Permission sheet | Bottom sheet over the session: question, detail, options | Pick an option |
| Proposal (2) | Message, PR text, files ±lines, actions | Commit & push |
| Diff (2) | One file's hunks, from a proposal | — |
| Host status | What is wrong (asleep, closed, relay down, revoked) and what to do | Retry |
| Settings | Notifications, app lock, hosts, about | — |

Wireframes come next, after this document's scope is agreed.

## 5. Design requirements

### 5.1 Look

- **Gurt's look, not a generic mobile kit.** The same dark palette and
  tokens as the desktop (`--app`, `--surface`, `--panel`, `--text`,
  `--dim`, `--accent`, `--green`, `--yellow`, `--red` in
  `src/renderer/src/styles.css`), IBM Plex Sans for UI, IBM Plex Mono for
  code, paths and commands. The desktop is dark-only; the app starts
  dark-only too (§8 Q2).
- **The same status language.** Colour, dot shape and label per status, as
  in `src/renderer/src/status.ts`: working = green pulsing, needs you =
  yellow, queued = accent, draft = hollow faint, error = red. Never colour
  alone: every status also has its word or an icon.
- **Dense, but legible.** Developers read logs; the chat may be denser than
  a consumer messenger, but body text is never under 15 px and code under
  13 px.

### 5.2 Hands and screens

- One-handed: primary actions in the bottom third (composer, sheet options,
  Stop); nothing important in the top corners.
- Touch targets at least 44 × 44 pt; destructive and benign actions are
  never adjacent without spacing.
- Safe areas (notch, home indicator), portrait first; landscape must not
  break, but is not designed for.
- Phone widths from 360 pt; system text size respected up to the largest
  standard setting without clipping.

### 5.3 Chat on a small screen

- Agent output is Markdown: headings, lists, tables (horizontally
  scrollable), code blocks (monospace, horizontal scroll, a copy button,
  no wrapping by default).
- Tool calls collapse to one row each; a turn with 40 tool calls shows as
  "40 steps" with the last few visible.
- Long chats load from the end and fetch older history on scroll; the
  screen never downloads a whole session log to show its last message.
- While streaming, the view follows the end unless the user has scrolled
  up; then a "new output ↓" pill appears.

### 5.4 Acting safely

The app can do things that run code and touch repositories. The UI must make
a wrong tap hard:

- **The permission sheet shows the whole request**: tool, command, paths,
  the diff preview — scrollable, never truncated to fit. Options appear in
  the agent's order and words. Options that allow *always* are visually
  distinct and get a second confirmation.
- **No swipe-to-approve and no approval from the notification itself**
  (decided: notification actions are an easy mis-tap and show no detail).
  Tapping a notification opens the session and the permission sheet; the
  answer is given there, with the whole request on screen.
- **Stale actions fail clearly.** If the prompt was already answered on the
  desktop, or the turn ended, the sheet says so and closes; it never sends
  an answer to a question that is gone.
- **Irreversible actions confirm with their consequence**: "Push 3 commits
  to origin/gurt/checkout-crash?" — not "Are you sure?".
- **The desktop shows what the phone did**: an entry in the chat such as
  "approved from Pixel 8 · 14:02", so the user at the desk is never
  surprised.

### 5.5 Connection and freshness

- Host status is visible on every screen as a thin bar, silent while
  connected.
- Data shown while disconnected is marked stale ("as of 14:02"); actions
  that need the host are disabled, not silently queued. A permission answer
  must never be sent late. A composer draft is kept and can be sent once the
  host is back.
- Reconnect is automatic and fast; the user never presses "reconnect" in
  the normal case.
- When the app goes to the background it stops live streaming; when it
  comes back it catches up from where it left off (`seq`, protocol §7.5).

### 5.6 Privacy on the device

- Notifications on the lock screen are generic ("A session needs you"); no
  session titles, prompts or code (protocol §8).
- Optional app lock: biometric or device passcode through the OS (Face ID /
  fingerprint / passcode), asked on open and after N minutes in the
  background.
- Masked values (`[email:1]`, masking in `architecture.md`) are shown as the
  agent saw them, and the **real value is available on tap**. The phone does
  not hold the masking table: each reveal asks Gurt for that one placeholder
  (`masked.reveal`, audited on the desktop), after the OS biometric or
  passcode prompt regardless of the app-lock timer, and the value is shown
  only while the user holds or has tapped it — it goes back to masked when
  the app leaves the foreground. Phase 2 (with the diffs it is most useful
  in).
- Unpairing wipes everything the app stored about that host.
- No analytics, no third-party scripts, no crash reporter that phones home.
  The app has one network peer: the relay.

### 5.7 Accessibility

- WCAG AA contrast on the dark palette (check `--faint` on `--app`
  especially).
- Every control labelled for screen readers; status dots announce their
  word.
- Reduced motion: no pulsing dots, no animated streaming caret.

### 5.8 Language

The desktop UI is English; the app starts English with all strings in one
place, so a translation is a file, not a refactor.

## 6. Things that are easy to forget

### 6.1 The platform

- **Push needs permission.** The OS asks once; if the user says no, the app
  shows a persistent line explaining that nothing will reach them when it is
  closed, with a button to the system settings.
- **The device key is device-bound.** It sits in the Keychain / Keystore, is
  not backed up or synced, and does not survive a new phone: pairing again
  is a 20-second flow, not a support case.
- **No background connection.** The app does not keep the WebSocket in the
  background (the OS would kill it, and it would drain the battery);
  anything the user must learn while the app is closed arrives by push.
- **The app-switcher snapshot** may show the last screen; the app covers
  its content with a blank view when it goes inactive (platform setting),
  and the app lock (§5.6) gates reopening.
- Badge count on the app icon for "needs you", set when the app runs and
  by the app only.
- **Store rules.** The app is a client of the user's own machine and has no
  accounts or sales of its own; release is by store review, with TestFlight
  and Play internal testing first. Over-the-air JS updates are off
  (remote-access §7.3).

### 6.2 The home machine

- **Gurt must be running**, not just the computer. Offer "start Gurt at
  login" on the desktop when remote access is turned on.
- **Sleep.** The desktop keeps the machine awake while remote access is on
  (remote-access §9.3); the app explains "asleep" when it happens anyway.
- **Gurt restarting** (update, crash): the app shows "Gurt is restarting"
  rather than "offline", if the host said goodbye (close reason 5).

### 6.3 Two screens on one session

- The desktop and the phone may have the same session open. Every action
  is idempotent or rejected when stale (§5.4); read state ("seen") is shared.
- Two phones, one host: all paired devices receive the push; answering on
  one clears it on the others.

### 6.4 States that need a designed screen, not an error toast

Not paired yet · pairing code shown, waiting for the desktop · pairing
rejected or expired · device revoked · host offline · relay unreachable ·
Gurt version too old or too new for the app · no workspaces or no sessions
yet · a session deleted while open · the agent's adapter crashed · plan
limit reached · masking engine down (turn ended with an error).

### 6.5 Notifications that do not become noise

- One notification per session, replaced as its state changes, not one per
  event.
- `turn-ended` is off by default (as on the desktop).
- Quiet hours are the OS's job; the app does not reinvent them.
- A notification for something already handled on the desktop is
  withdrawn.

### 6.6 Data and battery

- Tool outputs and diffs are fetched when expanded, not with the chat.
- A long session on a slow connection opens in under two seconds to its
  last screen of messages.
- Images in prompts are downscaled on the phone before sending.

### 6.7 Versions

- The app, Gurt and the protocol move independently. The app shows "Gurt
  needs updating" or "the app needs updating" with the versions, never a
  generic failure (remote-access §7.2, protocol §7.1).

## 7. What the remote API needs (derived)

Phase 1, from §3.1 — the whole surface the phone can reach:

- read: the session tree with statuses, one session's chat page by page,
  its plan, queue and pending prompt, one tool output on expand, the inbox;
- act: answer a permission prompt, send a message, cancel a pending
  message, stop a turn, mark notifications read, unpair this device;
- events: tree changed, session changed, session log records, notification,
  notification read, host state;
- push: register and unregister the device token.

Phase 2 adds run/enqueue, the proposal and its actions, the diff (file list,
then one file's hunks), revealing one masked value, proactive triage, modes
and config options, plan usage, resume interrupted.

The method names and shapes are in `requirements-remote-protocol.md` §7.2.

## 8. Open questions

Decided, and no longer open: the app is a React Native app on its own small
remote API; no approval from the notification; diffs on the phone; real
values for masked text, on demand (§5.6); diffs are read-only in phase 2,
with no line comments for now (a possible later addition).

1. **Diff weight.** A large proposal can be megabytes. Cap per file and
   offer "open on the computer" past it, or always page?
3. **Light theme** — the desktop has none. Does the phone need one for
   daylight?
4. **Name and icon** — "Gurt" or "Gurt Remote" as the store listing and home
   screen name.
5. **Tablet** — phase 3, or never?
6. **Quick reply.** With approval from the notification ruled out, is a
   text reply from the notification (no approval, just "continue") worth
   having later?
