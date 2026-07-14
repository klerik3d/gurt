# go-devcontainer — additions required by gurt

gurt owns Docker execution; go-devcontainer stays Docker-free and produces
**plans** that gurt executes. Everything below preserves the library's
existing contract: lossless round-trip, `Extra` for unknown properties,
`Findings()`.

## 1. Effective-config composition

- Programmatic mutation of a parsed config that survives lossless write-back:
  add/remove features, merge `containerEnv`, add labels, mounts, `runArgs`.
- Merge semantics per spec for "base + override" (gurt applies a template or
  gurt-injected pieces over the repo's file without touching it on disk).
- Variable substitution: `${localWorkspaceFolder}`, `${localEnv:VAR}`,
  `${containerEnv:VAR}`, `${containerWorkspaceFolder}`, `${devcontainerId}`.

## 2. Feature resolution

- Parse feature references: OCI (`ghcr.io/...`), HTTPS tarball, local path.
- Fetch + local cache; parse `devcontainer-feature.json`; validate options,
  apply defaults.
- Install-order resolution: `dependsOn`, `installsAfter`,
  `overrideFeatureInstallOrder`.

## 3. Build plan

- Input: base (`image` or `dockerfile`) + ordered, resolved features.
- Output: generated Dockerfile + build context + build args + image labels
  (including the `devcontainer.metadata` label content). No Docker calls —
  gurt runs the build.

## 4. Image metadata merging

- Parse `devcontainer.metadata` label content (gurt reads it off the image
  and hands it over) and merge it into the effective config per spec.

## 5. Run plan

- From the effective config produce a container create/run spec:
  workspace mount + declared mounts, `remoteUser`/`containerUser`,
  `containerEnv` vs `remoteEnv` split, `forwardPorts`/`appPort`,
  entrypoint/`overrideCommand`, `init`/`privileged`/`capAdd`/`securityOpt`,
  labels.
- Lifecycle commands in execution order (`onCreateCommand`,
  `updateContentCommand`, `postCreateCommand`, `postStartCommand`,
  `postAttachCommand`) with string-vs-array shell form resolved; gurt
  executes them via exec.

## 6. Runner (amendment, 2026-07-09)

This section is an append-only amendment; the text above stays as originally
agreed. **It supersedes the executor role:** wherever the intro and sections
1–5 say *gurt* executes the plans (runs the build, execs lifecycle
commands), read *the `runner` package* — execution moves into the library,
and gurt becomes a consumer of `runner`, keeping only policy (overlay
content, attach/reuse rules, its services). In the build order it comes
last, on top of the plans.

`runner` is the only Docker-aware package; core packages stay Docker-free
and the plans remain available raw (dry-run, other executors). Rationale:
the consumer-side rules (base-image USER via `ImageUserArg`, metadata
dedupe, `RemoteEnv` nil-means-unset, entrypoint chaining, lifecycle groups,
`UserEnvProbe`) are spec subtleties every tool would otherwise re-implement;
the canonical executor belongs next to the plans it executes.

- **`Runtime` interface** abstracting the container engine: image inspect
  (labels, USER), image build, container create/start/stop/remove, list by
  label selector, exec with user/env/workdir/attached stdio. Default
  implementation shells out to the `docker` CLI (no docker SDK dependency);
  a fake Runtime drives tests; podman compatibility comes for free.
- **`Up`** — the whole pipeline behind one call: apply overlays +
  substitution (caller supplies local values), resolve features, inspect the
  base image (metadata + USER → `ImageUserArg`), materialize the context and
  execute the build plan (Dockerfile-based configs: augment a copy of the
  configured context), run `initializeCommand` on the host, create/start per
  the run plan (entrypoint chaining, `OverrideCommand` keep-alive, publish
  `appPort`s, plan labels + caller's extra labels), then lifecycle `Exec`s
  in order — as `RemoteUser` with `RemoteEnv` applied, parallel within a
  named group, in `WorkspaceFolder`, with `UserEnvProbe` environment;
  `UpdateRemoteUserUID` honored on Linux hosts.
- **`Exec`** for tool sessions: run a process in a container as `RemoteUser`
  with `RemoteEnv` + probe env and attached stdio (how gurt runs its
  vsc/claude services).
- **Discovery helpers**: find containers by label selector. Reuse/attach
  *policy* (same-type attach, different-type error) stays with the tool.
- **Progress**: `Up` streams structured progress (fetch/build output, phase
  transitions) via a callback/writer so tools can render it live.
- Out of scope: compose (unchanged), dynamic port forwarding — tools publish
  the ports they need via `appPort` in an overlay at create time.

## Suggested order for gurt's MVP

1 (composition + substitution) → 5 (run plan) → 2 + 3 (features pipeline;
needed early because gurt injects `vsc`/`claude` as features) → 4 (metadata).

Still deferred: docker-compose configs, lockfiles, templates-as-registry
(gurt templates are plain local `devcontainer.json` files for now).
