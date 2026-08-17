# Requirements: session roles (executor / researcher / reviewer)

Status: implemented · Owner: klerik3d · Target: gurt Electron MVP (this repo)

Key code: `src/shared/types.ts` (`SessionRole`, the role predicates,
`AgentSessionRequest`), `src/main/sessions.ts` (lock by role, turn contract by
role, `createAgentDraft`), `src/main/mcp/gurtServer.ts` (per-role instructions
and tool set, `create_session`), `src/main/containers.ts` +
`src/main/provision.ts` (read-only mounts), `src/main/store.ts` (migration),
`src/renderer/src/components/{Sidebar,tags,SessionPane,Chat}.tsx`.

Extends `requirements-turn-contract.md` (the `complete` tool) and
`requirements-multirepo-sessions.md` (discovery sessions). Relation to
`design-orchestration.md`: that file sketches a heavier pipeline model (typed
artifacts, `ReviewVerdict` schemas, stage bindings) and remains an unapproved
sketch; this document is the simpler path actually taken — roles are session
configuration, verdicts are plain chat text, and the only orchestration
primitive is "an agent drafts another session, the user launches it".

## 1. Motivation

Today a session's behavior is inferred: `repos.length > 1` makes it a
discovery session (read-only by convention, no lock, no git broker), one repo
makes it a read-write worker. Review work has no shape at all. Roles make the
intent explicit: a session is created *as* an executor, a researcher, or a
reviewer, and its tools, mounts, and locking follow from that — instead of
from repo count.

The philosophy stays "many small sessions": a role does one narrow job; work
fans out by creating new sessions (as drafts), not by growing one session.

## 2. The roles

The role is part of the session's configuration: chosen at creation,
immutable, like everything else about a session.

| role       | mounts     | clone lock | `complete` | `create_session` | multi-repo |
| ---------- | ---------- | ---------- | ---------- | ---------------- | ---------- |
| executor   | read-write | holds      | yes        | no               | no         |
| researcher | read-only  | none       | no         | yes              | only role allowed |
| reviewer   | read-only  | holds      | no         | yes (fixer only) | no         |

### Executor

Today's default session, unchanged. Input: requirements in the start prompt.
Output: changed files in the working tree, reported through `complete`
(`requirements-turn-contract.md`). Single repo, read-write clone, exclusive
lock, git broker per `gitAccess`.

**Fixer (tentative executor variant).** An executor created to fix review
findings on a clone that already carries another session's proposal. Proposal
lookup is already per-clone, last-wins (`latestProposal(ws, task, repo)`
prefills the Commit modal), so a fixer works out of the box by simply
overwriting. The variant, if wanted later: its `complete` *appends* to the
clone's existing proposal (subject kept, body extended) instead of replacing
it. Decide when the plain overwrite proves insufficient — not designed here.

### Researcher

Chat is the primary format; there is no deliverable and no turn contract —
the `complete` tool is not offered at all. All repos are mounted read-only;
no clone lock is taken, so a researcher never blocks (and is never blocked
by) other sessions. A multi-repo session is *always* a researcher — the
discovery session of `requirements-multirepo-sessions.md` becomes this role;
a researcher on a single repo is equally valid (read-only decouples from repo
count).

A researcher can fan work out: the `create_session` tool (see §3) drafts
executor or reviewer sessions, fully configured. Nothing flows back — the
researcher does not wait for, observe, or receive results of the sessions it
drafted.

### Reviewer

Input: a review prompt carrying the requirements and pointing at one clone.
The reviewer judges the clone's **uncommitted changes** against those
requirements. The repo is mounted read-only, but the reviewer **holds the
exclusive clone lock** — while the review runs nothing may mutate the working
tree, exactly the way an executor excludes parallel writers today. Read-only
plus locked is the one new mount/lock combination this document introduces.

The verdict is the reviewer's plain chat reply — no structured artifact, no
tool call, and it gates nothing: whether to commit anyway is always the
user's call. When fixes are needed the reviewer drafts a fixer executor via
`create_session`. The reviewer never waits for the fixer — drafting is
fire-and-forget; releasing the lock so the fixer can run is the user's job
(delete or stop the reviewer session), like all lock management.

## 3. Spawning: `create_session`, drafts as approval

