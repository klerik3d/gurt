# Requirements: local (stdio) MCP servers

Status: implemented (phases 1, 2 and 3) · Target: gurt Electron MVP (this repo)

This document is a work order for an implementing agent, and the
as-built record of what landed. Read
`requirements-mcp-proxy.md` first — this is an extension of its registry
(§3.1) and of its routing (§4.3), and it changes neither. Key code:
`src/shared/mcp.ts` (the entry model, the validator, the snippet
parser), `src/main/mcp/stdioBridge.ts` (new), `src/main/mcp/manager.ts`
(the built-in/local split and the refcount), `src/main/mcp/probe.ts`
(new — phase 3, §4.6), `src/main/proxy/config.ts`
(`planProxy`), `src/main/store.ts` (`liftMcpServers`), `src/main/ipc.ts`
(the save-time checks, `reinstallMcpServer` and `probeMcpServer`), and — phase 2 —
`src/renderer/src/components/SettingsPage.tsx` (the kind picker, the
paste field and the per-kind editor), `src/renderer/src/useMcp.ts`
(`useMcpFailures`) and `src/renderer/src/components/tags.tsx`
(`McpFailBanner`).

> **Extends** `requirements-mcp-proxy.md`: §14 no longer lists
> stdio/local-process MCP servers as out of scope, and §2.1's threat
> model grows a second adversary. Nothing else in that document changes
> — in particular `resources/proxy/gurt-proxy.mjs` is not touched by
> this change at all, which is the test that the routing was put in the
> right place (§4.4).

## 1. Motivation

**The registry accepts a transport almost nobody publishes.**
`McpRegistryEntry` (§3.1 of the proxy doc) is a remote http(s) endpoint
and nothing else. But an MCP server, as the ecosystem ships it, is this:

```json
{ "mcpServers": { "kubernetes": { "command": "npx", "args": ["-y", "kubernetes-mcp-server@latest"] } } }
```

A user who finds a server they want has a snippet in their clipboard and
nowhere in gurt to put it. Every README, every registry listing, every
"add to Claude Desktop" button emits this shape. Supporting only the
other one is not a smaller feature set — it is a feature that does not
connect to the world it lives in.

**Some servers need host authorization, which the container does not
have and cannot get.** `kubernetes-mcp-server` reads a kubeconfig whose
credential is minted by `tsh`, on the host, against the user's SSO
session. The same is true of `aws`, of `gcloud`, of anything fronting a
corporate identity provider. Running it in the session container would
mean either shipping that credential into the container — which §2 of
the proxy doc forbids outright — or not running it. Running it on the
host is the only shape in which it works at all, and gurt already has a
place for "a thing that runs on the host and the agent reaches through
the proxy": that is exactly what the `github` built-in is.

So: a local MCP server is a **user-configured built-in**. The runtime
already exists; what is missing is a transport adapter and a lifetime.

## 2. The contract, and what it costs

What stays true, unchanged from `requirements-mcp-proxy.md` §2:

- The session container gets **no secrets**. A local server's
  credential is resolved on the host, into the *host process's*
  environment. It does not appear in the container, in the adapter's
  argv, or in any descriptor.
- The proxy is still the only thing the container talks to. A local
  server is a `host` upstream (§4.4), reached exactly the way `github`
  and `gurt` are.
- Egress policy is unaffected. The bridge listens on the host; the
  proxy reaches it; the container reaches the proxy.

What is **new, and is not a smaller version of something that already
existed**:

> A local MCP entry runs arbitrary third-party code on the user's
> machine, outside any sandbox, with the user's full privileges, and
> hands the agent the ability to drive it.

That is not hedged. A compromised or malicious package installed as an
`npm` entry can read the user's ssh keys, their `~/.aws`, their browser
profile, their kubeconfig and their source tree; it can write anywhere
the user can write; and it reaches the network on the host, where no
session egress policy applies. It gets all of that at install time, from
a `postinstall` script, before a single MCP request is made.

**The compromise, named.** The alternative design — run the local server
inside a container of its own — would have bought a sandbox and lost the
thing the feature is for. A containerized `kubernetes-mcp-server` has no
`tsh` session, no keychain, no SSO cookie; the only way to give it one
is to copy a host credential into a container, which is the exact rule
§2 exists to enforce. So the choice was between "unsandboxed and
useful" and "sandboxed and pointless for the motivating case", and this
document takes the first one, deliberately, and says so where the user
can read it.

**Two obligations follow, both required.**

1. **Say it in the UI, in these words.** Every surface that offers a
   local entry — the settings row, the add/paste dialog, the composer's
   picker — carries the line `Runs on your machine, unsandboxed, with
   your privileges.` It lives in code as `LOCAL_MCP_NOTICE`
   (`src/shared/mcp.ts`) rather than in a component, so the three
   surfaces cannot drift.
2. **Do not let it read as an extension of the container's guarantees.**
   The session container is *still* clean: nothing about a local server
   leaks into it. Saying "gurt sandboxes your agent" and "gurt runs this
   package as you" in the same breath, without marking which is which,
   is how a user ends up believing the wrong one.

### 2.1 The threat model, restated

