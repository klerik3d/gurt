# Requirements: notification system

Status: implemented · Target: gurt Electron MVP (this repo)

This document is a work order for an implementing agent. Read `README.md`
first. Key code: `src/shared/events.ts` (domain bus event map),
`src/main/bus.ts`, `src/main/kernel.ts` (subscriber wiring, see the idle
auto-stop policy for the pattern), `src/main/store.ts` (`agents.json`
read/write pattern for a new global config file), `src/main/ipc.ts`,
`src/preload/*`, `src/renderer/src/App.tsx` (titlebar `tb-icons`),
`src/renderer/src/status.ts` (the dot-tone grammar), `src/renderer/src/
components/SettingsPage.tsx` (settings section pattern). Do not change the
contract described here without asking the owner.

## 1. Motivation

Today the only "notification" is passive: a colored dot on a session's
sidebar row (`SESSION_DOT` in `status.ts`), visible only while that row is
on screen in the current workspace. Nothing tells the user *across*
workspaces/tasks that a session now needs them, finished with something to
review, or died. This spec adds an active, cross-cutting layer on top of
the existing domain bus (`docs/requirements-event-bus.md`) — no new source
of truth, just a subscriber that turns select bus events into user-facing
notifications, an on/off matrix per notification type, and a place to see
history. External delivery (Slack/email/webhook/OS push) is a stub in this
slice: the seam and the per-type toggle exist, nothing actually sends yet.

## 2. Notification types — what fires, and when

Four types in v1, each mapped to existing bus events (`src/shared/
events.ts`). No new domain events are introduced except where noted.

| Type | Fires on | Default: in-app | Default: external |
|---|---|---|---|
| `awaiting` — needs your input | `session.awaiting` transitioning to `awaiting: true` (a permission request is now pending) | on | on |
| `proposal` — changes ready to review | `session.proposal` (a `complete` call stored a proposal, i.e. outcome=changes) | on | off |
| `error` — session or container failed | `session.state` with `reason: 'start-failed'` (or any `err` present), `container.status` with `status: 'error'`, or `session.adapterExited` while the session was `running`/`waiting` (i.e. not a user-initiated stop) | on | on |
| `turn-ended` — turn finished, nothing to review | `session.turn` `phase: 'ended'` with no accompanying `proposal` | off | off |

Rules:

- `awaiting` fires once per `false → true` transition, not on every bus
  replay; it clears itself (no separate "resolved" notification) when the
  session stops awaiting or is opened.
- `error` and `proposal` are terminal per turn — at most one of `error` /
  `proposal` / `turn-ended` fires per turn-ended transition, in that
  priority order (an error supersedes "nothing to review").
- Env image build failures (`envBuildImage` in `SettingsPage.tsx`) are
  already surfaced inline in the Environments section synchronously — not
  wired into this system in v1 (see Non-goals).

## 3. Storage — per-type on/off matrix

New global file `~/.gurt/notifications.json`, same tier as `agents.json`
(`gurtRoot`, not per-workspace) and the same `readJson`/`writeJson` helpers
in `store.ts`:

```ts
// src/shared/notifications.ts
export type NotificationType = 'awaiting' | 'proposal' | 'error' | 'turn-ended'

export interface NotificationTypePrefs {
  inApp: boolean
  external: boolean
}

export type NotificationPrefs = Record<NotificationType, NotificationTypePrefs>

export const NOTIFICATION_DEFAULTS: NotificationPrefs = {
  awaiting: { inApp: true, external: true },
  proposal: { inApp: true, external: false },
  error: { inApp: true, external: true },
  'turn-ended': { inApp: false, external: false }
}
```

A missing key (fresh install, or a type added later) falls back to its
default — `readJson(notificationsFile(), {})` merged over
`NOTIFICATION_DEFAULTS`, mirroring how `agents.json` tolerates partial
files.

IPC: `getNotificationPrefs()`, `setNotificationPrefs(prefs)` — same
call/return shape as `getAgents`/`setAgents`.

## 4. Where it's shown in the app

### 4.1 Bell in the titlebar

`tb-icons` in `App.tsx` (next to the existing Search/Settings buttons)
gains a bell button with an unread-count badge (small filled circle,
hidden at 0, caps display at e.g. `9+`). Click toggles a popover panel
anchored under it — same interaction family as `CommandPalette`, not a
full `Modal`.

### 4.2 Notification panel (popover)

Reverse-chronological list, each row:

- a dot using the existing tone grammar (`status.ts`): `awaiting` → yellow,
  `proposal` → green, `error` → red;
- `<workspace> / <task> · <session title>`;
- one-line detail (e.g. "waiting on a permission request", "ready to
  review", the error message);
- relative timestamp.

Click a row → navigates like a sidebar click (`onSelectSession`/
`onSelectTask`, switching workspace/view as needed via the same `curWs`/
`selection` plumbing already in `App.tsx`), marks it read, closes the
popover. Header actions: "Mark all read", and a per-item dismiss (×).
Reading a session's own `awaiting`/turn state some other way (opening it
from the sidebar) also marks its pending notification read — dedupe by
`sessionId` when marking, not just by explicit panel interaction.

### 4.3 Relationship to the existing sidebar dots