`create_session` lives on the per-session gurt MCP server and is offered only
to researchers and reviewers. It creates a **draft** in the same task: role,
repo(s), agent kind, config values, start prompt — everything the New Session
modal takes, everything editable afterward. The draft never runs by itself:
the user reviewing and launching (or editing, or deleting) the draft *is* the
approval step. A different approval mechanism may replace drafts later.

No spawn-graph limits, no depth control, no flow management: since every
spawn is an inert draft, the user interrupts the flow at any moment by simply
not launching. Provenance ("created by session X") is not surfaced in the UI
this pass.

## 4. Mounts and locks

- Read-only is enforced at the mount level (Docker `readonly` bind mounts),
  not by convention — this closes the deferral recorded in
  `requirements-multirepo-sessions.md` §3 for researcher and reviewer
  sessions. Executors keep plain read-write mounts.
- Reviewer needs the read-only mount on a *single* clone — today read-only
  thinking exists only in the multi-repo wrapper path, so the single-repo
  mount path gains a read-only mode.
- Locking is unchanged mechanically: the scheduler's exclusive clone lock is
  taken by executors (as today) and reviewers (new), skipped for researchers
  (as discovery sessions do today). Lifetimes are managed by the user.

## 5. Turn contract by role

The gurt MCP server is already per-session; its instructions and tool set
become a function of the role:

- **executor / fixer** — `complete` exactly as in
  `requirements-turn-contract.md`, plus nothing.
- **researcher** — no `complete`; `create_session`; instructions describe the
  read-only, fan-out-by-draft contract.
- **reviewer** — no `complete`; `create_session` restricted to fixer
  executors; instructions delivered via MCP init, like `GURT_INSTRUCTIONS`
  (the concrete wording lives with the implementation, not in this doc).

## 6. Non-goals (this pass)

- Structured verdicts / `ReviewVerdict` artifacts (see
  `design-orchestration.md` — explicitly not taken).
- Result routing from spawned sessions back to the spawner.
- Spawn-graph limits or automatic flow control.
- Automatic lock release on verdict; provenance in the UI.
- The fixer's append-to-proposal semantics (see §2, tentative).

## 7. Touchpoints

`src/shared/types.ts` (role on `SessionInfo`), `src/main/sessions.ts`
(lock by role, tool gating), `src/main/mcp/gurtServer.ts` (role-dependent
instructions and tool set, `create_session`), `src/main/provision.ts` /
`src/main/containers.ts` (read-only mounts, single-repo read-only mode),
`src/renderer/src/components/Sidebar.tsx` (role picker in the New Session
modal).

## 8. As built

Decisions taken while implementing the above — the parts a reader would
otherwise have to re-derive from the diff:

- **The role is read through one function, never off the field.**
  `sessionRole(info)` folds an absent `role` the way behaviour was inferred
  before: more than one repo → researcher, otherwise executor. Everything
  role-dependent (locks, mounts, tools) goes through it, and the four
  predicates (`roleIsReadOnly`, `roleLocksClone`, `roleHasTurnContract`,
  `roleAllowsMultiRepo`) plus `spawnableRoles` are the whole of §2's table in
  code. `readSessions` writes the same fold back to disk once, so the role
  stops being derived from repo count anywhere.
- **"Immutable" means immutable once it has run.** The role is editable while
  the session is a draft, exactly like its repos and env (`editDraft` ignores
  every non-draft session), and changing it releases a container a failed start
  may have left — the role decides whether that container's mounts are
  read-only, so it is as structural as the repo set. The one (role, repos) rule
  is enforced in `assertRoleFitsRepos` at every entrance: create, draft edit,
  `create_session`.
- **Read-only implies no git broker.** `gitAccess` is forced off for a
  researcher and a reviewer (at creation, at draft edit, and again in
  `resolveLaunch`), and the toggle is hidden in the modal. Not in §2's table,
  but a consequence of it: the clone refuses writes at the mount, so native
  git could only fail later and more confusingly.
