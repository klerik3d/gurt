# Requirements: MCP registry & the per-session proxy container

Status: draft for review · Target: gurt Electron MVP (this repo)

This document is a work order for an implementing agent. Read `README.md`
first, then `requirements-session-container.md` (the container model this
builds on) and `requirements-git-access.md` (the parts of it this
retires). Key code: `src/main/mcp/manager.ts` (the per-(session, mcp)
host servers this replaces), `src/main/mcp/githubServer.ts`,
`src/main/mcp/gurtServer.ts`, `src/main/containers.ts` (`ensure`,
`resolveLaunch`, `teardown`, `reconcile`), `src/main/provision.ts`
(`devcontainerUp`, `idLabelArgs`, `spawnAcpAdapter`, the `docker*`
helpers), `src/main/git/broker.ts`, `src/main/git/config.ts`,
`src/shared/mcp.ts`, `src/shared/types.ts`, `src/main/store.ts`.

> **Supersedes in part** `requirements-git-access.md`: §4.2 (ssh-agent
> bridge), the `git-ssh-key` kind of §3, the container half of §4/§5/§6,
> and the container-side forge wrapper of §7.1 are dropped, not deferred.
> Everything that document says about *host-side* resolution (§3.1, §3.2,
> §8) stands unchanged and is load-bearing here.

## 1. Motivation

Two problems, one shape.

**MCP is a closed set.** `MCP_DEFS` (`src/shared/mcp.ts`) is a hardcoded
array with exactly one entry (`github`), and `mcp/manager.ts` starts one
host HTTP server per (session, mcp id), bound `0.0.0.0`, reached from the
container as `http://host.docker.internal:<port>/mcp/<uuid>`. A user who
wants their own MCP server has nowhere to put it, and the transport we
would have to hand them is "a URL with a bearer credential in it, set as
an env var inside the container" — i.e. the secret lands in the container,
in the adapter's argv, and in anything that dumps its environment.

**Egress is unbounded and invisible.** The container is a normal
devcontainer on the default bridge. The agent can reach anything the host
can reach, nothing records that it did, and a session cannot be told "you
may talk to npm and your MCP servers and nothing else". The one thing the
current design *does* keep out of the container — host credentials — it
keeps out by never letting the container do the authenticated work at all
(§10), which is why native git in the container exists as a parallel
credential path with its own broker, its own shims and its own ssh plans.

The fix for both is the same object: **one small proxy container per
session, on a session-private Docker network**, holding the credentials
and the policy, so the session container holds neither. MCP calls and
general egress become the same hop, logged in the same place, revocable
in the same breath.

## 2. The contract

- The session container gets **no secrets**. Not MCP tokens, not git
  credentials, not the tokens of gurt's own host-side MCP servers. What
  it gets is a URL to the proxy and an opaque token that *names a scope*
  the proxy holds.
- The proxy is **per session**, 1:1, exactly like the container
  (`requirements-session-container.md` §2). It is created with the
  session, torn down with it, and never shared.
- The proxy is the **only** thing that speaks to an MCP upstream. Both
  kinds of upstream go through it: registry servers (user-configured,
  remote, HTTP) and host servers (gurt's own `github` and `gurt` servers,
  running in the main process).
- Egress policy is a **session property**, chosen at session creation.
  It can be edited afterwards, and the edit takes effect at the **next
  session start** — a running session keeps the policy it started with
  (§5.3). Its two modes differ in what they *are*:
  observability (default) and enforcement (`internal: true`). The doc
  never pretends the first is the second.
- Every connection attempt is logged, allowed or denied, at **domain
  granularity only**. gurt does not terminate TLS. `CONNECT` carries a
  hostname and a port; that is what gets recorded.

### 2.1 Threat model

The adversary is **the agent** — a capable, prompt-steerable process that
may exfiltrate the repo, phone home, or pull down a payload. It is not
assumed malicious; it is assumed *steerable*, which is the same thing
under an untrusted prompt or a poisoned dependency.

The adversary is **not** the container image, the devcontainer features,
or the project's own dependency install. Those run before the agent
exists and, deliberately, on an open network (§7.3). Say this out loud in
the UI: internal mode bounds the *agent*, not the *build*.

## 3. The MCP registry

### 3.1 Where it lives: workspace.json

The registry is a third array in `<workspace>/workspace.json`, next to
`repos` and `envs`:

```ts
// src/shared/types.ts
export interface WorkspaceFile {
  repos: RepoConfig[]
  envs: EnvConfig[]
  mcpServers?: McpRegistryEntry[]   // absent = none
}
```

```ts
// src/shared/mcp.ts
export interface McpRegistryEntry {
  /** Stable id, the session's `McpSelection.id`, and the last path segment
   *  of the proxy route. Unique per workspace; may not collide with a
   *  built-in id (`github`, `gurt`) — see §3.3. */
  id: string
  /** Absolute http(s) URL of the upstream MCP endpoint. HTTP transport
   *  only: no stdio, no local process. */
  url: string
  /** Static headers sent upstream, verbatim. Never a secret — the store
   *  is a plain file the user edits and shares. */
  headers?: { name: string; value: string }[]
  /** Link into credentials.json (`CredentialEntry.id`), never a secret.
   *  Resolved and injected at the proxy (§4.3). */
  credentialId?: string
}
```

**Why workspace-level and not global.** Four reasons, in order of weight:

1. Every consumer is workspace-scoped already. A session resolves through
   `EnvRef.workspace`; `resolveMcpServers` receives the ref today. A
   global registry would introduce a second scope axis for a thing with
   no global consumer.
2. `workspace.json` is already "what this workspace is made of" — the
   repos it can clone, the envs it can build. An MCP server is the same
   category of fact: a named resource a session picks by id. Envs and
   repos are not global either, for the same reason.
3. Registry entries name *project* infrastructure (an issue tracker, an
   internal docs server, a staging API). Two workspaces wanting different
   `linear` endpoints must not have to fight over one name.
