# Requirements: append-only session log

Status: implemented · Target: gurt Electron MVP (this repo)

This document is a work order for an implementing agent. Read `README.md`
first. Key code: `src/main/{sessions,store}.ts`, `src/shared/types.ts`,
`src/main/ipc.ts`, `src/preload/*`, `src/renderer/src/components/Chat.tsx`.
Do not change the contract described here without asking the owner.
Depends on: `requirements-kernel.md` and `requirements-event-bus.md`
(merged first).

## 1. Motivation

Chat entries are mutated in place (streaming appends to the last entry,
tool updates patch by id) and the **full** snapshot is broadcast per
streaming chunk — O(history) IPC per token. Entries persist as mutable
state inside `sessions.json`. The planned inter-agent message log and
orchestration replay need an append-only, seq-numbered record stream;
the stored format must migrate while the data is small.

## 2. Log model — `src/shared/types.ts`

```ts
export type SessionLogRecord =
  /** New timeline entry; entry.id is unique and ascending per session. */
  | { seq: number; type: 'entry'; entry: ChatEntry }
  /** Streaming text delta appended to a ChatText entry. */
  | { seq: number; type: 'append'; id: number; text: string }
  /** In-place update of a tool call / permission entry. */
  | { seq: number; type: 'patch'; id: number;
      patch: { status?: string; title?: string; detail?: string; chosen?: string } }

/** Pure fold used by BOTH main (derive) and renderer (apply deltas). */
export function applyLog(entries: ChatEntry[], records: SessionLogRecord[]): ChatEntry[]
```

`applyLog` returns a new array; unknown `id`s and unknown record types are
ignored (forward compatibility). `seq` is monotonic from 1 per session.

## 3. SessionManager changes

- `Session` holds `records: SessionLogRecord[]` and derived `entries`
  (updated incrementally via `applyLog` — never refolded from scratch).
- One writer: `private append(s, record)` — assigns `seq`, pushes,
  applies, emits (see §5). All current mutation sites route through it:
  `push()` → `entry`; streaming chunk merge → `append`; `tool_call_update`
  and `respondPermission` → `patch`.
- `modes` / `plan` / `commands` / `configOptions` are current-state, not
  history — they stay snapshot fields, unchanged.

## 4. Persistence

- Per-session JSONL: `<ws>/<task>/sessions/<sessionId>.jsonl`, one record
  per line, **append-only** (`fs.appendFile`), reusing the existing 300ms
  debounce. Track `flushedSeq` per session; a flush appends records with
  `seq > flushedSeq` only, and `flushedSeq` advances only after the write
  is confirmed (a failed append is retried by the next flush). The file is
  never rewritten. Reading skips records whose `seq` does not advance
  (duplicates from a retried partial batch).
- Names colliding with gurt-owned path segments are rejected at creation
  (repo: `sessions`, `sessions.json`, `task.json`; task: `workspace.json`,
  `.devcontainers`; workspace: `agents.json`, `credentials.json`).
- `sessions.json` keeps `{ info, acpSessionId }` per session and **loses**
  `entries`.
- Restore: read `sessions.json`, then fold each session's JSONL.
- Migration: a legacy record with `entries` (and no JSONL present) is
  converted on restore — synthesize `{type:'entry'}` records seq 1..n and
  write the JSONL once; `sessions.json` is rewritten without `entries` on
  its next regular persist.
- Session delete → delete its JSONL. Task delete already removes the dir.

## 5. IPC

- `session:snapshot` (initial load) keeps returning folded `entries` —
  unchanged renderer bootstrap.
- The per-change broadcast stops carrying history: `session-changed`
  sends the snapshot **without** `entries` (`SessionSnapshot.entries`
  becomes optional; present only from `session:snapshot`).
- New event in `GurtEvents`:
  `'session-log': { sessionId: string; records: SessionLogRecord[] }` —
  every appended record is forwarded (batching several records per tick
  is allowed, ordering preserved).
- Renderer (`Chat.tsx` / `App.tsx` snapshot store): keep entries in state;
  initialize from `session:snapshot`, then `entries = applyLog(entries,
  records)` on each `session-log` event for the selected session. Records
  arriving for a session with no snapshot yet are dropped (the snapshot
  fetch that follows selection supersedes them).

## 5a. Rewind (`truncate`)