`requirements-mcp-proxy.md` §2.1 has one adversary — the agent — and
explicitly excludes code that runs *before* the agent (the image build,
the devcontainer features, the project's own dependency install), on the
grounds that those are the user's own supply chain and the container is
what they run in.

A local MCP entry adds a second adversary and it does not fit that
exclusion:

| | proxy doc §2.1 | this document |
|---|---|---|
| adversary | the agent, steerable | the agent **and** the local server's package |
| where it runs | session container | the host, as the user |
| what bounds it | the session network, the egress policy | nothing |
| when it runs | during the turn | from `npm install` onward |
| what it reaches | what the policy allows | everything the user can reach |

The agent's role changes too. Against a remote MCP server the agent can
only send requests the upstream chose to answer. Against a local one it
is driving a process that is *already* inside the trust boundary — so a
prompt-injected agent plus a permissive local server is a strictly
larger capability than either alone.

None of this reaches the container: the contract in §2 of the proxy
document is not violated, because nothing about the bridge — not the
URL, not the token, not the credential, not the process — is visible
from inside the session. The boundary that moves is the *host's*, and
the user is the one who has to decide about it. Hence §2's obligations.

## 3. The model

`McpRegistryEntry` becomes a discriminated union on `kind`
(`src/shared/mcp.ts`):

```ts
type McpRegistryEntry = McpHttpEntry | McpNpmEntry | McpCommandEntry

interface McpHttpEntry {
  kind?: 'http'          // absent means http — see §3.1
  id: string
  label?: string
  url: string
  headers?: { name: string; value: string }[]
  credentialId?: string  // → a request header, unchanged
}

interface McpNpmEntry {
  kind: 'npm'
  id: string
  label?: string
  package: string        // bare name, scope included, never name@version
  version?: string       // a version or a dist-tag
  args?: string[]
  env?: Record<string, string>
  credentialId?: string  // → an environment variable (§3.4)
  credentialEnvVar?: string
}

interface McpCommandEntry {
  kind: 'command'
  id: string
  label?: string
  command: string        // a PATH name or an absolute path
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  credentialId?: string
  credentialEnvVar?: string
}
```

`npm` and `command` are the **local** kinds. Everything downstream
branches on one predicate, `isLocalMcpEntry`, so "local" has exactly one
definition and the routing, the runtime and the UI cannot disagree about
it.

Why two local kinds rather than one. `command` alone would cover
everything — `npm` is `command: 'npx'` with extra steps. But `npx` is
precisely the case gurt should *not* run as written (§4.2), and it is
also the case the entire ecosystem publishes. Making it a first-class
kind is what lets gurt install once instead of resolving `@latest` over
the network on every session start, and lets it run the package with a
node it knows it has. `command` is the escape hatch underneath, for
`uvx`, `docker`, a checked-in script — the things gurt has no installer
for and does not pretend to.

### 3.1 `kind` is optional, and that is the compatibility promise

An entry with no `kind` field **is** an http entry. Not "defaults to",
not "is migrated to" — reads as, everywhere, at every layer:
`mcpEntryKind` returns `'http'`, the store's lift dispatches to the http
schema, the validator runs the http rules, and `normalizeMcpEntry` never
*writes* a `kind` for an http entry, so the canonical on-disk spelling
stays the one every existing `workspace.json` already uses.

The alternative — write `kind: 'http'` into every entry on first read —
would have meant a migration, which means a file rewrite, which means a
user's `workspace.json` changing under them (and in their git history)
for no behavioural reason. There is nothing to migrate: the old shape
is a valid instance of the new type.

An **unknown** kind is a different matter and is dropped, not read as
http. A record saying `kind: 'sse'` is a transport this build does not
have; calling its `url` anyway, or spawning it, would be acting on a
guess about a field whose whole purpose is to remove the guess.

### 3.2 Validation, per kind

`validateMcpEntry` checks the id first — the id is a route segment and a
selection key whatever transport sits behind it, so `ID_RE`, the
reserved ids and the taken ids apply to all three kinds unchanged — and
then branches:

| kind | required | also checked |
|---|---|---|
| `http` | `url` is an absolute http(s) URL with a host | header names (RFC 9110 token), header values (no newline/NUL/control), no duplicate names |
| `npm` | non-empty `package`, no whitespace, no `@version` in it | `version` has no whitespace; `args` is an array of NUL-free strings; `env` names match `[A-Za-z_][A-Za-z0-9_]*` and values are NUL-free strings |
| `command` | non-empty `command` | `cwd` is a string; `args` and `env` as above |

Three of those are worth their reasons:

- **The http(s) check applies only to `http`.** It used to be the one
  URL rule in the file; a local entry has no URL to check, and running
  the check anyway is how a validator ends up rejecting a valid entry
  for missing a field its kind does not have.
- **`package` may not carry its own version.** `pkg@1.2.3` in the
  `package` field would parse fine and then defeat the reinstall check
  (§4.2), which compares the requested `name@version` against what is
  installed. A scope's leading `@` is part of the name and is left
  alone; any later one is a version and belongs in `version`.
- **`args` and `env` are validated at runtime types, not just at
  compile time.** Both reach this function from a hand-edited
  `workspace.json` and from the IPC boundary, neither of which has been
  through a parser that vouched for the shape. NUL is the one character
  `execve` cannot carry, so it is the one that has to be an error rather
  than a surprise.

A `command` entry has one more check that cannot live here, because the
validator is shared with the renderer and the renderer does not know
this machine's PATH — see §4.3.

### 3.3 Modes: still none, and for the same reason

`mcpHasModes` stays `entry.source === 'builtin'`. A local entry gets
off/on, exactly like a remote one.

The temptation is real — gurt spawns the process, so surely it could
restrict it — and it is wrong for the reason §3.3 of the proxy doc
already gives: gurt does not know what an upstream's tools *do*.
Spawning a process does not confer an understanding of its tool
semantics. Offering `read-only` for `kubernetes-mcp-server` would be
gurt claiming an enforcement it has no mechanism for, on a server whose
write tools it cannot name.

What a local server's read-only mode actually is, when it has one, is a
flag: `kubernetes-mcp-server --read-only`. That flag lives in `args`,
where the user put it, and `mcpEntryDetail` renders the full argv in the
picker so the user can see it there. gurt reports it; gurt does not
enforce it, and does not imply that it does.

The probe (§4.6) ends with a real `tools/list`, so gurt does hold an
upstream's tool *names* for as long as a dialog is open. That changes
nothing here: a name is not a semantics, `readOnlyHint` is a hint the
server writes about itself, and a list read once says nothing about
what the server will expose tomorrow. Shown, not enforced.

### 3.4 The credential is an environment variable

An http entry's `credentialId` resolves to a request header, injected by
the proxy (`resolveMcpCredential`, proxy doc §3.2). A local entry has no
requests to put a header on — it is a process reading its own
environment — so its link resolves through `resolveMcpEnvSecret` to the
bare secret, and `credentialEnvVar` says which variable it lands in.
That is the same shape an agent's token already has (`secretEnv` in
`src/shared/agents.ts`), and it is the shape every stdio MCP server
documents itself in.

