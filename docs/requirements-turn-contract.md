# Requirements: turn contract — `complete` tool and change proposals

Status: draft for review · Owner: klerik3d · Target: gurt Electron PoC (this repo)

This document is a work order for an implementing agent. Read `README.md`
first. Key code: `src/main/mcp/{manager,githubServer}.ts`,
`src/main/sessions.ts`, `src/main/kernel.ts`, `src/main/changes.ts`,
`src/shared/{types,events,api}.ts`,
`src/renderer/src/components/TaskPane.tsx`. Do not change the contract
described here without asking the owner. Depends on the merged kernel /
event-bus / session-log slices.

## 1. Motivation

A turn just ends: commit/PR texts exist only as chat prose, and the only
machine-readable outcome is `stopReason`. The orchestration model (executor
never ships; a privileged host path commits/pushes/PRs after user approval)
needs every turn to end with an explicit, validated report: the `complete`
tool call carrying the proposed commit/PR texts. The host stores the latest
proposal per session and feeds it to the Changes panel (and, later, to the
committer stage). A turn ending without the call is a protocol violation —
detected and healed with one automatic follow-up prompt, since the ACP
session is still alive and a nudge costs seconds, not a container start.

## 2. Artifact — `src/shared/types.ts`

```ts
/** Terminal turn report, submitted via the `gurt` MCP server's `complete` tool. */
export interface ChangeProposal {
  version: 1
  /** changes — working tree holds work to ship; no_changes — nothing to ship
   *  (answer, analysis, no-op); blocked — cannot finish, see reason. */
  outcome: 'changes' | 'no_changes' | 'blocked'
  /** Only with outcome=changes (required then). */
  commit?: { subject: string; body?: string }
  /** Only with outcome=changes (optional). */
  pr?: { title: string; body?: string }
  /** Only with outcome=blocked (required then). */
  reason?: string
  notes?: string
}

/** Stored proposal: the artifact + host receipt time (ISO). */
export type StoredProposal = ChangeProposal & { at: string }
```

Server-side validation (zod, strict — unknown keys rejected): `version`
literal `1`; `commit.subject` single-line, 1–120 chars; `commit`/`pr`
rejected unless outcome=changes; `reason` required with blocked, rejected
otherwise. A failed validation returns `isError` with the zod message —
the agent self-corrects at the tool layer; the host callback never fires.

## 3. Host MCP server `gurt` — `src/main/mcp/gurtServer.ts`

One server **per session** (not per env — proposals must be attributed to a
session without trusting the agent to name itself). Same shape as
`githubServer.ts`/`manager.ts`: bind `0.0.0.0`, random-UUID token path
`/mcp/<token>`, stateless per POST, reachable via `host.docker.internal`.
Not in `MCP_DEFS`, never shown in the MCP picker — attached to every
session unconditionally.

```ts
export function buildGurtHttpServer(
  token: string,
  onComplete: (p: ChangeProposal) => void
): Server
/** Ensure the per-session server is running; keyed by sessionId. */
export async function ensureGurtServer(
  ref: EnvRef, sessionId: string, onComplete: (p: ChangeProposal) => void
): Promise<AcpHttpMcpServer>
export function stopGurtServer(sessionId: string): void
export function stopGurtServersForEnv(ref: EnvRef): void
```

MCP server name `gurt`, exactly one tool `complete`. Server `instructions`
(delivered through MCP init — nothing in the clone, invisible in chat):

```
Finish EVERY turn by calling the `complete` tool, after all other work:
- outcome "changes" — the working tree contains work to ship. Include the
  exact commit message you propose (subject, optional body) and, when a
  pull request should follow, the PR title/body.
- outcome "no_changes" — this turn produced nothing to ship.
- outcome "blocked" — you cannot finish; give the reason.
Do not commit, push, or open pull requests yourself — leave the working
tree uncommitted and deliver the texts through `complete`; the user
reviews and ships them. (Exception: the user explicitly attached shipping
tools and asked you to use them.)
```

`githubServer.ts` instructions: the local-work list drops `commit` —
"(status, diff, log, branch)" — so the two servers do not contradict.

## 4. Session integration — `src/main/sessions.ts`

`SessionEvents` gains:

```ts
resolveGurtServer(ref: EnvRef, sessionId: string,
  onComplete: (p: ChangeProposal) => void): Promise<AcpHttpMcpServer>
stopGurtServer(sessionId: string): void
```

`kernel.ts` wires them to the module; the existing `stopMcpServers` wiring
becomes `(ref) => { stopMcpServers(ref); stopGurtServersForEnv(ref) }`.
`stopGurtServer(sessionId)` is called from the same sites that delete the
session's JSONL log.

