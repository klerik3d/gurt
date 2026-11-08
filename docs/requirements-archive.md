# Scope and session archives

Status: implemented.

The scope context menu offers **Archive scope**. Session context menus and
the session actions menu also offer **Archive session**. Finish or cancel
running/queued work first; unsent draft images must be removed before archiving.
An archived scope disappears from the work list. Archiving one session leaves
its scope and sibling sessions in place.

The activity bar's **Archive** view shows archived scopes and sessions with
creation/archive dates, compressed size, chat preview, **Restore**, **Pin**
and deletion. Chat preview reuses the normal message/tool display without a
composer, queue controls, configuration editing or permission actions.
The list shows archives for the selected workspace.

## Storage and recovery

Archives live outside workspace trees, under `~/.gurt/.archives/`:

- `<id>.json`: metadata, session summaries, pin and dates;
- `<id>.jsonl.gz`: versioned streaming container with directories, files in
  bounded chunks, SHA-256 checksums, symlinks and a completion marker;
- `<id>.previews/`: independently compressed chat snapshots and masking tables.
  Preview reads only the selected chat, without extracting the scope or reading
  repository contents.

Archives contain only Gurt-owned configuration and conversation state:
`task.json`, `sessions.json`, session chat logs, review/proactive state,
native agent history and masking tables. Packing uses an explicit allow-list;
repository clones, `.git`, dependencies, build output, caches and generated
session mounts/skills are excluded before compression. A session archive
contains only that session's state; sibling sessions and the parent scope stay.
Containers are removed before packing. Shared Docker images/caches remain
governed by Docker cleanup settings.

Restore recovers configuration and chats, not local repository files or commits.
Repositories and generated session mounts are recreated through the normal
session startup flow. Existing archives from earlier versions keep their original
contents until explicitly replaced.

Compression is lossless. The archive is completely validated before source
retirement. Failed compression leaves the live scope/session available.
Scope retirement renames the original directory only after the compressed
archive and metadata are written and synced. A crash before retirement may
leave a duplicate compressed copy; a crash after it leaves a usable archive.
File checksums, hierarchy validation and deferred symlink creation prevent
partial/corrupt archives from being restored over existing scopes. Extracted
files retain executable bits and modification times. Restore refuses name or
session ID conflicts and removes the archive only after restoring the data.

Native agent resume retains the same per-provider limitations as ordinary
container recreation. If a workspace was deleted, recreate/configure that
workspace before restoring its archives. Archives survive workspace deletion.

## Automation

Settings → **Archive** stores host-wide policy in `archive-settings.json`.
Both automatic rules default to **off**. The timer runs one minute after boot,
then every five minutes; **Run rules now** applies enabled rules immediately.

Autoarchive requires all sessions to be read since their last recorded activity,
started and idle longer than the configured number of hours. It excludes scopes
with drafts, queued/running work, pending prompts, permission/recovery/limit
holds or open terminals. Every repository must be inspectable and have neither
uncommitted/untracked work nor unpushed work in its delivery thread. A failed
repository inspection prevents autoarchiving. Proactive agent scopes are excluded.

Read stamps remain owned by the renderer and are mirrored to durable session
metadata for background policy. Read state is compared with the last chat update;
the idle timer also counts composer activity, file edits and Git actions.
Legacy sessions with unknown read/activity state
do not qualify until their state is known. Restoring resets activity to now.

Autodeletion permanently removes unpinned archives older than the configured
number of days, measured from **archive time**. The pin is checked again under
the same lock as deletion, including manual deletion. Unpin before deleting.
Restore is allowed for pinned archives and consumes the archive on success.

## Validation

`scripts/archive.test.mjs` exercises archive integrity, extraction safety,
scope/session restoration, masking-table preservation, failed compression,
name collisions, pin protection, retention and real-Git automatic eligibility.
`scripts/archive-ui.test.mjs` verifies that archived chats expose no composer
or permission actions.