`credentialEnvVar` is **required whenever `credentialId` is set**. A
header has a sensible default (`Authorization: Bearer …`); an
environment variable does not, and the server's own docs are the only
place the name exists. Resolving a secret and then having nowhere to put
it would be a silent auth failure at first tool call, which is exactly
the failure this rule converts into a rejected save.

Two rules differ from the header path, and both are consequences of the
transport:

- A **newline is legal** in an environment value. The header rule that
  forbids it exists because a newline injects a second header; `execve`
  has no such hazard.
- A **NUL is fatal**, and is the only content check. It truncates the
  environment entry rather than failing, so it has to be caught.

The credential is resolved on the host, at reconcile time, and put into
the child's environment. It is never logged (§7) and never written to
`workspace.json`, which holds the link only — the same split as
everywhere else in gurt.

The resolved secret is also part of the *process* identity (§6): a
credential rotated in the store has to reach a server that already read
its environment, and the only way to do that is a restart.

## 4. The runtime

### 4.1 The bridge

`src/main/mcp/stdioBridge.ts` turns one transport into the other. It
spawns the process, frames JSON-RPC to and from its stdio, and exposes
the result as an HTTP listener of exactly the shape `githubServer.ts`
already produces: `POST /mcp/<token>`, bound `0.0.0.0` so the proxy
container can reach it via `host.docker.internal`, token in the path.

**Framing.** MCP's stdio transport is one JSON-RPC message per line.
`stdioFramer` is the whole of it, and it is a pure function of bytes to
messages — which is why it is tested against two fake streams rather
than a spawned server (§9). Three things it has to get right: a chunk
boundary landing mid-line (carried in `rest`), a chunk boundary landing
mid multi-byte character (carried by a `StringDecoder`, the same way
`lineBuffer` in `provision.ts` does it), and a line that is not a
message at all. That last one is not an edge case: servers that log to
stdout are common, and dropping those lines silently makes a working
server look like a broken one, so they are surfaced as noise at DBG.

**Id remapping.** One process serves every session that selected the
entry (§6), so two clients will both cheerfully send request id `1`.
Every request is renumbered onto a bridge-wide sequence on the way down
and restored on the way back. Without it, one session reads another's
reply — the one bug that would be both silent and severe.

**Responses stream.** A reply is written to the response as it arrives,
not collected first. For a single request that is the same thing; for a
batch it means a call that answers immediately is not held behind one
that takes a minute.

**What it does not do.** `GET` (the server→client SSE stream) answers
405, and a Streamable HTTP client reads that as "this server does not
offer one" and carries on. `DELETE` likewise: there is no per-client
session state to delete, because the state lives in the child. A
server-initiated request (sampling, roots) has no channel to be
delivered on in a stateless POST bridge, so it is dropped and logged at
DBG rather than being silently lost. These are the honest limits of
bridging a stateful stdio session onto stateless POSTs, and they are
listed here so nobody re-discovers them as bugs.

**Crash and restart.** The child is spawned eagerly, so a broken entry
fails at session start where it can be reported, and respawned lazily if
it dies, so one crashing server does not permanently break every session
that selected it. A respawn loses the MCP `initialize` handshake, which
the client redoes on its next call — the same thing that happens when a
remote upstream restarts.

### 4.2 `npm`: gurt installs it, gurt runs it

For `kind: 'npm'` gurt installs the package into `~/.gurt/mcp/<id>/` and
spawns it with **its own** node — `process.execPath` plus
`ELECTRON_RUN_AS_NODE=1` — rather than looking for `npx` on the PATH.

This is one decision that fixes two unrelated problems:

1. **A GUI app's PATH is not the shell's.** On macOS, an app launched
   from Finder or the Dock inherits `launchd`'s environment, not the
   user's login shell's — so `/opt/homebrew/bin` is simply not there,
   and `spawn('npx')` fails with `ENOENT` on a machine where `npx` works
   fine in every terminal. `githubServer.ts` already carries a
   `withHostPath` workaround for exactly this. Not needing `npx` at all
   is better than patching the PATH to find it.
2. **`@latest` is a network call.** `npx -y pkg@latest` re-resolves the
   tag on every invocation, which would mean a network round trip (and a
   possible failure, and a possible *silent version change*) on every
   session start. Installing once and recording what was installed makes
   the version a property of the entry rather than of the moment.

