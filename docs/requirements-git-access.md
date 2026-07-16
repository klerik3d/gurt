# Requirements: native git access & credential management

Status: draft for review · Owner: klerik3d · Target: gurt Electron PoC (this repo)

This document is a work order for an implementing agent. Read `README.md`
first. Key code: `src/main/provision.ts` (clone, `spawnAcpAdapter`
`--remote-env` seam), `src/main/changes.ts` (host git wrapper,
`parseOrigin`), `src/main/store.ts`, `src/main/mcp/manager.ts` +
`src/main/mcp/githubServer.ts` (host-service pattern this design reuses),
`src/shared/types.ts`. Do not change the contract described here without
asking the owner.

## 1. Motivation

Today all authenticated git runs on the host with ambient credentials
(user's ssh keys, `gh` login); the container is credential-free and remote
operations are delegated through the host-side github MCP service. This
works but: the agent has no *native* git (`git push` in the container
fails), auth silently depends on whatever the host happens to have, the
github MCP is forge-specific, and there is no way to say "this repo uses
that credential".

## 2. The contract

The universal contract is **git's own extension points**, never a forge
API. The container speaks only git-native protocols; forge-specific logic
(GitHub App token minting, OAuth refresh, forge CLI wrappers like `gh`)
lives behind a host-side broker as interchangeable **forge providers**
(§7). This is the no-vendor-lock guarantee: providers extend the
contract, they never replace it, and removing one must not break the git
paths.

Three mechanisms, all injected per agent process (not per container):

1. **HTTPS auth** — the git credential-helper protocol. A shim helper in
   the container forwards `fill` requests to the host broker over
   `host.docker.internal`; the broker answers `username`/`password` from
   the credential store (short-lived tokens where the kind allows).
2. **SSH auth** — the ssh-agent protocol. A shim bridges an in-container
   unix socket to a host-side ssh-agent holding only the linked key. Key
   material never enters the container.
3. **Transport independence** — `url.<base>.insteadOf` rewriting derived
   from (repo identity × credential kind), so the transport actually used
   follows the *credential*, not the stored clone URL. A repo cloned over
   ssh pushes over https with a token credential, and vice versa, with no
   remote rewriting and no re-clone.

All three are delivered via `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/
`GIT_CONFIG_VALUE_n` and `SSH_AUTH_SOCK`/`GIT_SSH_COMMAND` environment
variables (git ≥ 2.31), so nothing is written into the clone or the
container's global git config. Scope is the agent's process tree only —
this is the "passed into the agent optionally at start" requirement.

### 2.1 Repo identity

Canonical identity is `(host, path)` with `.git` stripped:
`git@github.com:me/app.git`, `ssh://git@github.com/me/app`, and
`https://github.com/me/app.git` are the same repo `github.com/me/app`.
Extend `parseOrigin` (`changes.ts`) into a shared `canonicalRepoId(url)`.
The stored `RepoConfig.url` is only the initial clone source; auth,
matching, and rewriting operate on identity. Editing the URL scheme in
repo settings must not create a "different repo".

## 3. Credential store

New file `~/.gurt/credentials.json` (plaintext for now — same tradeoff as
`agents.json`; `safeStorage` is a later, isolated change). Managed by
`src/main/credentials.ts` (CRUD in the `store.ts` style).

```ts
// src/shared/credentials.ts
export type CredentialKind = 'git-token' | 'git-ssh-key' | 'git-app' | 'git-host'

export interface CredentialEntry {
  id: string                    // uuid, stable — configs link by this
  label: string
  kind: CredentialKind
  hosts: string[]               // git hosts for auto-match; [] = explicit link only
  data: Record<string, string>  // kind-specific, see below
}

export interface CredentialsFile { credentials: CredentialEntry[] }
```

The store is deliberately generic (`kind` + opaque `data`): agent secrets
in `agents.json` migrate to entries here later (`agent-*` kinds) and
`AgentInstance` will link by id the same way repos do. Out of scope now,
but do not make the schema git-only.

`data` per kind:

| kind | data | notes |
|---|---|---|
| `git-token` | `secret`, `username` (default `x-access-token`) | PAT, fine-grained PAT, GitLab project/deploy token, Gitea token — anything usable as HTTP basic auth. |
| `git-ssh-key` | `keyPath` (host path) **or** `hostAgent: "1"` | dedicated key file, or bridge to the host's own `SSH_AUTH_SOCK`. |
| `git-app` | `provider` (`github-app`), `appId`, `installationId`, `privateKeyPath` | broker mints short-lived installation tokens per request. Providers are plugins behind the broker; adding GitLab OAuth etc. must not touch the contract. Phase 3. |
| `git-host` | — | explicit "use host ambient credentials" (current behavior). |

### 3.1 Linking, not storing

`RepoConfig` gains one optional field — a link, never a secret:

```ts
export interface RepoConfig {
  name: string
  url: string
  devcontainer: string
  credentialId?: string   // link into credentials.json; absent = auto
}
```

Resolution order for a request to host `H`, repo `R`:

1. `R.credentialId` set and entry exists → that entry (if the entry cannot
   serve `H` — e.g. token entry asked over ssh with no rewrite — this is a
   configuration error surfaced in UI, not a silent fallback).
2. else first entry whose `hosts` contains `H` (auto-match).
3. else implicit `git-host` (ambient).

The broker resolves **per request**, not per env: a fetch for a submodule
on another host auto-matches by that host (step 2), independently of the
env repo's link.

## 4. Host broker

One HTTP+TCP service per running env, following `mcp/manager.ts` exactly:
bind `0.0.0.0`, random UUID token in the path, started with the env,
stopped with it. New module `src/main/git/broker.ts`.

### 4.1 Credential endpoint

```
POST /git/<token>/credential
Content-Type: text/plain — git credential fill format:
  protocol=https
  host=github.com
  path=me/app.git

200 text/plain:
  username=x-access-token
  password=<secret or minted short-lived token>
204: no credential — git falls through and fails cleanly
```

The broker resolves per §3.1, never logs secrets, and answers only for
`protocol=https`/`http`. Run any host-side subprocess with the
PATH-augmented env (`githubServer.hostEnv()` — extract it to a shared
helper).

### 4.2 ssh-agent bridge

TCP endpoint on the same service. Protocol: client sends `<token>\n`,
then the raw ssh-agent protocol is piped. Host side connects the pipe to:

- a **dedicated** `ssh-agent` spawned per env with only the linked key
  added (`ssh-agent` + `ssh-add <keyPath>`), killed on env stop; or
- the host's `SSH_AUTH_SOCK` when `hostAgent` is set (exposes all host
  identities — the UI labels this option accordingly).