4. It keeps the secret boundary where it already is. `workspace.json`
   holds links (`credentialId`), `~/.gurt/credentials.json` holds
   secrets — exactly the split `RepoConfig.credentialId` established
   (`requirements-git-access.md` §3.1). One store for secrets, per
   machine; one registry per workspace, safe to read, diff and share.

The cost is duplication: an MCP server used from three workspaces is
configured three times. Accepted — it is a URL and a credential id, and
repos already duplicate the same way. A global layer that workspaces
inherit and override is a later change (§12) and does not affect the
runtime described here.

Registry edits follow the existing `store.ts` shape exactly: read via
`getWorkspace` (which stays tolerant of the field being absent), write
through `editWorkspace`'s `chained()` serialization, one mutator per
operation (`addMcpServer` / `updateMcpServer` / `removeMcpServer`).
`removeMcpServer` is refused while a live session's selection names it
(same rule as deleting a linked credential).

### 3.2 Credentials for MCP

A new credential kind, alongside `agent-token`:

| kind | data | notes |
|---|---|---|
| `mcp-token` | `secret`, optional `header` (default `Authorization`), optional `scheme` (default `Bearer`) | Injected by the proxy as `<header>: <scheme> <secret>`, or as the bare secret when `scheme` is empty (`X-Api-Key` style). |

No save-time verification (§3.2 of the git-access doc) applies: there is
no forge to ask, and an MCP server's auth failure surfaces on first use
as an upstream 401 in the session log. `agent-token`'s entry is the
precedent — the store was built generic on purpose.

Whether the secret *works* is therefore never checked, but whether it can
be **sent** is, in three places, because the failure mode is not a 401:
node refuses to build a request with a newline in a header value, and it
refuses synchronously, inside the proxy's request listener. Padding is
stripped (a terminal copy carries a trailing newline); a break inside the
token is an error. `checkMcpSecret` rejects it on save,
`resolveMcpCredential` rejects it at scope-build time — covering entries
stored before that check existed, which drop out of the scope with a
reported error rather than poisoning a header — and the proxy answers
502 for that one id instead of dying, since one bad credential may not
cost a session its other MCP routes and all of its egress.

### 3.3 Built-ins, ids, and modes

