# Requirements: env devcontainer normal form

Status: draft for review · Owner: klerik3d · Target: gurt Electron PoC (this repo)

This document is a work order for an implementing agent. Read `README.md`
first. Key code: `src/shared/types.ts`, `src/shared/api.ts`,
`src/main/store.ts`, `src/main/envs.ts`, `src/main/provision.ts`,
`src/main/ipc.ts`, `src/renderer/src/components/SettingsPage.tsx`.
Do not change the contract described here without asking the owner.

## 1. Motivation

gurt's core duty is to guarantee an agent a working environment for **any**
repo. devcontainer is the chosen standard. Reality: repos are a zoo — no
devcontainer at all; devcontainer with `image`; devcontainer with `build` +
Dockerfile; a bare Dockerfile. And the needed image almost never exists on
the host, so the full preparation cycle — including the image build — is
gurt's job, and gurt must never touch the repo itself while doing it.

The model that resolves this:

- **devcontainer is the normal form.** Whatever the repo has, an env is
  always described one way: its own devcontainer.json (+ a Dockerfile when
  a build is needed), stored entirely in gurt's settings.
- **The repo's artifacts are seed material, not the source of truth.** A
  repo devcontainer is loaded as the base and edited; a bare Dockerfile is
  wrapped in a devcontainer; nothing at all means writing one from scratch.
  From then on gurt's copy lives and is edited in gurt.
- **Runtime is one deterministic path:** materialize the env config, build
  the image in the repo's context if needed (via a temporary copy — the
  working clone is never touched), `devcontainer up`.

This kills the runtime combinatorics: repo variability collapses at
seeding/editing time (where a human can look and fix), execution is a
single path. A self-contained env config also means reproducibility — the
env does not depend on what the repo changes tomorrow.

The previous implementation (two mutually exclusive modes: inline
devcontainer XOR bare Dockerfile built into a synthesized `{"image": tag}`,
dropping features/mounts/remoteUser) is wrong and is removed by this work
order. It also carried a live bug: `resolveEnv` recomputed config args for
`exec` without the Dockerfile override, so `up` and `exec` saw different
configs.

## 2. Model (src/shared/types.ts)

```ts
export interface EnvConfig {
  name: string
  /** devcontainer.json (JSONC), REQUIRED — the single runtime description.
   *  '' is invalid: saving is blocked in the editor, starting throws. */
  devcontainer: string
  /** Companion Dockerfile content — REQUIRED iff `devcontainer` has a
   *  `build` section; ignored (and cleared by the editor) otherwise.
   *  Hand-written or seeded from the repo and edited. */
  dockerfile?: string
  /** Repo-relative path `dockerfile` was seeded from — provenance only. */
  dockerfilePath?: string
  repo?: string
}
```

Validation (one shared helper, used by editor + store + provisioning) —
new `src/shared/envConfig.ts`:

```ts
import { parse, ParseError } from 'jsonc-parser'   // npm i jsonc-parser

export interface ParsedEnvConfig {
  config?: Record<string, unknown>   // parsed devcontainer object
  build?: { dockerfile?: string; context?: string; args?: Record<string, string>; target?: string }
  error?: string                     // set on JSONC parse failure / non-object
}
export function parseEnvDevcontainer(text: string): ParsedEnvConfig
export function validateEnvConfig(env: EnvConfig): string | null  // null = ok
```

- `parseEnvDevcontainer`: jsonc-parser `parse` with an errors array; any
  parse error or a non-object root → `error`.
- `validateEnvConfig`: devcontainer empty → error; parse error → error;
  `build` present and `dockerfile` empty → `"Dockerfile is required when
  devcontainer has a build section"`. Nothing else is validated.
- Compose (`dockerComposeFile`) is NOT detected and NOT supported — the
  config author owns the outcome (see Non-goals).

`addEnv`/`updateEnv` in `store.ts` reject configs failing
`validateEnvConfig`.

## 3. Image identity

New helper in `src/shared/envConfig.ts`:

```ts
/** gurt-env:<sha256(repoUrl \n commit \n dockerfileContent \n canonicalBuild).hex.slice(0,16)> */
export function envImageTag(repoUrl: string, commit: string, dockerfile: string, build: object): string
```

- `canonicalBuild` = `JSON.stringify` of the `build` object with the
  `dockerfile` key removed and keys sorted (args/target/context affect the
  image; the file path does not — its content is hashed directly).
- Same commit + same config ⇒ same tag, on every path. This is what makes
  a pre-built image (built at remote HEAD) get reused by the session start
  (clone HEAD at the same commit), and what forces a rebuild when the
  Dockerfile, the build args, or the repo's committed content change.
  Uncommitted clone edits do not change the tag (as today — commit to
  force a rebuild).

