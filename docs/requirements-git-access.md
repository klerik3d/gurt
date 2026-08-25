# Requirements: git credentials & host-side git access

Status: implemented · Target: gurt Electron MVP (this repo)

This document describes the credential store and the **host-side** git
contract. Read `README.md` first. Key code: `src/main/credentials.ts`,
`src/shared/credentials.ts`, `src/main/git/env.ts`,
`src/main/git/config.ts`, `src/main/git/providers.ts`,
`src/main/git/hostCredBroker.ts`, `src/main/git/shims.ts`,
`src/main/mcp/githubServer.ts`, `src/main/changes.ts`,
`src/main/store.ts`. Do not change the contract described here without
asking the owner.

> **Superseded in part** by `requirements-mcp-proxy.md` §10, which removed
> the *container* half of this document outright. Gone, not deferred: the
> `git-ssh-key` kind and the whole ssh path (§4.2, §5's proxy shim), the
> per-session container-facing credential broker, the container shims
> (`gurt-launch`, `gurt-git-credential`, the `gh` wrapper), the
> devcontainer github-cli feature injection, and the `gitAccess` session
> toggle. What survives — and is what this document now describes — is the
> credential store (§3), save-time verification and stamped identity
> (§3.2), the *host* credential broker (§4), the rewrite matrix (§6.1),
> the forge providers' host-side halves (§7), and the host resolution
> (§8), which is load-bearing: it is what the github MCP tools run on.
>
> Also superseded in part by `requirements-session-container.md`: the host
> broker is a process-lifetime singleton and everything else that used to
> be per env is per session, since a container belongs to one session.

## 1. Motivation

All authenticated git runs on the host, under gurt-managed credentials.
Before this document it ran under *ambient* ones (the user's ssh keys,
whatever `gh` happened to be logged in as), which meant auth silently
depended on the machine, and there was no way to say "this repo uses that
credential". The store and the resolution below are the answer to both.

The session container is credential-free, and stays that way: every
authenticated operation against `origin` is delegated to the host-side
github MCP tools (`git_pull`, `git_push`, `create_pull_request`), which
run on the host clone under the resolution in §8. The container keeps
unauthenticated local git — status, diff, add, commit, branch, log — with
the commit identity of §3.2 injected so those commits are attributed.
There is deliberately no second, container-side credential path
(`requirements-mcp-proxy.md` §10.3).

## 2. The contract

The universal contract is **git's own extension points**, never a forge
API. Everything gurt does to a remote is a git-native protocol;
forge-specific logic (GitHub App token minting, OAuth refresh, the `gh`
CLI) lives behind interchangeable **forge providers** (§7). This is the
no-vendor-lock guarantee: providers extend the contract, they never
replace it, and removing one must not break the git paths.

**Credential policy (applies to every git/forge touchpoint in the app —
host git, MCP tools, discovery clones):** gurt talks to git
and forges only through gurt-managed credentials. Ambient host auth (ssh
keys, keychain helpers, `gh` login) is an explicit credential kind
(`git-host`), never a fallback: when nothing resolves, remote operations
are **blocked** with a clear error — they must not silently reach the
host's ambient auth.

Three mechanisms, all host-side, all scoped to the git process gurt spawns:

1. **HTTPS auth** — the git credential-helper protocol. A helper gurt
   materializes on the host forwards `fill` requests to the host
   credential broker over loopback; the broker answers
   `username`/`password` from the credential store (short-lived tokens
   where the kind allows).
2. **Transport independence** — `url.<base>.insteadOf` rewriting derived
   from (repo identity × credential kind), so the transport actually used
   follows the *credential*, not the stored clone URL. A repo cloned over
   ssh pushes over https with a token credential, and vice versa, with no
   remote rewriting and no re-clone.
3. **Commit identity** — `user.name`/`user.email` of the *token owner*,
   looked up from the forge once at credential save (§3.2) and injected
   next to the rest of the config. The credential policy extends to
   authorship: ambient host identity (`~/.gitconfig`) never authors a
   managed commit, on host or in container; ambient identity is only ever
   the explicit `git-host` kind. This is the one mechanism the container
   also gets (§6).

All three are delivered as `-c key=value` argv entries on the host git
call (§8), so nothing is written into the clone or into any global git
config, and the scope is one process. Ambient ssh is additionally shut off
with a failing `GIT_SSH_COMMAND` on every non-ambient call — there is no
ssh credential kind to reach it with, so a git that tries is either
misconfigured or wandering, and both must fail loudly.

The container gets exactly one of these three: commit identity, as
`GIT_CONFIG_*` env vars (git ≥ 2.31) on the agent's process tree. No
helper, no rewrites, no secret.

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
export type CredentialKind = 'git-token' | 'git-app' | 'git-host'
                           | 'agent-token' | 'mcp-token'

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
live here too as the `agent-token` kind, linked from `AgentInstance.credentialId`
the same way repos link theirs (implemented — see §10 phase 3). Do not make the
schema git-only.

`data` per kind:

| kind | data | notes |
|---|---|---|
| `git-token` | `secret`, `username` (default `x-access-token`), `gitName` + `gitEmail` (stamped by §3.2, never user-edited) | PAT, fine-grained PAT, GitLab project/deploy token, Gitea token — anything usable as HTTP basic auth. |
| `git-app` | `provider` (`github-app`), `appId`, `installationId`, `privateKeyPath` | broker mints short-lived installation tokens per request. Providers are plugins behind the broker; adding GitLab OAuth etc. must not touch the contract. Phase 3. |
| `git-host` | — | explicit opt-in to host ambient credentials — the only way ambient is ever used. |
| `agent-token` | `secret` | OAuth token / API key for a coding agent; linked from an agent (no host matching, no forge verification). |
| `mcp-token` | `secret`, optional `header`, optional `scheme` | Auth for a registry MCP server; injected by the session proxy (`requirements-mcp-proxy.md` §3.2). Never a git transport. |

**Retired kind.** `git-ssh-key` was removed with ssh support
(`requirements-mcp-proxy.md` §10.1). An entry stored under it survives a
read/write round-trip of `credentials.json` — nothing deletes a user's
data behind their back — but it does not *resolve*: `resolveCredential`
returns an error naming the kind as unsupported and telling the user to
use a token, and per the credential policy an unresolvable credential
blocks rather than falling back. The credentials editor draws such an
entry with the same message, so it can be converted or deleted.

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
3. else **nothing** — remote access to `H` is blocked with a clear error.
   Ambient behavior requires an explicit `git-host` entry resolving via
   step 1 or 2; it is never the implicit outcome.

Resolution is **per request**, not per repo: a fetch for a submodule on
another host auto-matches by that host (step 2), independently of the
repo's own link.

### 3.2 Save-time verification & commit identity

Unverified credentials are never stored. On save (`setCredentials`), every
`git-token` entry that is new, has a changed `secret`, or lacks
`gitName`/`gitEmail` is verified against its forge:

1. Lookup host: the first `hosts` entry a forge provider `matches()`
   (entries are canonicalized via `canonicalRepoId`; bare hosts pass
   through). No provider matches → the save is **rejected**: a `git-token`
   entry must name a verifiable forge host (e.g. `github.com`).
2. `provider.identity(cred, host)` (§7) — github:
   `GET https://api.github.com/user` (GHE: `https://<host>/api/v3/user`)
   with `Authorization: Bearer <secret>`. Result:
   `name = name ?? login`,
   `email = email ?? <id>+<login>@users.noreply.github.com`.
3. Lookup failure (bad token, no scope, network) → the save is **rejected**
   with the provider's error. Success → the identity is stamped into
   `data.gitName`/`data.gitEmail`.

Resolution (§3.1) treats a `git-token` entry without stamped identity as a
configuration error (`error` set: "re-save it in Credentials"); consumers
block per the credential policy. Entries saved before this section exist
are therefore blocked until re-saved — never silently used. The host
credential broker re-checks the same two gates against the entry itself
(§4) rather than trusting the caller's attestation.

## 4. The host credential broker

One HTTP service, a **process-lifetime singleton**, bound to `127.0.0.1`
only — it is not container-reachable and nothing in a session container
knows it exists. Random UUID token in the path. Started lazily on first
use, stopped when the app exits. Module `src/main/git/hostCredBroker.ts`.

```
POST /host/<token>/credential
X-Gurt-Cred-Id:   <CredentialEntry.id>     # set by env.ts from a save-time resolution
X-Gurt-Cred-Host: <host>
Content-Type: text/plain — git credential fill format:
  protocol=https
  host=github.com

200 text/plain:
  username=x-access-token
  password=<secret>
204: no credential — git falls through and fails cleanly
```

Three gates, all re-checked here against the entry itself rather than
taken on the caller's word: the fill's `host` must equal the header's,
the entry must be a `git-token` with a stamped identity (§3.2), and the
entry's own `hosts` must cover that host. A fill that wanders to another
host — a submodule, a redirect — gets nothing, and does not fall through
to ambient auth either.

Never logged: the token, the request, the fill, the URL. The port is the
only part of any of it that may reach a log line.

> There used to be a second broker here: one per session, bound `0.0.0.0`,
> reached from the container through `host.docker.internal`, plus a
> `/forge-env` endpoint and a planned ssh-agent TCP bridge (§4.2). All of
> it is removed — see the banner at the top.

## 5. The host credential helper

`git config credential.helper` points at a small node script gurt writes
to `~/.gurt/bin/gurt-credential-host.cjs` (lazily, the same pattern as
the ACP adapter install) and runs under Electron-in-node, so no system
node is assumed. On `get` it reads git's fill from stdin, POSTs it to the
broker with the two scoping headers taken from its own env
(`GURT_CRED_ID` / `GURT_CRED_HOST`), and prints the response;
`store`/`erase` are no-ops. It has no filesystem and no keystore access
of its own: it cannot read `credentials.json`, and it cannot ask for a
host it was not handed.

> The container shims that used to live here — `gurt-launch`,
> `gurt-git-credential`, the `gh` wrapper, the `gurt-ssh-agent-proxy` —
> are gone with the container broker. `/opt/gurt/bin` is no longer created
> and `spawnAcpAdapter` no longer wraps the agent in a launcher.

## 6. What the container gets

Commit identity, and nothing else. `spawnAcpAdapter` appends
`--remote-env` entries for the agent's process tree:

```
GIT_TERMINAL_PROMPT=0
GIT_CONFIG_COUNT=2
GIT_CONFIG_KEY_0=user.name    GIT_CONFIG_VALUE_0=<gitName>
GIT_CONFIG_KEY_1=user.email   GIT_CONFIG_VALUE_1=<gitEmail>
```

Unconditional — there is no toggle, because the injection carries no
authority: without it a local commit an agent does make is authored by
whatever the image happens to contain. The identity comes only from a
clean resolution (§3.1); an errored one injects nothing, which is the
honest outcome when gurt cannot say whose credential this repo uses.
`GIT_TERMINAL_PROMPT=0` stays so a remote operation the agent tries
anyway fails immediately rather than blocking on a prompt no one can
answer — and the github MCP's server instructions tell it, in words, that
shell git cannot reach `origin` here.

No credential helper, no rewrite rules, no broker URL, no secret: the
rewrite matrix below is host-only now, because the container has no
transport decision left to make.

### 6.1 Rewrite matrix

For the repo's host `H` (identity per §2.1), by resolved credential kind.
Host-side only (§8) — the container injects no rewrites:

| kind | rules |
|---|---|
| `git-token`, `git-app` | `url.https://H/.insteadOf` ← `git@H:` and `ssh://git@H/` |
| `git-host` | no rules (ambient behavior as-is) |

Both directions use plain `insteadOf` (fetch+push); `pushInsteadOf` is not
used.

## 7. Forge providers

The single extension point for forge-specific behavior, entirely
host-side. Adding a forge (gitlab, gitea, ...) is one new provider — no
change to the contract above.

```ts
// src/main/git/providers.ts
export interface ForgeProvider {
  id: string                     // 'github', 'gitlab', ...
  matches(host: string): boolean // e.g. github: host includes 'github'
  // env map for the forge CLI, or null when the credential cannot serve
  // the forge API (git-host → null)
  forgeEnv(cred: CredentialEntry, host: string): Promise<Record<string, string> | null>
  // verify the credential against the forge API and return the token
  // owner's commit identity (§3.2); throws with a readable message when
  // the forge rejects the token or the kind cannot be verified
  identity(cred: CredentialEntry, host: string): Promise<GitIdentity>
}
```

A provider used to carry two more fields — `wrappers` (shim names to
install in the container) and `features` (devcontainer features
guaranteeing the wrapped CLI exists). Both are removed: the container
authenticates to nothing, so a `gh` in it would have no credential to
use, and an image-level feature installed for a CLI nobody can log in as
is pure build cost.

Resolution: repo host → provider via `matches()` → credential per §3.1 →
`forgeEnv()`. `git-token` returns the stored secret; `git-app` (phase 3)
mints a short-lived scoped token behind the same seam. Variable names are
the provider's business (`GH_TOKEN` for github, plus `GH_HOST` when the
host is not `github.com`).

