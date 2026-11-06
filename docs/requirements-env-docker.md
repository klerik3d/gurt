# Requirements: plain docker runtime, own env format (drop devcontainer)

Status: implemented, then revised by the owner (as-built notes in §14) · Target: gurt Electron MVP (this repo)

This document is a work order for an implementing agent. Read
`docs/architecture.md` ("How a session starts") and
`docs/requirements-session-container.md` first. Key code:
`src/shared/types.ts`, `src/shared/envConfig.ts`, `src/main/provision.ts`,
`src/main/containers.ts`, `src/main/sessions.ts`, `src/main/store.ts`,
`src/main/operatorEnv.ts`, `src/main/adminWrites.ts`, `src/main/localRepo.ts`,
`src/main/doctor.ts`, `src/renderer/src/components/SettingsPage.tsx`,
`src/renderer/src/components/ConfigTab.tsx`. Do not change the contract
described here without asking the owner.

> **Revision (owner decision, after the first implementation):** gurt knows
> nothing about devcontainer any more. It does not look for a
> `devcontainer.json` in a project, does not convert one into its format, keeps
> no notes about what did not carry over, and does not imitate its fields. So
> §4 (importer), §5 (migration) and the discovery/adopt part of §7 are
> **removed**, `user` and `importNotes` are gone from the env, and the container
> user is the image's own (set it in the Dockerfile). Where the text below still
> mentions them, this note wins; §14 says what is built.

Supersedes `requirements-env-devcontainer.md` (the env normal form) and the
devcontainer parts of `requirements-session-container.md`,
`requirements-session-operator.md` §4 (env held fields) and
`requirements-new-projects.md` §6 (adopt).

## 1. Motivation

gurt adopted devcontainer as "the standard env description" and wraps the
`@devcontainers/cli` as its container runtime. In practice:

- **gurt already diverges from the spec** (build context default, no compose,
  no `build.options`, hooks stripped for read-only roles, mounts/features
  injected) — the stored devcontainer.json is a private format with someone
  else's semantics.
- **The CLI is the hot path and it is slow.** Every `devcontainer exec` boots
  a Node process that re-resolves the config (hence `--override-config` on
  every exec, atomic override writes, `sessionConfigArgs` mirroring), probes
  the user env, then calls docker. ACP, adapter probe/install, skills/history
  links, auth-file writes and terminals all go through it
  (`probeAdapterAndLinkSkills` exists only to save one CLI boot).
- **A layer of workarounds exists only because of the CLI:** `--no-lockfile`,
  `--mount-workspace-git-root=false` (must match on up and every exec or
  exit 127), `UP_RESULT` stdout parsing, `LIFECYCLE_BANNER` parsing,
  create-hook retry by parsing `description`, `ELECTRON_RUN_AS_NODE` spawns +
  `asarUnpack`, readonly binds forced through config `mounts`, the node
  feature vs `libatomic` exception keyed on the operator env name.

The one real loss is **devcontainer features**; they are not supported (§12) —
anything an env needs goes into its image or Dockerfile.

Target: gurt owns a small env format and drives containers with the docker
CLI directly. `@devcontainers/cli` is removed from the app.

## 2. Model (src/shared/types.ts, src/shared/envConfig.ts)

```ts
export interface EnvConfig {
  name: string                 // immutable, as today
  /** Exactly one of `image` | `dockerfile`. */
  image?: string               // e.g. "node:22-trixie", digest pins allowed
  dockerfile?: string          // Dockerfile content
  dockerfilePath?: string      // provenance only (repo-relative), as today
  /** Only with `dockerfile`. `context` is repo-root-relative (default "."),
   *  must stay inside the repo snapshot: no absolute path, no `..` escape. */
  build?: { context?: string; args?: Record<string, string>; target?: string }
  /** Container environment (`docker create --env`). */
  env?: Record<string, string>
  /** Shell script, run once when the container is created: as the container user, in the
   *  workdir, on the open network, before the network switch. The successor
   *  of onCreate/updateContent/postCreate. */
  setup?: string
  /** Shell script, run on every container start (create and restart). The
   *  successor of postStart. */
  start?: string
  repo?: string                // default repo, as today
}
```

`devcontainer` is removed from the type.

`src/shared/envConfig.ts` (keep the file; it is shared with the renderer):