The sidebar's `SESSION_DOT` stays exactly as is — it's the ambient,
always-current status of a *visible* row. The notification panel is the
catch-up surface for what happened while a row was *not* visible (another
workspace selected, window unfocused, app not running when it could poll
on launch — though replay-on-launch is out of scope, see below). Same
source events, two different presentations; no new status logic.

### 4.4 Settings → Notifications

New `SettingsSection` value `'notifications'`, added to the nav list in
`SettingsPage.tsx` next to `environments`/`repos`/`clients`/`credentials`.
One row per `NotificationType` from §2's table, two on/off controls per
row (in-app, external) — reuse the existing pill-button pattern used
elsewhere in this file (no checkbox component exists yet; two small
toggle buttons, matching the visual weight of e.g. the `tag`/`btn-link`
elements already in this file). The External column carries a small hint
next to the section title — `stub — not sent anywhere yet` — the same way
`CredentialsSection` flags kinds that are "stored, runtime not wired yet".

## 5. Implementation notes

- `src/main/notifications.ts` — subscribes to the bus
  (`session.awaiting`, `session.proposal`, `session.turn`,
  `session.state`, `container.status`, `session.adapterExited`),
  resolves each into at most one `NotificationRecord`, keeps an in-memory
  ring buffer (cap ~200, oldest dropped), and:
  - if `prefs[type].inApp` → append to the buffer, emit a new bus event
    `notification.created: NotificationRecord` (add to `DomainEvents` in
    `src/shared/events.ts`);
  - if `prefs[type].external` → call `sendExternal(type, record)` from
    `src/main/notify-external.ts` — the stub: log via the existing logger
    (`src/main/log.ts`) and resolve, no network call. This is the seam a
    later Slack/webhook/email/OS-push implementation replaces; nothing
    else in this spec changes when it does.
- Wire `createNotifications(bus, prefs)` in `kernel.ts` next to the idle
  auto-stop subscriber — same "plain subscriber over the bus" shape.
- `ipc.ts`: forward `notification.created` → renderer channel
  `notification`; add `getNotifications()`, `markNotificationRead(id)`,
  `markAllRead()`, `getNotificationPrefs()`, `setNotificationPrefs()`.
- `NotificationRecord`:
  ```ts
  interface NotificationRecord {
    id: string
    type: NotificationType
    sessionId: string
    ref: EnvRef
    title: string   // "<task> · <session title>"
    detail: string
    ts: string       // ISO
    read: boolean
  }
  ```
- Renderer: `App.tsx` loads `getNotifications()` once, subscribes to
  `onNotification` for live pushes (same pattern as `onSessionTurn`),
  derives the unread badge count; new `components/NotificationsPanel.tsx`
  for the popover; `SettingsPage.tsx` gains a `NotificationsSection`.
- Implementing §2's rules precisely needs a few small, additive changes to
  existing domain events (not new sources of truth, just enough for the
  subscriber to tell cases apart it otherwise can't):
  - `session.turn`'s `ended` phase gains `final: boolean` — false only for
    the internal nudge turn's own boundary (`SessionManager.runPrompt`'s
    healing follow-up), so `turn-ended` fires once per user-visible turn,
    not once per `sendTurn` call.
  - `session.adapterExited` gains `wasLive: boolean` — true when the session
    was busy or awaiting a permission at the moment the adapter died, so
    `error` only fires for the "while running/waiting" case §2 actually
    names, not an idle session whose container was killed out-of-band.
  - Two new events used only by the notifications subscriber itself:
    `session.deleted: { sessionId }` (prunes ring entries and per-session
    bookkeeping for a deleted session) and `notification.read: { sessionId }`
    (mirrors a server-side read — `awaiting` clearing, or opening a session
    another way — back to every renderer window).

## 6. Non-goals (explicitly out of scope)

- Any real external channel (Slack, email, webhook, OS-native push) —
  stub only, per §5.
- Per-workspace, per-task, or per-session muting — v1 prefs are global
  per type.
- Snooze / do-not-disturb schedules, quiet hours.
- Sound effects.
- Persisting notification history across app restarts (the ring buffer is
  in-memory; a relaunch starts empty) or replaying missed events from
  before the process was running.
- Env image build failures and other Settings-local errors already shown
  inline (§2).
- OS dock/taskbar badge count (`app.setBadgeCount`/`app.dock.setBadge`) —
  cheap to add later off the same unread counter, but not required here.

## 7. Acceptance

1. An agent's permission request (`session.awaiting: true`) on a session
   in a non-selected workspace lights the bell badge; opening the panel
   and clicking the row switches workspace/selection to that session and
   clears its unread state.
2. A `complete` call with `outcome: 'changes'` produces a `proposal`
   notification; one with `outcome: 'no_changes'` produces a `turn-ended`
   notification only if that type's `inApp` pref is on (default off, so
   nothing appears by default).
3. A session that fails to start, or whose container reaches `error`,
   produces exactly one `error` notification — not also a `turn-ended` or
   `proposal` for the same turn.
4. Toggling a type's in-app pref off in Settings → Notifications stops new
   notifications of that type from appearing; existing ones already in the
   panel are unaffected.
5. Toggling external on/off does not change in-app behavior; with the stub
   in place, no network activity occurs regardless of the toggle state —
   verified by the stub's log line firing (or not) per the toggle.
6. Existing behavior intact: sessions, queue/drafts, permissions, modes,
   provisioning, repo CRUD, env stop/delete, task delete, the Changes
   panel.
