# Requirements: OAuth credentials (sign in instead of pasting a key)

Status: partial — §8 phases 1–2 implemented, phase 3 (the generic MCP
provider) pending · Target: gurt Electron MVP (this repo)

This document is a work order for an implementing agent. Read
`requirements-git-access.md` §3 first — this adds one kind to its
credential store and changes nothing about how entries link, seal, mask
or block deletion. Key code: `src/shared/credentials.ts`
(`CREDENTIAL_KINDS`, `resolveAgentSecret`, `resolveMcpCredential`),
`src/main/credentials.ts` (sealing, masks, `feedRedactor`, the save
chain), `src/main/containers.ts` (`resolveLaunch` — the `secretEnv`
injection), `src/main/proxy/config.ts` + `src/main/proxy/manager.ts`
(the header a `pushScope` carries), `src/main/redact.ts` (`addSecrets`),
and — new — `src/main/oauth/` (the flow, the refresh) with
`src/main/oauth/providers/` (one module per provider).

> **Extends** `requirements-git-access.md`: §3's store gains a kind
> whose secret gurt *obtains* rather than the user pasting it. The
> linking model (§3.1), the sealing (`main/credentials.ts`), the
> renderer masking and the delete-while-linked rule are reused exactly
> as they are — that reuse is the design, and §5 below is the list of
> places where "exactly" has to be checked rather than assumed.

## 1. Motivation

**The credential a user actually has is a login, not a string.** An
`agent-token` entry is a pasted static secret. That fits an API key and
nothing else: Claude, ChatGPT and Gemini subscription plans authenticate
by OAuth sign-in, and the tokens those flows mint are not something a
user can reasonably extract from another tool's keychain and paste into
a form. The MCP specification's authorization model is OAuth outright
(authorization code + PKCE against a server that advertises its
endpoints), so a remote MCP server that follows the spec cannot be
configured with an `mcp-token` at all — there is no static token to
have.

**OAuth complements `agent-token`; it never replaces it.** API keys stay
first-class: CI, self-hosted gateways and enterprise proxies
authenticate with keys, and a key is the right shape there. This
document adds a second way to fill the same slot, not a migration.

## 2. The model

A new kind in `CREDENTIAL_KINDS`:

```
kind: 'oauth'
data:
  providerId   which src/main/oauth/providers/ module owns this entry
  refresh      the refresh token — secret, sealed, never leaves the host
  access       the current access token — secret, sealed
  expiresAt    when `access` expires (ISO 8601)
  account      display identity of the signed-in user ("jane@example.com")
```

`hosts` is `[]` and the kind joins `NON_GIT_KINDS`: like `agent-token`
and `mcp-token` it links explicitly and never auto-matches a git host.

**Linking is unchanged.** An agent's `credentialId` and an MCP registry
entry's `credentialId` may point at an `oauth` entry exactly as they
point at an `agent-token` / `mcp-token` today. The link pools the
editors offer (`agentCredentials`, `mcpCredentials`) grow to include the
kind, the wrong-kind errors in `resolveAgentSecret` /
`resolveMcpCredential` accept it, and `credentialUsedBy` needs no change
at all — it never looked at `kind`. Delete-while-linked still blocks.

**What a consumer gets is still "a secret string now" — but for this
kind, getting it is async.** Resolution may have to refresh (§5.2), and
a refresh is a network call plus a store write. The pure resolvers in
`shared/credentials.ts` stay pure: they identify the entry and its kind,
and the *main*-side caller — `resolveLaunch` for agents, the
(already async) proxy-plan caller for MCP — awaits the refresh before
handing the plain string onward. `planProxy` itself stays a pure
function of arrays; the token it composes into a header is resolved
before it runs, the same seam its credential store input already
crosses.