The install is stamped: `~/.gurt/mcp/<id>/gurt-install.json` records the
`name@version` that was installed and the absolute path of the script to
run. A start reinstalls only when the requested spec differs from the
stamp. So `version: 'latest'` means "whatever latest was when I saved
this", pinned from then on; a user who wants a newer one re-saves the
entry, or presses **Reinstall** in its editor (§8), and a user who pins a version gets
a reinstall when they change it and never otherwise.

`npm` itself is still resolved from the PATH — it is the one host tool
this path needs, it is needed once rather than per start, and its
absence produces a clear error naming what gurt was trying to do. That
is the whole remaining exposure of problem 1 on this path.

**The `package` field is a spec, not a name.** `npm install` takes more
than a registry name in that position, and the ecosystem publishes those
too: `npx -y github:user/jenkins-mcp` is a real README line. gurt
accepts them — but npm unpacks such a package under **its own name from
its `package.json`**, not under the spec it was installed with, so
`github:user/jenkins-mcp` lands in `node_modules/jenkins-mcp`. Deriving
the name from the spec produced the worst kind of failure: the install
succeeded and gurt then reported that the package it had just installed
did not exist.

So the name is read from npm's own record of the install — the
`dependencies` entry npm writes into the `package.json` gurt keeps in
that directory (`installedName`), which is exactly the
name→spec mapping, straight from the tool that chose it. Three smaller
consequences of the same distinction, all in `shared/mcp.ts` behind
`isPlainPackageName`: a spec is never split on its `@`
(`git+ssh://git@host/repo.git` is not a package called `git+ssh://git`),
the "no version in the name" rule does not apply to it, and a `version`
field *beside* such a spec is rejected — the ref rides in the spec, and
composing `github:user/repo@1.0` would ask npm for something it cannot
resolve.

The bin to run comes from the installed package's `bin` field: a string
is unambiguous, an object is resolved to the entry named after the
package, or to the single entry if there is exactly one. More than one
and gurt does not guess — it says so and points at `command`, where the
user picks. The resolved path is `realpath`'d and handed to node
directly rather than executed, because the shebang in it says
`#!/usr/bin/env node`, which is problem 1 all over again.

### 4.3 `command`: the escape hatch, and where PATH still bites

`kind: 'command'` runs what the user wrote. gurt has no installer for
`uvx`, `docker` or a checked-in script and does not pretend to.

The PATH problem is therefore still here, and is handled by moving the
failure: `resolveHostCommand` searches the user's PATH plus the
directories a GUI launch loses (`/opt/homebrew/bin`, `/usr/local/bin`,
`~/.local/bin`, `~/.cargo/bin`, `/usr/bin`, `/bin`), and it is called
**when the entry is saved**, from `ipc.ts`, not when a session starts.

That is the whole of the design here. "spawn uvx ENOENT" an hour later,
in a log the user has no reason to open, on a session that seemed to
start fine, is a bad failure. `command "uvx" was not found on this
machine — install it, or give the absolute path to it`, in the dialog,
at the moment the user typed it, is a good one. The same resolver runs
at spawn time too, so a tool uninstalled after the fact still fails with
the same sentence.

A name containing `/` is treated as a path and only checked for
existence; a bare name is searched. The user's own PATH always comes
first — the extra directories are appended, never prepended, so gurt
never shadows a tool the user deliberately put earlier.

### 4.4 Routing: a `host` upstream, and a proxy script that does not change

A local entry goes into the scope as `hostUpstream(id)`, i.e.
`{ kind: 'host', url: <the bridge's URL> }` — not as `registryUpstream`.
`ProxyPlanInput.hostMcpUrls` already exists for exactly this shape (one
URL per id, each carrying its own token), so the bridge's URL goes in
next to the built-ins' and `planProxy` needs one branch:

```
builtin              → hostUpstream(id)
registry, local      → hostUpstream(id, local: true)
registry, http       → registryUpstream(entry)
```

**`resources/proxy/gurt-proxy.mjs` is not modified by one line.** That
is the acceptance criterion for this section, not a nice property: the
proxy already knows how to forward to a `host` upstream, because that is
how `github` and `gurt` are reached. If the routing had needed the proxy
to learn something, the routing would have been in the wrong place.

One difference from a built-in: a local entry has **no `hostMcpUrl`
fallback**. Built-ins may hang off one shared per-session listener by
id (`<base>/<id>`, §10.4 of the proxy doc); a bridge is its own listener
with its own token, so deriving a path from the shared base would
produce a live-looking URL that answers 404. An absent
`hostMcpUrls[id]` for a local entry means "the process is not running",
and it is reported as that, in the session log, with the reason in the
app log.

**A free consequence, worth stating.** In `internal: true` mode a local
MCP server works — not by accident, but because the host upstream is the
*only* path that works there. `host.docker.internal` stops resolving
usefully from the session container in internal mode (§6.2 of the proxy
doc), which is the whole reason the `host` upstream kind exists; a local
server inherits that path for free. So the most locked-down session
gurt can create is also one that can reach a `tsh`-authenticated
Kubernetes cluster through a host process — which is a fair summary of
what this feature is for.

### 4.5 What is not in the container

Unchanged, and worth being explicit about because a process on the host
sounds like it should be: the session container sees a
`http://gurt-proxy:8100/mcp/<sessionToken>/<id>` URL and nothing else.
It does not learn the bridge's port, its token, the package name, the
command, the argv or the environment. The bridge's URL exists in the
proxy's config file (0600, mounted only into the proxy) and in main's
memory.