- **One mount path for "not a plain read-write single repo".** The wrapper
  `--workspace-folder` the multi-repo case introduced is now used whenever the
  repos must be mounted explicitly — more than one, or any read-only role
  (`usesRepoMounts` in `containers.ts`) — and each mount carries
  `,readonly` for the read-only roles. So a single-repo reviewer's clone lands
  at `<workspaceFolder>/<repo>` rather than at the workspace folder itself, and
  an executor's path is byte-for-byte what it was. *(Delivery since changed,
  2026-08-17: `--mount` flags → the `mounts` array of the per-session merged
  config, and the sibling root is the env config's `workspaceFolder`, not
  `/workspaces/repos` — see the amended mount bullet in
  `requirements-multirepo-sessions.md` §2.)* `store.multiRepoWorkspaceDir`
  became `mountedWorkspaceDir`; its on-disk path keeps the `.multirepo` segment
  so containers already provisioned against it still resolve. A discovery
  session that already has a live container keeps it — and therefore its
  read-write mounts — until that container is recreated; only the mounts are
  affected, its lock and tool set follow the role from the first restore.
- **A reviewer's lock has the same lifetime as an executor's**, i.e. its
  container's: the idle grace period, or immediately when something is queued
  behind that clone (the queue handoff in `kernel.ts`). §4's "lifetimes are
  managed by the user" and §2's "releasing the lock is the user's job" are about
  *not* adding a verdict-triggered release — the existing container policy is
  untouched, which is what "unchanged mechanically" asks for.
- **No `complete` also means no nudge.** `postTurnDecision` takes
  `hasContract`; for a researcher/reviewer it returns `none` for every input,
  so a turn that ends without `complete` is simply the end of the turn — never
  a nudge for a tool their server does not expose, never an `incomplete` mark.
- **`create_session` narrows its own schema.** The offered `role` is a zod enum
  built from `spawnableRoles(spawner)`, so a reviewer's tool cannot even
  express anything but `executor`, and `repos` is exactly one entry (no
  draftable role may hold more). Everything else is optional and inherited from
  the spawning session (env, agent, MCP selection, auto-allow, config values).
  Host-side rules that a schema cannot carry — role gating, a repo or env the
  agent invented — come back as an `isError` result with the message, so the
  agent self-corrects at the tool layer instead of the user finding a broken
  draft later. The spawn is also pushed into the spawner's own timeline
  (`create_session: drafted <role> "<title>"`): the draft is a to-do for the
  user, and that feed is where they are looking.
- **Read-only is about the clone, not about the network.** An MCP server the
  user attaches (`github` in full mode, say) is untouched by the role: the
  instructions tell a researcher and a reviewer to ship nothing, but no mount
  can stop a forge API call. Gating MCP modes by role is not part of this pass.
- **UI.** The role picker sits above the repository picker in the New Session
  modal, because it governs it: multi-select is offered for a researcher and a
  pick *replaces* the selection for the other roles. The role is shown as a
  tag in the draft settings row and in the chat/session header pill (`ROLE_INFO`
  in `tags.tsx` is the single source of the labels, hints and glyphs).

## 9. Acceptance

1. `npm run typecheck` is clean (both projects).
2. `node scripts/session-roles.test.mjs` — the role table, the (role, repos)
   rule, git access per role, reviewer-locks vs. researcher-locks-nothing
   (direct start *and* through the queue), draft role edits, the full
   `create_session` gating matrix, and the pre-roles migration.
3. `node scripts/gurt-mcp.test.mjs` — per-role tool sets over real HTTP
   (`complete` for an executor only, `create_session` for the other two with a
   per-spawner `role` enum), plus the `create_session` rejection matrix.
4. `node scripts/turn-contract.test.mjs` — the nudge matrix, including that a
   role without the contract never nudges and never marks `incomplete`.
5. `npm run build && node scripts/smoke-roles.mjs` — the real modal: default
   role, single vs. multi repo select, git access hidden for a read-only role,
   the role reaching `sessions.json` and the draft pane, and a draft's role
   being editable afterwards.
6. The rest of `scripts/*.test.mjs` passes unmodified.
7. **Not yet verified**: the `readonly` bind mounts against a real Docker
   daemon — this environment has none, the same gap
   `requirements-multirepo-sessions.md` §5.4 records for the wrapper-mount path
   it builds on. What to check on first real use: an agent in a researcher or
   reviewer session cannot write inside `/workspaces/repos/<repo>`, while the
   wrapper directory itself stays writable, and `devcontainer up` accepts the
   `,readonly` mount suffix.