## 5. Container shims

All shims live in a dedicated dir `/opt/gurt/bin`, written into the
container at env-up via `devcontainer exec` (same lazy pattern as
`installAcpAdapter`); all are small node scripts (node is guaranteed by
`BASE_FEATURES`):

- `gurt-launch` — prepends `/opt/gurt/bin` to `PATH` and `exec`s its
  argv. The agent adapter is started through it (§6), so shims shadow
  container binaries for the agent's process tree only. PATH is resolved
  inside the container (no guessing from the host), and VS Code
  terminals etc. stay untouched.
- `gurt-git-credential` — credential helper: on `get`, reads stdin,
  POSTs it to `$GURT_GIT_BROKER/credential`, prints the response;
  `store`/`erase` are no-ops.
- `gurt-ssh-agent-proxy` — listens on `/tmp/gurt-ssh-agent.sock`, per
  connection dials the broker TCP port, sends the token line, pipes both
  ways. Started detached at env-up only when the resolved credential
  needs ssh (phase 2).
- forge CLI wrappers (`gh`, later `glab`, ...) — contributed by forge
  providers, see §7.

## 6. Injection at agent start

Session start params gain `gitAccess: boolean` next to the existing
`McpSelection`; composer shows a toggle (default: on when a credential
resolves for the repo). Off = status quo (no injection; github MCP remains
the delegated path). The github MCP service is untouched by this doc.

When on, `spawnAcpAdapter` wraps the exec'd command in the launcher —
`devcontainer exec ... -- /opt/gurt/bin/gurt-launch <agent.bin>
<binArgs>` — and appends `--remote-env` entries:

```
GURT_GIT_BROKER=http://host.docker.internal:<port>/git/<uuid>
GIT_TERMINAL_PROMPT=0
GIT_CONFIG_COUNT=<n>
GIT_CONFIG_KEY_0=credential.helper      GIT_CONFIG_VALUE_0=            # reset inherited helpers
GIT_CONFIG_KEY_1=credential.helper      GIT_CONFIG_VALUE_1=/usr/local/bin/gurt-git-credential
# rewrite rules per §6.1, e.g. for a token credential on github.com:
GIT_CONFIG_KEY_2=url.https://github.com/.insteadOf   GIT_CONFIG_VALUE_2=git@github.com:
GIT_CONFIG_KEY_3=url.https://github.com/.insteadOf   GIT_CONFIG_VALUE_3=ssh://git@github.com/
# ssh credentials additionally:
SSH_AUTH_SOCK=/tmp/gurt-ssh-agent.sock
GIT_SSH_COMMAND=ssh -o StrictHostKeyChecking=accept-new
```

Secrets themselves are **never** in `--remote-env`, container files, or
logs — only the broker URL+token.

### 6.1 Rewrite matrix

For the env repo's host `H` (identity per §2.1), by resolved credential
kind:

| kind | rules |
|---|---|
| `git-token`, `git-app` | `url.https://H/.insteadOf` ← `git@H:` and `ssh://git@H/` |
| `git-ssh-key` | `url.ssh://git@H/.insteadOf` ← `https://H/` |
| `git-host` | no rules (ambient behavior as-is) |

Both directions use plain `insteadOf` (fetch+push); `pushInsteadOf` is not
used.