### 4.6 The probe: start it and see

Everything above §4.5 fails at *session start*. The save path checks two
things — that a credential link resolves (`checkMcpEntryCredential`) and
that a `command` exists on this machine (`checkMcpCommand`) — and every
other way a local entry can be wrong is learned an hour later, from a
banner in a session pane: an `npm install` that fails, a package with no
bin, a process that dies for want of an authorization it never had, a
`credentialEnvVar` the server does not read, argv mangled out of a
pasted snippet.

The comment §4.3 already states the principle — *"the failure it
produces at session start, an hour later, in a log, is exactly the one
worth moving to the moment the entry is saved"* — and implements it for
one case out of that list. The probe finishes the job for the rest, by
the only means that can find them: running the thing.

`probeMcpServer(entry)` (`src/main/mcp/probe.ts`) takes an entry and
answers "did it come up, and what does it offer":

- a **local** entry is installed if it is not installed
  (`ensureNpmPackage`), spawned on its own `StdioBridge`
  (`startStdioBridge`), sent `initialize` and then `tools/list`, and
  stopped;
- an **http** entry is sent `initialize` with the headers `planProxy`
  would send it — its static ones plus its resolved credential, the
  credential winning a name collision, exactly as in §3.2 of the proxy
  doc.

Four properties, and they are the design:

1. **Outside the refcount.** The probe starts its own one-shot bridge.
   It never enters `localBridges` and never becomes a `LocalMcpHolder`,
   so a session holding the same entry keeps the process it already has,
   and the probe's process cannot outlive the call. §6's invariant — the
   refcount is a function of the live sessions, computed and never
   stored — is untouched by a probe, which is the point of not routing
   it through the manager.
2. **Bounded, and it kills what it started.** One budget covers install,
   spawn, handshake and tool list; `stop()` (SIGTERM → grace → SIGKILL,
   idempotent) runs in a `finally` on every path. A server sitting on an
   interactive `tsh`/`gcloud` login never answers, and a dialog waiting
   on it forever is worse than no button at all. A timeout during an
   install needed one fix underneath: `spawnChild` now refuses to spawn
   after a stop, so an `npm install` that finishes *after* the probe gave
   up does not leave a server nothing is holding.
3. **It answers, it does not throw.** Every outcome is an
   `McpProbeResult` with a sentence written for a person. The entry
   arrives over IPC from a form and may be nonsense, so it is normalized
   and validated (`validateMcpEntry`, no `takenIds` — a probe is not a
   save) before anything is spawned.
4. **The secret does not come back.** The credential resolves through
   the same `credentialEnv` a session start uses, into the child's
   environment. Nothing on the result and nothing in the log
   (`mcp.probe`: `id`, `kind`, `ok`, a tool *count*) comes from there.

**It installs into the real place.** An `npm` entry's probe runs
`ensureNpmPackage` against `~/.gurt/mcp/<id>/`, not a scratch copy: the
point is to test what a session will actually run, and the side effect —
a warm install, so the first session start is fast — is the one worth
having. The cost is that probing an *edited* npm entry before saving it
rewrites that id's install stamp; the next session start sees a spec
that no longer matches and reinstalls, which is the same
self-correction §4.2 already relies on.

**The verdict is one sentence; the launch is a transcript.** A single
line ("the local MCP server exited") is the same thing the session
pane's banner already said, and it is not what a person needs next. So
the probe also returns the launch itself, in order: what was installed
and under which name, the argv it spawned, the working directory, the
*names* the environment gained, every line the process wrote to stdout
and stderr, each MCP call and its answer, and how the process ended —
each stamped with milliseconds since the probe began, because "what
preceded what" is the actual question. `StdioTrace` is the seam
(`stdioBridge.ts`); pass no trace and nothing about that module changes,
which is what the session path does.

This is the one piece of the feature that is otherwise **unobtainable**
in a shipped build. The child's output is logged as `mcp.out` at DBG,
and `logLevel` is `info` outside dev — so today a user would have to set
`GURT_LOG=debug` and relaunch to see why their server died, which is
also the moment the entry they were editing is gone.

Three rules hold it in place:

- **It is displayed, not logged.** The process's output is a third
  party's, not gurt's record of anything: it goes to the person who
  pressed the button and to no file of gurt's. `mcp.probe` keeps saying
  `id`, `kind`, `ok`, a tool *count* and a duration, and the pre-existing
  DBG `mcp.out` lines are unchanged. Closing the dialog is the end of
  it, which is why the UI offers **copy**.
- **Names, never values.** Both directions: the environment contributes
  the names a launch added (`KUBECONFIG`, `LINEAR_API_KEY`), which is the
  whole content of "the server does not read the variable you named"
  (§3.4), and an `http` probe contributes its header names. No value
  from either appears, exactly as §7 requires of the log.
- **Bounded, and honest about it.** Head plus rolling tail: the head
  holds the launch (the argv is in it, and nothing else has it), the tail
  holds whatever the process was saying when it stopped. What the cap
  drops is stated in place, as a line, so a gap never reads as silence.
  Every line goes through the app log's `sanitize()` even though none of
  it reaches a log — ANSI out, stored credential secrets out in each of
  their encodings — because the redactor is the only thing that knows
  what a secret looks like. A token a server mints and prints itself is
  not something gurt can recognise, and the UI says whose output this is.

