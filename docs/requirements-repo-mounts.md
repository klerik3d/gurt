# Requirements: per-repo mount modes, and roles without mounts

Status: implemented · Target: gurt Electron MVP (this repo)

Key code: `src/shared/types.ts` (`RepoMode`, `repoMode`, `anchorRepo`, the
role predicates), `src/main/sessions.ts` (clone claims, start gates,
`create_session`, `complete`), `src/main/containers.ts` (per-mount
`readonly`), `src/main/mcp/gurtServer.ts` (tool sets, instructions with the
mount table), `src/main/store.ts` (migration),
`src/renderer/src/components/ConfigTab.tsx` (the per-repo mode control).

> **Supersedes** the mount, lock and multi-repo columns of
> `requirements-session-roles.md` §2/§4 and
> `requirements-session-operator.md` §2.1 (the operator's "exactly zero
> repos"), and the reviewer role as a whole. Read those documents for
> everything else about roles — turn contract, drafts as approval, the admin
> surface — which is unchanged unless this document says otherwise.

## 1. Motivation

A session's repos were simply "mounted"; whether they were writable, locked
or allowed to be more than one was decided by the role, through a table the
user never saw (`roleIsReadOnly`, `roleLocksClone`, `roleAllowsMultiRepo`).
The reviewer was the proof that this was opaque: its instructions said
"read-only" while a stopgap mounted it read-write, and nothing in the UI
said which was true.

So: how each repo is mounted is **session configuration**, picked per repo
and shown per repo. The role no longer decides any of it.

## 2. Mount modes

Every repo of a session carries one of three modes:

| mode          | mount | clone claim                          | meaning |
| ------------- | ----- | ------------------------------------ | ------- |
| `write`       | rw    | **exclusive**, always                | changes the tree; every other claim on the clone waits |
| `read-locked` | ro    | **shared** — excludes writers only   | the tree does not move while this session is active |
| `read`        | ro    | none                                 | sees the live tree, blocks nobody, is blocked by nobody |

- Any session may hold any number of repos, in any mix of modes. There is no
  multi-repo role any more.
- **The default mode of a newly picked repo is `read-locked`**, whatever the
  role: reading is the usual case and usually wants a stable tree; writing is
  always an explicit pick. The role sets no defaults at all (§4).
- A **proactive** run is the one exception: its repos are always `read`
  (`repoMode` answers `read` regardless of the record) — it is gurt's own
  template, not something the user configures per repo.
  > **Superseded in part** by `requirements-review-loop.md`: a review loop's
  > `reviewer` is a second such role — its repos are always `read`.
- Modes are structural, like the repo list: editable while the session is a
  draft (a change releases a container a failed start may have left) and
  fixed once it has run.

### 2.1 Clone claims (the scheduler)

The single exclusive per-session lock becomes a set of per-clone claims —
a readers–writer lock per `(task, repo)`:

- a session conflicts with another *active* session (mid-start or with a
  container up, as before) when they claim the same clone and at least one
  of the two claims is exclusive;
- a start takes **all** of a session's claims or none: the scheduler's single
  pass checks the whole set before starting anything, so two sessions can
  never each hold half of what the other needs;
- **FIFO by clone**: a queued session that cannot start reserves its claims
  for the rest of the pass, so a later session cannot overtake it on any of
  them — in particular a stream of readers cannot starve a waiting writer,
  and a single-repo session cannot keep a multi-repo one waiting forever;
- the queue handoff (idle holders stopped early, `holdersBlockingQueue`)
  lists a holder only when its claim actually conflicts with a wanted one.

### 2.2 The anchor

One repo still has to build the image and name the git identity: the
**anchor** is the first `write` repo, or the first repo when none is
writable (`anchorRepo`). A drafted session's default env follows the anchor
(`requirements-session-roles.md` §3's rule, unchanged in spirit); a draft
with no repos at all takes the workspace's default env.

### 2.3 Container

- Each repo bind carries its own `readonly` flag.
- The workdir is the repo's directory when there is exactly one repo, else
  `/workspaces` (unchanged).
- The env's setup hooks are skipped when the anchor is mounted read-only —
  they exist to prepare a writable checkout. A session with a writable
  anchor runs them unmodified.

## 3. `complete` per repo

A session may write to several repos, and one commit message rarely fits
them all. `complete` therefore takes, with `outcome: "changes"`:

- `commit` / `pr` — the shared proposal, as before; and/or
- `repos: [{ repo, commit, pr? }]` — a proposal per repo.

At least one of the two is required. Every named repo must be one of the
session's `write` repos, at most once — anything else is an `isError` tool
result naming the problem, so the agent corrects itself. The commit modal of
a repo (`latestProposal(ws, task, repo)`) is prefilled from the newest
proposal of a session that **writes** that repo: its per-repo entry when it
has one, else its shared `commit`/`pr`.

The instructions of a session with more than one `write` repo say so.

## 4. Roles

What remains of a role is **what the agent delivers and which gurt tools it
gets** — never mounts, locks or the repo count, and never defaults for any
of those. Changing a draft's role leaves its repos, modes and env alone.

| role         | delivers                  | gurt tools                                             | needs to start |
| ------------ | ------------------------- | ------------------------------------------------------ | -------------- |
| `executor`   | changes in the tree       | `complete`                                             | ≥ 1 `write` repo |
| `researcher` | an answer in chat         | `create_session` → executor, researcher; `task`        | ≥ 1 repo |
| `inspector`  | a diagnosis in chat       | admin **read** tools; `create_session` → operator; `task` | nothing |
| `operator`   | changes to gurt's config  | admin read **and write** tools                         | nothing |
| `proactive`  | scopes with drafts        | `list_open`, `propose_scope`, `attach`, `finish_run`   | nothing |

- **reviewer** is removed for now — it needs rethinking, and everything it
  did is a researcher with a `read-locked` clone and a review prompt.
  Existing reviewer records migrate to `researcher` with their repos in
  `write` mode: exactly the mounts and lock they had (the 2026-08-24
  stopgap), so a live container stays valid.
  > **Superseded in part** by `requirements-review-loop.md`: `reviewer`
  > returns as a tool set (`submit_review`) that only the review loop
  > creates; the migration above applies only to records without `reviewOf`.
- **inspector** is the read half of the operator: the same admin surface
  minus every `write`-exposed method and `apply_held`. To change something
  it drafts an `operator` session (the draft is the approval step, as for
  every draft). An inspector or operator may hold repos like any other
  session; the "zero repos" rule of `requirements-session-operator.md` §2.1
  is lifted along with the rest of the role table.
- `create_session` / `propose_scope` take repos as `[{ name, mode }]`, the
  mode required: an agent drafting a session states how each repo is mounted
  just as a user does.
- The session's MCP instructions append the mount table — every repo with
  its mode, what that mode means for the agent ("writable — you hold it
  exclusively", "read-only, the tree does not move while you run",
  "read-only, may change under you"). The role's own text no longer claims
  anything about mounts.

## 5. Data and migration

- `SessionInfo.repos: string[]` stays the ordered name list;
  `SessionInfo.repoModes: Record<string, RepoMode>` sits beside it, kept
  normalized (exactly the keys of `repos`) at every entrance — create, draft
  edit, `create_session`, IPC. Read it through `repoMode(info, repo)` only.
- `AgentSessionRequest` carries the same pair.
- `readSessions` writes the fold once for records that have no
  `repoModes`: executor → `write`, reviewer → researcher + `write`,
  researcher / proactive → `read`, operator → `read` (it held none).
  Every resulting mount and lock is the one the record had before.

## 6. UI

The repository section of the config tab is one list, always multi-select.
Each picked repo is a row with its own segmented control
`write · 🔒 read · read` (the lock is an icon, not an emoji) and a remove button; hints say who blocks whom.
A note under the list says when Run is disabled (an executor without a
`write` repo, a researcher without a repo). The role picker no longer
touches the repo list or the env.

## 7. Non-goals (this pass)

- A writable scratch layer over a read-only mount (deps for a `read-locked`
  reviewer-style session) — `write` is the answer until then.
- A redesigned reviewer.
- Provenance of drafts in the UI.

## 8. As built

- **A record with no mode map reads through the old role table.**
  `repoMode` folds an absent `repoModes` the way `sessionRole` folds an
  absent role (`legacyRepoMode`: executor → `write`, every other role →
  `read`) — the same fold `readSessions` writes to disk once. Within a map, a
  repo without an entry takes the default. So nothing in flight between boot
  and migration changes its mounts, and code that builds a bare record (tests,
  the container layout) keeps meaning what it meant.
- **A fresh executor draft is not runnable until a repo is `write`.** The env
  seeds its default repo as `read-locked` like any pick (the role sets no
  default), and the Config tab says why Run is disabled. This is the price
  of "writing is always explicit".
- **Picking an env re-seeds the repo only while the draft holds at most one**,
  and the replacement inherits the replaced repo's mode. A hand-built list of
  several is never thrown away by an env pick.
- **The scheduler's FIFO reservation** is per pass: a blocked queue item
  reserves its claims (exclusive wins over shared) for everything behind it
  in that pass, so readers queue behind a waiting writer and single-repo
  sessions behind a multi-repo one.
- **`complete` refusals are thrown by the session manager** (`onComplete`
  calls `assertProposalFits` before recording anything) and turned into an
  `isError` result by the tool — the `create_session` precedent.
- **The `gurt` server is rebuilt when the mount table changes**, not only the
  role: the instructions carry it, and a draft's mounts may change until it
  runs.
- **Inspector and operator share the admin binding**; the server registers
  the write tools, `get_revisions` and `apply_held` only for the operator.
- **UI.** Each repo row has its name and remove on top and the mode control
  below (one line overran the config column); the locked mode shows the lock
  icon, not an emoji. The header's repo marks add a pen for `write` and a
  lock for `read-locked`.

## 9. Acceptance

1. `npm run typecheck` and `npx eslint .` are clean.
2. `node scripts/repo-mounts.test.mjs` — the default mode and normalization,
   draft mode edits, shared readers vs. an exclusive writer, all-or-nothing
   multi-repo starts, FIFO reservation (no overtaking, no writer starvation),
   the queue handoff listing only conflicting holders, the per-repo
   `complete` rules and `latestProposal` resolution.
3. `node scripts/session-roles.test.mjs`, `operator-role.test.mjs`,
   `gurt-mcp.test.mjs`, `admin-surface.test.mjs`, `proactive.test.mjs`
   updated to the new table (inspector, no reviewer, repos with modes in
   `create_session` / `propose_scope`, the reviewer migration).
4. The rest of `scripts/*.test.mjs` passes as before.
5. `npm run build && node scripts/smoke-roles.mjs` and `smoke-operator.mjs` —
   the real Config tab: seeded `read-locked`, the write note, per-repo mode
   picks, the role pick leaving repos and modes alone, persistence and
   reload, an operator holding and removing repos.