### 7.1 Where `gh` actually runs

On the host, in `create_pull_request` (`mcp/githubServer.ts`): the tool
pushes the branch with the §8 env, then runs the host's `gh pr create`
under `forgeCliEnv(access)` — the §8 env merged with the provider's
`forgeEnv`. The token exists only in the environment of that one child
process, for the length of one tool call.

## 8. Host-side git and forge use the same resolution

`ensureClone`, `discoverDevcontainer` (`provision.ts`), every git call in
`changes.ts`, and the github MCP tools (`mcp/githubServer.ts` —
`git_pull`, `git_push`, `create_pull_request`, which are now the *only*
authenticated git in the product) run with an env built by a single shared
`hostGitAccess(repo)` helper implementing the credential policy (§2) on
the host. Three modes:

- **managed** — a `git-token` entry resolves: helper reset + gurt host
  helper (secret read from `credentials.json`, answered **only for the
  resolved host** — a submodule fetch to another host gets nothing),
  §6.1 rewrite rules, `user.name`/`user.email` from the entry's stamped
  identity (§3.2 — ambient identity never authors a managed commit),
  ambient ssh blocked via a failing `GIT_SSH_COMMAND`,
  `GIT_TERMINAL_PROMPT=0`. Forge CLIs additionally get the provider's
  `forgeEnv` (e.g. `GH_TOKEN`).