**An entry that cannot resolve blocks, with a sentence.** The existing
credential policy (`requirements-git-access.md` §3.1, restated at
`RETIRED_KINDS` in `shared/credentials.ts`) holds unchanged: a refresh
token that is expired or revoked fails the session start with
`credential "<label>" is signed out — sign in again in Credentials`,
and never falls back to ambient auth, an empty env var, or a container
that starts and then 401s with no explanation. The error is actionable
or it is not an error message.

### 2.1 The fields list is the sealing manifest

`CREDENTIAL_KINDS[].fields` does two jobs today: it renders the modal's
form, and `secretKeys()` in `main/credentials.ts` reads it to decide
which `data` keys get sealed, masked and fed to the redactor. An `oauth`
entry renders no text inputs (§4) — but `refresh` and `access` **must**
still be declared as secret-flagged fields, or they are stored in
plaintext, served to the renderer unmasked and never redacted. The
implementation may hide the fields from the form (a per-kind render
branch, or a `hidden` flag on `CredentialField`); it may not omit them
from the definition. This is the one place §5's "reuse as-is" needs a
mechanical check, so it is named here rather than discovered as a leak.

`providerId`, `expiresAt` and `account` are plaintext `data` — none is a
secret, and `account` exists precisely to be shown.

## 3. Providers

One interface, all specifics behind it (`src/main/oauth/providers/`):

```ts
interface OAuthProvider {
  id: string
  /** Run the full sign-in: system browser, loopback redirect, code
   *  exchange. Resolves when the tokens are in hand. */
  authorize(): Promise<TokenSet>
  /** Exchange a refresh token for a new access token. MAY rotate the
   *  refresh token — the returned set is the truth. */
  refresh(current: TokenSet): Promise<TokenSet>
}

interface TokenSet {
  access: string
  refresh: string
  expiresAt: string
  account: string
}
```

The flow is standard OAuth 2.0 authorization code with PKCE (S256), in
the system browser, with the redirect on a loopback listener —
`http://127.0.0.1:<random port>/callback`, bound to `127.0.0.1` only —
per RFC 8252. `state` is generated per attempt and checked on the way
back; a mismatch is an aborted flow, not a warning.

Providers, phase 1: **anthropic**, **openai**, **google** — hardcoded
configs (endpoints, client_id, scopes), one small module each. Phase 3
adds a **generic MCP provider**: given a server URL it discovers the
authorization server via RFC 8414 metadata and registers a client via
RFC 7591 dynamic client registration, then runs the identical
authorize/refresh interface. That one provider is what covers the
MCP-spec OAuth path for any conforming server, without a per-server
module.

**Decision: reuse the official CLI clients' `client_id`s.** gurt does
not have its own registrations with Anthropic, OpenAI or Google, and it
does not need them: gurt literally launches those vendors' CLIs
(`AGENT_DEFS` in `src/shared/agents.ts`), so the token it obtains is
consumed by the exact client the `client_id` names. The tokens are for
those clients in the plainest sense. **The risk is real and is accepted
knowingly:** these are not our registrations. A vendor can rotate,
restrict or revoke a public client_id without notice, and a flow that
worked yesterday breaks with no action on our side. Each provider
module carries the client_id it borrows and a comment saying exactly
this, so the day it breaks the reason is one grep away.

## 4. UX

In the Credentials modal, an `oauth` entry renders a **Sign in** button
where other kinds render text fields.

- Sign in opens the provider's authorization URL in the **system
  browser** via `shell.openExternal` — never an embedded webview or a
  `BrowserWindow`. The user's password manager, passkeys, SSO cookies
  and 2FA live in their browser; an Electron surface asking for a
  provider password is indistinguishable from a phish and would be
  training users to accept one.
- While the browser round-trip is pending the modal shows a waiting
  state with **Cancel**, and the attempt times out on its own (the
  loopback listener closes on either). One pending attempt per entry —
  a second click cancels and restarts rather than racing two listeners.
- On success the entry shows **signed in as `<account>`** and a
  **Re-authenticate** action (same flow, replaces the token set). On
  failure, the provider's error as a sentence, and the entry stays as
  it was.
