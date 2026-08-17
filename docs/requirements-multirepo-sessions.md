# Requirements: discovery sessions (more than one repo per session)

Status: implemented · Owner: klerik3d · Target: gurt Electron MVP (this repo)

Key code: `src/shared/types.ts`, `src/shared/api.ts`, `src/main/sessions.ts`,
`src/main/containers.ts`, `src/main/provision.ts`, `src/main/store.ts`,
`src/main/kernel.ts`, `src/renderer/src/components/Sidebar.tsx`,
`src/renderer/src/components/tags.tsx`.

Extends `requirements-session-container.md` (the 1:1 session↔container model)
and `requirements-env-repo-split.md`, whose §8 listed "multi-repo sessions or
envs" as a non-goal — this document is that follow-up. It implements a
narrower thing than the multi-repo fan-out sketched in
`design-orchestration.md` (a parent task spawning N independent per-repo
sessions): here it is one session, one container, several repos.

## 1. Motivation

Some discovery-style agent work — understanding a cross-cutting problem,
designing a contract between services — needs to read more than one repo's
code to have enough context. A session was hard-wired to exactly one repo
(`SessionInfo.repo?: string`), so today that work either happens outside gurt
or is faked by cloning a second repo by hand inside the container.

## 2. Decisions

Reached by discussion before implementation; the rejected alternatives are
recorded because the reasoning is easy to re-derive backwards otherwise:

- **Fan-out into N single-repo sessions was rejected.** It was the first idea
  (multi-select a repo picker, create one session per repo, group them by a
  shared id), but it does not match the actual need: one agent that reasons
  over several repos *at once*, not several independent agents.
- **Fully symmetric, all-repos-writable sessions were rejected** as too large
  for this pass. Making every repo writable needs the git broker (currently
  "one repo, fixed for the container's whole lifetime", `git/broker.ts`) to
  become request-scoped, and needs the scheduler's single exclusive lock to
  become a set of locks. Both are real work with no immediate need.
- **What shipped instead: read/write is asymmetric by *use*, not by field.**
  `SessionInfo.repo?: string` and `SessionContainer.repo?: string` become
  `repos: string[]` — a flat list, no `primary`/`secondary` distinction in the
  type. `repos.length === 1` is a normal session, byte-for-byte the same
  behavior as before. `repos.length > 1` is a discovery session:
  - the scheduler's exclusive clone lock is skipped entirely — `repoKey`
    returns `null` for anything but exactly one repo, so nothing is ever
    claimed or waited on for a discovery session (`sessions.ts` `repoKey`,
    `canStart`, `scheduleSync`);
  - the git broker is never wired up, regardless of the `gitAccess` toggle —
    it is scoped to one repo for a container's whole life and generalizing it
    was explicitly out of scope this round (`containers.ts` `resolveLaunch`);
  - `repos[0]` is the *build anchor*: `materializeEnvConfig` still archives
    one repo's `HEAD` for the image build/cache-key exactly as today, purely
    because an image has to be built from something. It carries no other
    meaning — there is no "primary" repo at the type or UI level.
- **All repos, anchor included, are mounted as siblings**, not just the
  non-anchor ones. A single-repo session's container is unchanged
  (`--workspace-folder` still points straight at the one clone). A discovery
  session's `--workspace-folder` points at a fresh, empty, session-scoped
  wrapper directory (`store.multiRepoWorkspaceDir`, `<task>/.multirepo/
  <sessionId>/repos` — deliberately not the task directory itself, which also
  holds `task.json`/`sessions.json`); every repo, including the anchor, is
  bind-mounted into it by name via explicit `--mount` flags added to
  `devcontainerUp` (`provision.ts`). *(Mechanism since changed, 2026-08-17:
  the CLI validates `--mount` with a strict regex that rejects `,readonly`, so
  the mounts now ride the `mounts` array of a per-session merged copy of the
  env config — `.multirepo/<sessionId>/devcontainer.json`, written by
  `devcontainerUp`, resolved by `up` and every `exec` of a mounted session.
  Layout too: repos land under the env config's own `workspaceFolder`
  (`<workspaceFolder>/<repo-name>`) — its untouched `workspaceMount` binds the
  empty wrapper over the image's baked copy, so the agent starts in the env's
  configured workspace and sees the repos inside it; `/workspaces/repos` is
  only the fallback root when the config sets no `workspaceFolder`.)*