- **ambient** — an explicit `git-host` entry resolves: inherit the host
  env as-is, `GIT_TERMINAL_PROMPT=0`.
- **blocked** — nothing resolves, a resolution error (including a
  retired `git-ssh-key` entry, §3), or an unimplemented kind: helper
  reset, ambient ssh blocked, `GIT_TERMINAL_PROMPT=0`. Local git works;
  network auth fails cleanly; MCP forge tools return a configuration
  error without running.

Host delivery is `-c key=value` argv entries (`gitArgs`, spread before the
git subcommand), **not** `GIT_CONFIG_*` env: host gits can predate 2.31
(e.g. 2.19 from a standalone installer) and silently ignore the env vars —
which would silently fall back to ambient auth. The env carries only the
non-config parts (`GURT_CRED_ID`/`GURT_CRED_HOST`, `GIT_SSH_COMMAND`,
`GIT_TERMINAL_PROMPT`). The container's identity injection (§6) uses the
`GIT_CONFIG_*` env mechanism instead: its git comes from devcontainer
features (≥ 2.31), and an older container git ignoring them costs only
attribution — those pairs carry no authority to leak.

This makes clone/fetch/push work for a repo whose only credential is a
gurt-managed token, on a host with no ambient git auth at all — and
guarantees the reverse: a host full of ambient auth leaks none of it
unless a `git-host` entry explicitly says so.

