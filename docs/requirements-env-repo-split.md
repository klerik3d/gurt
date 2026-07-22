# Requirements: split Env and Repo

Status: draft for review · Owner: klerik3d · Target: gurt Electron PoC (this repo)

This document is a work order for an implementing agent. Read `README.md`
first. Key code: `src/shared/types.ts`, `src/shared/api.ts`,
`src/shared/keys.ts`, `src/main/store.ts`, `src/main/envs.ts`,
`src/main/provision.ts`, `src/main/sessions.ts`, `src/main/kernel.ts`,
`src/renderer/src/components/SettingsPage.tsx`,
`src/renderer/src/components/Sidebar.tsx` (NewSessionModal). Do not change
the contract described here without asking the owner.

## 1. Motivation

`RepoConfig` fuses two entities: repo identity (name, url, credential) and
environment definition (devcontainer). Env instances (`EnvState`) are keyed
by repo name; the Settings section named "Environments" actually edits
repos. Split them: Env and Repo are separate workspace-level entities. An
env holds 0..1 *default* repo. A session binds env + repo at creation and
runs with exactly one repo (hard 1:1 session↔repo at start — this
iteration).

## 2. Model (src/shared/types.ts)

```ts
export interface RepoConfig {   // `devcontainer` field REMOVED
  name: string                  // unique per workspace, immutable (as today)
  url: string
  credentialId?: string
}

export interface EnvConfig {
  name: string                  // unique per workspace, immutable (as repos)
  devcontainer: string          // inline devcontainer.json; '' = use repo's own
  repo?: string                 // DEFAULT repo, seeds new sessions; not a runtime binding
}

export interface WorkspaceFile { repos: RepoConfig[]; envs: EnvConfig[] }

export interface EnvState {
  env: string                   // identity — EnvConfig.name
  repo?: string                 // repo it was provisioned with; stamped at up
  session?: string              // owning session; stamped at up, absent = manual pre-warm
  containerId?: string
  remoteWorkspaceFolder?: string
  status: EnvStatus
  error?: string
}

export interface EnvRef { workspace: string; task: string; env: string }
```

- `SessionInfo.envRepo` → two fields: `env: string` (env name) and
  `repo?: string` (the session's repo; absent on a repo-less draft).
- `Tree.workspaces[]` gains `envs: EnvConfig[]` (renderer lists them in
  Settings and the New Session modal).
- `keys.ts`: `envKey = ${ws}/${task}/${env}`; `connKey`/`mcpServerKey`
  derive from it unchanged.

## 3. Invariants

- The session's repo is seeded from `EnvConfig.repo` at creation (nothing
  seeded when unset), changeable via the modal / `sessionEditDraft` while
  not started, fixed at start. **Changing it never touches the env**;
  `EnvConfig.repo` is edited only on the env settings page.
- A session cannot `run` or `enqueue` without a repo — kernel rejects with
  `session has no repository` (same guard spot as the repo-exists check,
  `kernel.ts:141-148`). `draft` is allowed.
- Start gate (`repoIsFree`, `sessions.ts:525-533`, renamed `canStart`):
  BOTH must hold within the task —
  - env free: no `EnvState` with this `env` is `starting`/`running`, and no
    other `starting` session on the same env;
  - repo free: no `EnvState` with the session's `repo` is
    `starting`/`running`, and no other `starting` session with the same repo.
  New sessions over a busy env/repo go to queue or stay draft (current UX).
- Multiple envs may reference one repo. Clone stays
  `cloneDir(ws, task, repoName)` and is shared; the gate above serializes use.
- Changing `EnvConfig.repo` (the default) requires nothing — it only
  affects future session seeding. Env names are immutable (as repo names);
  rename is out of scope.
- **A session has a container; the session id is its identity** (the only
  id-label). `EnvState.session` is stamped at up. The start gate is the
  single arbiter of who may start — checked once, in `startSession`, for
  every path (queue and Run now); a refused start surfaces as
  `startError`. Deleting a session removes its container; so does
  re-pointing a draft's repo/env (a failed start may have left one). The
  clone and env record stay. There is no manual env start. Sessions never
  share a container: adapters, shims, broker state and the mounted clone
  all differ per session.

## 4. Persistence & migration (src/main/store.ts)

- `overrideConfigPath(ws, env)` — same template, keyed by env name.
- `validateName` gains kind `env`; `RESERVED_NAMES.env = []` (segment rules
  only — env name only becomes `.devcontainers/<env>.json`).