- **Mounts are plain read-write bind mounts, not `readonly`.** The session is
  a discovery session by convention (no git broker, so nothing meaningful can
  be pushed anywhere), not by filesystem-level enforcement — enforcing
  read-only mounts was explicitly deferred to a separate, later task/
  mechanism rather than folded into this change. *(That deferral is closed:
  `requirements-session-roles.md` turns the discovery session into the
  **researcher** role and mounts its repos `readonly`.)*
- **Repos are the same shared clones every session of the task uses**, not a
  separate shallow/ephemeral checkout. A discovery session may later grow
  into a review session, at which point it needs to see the *actual* working
  tree (including another session's in-progress uncommitted changes), not a
  point-in-time snapshot.
- **The repo list is editable while a draft**, the same as the old single
  `repo` field was — `editDraft`/`sessionEditDraft` accept `repos?: string[]`
  and release a previously-provisioned container when it changes, exactly
  mirroring the pre-existing single-repo behavior. (An earlier version of this
  plan considered locking the repo set at creation time for a discovery
  session specifically; that was dropped in favor of one uniform code path —
  `repos` is just a list, single- or multi-, with no special-cased mutability
  rule for either size.)
- **UI**: the repo picker in `NewSessionModal` (`Sidebar.tsx`) is multi-select
  in place — no second picker. The GIT ACCESS toggle is hidden once more than
  one repo is picked, and `gitAccess` is forced to `false` on submit
  regardless of the toggle's last value. Repo tags/marks across the app
  (`tags.tsx` `EnvRepoMarks`, `SessionPane.tsx`, `TaskPane.tsx`, `Chat.tsx`,
  `App.tsx`) render one tag per repo instead of assuming a single value.

## 3. Non-goals (this pass)

- Write access to more than one repo in a session (needs the git broker to
  become per-request repo-aware, and the scheduler lock to become a set —
  see §2).
- Enforcing read-only mounts at the filesystem/Docker level. *(Since taken:
  see `requirements-session-roles.md` §4.)*
- Cleaning up `<task>/.multirepo/<sessionId>/` on session delete — clones
  already outlive their sessions by design, and the wrapper directory holds
  no data (only mount points), so an orphaned empty directory is inert, not a
  data-loss risk. Left as a known gap rather than solved here.
- Any change to the git broker itself, or to the scheduler's core exclusivity
  invariant for `repos.length === 1` sessions — the existing model is
  untouched.

## 4. Migration

`SessionInfo.repo?: string` and `SessionContainer.repo?: string` records on
disk migrate to `repos: string[]` on first read, the same lazy write-back-once
pattern `readSessions` already used for the `envRepo` fusion (`store.ts`).
`LegacyEnvState.repo` (the pre-1:1-container `task.json` shape) folds the same
way when it lands on a session's container record.

## 5. Acceptance

1. `npm run typecheck` is clean (both `tsconfig.node.json` and
   `tsconfig.web.json`).
2. `node scripts/session-repo-gate.test.mjs`, `queue-handoff.test.mjs`,
   `session-delete-container.test.mjs` and `env-split-migration.test.mjs`
   pass, updated for the `repos: string[]` shape. The rest of
   `scripts/*.test.mjs` passes unmodified.
3. A single-repo session's provisioning path (`--workspace-folder` = the
   clone dir directly, no extra `--mount` flags, git broker wired as before)
   is byte-for-byte what it was before this change.
4. **Not yet verified**: the discovery-session mount path itself (wrapper
   directory + explicit `--mount type=bind,...` flags into a live
   `devcontainer up`) has only been reviewed against the devcontainer CLI's
   documented behavior, not run against a real Docker daemon — this
   environment has none. The container-side path each repo lands at
   (`/workspaces/repos/<repo-name>`, since the wrapper's fixed basename
   `repos` is what `devcontainerUp` derives its default remote root from) and
   the CLI's handling of multiple `--mount` flags alongside
   `--workspace-folder` should be checked manually on first real use.