- `validateEnvConfig(env): string | null`: exactly one of image/dockerfile
  (non-empty); `build` only with `dockerfile`; `build.context` relative and
  inside the snapshot; `env` keys match `^[A-Za-z_][A-Za-z0-9_]*$`.
- `envImageTag(repoUrl, commit, dockerfile, build)`: unchanged semantics
  (`gurt-env:<16 hex>` over url, commit, Dockerfile content, canonical
  `build`). The image-identity rules of requirements-env-devcontainer.md §3
  still hold.
- `parseEnvConfigText(name, text)`: the JSONC reader of the bundled env files.

## 3. Runtime (src/main/provision.ts, src/main/containers.ts, src/main/sessions.ts)

All container work goes through the docker CLI (`dockerCliPath()`, spawned
with `hostPath()`), never by container label lookup on exec: every exec
targets the **container id** in the session record.

### 3.1 Image

- `image` env: `docker image inspect`; missing → `docker pull <image>` with the
  output streamed to the provisioning log (phase `image`).
- `dockerfile` env: `buildEnvImage` as today, except the Dockerfile is written
  to the scratch dir **outside** the context and passed with `-f`; nothing is
  written into a `.devcontainer/` of the snapshot. Context = `build.context`
  resolved against the snapshot root. Labels, tag reuse, stale-image removal,
  `buildsInFlight`, Settings pre-build and the badge are unchanged.

### 3.2 gurt's Node runtime (replaces the node feature)

Adapters are npm packages and need Node regardless of the env image.

