# Requirements: append-only session log

Status: draft for review · Owner: klerik3d · Target: gurt Electron PoC (this repo)

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

## 6. Non-goals

- Inter-agent messages, log compaction, cross-session/global logs,
  retention limits, UI changes beyond the wiring above.

## 7. Acceptance

1. `npx vitest run tests/session-log.test.ts` (new, pure node, no docker):
   `applyLog` unit cases — entry/append/patch, out-of-order ignore,
   unknown-id ignore; fold(all) == incremental application.
2. `archive/smokes/smoke3.mjs` (persistence across restart) passes; chat history is
   byte-identical after restart (folded from JSONL).
3. Migration: a fixture `sessions.json` in the legacy format (with
   `entries`) restores to the same chat and produces the JSONL.
4. During streaming, `session-changed` payloads contain no `entries`;
   the timeline updates via `session-log` deltas (assert in a smoke by
   listening on the preload event, or by payload-size logging in dev).
5. Existing behavior intact: permissions flow, tool status updates,
   stop/cancel, resume after restart.
