# Requirements: the operator session and the admin MCP surface

Status: phase 1 implemented (as-built notes in §16) · phases 2–4 pending ·
Target: gurt Electron MVP (this repo)

This document is a work order for an implementing agent. Read
`requirements-session-roles.md` first (the role model this extends —
this is a fourth role, and everything §2/§4/§5 says about mounts, locks
and per-role tool sets is the mechanism reused here), then
`requirements-mcp-proxy.md` §2.1 and `requirements-mcp-stdio.md` §2.1
(the adversary list this extends with a third entry), and
`src/shared/api.ts` (the surface this is *derived from*, not a parallel
one).

Key code: `src/shared/api.ts` (`GurtApi`, `METHODS`, `API_METHODS` — the
exposure annotation lands here), `src/shared/types.ts` (`SessionRole` and
the role predicates), `src/main/sessions.ts` (the start gates, the
`repos[0]` assumptions, `onPermission`), `src/main/mcp/gurtServer.ts`
(the per-role tool set the admin tools join), `src/main/mcp/probe.ts`
(`mcp.probe`, already built), `src/main/provision.ts`
(`materializeEnvConfig`, `devcontainerUp` and the `mounts` merge the deny
list protects), `src/main/store.ts` (`~/.gurt` layout, `editWorkspace`'s
`chained()` — where the journal hooks in), `src/main/log.ts`
(`addSecrets`/`redact` — the scrub filter already exists),
`src/main/proxy/config.ts` (`planProxy`, where the per-tool allowlist is
planned), `resources/proxy/gurt-proxy.mjs` (where it is enforced).

> **Extends** `requirements-session-roles.md` §2: a fourth role joins the
> table, and it is the first one for which "no repository" is a legal
> state at start rather than an error. Nothing about executor, researcher
> or reviewer changes.

> **Revises** `requirements-mcp-proxy.md` §14, which lists "per-tool or
> per-method policy on an upstream MCP server" as out of scope. §9 below
> takes it — narrowly. The reasoning of that document's §3.3 stands
> unchanged: gurt still does not claim to know an upstream's tool
> *semantics*, which is why this is an allowlist of names the user typed
> and not a `mode`.

## 1. Motivation

**Configuring gurt is the part of gurt nobody helps you with.** A
workspace is repos, envs, an MCP registry, skills, credentials, agent
instances, defaults — each a form in Settings, each with failure modes
that surface hours later as a container that will not build, a clone that
will not authenticate, an MCP server that answers 401. The user debugs
that by reading a provisioning log in a pane, guessing at a devcontainer
field, and trying again. Every other kind of work in gurt has an agent
doing it; this one has the user doing data entry against a system whose
error messages were written for the person who wrote it.

**So: a session whose subject is gurt itself.** The user says "this env
won't build", "add the linear MCP server", "why did that session's
network block npm" — and an agent reads the configuration, changes it,
provisions it to check, reads the log, and fixes it. That is the "soft
entry": the way into gurt is a conversation, not a tour of Settings.

This is a different shape from every existing role, and the difference is
the whole design problem. An executor is bounded by a container and a
clone; the worst it does is write bad code into a working tree the user
reviews. An operator's subject *is* the boundary — the envs that become
containers, the registry entries that become host processes, the
credentials that authenticate them. An agent that edits the sandbox is
not inside it.

The rest of this document is that problem, taken seriously: the surface
is derived from the one the UI uses so it cannot grow a shadow; the
fields through which a config write causes host execution are held back
from every write and released only through a confirmation the agent
cannot perform or phrase; credential values never cross the boundary in
either direction; and every mutation lands in a git journal, because the
one thing certain about an agent that configures the system is that some
day it will be confidently wrong about it.

## 2. The operator role

### 2.1 The role, in the table of `requirements-session-roles.md` §2

| role       | mounts     | clone lock | `complete` | `create_session` | multi-repo |
| ---------- | ---------- | ---------- | ---------- | ---------------- | ---------- |
| executor   | read-write | holds      | yes        | no               | no         |
| researcher | read-only  | none       | no         | yes              | only role allowed |
| reviewer   | read-write (stopgap) | holds | no | yes (fixer only) | no |
| **operator** | **none — no repos at all** | **none** | **no** | **no (§2.4)** | **n/a: exactly zero** |

**Zero repos is the definition, not a default.** A researcher holds N
repos read-only; the operator is that generalization taken to N = 0. It
mounts nothing, clones nothing, locks nothing, and therefore blocks
nobody and is blocked by nobody — it can always run, which matters for a
session whose job is to fix the reason the other sessions cannot.

`assertRoleFitsRepos` gains the operator case: exactly zero, enforced at
every entrance the other roles' rule is enforced at (create, draft edit,
and `create_session` — where the role is not offered at all, §2.4).

**Repo-less start is new plumbing, not a flag.** Today three gates and
one guard assume a repo, and they are correct for every existing role:
`SessionManager.create` refuses `run`/`queue` with no repos, `run()` and
`enqueue()` refuse it again, `startNow` refuses it once more at the one
funnel every start path goes through, and `ContainerManager` throws
`session has no repository` when the clone list yields no build anchor.
All four go through one new predicate beside the existing four —
`roleNeedsRepo(role)` — for the reason `requirements-session-roles.md` §8
gives for `sessionRole()`: the role is read through a function, never off
the field, so the table above is the whole of the behaviour in code.

Three consequences of the anchor being absent, each of which is phase-1
work rather than an accident to discover during provisioning:

- **The env must be image-only.** `materializeEnvConfig` short-circuits
  for a config with no `build` section (it writes the override config and
  returns); the build branch needs a clone to `git archive` and a commit
  to tag the image with. A repo-less session has neither, so an env with
  a `build` section is not merely unsupported for an operator — it is
  unreachable. It is refused at start with that sentence, not at the
  anchor guard with `session has no repository`.
- **`--workspace-folder` is the session's own scratch directory**, empty:
  `usesRepoMounts` answers true for an operator (zero repos is the
  mounted case, not the plain single-repo one), so the wrapper mechanism
  that already exists stages a directory with no mounts in it, and
  `remoteRoot` derives from that directory's basename rather than from a
  repo name.
- **Skills still work.** `usesSkillMounts` is independent of repos, so an
  operator that selected a skill gets the read-only skills bind and the
  merged per-session config exactly as any other session does
  (`requirements-skills.md` §5).

Everything else follows from the existing read-only-role machinery: no
git broker (there is no clone to access), no `complete` and therefore no
nudge (`postTurnDecision` with `hasContract: false`), no proposal, no
lock lifetime to manage.

### 2.2 The bundled default env

The operator ships with an environment. This is not a convenience — it is
what makes §10's bootstrap sufficient: a user with one agent token and one
workspace has no env yet, and the agent that would help them write one has
to run *somewhere*.

Decisions:

- **It is code, not user data** — the `MCP_DEFS` precedent
  (`requirements-mcp-proxy.md` §3.3). It lives beside the app, under
  `resources/`, next to `resources/proxy/gurt-proxy.mjs`, and is resolved
  through the same dev-vs-packaged path split. Its name is reserved: a
  workspace env may not take it, rejected in the store validator, because
  the two share one name space.
- **It is image-only and pinned by digest**, for §2.1's structural reason
  and for the proxy container's: `node:22-alpine@sha256:…`-style pinning,
  no build, no features beyond the base node feature the container model
  already injects, no repo. Minimal on purpose — it holds an agent CLI and
  nothing else, because everything it would otherwise need is on the host
  side of an MCP call.
- **The user can re-point it.** `workspace.json` gains
  `operatorEnv?: string`; absent means the bundled default. Set from
  Settings, beside `defaultAgent` and `defaultSkills`, which it is the
  twin of. An operator pointed at a workspace env is an ordinary session
  on an ordinary env — the bundled one is a default, not a requirement,
  and the role does not check which env it got.

### 2.3 It is a session, and it lives in a task

The operator's *authority* is workspace-scoped (§3.2), but on disk it is a
session like any other and lives in a task —
`~/.gurt/<ws>/<task>/sessions.json`, one row, restored by the same boot
restore, deleted by the same delete. Nothing about persistence, reconcile
or the tree grows a special case. Where the user reaches it from is a UI
question and an open one (§13).

### 2.4 What the operator is not, in phase 1

- **It does not start sessions.** No `create_session`, no `sessionRun`,
  no `sessionEnqueue`, no draft. The one primitive that turns a config
  agent into an orchestrator is the one it does not get, and drafting is
  deferred to §13 rather than granted quietly.
- **It does not read repository content, with one named exception.** Not
  diffs, not review comments, not proposals (§3.4's `none` block). "Holds
  zero repos" has to mean something; a session with no mounts that can
  read every diff of every clone through an API is holding them by
  another route.

  The exception is env seeding, and it is exactly two classes of file:
  the **devcontainer config** `discoverDevcontainer` finds (the repo's
  own `devcontainer.json`, plus the companion Dockerfile that config's
  `build` section names) and the **Dockerfile candidates**
  `discoverDockerfiles` collects, which that method already limits to the
  repo root and `.devcontainer/**`. Both return file contents, and both
  stay exposed: an env is *seeded from* those files, and an operator that
  cannot read them cannot do the job the role exists for. Nothing else —
  not a source file, not a lockfile, not a README — and widening this
  list is a change to this document, not a judgement call at a call
  site.
- **It does not drive other sessions.** No prompting, no cancelling, no
  permission answering, no mode switching. It reads their diagnostics
  (§3.4) and says what is wrong.
- **It does not touch the host's GUI or the update path.**
  `openLogsFolder`, `sessionOpenVscode`, `changesOpenVscode`,
  `changesOpenPr`, `checkForUpdates` are `none`: they open windows,
  browsers and native dialogs on the user's desktop.

## 3. The admin surface is derived from `src/shared/api.ts`

### 3.1 One list, annotated — not a parallel surface

The tempting shape is a hand-written set of admin MCP tools. It is wrong
for exactly the reason `src/shared/api.ts`'s own header gives for
`METHODS`: *adding a method here is the whole wiring*. A second surface
would be a second place to add it to, and the two would drift — silently,
in the direction of the agent having a capability the UI's author never
reviewed, or lacking one they thought they granted.

So the annotation lands on the list that already exists. `METHODS`'s
value type stops being `true` and becomes the exposure:

```ts
export type Exposure = 'read' | 'write' | 'none'

const METHODS = {
  getTree: 'read',
  setAgents: 'write',
  setCredentials: 'none',
  // …
} as const satisfies Record<keyof GurtApi, Exposure>

export const API_METHODS = Object.keys(METHODS) as readonly (keyof GurtApi)[]
```

The `satisfies Record<keyof GurtApi, Exposure>` that already makes a
missing method a compile error now makes an *unannotated* method one too.
There is no default: a new API method does not compile until someone
decides what the agent may do with it. When that decision is unclear the
answer is `none` — the surface fails closed, and widening it later is a
one-word diff with a reviewer on it.

### 3.2 Schemas are generated; descriptions are the JSDoc

Annotations are compile-checked, but TypeScript types are erased at
runtime and an MCP tool needs a runtime schema. Hand-writing the
parameter schemas would re-introduce exactly the drift §3.1 exists to
prevent — one method, two shapes.

So: `scripts/gen-admin-tools.mjs` reads `src/shared/api.ts` with the
TypeScript compiler API and emits a checked-in
`src/shared/adminTools.generated.ts` — one zod schema per exposed method,
built from its parameter and return types, with the tool description
lifted verbatim from the method's JSDoc. CI regenerates and asserts an
empty diff, the same guarantee `satisfies` gives for the annotation but
for shapes the type system cannot carry to runtime.

Lifting the JSDoc is not a shortcut. The sentence the model reads about
`probeMcpServer` is the sentence the renderer's author read; a tool
description that can drift from the doc comment is a tool description
that will.

**Naming is mechanical.** `camelCase` → `snake_case`, the convention the
`gurt` server already uses (`create_session`, `complete`): `addEnv` →
`add_env`, `getTaskChanges` → `get_task_changes`. The tools are
registered on the existing per-session `gurt` MCP server
(`mcp/gurtServer.ts`), offered only when
`sessionRole(info) === 'operator'` — `requirements-session-roles.md` §5's
"tool set is a function of the role", with one more role in the
function.

**Derived does not mean identical.** A method may be exposed with a
narrowed schema or a narrowed result, and the narrowing lives beside the
annotation so it is read with it. Phase 1 has four:

1. **`ws` is bound, not passed.** Every method taking a leading
   `ws: string` drops it from the generated schema; the host binds the
   operator's own workspace. The agent cannot express another workspace,
   so cross-workspace authority is not a check that can be forgotten — it
   is a parameter that does not exist.
2. **`getCredentials` returns no values** (§5).
3. **`sessionSnapshot` returns no chat.** The operator's diagnostic need
   is state, container status, `startError`, role, env, repos, timings —
   not another session's conversation, which carries repo content and
   whatever the user typed into it.
4. **`probeMcpServer` narrows by kind** (§6).

Every exception to "derived from `api.ts`" must be written down here.
Phase 1 has exactly one: **`get_provisioning_log(key, tail)`**, which has
no `GurtApi` twin because the renderer receives provisioning output by
subscribing to the `provision-log` event and an agent cannot subscribe.
It reads the session's own file (`~/.gurt/logs/session-<key>.log`, where
`key` is a session id or an `env-build:<ws>/<env>` key), tail-limited, and
it goes through the scrub filter like every other read (§8).

### 3.3 Reads

Reads cover nearly everything, and that is deliberate: the operator's
value is proportional to how much of the configuration it can see at
once. What it costs is bounded by the two filters every read passes —
the workspace binding of §3.2 and the scrub of §8 — and by the `none`
block below, which is about *categories of asset*, not about caution.