- `startSession` and `attach`: the descriptor is appended to the resolved
  list for both `session/new` and `session/load`:
  `[...await resolveMcpServers(ref, mcp), await resolveGurtServer(ref, id, cb)]`.
- `onComplete(sessionId, p)`: set `s.turnComplete = true`; when
  `p.outcome === 'changes'` set `s.proposal = { ...p, at: new Date().toISOString() }`
  (a `no_changes`/`blocked` call never clears a stored proposal); push a
  system timeline entry `complete: changes — <subject>` / `complete:
  no_changes` / `complete: blocked — <reason>`; emit `session.changed` +
  `schedulePersist`; when outcome=changes also emit the new domain event
  `'session.proposal': { sessionId; ref: EnvRef; proposal: StoredProposal }`
  (`src/shared/events.ts`) — the seam the committer stage will consume.
- Turn enforcement (in the `runPrompt` flow; extract the post-turn decision
  into a unit-testable function):
  - prompt start → `s.turnComplete = false`; clear `s.info.incomplete`.
  - turn ended with `stopReason === 'end_turn'` and `!s.turnComplete`:
    - regular prompt → send one automatic follow-up with the fixed text
      `NUDGE_PROMPT` (below); its timeline entry is `system`, not `user`.
    - the nudge prompt itself → no second nudge: push system entry
      `turn ended without complete`, set `s.info.incomplete = true`
      (runtime overlay like `busy`, never persisted, shown in the snapshot).
  - any other stopReason, a thrown prompt, or cancel → no nudge.
  - `complete` arriving outside a busy turn still updates the proposal and
    events (a benign race: a late POST may cost one redundant nudge).

```ts
const NUDGE_PROMPT =
  'You ended your turn without calling the `complete` tool. Call `complete` ' +
  'now with the correct outcome (changes / no_changes / blocked) and do ' +
  'nothing else.'
```

Persistence: `PersistedSession.proposal?: StoredProposal` (sessions.json,
existing persist path), carried through `restore()`;
`SessionSnapshot.proposal?: StoredProposal`. Repeated `complete` calls:
last one wins.

## 5. Consumption — Changes panel prefill

- `SessionManager.latestProposal(ws, task, repo): StoredProposal | undefined`
  — newest `at` among this env's sessions (stored proposals are always
  outcome=changes).
- `GurtApi.latestProposal(ws, task, repo)` — registered like every other
  method (`API_METHODS`); the Commit modal prefills its message field with
  `subject` (+ blank line + `body` when present) on open; the user edits
  freely.
- `Kernel.prUrl(ws, task, repo): Promise<string>` — wraps `changes.prUrl`
  and, when the latest proposal has `pr`, appends url-encoded
  `title`/`body` query params (GitHub's compare page picks them up);
  `ipc.ts` keeps only `shell.openExternal` on top of it.

## 6. Non-goals

- Pipeline/state machine, review stage, host committer service, multi-repo
  coordination — later slices; this slice only produces the artifact.
- Removing the `github` MCP full mode or the `gitAccess` option — the
  manual-mode escape hatch stays as is.
- Per-repo commit conventions (subject patterns, PR templates) — the
  validation hook exists in §2; config comes later.
- Clearing proposals on thread integration, tree badge for `incomplete`,
  renderer rendering beyond the system text entries above.
- No git broker / shims changes.

## 7. Acceptance

1. `node scripts/gurt-mcp.test.mjs` (new, pure node, no docker; harness
   style of `scripts/session-log.test.mjs`): drives the built server over
   HTTP with MCP JSON-RPC — `tools/list` shows exactly `complete`; valid
   changes call → callback gets the payload, result not error; changes
   without `commit` → `isError`, callback not called; blocked without
   `reason` → `isError`; unknown top-level key → `isError`; `version: 2` →
   `isError`; wrong token → 404; GET → 405.
2. Post-turn decision matrix unit test: end_turn+complete → nothing;
   end_turn without complete → exactly one nudge; nudge turn without
   complete → `incomplete` + system entry, no second nudge; complete during
   the nudge turn → clean; stopReason `cancelled` → no nudge.
3. Smoke (built app, offline local bare origins, pattern of `smoke7.mjs`):
   a trivial-edit session ends with `sessions.json` holding a proposal
   (outcome changes, non-empty subject), the `complete: changes — …` system
   entry in the JSONL, `latestProposal` returning it, and `Kernel.prUrl`
   containing the `title` param when `pr` was proposed. Gotchas: strip
   `ELECTRON_RUN_AS_NODE`, unique `GURT_ROOT` per run, roots under `/Users`.
4. Existing smokes and tests pass; restored legacy sessions (no `proposal`
   field) behave unchanged.