**Only on a button, never on save.** A local entry runs third-party code
on the host with the user's privileges, and a `postinstall` script gets
that before the first MCP request is made (§2). "I typed a package name"
must not silently mean "I ran it". So the probe is an explicit action,
on the same screen as `LOCAL_MCP_NOTICE`, taken by a user who has read
it — and the save path stays static-only.

**The tool list unlocks nothing.** It is tempting: gurt now has the tool
names, so surely `read-only` could be offered for a registry entry. No,
for the reason §3.3 gives and one more. A name does not say whether the
tool writes; `readOnlyHint` is a hint the server writes about itself,
optional and unverifiable; and a list read once in a dialog says nothing
about what the server will expose to a session tomorrow. `mcpHasModes`
stays `source === 'builtin'`. The list is there to be *read* — "is this
the server I meant" — not to be enforced against.

**The probe's network position is not the session's**, and the UI says
so. Main dials an `http` entry from the host; a session reaches it
through its proxy, from the container. A green probe therefore proves
the URL, the headers and the credential, and does not prove the session
can get there — the caveat is one line next to the result rather than
something the user is left to discover. (A local entry has no such gap:
the probe runs the process exactly where a session's bridge would.)

The `http` probe stops at the handshake. A stateful Streamable HTTP
server hands back an `Mcp-Session-Id` that every later call must carry,
and a probe that got that wrong would report "no tools" about a healthy
server — a worse answer than no list at all.

## 5. Pasting a snippet

`parseMcpSnippet` (`src/shared/mcp.ts`) is a pure function from a
published snippet to a registry entry. It is in `shared/` and has no
`node:` imports, so the editor's paste field calls it directly on paste
and the tests exercise it without a UI at all.

It accepts, in the shapes the ecosystem actually ships:

- `{"mcpServers": {"<id>": {…}}}` — Claude Desktop, Cursor, most READMEs
- `{"servers": {"<id>": {…}}}` — VS Code's `mcp.json`
- `{"<id>": {…}}` — the inner object on its own
- `{"command": …}` / `{"url": …}` — one body with no id, in which case
  the id is derived from the package, the command or the URL's host

and maps a body to a kind:

| body | kind |
|---|---|
| has `url` | `http`, with `headers` lifted from the object form to name/value rows |
| `command` is npx, and the package is readable | `npm` |
| anything else with `command` | `command`, verbatim |

The npx reading is the interesting one, because it is where a wrong
answer would install and run the wrong software. Leading valueless
flags (`-y`, `--yes`, `-q`, …) are dropped; the next argument is the
package spec; everything after it is `args`. `pkg@1.2` splits into
`package` + `version`; a bare `pkg` has no version; a scoped
`@scope/pkg@1.2` splits on the *last* `@`, so the scope survives. If the
next argument is a flag gurt does not recognise — `npx -p thing -c
'...'` — it does **not** guess: it returns an error naming the problem
and pointing at `command`, which runs the invocation exactly as written.

Every parse ends by running the entry through `validateMcpEntry`, so a
snippet that parses but cannot be saved (a reserved id, an `ftp://` URL)
fails at the paste rather than one click later.

A spec that is not a plain name (`github:user/jenkins-mcp`, `git+ssh://…`,
`file:../x`) parses to an `npm` entry the same way — npm installs it, and
§4.2 reads back the name it chose. Only the *id* is derived differently:
from the spec's last path segment (`jenkins-mcp`), because squeezing the
whole spec would offer `github-user-jenkins-mcp` as the name of the
server.

Ids are squeezed into shape rather than rejected: `"Kubernetes MCP"`
becomes `kubernetes-mcp`, `@scope/pkg` becomes `scope-pkg`. A snippet
naming more than one server is an error rather than a silent first-wins
— they have separate ids, separate credentials and separate trust
decisions, and batching that into one paste hides all three.

`env` rides through verbatim. That is the right call for a parser and
the wrong resting place for a secret: a snippet's `env` is where
READMEs put `"GITHUB_TOKEN": "<your token>"`, and `workspace.json` is a
plain file meant to be shared and committed. Moving such a value to a
credential link is the *editor's* job (§8), not something this function
should do silently: `looksLikeSecretEnv` marks the pair, the editor lifts
it out of the entry and the save turns it into an `mcp-token` credential
linked by `credentialId` + `credentialEnvVar`. A placeholder
(`<your token>`, `YOUR_API_KEY_HERE`) is explicitly not a secret — there
is nothing to store, and storing it would be worse than leaving it.

The paste is also where the probe (§4.6) earns its place. A user pasting
six lines from a README cannot see what gurt read out of them — that an
`npx -y pkg@latest --read-only` became an `npm` entry with the flag in
`args`, that the `env` token was lifted into a credential, that the
package really ships the bin it is about to be run through. **Test**
runs exactly what the form now holds and shows what the server answers,
which closes that loop at the moment it is open. A probe of an unsaved
entry is the *main* case, not an afterthought: it is why the IPC method
takes a whole entry rather than an id, and why a lifted-but-unsaved
secret is put back inline for the probe's environment (there is no
credential to link to until Save).

## 6. Lifecycle: one process per entry, refcounted from the live sessions

**One process per registry entry, shared by every session that selected
it** — not one per session. Three sessions with `kubernetes` selected
talk to one `kubernetes-mcp-server`.

Per session would have been simpler and is wrong here. These processes
are heavy (a kubeconfig, a cluster connection, a warm cache), they are
not scoped to a clone the way `github` is — a local server knows nothing
about the session's repo — and the user's mental model is "I configured
a server", not "each session gets its own copy of my server". The cost
of sharing is that request ids collide, which §4.1 handles, and that
one server's crash affects several sessions, which the lazy respawn
handles.

