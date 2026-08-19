# Requirements: manual review (split diff, comments, launch-fix, review lock)

Status: implemented · Owner: klerik3d · Target: gurt Electron MVP (this repo)

This document is a work order for an implementing agent. Read `README.md`
first. Follow-up to `docs/requirements-changes-thread.md` (the Changes
panel this replaces the diff modal of) and `docs/requirements-session-roles.md`
(the reviewer role's clone lock, which this reuses for a human reviewer).
Key code: `src/main/review.ts`, `src/main/changes.ts` (`getDiffFiles`,
`getDiffPair`), `src/main/sessions.ts` (`repoKey`/`repoHolder`/`canStart` —
the lock registry), `src/main/store.ts` (`RESERVED_NAMES`, `readReview`),
`src/renderer/src/splitDiff.ts`, `src/renderer/src/syntaxHighlight.ts` +
`syntaxLang.ts` (v2, §7), and
`src/renderer/src/components/{ReviewModal,TaskPane}.tsx`.
Do not change the contract described here without asking the owner.

## 1. Motivation

The Changes panel's diff modal (`DiffModal` in `TaskPane.tsx`, removed by
this change) dumped a raw unified diff as text — no alignment between old
and new lines, no folding of unchanged code, no way to react to what you
are looking at. It
is fine for a last glance before Commit/Push, not for actually reviewing
an agent's work. Today reviewing is either an ad-hoc read of that dump, or
spinning up a `reviewer`-role agent session (`requirements-session-roles.md`)
whose verdict is a chat message a fixer session must be drafted from by
hand. This spec adds the human equivalent: a split before/after view to
read the diff in, comments to react inline, one button to turn those
comments into a fix session, and a lock so nothing mutates the clone out
from under the reviewer mid-read — mirroring the reviewer role's exclusive
clone lock, but held by the user instead of an agent session.

## 2. Model

### 2.1 Diff target and pair

Everything the panel already diffs (the uncommitted tree, one thread
commit) becomes a **diff target**:

```ts
type DiffTarget = { kind: 'uncommitted' } | { kind: 'commit'; sha: string }
```

- `uncommitted` — before = `git show HEAD:<path>` (empty for an untracked
  file), after = the working-tree file content.
- `commit` — before = `git show <sha>^:<path>` (empty for a file the
  commit adds), after = `git show <sha>:<path>` (empty for a file it
  deletes).