`MCP_DEFS` stays: `github` is code, not user data, and `gurt` (the turn
contract) is not user-selectable at all. The composer's picker is the
union of `MCP_DEFS` and the workspace's registry; the two are visually
distinguished (built-ins carry gurt's own tool descriptions). Built-in
ids are reserved — saving a registry entry with id `github` or `gurt` is
rejected in the store validator, not just in the UI, because both spaces
share the proxy's route namespace.

`McpSelection.mode` (`read-only` / `full`) stays **built-in only**. It
exists because gurt knows, statically, which of *its* tools write
(`McpToolInfo.write`). gurt knows nothing about an upstream server's
tools, and a picker that offered `read-only` for one would be claiming an
enforcement it does not have. Registry entries are off or on; the picker
shows two states for them and three for built-ins, and `mode` is recorded
as `full` for a selected registry entry so `McpSelection` keeps one shape.

## 4. The proxy container

### 4.1 What it is

A stock `node:22-alpine` (pinned by digest, the way `providers.ts` pins
its feature refs) running one bind-mounted script. No image build, no
registry of our own, no `npm install` at session start — the script is
dependency-free Node using `node:http`/`node:net` only, and lives beside
the app:

```
<resources>/proxy/gurt-proxy.mjs   (host, read-only bind)
  → /opt/gurt/proxy.mjs            (container)
```

Path resolution follows `devcontainerCliPath()`'s dev-vs-packaged split.
Startup, in this order — the order matters (§6.2):

```
docker run -d \
  --name gurt-proxy-<session> \
  --label gurt.proxy=<session> \
  --network gurt-egress \
  --publish 127.0.0.1::8101 \                 # control, host loopback only
  --add-host host.docker.internal:host-gateway \
  --mount type=bind,source=<resources>/proxy/gurt-proxy.mjs,target=/opt/gurt/proxy.mjs,readonly \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  node:22-alpine@sha256:... node /opt/gurt/proxy.mjs
docker network connect --alias gurt-proxy gurt-s-<session> gurt-proxy-<session>
```

No docker socket, no other mount, no workspace access. The agent cannot
`docker exec` into it (there is no docker client in the session
container, and no socket to use one on): the credentials the proxy holds
live in its heap and die with it.

**The label key is `gurt.proxy`, not `gurt.session`.** Deliberate:
`dockerSessionContainers()` and `dockerSessionContainerIds()` build the
session → *devcontainer* registry from `--filter label=gurt.session`, and
`ContainerManager.teardown`/`reconcile` treat every hit as a devcontainer
to stop, adopt or remove. A proxy carrying the same key would collide in
that map and be swept as if it were the session's container. A separate
key keeps every existing query correct by construction rather than by a
negative filter every call site must remember. Networks are a different
docker namespace and cannot collide, so they do carry
`gurt.session=<id>` as agreed.

### 4.2 Two listeners

| port | reachable from | purpose |
|---|---|---|
| 8100 | the session network only | MCP routing + `CONNECT` egress, for the agent |
| 8101 | host loopback (published) *and* the session network | control plane, guarded by a separate token (§5.3) |

Both are on the same container, so both are dialable from the session
network — port separation is not isolation. The control token is what
separates them (§5.3).

### 4.3 MCP routing

```
<any method> /mcp/<sessionToken>/<mcpId>
```

The proxy looks `mcpId` up in the scope bound to `sessionToken` (§5) and
gets an upstream descriptor of one of two kinds:

- **`registry`** — `{ url, headers, auth? }` from the workspace entry,
  with `auth` already resolved from `credentials.json` by the host and
  pushed as a literal header. The proxy dials the upstream directly (it
  is on `gurt-egress`), replaces the request path with the upstream's,
  merges `headers` + `auth` over the incoming ones, and pipes.
- **`host`** — `{ url }` pointing at gurt's own per-session host listener
  (`http://host.docker.internal:<port>/mcp/<hostToken>/<mcpId>`), the
  route that serves `github` and `gurt`. The host token is injected here
  and never exists in the session container. This is what keeps the
  github MCP working in internal mode, where `host.docker.internal` is
  not reachable from the session container at all.

Transport rules, all "don't get clever": hop-by-hop headers are dropped;
`Mcp-Session-Id`, `Last-Event-ID`, `Accept` and `Content-Type` pass
through untouched; responses are **piped, never buffered** (streamable
HTTP answers a POST with an SSE stream, and a buffering proxy turns a
working server into a hang); `DELETE` passes through so an MCP session
can be closed; no response rewriting of any kind. An unknown `mcpId`, or
one not in scope, is `404` — with a log record, since "the agent asked
for an MCP it does not have" is exactly the kind of thing the blocked
list should show.

Upstream MCP hosts are **not** subject to the egress policy (§6.3): the
user selected them explicitly, per session, which is a stronger statement
of intent than an allow-list entry. They also never traverse the `CONNECT`
path — the proxy dials them itself.

### 4.4 Egress

`CONNECT host:port` → policy check → dial → `200 Connection Established`
→ pipe both ways, byte for byte. TLS is not terminated and no certificate
is ever generated; the proxy sees a hostname and a port and nothing else.

Plain HTTP (absolute-form request URI, the shape a proxy receives) →
policy check on the request's host → forward. Only the host is recorded:
a URL path routinely carries tokens, and the log must be safe to show.

A denial is `403` on both paths (`HTTP/1.1 403 Forbidden` before the
tunnel is established, with a one-line body naming the host and pointing
at the session's network settings — an agent that reads its own error
message should learn what happened rather than retry forever).

Egress is **not** token-guarded: only the session container is on the
session network, and requiring `Proxy-Authorization` would break the
long tail of clients that do not send it while adding nothing an attacker
on that network could not already reach. The token guards MCP because it
guards *credential injection* and *scope*, not because it hides a port.

### 4.5 What the agent gets

`spawnAcpAdapter`'s `--remote-env`, alongside the ACP descriptors that
now carry proxy URLs:

```
HTTP_PROXY=http://gurt-proxy:8100      http_proxy=http://gurt-proxy:8100
HTTPS_PROXY=http://gurt-proxy:8100     https_proxy=http://gurt-proxy:8100
NO_PROXY=localhost,127.0.0.1,::1,gurt-proxy
no_proxy=localhost,127.0.0.1,::1,gurt-proxy
```

Both cases, because curl and Node disagree about which one they read.
`gurt-proxy` resolves through the session network's embedded DNS
(user-defined networks only — another reason the session never sits on
the default bridge). MCP servers are addressed by the descriptors
themselves (`AcpHttpMcpServer.url`), so no extra env var is needed for
them.

## 5. Auth: an opaque token bound to a scope

### 5.1 The token

32 random bytes, base64url (`randomBytes(32)`), minted per session at
proxy start. It appears in the ACP descriptor URLs and in the proxy's
scope map. It is never logged: the existing convention — log the port,
never the URL (`mcp/manager.ts`, `git/broker.ts`) — applies unchanged.

### 5.2 Explicitly not a JWT

A signed token is the reflex here and it is the wrong tool:

- **Issuer and verifier are the same process boundary.** gurt's main
  process mints the token and pushes the scope to the one proxy that will
  ever verify it. There is no third party to convince, which is the only
  problem a signature solves.
- **Revocation must be instant.** Deleting a key from a `Map` revokes;
  a JWT is valid until it expires, so revocation would need a
  allow list — i.e. server-side state, i.e. the thing the JWT was chosen to
  avoid.
- **Scope changes do not reissue the token.** The user flips an MCP off,
  edits the allow list, or switches the session to internal, and the same
  token has to keep working across the restart that picks the change up.
  It is baked into an ACP descriptor sent at `session/new` and into a
  process environment; server-side scope means it stays a valid handle
  and its *meaning* changes, so the next start pushes the new scope under
  the token the session already has. A JWT carries its scope in its own
  bytes, so the same edit mints a new token and every place that holds
  the old one has to be found and rewritten. (*When* the change lands is
  §5.3: at the next session start, not while the agent is running.)
- Minor, but real: no key management, no clock skew, no expiry policy, no
  multi-kilobyte bearer strings in environments and logs.

The scope is the authority; the token is a handle to it. Write that down
in the module header, because the next reader will reach for JWT too.

### 5.3 Scope, and how it gets there

```ts
interface ProxyScope {
  session: string
  mcp: Record<string, McpUpstream>       // id → registry | host descriptor (§4.3)
  network: { internal: boolean; policy: DomainPolicy }
}
type DomainPolicy = { allow: string[] }   // empty = open (default), §6.3
```

The host **pushes** the scope; the proxy holds it in memory and answers
from it with no host round-trip on the hot path (an MCP call must not
depend on the main process being responsive, and an SSE stream must not
be re-authorized per event).

```
POST   /control/<controlToken>/scope    { token, scope }   → 204
DELETE /control/<controlToken>/scope    { token }          → 204   (revoke)
GET    /control/<controlToken>/health                      → 200
```

`controlToken` is a second, disjoint 32-byte secret that exists only in
the main process and in the proxy — never in the session container's
environment, never in an ACP descriptor. It is what stops the agent, who
is on the same network as port 8101, from granting itself a scope. The
host reaches the control plane over the published loopback port, so it
works whether or not the daemon is local-socket or remote-context.

Before any scope is pushed, `/mcp/*` answers `503` and `CONNECT` is
refused: a proxy that starts before its scope arrives must fail closed.
The push happens in `resolveLaunch`, before `spawnAcpAdapter` — the agent
never observes an unconfigured proxy.

Every later change (MCP selection edited, policy edited, session switched
to/from internal) is another push, and it takes effect at the **next
session start**. A running session keeps the scope pushed when it
started: the push happens on the start and resume paths only, before the
adapter is spawned, and the settings edit itself lands on a draft
(`editDraft` ignores a session that has left `draft`). Repointing a live
session's scope is deliberately **not built** — an agent mid-turn would
see its tool set change underneath it, and the value did not justify the
wiring. If it is ever wanted, §5.2 is why it would not need a new token.
`stopMcpServers`' role becomes "revoke the scope and stop the proxy".

### 5.4 As built: the scope is a watched file, not a pushed one

The proxy script and its host-side contract landed
(`resources/proxy/gurt-proxy.mjs`, `src/main/proxy/config.ts`) with one
deliberate change to §5.3: the scope reaches the proxy as a bind-mounted
JSON file (`<gurtRoot>/proxy/<session>.json` → `/etc/gurt/proxy.json`)
that the proxy re-reads on change, rather than as a POST to a second
listener on 8101.

Everything §5.2 argues for is unchanged — server-side scope, instant
revocation, no reissued token — and the delivery gets simpler in three
places: there is no control token to mint, guard and keep out of the
session container; a push cannot be lost to a proxy that restarted before
the host noticed, because the file is the state; and teardown's "revoke"
is `rm`. Writes are temp-file + rename, so a watcher can never read a
half-written scope, and a file that fails to parse leaves the last good
scope running rather than opening or closing a live session.

What it costs, and it is the reason this is written down: a resolved MCP
credential is now at rest on the host disk for the life of the session,
in a 0600 file under a 0700 directory, instead of living only in the
proxy's heap. It is the same disk `credentials.json` is on, and the file
is mounted into that session's proxy and nowhere else — but it is one
more place to remember at teardown, and `removeProxyConfig` is what
remembers it.

The rest of §5.3 stands: the proxy answers from memory with no host
round-trip on the hot path, `/mcp/*` is `503` and egress is refused
before any scope is loaded, and the reload latency is one poll (1s;
`SIGHUP` forces it sooner). The poll is a `stat`, not `inotify`, because
inotify events do not cross a Docker Desktop bind mount.

## 6. Networks and the egress policy

### 6.1 One network per session

`gurt-s-<session>`, a user-defined bridge, created with
`--label gurt.session=<session>` — so `docker network ls --filter
label=gurt.session` is the registry for networks exactly as `docker ps
--filter label=gurt.session` is for containers, and the boot reconcile
has something authoritative to converge against.

The proxy additionally sits on **one shared external network**,
`gurt-egress` (label `gurt.managed=1`), created on demand. Shared rather
than per-session on purpose: Docker's default address pool hands out /16s
from `172.17.0.0/12`, ~16–31 networks before allocation fails, and a
second network per session would halve the number of concurrent sessions
a stock daemon supports. The proxies on it are single-purpose processes
that answer only tokens they were pushed, so co-tenancy there buys an
attacker nothing that reaching the internet did not already give them.

### 6.2 The two modes

Chosen at session creation, stored on the session, editable while a draft
and adjustable while running (§5.2):

```ts
// src/shared/types.ts — SessionInfo, AgentSessionRequest
network?: {
  internal?: boolean          // default false
  policy?: DomainPolicy       // default { allow: [] }, i.e. open
}
```

**`internal: false` (default).** `gurt-s-<session>` is a normal bridge.
The container has its own route to the internet; the proxy is there for
MCP and for observability. `HTTP_PROXY`/`HTTPS_PROXY` are set, so
well-behaved tooling is routed and logged — and a process that ignores
them goes straight out. This is **visibility, not enforcement**, and the
UI must say so in those words. Its value is real (it is how a user sees
what a session reaches before deciding to lock it down) and its guarantee
is zero.

**`internal: true`.** `gurt-s-<session>` is created `--internal`: the
daemon installs no route out and no masquerade rule for it. The session
container has exactly one reachable peer, the proxy, and the proxy is the
only egress. `host.docker.internal` stops resolving usefully from the
session container — intended: host-side MCP now goes through the proxy's
`host` upstream (§4.3), which is the only reason that upstream kind
exists.

A drafted session (`create_session`, `requirements-session-roles.md`)
inherits its spawner's `network` and may not loosen it: an agent running
internal cannot draft a session with open egress. The host clamps this
in `assertDraftTarget`, not in the schema — a rule the agent cannot
express is a rule it cannot argue about.

### 6.3 The egress policy: one allow list, three rules

Applies to `CONNECT` and plain-HTTP egress in internal mode (and to the
*logging* of both in default mode). A session has exactly three
network-related controls: the `internal` toggle of §6.2, the built-in
deny list of §6.4, and **one user-editable allow list, empty by
default**:

```ts
type DomainPolicy = { allow: string[] }
```

There is no mode, no `alwaysAllow`, and no offline switch. The effective
behaviour is derived from the list alone, and it is three rules:

1. **Allow list empty** → everything is allowed **except** the built-in
   deny list (§6.4). This is the default, and the place to start: you
   cannot write an allow list for a toolchain you have not watched yet.
2. **Allow list has one or more entries** → **only** the listed
   destinations are allowed. The built-in deny list is **not consulted at
   all** — a user who named a destination has said something more
   specific than any default can.
3. **An allow-listed destination is connected exactly as written**:
   dialled by name through the normal lookup, with **no resolve-and-vet,
   no IP pinning and no deny check**. A user who fears DNS tricks enters
   a literal IP.

An entry is `host` or `host:port`. A bare host covers every port on it;
an entry with a port covers that port only. The host half matches the
host and any subdomain (`example.com` covers `api.example.com`, never
`notexample.com` — the dot is what makes the boundary a label boundary),
with no mid-label wildcards. An IP literal matches exactly; a literal
rule never matches a name and a name rule never matches a literal, since
deciding that would take a reverse lookup — slow, and forgeable by
whoever controls the PTR.

**The tradeoffs, stated rather than hidden.** They are real and the UI
says them in these words:

- Adding one entry to reach a single destination **closes the rest of the
  internet**. There is no "open, plus this one host": that state needs a
  per-session edit of the deny list, which is future work (§6.4).
- An allow-listed host is reached **with no address checks at all**. A
  name on the list that answers with `169.254.169.254` is connected to
  `169.254.169.254`. That is the point — `internal.corp.com` resolving
  into `192.168.x` is the case an entry exists for — and it is why the
  literal-IP escape hatch is documented next to it.
- The policy is a coarse instrument and should be described as one: it is
  evaluated on a host and a port, never on a path (gurt does not
  terminate TLS and so has nothing finer), and allow-listing a CDN
  hostname allow-lists everything that CDN serves.
- DNS still resolves inside the session container in internal mode (via
  the embedded DNS on the user-defined network), but a name the agent can
  resolve is not a name it can reach.

**Rule 1's enforcement machinery is unchanged.** For traffic the list
does not name, and only under rule 1: names are refused by name where
§6.4 names them, then the target is resolved **once**, *every* address it
answered with is checked against the built-in denied ranges, and the
connection is made to the vetted address. Nothing re-resolves in between
— that is the whole of the DNS-rebinding defence.

`sanitizeDomainPolicy` (host) and `policyDecision`/`vetTarget` (proxy)
are pinned to each other on all of this, and an **empty allow list is
open on both sides**. That is a reversal: the earlier three-mode policy
read an empty *allowlist* as deny-all. There is no deny-all state any
more, and `sanitizeDomainPolicy` migrates the old shapes on read — an old
allowlist's `domains` and any mode's `alwaysAllow` become entries, an old
`allow`/`denylist` becomes an empty list, and the custom deny entries of
a denylist are dropped, because §6.4 has nowhere to put them yet.

### 6.4 The built-in deny list

The allow list is a statement about the **internet**. It is not a
statement about the machine gurt is running on, and rule 1 must not be
read as one: an agent that can reach `169.254.169.254`, `127.0.0.1` or
`192.168.1.1` through the proxy has the host's cloud credentials, the
user's other local services, and their LAN.

So under **rule 1**, agent-initiated egress — `CONNECT` and absolute-form
HTTP, and nothing else — is refused to:

- loopback: `127.0.0.0/8`, `0.0.0.0/8`, `::1`, `::`, and the name
  `localhost` (with its RFC 6761 subtree);
- link-local: `169.254.0.0/16` (the cloud metadata service at
  `169.254.169.254`) and `fe80::/10`;
- the docker host: the names `host.docker.internal` and
  `gateway.docker.internal`, and the `host-gateway` address they resolve
  to in the proxy container;
- private ranges: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` and
  `fc00::/7`.

**This list is not user-editable.** It is shown read-only in the network
control, so a user can see what is blocked by default rather than
discovering it as a tool that failed for no stated reason.

**The one way to reach one of these is to name it in the allow list**,
and doing so is rule 2: the session then reaches that destination and
nothing else. That is the cost, it is not hidden, and it is the reason
per-session editing of *this* list is the next thing to build.

> **Future work.** A later task adds per-session editing of the built-in
> deny list (removing an entry, or adding one). Until it lands, a session
> cannot have the open internet *and* access to a built-in-denied target:
> the only lever is the allow list, and using it closes everything else.

**Under rule 1 the check is on the address, and the address is pinned.**
Checking the hostname alone would be theatre: an agent can point a name it
controls at `169.254.169.254`. A target the allow list does not name is
resolved once, *every* address it answered with is vetted, and the
connection is then made to the vetted address — `net.connect` and the
upstream request get the IP, with the original `Host` and SNI preserved.
An IP literal is checked directly, in octets rather than in text, so
`::ffff:169.254.169.254` is the address it is.

Refusals are logged with the rule `builtin-denylist` (and the address,
when a name resolved into one), distinct from `allowlist`: the UI has to
say "gurt refuses this by default, here is the one way to say yes, and
here is what that costs" rather than "edit your allow list", because the
second sentence alone would not work.

**MCP routes are outside all of this.** `/mcp/<token>/<mcpId>` dials only
the exact `host:port` pairs in the scope file, and every one of them is
user-authored — a registry entry is created by a human in the UI and an
agent has no path to create one, so a registry entry *is* an explicit
allow. `host.docker.internal:<published port>` is where a user's own MCP
server usually lives, and the registry does not validate against
internal addresses for that reason. The proxy's own operation is outside
it too: it legitimately reaches the host through `host-gateway`.

## 7. Provisioning

### 7.1 Sequence

`ContainerManager.ensure` / `resolveLaunch`, in order:

1. **Converge to the open network.** If the recorded container exists and
   is attached to `gurt-s-<id>`, disconnect it and connect it to the
   default bridge. (Both operations work on a stopped container; they
   take effect at start.)
2. `devcontainerUp` — unchanged. Image build, features, `onCreate` /
   `updateContent` / `postCreate`, and on a resumed container
   `postStart` / `postAttach`. All with normal internet access, because
   all of them need it.
3. `installAcpAdapter` (`npm install -g` of the adapter packages) and the
   shim install — also on the open network, also because `npm` needs it.
4. **Ensure the network and the proxy**: `gurt-s-<id>` created with the
   session's `internal` flag; `gurt-egress` ensured; the proxy started
   (§4.1) or reused if healthy.
5. **Switch the container.** `docker network disconnect bridge <id>` then
   `docker network connect gurt-s-<id> <id>`. No restart: the daemon
   rewires a live container's interfaces, rewrites `/etc/hosts` and
   points it at the embedded resolver. Sockets open across the switch
   die; nothing of the agent's exists yet, which is the point of doing it
   here. In internal mode the switch is then **re-inspected** and the
   start fails unless the container is on `gurt-s-<id>` and nothing else
   — see §7.2.
6. **Push the scope** (§5.3).
7. `spawnAcpAdapter` with the proxy env (§4.5) and MCP descriptors that
   point at the proxy.

Steps 1 and 5 are the same idempotent converge function run with
different targets — see §7.2.

### 7.2 Reconcile, not assume

Nothing here may assume a fresh start. A session's container is reused
across stop/start (`teardown('stop')` keeps it), the app can be killed
between any two steps, and the daemon can be restarted underneath
everything. So the network step is written as a **converge**:

```
observe:  docker inspect -f '{{json .NetworkSettings.Networks}}' <container>
plan:     connect(desired \ observed) + disconnect(observed \ desired)
apply:    in that order — connect before disconnect, so the container is
          never momentarily off every network
```

with `desired` = `{bridge}` during provisioning and `{gurt-s-<id>}` after
it (default mode keeps `gurt-s-<id>` too — it is a normal bridge; only
internal mode makes the distinction load-bearing). The planner is a pure
function of (observed set, desired set) and is the unit-testable core of
this section (§13.2).

**A converge fails closed, in every direction.** The observe step has
three outcomes, not two: the endpoint list; "the daemon says there is no
such container" (`No such object`, an answer — nothing to converge, and
the step is a no-op); and "the daemon did not answer" (unreachable
socket, mid-restart, timeout). The third is retried briefly and then
**throws**, failing the session start. Folding it into the second is the
one bug this section cannot tolerate: a fresh container is born on the
default bridge and the converge is what moves it off, so an observation
that silently reads as "nothing to do" launches an internal session's
agent with a direct route to the internet — the only failure here that
fails *open*, and one that leaves no trace in the log.

Because that failure is silent by nature, internal mode also asserts the
post-condition: after the switch, one more inspect, and the start fails
unless the container's endpoints are exactly `{gurt-s-<id>}` (exactly,
not a superset — a leftover `bridge` endpoint is the thing being checked
for). It costs one docker call and turns any future converge bug into a
visible startup error instead of an invisible open network.

Same shape for the proxy: a running proxy whose `/control/.../health`
answers is reused and re-pushed; one that is stopped, unhealthy, or
mounted from a stale script path is removed and recreated. A network that
exists with the wrong `internal` flag cannot be edited in place — it is
recreated, which requires disconnecting its endpoints first, which is why
the recreate path lives next to the converge planner and not in `ensure`.

### 7.3 The open-network window — a known, accepted caveat

Steps 2 and 3 above run with **unrestricted egress**, in internal mode as
much as in the default one. That means:

- devcontainer feature installers,
- `onCreateCommand` / `updateContentCommand` / `postCreateCommand` — in
  practice `npm install`, `pip install`, `bundle install`,
- every `postinstall` script every transitive dependency ships,
- and gurt's own `npm install -g` of the ACP adapter,

execute as root or as the remote user, on the network, before any policy
exists. A malicious `postinstall` in a transitive dependency has full
outbound access and a copy of the repo. **This is a supply-chain hole and
internal mode does not close it.**

It is accepted, for now, because the threat model (§2.1) is the agent,
not the setup — and because the alternative is not a smaller window but a
different product: dependency installs need the network, so bounding them
means pre-building images with a build-time policy, vendoring, or an
offline registry mirror. Each is a real option and none is this change.

Two obligations follow, both required:

1. **Say it in the UI.** The session's network settings show, next to the
   internal toggle, that setup runs before the restriction applies.
2. **Log the boundary.** The provisioning log records when the switch
   happens (`network: switched to gurt-s-<id> (internal)`), so a reader
   can see exactly which lines ran open.

## 8. Logging and the UI

The proxy writes one JSONL record per line to stdout — no files, no
rotation, nothing to mount:

```json
{"t":"2026-08-24T10:00:00.000Z","kind":"mcp","id":"linear","up":"api.linear.app","status":200,"ms":142}
{"t":"...","kind":"connect","host":"registry.npmjs.org","port":443,"decision":"allow","ms":31}
{"t":"...","kind":"connect","host":"pastebin.com","port":443,"decision":"deny","rule":"allowlist"}
```

The host attaches to `docker logs -f <proxy>` for the session's lifetime,
parses each line, and:

- forwards it to the app log via `createLogger('proxy')` at DBG for
  allows, INF for denies (hostnames only — never a path, never a header,
  never the token);
- keeps a bounded per-session ring buffer of the recent records;
- emits a bus event so the UI updates live (`proxy.blocked`, alongside
  the existing session events in `src/shared/events.ts`).

The session pane surfaces **blocked attempts** first: a count badge while
any exist, and a list of `host:port`, last-seen time and attempt count,
with a one-click "allow this host" that edits the session's allow list
for its next start (§5.3) — the loop that makes open → observe → allow
list a workflow rather than a guessing game, one restart per round. The
click has to say what it costs, because the first entry closes everything
else (§6.3, rule 2). Allowed traffic is available in the same panel, collapsed.

Never logged, under any mode: request paths, request or response bodies,
headers, the session token, the control token, the injected credential.

## 9. Lifecycle

Created with the session, torn down with it, swept by label like
everything else (`requirements-session-container.md` §2, "Docker is the
registry").

| event | network | proxy |
|---|---|---|
| `ensure` (first start / resume) | ensured, converged | ensured, scope pushed |
| `teardown('stop')` (idle, queue handoff) | kept | scope revoked, container stopped |
| `teardown('remove')` (session deleted) | removed | removed |
| boot `reconcile` | swept if its session is gone | swept if its session is gone |

Details that will bite the implementer:

- Ordering on remove: revoke → remove proxy → disconnect any remaining
  endpoints → `docker network rm`. A network with live endpoints refuses
  to be removed, and the endpoint that outlives everything is usually a
  devcontainer that a failed start left behind.
- Teardown is **record-independent**, like the container sweep it extends:
  ask the daemon (`docker ps -a --filter label=gurt.proxy=<id>`,
  `docker network ls --filter label=gurt.session=<id>`) rather than trust
  the session record, because a start that died between `docker run` and
  the record write leaves resources findable only by label.
- `dockerSessionContainers()` returning `null` (daemon unreachable) keeps
  meaning "could not ask" and must not delete anything — the new network
  and proxy queries adopt the same `null`-vs-`[]` discipline.
- `gurt-egress` is shared, so it is removed only when no proxy remains on
  it — or simply left in place; an empty user-defined network costs one
  subnet and nothing else. Leaving it is the recommended default.
- Stopping the proxy on idle and recreating it on resume is deliberate:
  it costs ~200ms and it guarantees that a resumed session's scope is
  rebuilt from current config rather than inherited from whatever the
  proxy was told before the app restarted.

## 10. Removals

### 10.1 SSH git support — dropped entirely

Not deferred, not "phase 2": removed from the model.

- `CredentialKind` loses `git-ssh-key`, along with its `CRED_KINDS` entry
  and the `SettingsPage.tsx` kind label/fields.
- `git/config.ts` loses `SSH_AGENT_PROXY_BIN`, `SSH_SOCK`, and the
  `git-ssh-key` branch of `rewriteRules`.
- The `gurt-ssh-agent-proxy` shim and the broker's planned ssh-agent TCP
  bridge (`requirements-git-access.md` §4.2, never implemented) go with
  them.
- `BLOCKED_SSH_COMMAND` **stays** — host-side git must still fail loudly
  rather than reach the user's ambient keys.
- Migration: an existing `git-ssh-key` entry resolves as an error
  ("unsupported credential kind — use a token"), never silently. Per the
  credential policy, an unresolvable credential blocks; it does not fall
  back.

Rationale: ssh existed to give the container a second, key-based path to
the forge. The container no longer authenticates to anything, so the path
has no user — and an agent socket bridged into a container is precisely
the kind of ambient authority this change exists to remove.

### 10.2 The container-side git credential broker — removed

`resolveGitBroker` / `stopGitBroker`, `buildServer`, `handleCredential`,
`handleForgeEnv`, and their call sites in `containers.ts` go. With them:

- the `gurt-git-credential` shim and `CRED_HELPER_BIN`,
- `containerGitEnv()` and the `GURT_GIT_BROKER` env var,
- the container-side `gh` wrapper (`forgeWrappers`) and the github-cli
  devcontainer feature injection (`forgeFeatures` in `devcontainerUp`) —
  note that changing `--additional-features` changes the image identity
  and costs one rebuild per env, once,
- `ForgeProvider.wrappers` and `ForgeProvider.features`,
- the `gitAccess` flag on `SessionInfo` / `AgentSessionRequest`, its
  composer toggle, its `create_session` parameter, and the `git` tag in
  `SessionPane.tsx`.

**One correction to the brief.** `src/main/git/broker.ts` holds *two*
services, and only the first is removable:

1. the per-session, container-facing broker (`0.0.0.0`, reached via
   `host.docker.internal`) — removed, as above;
2. `ensureHostCredBroker()` — a loopback-only, process-lifetime singleton
   that answers the **host** git credential helper (`git/shims.ts`
   `ensureHostCredHelper`, wired from `git/env.ts`). Every authenticated
   host git call depends on it, including the github MCP tools that are
   now the *only* authenticated git path.

So (2) survives. Move it to `src/main/git/hostCredBroker.ts` and delete
`broker.ts`, so no file is half-dead and the remaining service's name
says what it is.

What else stays, load-bearing: `credentials.json` and the `git-token` /
`git-app` / `git-host` kinds; save-time verification and stamped commit
identity (§3.2 there); `hostGitAccessForRepo` and the three host modes;
`rewriteRules` + `gitConfigArgs`; `providerForHost` and `forgeEnv` (the
host `gh` in `mcp/githubServer.ts` runs on them); `identity()` at
credential save.

### 10.3 What replaces native git in the container

Nothing, deliberately. Authenticated git is **exclusively** the host-side
github MCP: `git_pull`, `git_push`, `create_pull_request`, running on the
host clone with `hostGitAccessForRepo`'s resolution — reached, now,
through the proxy's `host` upstream (§4.3). The container keeps
unauthenticated local git: status, diff, add, commit, branch, log. That
is what the turn contract asks of an agent anyway (leave the tree
uncommitted, propose a message).

One consequence needs a decision and this doc makes it: `containerGitEnv`
was also what injected `user.name`/`user.email`, so removing it leaves
in-container `git commit` unattributed. Keep an **identity-only**
injection — the two `GIT_CONFIG_*` pairs from the repo's resolved
credential identity (`identityPairs`), no helper, no broker URL, no
secret, no rewrite rules. It needs none of the removed machinery, it is
unconditional (no toggle), and without it a commit an agent does make is
authored by whatever the image happens to contain.

### 10.3.1 As built

Phase 3 landed as written above, with three notes worth recording.

**The container shims went entirely, not just the credential helper.**
§10.2 names `gurt-git-credential` and the `gh` wrapper. `gurt-launch`
went with them: its only job was prepending `/opt/gurt/bin` to the
agent's `PATH` so those two could shadow container binaries, and with an
empty shim dir it was a `docker exec -u root` per container plus a
process in front of every agent, buying nothing. `SHIM_DIR`, `LAUNCH_BIN`,
`installGitShims`, `CONTAINER_SHIMS`, `shimInstallScript` and the
`shimmed` cache in `containers.ts` are all gone; `git/shims.ts` now holds
only the *host* credential helper. `spawnAcpAdapter` no longer wraps the
agent command.

**The identity injection is unconditional and role-blind.** §10.3 asks
for identity-only injection; as built it is on `LaunchContext` for every
session, including a researcher's and a reviewer's. A read-only role's
clone refuses writes at the mount, so the pairs are inert there — but
`user.name`/`user.email` carry no authority, and a rule that has to be
explained ("identity, except for these two roles, because…") is worse
than two inert env vars. `resolveGitAccess` became `resolveGitIdentity`
and takes a repo, not a session.

**`git-ssh-key` resolves as an error, and the editor says so.** Per
§10.1's migration rule, `CredentialKind` no longer includes it and
`CREDENTIAL_KINDS` no longer offers it, but a stored entry still
round-trips through `credentials.json` (the envelope keeps unknown kinds
on purpose) — so `resolveCredential` returns
`unsupported credential kind … replace it with a token credential` for
it, on both the link and the auto-match path, and `hostGitAccess` blocks
on that error like any other. The credentials editor draws such an entry
with its raw kind as the tag and that message in place of the kind hint,
with the type picker and Delete still live, so it can be converted or
removed rather than expanding into an empty card.

One consequence for §13.5: `grep -rn "gitAccess" src` is no longer empty.
It matches `store.ts`'s session migration, which deletes the legacy key
from disk and has to name it to do so. Everything else the acceptance
grep looks for is gone.

### 10.4 `mcp/manager.ts`

The per-(session, mcp id) listener map is replaced by **one host listener
per session**, multiplexing gurt's built-in servers by id
(`/mcp/<hostToken>/github`, `/mcp/<hostToken>/gurt`) and reached only by
that session's proxy. `buildGithubHttpServer` and `buildGurtHttpServer`
keep building handlers; what they stop owning is a listener and a port
each. `gurtServer.ts`'s `ensureGurtServer`/`stopGurtServer` bookkeeping
folds into the same per-session record.

The agent's `AcpHttpMcpServer` descriptors change from
`http://host.docker.internal:<port>/mcp/<uuid>` to
`http://gurt-proxy:8100/mcp/<sessionToken>/<id>` for every server,
built-in and registry alike. `AcpHttpMcpServer` itself is unchanged.

## 11. UI surface

- **Settings → MCP servers** (new section, next to Repos and
  Environments, `SettingsPage.tsx` pattern): list, add/edit
  (id, url, headers as name/value rows, credential select), delete —
  refused while a live session selects it. Built-ins are listed
  read-only, so the picker's two sources are visible in one place.
- **Settings → Credentials**: the `mcp-token` kind, secret masked exactly
  as the others.
- **Composer** (`Sidebar.tsx`): the MCP list gains registry entries
  (on/off; built-ins keep off/read-only/full), and a **network** control
  next to it — `open` / `internal`, the read-only built-in deny list, and
  the editable allow list with its "one entry closes the rest" note.
  There is no mode picker: the allow list being empty or not is the whole
  of the policy (§6.3).
  The `git access` toggle is removed (§10.2).
- **Session pane**: a `net` tag when the session is internal; the blocked
  attempts panel (§8); the setup-window note (§7.3).

## 12. Phases

1. **Registry + proxy + MCP routing, default network only.** Registry in
   `workspace.json`, `mcp-token`, proxy container, session network,
   scope push, all MCP (built-in and registry) routed through the proxy,
   `HTTP_PROXY` set, logging + blocked panel. No internal mode yet —
   nothing is enforced, everything is observed, and the whole MCP path
   moves in one step.
2. **Internal mode.** `--internal` networks, the provisioning switch and
   the converge planner, the egress policy engine, the network control in
   the composer, the setup-window disclosure.
3. **Removals** (done — §10.3.1). SSH kind, container broker + shims +
   wrappers + features, `gitAccess`, `hostCredBroker.ts` split,
   identity-only injection. Last on purpose: it is the step that cannot
   be reverted by toggling a flag, and it should land after the proxy has
   carried real sessions.

## 13. Acceptance

1. A registry MCP server configured with an `mcp-token` credential works
   end to end from an agent, and neither the secret nor the proxy's
   control token appears in the session container's environment,
   `devcontainer exec` argv, the session log, or the app log.
2. `scripts/proxy-policy.test.mjs` (new, pure node): the domain matcher —
   subdomain match, no mid-label wildcards, IP literals exact, name rules
   never match literals — and scope lookup, including 404 for an id not
   in scope and 503 before any scope is pushed.
3. `scripts/network-converge.test.mjs` (new): the converge planner is a
   pure function of (observed, desired), connects before disconnecting,
   is a no-op when already converged, and produces the same plan whether
   the container was fresh, reused, or half-attached after a crash. And,
   against a stub `docker`: an inspect the daemon never answers is
   retried and then throws (never a silent no-op), a container the daemon
   says is gone is a no-op, and the internal-mode post-condition rejects
   a container left on the default bridge.
4. `scripts/smoke-mcp-proxy.mjs` (docker): an internal session reaches
   its MCP servers and the github MCP tools, is refused by an allow list
   for anything else, the refusal appears in the session's blocked list,
   adding the host there unblocks it **without restarting the agent**,
   and a session teardown leaves no `gurt.proxy` container and no
   `gurt.session` network behind.
5. `grep -rn "GURT_GIT_BROKER\|git-ssh-key\|gurt-ssh-agent-proxy\|gitAccess" src`
   returns nothing.
6. The rest of `scripts/*.test.mjs` still passes; `npm run typecheck` and
   `npm run build` are clean.

## 14. Out of scope

A global MCP registry layer that workspaces inherit and override (§3.1 —
the runtime does not change if it lands later). stdio/local-process MCP
servers. Per-tool or per-method policy on an upstream MCP server (gurt
does not know an upstream's tool semantics — §3.3). TLS interception, and
therefore any policy finer than a hostname. Closing the provisioning
window (§7.3) via pre-built images, vendoring or a registry mirror.
Bandwidth or rate limiting at the proxy. Sharing one proxy between
sessions, for any reason. Encrypted credential storage (`safeStorage`),
still, as in `requirements-git-access.md` §11.
