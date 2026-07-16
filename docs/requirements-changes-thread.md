# Requirements: Changes panel → delivery thread (follow-up)

Status: draft for review · Owner: klerik3d · Follow-up to
`requirements-changes-panel.md` (PR #10, `src/main/changes.ts`).
Supersedes its §2 (model), §3.1 (layout), §3.2 (badge); the rest stays.
Do not change this contract without asking the owner.

Problem: after Commit the changes collapse into the `ahead` number;
after Push the panel says "No changes" though the branch is merged
nowhere. Instead the panel must render the delivery thread of
`gurt/<task>` vs the default branch — derived from git alone, no forge
APIs, no state outside the clone.

## Model (per clone, host git)

- **default** = `origin/HEAD`, fallback `origin/main`
- **dirty** — as today
- **commits** = `git rev-list <default>..HEAD`, newest first; each
  `pushed` (reachable from `origin/gurt/<task>`) or `local`
- **integrated** = commits empty, or `refs/gurt/integrated` == HEAD
- **actionable** = dirty OR any local commit
- **delivered** = not actionable AND any pushed AND not integrated
- a repo renders while actionable or delivered; "No changes" only when
  every repo is integrated/clean

Squash merges rewrite SHAs, so the range never empties by ancestry; the
integration signal is remote branch deletion. When `fetch --prune`
removes `origin/gurt/<task>` while it pointed at HEAD →
`git update-ref refs/gurt/integrated HEAD`. New commits reopen the
thread. Accepted trade-off (state it in a code comment): deleting an
unmerged remote branch also counts as integrated.

Network: `git fetch --prune origin` only; runs on panel open, manual
`↻`, and after each Changes action. Never on agent turn end, never on a
timer. Fetch failure is non-fatal: render last-known refs, no error UI.

## UI

Flat/grouped rules, modal style, `Open in VS Code`, `↻`, inline errors —
unchanged. Two blocks per repo, each only when non-empty:

```
Changes ────────────────────────── [↻] [Open in VS Code]
 Uncommitted
  M  src/auth/login.ts
  2 files · +85 −10
  [Commit]

 On gurt/<task> · 2 commits not in main
  d4e5f6  gurt: add refresh flow                local
  a1b2c3  gurt: fix login                       pushed
  [Push]  [Create PR]
```

Uncommitted block: today's, unchanged. Branch block: click a commit →
read-only `git show <sha>` modal; `Push` enabled when any local commit;
`Create PR` from a host → URL-template map with one entry (host contains
`github` → today's compare URL), shown when matched and any commit is
pushed; unknown host → no button.

Badge: filled dot — some repo actionable, tooltip "uncommitted or
unpushed changes"; hollow dot — none actionable, some delivered, tooltip
"delivered — awaiting merge"; otherwise none.

## IPC

- `getTaskChanges(ws, task, { fetch })` → per repo `{ repo, dirty,
  files, insertions, deletions, defaultBranch, commits: [{ sha,
  subject, pushed }], integrated, prUrl? }`;
  `ahead`/`prAvailable`/`prReady` retired
- `getCommitDiff(ws, task, repo, sha)` → `git show` text (new)
- the rest unchanged; `openPr` reads the forge map

## Non-goals

No forge APIs (`gh`/REST), no PR existence/status tracking, no URL
templates beyond GitHub, no timers/watchers, plus the panel spec's
exclusions.

## Acceptance

1. Edit → Uncommitted block, filled badge. Commit → change moves into
   the branch block as `local` (nothing vanishes). Push → `pushed`,
   hollow badge, `Create PR` on a GitHub-style origin.
2. Merge into default on the remote, `↻` → "No changes", no badge.
3. Squashed commit on the remote default + delete the remote branch,
   `↻` → integrated; a new local commit reopens the thread.
4. Unreachable origin: fetch fails silently, panel renders last-known
   refs, Commit works.
5. Non-GitHub origin: full thread, no `Create PR`.
6. Group independence, stopped containers, existing behavior — intact.

## Verification

Smoke like `smoke7.mjs` (offline, local bare origins, built app): merge
case; squash case (`git update-ref -d` in the bare repo, assert
`refs/gurt/integrated` in the clone); offline case (rename the bare
dir); assert pushes via `git log` in the bare repo. Gotchas: strip
`ELECTRON_RUN_AS_NODE`, unique `GURT_ROOT` per run, roots under
`/Users`.
