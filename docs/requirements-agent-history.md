# Requirements: native agent history on the host

Status: planned · Target: gurt Electron MVP (this repo)

This document is a work order for an implementing agent. Read
`requirements-session-container.md` first (the 1:1 container model and its
single teardown path) and `requirements-skills.md` §5 second — this feature
is that document's delivery mechanism pointed the other way, and every
decision below that could be borrowed from it was borrowed rather than
reinvented. Key code: `src/shared/agents.ts` (`AgentDef`), `src/main/store.ts`
(the host path and its removal), `src/main/provision.ts`
(`SKILLS_MOUNT` / `linkContainerSkills` — the pattern this copies),
`src/main/containers.ts` (`ensure`'s `hostMounts`, `sessionConfigArgs`),
`src/main/sessions.ts` (`patchDraft`, `deleteSession`), `src/main/kernel.ts`
(the delete wiring).

> **Does not change** `requirements-session-log.md`. gurt's own append-only
> chat log stays exactly what it is — the source of truth for the UI, folded
> from `~/.gurt/<ws>/<task>/sessions/<sessionId>.jsonl`. This document is
> about the *agent's* private state, which gurt neither reads nor renders.

## 1. Motivation

**Two histories exist, and only one of them survives.**

gurt keeps its own transcript on the host and shows it: `SessionLogRecord`s
in a per-session JSONL, restored on boot, byte-identical across an app
restart (`requirements-session-log.md` §4). That half is solid.

The agent's own state is the other half, and it lives nowhere but the
container's writable layer. Every CLI gurt drives keeps a private on-disk
record of the conversation — the thing its native `resume` reads — and gurt
deliberately ignores its contents (`sessions.ts`, "session/load in progress
— drop replayed updates, we keep our own history"). Ignoring the *contents*
was right. Letting the *file* die with the container was not.

The failure it produces is visible today. `attachUncoalesced` re-attaches by
calling `session/load` with the stored `acpSessionId` and the container's
`cwd` (`sessions.ts`); when the adapter has no such session on disk it
throws, and the catch around it posts

> could not resume (…) — create a new session

That happens on every path that replaces a container rather than stopping
it: a repo-set change forcing a rebuild (`containers.ts`), a container
removed because an unfinished start left it un-nameable, the boot reconcile
reaping an orphan, and any user-facing rebuild. The chat in the UI is intact
— gurt restored its own log — while the agent behind it has amnesia. A user
reads that as gurt losing the session, because from where they sit the two
histories are one thing.

**Container recreation is normal, not exceptional.** The 1:1 model destroys
containers freely and says so; that is a deliberate property
(`requirements-session-container.md` §2, "stale-cache reuse is
unrepresentable"). The fix is therefore not "recreate containers less" — it
is to stop storing durable state in the one place designed to be
disposable.

So: **the agent's history is session data, stored on the host, delivered as
a bind mount.** Same shape as skills, same two-step link, opposite
direction of travel — gurt writes nothing into it and reads nothing out of
it.

## 2. The contract

**The mount is per session and never shared.** A container belongs to one
session (`requirements-session-container.md` §2); its history directory
belongs to the same one. Not per env, not per task, not per agent instance,
not per workspace. Two sessions must not be able to read each other's
transcripts — they may be different repos, different roles, different
trust.

**gurt never reads it.** The directory is opaque: gurt creates it, mounts
it, and removes it. Nothing parses it, no schema is assumed, no content
reaches the renderer or the log. This is what makes agent-controlled
content safe to keep on the host (§6.3) and what keeps the feature free of
per-CLI format coupling — only the *path* is per kind, never the contents.

**Only the transcript directory, never the credential file.** Codex reads
`~/.codex/auth.json` and gemini `~/.gemini/oauth_creds.json`, materialized
fresh at every adapter launch and holding a live access token
(`requirements-oauth-credentials.md` §5.2.1). Those files exist in the
container's writable layer precisely so they die with it; acceptance item 6
of that document requires that no materialized auth file be findable
outside `credentials.json`. Mounting a whole agent home would persist a
bearer token to host disk in plaintext and break that invariant. The mount
target is the transcript subdirectory alone, and §3's table records the
directory boundary for each kind for exactly this reason.

**A kind whose paths are not verified gets nothing.** `historyPaths` is
empty until someone has confirmed, against the *pinned* adapter/CLI
version, where that CLI actually writes — and that the answer is separable
from where it keeps credentials. Empty means no mount, no link, and a
session that provisions exactly as it does today: the `skillsDir` rule
(`requirements-skills.md` §5), and the standing lesson of
`requirements-oauth-credentials.md` §11 — a delivery is only real once the
consumer's actual consumption path has been checked. §3.3 is a kind that
stays empty *permanently*, on evidence.

**No session is worse off than today.** History that was in a container
before this feature is lost at that container's next rebuild — which is what
happens to it today, unconditionally. The feature adds durability going
forward; it does not migrate anything, and it may not fail a start.

## 3. Where each kind keeps it

`AgentDef` grows one field, beside `skillsDir` and for the same reason — it
answers a per-kind question about `$HOME`-relative paths in the pinned CLI:

```ts
/** The `$HOME`-relative paths this kind persists its own conversation and
 *  resume state in, each linked into the read-write bind by
 *  `linkContainerHistory`. Empty means no delivery at all: the session
 *  provisions exactly as it does today.
 *
 *  A **list**, not a single directory, because no CLI examined keeps all
 *  of it in one place (§3.1) — and every entry MUST be separable from
 *  that kind's credential file (§6.2). A kind whose transcript cannot be
 *  separated from its secrets gets `[]` and stays there (§3.3).
 *
 *  Verified against the *pinned* versions, not whatever the projects ship
 *  today — a pin bump re-checks this field, same rule as `skillsDir`. */
historyPaths: readonly string[]
```

Verified against the pinned artifacts (method and evidence in §3.4):

| kind | pinned version | keeps its session state in | boundary vs. that kind's credential file | keyed by |
|---|---|---|---|---|
| claude-code | claude-agent-acp@0.76.0 (SDK 0.3.257) | `.claude/projects/<mangled-cwd>/<sessionId>.jsonl`, plus `.claude/todos` | **clean** — its credential is the `CLAUDE_CODE_OAUTH_TOKEN` env var; there is no auth file in `~/.claude` at all | cwd, mangled — overridable (§3.2) |
| gemini | @google/gemini-cli@0.59.0 | `.gemini/tmp/<shortId>/chats/session-*`, `.gemini/history/<shortId>`, and the registry `.gemini/projects.json` that assigns `<shortId>` | **workable** — `oauth_creds.json` is a top-level file; the two directories and `projects.json` are separately addressable siblings of it | absolute project root, via the registry |
| codex | codex-acp@1.11.0 (bundles @openai/codex@0.153.4) | `.codex/sessions/<Y>/<M>/<D>/rollout-*.jsonl`, indexed by `.codex/state_5.sqlite` and `.codex/thread_history_1.sqlite` | **awkward** — `sessions/` is a subdirectory, but the two index DBs are top-level files sitting *next to* `auth.json` | `threads.cwd` **and an absolute `rollout_path`** stored in the index |
| opencode | opencode-ai@1.18.30 | `.local/share/opencode/opencode.db` — one sqlite file | **none — see §3.3** | `session.directory` / `project.worktree`, absolute |

### 3.1 One bind, several links

None of the four keeps everything under a single directory, so the
delivery is one host directory bound once, with one symlink per entry in
`historyPaths`:

```
/gurt/history/claude-projects   ←  $HOME/.claude/projects
/gurt/history/claude-todos      ←  $HOME/.claude/todos
```

The host side pre-creates one subdirectory per directory entry (slug =
the relative path with `/` → `-` and the leading dot dropped, so entries
from different agent homes cannot collide). A **file** entry —
`.gemini/projects.json` — is not pre-created: the symlink points at a path
inside the mount that the CLI creates on first write, which is exactly what
opening through a dangling symlink with `O_CREAT` does.

This keeps `hostMounts` at one entry per session and leaves the deletion
story of §5 untouched — the whole thing is still one directory tree.

### 3.2 The cwd-keying problem, and the one real lever

Every one of the four keys its transcripts by the working directory. That
matters because gurt's container-side path is derived from the session's
repo set: `/workspaces/<repo>` for a plain executor, `/workspaces/repos` for
a mounted one (`containers.ts`), and `attachUncoalesced` passes it to
`session/load` as `cwd`. It is stable across a rebuild that keeps the repo
set — which is the case this feature is for — and changes when the repo set
changes, which is a rebuild the user asked for.

claude-code is the one kind with an explicit override:
`CLAUDE_CODE_PROJECT_DIR_NAME` replaces the mangled-cwd directory name
outright. Setting it to a **constant** (the session id is the obvious
choice, and it is already what the host directory is keyed by) makes that
kind's history independent of the container path entirely — a session that
changes its repo set still finds its own transcripts. It is delivered the
same way every other agent env var is, in `resolveLaunch`.

The others have no equivalent, so for them a repo-set change leaves the old
entries on disk, inert (§8). The history survives either way; whether the
CLI *addresses* it is that CLI's scheme, not gurt's.

### 3.3 opencode gets nothing, and the reason is the rule

`opencode-ai@1.18.30` stores sessions, messages and parts in
`~/.local/share/opencode/opencode.db` — and stores `account`,
`control_account` and `credential` rows, holding live access and refresh
tokens, **in that same sqlite file**. There is no path at which transcripts
can be separated from secrets: persisting the history means persisting the
refresh tokens to host disk, which `requirements-oauth-credentials.md` §5.2
forbids in the plainest terms ("the refresh token never leaves the host" is
its rule in the other direction; a token durably written *to* the host by a
container is the same boundary broken from the other side).

So `historyPaths` is `[]` for opencode, and it is not a "pending
verification" placeholder — it is the verified answer. Revisiting it needs
either an upstream change that splits the store, or a mechanism that
filters tables, which is a different feature with a different threat model.
This case is why §2 states the credential rule as a hard constraint rather
than a caution: one kind in four actually fails it.

### 3.4 How the table was produced

codex and opencode were checked by **running the pinned binaries** under a
scratch `HOME` and listing what appeared (`codex doctor` names its own DB
set; a real `codex exec` produced the rollout and the sqlite index; an
`opencode run` produced `opencode.db` and nothing else). claude-code and
gemini were read out of the shipped bundles — the SDK's config-dir and
project-dir functions, and gemini's `GEMINI_DIR` / `getProjectTempDir` /
`ProjectRegistry` respectively.

A pin bump re-runs this, same rule as `skillsDir`. The check that matters
is not "where does it write" alone but "**is that separable from where it
keeps secrets**" — §3.3 is what happens when it is not, and no amount of
reading a changelog would have surfaced it.

## 4. Delivery

Mirrors `requirements-skills.md` §5 step for step.

1. Provisioning resolves the session's agent kind exactly as the skills
   mount already does — `info.agent || ws.defaultAgent`, then
   `agents.json` → `AgentDef` (`containers.ts`). A kind that resolves to
   nothing, or to an empty `historyPaths`, adds no mount.
2. The host directory is created and bound **read-write** at a fixed
   absolute container path:

   ```
   HISTORY_MOUNT = /gurt/history
   ```

   Fixed and absolute for the same reason `SKILLS_MOUNT` is
   (`provision.ts`): a devcontainer's `mounts` are evaluated to *create*
   the container, so `${containerEnv:HOME}` is not substituted yet and the
   remote user — hence `$HOME` — is the image's choice, not gurt's.

   It rides the existing `hostMounts` list on `devcontainerUp`, which
   already carries `{ hostDir, target, readonly }` with an absolute target
   and is deliberately kept apart from `extraMounts` so that repo-specific
   logic (single-entry `workspaceFolder` re-pointing, create-hook
   stripping) does not key off it (`requirements-skills.md` §5.1). A
   read-write entry must trigger neither of those either.

   **`mkdir -p`, and never anything else.** This is the one place the
   skills model must *not* be copied: `materializeSessionSkills`
   (`store.ts`) opens with `rmTree(dir)` before every start, because a
   selection is a fresh statement of intent each time. History is the
   opposite — it is the accumulated state the whole feature exists to
   keep, and a wipe-then-recreate here would reintroduce the §1 bug on the
   host side, where no container rebuild is even needed to trigger it.
   Ensuring the directory is idempotent and additive, full stop.

3. Right after `up`, gurt links each entry into the agent's home through
   `devcontainer exec` — `linkContainerHistory`, a sibling of
   `linkContainerSkills`. Per entry, in one `sh -c`:

   ```sh
   mkdir -p "$HOME/<parent of entry>" \
     && rm -rf "$HOME/<entry>" \
     && ln -s /gurt/history/<slug> "$HOME/<entry>"
   ```

   Through `exec` rather than a lifecycle hook, because a read-only role
   has its create-time hooks stripped and would silently skip the delivery
   (the same argument `linkContainerSkills` carries). Idempotent, re-run
   after every `up`, so a rebuilt container is relinked.

   `rm -rf` on the link target removes a *symlink* without following it, so
   a re-link never touches the bound history. It does destroy a real
   directory the image baked or a pre-feature container wrote — accepted,
   and covered by §2's last paragraph.

4. For claude-code only, `resolveLaunch` sets
   `CLAUDE_CODE_PROJECT_DIR_NAME` to the session id (§3.2), beside the
   env vars it already composes. It is an ordinary non-secret variable —
   it needs none of the credential machinery around `secretEnv`.

5. Failure is logged, not fatal — again as with skills. A session that
   starts without durable history beats a session that does not start; the
   provisioning log line says which happened. A *partial* failure (one link
   of several) is logged per entry: the CLIs degrade unevenly, and "which
   half landed" is the first question such a session raises.

### 4.1 The merged config is now the common case

`sessionConfigArgs` (`containers.ts`) must keep mirroring
`devcontainerUp`'s write condition *exactly* — that function's doc comment
already warns what happens when it does not, with a repo-less operator as
the worked example. Adding a mount that most sessions carry flips the
default: a plain read-write single-repo executor, which today runs on the
env's shared `--override-config`, now has mounts of its own and therefore a
per-session merged config at `sessionConfigPath(sessionScratchDir(...))`.
The condition becomes "repo mounts **or** skills mount **or** history
mount", in both places, or the `exec`s of an ordinary session will resolve
a config file that was never written.

### 4.2 The agent pick becomes structural

`patchDraft` releases a draft's container when `agent` changes *only if the
draft has a skill selection* (`sessions.ts`) — the reasoning being that
without one, every kind produces the same empty mount list. With a history
mount that stops being true: the mount list now depends on the kind for
every draft, and the kinds genuinely differ (§3 gives one of four an empty
`historyPaths`, so switching to or from opencode changes the mount list
even with no skills picked). The condition widens to "the agent changed",
full stop, in line with `repos` / `env` / `role` / `skills`
(`requirements-skills.md` §5.2).

A **draft** switching agent may drop its (empty, unstarted) history
directory with the container. A **started** session cannot change agent, so
no live history is ever orphaned by this.

## 5. Where it lives on the host, and how it is removed

```
~/.gurt/<ws>/<task>/.multirepo/<sessionId>/history/
```

A sibling of `skills/` inside the session's scratch directory
(`store.sessionScratchDir`, `store.ts`) — the directory whose stated job is
"everything gurt stages for one session's container and nothing else,
removed with the session".

**This placement is the deletion design, not a filing convenience.** Three
lifecycles have to come out right, and the scratch dir already gets all
three:

1. **Session deleted.** `deleteSession` (`sessions.ts`) awaits
   `releaseContainer` and only then calls `deleteScratch` → `rmTree` of
   `.multirepo/<sessionId>`. The ordering is load-bearing and already
   commented as such ("its bind mounts are staged inside that directory, so
   removing it any earlier races the daemon") and already asserted by
   `scripts/session-delete-container.test.mjs`. A history directory inside
   it is removed by that same call, after the container that held it is
   gone, with **no new code and no second failure mode**.
2. **Task or workspace deleted.** Both already `rmTree` the whole `<task>` /
   `<ws>` subtree, so a directory under it needs no participation. A history
   directory placed anywhere *outside* `~/.gurt/<ws>/<task>/` — a sibling
   root, a named Docker volume — would leak on exactly this path, silently,
   with nothing to notice it.
3. **Container stopped, rebuilt, reaped or replaced.** Nothing touches the
   scratch dir. `deleteSessionScratch` has one caller, and it is
   `deleteSession`. This is the case the feature exists for, and it is
   correct by construction rather than by a check someone has to remember.

**Named volumes are rejected for that reason.** A `docker volume` would be
a second bookkeeping system with its own failure modes — a `volume rm` can
fail independently of the file removal, leaving an orphan no `rm -rf` will
ever reach, and it would need its own reconcile at boot to find volumes
whose session is gone. A bind under `~/.gurt` is removed by the tree
removal that already exists. It also keeps the feature inside the one
storage story the repo has: every mount in `provision.ts` is `type=bind`
sourced from `~/.gurt`, and there are no named volumes anywhere in the
codebase today.

`deleteSessionScratch`'s own doc comment enumerates what the scratch dir
holds ("its repo mount points, its merged devcontainer config and its
materialized skills") — the list gains the history directory, since that
comment is the closest thing the code has to a statement of what deleting a
session destroys.

**`RESERVED_NAMES` needs no entry** (`store.ts`), and that is worth stating
so nobody adds one out of symmetry with `skills`. That list guards the
directories where *users* name things: a repo may not be called
`.multirepo` because clones sit at `<task>/<repo>`, and `skills` is
reserved at the task level for the same reason. The history directory sits
two levels below, inside `.multirepo/<sessionId>/`, whose only children are
gurt's own and whose parent segment is a gurt-minted session id. No user
input reaches that path, so there is nothing to collide with.

**Duplicating a session copies no history.** `duplicateSession` produces a
fresh draft and takes "nothing runtime-derived" (`sessions.ts`); a
transcript is the most runtime-derived thing a session has. The copy starts
empty, which is also what its absent `acpSessionId` already implies.

## 6. Security

### 6.1 Isolation is the whole design

One directory per session, mounted into one container. The failure to avoid
is a shared history root — per workspace, per agent instance, per env —
which would let a session read the transcripts of sessions it has no
relationship to: different repos, different roles, different network policy,
possibly a different person's work. Per-session is not a refinement here; it
is the property.

### 6.2 Credentials must not become durable

Restated from §2 because it is the one way this feature could actively make
gurt less safe: mounting an agent's whole home directory would persist
`~/.codex/auth.json` / `~/.gemini/oauth_creds.json` — live OAuth access
tokens, plaintext — onto host disk, surviving the container they were
scoped to. `requirements-oauth-credentials.md` §5.2 ("only the short-lived
access token reaches a container") and its acceptance item 6 both forbid
it. Only the transcript paths are mounted; §3's table names the boundary
per kind, and a kind whose transcript cannot be separated from its
credentials keeps an empty `historyPaths`.

**This is not a theoretical guard.** Of the four kinds, one fails it
outright — opencode keeps its sessions and its refresh tokens in a single
sqlite file (§3.3) — and one nearly does: codex's resume index sits as
top-level files beside `auth.json`, which is why §10 puts it behind a
separate phase rather than folding it in. Had the rule been written as a
caution instead of a constraint, the natural implementation ("mount the
agent's home") would have written live refresh tokens to host disk for a
quarter of the supported agents.

### 6.3 The host now stores agent-controlled bytes

The agent can write anything into the mount, including hostile names,
symlinks pointing at host paths, and a great deal of data. What makes that
tolerable is §2's opacity rule:

- **Nothing parses it.** No content is read into gurt, so no parser is
  exposed to attacker-chosen input, and no content can reach the renderer,
  the log, or the admin surface.
- **Nothing follows links out of it.** Removal is `rmTree` → `rm -rf` on
  the *directory*, which unlinks symlinks rather than traversing them. A
  symlink to `/` inside the mount deletes nothing but itself. Any future
  code that walks this directory would break that property and must not be
  added casually.
- **Size is unbounded, and accepted** (§8). It is bounded in practice by
  the same thing that bounds a clone's `node_modules`: it lives under
  `~/.gurt` and is removed with its session.

### 6.4 Content sensitivity is not new, but it is now duplicated

The transcript holds what the conversation held — pasted secrets, file
contents, tool output. That is already true of
`~/.gurt/<ws>/<task>/sessions/<sessionId>.jsonl`, at the same sensitivity
and with the same absence of encryption at rest (sealing via `safeStorage`
covers `credentials.json`, not session data). This feature does not
introduce the class of data; it does mean two files now hold it instead of
one, and both are removed by the same `deleteSession`. Recorded as a known
consequence rather than discovered later.

### 6.5 Ownership

The directory is created by gurt (host UID) and written by the container's
remote user. The devcontainer CLI's default `updateRemoteUserUID` behaviour
on Linux, and Docker Desktop's filesystem mapping on macOS, are what make
the existing read-write clone mounts work — the same mechanism carries this
one. It is nevertheless the most plausible way for the feature to fail
silently on a given image (a container that cannot write its history simply
has none), so §9 makes it an explicit check rather than an assumption.

## 7. Logging

Existing rules unchanged: no content, ever — and here there is no content to
have, since gurt never reads the directory.

| slug | level | context |
|---|---|---|
| `history.link` | INF | `s`, `kind`, `path`, `ok` — one record per entry in `historyPaths` |

The provisioning log gets the human-readable counterpart beside the skills
line it is modelled on: `history mounted at /gurt/history, linked as
~/.claude/projects, ~/.claude/todos`, or the failure sentence naming the
entry and the exit code.

## 8. Accepted limits

- **No quota, no retention, no pruning.** A long-running session's history
  grows without bound and is removed only with the session. Same policy the
  session JSONL already has (`requirements-session-log.md` §6 lists
  retention as a non-goal).
- **No migration.** Pre-existing in-container history is not rescued; §2's
  last paragraph is the argument.
- **No cross-container resume guarantee for a repo-set change**, except for
  claude-code. Every kind keys its transcripts by project path (§3), and a
  repo-set change moves that path; only claude-code can be pinned past it,
  via `CLAUDE_CODE_PROJECT_DIR_NAME` (§3.2). For the others the old entries
  stay on disk and are inert rather than resumed. The history survives;
  whether the CLI addresses it is that CLI's scheme, not gurt's.
- **codex keeps its index next to its credential file, and that is not
  worked around here.** Mounting `.codex/sessions` preserves the rollout
  files; the `state_5.sqlite` / `thread_history_1.sqlite` index that a
  native resume reads is top-level, sibling to `auth.json`, and it stores
  an **absolute** `rollout_path`. Binding those two files individually is
  the obvious next step and is deliberately left to §11 phase 3, behind a
  live check — an index whose absolute paths disagree with the mount is a
  worse failure than no index at all.
- **opencode gets no history at all, permanently** (§3.3) — not a gap to
  close on a later pin, unless upstream splits the store.
- **`historyPaths` is per kind, not per instance.** Two agent instances of
  the same kind in one session are not a thing that exists.

## 9. Acceptance

1. `npm run lint`, `npm run typecheck`, `npm test` clean; no pre-existing
   test changed to accommodate this work.
2. `node scripts/session-history-mount.test.mjs` (new, pure node, no
   daemon), asserting:
   - a kind with an empty `historyPaths` (opencode, §3.3) produces the
     mount list it produces today — byte-identical config args, no link
     `exec`;
   - a kind with entries adds exactly **one** read-write `hostMounts`
     entry targeting `/gurt/history` regardless of how many entries it
     has, and one link per entry;
   - `sessionConfigArgs` returns the per-session merged config path for a
     plain single-repo executor (§4.1 — the regression that would
     otherwise surface as a broken `exec` on an ordinary session);
   - the mount is not `readonly`, and the slugs of two entries from
     different agent homes do not collide (§3.1);
   - ensuring the directory twice, with a file written in between, keeps
     the file (§4 step 2 — the `rmTree` that must not be there).
3. Deletion, extending the existing shape of
   `scripts/session-delete-container.test.mjs`: deleting a session removes
   the history directory, and does so **after** the container `rm`.
4. Survival, in the same test: `teardown(…, 'remove')` on its own — the
   rebuild path — leaves the history directory in place. This is the
   feature; a test that only covers deletion would pass on a
   delete-everything implementation.
5. **The credential boundary, checked rather than assumed** (§6.2): after
   a live session of every non-empty kind, `grep -ril` over that session's
   host history directory finds no `auth.json`, no `oauth_creds.json`, no
   `refresh_token` and no `access_token`. This is the item §3.3 exists
   because of — it must fail loudly if someone ever gives opencode a
   non-empty `historyPaths`, so it runs against whatever the table says
   rather than against a fixed list of paths.
6. **Live, per kind, and a release blocker for any kind with a non-empty
   `historyPaths`**: start a session, take a turn, force a container
   rebuild (remove the container out from under it, keeping the repo set),
   resume — and get a session that continues rather than the "could not
   resume — create a new session" of §1. As with
   `requirements-oauth-credentials.md` §9.9, "working" means the turn
   continues with the earlier context, not merely that the adapter spawns.
   The automated items above stop where the bytes leave gurt's code; this
   is the part none of them can stand in for.
7. For claude-code additionally: item 6 again, but with the **repo set
   changed** between the two turns — which is what
   `CLAUDE_CODE_PROJECT_DIR_NAME` is set for (§3.2). Item 6 passing while
   this fails means the env var is untested; this passing while item 6
   fails would mean the env var is doing all the work and the mount none
   of it.
8. The container's history directory is writable by the remote user on a
   default image (§6.5) — observable as a non-empty host directory after
   one turn.

## 10. Phases

The mechanism is one change; the per-kind coverage is not, because each
kind's boundary was a separate finding (§3).

1. **The mechanism, and claude-code.** `historyPaths`, the host directory,
   the single bind, `linkContainerHistory`, the §4.1 config-condition fix,
   the §4.2 draft rule, and `historyPaths` non-empty for claude-code only
   (`.claude/projects`, `.claude/todos`) plus its
   `CLAUDE_CODE_PROJECT_DIR_NAME`. Cleanest boundary of the four — no auth
   file in `~/.claude` at all — and the only kind that can be made
   path-independent, so it is the one that proves the design end to end.
   Every other kind keeps an empty list and is untouched.
2. **gemini.** `.gemini/tmp`, `.gemini/history`, and the `projects.json`
   file entry that makes the shortId stable — the first use of §3.1's file
   case, and the first kind whose credential file is a top-level sibling of
   what is mounted, so acceptance item 5 does real work here.
3. **codex, behind a live check.** `.codex/sessions` is easy; the two
   top-level index DBs next to `auth.json` are the question, and their
   absolute `rollout_path` is the risk (§8). Ships only if a rebuilt
   container actually resumes — otherwise codex stays at phase 0 with the
   finding recorded, which is a better outcome than an index that
   disagrees with the filesystem.
4. **opencode — no phase.** §3.3.

## 11. Out of scope

Reading, parsing, rendering or migrating the agent's own transcript —
gurt's chat log stays the UI's source of truth
(`requirements-session-log.md`). Sharing history between sessions, or
seeding a new session from another's. Compaction, retention windows, export
and encryption at rest for session data (all would apply to the existing
session JSONL first, and belong in that document). Named Docker volumes as
a storage mechanism (§5). Mounting anything else out of the agent's home —
caches, config, MCP state, installed adapters — each of which is a separate
question with its own credential boundary to check.