- A pinned image constant `NODE_RUNTIME_IMAGE` (`node:<LTS>-bookworm-slim@sha256:…`,
  must satisfy every plugin's minimum — pi needs ≥ 22.19).
- A docker volume `gurt-node-<digest12>-<arch>` (labels `gurt.managed=1`,
  `gurt.kind=node-runtime`), filled once with
  `docker run --rm --platform <env image platform> -v <vol>:/out NODE_RUNTIME_IMAGE sh -c 'cp -a /usr/local/. /out/ && touch /out/.gurt-ready'`.
  A volume without `.gurt-ready` is emptied and refilled. `arch` is the env
  image's architecture (`docker image inspect -f '{{.Architecture}}'`).
- Mounted into every session container read-only at `/opt/gurt/node`.
- Adapter install: `npm install -g` with `NPM_CONFIG_PREFIX=$HOME/.gurt/npm`,
  run by `/opt/gurt/node/bin/npm`. The version marker stays where it is.
- Adapter launch uses gurt's node explicitly
  (`/opt/gurt/node/bin/node <resolved bin script>`) so a project's own, older
  Node on PATH cannot break it. If a plugin's `bin` is not a JS file, exec it
  directly. Check every plugin under `src/plugins/agents/`.
- `/opt/gurt/node/bin` and `$HOME/.gurt/npm/bin` are **appended** to the
  agent's PATH (the project's toolchain wins for the agent's own commands).
- After the first install, `node --version` failing in the container is a
  start error that quotes its stderr and says the image needs a glibc distro
  (musl/alpine is unsupported, §12).
- The operator special case (`bundledOperatorImage`) is deleted: every env gets
  the same runtime.
- Verify, before settling the runtime image, that its node runs in: both
  bundled envs, `mcr.microsoft.com/devcontainers/base:ubuntu`, `python:3`,
  `ubuntu:24.04`, `debian:bookworm-slim` (`libstdc++`/`libatomic` presence).
  Record the result in §13 As built.

### 3.3 Create

`docker create` (then `docker start`), on Docker's default bridge as today:

- `--label gurt.session=<id> --label gurt.managed=1 --label gurt.runtime=docker`
- `--init`, `--entrypoint /bin/sh <image> -c 'trap "exit 0" TERM; sleep infinity & wait'`
  (the CLI's keep-alive; the image's own entrypoint/CMD is not run, §12)
- `--env K=V` for `env.env`
- mounts, all `--mount type=bind,…[,readonly]` / `type=volume`:
  - every repo → `/workspaces/<name>` (readonly per role), one repo or several,
    so file paths never depend on the repo count; workdir = `/workspaces/<name>`
    when there is exactly one repo, else `/workspaces`; a repo-less operator
    gets workdir `/workspaces` with no repo mounts. The empty wrapper dir is no
    longer mounted;
  - skills `/gurt/skills` (ro), history `/gurt/history` (rw), node runtime
    `/opt/gurt/node` (ro, volume).
- `remoteWorkspaceFolder` = the workdir, computed by gurt (no CLI result).
- Stale-bind handling (`STALE_BIND_RE`, `warmBindPaths`, backoff, 3 attempts)
  stays, matched against `docker create`/`start` stderr — it is a Docker
  Desktop fault, not a CLI one.

### 3.4 After create (in order; status `post` from step 2)

1. **User + UID.** The user is the image's `Config.User`, else `root`. On a
   Linux host, when user ≠ root and its uid ≠ the host uid (and host uid ≠ 0):
   as root, `groupmod`/`usermod` the user to the host uid/gid and `chown -R`
   its home (what the CLI's default `updateRemoteUserUID` did for the
   read-write clone mounts, see requirements-agent-history.md). Target uid
   already taken or `usermod` missing → log a warning and continue. Not on
   macOS/Windows.
2. **setup** (unless the role mounts read-only — today's hook stripping):
   `docker exec -u <user> -w <workdir> <id> "${SHELL:-/bin/sh}" -lc <setup>`
   (resolve the user's shell from `/etc/passwd`, fall back to `/bin/sh`).
   Failure → remove the container and retry once in a fresh one, then fail
   with the output tail — the semantics of today's create-hook retry
   (`hookOutputTail` reused), now without parsing CLI output.
3. **start** (every start, incl. restart of a stopped container): same exec
   form. Failure fails the start; the container is kept.
4. **Env probe** (replaces `userEnvProbe`): once per container id, after
   setup: `$SHELL -lic` printing `PATH` behind a marker, 10 s timeout, fall
   back to `-lc`, then to the image PATH. Cached on the session's container
   record; passed as `-e PATH=<probed>:/opt/gurt/node/bin:$HOME/.gurt/npm/bin`
   on every exec.
5. The container id is written to the session record **only after** setup
   succeeded. Any `gurt.session=<id>` container not named by the record is
   removed before create (today's sweep) — a crash mid-setup can never be
   adopted.

Restart of a stopped own container: `docker start <id>` → start hook → reuse
the cached probe. The fast path for a running container is unchanged.

### 3.5 Exec

One helper replaces `execArgs`/`runNodeCli`:
`docker exec -i -u <user> -w <cwd> -e PATH=… [-e NAME …] <containerId> argv…`.

- **Secrets never in argv.** Pass `-e NAME` (name only) and put the value in
  the docker client process env. Applies to the agent secret, proxy vars,
  git identity, `launchEnv`.
- File writes (`writeContainerUserFile`: oauth auth files, client config) pipe
  the content through **stdin** into `sh -c 'umask 077 && mkdir -p … && cat > …'`
  instead of `GURT_PROVISION_FILE` in argv.
- Users: `linkContainerSkills`, `linkContainerHistory`, adapter probe/install,
  `spawnAcpAdapter`, `spawnInContainer` (PII-masked fs/terminal),
  terminal (`containerTerminalCommand` → `docker exec -it … "${SHELL:-/bin/sh}" -l`).
- `probeAdapterAndLinkSkills` / `pendingSkillsLink` may be split back into
  plain steps if that is simpler; their only reason was CLI boot cost.

### 3.6 Network, proxy, teardown, reconcile

Unchanged: created on `bridge`, setup and adapter install on the open network,
then `convergeProxyNetwork`; `internal` isolation assertion; stop/remove/GC
via docker; boot `reconcile()`. Addition to reconcile: a `gurt.session`
container **without** `gurt.runtime=docker` is a pre-migration container —
removed (when the store is not degraded) and its record reset, so the session
recreates it on next start. Clones and agent history are host binds; nothing
is lost but in-container state.

### 3.7 Delete

`runNodeCli`, `devcontainerCliPath`, `CLI_SILENCE_TIMEOUT_MS`, `UP_RESULT`,
`LIFECYCLE_BANNER`, `CREATE_HOOK_RE` (as CLI-output parsing),
`MOUNT_WORKSPACE_GIT_ROOT_OFF`, `idLabelArgs`, `BASE_FEATURES`,
`materializeEnvConfig`, `overrideConfigArgs`, `overrideConfigPath`,
`sessionConfigPath`, `sessionConfigArgs`, `canReuseMaterializedConfig`,
`MOUNT_MERGE_FIELDS`, the `~/.gurt/<ws>/.devcontainers/` dir (delete it in the
migration, drop `.devcontainers` from `RESERVED_NAMES` only if nothing else
needs it) and every `.multirepo/<sid>/devcontainer.json`.

## 4. Import from devcontainer.json — removed

gurt does not read a repo's `devcontainer.json`, imports nothing from it and
keeps no record of what it would have carried over (owner decision, see the
revision note).

## 5. Migration — removed

An env stored by the previous release (a `devcontainer` text) is not converted:
it has neither an image nor a Dockerfile, so it is invalid and starting it fails
with `image or a Dockerfile is required`; the user fills it in again in the
editor. The workspace file is otherwise read as before.

## 6. Bundled envs (resources/env/, src/main/operatorEnv.ts)

- `resources/env/devcontainer.json` → `resources/env/operator.json`,
  `starter.devcontainer.json` → `starter.json`, both in the new format (JSONC
  allowed, keep the explanatory comments, minus the node-feature one). Same
  images/digests.
- `GURT_OPERATOR_ENV` / `GURT_STARTER_ENV` keep working, pointing at
  new-format files.
- `materializeEnvConfig`'s refusal of a `build` env for a repo-less operator
  moves to the start path, same message.

## 7. Discovery, publish

- No env discovery. `discoverDockerfiles` stays (root `Dockerfile*` only; the
  editor's "detect Dockerfiles in repo" loads one into the Dockerfile field).
- `publishLocalRepo` no longer adopts an env: `PublishSpec.adoptEnv`,
  `PublishResult.env`/`envNote` and the form's "adopt" choice are removed.
- Regenerate `src/shared/adminTools.generated.ts`
  (`node scripts/gen-admin-tools.mjs`): `discover_devcontainer` is gone.

## 8. Operator / held fields (src/main/adminWrites.ts, gurtServer.ts)

The new format has no field that executes on the host or widens container
privileges (`build.context` is confined to the snapshot by validation;
Dockerfile content runs in the builder, as today — it was never held). So:

- delete `ENV_HELD`, `planEnv` and the env branches of `describe`/`applyHeld`;
  the held machinery stays for MCP entries;
- `OPERATOR_INSTRUCTIONS`: drop the env held-field sentence;
- `held-fields.test.mjs`: drop the env half, keep MCP.

## 9. Renderer

`EnvModal` (SettingsPage.tsx):

- Source: radio **Image** | **Dockerfile**. Image → one text field.
  Dockerfile → the existing `CodeEditor` + "detect Dockerfiles in repo" +
  an "advanced" block for context/args/target.
- **Environment** (`KEY=VALUE` per line), **Setup script**, **Start script**
  (`CodeEditor`, shell).
- `JsonEditor` goes. Badge/build button unchanged.

Text: Network.tsx:276 and tags.tsx:316 ("devcontainer features, postCreate")
→ "image build, setup script, the agent install"; ConfigTab starter tooltip
"for a project with no devcontainer yet" → "for a project with no env yet";
`doctor.ts` detail ("installs the node feature") → the node runtime volume.
`doctor prepareImages` also pulls `NODE_RUNTIME_IMAGE` and fills the volume.

## 10. Packaging, docs (this work order includes them)

- Remove `@devcontainers/cli` from package.json (+ lockfile), its
  `asarUnpack` entry in electron-builder.yml, its renovate rule, the
  `prepare-terminal.mjs` comment.
- Smokes: drop the `.devcontainer/devcontainer.json` seeding workaround for
  the CLI lockfile; env editor flows use the new form.
- `docs/architecture.md`: rewrite "How a session starts" and the
  materialized-config paragraph; env/repo bullets; skills and network
  sections. `README.md`, `docs/development.md`, `docs/agent-brief-workflows.md`,
  `SECURITY.md` (features pin line), `CONTRIBUTING.md` (prerequisites),
  `docs/logging.md`.
- `docs/README.md`: this doc → implemented; env-devcontainer →
  historical (superseded); add "Superseded in part by
  requirements-env-docker.md" notes to session-container, session-operator,
  new-projects.
- The repo's own `.devcontainer/` (for developing gurt) is unrelated and
  stays.

## 11. Order of work

1. **Measure before touching anything** (§13 needs it): with the current
   build, time Run → first prompt for a cold start (new container) and a
   warm start (stopped container), and the wall time of one adapter probe
   exec, on the starter env with claude-code.
2. Format + validation (pure, tests first).
3. Runtime swap (§3), behind the existing `ContainerManager` API — no change
   to its callers' contract beyond what §3.5 says.
4. Discovery/publish/admin surface (§7, §8), regenerate admin tools.
5. Renderer (§9).
6. Packaging, smokes, docs (§10). Measure again.

## 12. Non-goals

- devcontainer features, and any handling of devcontainer at all (no discovery,
  no import, no migration, no notes, no `user` field).
- Compose-based envs.
- Running the image's own ENTRYPOINT/CMD (keep-alive replaces it, as the CLI's
  default `overrideCommand` did).
- musl/alpine env images (the node runtime is glibc).
- Port forwarding, `customizations`, `initializeCommand`, `mounts`/`runArgs`
  from env configs.
- GC of the CLI's old feature-derived images (release note:
  `docker image prune`).

## 13. Acceptance

1. `npm run typecheck`, `npm run lint`, `npm test` pass; `npm run smoke`
   passes; admin tools regen gives no diff.
2. `grep -rn "@devcontainers/cli\|devcontainer up\|devcontainer exec\|runNodeCli\|override-config\|additional-features\|devcontainerCliPath" src scripts electron-builder.yml package.json`
   matches nothing (comments in historical docs are fine).
3. New `scripts/env-format.test.mjs`: validation matrix (§2), the editor's
   `KEY=VALUE` lines, `envImageTag` unchanged for equal inputs. (The importer
   and migration cases of the first draft are gone with §4/§5.)
4. New `scripts/docker-runtime.test.mjs` with a fake `docker` on PATH
   recording argv + stdin: create argv (labels, init, keep-alive, mounts per
   session shape with today's container paths, node volume ro); setup runs
   once, is skipped for read-only roles, failure → rm + one retry → error with
   tail; start runs on create and restart; id recorded only after setup;
   every exec targets the id, carries `-u`, `-w`, PATH; **no secret value
   appears in any recorded argv**; auth-file content arrives via stdin; UID
   alignment only on linux/non-root/mismatch; reconcile removes a
   `gurt.session` container lacking `gurt.runtime=docker`.
5. Existing suites that stubbed the CLI (`provision-hook-retry`,
   `mount-workspace-git-root`, `session-history-mount`, `agent-fixture`,
   `operator-role` up/exec path assertions) are ported to the fake docker or
   deleted where their subject no longer exists — say which in As built.
6. Manual (real docker), each recorded in As built:
   - starter env + claude-code and codex: start, prompt, terminal,
     stop, restart (adapter not reinstalled), recreate;
   - Dockerfile env with `COPY` from the repo: badge missing → build → exists
     → start reuses the image; clone `git status` clean;
   - Linux host, image with a non-root user: files the agent creates in the
     clone are owned by the host user;
   - `internal` network session: setup on the open network, isolation
     asserted after the switch;
   - operator: first-run flow starts it;
   - an existing workspace from the previous release: old containers removed at
     boot, sessions start (its envs, in the old devcontainer form, are
     invalid until filled in again).
7. §11 step 1 and step 6 numbers side by side in As built.

## 14. As built

Work followed §11 from step 2 on; step 1 was **not** done (see "Numbers").
The sandbox this was built in has no docker and no Electron, so everything
below that needs a real daemon is marked **not run**.

### Numbers (§11 step 1 vs step 6, §13.7)

**Not measured, before or after.** The owner told the implementing agent to
skip the speed measurement, and in any case the build environment has no docker
daemon, so the cold-start / warm-start / adapter-probe wall times of §11.1 do not
exist for either build. What is established from the code is the number of
Node-CLI boots, which §1 named as the cost:

| path | CLI boots before | after |
| --- | --- | --- |
| cold start (new container), claude-code + skills | `up` + history link (one per `historyPaths` entry) + adapter probe/skills + adapter install + auth/config writes (0–2) + the adapter spawn | 0 — the same steps are plain `docker exec`s |
| warm start (stopped container) | `up` + probe/skills + history link + spawn | 0 (`docker start`, the start script, the cached PATH) |
| one adapter probe | 1 | 0 (one `docker exec sh -c`) |

Someone with docker should record the three wall times on the starter env with
claude-code, before (previous release) and after (this one), and put them here.

### What was built

The first implementation included a devcontainer importer, a migration of
stored envs, repo discovery, "adopt on publish", a per-env `user` and
`importNotes`. The owner then removed all of it (see the revision note at the
top); what is described here is the final state.

- **Format (§2).** `EnvConfig` = `image` | `dockerfile` (+ `dockerfilePath`,
  `build`), `env`, `setup`, `start`, `repo`. `validateEnvConfig`, `insideRoot`,
  `parseEnvConfigText` (the JSONC reader of the bundled files),
  `parseEnvLines`/`formatEnvLines` (the editor's `KEY=VALUE` text) live in
  `src/shared/envConfig.ts`. No importer, no migration: `getWorkspace` only maps
  repos (stray fields such as an old per-repo `devcontainer` text are dropped) and
  writes `envs: []` once when the file had none. A stored env in the old
  devcontainer form is left as it is, invalid (`image or a Dockerfile is
  required`), to be filled in again.
- **Runtime (§3).** `src/main/provision.ts` is the docker runtime:
  `dockerExec`/`spawnDockerExec`/`dockerExecArgs` (`ExecTarget`), `createContainer`,
  `restartContainer`, `probeExecPath`, `ensureNodeRuntimeVolume`, `prepareEnvImage`,
  the adapter install/launch, `writeContainerUserFile` (stdin). The container
  record gained `user` and `path`; `remoteWorkspaceFolder` is the workdir. The
  user is the image's `Config.User`, else root (there is no `user` field in the
  env). `containerLayout` (containers.ts) is the pure container-path contract.
  Stale-bind handling is `withStaleBindRetry` around `docker create`+`start` and
  `docker start`. The shell used for setup/start/probe/terminal is the user's login
  shell from `/etc/passwd` (nologin/false/non-executable → `/bin/sh`); the
  terminal uses it too (the spec's `"${SHELL:-/bin/sh}"` would always be `sh`,
  since `docker exec` sets no `$SHELL`).
- **Node runtime.** `NODE_RUNTIME_IMAGE` is the operator image's digest,
  `node:26-bookworm-slim@sha256:bc0a2afd…` (already pinned and in use), mounted
  from `gurt-node-<digest12>-<arch>`. The volume check (`.gurt-ready`) is one
  container run per app process, not per start. The "node must run" check is made
  **before** the adapter's `npm install` (rather than after the first install):
  same message, earlier. npm runs as
  `PATH=/opt/gurt/node/bin:$PATH NPM_CONFIG_PREFIX=$HOME/.gurt/npm /opt/gurt/node/bin/npm install -g`.
  The adapter launch resolves `$HOME/.gurt/npm/bin/<bin>` inside the container
  (`readlink -f`) and runs `.js/.mjs/.cjs` under `/opt/gurt/node/bin/node`, anything
  else directly. Plugin check, from the registry metadata of the pinned
  versions (not by installing): `claude-agent-acp`, `codex-acp`, `pi-acp` and
  `gemini` are JS (`dist/index.js`, `bundle/gemini.js`); `opencode` is
  `bin/opencode.exe`, a stub replaced by the native binary in `postinstall`, so it is
  exec'd directly.
- **Reconcile (§3.6)** removes a `gurt.session` container without
  `gurt.runtime=docker`, resets its record (skipped when the store is degraded).
  Nothing sweeps the CLI era's host files (`~/.gurt/<ws>/.devcontainers/`,
  `.multirepo/<sid>/devcontainer.json`): they are harmless and can be deleted by
  hand. `.devcontainers` is gone from `RESERVED_NAMES`.
- **Discovery/publish/admin (§7, §8).** Only `discoverDockerfiles` is left
  (root `Dockerfile*`); `discover_env`/`discover_devcontainer` do not exist
  (`src/shared/adminTools.generated.ts` regenerated, 51 tools); publishing a local
  repo no longer adopts an env. `ENV_HELD`, `planEnv` and the env branches of
  `describe`/`applyHeld` are deleted; the operator instructions no longer name env
  fields.
- **Renderer (§9).** `EnvModal`: an Image | Dockerfile toggle (the app's
  `.seg`/`.seg-btn`), the image field or the Dockerfile editor with "detect
  Dockerfiles in repo" and an advanced build block, environment, setup, start.
  `JsonEditor`/`highlightJson` removed; texts in `Network.tsx`, `tags.tsx`,
  `ConfigTab.tsx`, `doctor.ts` changed; `prepareImages` also lists
  `NODE_RUNTIME_IMAGE` and `machinePrepare` fills the volume.
- **Bundled envs (§6):** `resources/env/operator.json`, `starter.json`;
  `GURT_OPERATOR_ENV`/`GURT_STARTER_ENV` unchanged. The repo-less refusal of a
  Dockerfile env is in `prepareEnvImage`, same sentence.
- **Packaging/docs (§10):** `@devcontainers/cli` removed from package.json and the
  lockfile (`npm uninstall --package-lock-only`), `asarUnpack`, renovate, the
  `prepare-terminal.mjs` comment; smokes use the new env form and no longer seed
  `.devcontainer/`; docs listed in §10 updated.
- **Logging.** The container lifecycle (build, pull, create, start, the
  setup/start scripts, the adapter install) traces at INF (`RunOpts.level`), the
  probes stay DBG; docs/logging.md says so.
- Test seam: `GURT_STALE_BACKOFF_SCALE` scales the stale-bind waits (tests set 0).

### Tests (§13.1, §13.3–§13.5)

- New `scripts/env-format.test.mjs` (replaces `env-config.test.mjs`) and
  `scripts/docker-runtime.test.mjs` (+ `scripts/lib/fake-docker.mjs`).
- Ported to the fake docker / new API: `provision-hook-retry` (now the `setup`
  retry contract), `session-history-mount`, `container-terminal`,
  `agent-fixture`, `operator-role`, `containers-lifecycle` (fake reports
  `gurt.runtime`, new pre-migration reconcile case), `doctor`, `local-repo`
  (publish no longer adopts an env), `env-split-migration` (a file without envs
  reads as `envs: []`).
- `held-fields` lost its env half (kept MCP; added "env writes land whole").
- Deleted, subject gone: `mount-workspace-git-root` (the CLI flag; replaced by a
  layout assertion in `docker-runtime`), `env-config-reuse`
  (`canReuseMaterializedConfig`).
- `env-image-build` is ported (Dockerfile outside the context, `build.context`)
  but **not run** — it needs a docker daemon, like before.
- Results in the build environment: the three `tsc` projects, `eslint .` and
  every `scripts/*.test.mjs` pass except `env-image-build`; `node
  scripts/gen-admin-tools.mjs --check` is clean; the §13.2 grep matches nothing
  in `src scripts electron-builder.yml package.json`. (The repo's `node_modules`
  was installed for macOS, so the checks ran with the linux esbuild/tsc binaries
  put in a temp dir. `agent-fixture` hangs under Node 20 — `child.kill()` of a
  child whose spawn failed signals the whole process group — and was only run
  green under Node 26, before the revision; its code is untouched since.)
  **`npm run smoke` was not run** (needs Electron + docker).

### §13.6 manual acceptance — **not run, none of it**

No docker daemon was available. Still to be done by someone with one, each to be
recorded here: starter env + claude-code and codex (start, prompt, terminal, VS
Code attach, stop, restart without an adapter reinstall, recreate); a Dockerfile
env with `COPY` from the repo (badge missing → build → exists → start reuses the
image; clone `git status` clean); a Linux host with a non-root image user (files
in the clone owned by the host user); an `internal` session (setup on the open
network, isolation asserted after the switch); the operator first-run flow; an
existing workspace from the previous release (old containers removed at boot,
sessions start; old-form envs are invalid until filled in again).

### §3.2 node runtime verification — **not run**

Whether the volume's node runs in both bundled envs,
`mcr.microsoft.com/devcontainers/base:ubuntu`, `python:3`, `ubuntu:24.04` and
`debian:bookworm-slim` (`libstdc++`/`libatomic`) could not be checked. If one of
them lacks a library, the start fails at the adapter install with the
"needs a glibc distro" message quoting node's own stderr.

### Things to look at

- Docker Desktop's CSV parsing of `--mount` fields holding a comma or a quote
  (`mountArg` quotes them) is untested against a real daemon.
- A start-script failure keeps the container and its record (the id is recorded
  after setup); the next start restarts it and runs the script again.