- A signed-out entry (refresh token expired or revoked, detected at
  resolve time) shows the same Sign in button plus the blocking error
  from §2 — the modal is where the error's "sign in again" points.

**Two paths, one goal, presented as a choice — not a puzzle.** The
place a user meets this is "give this agent a credential", and both an
API key and a sign-in legitimately answer it. The intended
presentation: the kind picker offers `agent token` (relabelled in hint
text as the API-key path: *"paste an API key — CI, self-hosted,
enterprise"*) and `oauth sign-in` (*"sign in with your Claude / ChatGPT
/ Gemini account"*) side by side, as peers. Neither is marked
recommended, neither is buried under "advanced", and the hint says whose
account each expects — the existing `hint` field is where this lives, so
the renderer needs no new mechanism to say it.

## 5. Storage and transport

### 5.1 What is reused, unchanged

Sealing at rest (`safeStorage`, the `sealed` blob, the plaintext
fallback and its warning), the renderer mask round-trip
(`maskValue` / `resolveSentinels` / `UNSEAL_FAILED_MASK`), and the
redaction feed on every store read (`feedRedactor`). No new storage
mechanism, no second file, no keychain entries of our own.

### 5.2 Where the tokens go — and where they never go

**The refresh token never leaves the host.** Not into a container, not
into an env var, not into a proxy config, not to the renderer (it is
secret-flagged, so the renderer only ever sees its mask). It exists to
be spent by `refresh()` in main, and nowhere else.

**Only the short-lived access token reaches a container**, by the two
paths that already exist:

- **Agents:** `resolveLaunch` resolves the linked credential to the
  access token and injects it as the agent's `secretEnv`
  (`--remote-env`, `provision.ts`) — the same variable an `agent-token`
  fills (`CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, …). Resolution
  runs at every adapter launch, so every launch starts with a fresh
  token.
- **MCP:** the access token composes into the upstream header exactly
  as an `mcp-token` does (`Authorization: Bearer <access>` by default),
  rides in the proxy scope, and reaches the proxy via `pushScope`. The
  scope file *is* the push (`requirements-mcp-proxy.md` §5.4), so a
  refreshed token can be delivered to a **live** session by rewriting
  the scope — no restart, no token reissue for the agent.

### 5.3 Refresh

At resolve time: if `access` is expired, or within a small skew window
of expiring (a token that dies mid-injection helps nobody), call the
provider's `refresh()` and persist the result before handing the access
token out.

**Single-flight per credential — this is a correctness rule, not a
nicety.** Providers may rotate the refresh token on every refresh, and
the old one dies when the new one is born. Two sessions launching
concurrently, each refreshing the same entry, is two `refresh()` calls
racing: the loser holds a rotated-away refresh token, and whichever
result is persisted last may be the dead one. One in-flight refresh per
credential id; every concurrent resolver awaits the same promise and
gets the same fresh token.

**A rotated refresh token is persisted immediately** — before the new
access token is handed to any consumer, through the same serialized
write path (`saveChain`) every credential save takes, so it seals, it
feeds the redactor, and it cannot interleave with a renderer save. The
write path must read-modify-write the current store state: a renderer
save that was in flight when the refresh started (the user editing a
label, say) must not last-write-wins away the rotated token, and vice
versa — the save chain is the lock, and both writers sit on it. Losing
a rotated refresh token is losing the sign-in; the user pays with
another browser round-trip.

### 5.4 Redaction

`addSecrets` learns secrets from credential-store reads and saves
(`feedRedactor`) — today that is the only feed, and it is enough because
every secret enters the store before it is ever used. An OAuth token
breaks that assumption: it arrives over the network, mid-flight, and is
injected into a launch or a proxy scope in the same breath. **Every
`TokenSet` is fed to `addSecrets` the moment it is obtained** —
`authorize()` and `refresh()` results alike, in the oauth module itself,
not left to the store write that follows — so there is no window in
which a live token is loggable. The store write then re-feeds it
harmlessly; `addSecrets` is idempotent.

## 6. Accepted limits, decided now

**Mid-turn access-token expiry is accepted for v1.** The agent path
refreshes per adapter launch and the injected env var is fixed for the
life of the adapter process — a very long turn can outlive its token
and die on a 401, and v1 answers that with "start the turn again". (The
MCP path is better off: §5.2's live scope push can renew a running
session's header.) Two mitigations are recorded as future options,
neither committed: claude-code accepts a long-lived
`CLAUDE_CODE_OAUTH_TOKEN` minted for exactly this shape of consumer,
which would sidestep expiry for that agent entirely; and a host-side
token broker (the container asks the host for a token at use time,
never holding more than it needs) would fix it for every agent at the
cost of a new host surface — that shape already exists once in gurt as
the git broker, so it is a known pattern, not a research project.

**Borrowed client_ids** — decided, with the risk named, in §3.

**Two credential paths stay** — decided in §1; the presentation duty is
§4's last block.

## 7. Logging

The existing rule: values never, and the tokens are registered with the
redactor before anything can log them (§5.4). `account` and `providerId`
are not secrets and are what makes a record answerable.

New slugs, for `docs/logging.md`'s dictionary:

| slug | level | context |
|---|---|---|
| `oauth.authorize` | INF | `id`, `provider`, `ok`, `ms` — a sign-in attempt ended (success, failure or timeout) |
| `oauth.refresh` | INF | `id`, `provider`, `ok`, `rotated` (bool), `ms` |
| `oauth.expired` | WRN | `id`, `provider` — the refresh token is dead; the session start it blocked says so too |

The authorization code, the loopback URL (its port is fine; its query
string is not) and every token value appear in no record at any level.

## 8. Phases

1. **Model + refresh path.** The kind, the sealing manifest (§2.1), the
   async resolution seam, single-flight refresh with immediate
   persistence, the redaction feed, the three hardcoded providers, and
   the blocking signed-out error. An entry created by hand in
   `credentials.json` (a token set copied from a CLI's own storage)
   works end to end from here.
2. **UI.** The Sign in button, `shell.openExternal`, the loopback
   listener, pending/cancel/timeout, "signed in as", Re-authenticate,
   and the two-paths presentation (§4).
3. **The generic MCP provider.** RFC 8414 discovery + RFC 7591 dynamic
   client registration behind the same interface, and the MCP registry
   editor offering "sign in" for a server that advertises it.

## 9. Acceptance

1. `npm run lint`, `npm run typecheck`, `npm test` clean; no
   pre-existing test changed to accommodate this work.
2. A pre-existing `credentials.json` round-trips unchanged — the new
   kind costs existing entries nothing.
3. With sealing available, a stored `oauth` entry's `refresh` and
   `access` appear only under `sealed`; the renderer sees masks; a log
   line hand-fed a live access token prints `[redacted]`.
4. Two sessions launched concurrently against one `oauth` credential
   with an expired access token produce exactly one `refresh()` call
   (single-flight proven, not assumed), and the rotated refresh token
   is on disk before either launch proceeds.
5. A revoked refresh token blocks the session start with the
   sign-in-again sentence; nothing falls back to ambient auth and no
   container starts with an empty or stale token.
6. `grep` finds the refresh token in no proxy config, no descriptor, no
   argv and no `--remote-env` — only `credentials.json` holds it.

## 10. Out of scope

A host-side token broker and any mid-turn refresh for the env-var path
(§6 — recorded as future options, not built). Device-code flow for
browserless machines. Our own client registrations with the agent
vendors (§3 — borrowed client_ids are the decision, revisited only when
one breaks). Revoking tokens upstream when an entry is deleted —
deleting the entry forgets the tokens, and the provider's own session
management is where revocation lives. Confidential clients / client
secrets: every flow here is a public client with PKCE. Migrating
existing `agent-token` entries to OAuth — they are not wrong, and §1
says why they stay.
