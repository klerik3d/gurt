# Requirements: new projects (local repos, the starter env, publish)

Status: implemented (as-built) · Target: gurt Electron MVP (this repo)

Key code: `src/main/localRepo.ts` (`createLocalRepo`, `publishLocalRepo`),
`src/main/store.ts` (`localRepoDir`, `addRepo`/`updateRepo`/`removeRepo`,
`markRepoPublished`), `src/main/git/env.ts` (the `local` mode),
`src/main/changes.ts` (`mergeToMain`, `RepoChanges.local`),
`src/main/mcp/githubServer.ts` (`create_pull_request` refusal),
`src/main/git/providers.ts` (`ForgeProvider.createRepo`),
`src/main/operatorEnv.ts` (`bundledStarterEnv`, `bundledEnv`),
`resources/env/starter.devcontainer.json`, `src/shared/types.ts`
(`RepoConfig.local`, `STARTER_ENV_NAME`, `PublishSpec`),
`src/renderer/src/components/ConfigTab.tsx` (the repo and env pickers),
`src/renderer/src/components/SettingsPage.tsx` (`RepoModal`,
`PublishRepoModal`), `scripts/local-repo.test.mjs`.

## 1. Motivation

gurt was built around a repository that already exists. A repo was a git
URL, an env was seeded from that repo's devcontainer, and delivery was a pull
request. For a project that doesn't exist yet, or a quick experiment with no
clear future, every step pushed back:

1. a repo could not be created in gurt — it had to be made on a forge first;
2. a new repo has no devcontainer, so the env had to be written by hand (the
   one image-only env gurt ships was offered to the operator only);
3. an empty repo has no `HEAD`, so `git archive` for an image build, the
   task branch and the changes panel's `origin/<default>` all had nothing to
   stand on;
4. all of that took five forms in an order nothing stated.

The fix: start local and publish later. A project can begin as a repository
kept by gurt on this machine, with no forge and no credential. It runs in a
bundled env that needs no setup. Once it is worth keeping, one action moves
it to GitHub and adopts its devcontainer as an env.

Non-goals: a separate "sandbox" mode or a one-click scratch session. A local
repo is an ordinary workspace repo. It is created where a repo is picked, and
it stays available to every later session.

## 2. Local repos

`RepoConfig.local: true` means gurt owns the repo's storage: a bare
repository at `~/.gurt/<ws>/repos/<name>.git`, which `url` points at.

- **Creation** (`createLocalRepo`): validate the name, refuse an existing
  directory (it is somebody's history — never adopted, never overwritten),
  `git init --bare --initial-branch=main`, write one empty commit
  (`hash-object -t tree /dev/null` → `commit-tree` → `update-ref`, authored
  `gurt <gurt@localhost>`), register. Any failure removes the directory.
- **Why the seed commit:** it is what lets the rest of gurt run unchanged on a
  brand-new project. The task branch has a commit to fork from, an image
  build has a `HEAD` to archive, and the changes panel has an `origin/main`.
- **Everything else is the ordinary path.** `ensureClone` clones the path;
  fetch, push and update-from-main are file operations against it.
- **The flag is the store's.** `addRepo` accepts `local` only for the bare
  repo `createLocalRepo` has just made at its fixed path. `updateRepo` keeps a
  local repo's url and flag whatever it is sent, and can never make a repo
  local. `markRepoPublished` is the one way out (§6). This matters because
  `removeRepo` deletes a local repo's storage, and what it deletes has to be
  gurt's to delete.
- **Removal** deletes the storage, after the usual refusals (an env defaulting
  to it, a task holding a clone). The confirmation says it is the only copy.
- `repos` is a reserved task name, for the same reason `skills` is.

## 3. The starter env

`starter` (`STARTER_ENV_NAME`) is a bundled, image-only env. It is code, not
user data, just like the operator default: it lives in
`resources/env/starter.devcontainer.json`, resolves by name wherever a
workspace env would (`bundledEnv`, `isBundledEnv`), and its name is reserved
against workspace envs.

The image is `node:22-trixie` (Debian 13, the floor — not bookworm), not the
operator's `-slim`. The full variant sits on buildpack-deps, so git (the clone is committed to from inside
the container), python3, make and a C toolchain are all present. It is pinned
by tag for now; pin it by digest like the operator env when it is next bumped.
It is not pre-pulled by the machine checklist, so the first start pulls it.

It is offered in every non-operator session's env picker and listed
read-only in Settings → Environments. Picking it keeps the session's repo
selection, because the starter claims no default repo.

## 4. Delivery and remote verbs for a local repo

- **Host git access** has a fourth mode, `local`. It uses the same reset config
  as `blocked` (no credential helper, ambient ssh refused), but remote verbs are
  allowed, because there is no auth to resolve.
- **Merge into main** (`changes.mergeToMain`, `changesMergeToMain`) is a local
  repo's delivery in place of a pull request. It fetches, refuses a branch that
  is behind the default (with "update from main first", as a forge would
  refuse to merge it), then pushes `HEAD:refs/heads/<default>`. Afterwards the
  thread is empty and reads as integrated, and the next task's clone starts
  from there. `RepoChanges.local` is what makes the task pane and the diff
  sidebar offer it.
- **github MCP:** `git_pull`/`git_push` work against the local origin.
  `create_pull_request` is refused *before* its push, with a message that
  points at `git_push` and at publishing.
- **Commit identity:** there is no credential, so none is injected. Host
  commits from the changes panel use the machine's own git identity, and a
  commit made inside the container needs one configured there. This is the
  same as for any repo whose credential does not resolve.

## 5. Creating one where a repo is picked

The draft's repo picker ends with **new local repository…**. Typing a name and
pressing Enter creates the repo (§2), selects it (added to a researcher's
selection, replacing anyone else's), and, if the draft has no env yet, picks
the starter. Settings → Repos → **+ New repo** offers the same thing as a
**new, local** source beside **existing, by URL**.

## 6. Publish, with env adoption

From the local repo's edit dialog: **Publish to GitHub…** opens a form with a
`git-token` credential for a GitHub host, the name on GitHub (defaults to the
repo's), an optional organization, private/public, and "adopt the repo's
devcontainer" (on by default). Publishing runs these steps in order, so that a
failure leaves the repo usable:

1. Discover the devcontainer from the local storage, while it is still the url.
2. `ForgeProvider.createRepo`: `POST /user/repos` or `/orgs/<org>/repos`
   with `auto_init: false`. An initial commit on the forge would diverge from
   the history about to be pushed.
3. `git push --all` from the storage to the new repo under its managed
   access. A failure here names the forge repo that was created and left
   empty. Nothing local has changed yet.
4. `markRepoPublished`: the entry gets the forge url and the credential link,
   and loses `local`.
5. `remote set-url origin` in every task's clone. Every branch a clone tracks
   was in the storage and is now on the forge, so the remote-tracking refs stay
   true and the next `fetch --prune` does not mistake them for integrated.
6. Remove the storage.
7. Adopt: if a devcontainer was found and no env already has the repo's name,
   add an env of that name with the repo as its default. This step never
   undoes the publish. The result reports what happened (`env` / `envNote`).

`publishRepo` is not exposed to the operator (`none`): it creates something on
an external service with a credential.

Known edges: env image tags hash the repo url, so a published repo's
build-based envs rebuild once. GitHub is the only forge with `createRepo`.