**The refcount is never stored.** It is recomputed, from the set of live
sessions and their selections, on every change — `localMcpWants` is a
pure function of (holders, registries) and is the whole of the lifetime
decision: a key in its output must have a process, a key absent from it
must not. This is `requirements-mcp-proxy.md` §7.2 ("reconcile, not
assume") applied to processes instead of networks, and for the same
reason: a count on disk is a claim nothing can be checked against, and
it is wrong after exactly one crash. Recomputing survives a gurt
restart, a killed session and a hand-edited registry, because there is
no remembered number to be stale.

The reconcile:

```
observe:  the live holders (session → selected ids), each workspace's registry
plan:     wants = localMcpWants(holders, registries)
apply:    stop  every running key not wanted, or whose process identity changed
          start every wanted key not running
```

Stops run before starts, so an entry edited in place never holds two
processes open at once.

**Process identity** (`localMcpSpec`) is every field that would have
made gurt spawn something else — package, version, command, cwd, args,
env, the credential env var — plus the *resolved secret*. A relabelled
entry does not restart. A re-pointed or re-credentialled one does,
because a stdio server reads its environment once and a rotated
credential reaches it no other way.

Reconciles are serialized behind one promise: they start and stop
processes, and two overlapping passes would each act on the other's
half-finished work.

Where it hooks in:

| event | what happens |
|---|---|
| session start / resume | `resolveMcpServers` records the session's holds, reconciles, returns descriptors for the bridges that came up |
| session detach / delete | `stopMcpServers` drops the session's holds and reconciles — the last release stops the process |
| registry edit | takes effect at the next session start, like every other scope change (proxy doc §5.3) |
| app quit | `stopLocalMcpServers` from `before-quit`, **synchronously** — that hook cannot await, and a promise scheduled in it is not reliably given a turn before the process exits. An orphaned server holding a `tsh` session is not something a user would think to go looking for |

**Failures do not fail the session.** A server whose package will not
install, whose command is gone or whose credential does not resolve is
logged (`mcp.fail`, with the reason) and left out. The session starts
without it, and `planProxy` reports the id in the session's
provisioning log as unroutable. The alternative — failing the whole
start on a transient `npm install` blip — trades a degraded session for
no session.

## 7. Logging

The existing rule holds and is the one that matters: **the port, never
the URL.** A bridge's URL carries its token, so `mcp.start` /
`mcp.listen` / `mcp.stop` record `id`, `kind` and `port`, and the URL
appears in no record at any level.

Added, because "which of my servers is this" is unanswerable from an id
alone once packages are involved: `command` (the resolved command or the
package spec) on start, `package` on install.

**The environment is never logged.** Not at DBG, not on failure, not in
an error message. It is where the credential lands (§3.4), and a stdio
server printing its own configuration to stderr is not hypothetical.
The child's stdout and stderr are line-framed and logged at DBG as
`mcp.out` — they go through the app log's redactor like everything else,
and credential secrets are already registered with it
(`addSecrets` in `main/credentials.ts`), but the environment itself is
simply never passed to a logger.

The probe's transcript (§4.6) does not change any of this, and is worth
naming here because it looks like it should. It is not a log: it is the
third-party process's own output, handed to the person who started it and
written to no file. The log's share of a probe stays one `mcp.probe`
record — `id`, `kind`, `ok`, a tool *count*, `ms` — and the child's lines
keep going to `mcp.out` at DBG exactly as before.

New slugs, for `docs/logging.md`'s dictionary:

| slug | level | context |
|---|---|---|
| `mcp.listen` | INF | `id`, `kind`, `port` |
| `mcp.install` | INF | `id`, `package` (the `name@version` being installed) |
| `mcp.exit` | WRN | `id`, `command`, `code`, `signal` — the child died and gurt did not ask it to |
| `mcp.fail` | ERR | `id`, `kind`, `err` — could not start; the session log says the id is unroutable, this says why |
| `mcp.out` | DBG | `id`, `stream`, `line` — the child's own output |
| `mcp.drop` | DBG | `id`, `method` — a server-initiated message the bridge has no channel for (§4.1) |
| `mcp.probe` | INF | `id`, `kind`, `ok`, `tools` (a *count*), `err`, `ms` — a user asked "does this start?" (§4.6). Never the tool names, never the environment |

`mcp.start` and `mcp.stop` keep their existing shape and gain
`kind`/`command`.

## 8. Phases

1. **Model, runtime, routing** (done — this document). The union, the
   validator, the snippet parser, the bridge, the refcount, the `host`
   upstream. An entry is created by editing `workspace.json` and works
   end to end from there: selected in the composer, spawned on start,
   reached by the agent through the proxy.
2. **UI** (done). `SettingsPage.tsx` no longer shows a local entry
   read-only: `+ Add` is a choice of the three kinds, and
   `McpServerModal` branches on `kind` — url + headers for `http`,
   package + version for `npm`, command + cwd for `command`, argv and
   `env` rows for both local kinds, and a credential that resolves into
   a named environment variable rather than a header (§3.4).

   What the phase is *for* is the paste field: a textarea calling
   `parseMcpSnippet` on paste and spreading the result across the form —
   kind, id, package/version, argv, env — so the six lines in a README
   become a saved entry without a field being retyped. A `uvx` or
   `docker` snippet switches the form to `command` instead of being
   refused. The parser's error is already a sentence written for a
   person, so it is shown verbatim.

   The rest of the phase, in one list: `LOCAL_MCP_NOTICE` as visible text
   (not only a tooltip) on the settings row, in the editor and in the
   composer's picker, per §2's first obligation; a **Reinstall** button
   for an `npm` entry (`reinstallMcpServer` → `clearNpmInstall`, which
   drops the stamp so the next start resolves the spec again — §4.2);
   `mcp.fail` carried off the host process as a bus event
   (`mcp/manager.ts` → `onMcpFailures` → `bus` → `mcp-fail` → the session
   pane's banner) so a process that would not start says *why* where the
   user is working, carrying the reason and never the environment (§7);
   and a pasted `env` value that looks like a secret lifted out of the
   entry by default (`looksLikeSecretEnv`) into a credential the save
   creates, rather than resting in `workspace.json` (§5).

   Two things this phase deliberately did **not** grow. There is still no
   read-only mode for a registry entry — `mcpHasModes` stays
   `source === 'builtin'` for the reason in §3.3, and a local server's
   own read-only flag is rendered as part of the argv where the user put
   it. And `resources/proxy/gurt-proxy.mjs` and `stdioBridge.ts`'s
   routing are untouched: this phase is a renderer phase, plus the one
   IPC method and the one event that a renderer cannot invent for
   itself.

3. **The probe** (done). One IPC method (`probeMcpServer`), one main
   module (`mcp/probe.ts`) and one button — **Test**, next to Reinstall
   in the MCP editor — that starts the entry as it currently stands,
   completes the MCP handshake, lists what the server offers and stops
   it again (§4.6). Its states are idle, running, up (with the tool list
   and, for an `http` entry, the line saying gurt checked it from the
   host while a session goes through its proxy) and failed, with the
   reason. Nothing runs on save, and the tool list unlocks no mode.

   Under the one-line verdict, the **launch log**: the install, the argv,
   the process's own stdout/stderr, the MCP calls and how it ended, on one
   clock, collapsible, copyable, and displayed rather than logged (§4.6).

   Two changes underneath the renderer. `spawnChild` refuses to spawn
   after a `stop()`, so a probe that times out during an `npm install`
   cannot be handed a process afterwards — the same latent leak existed
   on the session path, where a reconcile can stop a bridge whose install
   is still running. And `ensureNpmPackage` reads back the name npm
   installed under instead of assuming it is the spec (§4.2), which is
   what makes `npx -y github:user/thing-mcp` — a shape the ecosystem
   really publishes — work at all: it used to install correctly and then
   fail to be found.

## 9. Acceptance

1. `npm run lint`, `npm run typecheck`, `npm test` are clean, and no
   pre-existing test was changed to accommodate this work: a red one
   would have been a compatibility bug, not a stale test.
2. `scripts/mcp-stdio.test.mjs` (new, pure node) covers, in order:
   the snippet parser (npx with and without `-y`, `pkg@version` and a
   bare `pkg`, a scoped package, uvx/docker → `command`, both wrappers,
   a bare body, an unreadable npx invocation and every shape of garbage
   → a sentence); the validator per kind; backwards compatibility (a
   `kind`-less entry reads as http, everywhere, and a pre-existing
   `workspace.json` round-trips without gaining a field); routing in
   `planProxy` (local → `kind: 'host'`, remote → `kind: 'registry'`,
   unknown id → the error it always was, no `hostMcpUrl` fallback for a
   local entry); the refcount computed from live sessions; the JSON-RPC
   framing, against two fake streams; and the bridge end to end against
   a five-line echo server, which is where the id remapping is proven.

   For the probe (§4.6), against real child processes: a server that
   answers `initialize` and a non-empty `tools/list`; one that exits the
   moment it is spawned; one that never answers *and* ignores SIGTERM,
   which only passes if the budget fires and the teardown escalates to
   SIGKILL; a command that is not installed; and a nonsense entry, which
   must be an answer rather than a throw. Every one of those ends by
   reading the server's own pidfile and asserting the process is gone —
   "the probe leaves nothing running" is checked against the process
   table, not inferred. The http half runs against a local listener that
   demands a header, so both the composed headers and a quoted 401 are
   covered. The transcript has its own: the dying server's last stderr
   line is in it, the launch's argv is in it, the injected variable's
   *name* is in it and its value is not, and a server that writes 800
   lines is capped with the cut named in place.

   For the spec/name distinction (§4.2): `isPlainPackageName` and
   `splitPackageSpec` over `github:`, `git+ssh://` and `file:` specs; the
   validator accepting a spec and refusing a `version` beside it; the npx
   snippet for a repo taking its id from the repo's own tail; and
   `installedName` against npm's record, its fallbacks included.
3. `git diff --stat resources/proxy/gurt-proxy.mjs` is empty (§4.4).
4. A `kubernetes-mcp-server` entry, configured with a host `tsh`
   session, answers the agent's tool calls from inside an `internal:
   true` session — the motivating case, end to end (§4.4).

## 10. Out of scope

Sandboxing the local process (§2 — the whole point is host
authorization, and every sandbox worth the name takes it away).
Per-tool policy on a local server, for the same reason it is out of
scope for a remote one (§3.3). Installing anything but npm packages —
`pip`/`uv`/`cargo` entries are `command` entries. A shared, cross-session
*view* of a local server's logs. Auto-updating an `npm` entry on a
schedule, or notifying about a newer `latest` (§4.2 — the pin is the
feature). Restarting a local server without restarting the sessions that
hold it. Windows: `resolveHostCommand` does not consult `PATHEXT`,
because gurt does not run there.