## 4. Provisioning pipeline (src/main/provision.ts, src/main/envs.ts)

### 4.1 Materialize + build

Replace `overrideConfigArgs` / `dockerfileConfigArgs` / `ensureBuiltImage`
with:

```ts
/** Write the env's effective devcontainer.json to overrideConfigPath(ws, env)
 *  and return ['--override-config', path]. When the config has `build`,
 *  ensure the image first and write the config with `build` replaced by
 *  `image: tag` (all other fields preserved verbatim). */
export async function materializeEnvConfig(
  ref: EnvRef, envCfg: EnvConfig, repo: RepoConfig, cloneDir: string, log: LogSink
): Promise<string[]>

/** ['--override-config', overrideConfigPath(ws, env)] — no content logic.
 *  The file was written by materializeEnvConfig at up. */
export function overrideConfigArgs(ref: EnvRef): string[]

/** Ensure the image for (repo, commit, envCfg) exists; returns its tag.
 *  contextDir is a disposable snapshot of the repo at `commit`. */
export async function buildEnvImage(
  repo: RepoConfig, envCfg: EnvConfig, contextDir: string, commit: string, log: LogSink
): Promise<string>
```

`buildEnvImage` (shared by session start and pre-build):

1. `tag = envImageTag(repo.url, commit, envCfg.dockerfile!, build)`.
2. `docker image inspect` hit → log `image <tag> already present`, return.
   Keep the `buildsInFlight` per-tag dedupe.
