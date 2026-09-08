# Requirements: the first-run experience (machine checklist + one-click operator)

Status: phase 1 implemented (as-built notes in §11a) · phases 2–3 pending ·
Target: gurt Electron MVP (this repo)

This document is a work order for an implementing agent. Read `README.md`
first (the domain model and "How a session starts"), then
`docs/requirements-session-operator.md` — §1 and §2 especially, and §16
for what actually landed. This design is the missing front door to that
role: the operator exists, and there is no path to it that a person
meeting gurt for the first time can walk.

Key code: `src/shared/api.ts` (`GurtApi`, `METHODS` — the exposure
annotation makes a new method a compile error until someone decides what
the operator may do with it), `src/shared/types.ts` (`Tree`,
`AgentInstance`, `operatorEnvName`, `sanitizeSessionNetwork`),
`src/shared/agents.ts` (`AGENT_DEFS` — the four kinds and their
`secretEnv`), `src/shared/credentials.ts` (`CREDENTIAL_KINDS`, the
`agent-token` kind), `src/shared/envConfig.ts`
(`parseEnvDevcontainer`), `src/main/provision.ts` (`assertDockerCli`,
`dockerCliPath`, `dockerVersion`, `dockerImageExists`, `run`),
`src/main/hostPath.ts` (`applyHostPath`, `resolveHostCommand`),
`src/main/containers.ts` (`ensureUncoalesced` — where `assertDockerCli`
is called), `src/main/proxy/manager.ts` (`PROXY_IMAGE`),
`src/main/operatorEnv.ts` + `resources/env/devcontainer.json` (the
bundled env), `src/main/credentials.ts` (`setCredentials`, the save
chain, `feedRedactor`), `src/main/redact.ts` (`addSecrets`),
`src/main/store.ts` (`createWorkspace`, `createTask`, `setAgents`,
`validateName`), `src/main/sessions.ts` (`createSession`, `run`, the
start-failure branch that lands a session back in `draft`),
`src/main/ipc.ts` (`OPAQUE_ARGS`), `src/main/log.ts`
(`sessionLogFilePath`, `dropSessionLog`),
`src/renderer/src/App.tsx` (the `!selection` placeholder, the footer),
`src/renderer/src/components/SettingsPage.tsx` (`SettingsSection`, the
operator-env picker), `src/renderer/src/components/CommandPalette.tsx`,
`src/renderer/src/useAgents.ts`.

