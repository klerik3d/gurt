# Requirements: task Changes panel (product surface)

Status: draft for review · Owner: klerik3d · Target: gurt Electron PoC (this repo)

This document is a work order for an implementing agent. Read `README.md`
first. Key code: `src/main/provision.ts` (clone + `gurt/<task>` branch,
`hasUncommittedChanges`), `src/main/store.ts` (`cloneDir`),
`src/main/ipc.ts`, `src/preload/*`,
`src/renderer/src/components/{TaskPane,Sidebar}.tsx`. Do not change the
contract described here without asking the owner.

## 1. Motivation

The UI deliberately hides clones and their paths; sessions are the visible
unit. But the agent's *product* is the change set in the clone, and today
the interface has no entity to view or deliver it. This spec adds that
entity.

Design decisions already made:

- The product belongs to **(task, repo)** — the same identity as the clone
  and the `gurt/<task>` branch. Sessions are contributors, not owners:
  session rows get NO product buttons.
- Repos do NOT return as a navigational entity. They appear in exactly one
  place — as group headers inside the Changes panel — and only for repos
  that actually have changes. The panel is rendered from git state, not
  from configuration.
- Delivery is git-native: commit → push `gurt/<task>` → open a PR. Once
  pushed, the product lives in the remote and the clone is disposable
  again.

## 2. Model

For every clone `~/.gurt/<ws>/<task>/<repo>/` define:

- **dirty** — uncommitted changes: staged, unstaged, or untracked
  (`git status --porcelain` non-empty; helper already exists in
  `provision.ts`).
- **ahead** — local commits not on the remote: `git rev-list --count @{u}..HEAD`
  when an upstream is set; otherwise count against `origin/HEAD`
  (`git rev-list --count origin/HEAD..HEAD`).
- **actionable** = dirty OR ahead.

All git commands run **on the host** against the clone directory (clones
are host-side bind mounts), so the panel works even when the container is
stopped. Reuse the `run()` helper from `provision.ts`.

## 3. UI

### 3.1 Changes panel in the task pane

A "Changes" section in the task pane. Only repos with `actionable` state
appear. If none: a single muted "No changes" line.

Exactly one actionable repo → flat rendering, no repo header:

```
Changes ────────────────── [↻] [Open in VS Code]
 M  src/auth/login.ts
 M  src/auth/session.ts
 A  src/auth/refresh.ts
 3 files · +120 −34
 [Commit]  [Push]  [Create PR]
```

Two or more actionable repos → groups with repo-name headers; every
control moves into its group:

```
Changes ──────────────────────────────── [↻]
 ▾ myapp-backend ────────── [Open in VS Code]
    M  internal/auth/token.go
    A  internal/auth/refresh.go
    2 files · +85 −10
    [Commit]  [Push]  [Create PR]

 ▾ myapp-frontend ───────── [Open in VS Code]
    M  src/api/client.ts
    1 file · +12 −3
    [Commit]  [Push]  [Create PR]
```

Group headers are plain text, not links — there is nowhere to navigate.
The transition flat ↔ grouped is automatic.

Per group (or the flat panel):

- **File list** from `git status --porcelain`: status letter per file
  (M/A/D/R; untracked shown as `A`), path relative to the repo root.
- **Counts**: file count plus `+ins −del` from `git diff HEAD --shortstat`
  (untracked files count toward the file count only).
- **Click a file** → read-only unified diff in a modal (monospace, +/−
  line coloring; `git diff HEAD -- <path>` for tracked, whole file as
  added for untracked). No editing, no staging.
- **Buttons**:
  - `Commit` — enabled when dirty. Opens a small dialog with a message
    input prefilled `gurt: <task>`; runs `git add -A && git commit -m`.
  - `Push` — enabled when ahead (including right after a commit). Runs
    `git push -u origin gurt/<task>`.
  - `Create PR` — enabled when the remote branch exists and is current.
    PoC scope: open the browser at the GitHub compare URL
    `https://github.com/<owner>/<repo>/compare/<default>...gurt/<task>?expand=1`,
    deriving `<owner>/<repo>` from the origin URL path. Show the button
    only when the origin host contains `github` (SSH host aliases like
    `github.com-personal` count); hide otherwise.
  - `Open in VS Code` — PoC scope: open the clone directory with host
    VS Code (`code <cloneDir>`). This is the escape hatch for when the
    diff view is not enough; later it becomes the in-container `vsc`
    service.
  - `↻` — manual refresh of the whole panel.
- Action errors (push rejected, missing auth, `code` not found) render
  inline in the group as red text; no automatic retries.

### 3.2 Sidebar indicator on the task row

A task whose repos include at least one `actionable` clone shows a badge
on its sidebar row (accent-colored dot after the title; tooltip
"uncommitted or unpushed changes"). The badge reflects ONLY
commit/push/PR actionability — never vsc availability or container state.
It disappears when every clone is clean and pushed.

### 3.3 Refresh triggers

Recompute a task's git state on: app start (lazy on first render is
fine), opening the task pane, the end of every agent turn in a session of
that task, after any Changes action, and manual `↻`. No file watchers, no
polling loops.

## 4. Implementation notes

- New main-process module (e.g. `src/main/changes.ts`) exposing over IPC:
  - `getTaskChanges(ws, task)` → per-repo
    `{ repo, dirty, ahead, files: [{ path, status }], insertions, deletions }`
  - `getFileDiff(ws, task, repo, path)` → unified diff text
  - `commit(ws, task, repo, message)`, `push(ws, task, repo)`,
    `openPr(ws, task, repo)`, `openInVscode(ws, task, repo)`
- Wire through `ipc.ts` + preload like existing calls; the renderer keeps
  a per-task snapshot that both TaskPane and the sidebar badge read.

## 5. Non-goals (explicitly out of scope)

- discard/revert UI, per-file staging, partial commits
- per-session attribution, auto-commit checkpoints per session
- PR creation via API/`gh`, PR status tracking, review flow
- PR support for non-GitHub remotes
- git worktrees, branch management UI, multiple remotes
- file watchers / live-updating diffs

## 6. Acceptance

1. An agent (or the test) modifies files in one repo of a task → task
   pane shows the flat Changes list with correct statuses and counts; the
   sidebar task row shows the badge. Commit then Push clears dirty then
   ahead; the badge disappears.
2. Changes in two repos of one task → grouped rendering with headers;
   Commit/Push in one group does not affect the other.
3. Repos without changes never render; a task with clean, pushed clones
   shows "No changes" and no badge.
4. The panel works with the task's containers stopped (host git).
5. Create PR opens the correct compare URL for a `github.com`-style
   remote; the button is absent for a non-GitHub origin.
6. Existing behavior intact: sessions, queue/drafts, permissions, modes,
   provisioning, repo CRUD, env stop/delete, task delete.

## 7. Verification

Extend the Playwright smoke suite (`scripts/smoke*.mjs` pattern, run
against `npm run build` output). No agent secrets needed: the test can
mutate the clone directly (write a file into
`GURT_ROOT/<ws>/<task>/<repo>/`), trigger `↻`, and assert the panel and
badge. Use a local bare repo (`file://` or path URL) as the registered
repo so Commit/Push are fully testable offline; assert the result with
`git log` in the bare repo. Mind the README gotchas: strip
`ELECTRON_RUN_AS_NODE`, unique `GURT_ROOT` per run, roots under `/Users`.