3. Write into the snapshot: `<contextDir>/.devcontainer/devcontainer.json`
   (the env's devcontainer text as-is) and
   `<contextDir>/.devcontainer/<build.dockerfile ?? 'Dockerfile'>`
   (the env's `dockerfile` content) — overwriting the repo's own versions;
   the snapshot is disposable and the env config is the source of truth.
4. `docker build -f <that dockerfile> -t <tag> [--build-arg k=v ...]
   [--target <t>] <context>` where `context` = `build.context` resolved
   relative to `<contextDir>/.devcontainer/`, default `<contextDir>` (repo
   root — gurt's convention; documented divergence from the spec default).
   `build.options` / `cacheFrom` are ignored (Non-goals).

`materializeEnvConfig`:

1. `validateEnvConfig` → throw on error (`env "<name>": <error>`).
2. No `build` → write `envCfg.devcontainer` verbatim (JSONC is fine, the
   CLI reads it) to `overrideConfigPath`, return args.
3. `build` → make the temporary repo copy: `git -C <cloneDir> archive
   --format=tar -o <scratch>/src.tar HEAD` + `tar -xf src.tar -C
   <scratch>/src` (scratch via `fs.mkdtemp`; always `rm -rf` in finally).
   `commit` = `git -C <cloneDir> rev-parse HEAD`. Call `buildEnvImage`
   with `<scratch>/src`. Then write the parsed config object with `build`
   deleted and `image: tag` set (plain `JSON.stringify(cfg, null, 2)` —
   comments are lost only in this materialized file, never in the stored
   config) to `overrideConfigPath`, return args.

Delete `overrideDockerfilePath` (store.ts) and the `.devcontainers/
<env>.Dockerfile` file handling.

### 4.2 One config resolution for up and exec (bug fix)

- `EnvManager.ensureRunning`: `configArgs = await materializeEnvConfig(...)`
  → pass to `devcontainerUp`. Delete `dockerfileConfigArgs`.
- `EnvManager.resolveEnv`: `configArgs = overrideConfigArgs(ref)` — the
  file already materialized at up (it persists on disk across app
  restarts, so the reattach path needs nothing). `up` and every `exec` now
  always resolve the same file; since devcontainer is mandatory, the
  override args are never empty.

## 5. Pre-build & image indicator

Goal: see that the target image already exists, and build (and debug) it
before any agent is started.

### 5.1 API (src/shared/api.ts, src/main/ipc.ts)

```ts
export interface EnvImageStatus {
  state: 'not-applicable'   // config has no build section
       | 'no-repo'          // build section but no default repo to build from
       | 'invalid'          // validateEnvConfig failed
       | 'exists' | 'missing'
  tag?: string              // for exists | missing
  commit?: string           // remote HEAD used for the tag
}
envImageStatus(ws: string, env: string): Promise<EnvImageStatus>
envBuildImage(ws: string, env: string): Promise<{ tag: string }>
```

Both read the SAVED `EnvConfig` (workspace-level, no task context).

- `envImageStatus`: commit = `git ls-remote <url> HEAD` (credentials via
  `hostGitAccess`, as `withShallowClone` does) → `envImageTag(...)` →
  `dockerImageExists(tag)`.
- `envBuildImage`: `withShallowClone(repo, dir => buildEnvImage(repo,
  envCfg, dir, headOf(dir), log))` — the shallow clone IS the temporary
  repo copy; commit = `git -C dir rev-parse HEAD`. Log sink emits the
  existing `provision.log` bus event with `key = `env-build:${ws}/${env}``
  (renderer subscribes by that key). Errors reject and also go to the log.

### 5.2 Renderer (SettingsPage, Environments section)

- Each env row gains an image badge, loaded lazily when the section opens
  (and refreshed after a build): `image ✓ <tag>` / `image ✗ <tag>` /
  nothing for `not-applicable`; `no-repo` / `invalid` render as a faint
  hint. Plus a `build` button (only for `missing`/`exists` states) →
  `envBuildImage`; while building show a spinner and the streamed log tail
  (last ~5 lines, monospace) under the row; on error keep the tail + error
  line. On success refresh the badge.
- Session start reuses the pre-built image automatically via the tag match
  (§3) — no extra wiring.

## 6. Env editor (SettingsPage)

- Remove the devcontainer/Dockerfile mode toggle. The devcontainer
  JsonEditor is always shown and required.
- `detect from repo` keeps seeding the devcontainer field. Extend
  `discoverDevcontainer` to also return the companion Dockerfile when the
  discovered config has `build.dockerfile` (read from the same shallow
  clone, path resolved relative to the config's directory):
  `Promise<{ path, content, dockerfile?: { path, content } } | null>` —
  seeds both fields at once.
- The Dockerfile section (editor + existing `detect Dockerfiles in repo`
  flow + provenance) renders iff the parsed devcontainer has `build`.
- Save validity = name non-empty + `validateEnvConfig` passes. Show its
  error text inline.

## 7. Migration (src/main/store.ts, lazy, write-back once)

In `getWorkspace`, an env with `dockerfile` set and `devcontainer` blank
(the old Dockerfile mode) becomes:

```ts
env.devcontainer = JSON.stringify({ build: { dockerfile: 'Dockerfile' } }, null, 2)
// dockerfile / dockerfilePath kept as-is
```

An env with both fields blank stays as-is — it is now invalid; the next
start throws `env "<name>": devcontainer config is required` and the user
fills the editor (detect seeds it). No auto-discovery at start.

## 8. Docs cleanup (this work order includes it)

- `README.md` Model section: the **repo** bullet still says "git URL +
  optional inline devcontainer.json (used via `--override-config` when the
  repo has none)" — stale since the env/repo split; drop the devcontainer
  part. Rewrite the **env** bullet: env is a workspace entity — a
  mandatory devcontainer.json (+ companion Dockerfile when it has
  `build`), stored in gurt, seeded from the repo's own files; instances
  per (task, session) as today.
- `README.md` "How a session starts": insert the build step (temporary
  repo snapshot → `docker build`, reused by content tag) between clone and
  `devcontainer up`; replace "The inline devcontainer config is passed via
  `--override-config`" with: the materialized env config is ALWAYS passed
  via `--override-config` to `up` and every `exec`.
- Delete the stale either-or comments on `EnvConfig` in
  `src/shared/types.ts` (rewritten in §2).
- `CONCEPT.md` untouched (archived Go-stack vision).

## 9. Non-goals

- Re-seed / diff of the env config against the repo's current devcontainer
  (explicitly deferred — provenance fields stay for it).
- Compose-based devcontainers (`dockerComposeFile`): unsupported, no
  detection, no error — the config author's responsibility.
- `build.options`, `cacheFrom`, registry push, multi-arch.
- Garbage collection of stale `gurt-env:*` images.
- Hashing the working tree into the tag (commit to force a rebuild).

## 10. Acceptance

1. `npm run typecheck` and `npm run build` pass; all existing
   `node scripts/*.test.mjs` suites pass.
2. New `scripts/env-config.test.mjs` (pure node, esbuild-bundled like the
   others): JSONC with comments parses; validation matrix (empty config /
   parse error / build without dockerfile / build with dockerfile / no
   build); `envImageTag` stable for equal inputs and changes when the
   dockerfile content, build args, or commit change; migration fixture —
   old Dockerfile-mode env reads back with the synthesized `build` config,
   write-back happens once.
3. `grep -rn 'overrideDockerfilePath\|dockerfileConfigArgs' src` matches
   nothing; no mode toggle remains in `SettingsPage.tsx`.
4. Manual: env whose devcontainer has `build` + a Dockerfile with `COPY`
   from the repo → badge `missing`; `build` in Settings succeeds (log
   streams) → badge `exists`; session start logs `image <tag> already
   present` (no rebuild) and the agent runs; after an agent commit the
   next start rebuilds under a new tag; `git status` in the clone stays
   clean throughout.
5. Env with an `image`-only devcontainer: no Dockerfile section, no badge,
   session starts as before; `exec` (adapter install) uses the same
   override config as `up`.