Rewinding a session to before one of the user's messages appends
`{ seq, type: 'truncate', afterId }`: the fold drops every entry whose id is
above `afterId`, and later entries may reuse those ids. The file is still never
rewritten — the rewound tail stays on disk, and a fold that replays the log
reaches the same timeline the live session had. `ChatText.acpMessageId` records
the adapter's id of an agent message; it is the fork point a native
`session/fork` is given. See `SessionManager.rewindSession` / `branchSession`.

## 6. Non-goals

- Inter-agent messages, log compaction, cross-session/global logs,
  retention limits, UI changes beyond the wiring above.

## 7. Acceptance

1. `node scripts/session-log.test.mjs` (new, pure node, no docker):
   `applyLog` unit cases — entry/append/patch, out-of-order ignore,
   unknown-id ignore; fold(all) == incremental application.
2. `smoke-persistence.mjs` (persistence across restart) passes; chat history is
   byte-identical after restart (folded from JSONL).
3. Migration: a fixture `sessions.json` in the legacy format (with
   `entries`) restores to the same chat and produces the JSONL.
4. During streaming, `session-changed` payloads contain no `entries`;
   the timeline updates via `session-log` deltas (assert in a smoke by
   listening on the preload event, or by payload-size logging in dev).
5. Existing behavior intact: permissions flow, tool status updates,
   stop/cancel, resume after restart.

### Rewind file checkpoints

Before sending each user prompt (including `startSession`'s initial prompt),
main awaits a snapshot of every `writeRepos(info)` clone. Automatic system
nudges belong to the preceding user turn and do not replace its snapshot.
Read-only and read-locked mounts are excluded. A snapshot failure stops the
prompt before the agent can edit files and appears as a turn error.

Host Git uses the same access resolution, runner and per-clone operation queue
as Changes. A disposable `GIT_INDEX_FILE`, `read-tree`, `add -A`, `write-tree`
and `commit-tree` save the working tree, including untracked files, respecting
Git ignore rules (already tracked files remain tracked). The commit's parent
is HEAD, or absent for an unborn repository. No branch, HEAD, real index or
stash is changed. Refs `refs/gurt/checkpoints/<sessionId>/<userEntryId>` keep
objects reachable; no log fields or record types are added.

Rewind requires the session to be active and hold its clones, with no
conflicting holder. It first switches the agent session using the existing
fork/new behavior. Then it resolves **all** target checkpoints and saves
**all** current trees as `refs/gurt/checkpoints/<sessionId>/pre-rewind-<timestamp>`
before restoring any repository. Restoration uses a temporary index and a
checked two-tree update; untracked/ignored collisions and changes since the
backup are refused. Successful restores leave the real index and HEAD intact,
so staged differences may no longer match the restored working tree.

Missing checkpoints (including old logs), backup or restore failures still
allow the conversation rewind. The system line reports the reason, repositories
already restored, and the safety ref. There is no cross-repository atomic Git
transaction: a later repository may fail after an earlier one was restored.
Safety refs remain for manual recovery. The append-only `truncate` and status
line follow the restoration attempt, while prompt dispatch remains blocked.
The fallback transcript describes whether restoration succeeded. Agent-session
creation failure leaves files and the timeline intact. A process crash between
Git writes and the appended truncate can leave files restored but the old chat;
the safety refs are the recovery source.

To recover manually, first stop sessions using the clone and inspect the backup
with `git show <safety-ref>` or `git diff <safety-ref>`. To recover its complete
file tree without changing the active clone, run
`git worktree add --detach /path/to/recovery <safety-ref>`, then copy the needed
files. Ignored files, installed packages, databases, network side effects and
files outside clones are outside these snapshots.

Retention: keep checkpoints for the surviving timeline; after truncate remove
numeric refs at and above the removed entry, and keep the ten newest safety
refs per session. Session deletion removes its refs (cleanup errors are logged);
individual session archival awaits cleanup. Full scope archival moves the whole
clone out of the live workspace into the archive, including its refs, so a scope
restore retains rewind support; deleting the archive removes those refs too.
Task deletion removes the clones and all their refs. Unreachable objects are
left for normal Git garbage collection; Gurt does not run aggressive GC.

Snapshot work runs asynchronously on the host but is awaited before prompt
submission. A local test with 5,000 included and 5,000 ignored small files took
about 75–80 ms for the snapshot alone. This is not a latency guarantee: large
nonignored files still cost hashing/storage and delay prompt dispatch. Ignore
build output and dependency directories. Nested repository/submodule contents
are not recursively snapshotted (Git records gitlinks); this follows Git tree
semantics, and external repositories need their own registered writable clone.