## 9. UI

- **Credentials modal** (pattern: `AgentsModal.tsx`): list entries; add/edit
  with kind selector, label, hosts, kind fields (secret inputs
  `type="password"`); delete blocked while any repo links to the entry;
  saved `git-token` entries show the verified identity
  (`gitName <gitEmail>`); a rejected verification (§3.2) surfaces as the
  save error.
- **ReposModal**: credential select per repo: `auto (match by host)` /
  explicit entries / `host credentials`. Shows the resolved outcome for
  the repo's host (e.g. "auto → gh-fine-grained (github.com)").
- **Composer**: no git control. There is nothing per-session to choose —
  the credential follows the repo, and the only authenticated path is the
  github MCP, which is selected like any other MCP server.

## 10. Phases

1. **Store + HTTPS path** (done): `credentials.json`, kinds `git-token` +
   `git-host`, the credential broker, the github forge provider,
   `hostGitAccess()` on the host, UI (credentials editor, repo link).
2. ~~**SSH path**~~ — dropped, not deferred (`requirements-mcp-proxy.md`
   §10.1). ssh existed to give the container a second, key-based path to
   the forge; the container no longer authenticates to anything, so the
   path has no user, and an agent socket bridged into a container is
   precisely the ambient authority that change exists to remove.
3. **App auth**: `git-app` (github-app minting behind the same provider
   seam — the credential helper and the host `gh` pick it up without
   changes). Not implemented; the kind is stored but resolves as
   unusable.

Agent secrets and MCP secrets live in the same store: an `agent-token`
kind holds a coding agent's secret (`AgentInstance.credentialId` links
it, with inline `agents.json` secrets migrated on first launch), and an
`mcp-token` holds a registry MCP server's.

## 11. Out of scope

Encrypted storage (`safeStorage`), read-only enforcement at the git level
(the credential protocol cannot distinguish fetch from push; scoping is a
credential-capability concern — fine-grained/read-only tokens, `git-app`
minted scopes), forge providers beyond github (`glab` etc. — the seam
exists, nothing is implemented), any credential path back into the
container (removed on purpose — see the banner), env for non-agent
processes in the container (VS Code terminals do not inherit the identity
injection — by design).