> **Extends** `requirements-session-operator.md` §10 ("Bootstrap stays
> manual, and minimal"). That section's rule is *who* does the
> bootstrap, not *how many forms it takes*: the credential store and
> `createWorkspace` stay on the user's side of the boundary, and this
> document does not move them. What it changes is that the two manual
> steps §10 names — one agent instance with its token, one workspace —
> plus the three more a running operator actually needs (a task, a
> session, the start) collapse into one screen with one button. Every
> new IPC method here is annotated `none` except the read-only doctor
> (§8), so nothing the operator can call grows by it.

> **Answers, in part,** `requirements-session-operator.md` §13 question 4
> ("Where the user reaches the operator"). That question listed three
> candidates and §16 recorded the cheapest one as built — the role picker
> on a draft's Config tab. This adds a fourth that does not replace it:
> the welcome screen is the *first* way in, the Config tab stays the
> every-day way in. Question 4's "pinned sidebar entry" candidate stays
> open; §2.3 below explains why the footer is used instead.

> **Does not revise** `requirements-session-container.md` §2. The docker
> preflight described there (`assertDockerCli` before a clone or a build)
> stays exactly as it is; §4 below adds a second preflight *beside* it
> with its own sentence, for the failure that preflight cannot see.

## 1. Motivation

A fresh `~/.gurt` opens on an empty sidebar (`no workspaces yet — create
one via the workspace menu`, Sidebar.tsx) and a logo. Reaching one
running operator session from there is five separate forms, in an order
nothing states:

1. create a workspace (the workspace menu in the titlebar),
2. add an agent instance to a registry that starts empty (Settings →
   Clients),
3. create an `agent-token` credential and link it (Settings →
   Credentials, then back to Clients),
4. create a task (the sidebar's `+`),
5. create a session, find the role picker on its Config tab, set it to
   operator, run it.

Each step is a silent failure point, and none of them is the *actual*
first failure, which is that the machine has no Docker daemon running.
That failure surfaces at step 5, minutes in, as a provisioning log in a
pane the user has no reason to trust yet. This killed a live demo.

The two things a cold machine needs are therefore: **tell me what is
wrong with this machine before I invest five forms in it**, and **get me
to a talking agent in one gesture**. Everything after that is a
conversation, because the operator role already exists and configuring
gurt is what it is for (`requirements-session-operator.md` §1, the "soft
entry"). This document is the screen that produces the first turn of
that conversation.

## 2. Trigger and re-entry

### 2.1 What counts as first run

**The store has never produced a session.** Formally: the welcome screen
is shown in the main pane, in place of `App.tsx`'s `!selection`
placeholder, when

```
tree !== null && tree.workspaces.every((w) => w.tasks.every((t) => t.sessions.length === 0))
```

Not "no workspaces" and not "no agents", for one reason each:

- **Not "no workspaces"**, because a user who created a workspace by
  hand and then got stuck at step 2 is exactly the user this screen is
  for. Losing the screen at the first successful step would abandon them
  at the hardest one.
- **Not "no agents"**, because the agent registry is host-global
  (`~/.gurt/agents.json`, `store.getAgents`) while sessions are
  per-workspace. A second machine profile, a `GURT_ROOT` override or a
  wiped workspace all leave a registry behind, and a returning user with
  an agent but no sessions still needs the screen. When an agent
  instance *does* exist, the screen adapts (§6.2) instead of
  disappearing.

The condition is derived from `tree`, which the renderer already holds
and already refreshes on `tree.changed` — no "has seen welcome" flag. A
flag would be a fourth thing that can be wrong on a machine gurt has
never seen, and it answers the wrong question: what matters is whether
this machine has a session, not whether someone once looked at a screen.
(§2.1.1 adds a *mode*, which is a stated preference rather than a
latched fact — a different thing, and the user's to set.)

**It stops appearing the moment any session exists in any state**,
including a draft. Clicking the sidebar's `+` creates a draft
immediately (`App.tsx`'s `createDraft`), so a user who deliberately
enters the manual flow is not sent back to the welcome screen on the
next render.

Two consequences of deriving it rather than latching it, both
deliberate: the screen **survives a restart** (a machine that still has
no session is still the machine this screen is for — there is no "seen
it once" to record), and it **comes back if every session is later
deleted** (a store with no sessions is exactly the state it serves).
The second is the one that can surprise, and §2.1.1 is the way out.

### 2.1.1 The mode: `auto` / `always` / `never`

The condition above is the `auto` mode, which is the default. Two other
states answer questions it cannot, and a boolean could not hold all
three:

| mode | shows itself |
| --- | --- |
| `auto` (default) | while the store has never produced a session — §2.1 |
| `always` | every launch, whatever the store holds |
| `never` | not on its own; only ⌘K reaches it |

`always` is what a demo machine wants, and it is what lets
`smoke-first-run.mjs` reach the screen without first emptying the store.
`never` is the way out of the delete-all-sessions surprise above.
**Neither mode touches the command palette**: ⌘K → "Welcome & machine
setup" reaches the screen under all three, because a setting that could
make a screen unreachable is a setting that will one day strand someone.

Stored in `~/.gurt/welcome.json` (`{ "mode": "auto" }`) — its own small
global file, the shape `notifications.json` and `hotkeys.json` already
established, read through the same defaults-merge so a missing or
hand-mangled file degrades to `auto` rather than to a screen nobody can
reach. Edited in Settings → Machine, beside the checklist.

**`GURT_WELCOME` overrides it for one run**, the relationship `GURT_LOG`
has to the log level: a demo machine exports it instead of editing a
file, and the smoke sets it in the launch env. An unrecognized value is
`auto`, not an error — an override is a convenience, and a typo in one
must not change what the app does in a way nobody can see.

The rule itself is one exported function, `welcomeShows(mode, firstRun)`
in `shared/doctor.ts`, so main's tests and the renderer's render
condition cannot state it twice and drift.

### 2.2 The checklist has a permanent home; the welcome screen embeds it

The checklist is not part of the welcome screen — it is a Settings
section that the welcome screen renders inline. One implementation, two
mount points:

- **Settings → Machine** — a new `SettingsSection` (`'machine'`), in the
  **General** group beside `notifications` and `hotkeys` (those are the
  per-user/per-host sections; the Registry group is per-workspace
  entities, which this is not). Icon: `box` is taken by
  `environments` — use `sliders`' neighbour set in `icons.tsx` and pick
  one that is free at implementation time; the icon choice is not a
  contract.
- **The welcome screen** — the same component, above the Start operator
  block.

This is a decision, not two options left open: a machine that lost
Docker after setup needs the checklist, and it must not need an empty
store to reach it.

### 2.3 Reaching it again later

Three ways, in ascending cost:

- **Settings → Machine**, always, whatever the store holds. This is the
  answer for "a machine that lost Docker".
- **The command palette** — a new action item beside `new-session` /
  `new-task` in `CommandPalette.tsx`, "Welcome & machine setup", which
  sets an `App.tsx` state flag that forces the welcome screen into the
  main pane regardless of §2.1's condition. The flag clears on any
  selection change. This is the answer for "a second demo on a machine
  that already has sessions".
- **The footer**, when something is red. `App.tsx`'s `.footer` already
  reports host-level state (the boot-restore bar); a hard-gate row that
  fails adds one chip there — `docker not responding`, clicking it opens
  Settings → Machine. Nothing is added to the sidebar: the sidebar is
  the workspace tree, a red dot there would have to mean "a session is
  in trouble", and this is not about a session. §13 question 4's
  "pinned sidebar entry" candidate stays open on those grounds.

The footer chip is **phase 2** (§10); phase 1 ships the two mount
points.

## 3. The machine checklist

### 3.1 Shape

One report, computed on demand, no persistence. `src/shared/doctor.ts`
(new — the `shared/proxy.ts` / `shared/skills.ts` precedent: a shared
type module with no main-only imports):

```ts
export type DoctorState = 'ok' | 'warn' | 'fail' | 'checking'

export interface DoctorRow {
  id: 'docker-cli' | 'docker-daemon' | 'images'
  /** Row label, e.g. "Docker CLI". */
  label: string
  state: DoctorState
  /** One line under the label: the resolved path, the daemon version, the
   *  image ref — or the failure sentence. Never a stack trace. */
  detail: string
  /** A red row here disables "Start operator" (§6.4). */
  gates: boolean
  /** The row's one action, when it has one — the renderer maps the id to a
   *  handler; a row with no action shows only "Re-check". */
  action?: 'start-docker' | 'prepare'
}

export interface DoctorReport {
  rows: DoctorRow[]
  /** Every gating row is `ok`. */
  ready: boolean
}
```

`checking` is a renderer-side state (the row before the first reply); it
never comes back from main.

### 3.2 The rows, phase 1

| id | probe | timeout | gates | failure detail | action |
| --- | --- | --- | --- | --- | --- |
| `docker-cli` | `dockerCliPath()` — `resolveHostCommand('docker')`, a few `stat`s, no subprocess (hostPath.ts) | n/a | **yes** | the sentence `assertDockerCli` already throws, verbatim, plus the PATH searched (`hostPath()`) | none — "Re-check" |
| `docker-daemon` | `dockerDaemon()` — new, §4 | 5 s | **yes** | `Docker is installed but its daemon is not answering — start Docker Desktop (or your runtime) and re-check.` | `start-docker` (macOS only, §3.4) |
| `images` | `dockerImageExists()` for each of the two refs in §5.1 | 10 s each (`PROBE_TIMEOUT_MS`) | no | `2 images to pull (~450 MB) — the first session will pull them; Prepare does it now.` | `prepare` |

**On success** each row's `detail` is the fact, not the word "ok": the
resolved `/usr/local/bin/docker`, the daemon's reported server version,
`operator + proxy images present`. The single most useful line when a
start later fails is the same line `logStartBanner` already writes into
`app.start` (index.ts) — the checklist is that banner, made visible at
the moment it can still be acted on.

**Skipping is not caching.** `docker-daemon` is not probed when
`docker-cli` failed (there is nothing to spawn); `images` is not probed
when `docker-daemon` failed (the daemon is what holds the image store).
A skipped row reports `state: 'fail'` with `detail: 'not checked —
Docker is not available'`, never `ok`. "Could not ask" must not read like
"the answer is no", which is the rule `dockerSessionContainers` already
follows with its `null`-vs-empty return.

### 3.3 Which rows gate

**`docker-cli` and `docker-daemon` hard-gate "Start operator". `images`
does not.**

The brief for this feature said the button is gated on the checklist
being green; this narrows that, deliberately. A missing image is not a
broken machine — it is a pull that is going to happen anyway, and
gating on it would mean a user who clicks Prepare, watches 450 MB, and
*then* gets to click the real button. Instead: **clicking "Start
operator" with `images` amber runs Prepare first**, in place, with the
same progress display, and continues into the create when it finishes
(§6.3). One click still means one click. The row stays in the list
because "why is this taking three minutes" deserves an answer before it
is asked, and because a user who wants to warm the machine before a
demo should be able to.

### 3.4 The `start-docker` action, and what it does on Linux

On macOS the action spawns `open -a Docker` (detached, output
discarded) and then re-runs the report on a short poll — Docker Desktop
takes 20-60 s to answer, so the row goes to `checking` with a "waiting
for the daemon" detail and the poll gives up after 90 s with the
original failure sentence.

**On Linux there is no equivalent and gurt must not invent one.** The
daemon is a system service; gurt does not run `sudo`, and
`systemctl --user start docker` is right for a rootless install and
wrong for every other. The row therefore carries no `action` on Linux —
only the sentence `start your Docker runtime (dockerd, Docker Desktop,
OrbStack, Rancher Desktop) and re-check`. This asymmetry is stated in
the row, not hidden: an action that silently does nothing on half the
supported platforms is worse than no action.

### 3.5 Later-phase rows

Named here so they are decided rather than rediscovered. None is in
phase 1.

- **Secrets are encrypted at rest** (phase 2, nearly free).
  `getCredentials()` already returns `CredentialsFile.plaintext`,
  computed by `sealingAvailable()` in credentials.ts. A `warn` row
  reading `no OS keystore available — the token you paste is stored in
  plaintext` is one read with no new probe, and it is the one thing a
  user should know *before* pasting.
- **npm registry reachable** (phase 2). Step 4 of "How a session starts"
  installs the ACP adapter with `npm i -g` *inside the container*; on a
  restricted network that is where a start dies, long after Docker is
  green. Probing it from the host is an approximation (the container's
  route out is the session proxy's, not the host's), so the row must say
  `checked from the host, not from the container` or it will lie. `warn`
  only.
- **Docker registry reachable** (phase 2, same caveat, same wording).
- **Disk space** (phase 3). Grounded only once there is a number worth
  quoting; `warn` under ~10 GB free on the `gurtRoot` filesystem.
- **Token validity** (phase 3) — §7.3.

Registry reachability and disk space are `warn`-only forever: neither
can be checked well enough from the host to justify blocking a start
that might have worked.

## 4. The daemon probe

### 4.1 The probe

`src/main/provision.ts`, beside `dockerVersion` and following its shape
exactly (bare `spawn`, so it inherits the PATH `applyHostPath` repaired;
a `killAfter`-style timer; resolve rather than reject):

```ts
/** The daemon's reported server version, or null when it is not answering.
 *  Distinct from `dockerVersion` (the CLI's own `--version`, which answers
 *  fine while the daemon is dead) and from `dockerCliPath` (whether the
 *  binary exists at all). Bounded: a half-dead Docker Desktop answers `info`
 *  slowly or never, which is the exact state this exists to name. */
export function dockerDaemon(timeoutMs = 5000): Promise<string | null>
```

Implementation: `docker info --format {{.ServerVersion}}`. Treat the
daemon as responding **only** when the child exits `0` *and* stdout
trims to a non-empty string that is not `<nil>`. Both halves are load
bearing: `docker info` has historically exited 0 while printing
connection errors into its `ServerErrors` section, and the template
renders `<nil>` for an absent field. Exit code alone is not the answer.

### 4.2 The second preflight, beside the first

`assertDockerCli()` is called in `ContainerManager.ensureUncoalesced`
(containers.ts) before the clone and the build, with the comment that
every probe underneath swallows spawn errors by design. A dead daemon is
the same failure with a different cause and the same unreadable
symptom — every one of those probes reports "the daemon says no" until
some later `run` fails with `Cannot connect to the Docker daemon`
quoted out of a tail.

So: a new `assertDockerDaemon()` in provision.ts, async, throwing its
own sentence, awaited **immediately after** `assertDockerCli()` in
`ensureUncoalesced` — the one funnel every start path goes through.

```
    assertDockerCli()
    await assertDockerDaemon()
```

Its message names the cause and the fix, and is *not* the CLI one:

> Docker is installed but its daemon is not responding. gurt runs every
> session in a container: start Docker Desktop (or your Docker runtime),
> wait for it to report ready, and start the session again.

The cost is one `docker info` per `ensure`, on a call that already
takes seconds and is coalesced per session (`ensureInFlight`). A
positive answer is memoized for 5 s so a burst of starts pays once;
5 s is short enough that a daemon stopped mid-demo is never reported as
up. No memo for the negative answer — a user who just started Docker
Desktop must not have to wait out a cache.

Nothing else moves: the reconcile path (`dockerSessionContainers` and
friends) keeps its `null`-means-"could not ask" contract and does not
gain a preflight. Reconcile runs at boot on a machine that may
legitimately have no daemon yet, and refusing there would turn a quiet
degradation into a start-up error.

## 5. Prepare

### 5.1 What it pulls

Exactly two refs, both already pinned by digest in the codebase:

1. **The bundled operator env's image** —
   `parseEnvDevcontainer((await bundledOperatorEnv()).devcontainer).config?.image`,
   today `node:22-bookworm-slim@sha256:83f4…` (resources/env/devcontainer.json).
   Read, never hardcoded a second time: a packaged update bumps that pin
   and Prepare must follow it.
2. **`PROXY_IMAGE`** — `node:22-alpine@sha256:c610…`
   (main/proxy/manager.ts). Every session gets a proxy container; on a
   cold machine its pull happens inside `docker run` under
   `RUN_TIMEOUT_MS`, invisible, in the middle of a start.

**Only the bundled env's image.** When the workspace has re-pointed
`operatorEnv` (`setOperatorEnv`, Settings → Environments), the `images`
row says so — `workspace operator env is "<name>" — this row covers the
bundled default only` — and does not claim to have checked it. A
workspace env may carry a `build` section, which is not a pull at all
(it is `envBuildImage`, and §2.1 of the operator spec makes it
unreachable for an operator anyway).

### 5.2 What Prepare cannot do

Stated in the UI, not just here: **a green `images` row does not make
the first start offline-capable.** Two network steps happen on the
first start regardless of what is pulled, and both are minutes:

- **The node feature.** `devcontainerUp` passes
  `'--additional-features', JSON.stringify(features)` unconditionally
  (provision.ts:1019) with `BASE_FEATURES`' digest-pinned
  `ghcr.io/devcontainers/features/node` (provision.ts:98). This holds
  for the operator too: an image-only devcontainer with no features of
  its own still gets that one injected, so the feature is fetched from
  ghcr.io and its install script runs. See §12 question 5 — this may be
  removable for the operator env specifically, which would collapse the
  step to nothing.
- **The ACP adapter.** `npm install -g <agent.adapterPackages>` inside
  the container (provision.ts:1235, driven by
  `ContainerManager.installAdapter`), cached per container id, so it
  runs once per container and again for every replaced one.

The adapter install is a **deliberate, recorded compromise, not an
oversight**: warming it would mean baking the adapter into an image, and
the adapter is pinned per agent kind and bumped with gurt releases, so
that image would be a fifth thing to build, tag by content and keep in
step with `AGENT_DEFS`. The right eventual shape is a derived operator
image tagged by content the way `envImageTag` already tags env builds —
named here so it is a decision someone takes later, rather than a
surprise someone rediscovers on the next cold machine.

The row's success detail therefore reads `images present — the first
start still installs the node feature and the agent adapter`, rather
than anything that sounds like "ready".

### 5.3 Progress, and how it is shown

`docker pull <ref>` through provision.ts's existing `run()`, whose
`LogSink` is a line callback, emitting onto the bus event the
provisioning log already uses:

```ts
this.bus.emit('provision.log', { key: 'machine:prepare', line })
```

`provision.log`'s `key` is documented as a session id, and the second
non-session key already exists (`env-build:<ws>/<env>`, ipc.ts). This
adds a third, reserved: `machine:prepare`. `sessionLogFilePath` runs the
key through `fileId`, so it lands at
`~/.gurt/logs/session-machine-prepare.log` with no change to log.ts, and
`dropSessionLog('machine:prepare')` clears it. The renderer already
subscribes to `provision-log` and keeps `logs[key]` in `App.tsx` — the
checklist row renders `logs['machine:prepare']` in the same
provisioning-log style `SessionPane` uses for a starting session.

Both pulls run sequentially, not concurrently: two `docker pull`
progress streams interleaved into one line-oriented log is unreadable,
and the total is bounded by bandwidth either way. Timeout: 15 minutes
for the pair (`run`'s `timeoutMs`), which is generous on purpose — a
demo hotel's wifi is the case this exists for.

### 5.4 Auto-run

**Prepare does not auto-run in the background after setup.** A pull is
hundreds of megabytes on a connection gurt knows nothing about, and
starting one because the app was opened is the kind of thing that is
noticed only when it is unwelcome. It runs when the user clicks
Prepare, or as the first stage of "Start operator" (§6.3) — both are
explicit gestures with visible progress.

### 5.5 Detecting "pulled"

`dockerImageExists(ref)` — `docker image inspect -f {{.Id}} <ref>`,
already in provision.ts, already used by `envImageStatus`. Both refs are
`name@sha256:…` forms, and `docker image inspect` resolves a
digest-pinned reference against the local store, which is precisely the
question. No `docker images` parsing, no tag comparison.

## 6. "Start operator": the one-click create

### 6.1 The gesture: sign in

Below the checklist: a kind picker (the four `AGENT_DEFS` —
claude code / codex / gemini / opencode) and one button, **Sign in with
Claude (Anthropic)** / **ChatGPT (OpenAI)** / **Gemini (Google)**,
naming the provider that kind authenticates against.

> **Extends** `requirements-oauth-credentials.md` §4. That section
> presents the API key and the sign-in as *peers* in the Credentials
> modal, and this does not change that — Settings stays exactly as it
> is. The welcome screen is a different context and takes a different
> position: **the sign-in leads, the key is behind one click.** The
> reason is that document's own §1 — the credential a user meeting gurt
> for the first time actually *has* is a login, not a string. Claude,
> ChatGPT and Gemini subscriptions authenticate by sign-in, and the
> tokens those flows mint are not something anyone can extract from
> another tool's keychain and paste into a form. Leading with a
> password field asks most first-time users for the one thing they do
> not have.

**Which provider signs a kind in is a per-kind fact, on `AgentDef`.**
`oauthProvider` sits beside `secretEnv` because it answers the same
question — how this kind is authenticated — and because
`requirements-oauth-credentials.md` §5.2.1 already makes *delivery* a
per-kind fact (`oauthAuthFile` in `main/oauth/materialize.ts`):

| kind | `oauthProvider` | how the token is delivered (§5.2.1) |
| --- | --- | --- |
| claude-code | `anthropic` | `CLAUDE_CODE_OAUTH_TOKEN`, the env var |
| codex | `openai` | `~/.codex/auth.json`, env var suppressed |
| gemini | `google` | `~/.gemini/oauth_creds.json`, env var suppressed |
| opencode | **null** | — no verified delivery; API key only |

A kind is listed only once that document says how its CLI consumes a
sign-in. **opencode is null on purpose**: pointing it at the anthropic
provider would buy a browser round-trip and a failure at session start,
which is a worse outcome than asking for a key. Picking it on the
welcome screen says so and opens the key field.

### 6.1.1 The key path stays, demoted

Under the sign-in button: **"or paste an API key instead"**, one click
to a password field carrying the kind's `secretEnv` as its placeholder
(`CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, …) — that string is what
tells a user which key they are being asked for.

Not hidden and not deprecated, for two reasons that are not taste:
opencode has no sign-in path at all, and a key is the right shape for
CI, self-hosted gateways and enterprise proxies — which is why
`requirements-oauth-credentials.md` §1 says OAuth "complements
`agent-token`; it never replaces it".

### 6.2 What it creates

**The requirement, in one line: one IPC method in main creates all five,
not five calls from the renderer.** That method is `firstRunStart`
(§8), and it is called by the welcome screen — by gurt's own UI, before
any session exists. Three reasons, in order of weight:

1. **The rules are domain logic.** "Reuse the workspace if there is
   one", "re-point an existing agent instance of that kind rather than
   duplicating it", "what stays behind when step 3 throws" — that is
   knowledge about how `~/.gurt` is shaped, and the renderer is the
   wrong place for a fourth copy of it.
2. **`setAgents` and `setCredentials` replace a whole file.** There is
   no partial update. From the renderer each would be read-all →
   append → write-all, racing whatever a second window has open in
   Settings (windows are plural — `broadcast()` walks
   `getAllWindows()`).
3. **`getCredentials()` masks other people's secrets.** A renderer
   write-back therefore sends masks where real secrets belong, and main
   restores them by recognizing the mask's *shape*
   (`resolveSentinels`, credentials.ts:416). That mechanism works and is
   carefully commented; it is also a thin guard, and a second caller of
   it is how it eventually acquires a hole.

All five entities are created **eagerly**, in this order, each reusing an
existing one where the name or shape already matches:

| # | entity | name / default | reuse rule |
| --- | --- | --- | --- |
| 1 | workspace | the currently-selected workspace; else the only existing one; else create `default` | never creates a second when one exists |
| 2 | credential | **sign-in path**: `{ kind: 'oauth', label: '<kind label> sign-in', data: { providerId } }`, stored by the flow itself. **key path**: `{ kind: 'agent-token', label: '<kind label> token', data: { secret } }`. `id` a fresh `randomUUID()` either way | never reused — a pasted token is always a new entry (an existing entry's secret is unreadable from here by design), and a sign-in always mints a fresh set |
| 3 | agent instance | id from the kind slug, uniquified the way `SettingsPage`'s `uniqueId` does (`claude-code`, `claude-code-2`, …); `{ kind, label: AgentDef.label, credentialId }` | an existing instance of that kind is **re-pointed** at the new credential rather than duplicated |
| 4 | task | `setup` | reused when it exists (`store.taskExists`) |
| 5 | session | role `operator`, `repos: []`, `env: operatorEnvName(ws)`, `agent` = #3, `network: { internal: true }`, `startPrompt` = §6.5, `action: 'draft'` | never reused |

Names are checked against `store.validateName` before anything is
written: `default` is not in the workspace reserved list
(`agents.json`, `credentials.json`, `agent-config-cache.json`) and
`setup` is not in the task one (`workspace.json`, `.devcontainers`,
`skills`), so both are legal today — the point of saying so is that a
future reservation must not silently break this path.

The session's title comes free: `defaultTitleForRole` names it
`operator`, and a second one `operator 2`.

`network: { internal: true }` matches what `App.tsx`'s `createDraft`
already gives every new session — the mode that enforces the allow list
is the one a session gets without asking. The default domain policy is
`allow` (everything permitted, everything recorded), so the agent
reaches its provider; the proxy still refuses egress to the host under
every mode, which is what the operator role wants anyway.

Nothing is created lazily. Laziness is what produces the half-states
this document exists to remove.

### 6.3 The click, step by step

1. If `images` is amber, run Prepare (§5) and stream it. A Prepare
   failure stops here with its own message and creates nothing — a
   failed pull means the start would fail too, and an entity graph
   created for a start that cannot happen is exactly the litter the
   manual flow leaves behind.
2. Call `firstRunSignIn(kind)` or, on the key path,
   `firstRunStart(kind, token)`. Both verify the credential before
   creating anything, in the way their path allows:

   - **sign-in** runs the provider's browser flow (`oauthSignIn`, which
     is also what *stores* the entry — so a cancelled flow stores
     nothing). There is no token probe here and none is wanted: the
     provider just authenticated the user, which is a stronger
     statement than any `/v1/models` call could make.
   - **key** probes it (§7.3): `rejected` creates nothing and rejects
     with the provider's answer; `ok` and `unreachable` both continue,
     the latter carrying a warning back.

   Then entities 3–5 are created — by one shared `createAndStart`, so
   the two paths cannot drift in what they leave on disk — and
   `{ sessionId }` for the **draft** comes back.
3. The renderer selects that session immediately. The welcome screen
   stops matching §2.1's condition on the same tree push, so it goes
   away by itself.
4. Main then calls the ordinary `SessionManager.run(sessionId)` — the
   same path the pane's Run button takes. `firstRunStart` does **not**
   await the start.

### 6.4 Gating and failure

The button is disabled while any gating row (§3.3) is red, and while the
token field is empty. It is *not* disabled on `images`.

**Partial failure has one rule: whatever exists after a failure is an
ordinary entity the UI already knows how to show.** That falls out of
step 4 being a separate, un-awaited call:

- **The sign-in is cancelled or fails** — nothing at all exists yet.
  The oauth entry is a draft until the flow stores it, so a closed
  browser tab, a timeout or a `state` mismatch leaves the machine
  untouched. A cancel is not shown as an error; it was a decision.
- **Steps 1–5 of §6.2 throw** — the method rejects with that sentence,
  shown inline under the button. Everything created before the throw
  stays (a workspace, possibly a credential), because every one of them
  is a legal entity the user can see and reuse, and rolling back would
  delete the credential they just pasted. A second click reuses them
  (the reuse rules above make the whole method idempotent apart from the
  credential).
- **The start fails** — `SessionManager.startSession`'s catch already
  sets `info.state = 'draft'`, records `startError`, pushes a
  `start failed: <message>` system entry and emits `start-failed`. The
  user lands on a draft session pane showing the error and a Run button,
  which is the same place a failed start from any other entrance lands.
  There is no new state and no new UI for this case, which is the whole
  reason the start is handed to the existing path instead of being
  inlined.

The one thing that must not happen — a token saved into a session that
the tree cannot show — cannot happen, because the token never lives on
the session: it lives in `credentials.json`, linked by
`AgentInstance.credentialId`, and the session references the agent
instance by id.

### 6.5 The first prompt

The session's `startPrompt` is a fixed string shipped with the app (a
constant in `shared/doctor.ts` beside the rest of this surface, so the
renderer and any test read the same text). It should say what the
operator is, what it can see, and what it cannot do yet — phase 1 of
the operator spec is read-only, and a first turn that offers to fix
things it cannot write would be a bad first impression twice over.

Suggested (adjust freely at implementation time; this is not a
contract):

> You are gurt's operator session for this machine. Introduce yourself
> in two sentences, then read this workspace's configuration and tell me
> what it has and what it is missing before I can run a coding session:
> repositories, environments, MCP servers, credentials. You can read
> everything and change nothing yet — say what you would change and I
> will do it.

## 7. Token handling

This whole section is about the **key path**. On the sign-in path no
secret crosses the IPC boundary at all: `firstRunSignIn` takes an agent
kind, and the tokens are minted host-side by the provider's flow and fed
to `addSecrets` there (`requirements-oauth-credentials.md` §5.4) before
they can reach a log. That is the strongest reason to lead with it.

### 7.1 One crossing

The token crosses renderer → main exactly once, as `firstRunStart`'s
second argument, and lands in `credentials.json` through the existing
`setCredentials` (which seals it with `safeStorage` where a keystore
exists, and reports `plaintext` where none does). It is never returned,
never echoed, never written onto the session, never put in the
`startPrompt`, and never stored in renderer state past the call.

The field is `type="password"`. The renderer clears it in the same tick
the call resolves *or* rejects — a rejected call is the case where a
user retries, and a retry re-types the token rather than resubmitting a
value the renderer kept.

### 7.2 It never reaches a log

Three things, all of which use mechanisms that already exist:

1. **`firstRunStart` joins `OPAQUE_ARGS`** in `ipc.ts`, beside
   `setCredentials` and `probeMcpServer`. That set is what keeps the IPC
   wrapper from tracing arguments at DBG, and its header states the
   rule this method falls under: methods whose arguments carry
   credential payloads.
2. **`addSecrets([token])` is the first statement of the
   implementation**, before the credential is written and before
   anything can be spawned. `main/redact.ts` registers the raw, base64
   and base64url forms, and every outgoing log line passes through
   `redact()` — so a token that leaks into an error message from any
   later call in the method is already redacted when it is written.
   `setCredentials` calls `feedRedactor` itself, but it does so *after*
   its verification and write; the failure modes worth covering are the
   ones before that point.
3. **The renderer never logs it.** `renderer/src/log.ts` forwards to
   main's `logRenderer`; the welcome screen logs failures through
   `logErr`, which receives the *error*, and the error must not be
   built by interpolating the token. There is no case where it would
   be — but the rule is worth writing down next to the field.

### 7.3 The token is probed before anything is created

`verifyTokens` in credentials.ts verifies `git-token` entries against
their forge at save time and stamps the owner's identity; it
`continue`s past every other kind, so an `agent-token` is stored
unverified today. That is the one remaining way the "one screen to a
talking operator" promise breaks: a green checklist plus a mistyped
token gives a session that starts, connects, and answers with the
provider's auth error — minutes later, in a chat the user has not
learned to read yet.

**So phase 1 probes it, for all four kinds**, in `firstRunStart` before
the credential is written (§6.3 step 2). A rejected token creates
nothing and answers under the field; the user retypes and clicks again.

**The seam** is `main/agentProviders.ts` (new), one provider per
`AgentDef.id`, shaped like `git/providers.ts`: an interface with one
call, a lookup by kind, and no knowledge of it anywhere else. Each
provider makes one cheap authenticated GET with a 5 s timeout and maps
the answer to three outcomes and nothing else:

| outcome | what it means | what happens |
| --- | --- | --- |
| `ok` | the provider accepted the credential | proceed |
| `rejected` | the provider answered 401/403 | refuse, with the provider's own status in the message |
| `unreachable` | timeout, DNS, 5xx, or any unrecognized answer | **proceed**, with a warning line under the field |

`unreachable` must not block, for the same reason §3.5 makes the
reachability rows `warn`-only: the probe runs **on the host**, and the
container's route out is the session proxy's, not the host's. A
corporate proxy that blocks the host can sit next to a container that
reaches the provider fine. Refusing there would turn a working setup
into a dead end, which is worse than the failure this probe exists to
catch.

The per-kind calls, each chosen to be the cheapest authenticated read
the provider offers — none of them consumes tokens or creates state:

| kind | `secretEnv` | probe |
| --- | --- | --- |
| `claude-code` | `CLAUDE_CODE_OAUTH_TOKEN` | an `sk-ant-oat…` OAuth token → `GET https://api.anthropic.com/api/oauth/usage`, the call `main/planUsage.ts` already makes (`ENDPOINT`, `anthropic-beta: oauth-2025-04-20`, the CLI's `User-Agent`). Anything else → `GET /v1/models` with `x-api-key`. |
| `codex` | `OPENAI_API_KEY` | `GET https://api.openai.com/v1/models`, `Authorization: Bearer` |
| `gemini` | `GEMINI_API_KEY` | `GET https://generativelanguage.googleapis.com/v1beta/models?key=…` |
| `opencode` | `ANTHROPIC_API_KEY` | the Anthropic API-key branch above (`/v1/models`, `x-api-key`) |

Two hazards, both already solved once in this repo and both to be
reused rather than re-derived:

- **The 429-means-nothing trap.** `main/planUsage.ts` records that the
  `/api/oauth/usage` edge answers even an *unauthenticated* request
  with 429 rather than 401. A 429 is therefore `unreachable`, never
  `ok` and never `rejected` — reading it as acceptance would report a
  bad token as good, which is the one wrong answer this section must
  not produce. Its per-agent rate floor exists for the same edge; a
  probe that runs once per click does not need one, but it must not be
  wired into a retry loop that does.
- **The token must not reach a log through the probe.** `addSecrets`
  runs first (§7.2), so a failure message quoting the request is
  already redacted. The probe never logs the request; it logs the
  status code.

**Not a checklist row in phase 1.** The probe belongs to the token
field, where the token is, and a doctor row would have to either hold a
token (it must not) or report a stale verdict. Once the provider seam
exists, a `token accepted` row over the *saved* credentials is cheap
and lands with the phase-2 rows (§3.5).

**Not wired into `setCredentials`.** Adding `agent-token` to
`verifyTokens` would mean every save of the credentials file probes
four providers, and would make Settings → Credentials refuse a token on
a machine that is merely offline. The probe stays on this path, where
the user is asking for exactly this check. Widening it to the store is
a separate decision, taken with `verifyTokens`' own tests in front of
whoever takes it.

## 8. IPC surface

`src/shared/api.ts` is the single source of truth (its own header: "adding
a method here is the whole wiring"), and `METHODS` makes an unannotated
method a compile error. Eight methods, eight annotations:

```ts
  /** Host-state report for the welcome screen and Settings → Machine: the
   *  docker CLI, the daemon, and whether the images a first session needs
   *  are already pulled. Runs the probes on every call — this is the answer
   *  to "why will nothing start", and a cached one would be worse than none. */
  machineDoctor(): Promise<DoctorReport>
  /** Pull the two images a first session needs (the bundled operator env's
   *  and the session proxy's). Progress streams over `provision-log` under
   *  the key `machine:prepare`. Rejects with the pull's own failure. */
  machinePrepare(): Promise<void>
  /** Create everything a first operator session needs — workspace, agent
   *  instance, its `agent-token` credential, task, session — and start it.
   *  Returns as soon as the draft exists; a failed start lands on it as an
   *  ordinary `startError`, not a rejection here. */
  firstRunStart(kind: string, token: string): Promise<FirstRunResult>
  /** The same create, entered by signing in instead of pasting a key — the
   *  primary path (§6.1). Mints an `oauth` credential for the kind's provider
   *  (`AgentDef.oauthProvider`), runs that provider's browser flow, and on
   *  success creates and starts exactly what `firstRunStart` does. A cancelled
   *  flow creates nothing; a kind with no sign-in path is refused. */
  firstRunSignIn(kind: string): Promise<FirstRunResult>
  /** Abort that pending sign-in. The credential it mints is created
   *  host-side, so the renderer has no id to hand `oauthCancel`. */
  firstRunCancelSignIn(): Promise<void>
  /** The daemon row's `start-docker` action (§3.4) — `open -a Docker`, macOS
   *  only, fire-and-forget; the row's own re-check reports the result. */
  machineStartDocker(): Promise<void>
  /** When the welcome screen shows itself (§2.1.1). `GURT_WELCOME` overrides
   *  the stored value the way `GURT_LOG` overrides the log level. */
  getWelcomeMode(): Promise<WelcomeMode>
  setWelcomeMode(mode: WelcomeMode): Promise<void>
```

```ts
  machineDoctor: 'read',   //   the "why won't anything start" diagnostic
  machinePrepare: 'none',  //   host-side side effect, and a user gesture
  firstRunStart: 'none',   //   §10 bootstrap + §5.1: no path to a credential
  firstRunSignIn: 'none',  //   the same, plus a host browser window
  firstRunCancelSignIn: 'none', // controls that flow
  machineStartDocker: 'none', // host GUI, like `openLogsFolder`
  getWelcomeMode: 'read',  //   a UI preference, exactly like the hotkeys
  setWelcomeMode: 'write', //   same — "configuring gurt is the point"
```

- **`machineDoctor` is `read`** because it is precisely the diagnostic
  the operator role exists for — an operator asked "why did that session
  fail to start" today has `get_provisioning_log` and no way to learn
  that the daemon is down. It takes no parameters (so §3.2's `ws`
  binding is moot), returns paths and version strings, and passes the
  §8 scrub like every other read. Cost: one generated tool from
  `scripts/gen-admin-tools.mjs` and one line in `main/adminSurface.ts`'s
  `Pick<GurtApi, ReadMethod>` binding — both mechanical, both
  compile-checked, and CI's no-diff regeneration check covers the rest.
- **`firstRunSignIn` is `none` for `firstRunStart`'s reason and one
  more**: it opens a browser window on the user's desktop, which is the
  `openLogsFolder` rule (§3.4 of the operator doc). An agent that could
  start an OAuth flow could put a provider's consent screen in front of
  a user who did not ask for one.
- **`firstRunStart` is `none`.** The annotation is not about who calls
  the method — the welcome screen does, and no operator exists at that
  point. It answers one question and only that one: *may the operator
  agent reach this method as an MCP tool?* No. `setCredentials` is
  `none` because the credential store stays on the other side of the
  boundary (`requirements-session-operator.md` §5.1) and
  `createWorkspace` is `none` because the workspace binds the
  operator's own authority (§10); a method that creates both must not
  be reachable when neither of its parts is. The trap to avoid is
  annotating it `write` on the grounds that phase 1 treats `write` as
  `none` anyway — that is true today and stops being true in phase 2 of
  that document.

No parallel channel: `machinePrepare`'s progress rides the existing
`provision.log` bus event and the existing `provision-log` forward in
ipc.ts, and the doctor is a plain pull. Nothing new is broadcast.

## 9. What this does not change

- **The role model.** `requirements-session-roles.md` is untouched: no
  new role, no change to mounts, locks, `complete` or `create_session`.
  The operator role is used exactly as `requirements-session-operator.md`
  §2 defines it — `roleNeedsRepo('operator')` is already false, and the
  four repo gates already let it through.
- **The session lifecycle.** `draft → queued → starting → started`,
  `createSession`'s signature, the queue, the start-failure branch —
  all unchanged. `firstRunStart` is a caller of `createSession` and
  `run`, not a new path into either.
- **The operator spec's pending phases.** Writes (its phase 2), held
  fields, `applyHeld`, the composite verbs and the per-tool MCP
  allowlist are all untouched and unblocked. This document adds one
  `read` annotation and two `none`s.
- **The Credentials modal.** `requirements-oauth-credentials.md` §4's
  presentation — API key and sign-in as peers, neither recommended,
  neither buried — is exactly as it was. §6.1's ordering is the welcome
  screen's alone, and it is a first-encounter judgement, not a claim
  that one path is better than the other.
- **The Settings operator-env picker.** `setOperatorEnv` stays the way a
  workspace re-points its operator env, and the welcome screen honours
  it: the session is created on `operatorEnvName(ws)`, not on the
  bundled name. Only §5.1's image row is bundled-only, and it says so.
- **The docker preflight.** `assertDockerCli` keeps its message, its
  call site and its test (`scripts/host-path.test.mjs`); §4 adds a
  second assertion next to it.
- **`~/.gurt` layout and the config journal.** The entities created are
  the ordinary ones, through the ordinary mutators, so they journal
  themselves (`createWorkspace` and `setAgents` already call
  `journal()`); `createTask` does not journal today and this does not
  change that.

## 10. Phases

1. **The cold demo machine reaches a talking operator in one screen.**
   `shared/doctor.ts`, the three rows of §3.2, `dockerDaemon` +
   `assertDockerDaemon` and its call site in `ensureUncoalesced` (§4),
   Prepare over the two refs with its log key (§5), the four token
   probes behind `agentProviders.ts` (§7.3), `firstRunStart` (§6), the
   three API methods and their annotations (§8), the welcome screen in
   `App.tsx`'s `!selection` slot, and Settings → Machine mounting the
   same checklist component. This is the whole of the motivating
   failure and nothing else.
2. **Re-entry and honesty.** The command-palette entry and the footer
   chip (§2.3), the encrypted-at-rest row, the two reachability rows
   and a `token accepted` row over the saved credentials (§3.5, §7.3),
   and the `operatorEnv`-is-re-pointed detail on the images row.
3. **The rest of the warm-up.** The disk-space row, and — if §12
   question 5 holds — dropping the node feature from the operator env.
   A derived, content-tagged operator image carrying the ACP adapter
   (§5.2) is the end of that road and is not promised here.

Phase 1 is deliberately three rows and one button. Every row added
before the button works is a row that has to be right on a machine
nobody has tested on. The token probes are in phase 1 despite that rule
because without them a green checklist can still hand the user a
session that fails in the chat — which is the exact failure the screen
exists to remove.

## 11. Acceptance

1. `npm run lint`, `npm run typecheck`, `npm test` clean, and no
   pre-existing test changed to accommodate this work. In particular
   `scripts/admin-surface.test.mjs` passes unchanged apart from the
   three new annotations, and the `gen-admin-tools` no-diff check is
   green.
2. `scripts/first-run.test.mjs` (new, pure node, no docker) — the
   create path over a `GURT_ROOT` temp dir: the five entities with the
   names and defaults of §6.2; a second call reusing workspace, task and
   agent instance while creating a second credential and a second
   session; the session landing as a `draft` with `role: 'operator'`,
   `repos: []` and `env` equal to `operatorEnvName(ws)`, both with the
   bundled default and with `operatorEnv` set; the token present in
   `credentials.json` and absent from `sessions.json`, `agents.json`
   and every log file under `logs/`; and a `firstRunStart` whose start
   throws leaving an ordinary draft carrying `startError`.
3. `scripts/doctor.test.mjs` (new) — the row table of §3.2 over injected
   probe results: `docker-cli` failing skips the other two as `fail`
   with "not checked" rather than `ok`; `ready` is true with `images`
   amber and false with either gating row red; `docker info` exiting 0
   with empty output (and with `<nil>`) reads as **not** responding.
4. `scripts/host-path.test.mjs` — extended with `assertDockerDaemon`'s
   message, the way it already covers `assertDockerCli`'s, via the same
   injected-value seam.
4b. `scripts/first-run.test.mjs`, the mode — `welcomeShows` over all six
   (mode, firstRun) pairs; a garbage or hand-mangled value degrading to
   `auto` rather than to a screen nobody can reach; the mode persisting
   to `welcome.json`; and `GURT_WELCOME` winning over the file, forgiving
   case and padding, and falling back to `auto` on a typo without
   destroying what is stored.
4a. `scripts/first-run.test.mjs`, the sign-in half — a stub `signIn`
   stands in for the browser flow: each kind hands its own `providerId`
   to it (`claude-code`→anthropic, codex→openai, gemini→google); the
   minted entry is `kind: 'oauth'` and the agent links it exactly as it
   links an `agent-token`; a throwing flow leaves no workspace, no
   agent change and **no credential** (the entry is a draft until the
   flow stores it); and `opencode` is refused before the browser is
   opened, with `attempted === false` asserted rather than assumed.
5. `scripts/agent-providers.test.mjs` (new) — a provider per kind
   against a local HTTP stub: 200 → `ok`, 401 and 403 → `rejected`,
   **429 → `unreachable`** (the `/api/oauth/usage` edge answers an
   unauthenticated request with 429 — reading it as `ok` is the one
   wrong answer this must not produce), timeout and 5xx →
   `unreachable`; a `rejected` verdict leaves `credentials.json`,
   `agents.json` and the tree untouched, while `unreachable` creates
   everything and returns its warning; and the probed token appearing
   in no log file.
6. `npm run build && node scripts/smoke-first-run.mjs` (new, no docker)
   — a store with a workspace and a task but *no session* opens on the
   welcome screen (§2.1's condition, which is deliberately not "no
   workspaces"); the checklist renders its three rows; "Start operator"
   **Sign in with Claude (Anthropic)** leads and no key field is on
   screen until asked for; it is disabled on a machine with no daemon,
   with the reason beside it; "or paste an API key instead" opens a
   password field carrying the kind's `secretEnv`; switching kinds
   renames the button to that kind's provider, and `opencode` shows
   "has no sign-in" and the key field instead of a button; Settings →
   Machine shows the same rows; creating a draft ends the first run, and
   the command-palette entry brings it back. The docker rows will be red
   in this environment, which is the point — the screen must be legible
   and correct on the machine that has nothing.

   It then sets the mode to `never` in Settings → Machine and relaunches
   with `GURT_WELCOME=always` against that store — which by then has a
   session *and* a stored `never`, so nothing else would show the screen.
   That leg is the whole reason the setting exists.

   The sign-in button's **click** is deliberately not driven: it opens
   the system browser against a real provider, which a smoke must not
   do.
7. **Not verified without a daemon**: the whole happy path. What to
   check on first real use — Prepare pulling both refs and the row
   turning green; `docker info` on a *starting* Docker Desktop (the
   window between "the socket exists" and "the daemon answers", which is
   the case the 5 s timeout and the `<nil>` check exist for); a
   `firstRunStart` reaching `started` and producing a first turn; and
   `assertDockerDaemon` firing with its own sentence when Docker Desktop
   is quit under a running gurt. This is the same gap
   `requirements-session-operator.md` §12 item 10 records.

   **Also unrun: item 6 itself.** Every Playwright smoke needs Electron's
   unpacked binary (`npm run setup`), which the devcontainer this landed
   in has no network to fetch. The script is written and its selectors
   are read off the components it drives, but it has not been executed —
   run it on a real checkout before trusting it.

## 11a. As built

Where the plan met the code and bent.

- **A fourth IPC method.** §3.4 describes a "Start Docker Desktop"
  action; §8 listed three methods and no way to perform it.
  `machineStartDocker` exists, annotated `none` for `openLogsFolder`'s
  reason. Both sections now say four.
- **The daemon preflight fires before the image-only refusal.** §4.2
  puts it immediately after `assertDockerCli`, which already sits ahead
  of `materializeEnvConfig`. Consequence, caught by
  `scripts/operator-role.test.mjs`: on a machine whose daemon is down, an
  operator on a `build` env now hears "start Docker" rather than "this
  env is image-only". That ordering is right — a start that cannot run
  is not a start whose config is worth validating — but it invalidated
  an existing fixture whose docker stub refused *everything*. The stub
  now answers `docker info` and nothing else, which is exactly the
  machine those tests mean: a live daemon and a useless image.
- **A positive daemon answer is memoized for 5 s; a negative one never
  is.** `ensure` is already coalesced per session, but a queue draining
  several sessions would otherwise pay a `docker info` each. The
  asymmetry is the point: a user who has just started Docker Desktop
  must not have to wait out a cached "no".
- **The prepare log key is cleared on each run.** `dropSessionLog` runs
  before the pull, so a second Prepare shows its own output instead of
  appending to the last one's — a session id is unique per session and
  this key is not.
- **The checklist owns the daemon poll.** After `start-docker` the row
  reads `waiting for the daemon…` and the component re-runs
  `machineDoctor` every 3 s for 90 s (§3.4's numbers), rather than
  asking the user to guess when to press Re-check.
- **`MachineChecklist` takes the prepare log as a prop.** `App.tsx`
  already keeps `logs[key]` for every `provision-log` key, so the welcome
  screen passes `logs[PREPARE_LOG_KEY]` down and only the Settings mount
  subscribes on its own.
- **The screen leads with signing in** (§6.1), which arrived after the
  first cut of this document was written against a token field. Three
  things followed. `AgentDef` gained `oauthProvider`, because "which
  provider signs this kind in" is the same shape of per-kind fact as
  `secretEnv` and `skillsDir`, and `main/oauth/materialize.ts` already
  branches on agent kind for the delivery half. `firstRun.ts` split into
  a shared `createAndStart` plus two thin entrances, so an `oauth` first
  run and an `agent-token` one cannot drift in what they leave on disk.
  And `firstRunCancelSignIn` exists because the credential is minted
  host-side: the renderer never learns its id, so it has nothing to pass
  to `oauthCancel` and needs a cancel addressed by "the one the welcome
  screen started".
- **The welcome screen gained a mode** (§2.1.1) after the first cut
  shipped with the §2.1 condition alone. Two things forced it: a demo
  machine wants the screen on every launch, and the smoke could only
  reach it by keeping the store empty — which made the interesting
  assertions (the mode picker, a screen over a populated tree) unable to
  run in the same file. `never` came along because deriving the
  condition means the screen returns when the last session is deleted,
  and that is right by default and wrong for somebody. The command
  palette deliberately ignores all three modes.
- **`opencode` gets no sign-in button.** Its `oauthProvider` is null
  because `requirements-oauth-credentials.md` §5.2.1 verified delivery
  for three kinds and not for it. The screen says so and opens the key
  field, rather than offering a button that would complete a browser
  round-trip and then fail at session start.
- **`ipc-opaque-args.test.mjs` did its job.** It failed on the three
  new zero-argument methods until they were declared in `SAFE_ARGS`;
  `firstRunStart` it accepted, because that one was already in
  `OPAQUE_ARGS` where its pasted token belongs.

## 12. Open questions

1. **Should the welcome screen offer a repo?** The operator holds none,
   so the screen is complete without one — but the *second* thing a user
   wants is a coding session, which needs a repo, an env and a
   credential. The position taken here is that the operator is the one
   who should ask for those, in chat, which is the whole "soft entry"
   argument. If that turns out to be too slow in a demo, the answer is a
   second block on the welcome screen, not a longer form.
2. **Does `machineDoctor` want to be pushed rather than pulled?** A bus
   event on daemon-state change would let the footer chip appear without
   polling. There is no daemon-state event to subscribe to, so it would
   mean a background poll — which the phase-2 footer chip needs anyway.
   Decide when the chip lands, not before.
3. **Should `firstRunStart` be reachable from the command palette
   directly** ("Start an operator session"), skipping the screen for a
   user who already has an agent instance? Cheap, and it overlaps the
   Config-tab role picker that §16 recorded as built. Leaning yes,
   deferred to phase 2 with the rest of the re-entry work.
5. **Can the operator env skip the node feature entirely?** Its base
   image is `node:22-bookworm-slim`, which already carries node 22, and
   gurt injects `BASE_FEATURES`' node feature into it anyway
   (provision.ts:98, :1019). If the feature is redundant *for this env*,
   dropping it there removes the first of §5.2's two network steps and
   makes Prepare very nearly sufficient. Not asserted here, because it
   was not checked against a real daemon. **What to check:** whether the
   feature contributes anything the base image lacks that gurt depends
   on — the container user the devcontainer CLI resolves, the `PATH`
   `devcontainer exec` gets, and whether `npm install -g` in step 4
   still lands somewhere the adapter is launchable from. The change, if
   it holds, is a per-env feature set rather than one global
   `BASE_FEATURES`, which touches `requirements-session-operator.md`
   §2.2's "no features beyond the base node feature the container model
   already injects" and belongs in that document, not this one.

4. **What happens on a machine with two Docker runtimes?**
   `resolveHostCommand` returns the first `docker` on the repaired PATH,
   and `docker info` reports whichever daemon that CLI's context points
   at. The row shows both the resolved path and the reported server
   version, which is enough to *notice* a mismatch and not enough to fix
   one. Docker contexts are out of scope until someone hits it.

## 13. Out of scope

Installing Docker, or offering to. Any credential write path beyond the
one `agent-token` create of §6.2 — Settings → Credentials stays the
place credentials are managed, and §7.3's probe is deliberately not
wired into `verifyTokens`. Baking the ACP adapter into an image (§5.2). Onboarding beyond the first session: no
tour, no tooltips, no checklist of features. Persisting anything about
whether the welcome screen has been seen (§2.1). A doctor row for
anything gurt cannot both check honestly and act on. Cross-workspace or
multi-machine setup state. Auto-running Prepare on launch (§5.4).

## 14. Touchpoints

`src/shared/doctor.ts` (new — `DoctorRow`, `DoctorReport`, the first
prompt constant), `src/shared/api.ts` (three methods, three `METHODS`
annotations), `src/shared/adminTools.generated.ts` (regenerated —
`machineDoctor` joins the read tools), `src/main/adminSurface.ts` (one
binding), `src/main/doctor.ts` (new — the report, Prepare),
`src/main/provision.ts` (`dockerDaemon`, `assertDockerDaemon`),
`src/main/agentProviders.ts` (new — one token probe per `AgentDef.id`,
shaped like `git/providers.ts`),
`src/main/containers.ts` (`ensureUncoalesced`: the second preflight),
`src/main/firstRun.ts` (new — `createAndStart` plus its two entrances,
the only place the five creates live), `src/shared/agents.ts`
(`AgentDef.oauthProvider`), `src/main/ipc.ts` (three handlers, `firstRunStart` into
`OPAQUE_ARGS`), `src/renderer/src/components/Welcome.tsx` (new — the
screen and the reusable checklist), `src/renderer/src/App.tsx` (the
`!selection` slot, the forced-welcome flag, the palette wiring),
`src/renderer/src/components/SettingsPage.tsx` (`SettingsSection` gains
`'machine'`, its icon, its General-group entry and the welcome-mode
picker), `src/main/store.ts` (`welcome.json` and its `GURT_WELCOME`
override),
`src/renderer/src/components/CommandPalette.tsx` (one action item),
`scripts/first-run.test.mjs`, `scripts/doctor.test.mjs`,
`scripts/agent-providers.test.mjs`, `scripts/smoke-first-run.mjs`
(all new), plus the daemon-preflight cases appended to
`scripts/host-path.test.mjs`, the three zero-arg methods declared in
`scripts/ipc-opaque-args.test.mjs`'s `SAFE_ARGS`, and
`scripts/operator-role.test.mjs`'s docker stub.
