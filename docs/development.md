# Developing Gurt

Running Gurt from source, the dev container, the test tiers, packaging and
auto-update. Setup, lint and the pull-request checklist are in
[CONTRIBUTING.md](../CONTRIBUTING.md); the domain model and internals are in
[architecture.md](architecture.md).

Development happens in the devcontainer (see [Dev container](#dev-container)).
macOS and Linux are the primary platforms; Windows is a candidate (untested).

## Run

```bash
npm run setup      # npm ci + allow-scripts + unpack the Electron binary
npm run dev        # requires docker daemon for env start
```

`GURT_ROOT` env var overrides `~/.gurt` (used by tests).
`GURT_WELCOME=auto|always|never` overrides the stored welcome-screen mode
(`~/.gurt/welcome.json`, Settings → Machine) for one run — `always` is what a
demo machine wants and how the smoke reaches the screen on a store that already
has sessions; `never` is what the welcome popup's "don't show this again" writes,
and what the other smokes launch with so its backdrop stays out of their way. `GURT_LOG=debug|info|warn|error`
sets the log level — the app writes `~/.gurt/logs/gurt.log` (⌘K → "Open logs
folder"); see [logging.md](logging.md).

## Packaging (alpha builds)

```bash
npm run dist         # macOS → release/gurt-<version>-arm64.dmg + release/mac-arm64/gurt.app
npm run dist:linux   # Linux → release/gurt-<version>[-<arch>].AppImage + .deb (no arch suffix on x64)
```

Release artifacts (built by `.github/workflows/release.yml` on `v*` version
tags) are the dmg/zip plus the AppImage/deb. The workflow stamps the tag's
version into `package.json` before building, so the tag is the single source
of truth — no need to bump `package.json` before tagging.

Config lives in `electron-builder.yml`. macOS signing + notarization are
driven entirely by the environment (see the comment in the `mac:` section):
CI takes them from repo secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`); a local `npm run dist`
without them produces an unsigned build with a warning. An unsigned dmg
downloaded onto another Mac won't open until the quarantine flag is cleared:

```bash
xattr -dr com.apple.quarantine /Applications/gurt.app
```

Gurt drives the `docker` CLI directly (there is no bundled container tooling);
the files it hands to other processes by path — the node-pty binding and
`resources/**` (the bundled env files, the proxy script) — are kept outside
`app.asar` (`asarUnpack`), because only Electron's own fs can read from an asar.

## Auto-update

Packaged builds carry [electron-updater](https://www.electron.build/auto-update),
wired in `src/main/update.ts`. A background poll checks the feed every minute
and downloads a found update silently; once it's ready an **update** button
appears in the titlebar (right of the workspace switcher) — clicking it
restarts into the new version. A manual check also exists (⌘K → "Check for
updates") and is the only path that answers with dialogs (up to date / error).
`electron-builder.yml`'s `publish` block points the default feed at this
repo's GitHub Releases, matching `.github/workflows/release.yml` (which
uploads the `latest*.yml` manifests alongside the installers — without those,
electron-updater has nothing to compare versions against).

Auto-update only works for the **AppImage** target on Linux (the deb ships too,
but upgrades through apt/dpkg, not this — both the poll and `checkForUpdates()`
short-circuit if it isn't running as the AppImage, so it never falls back to
shelling out to `sudo dpkg -i`, which electron-updater will otherwise attempt
and which just hangs or fails outside a desktop with a polkit agent). macOS
auto-update needs the `zip` target (also configured) and a **signed** build:
Squirrel.Mac refuses to apply an update to an unsigned install, so mac
auto-update only works end-to-end once the signing secrets are in place.

**Testing the whole loop locally, before pushing a tag:**

```bash
# 1. Build and set aside the "old" version an installed user would be running.
npm run dist:linux
cp release/gurt-<old-version>-arm64.AppImage /tmp/gurt-old.AppImage

# 2. Bump the version in package.json, rebuild — release/ now has the "new"
#    installer plus an updated release/latest-linux*.yml pointing at it.
npm run dist:linux

# 3. Serve release/ as the update feed.
npx http-server release -p 8384    # or: python3 -m http.server 8384 -d release

# 4. Run the old build with the feed overridden to your local server (this is
#    the one thing that only exists for this loop — GURT_UPDATE_URL isn't read
#    anywhere else) and trigger a check from the running app (⌘K → "Check for
#    updates"). It downloads the new AppImage, verifies its sha512 against the
#    manifest, and replaces /tmp/gurt-old.AppImage in place.
GURT_UPDATE_URL=http://127.0.0.1:8384 /tmp/gurt-old.AppImage
```

`GURT_UPDATE_URL` swaps the baked-in GitHub provider for a `generic` one at
runtime (`autoUpdater.setFeedURL`) — nothing about the build config changes, so
this is safe to leave set only for the one test run. Running the *unpacked*
`release/linux-arm64-unpacked/gurt` binary instead of the real `.AppImage` also
works for exercising the check-and-download path, but electron-updater then has
no `APPIMAGE` env var to tell it how it was installed and falls back to the
deb/sudo path above — always test through the actual `.AppImage` file.

## Dev container

`.devcontainer/` provides a Node 22 environment for working on Gurt itself.
Because Gurt provisions *child* dev containers at runtime, the container ships
**Docker-in-Docker** (the inner daemon shares its filesystem, so clones under
`GURT_ROOT` bind-mount into the children). Electron runs headless on an Xvfb
display (`:99`), started automatically — `xvfb-run` is not needed. Reopen the
folder in the container, then `npm run dev` or the smoke scripts work as above.
The full docker-provisioning smokes are heavy nested-in-nested; the UI-only
`smoke.mjs` is the light check.

## Smoke tests

Smoke scripts drive the built app with Playwright through the real UI and
screenshot into `$SCRATCH/shots`; run `npm run build` first. Without agent
secrets the chat shows an auth error — that still proves the ACP pipe. The
scripts strip `ELECTRON_RUN_AS_NODE` (shells spawned from a VSCode extension
host inherit it and it makes Electron start as plain Node). The list below is
the full set (`ls scripts/smoke*.mjs`).

`npm run smoke` (`scripts/run-smoke.mjs`) runs the docker-free gate — the ten
scripts in its `SMOKES` list, each with its own `SCRATCH` under a temp dir or
`SMOKE_SCRATCH_ROOT`, each bounded by `SMOKE_TIMEOUT_MS` (default 240 s); it
builds `out/` first if it is missing. CI's `smoke` job runs exactly that.
Everything else below is run by hand.

```bash
npm run build
SCRATCH=/tmp/gurt-smoke node scripts/smoke.mjs    # UI only, no docker
SCRATCH=/tmp/gurt-smoke node scripts/smoke-provisioning.mjs   # provisioning + ACP session
SCRATCH=/tmp/gurt-smoke node scripts/smoke-persistence.mjs    # session persistence across restart
SCRATCH=/tmp/gurt-smoke node scripts/smoke-crud.mjs           # CRUD + stop/delete + codex handshake
SCRATCH=/tmp/gurt-smoke node scripts/smoke-codex.mjs          # codex-in-gurt handshake
SCRATCH=/tmp/gurt-smoke node scripts/smoke-queue.mjs          # session queue: draft/serialization/restart
SCRATCH=/tmp/gurt-smoke node scripts/smoke-changes.mjs        # Changes panel delivery thread, no docker (local bare repos)
SCRATCH=/tmp/gurt-smoke node scripts/smoke-review.mjs         # manual review: split diff, comments, lock toggle, Launch fix, no docker (local bare repos)
SCRATCH=/tmp/gurt-smoke node scripts/smoke-git-credentials.mjs # credentials CRUD + repo resolution note, no docker
# turn contract end-to-end (docker + a working claude secret; SKIPs without one):
SCRATCH=/tmp/gurt-smoke GURT_SMOKE_CLAUDE_TOKEN=… node scripts/smoke-turn-contract.mjs
node scripts/smoke-delete-row.mjs                 # sidebar Del/⌫: confirm, delete, move the selection, no docker
node scripts/smoke-session-copy.mjs               # duplicate/delete from the row actions and the pane menu, no docker
node scripts/smoke-roles.mjs                      # session roles: the picker, the repo select it drives, persistence, no docker
node scripts/smoke-first-run.mjs                  # first run: the welcome screen, the machine checklist, Settings → Machine, no docker
node scripts/smoke-newtask.mjs                    # header "+" creates a task inline — no modal, no stray session, no docker
node scripts/smoke-deleted-task.mjs               # a deleted task stays deleted: selection cleared, no dir resurrected by a late persist, no docker
node scripts/smoke-logging.mjs                    # app log: startup banner, IPC wrapper, renderer transport, no docker (an unreachable daemon is logged as "unavailable")
node scripts/smoke-diff-mode.mjs                  # Diff mode: switching modes + real host-git actions on local repos, no docker
node scripts/smoke-terminal.mjs                   # terminal panel: real PTY, toggles, per-scope lifetime, cleanup on delete, no docker
node scripts/smoke-operator.mjs                   # operator role: picker, repo picker disabled, operator env default, persistence, no docker
node scripts/smoke-proactive.mjs                  # Proactive mode: seeded agent, settings/on-off/instructions persist, raised scope origin, new agent, no docker
node scripts/smoke-proxy-net.mjs                  # per-session network + proxy container (docker; pulls node:22-alpine and alpine)
node scripts/smoke.linux.mjs                      # linux variant of smoke.mjs: client registry + agent-token credential linkage over a plaintext store, no docker
```

Unit tests are pure node — no Electron, no Playwright, no docker; the TS under
test is bundled on the fly with esbuild. `npm test` runs every
`scripts/*.test.mjs` (currently 78) and is the canonical way to run them; a single
file can also be run directly. A few, to show what they cover:

```bash
npm test                               # all of scripts/*.test.mjs
node scripts/git-logic.test.mjs        # git contract: repo identity, credential resolution, rewrites, forge
node scripts/session-log.test.mjs      # append-only session log + legacy migration
node scripts/gurt-mcp.test.mjs         # the `gurt` MCP server: `complete` validation + the per-role tool set
node scripts/session-roles.test.mjs    # session roles: locks, (role, repos) rules, create_session gating, migration
node scripts/doctor.test.mjs           # machine checklist: what each row probes, what gates, what "could not ask" reports
node scripts/agent-providers.test.mjs  # agent token probes: ok / rejected / unreachable per kind (a 429 is never "ok")
node scripts/first-run.test.mjs        # one-click first run: the five entities, reuse, where the token lands, a failed start
node scripts/turn-contract.test.mjs    # turn contract: the post-turn nudge/incomplete decision matrix
node scripts/proposal-store.test.mjs   # turn contract: proposal restore, latestProposal, Kernel.prUrl params
node scripts/env-config.test.mjs       # env normal form: JSONC parse/validation, envImageTag identity, migration
node scripts/mcp-registry.test.mjs     # workspace MCP registry: validation, built-in/registry lookup, store CRUD, mcp-token links
node scripts/mcp-selection.test.mjs    # per-session MCP selection: persistence over both sources, scope resolution, a deleted entry
node scripts/skills-selection.test.mjs # per-session skills: the on-disk registry, selection/inheritance/defaults, what gets materialized
node scripts/proxy-policy.test.mjs     # session proxy: the domain matcher, the policy modes, route/config parsing
node scripts/proxy-server.test.mjs     # session proxy, live: MCP routing + credential injection, CONNECT, config reload
node scripts/proxy-config.test.mjs     # host side of the proxy contract: scope + ACP descriptors, and what never reaches the container
node scripts/proxy-traffic.test.mjs    # observed traffic: the proxy's JSON lines → the blocked/allowed lists the session pane shows
node scripts/session-network.test.mjs  # per-session network mode: persistence, restore, sanitization, what a copy or a drafted session inherits
node scripts/session-delete-container.test.mjs  # deleting a session takes its container down with it
node scripts/session-duplicate.test.mjs # duplicating a session: what a copy carries, and what it never does
node scripts/log.test.mjs              # app log: writer, rotation, sanitization, redaction, drop accounting
```


## Docker Desktop gotchas (macOS)

- Bind mounts require Docker-shared paths; `~/.gurt` (under `/Users`) is fine,
  `/tmp` is not.
- Deleting a directory and recreating it at the same path can leave a stale
  virtiofs cache in the Docker VM — mounts then fail with "bind source path
  does not exist" even though the path exists. Smoke tests use a unique root
  per run for this reason; if it bites the real `~/.gurt` after env
  delete/re-add, restart Docker Desktop.