Per target: a file list (`uncommitted` reuses today's `git status
--porcelain`; `commit` is new — `git show --name-status <sha>`), and per
file a before/after pair. Binary files: detect via `git diff --numstat`
(a `-` byte count) and report `{ binary: true }` instead of content.

### 2.2 Split rendering (renderer-side)

Line alignment and folding are computed in the renderer from the
before/after pair — the host keeps returning raw file content, nothing
diff-shaped. Add a line-diff library (`diff` / jsdiff is the standard
pick — pure JS, no native deps) and:

- `Diff.diffLines(before, after)` → ordered blocks of `equal` / `added` /
  `removed`. Render as two columns; a block only on one side pads the
  other with an empty row so the two panes stay line-aligned (this is the
  "linking" — matching rows sit on the same row across both panes, like
  JetBrains' split view).
- Within an adjacent removed+added block pair (a "replace"), run
  `Diff.diffWordsWithSpace(removedText, addedText)` per line pair and
  highlight the changed spans — intraline highlighting, not just whole-
  line coloring.
- A run of `equal` lines longer than a small context threshold (3 lines,
  matching typical unified-diff context) collapses to one row: `⋯ N
  unchanged lines ⋯`, click to expand in place. Runs of `equal` lines at
  the very start/end of the file always collapse (there is no "next hunk"
  to anchor context to). Collapsed-by-default, expand-in-place, no
  network round trip (the whole before/after pair is already local).

### 2.3 Review state (per task, per repo)

New file `<task>/review.json`, alongside `task.json`/`sessions.json`.
Add `'review.json'` to `RESERVED_NAMES.repo` in `store.ts` (a repo clone
directory must not collide with it, same reasoning as the existing
entries).

```ts
interface ReviewComment {
  id: string
  repo: string
  target: string        // `targetKey`: 'uncommitted' | `commit:<sha>`
  path: string
  side: 'before' | 'after'
  line: number          // 1-based, within that side's content — anchor start
  endLine?: number       // 1-based, inclusive; a range or whole-block anchor (v2, §7)
  text: string
  createdAt: string      // ISO
  resolved?: boolean
}

interface ReviewFile {
  /** repo -> ISO time the lock was acquired; absent = unlocked. */
  locked: Record<string, string>
  comments: ReviewComment[]
}
```

Comments anchor to `(target, path, side, line)` captured at the moment
they're left, against the diff pair as it existed then — there is no
re-anchoring across a changed diff (MVP). This is safe in practice
because a comment can only be left while the repo is locked (§2.4), so
the diff it anchors to cannot move underneath it. A comment whose `path`
is no longer part of **its own** target (file now clean, or the edit
reverted) is dropped on the next `getReviewState` read of that target —
pruned, not archived.

`target` is not cosmetic: without it the working tree and a commit would
share one comment set, and reading the working tree would prune every
note left on a commit — those files are usually clean there. It also
scopes what `Launch fix` sends: a fix is seeded from the target being
reviewed, not from every note on the clone.

### 2.4 Review lock — one holder per (task, repo), same registry sessions use

The lock is the reviewer role's clone lock (`roleLocksClone`,
`repoKey`/`repoHolder`/`canStart` in `sessions.ts`) generalized to
a second kind of holder that isn't a session. Concretely: `repoHolder(key)`
must also report the manual review lock when `review.json` has `locked[repo]`
set, and `canStart` stays "free iff no holder" — so a locked repo refuses
`Run now`, the queue, and the scheduler alike, surfaced as the existing
inline action-error style ("repo is locked for review"), not a
confirm-and-proceed dialog like the same-repo warning
`requirements-session-queue.md` §2.2 describes for `Run now` — this one is
a hard block, because the whole point is that nothing writes.

Being the same registry decides who is gated: a role that claims no clone
(`roleLocksClone` — i.e. a researcher, read-only mounts, blocks nobody and
is blocked by nobody) starts against a locked repo unchanged. It cannot
write, so it is not what the lock exists to stop. Executors and agent
reviewers are gated. See §7.

Symmetrically, acquiring the lock fails if a session currently holds that
key (live container, or mid-start) — error: "a session is running against
this repo — stop it first." No auto-stop of a running session on lock
acquire; releasing/acquiring lifetimes stay the user's job, exactly the
phrasing `requirements-session-roles.md` §2/§4 already uses for the
reviewer role's lock.

The lock does **not** gate the human's own Commit/Push/Update-from-main
actions in the Changes panel — those are the reviewer's own git
operations, not an agent write. It only gates session starts.

## 3. UI

### 3.1 Changes panel: lock toggle + Review entry point

```
Changes ──────────────────────────────── [↻]
 ▾ myapp-backend ────── [Open in VS Code]
    M  internal/auth/token.go
    A  internal/auth/refresh.go
    2 files · +85 −10
    [Commit]  [Push]  [Review]  [🔒 Lock for review]
```

`🔒 Lock for review` toggles to `🔓 Unlock` (filled/hollow icon) once
acquired; a locked repo's group header carries a small "locked" tag next
to its name, visible even when the group is collapsed. `Review` opens the
new review surface for that repo (replaces file-row click → `DiffModal`
for both the uncommitted block and, per commit, the old whole-commit
`git show` dump — a commit row click now opens the same surface scoped to
that commit's files).

### 3.2 Review surface

```
┌─ Review: myapp-backend ───────────────────────────── 🔒 locked  [Unlock] ─┐
│ Files                 │  internal/auth/token.go                          │
│  M token.go      •2   │ ┌───────────────────────┬─────────────────────┐  │
│  A refresh.go         │ │ HEAD                  │ working tree        │  │
│                       │ │  12  func Verify() {  │  12  func Verify() {│  │
│                       │ │  13   return ok       │  13   if !ok {      │  │
│                       │ │                       │  14     return err │  │
│                       │ │  14  }                │  15   }             │  │
│                       │ │ ⋯ 40 unchanged lines ⋯                      │  │
│                       │ │  55  func Close() {   │  57  func Close() { │  │
│                       │ │      [+]              │      [+]            │  │
│                       │ └───────────────────────┴─────────────────────┘  │
│                       │  ▸ line 13: "why swallow the error here?"    [×] │
├─────────────────────────────────────────────────────────────────────────┤
│ Comments (2 open)          Prompt: [________________]     [Launch fix]  │
└─────────────────────────────────────────────────────────────────────────┘
```

- File list: same status letters as the Changes panel; a comment-count
  badge per file with unresolved comments.
- Gutter `[+]` on either side of a line → inline comment composer,
  anchored to that side/line. Existing comments render under the line
  they anchor to (both sides collapse into one thread strip so a comment
  on `before` doesn't get lost off-screen from the paired `after` row),
  with a resolve checkbox and delete. Comments can also anchor to a
  dragged range of lines or a whole change block — see §7 (v2).
- `Comments (N open)` — flat list, click jumps to that file/line.
- Each column scrolls horizontally on its own — one scrollbar for the
  whole `before` side, one for `after`, not one per row (v2, §7).
- Code is syntax-colored per the file's extension, layered under the
  word-diff highlight (v2, §7).
- `Prompt` — free-text box, optional. `Launch fix` is disabled with no
  unresolved comments and an empty prompt (nothing to send); otherwise it
  builds a start prompt (§3.3) and is enabled regardless of lock state —
  launching creates a *draft*, it does not itself write anything.
- The surface itself has no editing of code — read-only, same as today's
  `DiffModal` ("No editing, no staging").

### 3.3 Launch fix session

`Launch fix` composes a start prompt from every unresolved comment,
grouped by file, plus the free-text prompt appended at the end (or used
alone if there are no comments), e.g.:

```
Review comments on myapp-backend:

internal/auth/token.go:13
  why swallow the error here?

internal/auth/refresh.go:40
  this duplicates Verify() above — extract a helper?

<free-text prompt, if any>
```

and calls the existing session-creation path (`SessionManager.createSession`,
reached over IPC as `createSession`) with `role: 'executor'`, `repos: [repo]`, `action:
'draft'` — landing in the task's session list exactly like a `create_session`
draft from an agent reviewer, so the user reviews/edits/launches it the
same way (`requirements-session-roles.md` §3, "the user reviewing and
launching it *is* the approval step"). No new MCP tool: this flow is
renderer-initiated, never agent-initiated (an agent reviewer keeps using
`create_session`, unrelated to this UI).

Launching does **not** resolve the comments or release the lock — both
stay exactly as the user left them; unlocking and resolving are separate,
explicit actions.

## 4. IPC

- `getDiffFiles(ws, task, repo, target: DiffTarget)` → `ChangedFile[]`
- `getDiffPair(ws, task, repo, target, path)` → `{ binary: false; before: string; after: string } | { binary: true }`
- `getReviewState(ws, task, repo, target)` → `{ locked, lockedAt?, comments }`
  — this target's comments, pruned against its file list
- `getReviewLocks(ws, task)` → `Record<repo, true>` — the panel's lock read.
  Separate from `getReviewState` because that one *prunes* as it reads, and
  a panel poll must never do that (nor pay for N diffs to learn a boolean).
- `setReviewLock(ws, task, repo, locked: boolean)` — throws per §2.4
- `addReviewComment(ws, task, repo, target, path, side, line, text)` → `ReviewComment`
- `resolveReviewComment(ws, task, id, resolved: boolean)`
- `deleteReviewComment(ws, task, id)`
- `launchReviewFix(ws, task, repo, target, prompt)` → `{ sessionId: string }`

`launchReviewFix` composes the start prompt in main (`fixPrompt` in
`review.ts`), not in the renderer as the draft had it: the wording is then
one thing, and a test can assert it without driving the UI.
`addReviewComment` and `launchReviewFix` join `OPAQUE_ARGS` in `ipc.ts` —
they carry user prose, which the log never sees.

`getFileDiff`/`getCommitDiff` (unified-text) stay for now — nothing else
in the app used them beyond `DiffModal`'s call sites, and this doc retires
those call sites, but deleting the underlying `git diff`/`git show` helpers
is a separate cleanup, not required for this feature to ship.

## 5. Non-goals (explicitly out of scope)

- Re-anchoring comments across a changed diff (a comment's anchor — line,
  range, or block — is still captured once, against the diff pair as it
  looked when it was written; multi-line ranges shipped in v2, §7, but
  re-anchoring across an edit did not); comment replies/threads (flat,
  single author — there is exactly one human reviewer, no multi-user review
  here).
- Editing code from the review surface — stays read-only.
- Auto-stopping a running session to acquire the lock; auto-releasing the
  lock on launch-fix, on resolve-all, or on unrelated Commit/Push.
- A new MCP tool, or any change to the agent-reviewer (`create_session`)
  path — this is a separate, human-only flow that happens to land drafts
  in the same place.
- Gating the human's own Commit/Push/Update-from-main behind the lock.
- Diffing across two arbitrary commits/branches — targets stay
  `uncommitted` and single thread commits, matching what the Changes
  panel already shows.

## 6. Acceptance

1. Uncommitted changes in a repo → `Review` opens the split view; edited
   lines show word-level highlighting within replace blocks; a 40-line
   unchanged run collapses and expands on click; before/after stay row-
   aligned across an add-only or delete-only block.
2. A thread commit → `Review` from its row shows that commit's file list
   and per-file split view (parent vs. commit content), independent of
   the uncommitted block.
3. Leaving a comment persists it (`review.json`); it survives app
   restart; resolving/deleting it updates the open-count badge and the
   Comments list immediately.
4. `Lock for review` on a free repo blocks a queued or "Run now" session
   start against that repo with an inline error; it fails outright if a
   session is currently live on that repo. `Unlock` immediately allows
   starts again.
5. `Launch fix` with two open comments and no free text produces a draft
   session whose start prompt lists both, grouped by file; the draft
   behaves exactly like any other draft (editable, launchable, deletable)
   and does not touch lock or comment state.
6. A comment on a file that becomes clean (committed, or the edit
   reverted) is pruned from `getReviewState` on next read; no crash, no
   orphaned reference.
7. Existing behavior intact: Changes panel actions, sessions, queue/
   drafts, permissions, modes, reviewer-role agent sessions and their own
   lock, provisioning, repo CRUD, task delete.

## 7. As built

Decisions taken while implementing the above — the parts a reader would
otherwise have to re-derive from the diff:

- **A researcher is not gated by the review lock** (§2.4, second paragraph —
  amended from the draft's flat "every session start"). The lock is a second
  kind of holder in the *same* registry sessions use, and that registry is
  `repoKey`, which a researcher opts out of entirely. Following the registry
  rather than overriding it is both the smaller change and the right reading
  of the ask: a session that cannot write is not what a write-lock stops.
- **The lock set lives in memory, seeded from disk at boot.** The scheduler
  asks "is this locked?" synchronously on every pass and cannot await a read,
  so `review.ts` keeps a `Set` of `<ws>/<task>/<repo>` and every mutation goes
  through it. `kernel.ready` awaits `review.load()` *before* the first
  `schedule()` — otherwise a queue restored past a still-held lock would start
  exactly what the lock excludes. The set is updated after the write, never
  before, so a failed write cannot leave a lock nothing on disk backs.
- **Comments are scoped to a target** (§2.3) — the one addition to the draft's
  model, and not optional: shared comments meant reading the working tree
  pruned every note left on a commit.
- **`getReviewLocks` is a separate call from `getReviewState`.** The panel
  needs one boolean per repo; `getReviewState` prunes as it reads and costs a
  `getDiffFiles` per call. Polling the latter from the panel both pruned the
  wrong target's comments and paid for N diffs to learn N booleans.
- **The fix session inherits like `create_session` does.** `launchReviewFix`
  takes env, agent, MCP selection, auto-allow, git access and config values
  from the newest session that already worked that clone, falling back to the
  workspace's first env and first agent — the same two things the New Session
  modal preselects. It creates a *draft*, so the inheritance being wrong is
  editable, not fatal.
- **Paths and shas from the renderer are argv.** `getDiffPair` normalizes and
  confines the path to the clone (`git show <rev>:<path>` resolves `..` against
  the repo root just as the filesystem does), and a target sha must match
  `[0-9a-f]{4,40}` so nothing can smuggle a leading `-` past git's option
  parser.
- **`git`'s `--numstat` decides "binary"**, not content sniffing: the pair is
  read as utf8, and by the time we could sniff it we would already have
  mangled it.
- **The `+` gutter affordance is hover-only and lock-gated.** Unlocked, there
  is no way to leave a comment at all — which is what makes "the diff cannot
  move underneath an anchor" (§2.3) true rather than merely likely.
- **The old `DiffModal` is gone**, and both of its entry points (a file row, a
  commit row) now open the review surface. `getFileDiff`/`getCommitDiff` stay
  on the API surface unused, per §4.

### v2: syntax highlighting, per-side scroll, range/block comments

Three follow-ups, landed together: `.split-code` used to give every row its
own `overflow-x: auto` — one scrollbar per line; comments could only anchor
one line at a time; the split view was plain monospace text.

- **Horizontal scroll is two synced tracks, not per-row native scroll.**
  `.split` clips overflow-x; each side's rows are translated by a shared
  `scrollX.before` / `scrollX.after` (React state in `SplitDiff`), driven by
  two real `overflow-x: auto` tracks pinned `position: sticky; bottom: 0`
  (sized to that side's longest rendered line via a `<canvas>`
  `measureText`), plus a native (non-passive) `wheel` listener on the root
  that routes trackpad/shift-wheel deltas to whichever side the pointer is
  over — React's synthetic `onWheel` is passive and can't `preventDefault`.
- **`endLine` is additive, not a migration.** A `review.json` written before
  v2 has no `endLine` on any comment; reading it back treats a missing
  `endLine` as "same as `line`" everywhere (`fixPrompt`, the anchor render,
  the in-range check) — no on-disk version bump, no upgrade pass.
- **Three ways to start a comment draft, one `Draft` shape.** The existing
  per-line `[+]` still sets `{side, line}`; a mousedown-drag across the
  gutter's line numbers (any rows, not just changed ones) sets
  `{side, line: min, endLine: max}` on `mouseup`; a block's `+ block`
  affordance (from `groupBlocks` in `splitDiff.ts`, on the *shown*,
  post-fold row list) does the same, deriving the range from every cell in
  the block on the `after` side, falling back to `before` only when the
  block has no `after` cells at all (a pure deletion). A range/block
  comment's `Note` and its `.split-pane.in-range` marker attach to the row
  at `max(line, endLine)` — the same "hangs off the last line" rule a
  single-line comment already followed.
- **Syntax spans are always present, word-diff spans are merged into them,
  not replacing them.** `Cell.spans` used to be `undefined` outside a
  rewritten pair; every cell now carries syntax spans (`cls: null` with no
  `lang`), and a rewritten pair's word-diff boundaries (`wordDiff`, the
  renamed `intraline`) are merged against them by `mergeSpans` — a
  two-pointer walk over two partitions of the same string
  (`syntaxHighlight.ts`) — so a changed word keeps its syntax color under
  the `.split-word` background instead of one replacing the other.
- **hljs output is parsed with a small hand-rolled scanner, not `DOMParser`
  or an HTML-parser dependency.** hljs's own `escapeHTML` only ever emits 5
  known entities and every scope is exactly one (possibly multi-class, for
  tiered scopes like `title.function_`) `<span class="...">`, arbitrarily
  nested — regular enough for a regex-plus-stack walk in `syntaxHighlight.ts`
  that runs identically in Node (`syntax-highlight.test.mjs`, no browser)
  and the renderer, and needs no jsdom/`DOMParser` shim either place.
- **Colors are a hand-picked mapping onto the existing palette, not a stock
  hljs theme.** The app is dark-only (no light-theme variables to speak of),
  so importing an hljs theme stylesheet would fight the existing look —
  `styles.css` maps a fixed set of `hljs-*` classes onto `--accent`,
  `--green`, `--yellow`, `--code`, `--faint`, `--dim`, `--red` instead.
- **Language is chosen from the file extension only** (`syntaxLang.ts`), not
  content sniffing or a user setting — an unregistered/unknown extension
  renders exactly as before (plain), which is why this is safe to ship as a
  fixed, curated language list rather than "whatever hljs autodetects."

## 8. Verification

- `npm run typecheck` — clean, both projects.
- `node scripts/split-diff.test.mjs` — alignment (padding, rewrite pairing,
  unequal rewrite blocks, line numbering per side), intraline spans
  reconstructing each line exactly, and the folding rules including the
  leading/trailing runs and expand-in-place; `groupBlocks` grouping and
  splitting on non-change rows; `alignRows`'s `lang` param — no-lang parity
  with the old default, a real language tokenizing every cell (not just
  rewritten ones), merged spans still reconstructing the line exactly and
  preserving the word-diff `changed` boundary, and an unregistered language
  falling back to plain.
- `node scripts/syntax-highlight.test.mjs` — `tokenize` (no-lang and
  unregistered-lang fallback, several real languages each reconstructing
  their input exactly and producing at least one scoped token, HTML-entity
  round-tripping) and `mergeSpans` (a syntax span split by diff boundaries,
  a diff span split by syntax boundaries, uneven boundaries on both sides
  still reconstructing exactly) — pure, no DOM, runs under plain Node.
- `node scripts/review.test.mjs` — over the real kernel, no Docker: the diff
  targets against a real git clone (including the root-commit and untracked
  cases and both argv guards), comment persistence/pruning/target-scoping
  (including a ranged comment's `endLine` round-tripping and a plain one
  carrying no `endLine` key at all), the lock against "Run now", the queue,
  a researcher, an agent reviewer and a live session holder, `fixPrompt`'s
  exact shape (including a range rendering as `path:start-end`), and a lock
  surviving a restart.
- `npm run build && node scripts/smoke-review.mjs` — the real UI, offline
  against a local bare origin: the split view's folds/word-highlight/padding,
  hover-only comment affordance, lock → `review.json` → a Run-now start
  refused with "locked for review", comment persistence and the open count,
  `Launch fix` drafting a session whose `startPrompt` carries the open
  comment (and neither unlocking nor resolving anything), syntax-highlight
  classes present (including on a changed word, alongside `.split-word`), a
  dragged gutter range persisting with the right `line`/`endLine` and
  showing `.split-pane.in-range`, and the `+ block` affordance anchoring to
  a whole two-line rewrite at once.
- The rest of `scripts/*.test.mjs` passes unmodified.

Mind the README gotchas: strip `ELECTRON_RUN_AS_NODE`, unique `GURT_ROOT`
per run, roots under `/Users`.