- Registry CRUD: `addEnv(ws, env: EnvConfig)`,
  `updateEnv(ws, env: EnvConfig)` (matched by its immutable name),
  `removeEnv(ws, name)` (blocked while any task has an instance — mirror
  of today's `tasksUsingRepo` guard, now `tasksUsingEnv`).
- Instance helpers renamed: `ensureTaskEnv` / `updateTaskEnv` /
  `removeTaskEnv` `(ws, task, env, …)`, matching on `e.env`.
- `removeRepo` guard changes: blocked while any `EnvConfig.repo === name`
  or any task has an `EnvState.repo === name` (a clone exists). A draft
  session pointing at a deleted repo fails at start into `startError` —
  no extra guard.
- Lazy migration, write-back once on first read:
  - `getWorkspace`: file without `envs` →
    `envs = repos.map(r => ({ name: r.name, devcontainer: r.devcontainer ?? '', repo: r.name }))`,
    strip `devcontainer` from repos, save.
  - `getTask`: entries with `repo` and no `env` → `env = repo`, keep `repo`.
  - `readSessions` (existing migration spot): `info.envRepo` →
    `info.env = envRepo` AND `info.repo = envRepo`.
  - `.devcontainers/*.json` untouched (env inherits the repo's name).
- Old containers carry `gurt.repo` labels only: Stop keeps working (by
  `containerId`); exec/attach won't match the new labels until the env is
  restarted once. Acceptable; no code for it.

## 5. Main process

- `envs.ts resolveEnv`/`ensureRunning` gain repo + session arguments:
  sessions pass `SessionInfo.repo` and their id (throw
  `session has no repository` if unset; throw if not registered). Stamp
  both into `EnvState` at up. Clone, branch `gurt/<task>`,
  `forgeFeatures(host)`, fallback `/workspaces/<repoName>` — all
  unchanged, driven by that repo.
- `ensureRunning(ref, repo, session)` is dumb on purpose: own container
  running → attach; else remove the previous session's leftover (the gate
  saw the env free) and `up` under the session's label. No busy/ownership
  arbitration here — that is the gate's job. `releaseSession(ref,
  sessionId)` — session delete / draft re-point — removes the owned
  container, keeps clone + record. No manual start; `stopEnv` /
  `removeTaskEnv` stay.
- Container id-label: the single `gurt.session=<session id>` (replaces
  `gurt.repo` et al.) in `provision.ts idLabelArgs`; `up`, adapter install
  and spawn all pass it (`EnvContext.session`).
- Override config: write `envCfg.devcontainer` to
  `overrideConfigPath(ws, ref.env)`.
- `removeTaskEnv` teardown: remove the clone only if no other `EnvState` in
  the task has the same `repo`.
- Runtime repo resolution — `resolveGitAccess`, `git/broker.ts
  envRepo(ref)`, `githubServer.ts requireGitAccess`, `mcp/manager.ts`
  cloneDir — uses the *instance's* `EnvState.repo` (not `EnvConfig.repo`)
  → `RepoConfig`. Keying by `envKey` stays.

## 6. API (src/shared/api.ts)

- New: `addEnv(ws: string, env: EnvConfig): Promise<void>`,
  `updateEnv(ws: string, env: EnvConfig): Promise<void>`,
  `removeEnv(ws: string, name: string): Promise<void>`.
- Renamed: instance `removeEnv(ref)` → `removeTaskEnv(ref: EnvRef)`.
  `startEnv`/`stopEnv` keep names, `ref` shape changes.
- `createSession(ref: EnvRef, repo: string | null, agent, …)` — the
  session's repo, inserted after `ref`.
- `SessionDraftPatch`: `envRepo` → `env?: string` plus
  `repo?: string | null` (null clears; absent = unchanged).
- Unchanged: `discoverDevcontainer` (now feeds the env form),
  `credentialUsedBy` (repos only — envs hold no credentials), all
  changes/diff methods (repo/clone-keyed), `taskDirtyRepos`.

## 7. Renderer

- `SettingsSection` = `'general' | 'environments' | 'repos' | 'clients' |
  'credentials'`. Keep the existing Modal pattern for both editors.
  - Environments section lists `WorkspaceFile.envs`. Modal fields: name
    (immutable on edit, as repos), "Default repository" picker (workspace
    repos + "no repository"), devcontainer `JsonEditor` with auto-detect
    (enabled only when a default repo is set; uses its `url`).
  - Repos section = current `EnvironmentModal` minus devcontainer: name
    (immutable on edit), url, credential chip.
- `NewSessionModal` (Sidebar.tsx): ENVIRONMENT picker lists envs; default
  first env. The chips row under it (`Sidebar.tsx:550-560`) becomes the
  session-repo chip: repo's short URL with a pick-menu of workspace repos
  plus "no repository"; dashed chip when unset. State is **modal-local**
  (`repo`), seeded from the picked env's `EnvConfig.repo` — re-seeded when
  the env pick changes; in edit-draft mode seeded from `session.repo`. It
  goes out in the `createSession` / `sessionEditDraft` payload; **no env
  API calls from this modal**. Run/Queue disabled with a hint while repo is
  unset; Draft always allowed. No busy pre-check or confirm dialog:
  "Run now" goes through the same start gate as the queue and a refusal
  surfaces as the session's `startError`. Git-credential note resolves
  from the picked repo; hidden when none.
- TaskPane: env rows keyed by `env.env`, label = env name + repo tag from
  `EnvState.repo` when present; queue hint reworded to "starts when the
  environment and its repository are free". ChangesSection unchanged.
- App footer join, provision-log key, SessionPane/Chat pills: `info.env`
  (pill may add the repo tag when `info.repo` is set).
- Vocabulary: "environment" now always means the Env entity; fix the
  credential delete-block message ("repo / client settings").

## 8. Non-goals

- Multi-repo sessions or envs; repo or env rename; clone layout or branch
  naming changes; worktrees; UUID/slug identity (name stays the key);
  CommandPalette nav entries; migrating labels of already-running
  containers.

## 9. Acceptance

1. `npm run typecheck` and `npm run build` pass.
2. All existing `node scripts/*.test.mjs` suites pass.
3. New `scripts/env-split-migration.test.mjs`: old-format fixtures for
   workspace.json / task.json / sessions.json read back migrated (one env
   per repo with the same name; repos stripped of `devcontainer`;
   `envRepo` → `env` + `repo`), and the write-back happens exactly once.
4. `grep -rn 'envRepo' src` matches nothing; `grep -rn 'gurt\.repo' src`
   matches nothing.
5. Manual flow: create an env with no default repo → new session on it has
   no repo chip value, Run/Queue disabled; pick a repo in the modal → run
   works and the env's config in Settings still shows no default repo; a
   second session over the same repo (any env) only queues or drafts.