## 7. Forge providers

The single extension point for forge-specific behavior. A provider is a
host-side module; adding a forge (gitlab, gitea, ...) is one new file
plus optional wrapper shims — no change to the contract above.

```ts
// src/main/git/providers/<id>.ts
export interface ForgeProvider {
  id: string                     // 'github', 'gitlab', ...
  matches(host: string): boolean // e.g. github: host includes 'github'
  // env map for the forge CLI, or null when the credential cannot serve
  // the forge API (git-ssh-key, git-host → null)
  forgeEnv(cred: CredentialEntry, host: string): Promise<Record<string, string> | null>
  wrappers: string[]             // shim names to install, e.g. ['gh']
  // devcontainer features guaranteeing the wrapped CLIs exist, merged
  // into --additional-features at env-up (next to BASE_FEATURES' node)
  features: Record<string, object> // { 'ghcr.io/devcontainers/features/github-cli:1': {} }
}
```

Feature contribution rules: the set is computed at `devcontainerUp` from
the env repo's host only (provider `matches()`), **not** from credentials
or the session toggle — features are image-level, so the set must be
stable for the env's lifetime (changing it triggers a rebuild on next
up). An installed-but-unauthenticated CLI (toggle off, no credential) is
harmless. If the repo's own devcontainer already declares the same
feature, the merge is benign — same tool.

Broker endpoint:

```
GET /git/<token>/forge-env
200 application/json: { "GH_TOKEN": "...", "GH_HOST": "..." }  // names chosen by the provider
204: no provider for the host, or the credential cannot serve the API
```

Resolution: env repo's host → provider via `matches()` → credential per
§3.1 → `forgeEnv()`. `git-token` returns the stored secret; `git-app`
(phase 3) mints a short-lived scoped token — wrappers benefit without
changes. Variable names are the provider's business (`GH_TOKEN` for
github, plus `GH_HOST` when the host is not `github.com`).

### 7.1 gh wrapper (phase 1)

`/opt/gurt/bin/gh`, contributed by the github provider:

1. Resolve the real `gh`: first PATH entry that is not the shim itself.
   Normally guaranteed by the provider's github-cli feature; if missing
   anyway (e.g. pre-existing env image) → exit 1 with `gh is not
   installed in this container; rebuild the environment`.
2. `GET $GURT_GIT_BROKER/forge-env`. On 200 merge the env map into the
   child env; on 204/error run passthrough unchanged.
3. `exec` the real gh with argv untouched.

The token exists only in the env of that one gh process, fetched per
invocation — never in static container env, files, or `devcontainer
exec` argv. Git subprocesses spawned by gh keep using the credential
helper path as usual.

## 8. Host-side git uses the same resolution

`ensureClone` (`provision.ts`) and every git call in `changes.ts` must run
with an env built by a single shared `gitEnv(repo)` helper implementing
the same contract on the host: same `GIT_CONFIG_*` rewrite rules, helper
pointed at the broker over `127.0.0.1` (or an equivalent local askpass),
`GIT_TERMINAL_PROMPT=0` everywhere (including `ensureClone`, which today
can block on a prompt). `git-host` kind → empty env, current behavior.
This makes clone/fetch/push work for a repo whose only credential is a
gurt-managed token, on a host with no ambient git auth at all.

## 9. UI

- **Credentials modal** (pattern: `AgentsModal.tsx`): list entries; add/edit
  with kind selector, label, hosts, kind fields (secret inputs
  `type="password"`); delete blocked while any repo links to the entry.
- **ReposModal**: credential select per repo: `auto (match by host)` /
  explicit entries / `host credentials`. Shows the resolved outcome for
  the repo's host (e.g. "auto → gh-fine-grained (github.com)").
- **Composer**: `git access` toggle per session start (§6).

## 10. Phases

1. **Store + HTTPS path + gh**: `credentials.json`, kinds `git-token` +
   `git-host`, broker credential + forge-env endpoints, shims
   (`gurt-launch`, `gurt-git-credential`, `gh` wrapper), github forge
   provider incl. github-cli feature injection at `devcontainerUp`,
   `GIT_CONFIG_*` injection, `gitEnv()` on host, UI (modal, repo link,
   toggle).
2. **SSH path**: `git-ssh-key`, dedicated per-env ssh-agent, TCP bridge +
   proxy shim.
3. **App auth + agents**: `git-app` (github-app minting behind the same
   provider seam — credential helper and gh wrapper pick it up without
   changes), migrate `agents.json` secrets into the credential store with
   `AgentInstance.credentialId` links.

## 11. Out of scope

Encrypted storage (`safeStorage`), read-only enforcement at the git level
(the credential protocol cannot distinguish fetch from push; scoping is a
credential-capability concern — fine-grained/read-only tokens, `git-app`
minted scopes), forge providers beyond github (`glab` etc. — the seam
exists, nothing is implemented), removing/changing the github MCP
service, env for non-agent processes in the container (VS Code terminals
do not inherit the injection — by design).