### 3.4 What is `none`, and why

Four groups, each for one reason:

- **Repo content** — `getFileDiff`, `getCommitDiff`, `getDiffFiles`,
  `getDiffPair`, `getReviewState`, `latestProposal`, `changesCommit`,
  `changesPush`, `changesUpdateFromMain`. §2.4: zero repos has to be true.
- **Session lifecycle and driving** — `createSession`, `sessionRun`,
  `sessionEnqueue`, `sessionCancelQueue`, `sessionPrompt`,
  `sessionCancel`, `sessionClearPending`, `sessionCancelPending`,
  `sessionSetMode`, `sessionSetConfigOption`, `sessionPermission`,
  `sessionActivity`, `sessionEditPrompt`, `sessionEditDraft`,
  `sessionDuplicate`, `sessionDelete`, `renameSession`, `launchReviewFix`,
  `stopContainer`, `releaseContainer`. §2.4.
- **Destructive beyond the config layer** — `removeWorkspace`,
  `removeTask`, `renameTask`. Each destroys or rewrites clones holding
  uncommitted work, which is user work, not configuration.
  `createWorkspace` is `none` for a different reason: it is bootstrap
  (§10), and the workspace is what binds the operator's own authority.
- **Host desktop and secrets** — `setCredentials`, `openLogsFolder`,
  `sessionOpenVscode`, `changesOpenVscode`, `changesOpenPr`,
  `checkForUpdates`, `markNotificationRead`, `markAllRead`,
  `dismissNotification` (the user's own read state).

The full proposed annotation, method by method, is §13's table.

### 3.5 Writes: plain CRUD, with optimistic locking

Writes are the existing methods, unchanged in what they do. What they
gain is a revision.

**Every write op carries an expected revision and fails on mismatch.**
There are no entity mutexes and no leases: the store already serializes a
read-modify-write against its siblings (`editWorkspace`'s `chained()`),
so the race a mutex would close is not the one that exists. The one that
exists is the *user* editing an env in Settings between the agent's read
and its write — a window a mutex cannot cover because the user is not
holding it. A revision covers it, and it degrades correctly: the agent
re-reads, sees the user's change, and decides.

**The revision is derived, never stored.** It is a short hash of the
entity's canonical JSON as read — `canonicalJson` + the sha256 helper
already in `src/shared/envConfig.ts`, which exist for exactly this kind
of content addressing. No field on disk, no migration, and — the reason
it must be derived — it is correct for entities the user edited by hand
in `workspace.json`, which will never carry a revision counter.

A mismatch is an `isError` result naming the current revision and what
changed, the `create_session` precedent: host-side rules that a schema
cannot carry come back at the tool layer so the agent self-corrects
instead of the user finding a broken entity later.

## 4. Held fields: the devcontainer deny list

### 4.1 The deny list is a category, not a list of names

An env config is a devcontainer.json, and some of its fields do not
describe a container — they describe what the *host* does while creating
one:

| field | what it is |
| --- | --- |
| `initializeCommand` | **runs on the host**, outside every container, before anything is built |
| `mounts` | arbitrary host paths bound into the container — `~/.ssh`, `~/.aws`, `/` |
| `runArgs` | raw `docker run` arguments: `--privileged`, `-v /:/host`, `--pid=host`, the docker socket |
| `privileged` | the same, as a flag |
| `capAdd` | the same, one capability at a time |

`mounts` is not theoretical: `provision.ts`'s merge reads the stored
config's `mounts` array and concatenates gurt's own onto it, and the
entries go to `docker --mount` verbatim — it is the one channel in the
whole pipeline that reaches Docker unparsed.

These five are the deny list for env writes. But the list is a
consequence of a rule, and the rule is what implementations must apply:

> **A field through which an agent write causes code to run on the host,
> or grants a container access to the host, is never landed by an
> ordinary write.**

Applied across the config surface, phase 1 has one more member beyond the
five: the **command-bearing fields of a local MCP registry entry** —
`command`, `args`, `package` of a `kind: 'npm' | 'command'` entry
(`requirements-mcp-stdio.md` §3). Such an entry is a process gurt spawns
on the host, unsandboxed, with the user's privileges, from `postinstall`
onward — `requirements-mcp-stdio.md` §2.1's second adversary. An agent
that can write one has staged host execution as surely as one that can
write `initializeCommand`, and it would be incoherent to hold the second
and not the first. They are held, released the same way, and the
confirmation shows exactly what would run.

### 4.2 A write carrying a held field succeeds partially

The write does not fail. Failing it would teach the agent to retry with
the field renamed or split, and it would lose the safe 90% of a config
the user wants:

```ts
interface HeldField { field: string; reason: string }
interface WriteResult {
  /** Revision after the safe part landed — what the next write must carry. */
  rev: string
  /** What did not land. Absent when nothing was held. */
  held?: HeldField[]
}
```

The safe part applies. The held fields are **not written**, not to the
entity, not to a staging copy of it that some later code path might
merge. `reason` is written for the model: *"`initializeCommand` runs on
your user's machine, outside every container — it needs their explicit
confirmation"*.

### 4.3 `applyHeld`, and the one prompt auto-allow cannot reach

```ts
applyHeld(entity: EntityRef, fields: string[], rev: string): Promise<WriteResult>
```

Three properties, and all three are load-bearing:

**The values come from the kernel, not from the call.** The write that
held them stored the held fragment host-side, keyed by (entity,
resulting `rev`), dropped the moment the entity changes again.
`applyHeld` names fields; it cannot carry values. If the agent supplied
them here, the prompt would be rendering agent-authored text and the
guarantee would be theatre — the user would be confirming a diff written
by the thing being confirmed.

**It always prompts, and the prompt is exempt from the session's
auto-allow.** This is not the ACP permission path, and it cannot be. Two
mechanisms already make that path unusable as a guardrail:
`SessionManager.onPermission` blanket-allows every request whose title
matches `mcp__gurt__` (correctly — `complete` and `create_session` are
plumbing), and `autoAllow` drives the agent into a bypass mode where the
adapter stops asking at all. So the confirmation is gurt's own: raised by
the kernel, rendered by the renderer from the stored held fragment as a
diff, resolved by the user, blocking the tool call's promise until it is.
It is a session-log entry like a permission is, so the decision is in the
timeline afterwards. It has no timeout and no default: a walked-away
session leaves the fields held, and an app restart drops the pending
apply rather than resuming it. Fail closed, both times.

**The rationale, recorded, because it is what the design rests on.** The
operator's loop is create → check → edit → check; a session that asks
permission for each step of it is a session the user turns auto-allow on
for, on the first day, permanently. That is not a misuse — it is what
auto-allow is for. It follows that *ordinary permission prompts are not a
security layer for this role*, and that anything the agent can perform
itself, or phrase itself, or make routine by repetition, is not a
guardrail. Exactly one interaction in the operator's surface is exempt
from that erosion. It stays meaningful because it is rare enough not to
be answered by reflex, and because what it shows is kernel data — bytes
the agent never touched.

### 4.4 This is a tested invariant, not a convention

`requirements-mcp-proxy.md` §2 says the doc never pretends observability
is enforcement. Same rule here: the deny list is worth something only if
it cannot be walked around, and "cannot" is a claim that has to be
executed. Three tests, and they are acceptance criteria, not nice-to-have:

- **(a) A write carrying a deny-listed field never lands that field.**
  Drive every `write`-annotated method with a payload carrying each
  deny-listed field; assert the on-disk entity is byte-identical in that
  field to before, that the safe part *did* land, and that the field came
  back in `held`.
- **(b) `applyHeld` raises its prompt with auto-allow on.** The session
  is configured exactly as a real operator will be — `autoAllow: true`,
  a bypass mode selected — and the call must still block on a
  confirmation, and must apply nothing until it is answered. Answer
  "no": nothing landed. Answer "yes": exactly the held fields landed and
  nothing else.
- **(c) No other op sequence lands a deny-listed field without that
  prompt.** Testable because it is a property of one chokepoint: every
  config write goes through one filter function, and the test is a matrix
  over the write surface — write → write, write → `applyHeld` naming
  *other* fields, a stale `rev` replayed, the same `rev` used twice, a
  field smuggled through a wholesale-replace method (`setAgents`), an
  entity deleted and recreated between the two calls. The oracle is
  independent of the code under test: replay the §7 journal and assert no
  commit introduces a deny-listed field without a paired confirmation
  record.

## 5. Credentials: values never cross the boundary

### 5.1 No read of values, no write at all

`getCredentials` is exposed and its values are not: ids, labels, kinds,
link targets, the `unencrypted` flag — everything except `data`, whose
secret-marked members come back as `[redacted]`. The operator needs to
know *which* credentials exist to explain a 401 and to reason about what
links to what; it never needs the bytes.

`setCredentials` is `none`. There is no partial version of it, no
"create a credential and let the user fill in the secret" convenience: a
write path into the credential store is a write path into the credential
store.

### 5.2 Threat model, third adversary: re-pointing *is* exfiltration

`requirements-mcp-proxy.md` §2.1 has one adversary (the steerable agent
in the container) and `requirements-mcp-stdio.md` §2.1 adds a second (the
local server's package, on the host). This document adds a third, and it
is the same agent with a new capability:

| | proxy §2.1 | stdio §2.1 | this document |
| --- | --- | --- | --- |
| adversary | the agent, steerable | the agent **and** a host package | the agent, **holding the config the other two are bounded by** |
| what it reaches | what the policy allows | everything the user can | the policy itself, the envs, the registry, the links |
| what bounds it | the network, the mounts | nothing | this document |

The specific attack to record, because it is the one that survives every
obvious defence:

> An agent that cannot read a secret can still **route** it. Re-link a
> credential to an entry it controls, or change the `url` of a repo or
> MCP entry that already links one, and gurt itself sends the secret to a
> host the agent chose — as `Authorization: Bearer …`, over the proxy,
> from the host process, indistinguishable from a legitimate call.

Redaction does not touch this. Neither does the deny list: no host code
runs, no mount is created, nothing executes. It is a two-field edit to a
JSON file that gurt is designed to honour.

Therefore, in phase 1 and enforced at the write filter, not the schema:

- **No write op may set or change `credentialId`** on any entity.
- **No write op may change the `url`** of an entity that carries a
  `credentialId` — repo or MCP entry.
- **No write op may create an entity carrying a `credentialId`**, which
  is the same attack without an update: an `addMcpServer` naming an
  existing credential and an attacker's URL needs no edit at all.

These are **refused**, not held. The held mechanism releases a change by
showing the user a diff, and a URL diff does not make its consequence
evident — "this host now receives your token" is not something a reader
of `- url: …` / `+ url: …` reliably sees. A guardrail whose prompt does
not convey what is being confirmed is worse than a refusal, because it
manufactures consent. The refusal names the reason and points at
Settings.

### 5.3 Recorded and deferred

This subsection is explicitly a *recorded and deferred* attack surface,
not a solved one. Re-linking and re-pointing are genuinely useful and
will be asked for. Exposing them later requires **credential→host
binding first**: a credential entry carries the set of hosts it may be
sent to, the resolvers (`resolveMcpCredential`, `hostGitAccess`) refuse
to inject it toward anything else, and re-pointing becomes safe by
construction — a re-pointed URL simply loses its credential instead of
carrying it somewhere new. Until that exists, the surface stays closed,
and any change that opens it must cite this section.

## 6. Composite verbs: a fixed catalog, and no composition mechanism

The operator's loop is create → run → read the log → edit. Served
naively, that is "let the agent run commands", which is the entire
security model handed back. Served as one kernel operation per step, it
is three tools:

- **`env_check(env, rev)`** — provision the saved env exactly as a
  session start would (materialize the config, build if it has a build
  section, `devcontainer up`, run the lifecycle hooks), stream the
  provisioning log, tear the container down. **No ACP adapter is
  installed. No agent secret is injected. No proxy scope is minted, no
  MCP is routed, no session exists.** It answers `{ ok, phase, log }` and
  it never throws for the env's own failure — `probeMcpServer`'s rule
  verbatim (`mcp/probe.ts`: *it answers, it does not throw*), because a
  stack trace across the tool boundary is the same failure the check
  exists to translate. It takes a `rev` for the same reason a write does:
  checking a version of the env the agent no longer holds produces a
  verdict about the wrong thing. A build env is cloned from its default
  repo the way a start would clone it, with the same host-side
  credential resolution; nothing runs inside the clone.
- **`repo_check(repo)`** — resolve the repo's credential host-side and
  `git ls-remote` it: does the URL exist, does the credential
  authenticate, what is HEAD. The `remoteHead` path already exists in
  `provision.ts`. The result carries the answer and never the credential.
- **`mcp_probe`** — `probeMcpServer`, already built
  (`src/main/mcp/probe.ts`), narrowed by kind. An `http` entry may be
  probed **by value**, unsaved: probing one is an HTTP request with
  headers, which the proxy could make anyway. A local (`npm` /
  `command`) entry may be probed **only by id, only if saved** — because
  the method takes a whole entry, and an unsaved local entry passed by
  value is arbitrary host execution with no write and therefore no §4
  confirmation. Addressed by id, the command it runs has already passed
  the held prompt.

**There is no `run_ops` tool, and there will not be one.** A "here is a
list of operations, execute them" primitive — however typed, however
allowlisted per member — is free-form execution reintroduced through the
back door: the composition becomes the payload, ordering becomes control
flow, and the thing under review stops being a call and becomes a
program. The catalog is fixed, each entry is a kernel operation with its
own bounded semantics, and growing it is a change to this document.

## 7. The config journal: `~/.gurt` is a git repository

**The operator's memory is chat context, and chat context is not a
record.** It dies on compaction, on session deletion, on container
recreation. And the moment a journal is needed is precisely the moment
the operator cannot be asked — it is broken, or it is confidently wrong,
and "what did you change" is the question it is least able to answer.

So the record is kept by the host, mechanically, and it is git — because
git is journal, diff, attribution and rollback in one, it works from a
terminal when gurt will not start, and it needs no UI to be useful on the
day it is needed.

**Scope.** One repository at `~/.gurt`, allow-listed by `.gitignore`, so
adding a file to the tree is a decision rather than an oversight:

```gitignore
/*
!/.gitignore
!/agents.json
!/*/
/*/*
!/*/workspace.json
!/*/skills/
```

In: `agents.json` (the agent registry), every `workspace.json` (repos,
envs, the MCP registry, defaults), every workspace's `skills/` tree.

`!/*/skills/` rests on a store invariant, and it is written down here
because it is invisible at the point it would be broken: `skills` is a
**reserved task name** (`RESERVED_NAMES.task` in `store.ts`, beside
`workspace.json` and `.devcontainers`), so `~/.gurt/<ws>/skills/` can
never be a task directory. Un-reserve it and that one line stops naming
a registry and starts naming a task — committing its `sessions.json`,
its chat logs and its clones into the journal. The reservation is a
dependency of this design, not a nicety of naming.

Out, and each for a stated reason: **`credentials.json`** — secrets never
enter a git history, which is a one-way door; **`sessions.json`, the
`sessions/*.jsonl` chat logs, `usage.jsonl`, `.devcontainers/`,
`agent-config-cache.json`, `logs/`, `mcp/`** — runtime state and derived
artifacts, which would bury every real change under churn; **the clones**
— they are git repositories themselves, and an allow-list ignore keeps
them out by construction rather than by an embedded-repo warning nobody
reads.

**Every mutation auto-commits**, from one place: the store calls
`journal(...)` after a successful config mutation, beside the `chained()`
serialization that already makes the write atomic.

```
env "node20": devcontainer updated

Op: updateEnv
Entity: acme/env/node20
```

with the author carrying the actor: `gurt-ui <user@gurt.local>` for a
change made in the UI, `gurt-operator <4f3c…@gurt.local>` for one made by
an operator session, its id in the address. `git log --author=operator`
is then the answer to "what has the agent done to my setup", and it is
the answer whether or not gurt is running.

**A journal failure never fails the user's edit.** It is logged and the
write stands: a repository the user deleted, a git binary that is missing,
a lock left by a terminal — none of those is a reason to refuse to save an
env. The journal is a record, not a gate; §4's guarantees do not depend on
it (it is an *independent oracle* for test (c), which is a different and
weaker claim).

**No UI in phase 1.** Rollback is `git -C ~/.gurt revert`/`checkout` from
a terminal, with gurt restarted afterwards — config is read from disk on
demand, but "restart after a rollback" is the honest instruction rather
than a claim about every cache. A history view in Settings is a later,
purely additive change.

## 8. Scrub on read, as a tested invariant

Logs are believed secret-free by design today, and the belief is largely
justified: `sanitize()` runs over every line written to a session's file,
and `addSecrets()` registers every credential-store value at startup and
on every save, so redaction is value-based — it catches a token wherever
it appears, without the call site knowing it was a token.

What changes is who reads. A convention that holds because people rarely
read provisioning logs stops holding when an agent reads them
programmatically, on every iteration of a loop, and can be steered to
look. And config reads are *not* covered today: `workspace.json` is read
raw, and a secret can be sitting in an MCP entry's static header or a
local entry's `env` map — `requirements-mcp-stdio.md` §5 lifts the
obvious ones into credentials on paste, which is a mitigation, not a
guarantee.

**So: every read on the MCP path passes a scrub filter.** It reuses
`log.ts`'s `redact()` — the same registered values, raw/base64/base64url,
the same documented `MIN_SECRET_LEN` exception — lifted into a shared
module and applied to structured results: every string at every depth,
plus `logging.md`'s key deny-list (`token`, `authorization`, `secret`,
`apikey`, …) for the keys themselves. It scrubs the *result*, not the
file: the value on disk is untouched and Settings still shows it.

**The test is the requirement.** Plant a credential in the store; make it
appear in a provisioning log and in a `workspace.json` header value;
assert it survives into neither `get_provisioning_log` nor any config
read, in raw, base64 and base64url form. A convention that is not
executed is a convention that has already drifted.

## 9. Per-tool granularity for MCP registry entries

`McpRegistryEntry` gains `tools?: string[]` — an allowlist of tool names,
absent meaning "all", per entry, for every kind. It is planned host-side
in `src/main/proxy/config.ts` (`planProxy` puts it into the scope's
`McpUpstream`) and enforced where the protocol is actually seen.

**Enforcement is on the request path only.** `tools/call` carries the
tool name in a small, already-complete request body: the proxy checks the
name against the scope's list and answers a JSON-RPC error itself,
without dialing upstream. `resources/proxy/gurt-proxy.mjs`'s *routing* is
untouched — this is an additive check before the same dial — and the
response path is untouched too, which matters: `requirements-mcp-proxy.md`
§4.3 requires responses to be piped and never buffered, and a
`tools/list` filter would mean buffering an SSE stream to rewrite it.

**`tools/list` is deliberately not filtered.** The agent sees the whole
list and learns which entries are blocked from the error it gets when it
calls one — which is better than a silently shortened list, and it is the
only shape that survives the reason this feature exists: **tool names
drift across server versions.** An allowlist written against v1 will name
a tool v2 renamed, and a blocked-or-unknown call must therefore be
*visible*, never silently dropped:

- A call to a **blocked** tool: a JSON-RPC error naming the tool and the
  entry, and a line in the session's log (the same place a `403` egress
  denial lands, `requirements-mcp-proxy.md` §8), so the user sees "your
  allowlist refused `linear.create_issue`" rather than an agent that
  quietly stopped using a server.
- A call to a tool the upstream **does not have**: the upstream's own
  error, passed through, also logged. The two are different sentences
  because they are different problems — one is the user's list, one is
  the server's version.

**The field belongs to registry entries, not to built-ins.** A local
(`npm` / `command`) registry entry is routed as a `host` upstream
(`requirements-mcp-stdio.md` §4.4), so its allowlist is enforced one hop
earlier — in `stdioBridge.ts`, where the host already terminates the
protocol — with the same request-path rule and the same log line. The
built-ins (`github`, `gurt`, and the admin tools of §3) are out: they
keep `McpSelection.mode`, which is a claim gurt can make about its own
tools (`McpToolInfo.write`) and only its own.

That distinction is why this does not contradict
`requirements-mcp-proxy.md` §3.3. An allowlist is not a mode: a mode is a
statement about what an upstream's tools *do*, which gurt does not know,
while a list of names is a statement the user made and gurt only has to
match.

## 10. Bootstrap stays manual, and minimal

A first run needs exactly two things done by hand:

1. **One agent instance and its token** — a record in `agents.json` and
   an `agent-token` credential.
2. **One workspace.**

Everything after that goes through the operator: repos, envs, the MCP
registry, skills, defaults, tasks. The bundled default env (§2.2) is what
makes this minimum *sufficient* rather than merely small — without it,
"create an env" would be a prerequisite for the agent that creates envs.

Neither step is exposed to the agent (`setCredentials` and
`createWorkspace` are `none`, §3.4): the credential store is the one
asset the whole design keeps on the other side of the boundary, and the
workspace is what the operator's own authority is bound to.

## 11. Phases

1. **The role, the read surface, the journal.** The operator role and its
   repo-less start path (§2), the bundled default env (§2.2), exposure
   annotations on `METHODS` with the generator and its no-diff CI check
   (§3.1–3.2), the scrub filter and its test (§8), the git journal (§7).
   Every annotation that is not `read` or `none` is treated as `none` in
   this phase: the operator can see everything and explain it, and can
   change nothing. That is a shippable product — "why did this fail" is
   most of the motivating use — and it lands the two mechanisms every
   later phase depends on (the derived surface, the journal) with no
   write risk at all.
2. **Writes.** Revisions (§3.5), the deny list, `held`, `applyHeld` and
   its confirmation (§4), the credential refusals (§5). The tests of §4.4
   land *with* this phase, not after it: they are the definition of the
   feature.
3. **Composite verbs.** `env_check`, `repo_check`, the narrowed
   `mcp_probe` (§6).
4. **Per-tool MCP granularity** (§9). Independent of 1–3; last because
   nothing above depends on it.

## 12. Acceptance

1. `npm run lint`, `npm run typecheck`, `npm test` clean, and no
   pre-existing test changed to accommodate this work.
2. `scripts/operator-role.test.mjs` — the role table row: zero repos
   enforced at create / draft edit / IPC, a repo-less operator reaching
   `starting` through all four checks while every other role still refuses
   it, no clone lock taken and none waited for, no `complete` and no
   nudge, `create_session` absent from its tool set, an env with a
   `build` section refused with its own sentence, and the `operatorEnv`
   resolution (absent → bundled, set → that env).
3. `scripts/admin-surface.test.mjs` — the derived surface: every
   `GurtApi` method is annotated (a compile-time guarantee, asserted
   again at runtime over `API_METHODS`), the generated tool list is
   exactly the `read`+`write` set, regenerating produces no diff, `ws` is
   absent from every schema and a call cannot reach another workspace,
   `getCredentials` returns no secret value, `sessionSnapshot` returns no
   chat entries, and every `none` method is unreachable by any tool name.
4. `scripts/held-fields.test.mjs` — §4.4's (a), (b) and (c) in that
   order, including the local-MCP command fields, and the journal replay
   used as the independent oracle for (c).
5. `scripts/credential-boundary.test.mjs` — no write sets or changes a
   `credentialId`, no write changes the `url` of a credentialed entity,
   no create carries a link; each refused (not held) with a sentence
   naming Settings.
6. `scripts/scrub.test.mjs` — §8's planted credential, in raw, base64 and
   base64url form, surviving into neither `get_provisioning_log` nor a
   config read.
7. `scripts/config-journal.test.mjs` — the ignore file (a planted
   `credentials.json` never appears in `git ls-files`, nor does a clone,
   nor `sessions.json`), the reservation the ignore file depends on (a
   task named `skills` is refused by the store — §7), one commit per
   mutation with the actor in the author and the op in the trailer, a UI
   change and an operator change distinguishable by `--author`, and a
   journal failure (missing git, deleted repo, stale lock) leaving the
   config write successful.
8. `scripts/mcp-tool-policy.test.mjs` — the allowlist in the scope, a
   blocked `tools/call` answered with an error and logged, an unknown
   tool's upstream error passed through and logged, `tools/list`
   unfiltered, and — against a server that answers a POST with a long
   SSE stream — the response still arriving unbuffered and byte-identical
   through a proxy that has the check enabled.
9. `npm run build && node scripts/smoke-operator.mjs` — the real modal:
   the operator role selectable, the repo picker disabled for it, the env
   defaulting to the bundled one, the session reaching `started` with no
   clone, and the `applyHeld` confirmation appearing in a session with
   auto-allow on. *(Phase 1 as-built: the smoke covers the modal half —
   role selectable, repo picker disabled, bundled env default, zero repos
   persisted, Run not blocked on a repository, reload round-trip.
   "Reaching `started` with no clone" needs a Docker daemon and moved to
   item 10's record; the `applyHeld` confirmation is phase 2 and lands
   with it. The unit half of the row — the four gates, the lock
   non-participation, the image-only refusal — is item 2's test.)*
10. **Not yet verified**: the bundled env against a real Docker daemon
    (this environment has none — the same gap that
    `requirements-session-roles.md` §9 records in its item 8). What to
    check on first real use: a repo-less `devcontainer up` against an
    empty wrapper folder (the unit test verifies the empty wrapper is
    staged and the CLI is invoked against it; not that a daemon accepts
    it), an operator session actually reaching `started` with no clone,
    the pinned `node:22-bookworm-slim` digest resolving and the node
    feature installing on it, and — phase 3 — `env_check` tearing its
    container down on every exit path including a failed build.

## 13. Open questions

**1. The exact exposure annotation per method.** Proposed below, in
`api.ts` order. This table is the thing to argue with before phase 1
lands; every row is cheap to change now and expensive to change once an
agent depends on it. `read*` marks a narrowed read (§3.2).

| method | exposure | note |
| --- | --- | --- |
| `getTree` | read | scoped to the operator's workspace |
| `getMcpDefs` | read | |
| `getAgents` | read | credential links only, values scrubbed |
| `setAgents` | write | wholesale replace: `rev` covers the whole file |
| `getAgentConfig` | read | |
| `getCredentials` | read\* | ids, labels, kinds; no values (§5.1) |
| `setCredentials` | none | §5.1 |
| `credentialUsedBy` | read | |
| `createWorkspace` | none | bootstrap (§10) |
| `removeWorkspace` | none | destroys clones and their uncommitted work |
| `addRepo` | write | no `credentialId` (§5.2) |
| `discoverDevcontainer` | read | repo file contents, by the §2.4 exception; reaches the network |
| `discoverDockerfiles` | read | repo file contents, by the §2.4 exception |
| `envImageStatus` | read | |
| `envBuildImage` | write | largely superseded by `env_check` (§6) |
| `updateRepo` | write | no `url` change on a credentialed repo (§5.2) |
| `removeRepo` | write | |
| `addEnv` / `updateEnv` | write | deny list applies (§4) |
| `removeEnv` | write | already blocked while a session runs it |
| `setDefaultAgent` / `setDeniedAgents` | write | |
| `getMcpServers` | read | |
| `addMcpServer` / `updateMcpServer` | write | local-kind command fields held (§4.1); links frozen (§5.2) |
| `removeMcpServer` | write | |
| `getSkills` / `getSkillDoc` | read | |
| `addSkill` / `updateSkill` / `removeSkill` | write | |
| `skillUsedBy` | read | |
| `setDefaultSkills` | write | |
| `setOperatorEnv` | write | §2.2's re-pointing — configuring gurt is the point |
| `reinstallMcpServer` | write | the package identity was already confirmed; the version pin is not a boundary |
| `probeMcpServer` | read\* | narrowed by kind (§6) |
| `createTask` | write | |
| `removeTask` / `renameTask` | none | destroys or rewrites clones |
| `taskDirtyRepos` | read | |
| `setTaskMaxConcurrentSessions` | write | |
| `stopContainer` / `releaseContainer` | none | §2.4 |
| `sessionOpenVscode` | none | host GUI |
| `getTaskChanges` | read | counts and states, not content |
| `getFileDiff` / `getCommitDiff` / `getDiffFiles` / `getDiffPair` | none | repo content (§2.4) |
| `getReviewState` | none | comments quote code |
| `getReviewLocks` | read | why a session cannot start — diagnostics |
| `setReviewLock` | none | |
| `addReviewComment` / `resolveReviewComment` / `deleteReviewComment` | none | |
| `launchReviewFix` | none | drafts a session (§2.4) |
| `changesCommit` / `changesPush` / `changesUpdateFromMain` | none | writes to repos and remotes |
| `latestProposal` | none | repo content |
| `changesOpenPr` / `changesOpenVscode` | none | host GUI / browser |
| `createSession` | none | phase 1; see question 2 |
| `sessionRun` / `sessionEnqueue` / `sessionCancelQueue` | none | §2.4 |
| `sessionEditPrompt` / `renameSession` / `sessionEditDraft` / `sessionDuplicate` / `sessionDelete` | none | §2.4 |
| `sessionSnapshot` | read\* | state, container status, `startError`; no chat (§3.2) |
| `sessionTraffic` | read | blocked hosts — the diagnostic the operator exists for |
| `sessionPrompt` / `sessionCancel` / `sessionClearPending` / `sessionCancelPending` | none | driving another agent |
| `sessionSetMode` / `sessionSetConfigOption` / `sessionPermission` / `sessionActivity` | none | driving another agent |
| `openLogsFolder` / `checkForUpdates` | none | host GUI / native dialog |
| `getNotifications` | read | scrubbed |
| `markNotificationRead` / `markAllRead` / `dismissNotification` | none | the user's own read state |
| `getNotificationPrefs` | read | |
| `setNotificationPrefs` | write | configuring gurt is the point |
| `getHotkeys` | read | |
| `setHotkeys` | write | same |
| `getUsage` / `getPlanUsage` | read | |
| `getBootProgress` | read | |

**2. May the operator draft — not start — sessions?** `create_session`
already exists, already produces an inert draft, and the user launching it
already *is* the approval step (`requirements-session-roles.md` §3). The
case for: "I fixed your env, here is a session ready to test it" is the
natural end of the operator's loop. The case against: drafting is how a
config agent becomes an orchestrator, the draft carries a start prompt the
agent wrote, and phase 1 is the wrong time to find out which matters more.
Deferred, not refused — and if it is taken, `spawnableRoles('operator')`
is the whole of the change plus a `repos` rule (an operator holds none, so
it must name the draft's repo explicitly).

**3. Read scope if the diagnostics reads are later offered to
non-operator sessions.** `sessionSnapshot`, `sessionTraffic`,
`get_provisioning_log` and `getReviewLocks` are useful to any session
debugging itself ("why was I blocked from npm"), and there is an obvious
appetite for a per-session diagnostics toggle. If that is offered, the
scope must be **own-session-only** — bound host-side to the calling
session's id, the way §3.2 binds `ws`, so a session cannot name another
one's id at all. A cross-session read is the operator's privilege, and it
is a privilege precisely because the operator holds no repo and drives
nothing.

**4. Where the user reaches the operator.** Three candidates, none
decided: a role in the New Session modal like the other three (cheapest,
consistent, and it inherits task placement — but it buries the "soft
entry" the feature is named for); a pinned entry in the sidebar, one per
workspace, always present, its session created on first click (best
discoverability, but it needs a task to live in and therefore a rule for
which); or an entry point in Settings, beside the thing being configured
(most contextual, most work). §2.3 makes all three implementable — the
operator is an ordinary session in an ordinary task whichever is chosen.

**5. What happens to held fields the user never answers.** They are
dropped on restart and on any further write to the entity (§4.3). Whether
a pending apply should be *visible* in the session pane as a to-do —
the way a draft is — is unresolved. Leaning yes, deferred.

**6. Does the journal need a `.gurt` repo per machine or per user?** One
per `gurtRoot`, so `GURT_ROOT` overrides get their own — which is what
tests want and what a second profile wants. No cross-machine sync is
proposed, and syncing a directory that excludes `credentials.json` by
policy but sits beside it deserves its own document.

## 14. Out of scope

A general "run these operations" tool, in any form (§6 — the reason is
structural, not a matter of scope). Any write path to `credentials.json`
(§5.1). Credential→host binding, which is the prerequisite for re-linking
rather than a part of it (§5.3). Repo content of any kind to the operator
(§2.4). Session start, queueing and driving (§2.4); drafting is question 2,
not a promise. A rollback or history UI for the journal (§7 — the terminal
is the phase-1 interface, deliberately). Filtering `tools/list` or any
response-path rewriting at the proxy (§9). A global (cross-workspace)
operator: authority follows the workspace binding, and an operator over
all workspaces would need a scope story this document does not have.
Multi-operator concurrency beyond what the revision check already gives —
two operators editing one env is a revision mismatch, not a lock.

## 15. Touchpoints

`src/shared/types.ts` (`SessionRole` gains `operator`, `roleNeedsRepo`
beside the existing predicates, `WorkspaceFile.operatorEnv`),
`src/shared/api.ts` (`Exposure`, the annotated `METHODS`),
`src/shared/adminTools.generated.ts` + `scripts/gen-admin-tools.mjs`
(new), `src/shared/mcp.ts` (`McpRegistryEntry.tools`),
`src/main/sessions.ts` (the four repo gates, the operator's tool set, the
held-apply confirmation beside `onPermission`),
`src/main/mcp/gurtServer.ts` (the admin tools, offered by role),
`src/main/mcp/probe.ts` (the by-id narrowing for local kinds),
`src/main/provision.ts` / `src/main/containers.ts` (repo-less
provisioning, the empty wrapper folder), `src/main/store.ts` (the write
filter, derived revisions, `journal()`, the bundled env's reserved name),
`src/main/log.ts` (`redact` lifted into a shared scrub),
`src/main/proxy/config.ts` (`tools` into the scope),
`resources/proxy/gurt-proxy.mjs` (the request-path tool check),
`resources/env/` (new — the bundled default env),
`src/renderer/src/components/SettingsPage.tsx` (`operatorEnv`, the
per-entry tool allowlist) and `Sidebar.tsx` / `tags.tsx` (the role in the
modal, `ROLE_INFO`).

## 16. As built (phase 1)

Decisions taken while implementing phase 1 — the parts a reader would
otherwise have to re-derive from the diff, and the places where the plan
above met the code and bent. Everything §11 lists for phase 1 landed; the
tests are `scripts/operator-role.test.mjs`, `scripts/admin-surface.test.mjs`,
`scripts/scrub.test.mjs`, `scripts/config-journal.test.mjs` and
`scripts/smoke-operator.mjs`.

- **The admin dispatch is a second compile-checked binding of the annotated
  list, not a reuse of ipc.ts's `impl`.** §3.1's rule is that the *list* must
  not fork, and it does not: the annotation lives on `METHODS`, and
  `main/adminSurface.ts` binds it as `Pick<GurtApi, ReadMethod>` (a type
  derived from the annotations), so a method annotated `read` without an
  admin binding — or a binding without the annotation — is a compile error,
  exactly the way preload and ipc.ts are each compile-checked bindings of
  `API_METHODS`. Reusing ipc.ts's `impl` object was rejected for two
  reasons: `scripts/ipc-contract.test.mjs` pins it as an object literal in
  ipc.ts, and it carries renderer-only side effects an operator read must
  not trigger — `sessionSnapshot` marks the session's notifications read
  there, and the read state is the user's own (§3.4).
- **The generated file carries parameter schemas; results are JSON text.**
  §3.2 said "built from its parameter and return types"; as built,
  `adminTools.generated.ts` derives input schemas only and results cross the
  boundary as JSON text with no registered output schema — the scrub (§8)
  rewrites values on the way out, and a structural output contract would
  either fight the redaction or have to lie about it. Descriptions are the
  JSDoc verbatim, as specified; a method with no JSDoc reads
  `GurtApi.<name>`.
- **`probeMcpServer`'s by-kind narrowing is live in phase 1** — §3.2 lists
  it among the four narrowings even though §11 files the `mcp_probe`
  *composite verb* under phase 3. As built: an `http` entry probes by value,
  unsaved; a local (`npm`/`command`) entry resolves by its `id` against the
  saved registry and the **saved** entry is what runs — a doctored command
  under a saved id probes the registry's own command, and an unsaved local
  entry is refused with a sentence pointing at Settings.
- **`get_provisioning_log` takes `env-build:<env>`**, not
  `env-build:<ws>/<env>`: the ws segment is the parameter §3.2 removes, so
  the host prefixes the bound workspace (a fully-qualified key is accepted
  only when it names it). A session id must belong to the bound workspace;
  an id from another workspace answers exactly like one that does not
  exist. A missing log file is an answer ("no provisioning log for …"),
  not an error. Tail defaults to 200 lines, capped at 2000.
- **The snapshot narrowing, precisely:** `entries`, `pending` (queued
  prompt texts), `proposal` (commit/PR prose), `plan`, `commands`, `modes`
  and `configOptions` are dropped, and `info.startPrompt` is blanked — all
  of them carry conversation or its products. What survives is `info`
  (state, role, env, repos, container, timings), `busy`, `resuming`,
  `startError`, `queuePosition`, `pendingBlocked` and `usage`.
- **The workspace binding also filters the ws-less aggregates**:
  `getTree` answers only the bound workspace, `getNotifications` and
  `getUsage` are filtered to it. `getAgents`, `getAgentConfig`,
  `getCredentials` (values stripped), `getPlanUsage` and the prefs/hotkeys
  reads stay host-global — they are host-level registries with no
  workspace dimension.
- **The scrub's key deny-list has a three-name allow-list**: `credentialId`
  (a link — §5.1 exposes exactly that), `credentialEnvVar` (the name of the
  variable a local MCP entry reads, not its value) and `credentials`
  (`CredentialsFile`'s envelope key, whose secret-marked members the §3.2
  narrowing has already replaced before the scrub runs). Without them the
  deny-substring `credential` would erase the links the operator exists to
  reason about. Widening the list is a change to §8, not a call-site
  judgement. The redaction values themselves are shared with the log
  writer via `main/redact.ts`, lifted out of `log.ts` as §8 asks.
- **The bundled env is `node:22-bookworm-slim`, pinned by digest** —
  Debian rather than the `node:22-alpine` §2.2 used as its example, because
  the pinned devcontainer node feature installs via bash/apt and does not
  support musl images. It resolves by name (`operator`) anywhere a
  workspace env would — the shared name space, with the name reserved in
  the store validator — and `GURT_OPERATOR_ENV` overrides its path for
  headless tests, the `GURT_PROXY_SCRIPT` precedent.
- **Phase 1's "write is none" is enforced twice**: the write tools are
  generated (so §12 item 3's "read+write set" holds for the file) but never
  registered on the MCP server, and the admin surface's chokepoint refuses
  them again if reached by another route.
- **First-real-run fix: `exec` must resolve exactly the config `up` wrote,
  and "zero mounts" is the case that broke it.** `devcontainerUp` writes the
  per-session merged config only when gurt added mounts of its own; the
  exec-side resolver (`sessionConfigArgs` in containers.ts) picked the
  merged copy for every mounted *role*. Those agreed for every prior role —
  mounted implied at least one repo — and disagreed exactly for the
  repo-less operator: its `up` came up on the env's own materialized file
  (confirming, on a real daemon, that a repo-less `devcontainer up` against
  the empty wrapper works — §12 item 10's first check), and then the
  adapter probe/install exec'd against a merged copy that was never
  written, failing the start with "ACP adapter install failed (exit 1)".
  The resolver now mirrors `up`'s write condition literally (repo mounts
  present, or the skills bind); regression in
  `scripts/operator-role.test.mjs` ("exec resolves exactly the config up
  wrote").
- **Journal mechanics.** Commits run with a fixed committer
  (`-c user.name=gurt`), signing off (`-c commit.gpgsign=false`) and hooks
  off (`--no-verify`) — a machine-written journal must commit the same way
  on every machine. A mutation that changed no tracked bytes commits
  nothing. Two mutations of *different* workspaces racing can coalesce into
  one commit whose trailer names one op (the journal chain serializes
  commits, not saves); sequential mutations — the only kind one actor
  produces — journal one-to-one. `removeWorkspace` journals too (the
  deletion of a tracked `workspace.json` is a config change), as does the
  new `setOperatorEnv`. The actor rides an `AsyncLocalStorage` context
  (`store.withJournalActor`), so phase 2's operator writes attribute
  themselves without a parameter on every mutator.
- **Where the user reaches the operator** (question 4): as built, the role
  is picked on a draft's Config tab like the other three — the cheapest
  candidate. Picking it clears the repos, disables the repository picker
  and points the draft's env at `operatorEnv ?? bundled`; the sidebar/
  Settings entry points stay open questions.
