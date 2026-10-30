# Requirements: PII/secret masking layer (tokenization)

Status: draft for review · Owner: klerik3d · Target: gurt Electron MVP (this repo)

This document is a work order for an implementing agent. Read `README.md`
first. Key code: `src/main/sessions.ts` (`promptBlocks`, `onSessionUpdate`,
`session/prompt`), `src/shared/mcp.ts` (`MCP_DEFS`, `mcpDef` — the registry
pattern reused for detector backends, §4), `src/shared/credentials.ts`
(`CredentialKind`, `CREDENTIAL_KINDS`), `src/main/credentials.ts`,
`src/shared/types.ts` (`SessionInfo`, `AgentSessionRequest`),
`src/renderer/src/components/Sidebar.tsx` (the `git access` chip this
mirrors), `src/renderer/src/components/SettingsPage.tsx`,
`docs/requirements-git-access.md` (the closest existing precedent — a host
broker keeping one specific kind of secret out of the container). Do not
change the contract described here without asking the owner.

> **Scope**: this pass covers the user ↔ agent (ACP) chat seam, the per-session
> table and the view toggle, and the settings that configure it. The ACP
> `fs/*` / `terminal/*` client methods and agent ↔ MCP traffic are the agreed
> next stages — §9.

## 1. Motivation

Today everything the agent sees carries whatever real data is in it: chat
text the user types, and everything the agent says back. Nothing stands
between the user and the agent's own context, the way
`requirements-git-access.md` already isolates *credentials* specifically
(the agent never sees a git secret; a host broker holds it and answers per
request). This generalizes that same idea from "git credentials" to "any
sensitive text the user types": the agent operates on typed placeholder
tokens, never real values, while the user's own chat view always sees the
real data.

## 2. The contract

- **encode**: scan text for entities a detector recognizes, replace each with
  a token (§3), recording what it stood for in the session's table.
- **reveal**: replace tokens with the real value, from the same table.
- The agent's context never holds a real value. The timeline gurt keeps holds
  the same tokenized text the agent saw; **the chat view reveals it at render
  time**, so showing reals or tokens is a view toggle (§5.4), not a property of
  what is stored.

### 2.1 Direction table

| seam | direction | data | operation |
|---|---|---|---|
| user → agent | outbound `session/prompt` | user-typed prompt text | encode (real→token) before it reaches the agent *and* before it is pushed to the timeline |
| agent → user | inbound `session/update` | agent's text / tool titles / detail | stored as received (tokens stay tokens) |
| timeline → chat view | render | every text field of every entry, plan rows | reveal from the session's table when the view is "open" |

A token split across two streamed chunks needs no special handling: the entry
accumulates the chunks and the view reveals the whole token.

## 3. Token format and the table

- **Token**: `[type:N]` — lower-case entity type (`email`, `phone_number`,
  `us_ssn`, …) and the ordinal of the value among that session's values of that
  type. Chosen for few model tokens, a visible type, no collision with
  markdown (a link or footnote has no `type:digits` inside its brackets) and a
  one-line regex: `\[([a-z][a-z0-9_]*):(\d+)\]`. Agents sometimes URL-encode
  it into a link; the reveal step also resolves `%5Bemail%3A1%5D`.
- **Table**: `~/.gurt/pii-tables/<sessionId>.json`, mode 0600, outside every
  session mount:

  ```json
  { "v": 1, "tokens": { "email": { "1": "acme@gmail.com", "2": "bob@example.com" } } }
  ```

- Ordinals are assigned left to right in order of first sight and **never
  reused**; the same value is the same token for the session's whole life. Mail
  addresses are compared case-insensitively, everything else as typed.
- The row is written (atomically, serialized per session) **before** the token
  can be sent: a token never reaches the agent without its row.
- A token the table does not know (an agent-invented `[email:99]`, or prose that
  merely looks like one) is left verbatim.
- **Lifetime = the session's.** The file is deleted when the session is deleted
  (and with its task/workspace). A restart keeps it, so old history stays
  readable. A duplicate or an agent-drafted session does **not** inherit the
  table: each session encodes its own prompt into its own table. Moving text
  between sessions is a reveal on the way out of one and an encode on the way
  into the other.
- No cryptography. The table sits at rest in cleartext like every other file
  under `~/.gurt`; it is what keeps reals out of the *agent's context*, not a
  vault. Encrypting the file is a possible later step.

## 4. Detection

Pluggable, behind one interface (`Detector`):
`detect(text: string): Array<{ start: number; end: number; type: string }>`.

- **v1 built-in detector** — pure TS, regex/checksum only, **no new npm
  dependency, no vendored pattern files** — see §4.1 for where the patterns
  actually come from.
- **external detector** (optional, later): an HTTP call to a configured
  backend (Presidio analyzer, or any other), for the free-text NER gap the
  built-in detector explicitly does not cover. Backend selection is a
  registry, the same shape as `MCP_DEFS`/`mcpDef` in `shared/mcp.ts`.

### 4.1 Pattern sources (built-in detector)

No pattern data ships in the repo and no library is added to `package.json`
for this. Instead, the pattern *source* is itself a setting (§5.1): pick a
public, permissively-licensed collection (CommonRegex, Presidio's
`predefined_recognizers`, gitleaks' `gitleaks.toml`, or another one added to
the same list later) and gurt fetches it at runtime.

- **Fetch**: a plain HTTP GET of the raw source file, pinned to a specific
  commit/tag (never a moving branch) so patterns never change silently
  underfoot. Refetched only on explicit user action ("check for updates" /
  re-selecting the pinned ref), not on every launch.
- **Cache**: the fetched raw file plus its adapted form live under
  `~/.gurt/pii-patterns/<source>.json` — read from there on every start;
  the network is only touched on first selection or an explicit refresh.
- **Adapter**: one small per-source parser we write ourselves — pulls just
  the `{ type, regex }` pairs out of that source's own format (a Python
  literal list for CommonRegex/Presidio, the `[[rules]]` blocks of
  `gitleaks.toml`) into gurt's own pattern shape. This is text extraction of
  a handful of fields, not a full-fidelity parser — no TOML/Python-AST
  library needed for it either.
- **Offline / first run**: with nothing cached yet and no network, the
  built-in detector has no patterns to run and masking cannot turn on —
  surfaced as a plain configuration state in §5.1, not solved further here.

## 5. Settings: two-tier toggle

### 5.1 System settings (global)

New section in `SettingsPage.tsx` (pattern: Repos / Environments /
Credentials), picks the active detector backend:

- `built-in` — requires picking a **pattern source** (§4.1) from the same
  kind of list: CommonRegex / Presidio patterns / gitleaks rules / …
  Selecting one triggers the fetch → adapt → cache flow; re-selecting the
  same source with a newer pinned ref re-fetches. Nothing is masked until a
  source has been fetched at least once.
- `presidio` — configure either "run locally" (gurt manages a docker sidecar
  the same way it builds/runs env images — `docker build`/`up`,
  content-tagged) or "remote" (URL + a `pii-detector` credential, §5.3).
- registry open to more backends later (mirrors §4's detector interface).

Nothing is masked while no backend is selected — this *is* "off".

The section shows facts and controls only — no prose explaining them.

#### 5.1.1 Presidio options (`src/main/piiAnalyzer.ts`, `presidioDetector` in `src/main/pii.ts`)

High-level only; nothing here tunes a model.

| setting | applies to | effect |
|---|---|---|
| **languages** (`presidioLanguages`, default `en`) | local + remote | `/analyze` takes one language per call, so a text is analyzed once per language and the findings pooled. A NER finding (`PERSON`, `LOCATION`, `NRP`, `ORGANIZATION`, `DATE_TIME`) whose letters are all in another script than its language's is dropped: an English pipeline over Russian prose tags ordinary words as names. Pattern findings are never script-filtered. |
| **model** (`presidioModel`: spaCy `lg` / `sm`, default `lg`) | local | the spaCy pipeline per language (`en_core_web_*`, `<lang>_core_news_*`). |
| **min score** (`presidioThreshold`, default 0) | local + remote | sent as `score_threshold`, and applied again to what comes back. |
| **entities** (`presidioEntities`, default all) | local + remote | sent as `entities`; the choices are the analyzer's own `/supportedentities` for the selected languages. |

**The local image.** `en` + `lg` is the stock pinned image. Anything else is a
derived image gurt builds: `FROM` the stock image, the spaCy pipelines
installed with presidio's own `install_nlp_models.py`, and presidio's three
config files (`default.yaml` models, `supported_languages` in
`default_analyzer.yaml` and `default_recognizers.yaml`) rewritten in place —
the files its Dockerfile already points `NLP_CONF_FILE`,
`ANALYZER_CONF_FILE` and `RECOGNIZER_REGISTRY_CONF_FILE` at. The tag is
`gurt-presidio-analyzer:<hash of the plan>`; the sidecar carries
`gurt.pii.key=<image>@<port>` and is recreated when that changes. Pull, build
and start run in the background after a save (and at boot); until `/health`
answers, `encode` fails closed naming the phase (`not up yet (building)`).

**Status** shows the image (or the remote URL) and its state — `pulling`,
`building`, `starting`, `running`, `stopped`, `missing`, `unreachable`,
`error` — polled while it is changing; `restart` recreates a local sidecar.

#### 5.1.2 Test

With a usable engine, a TEST field runs the active detector over a sample
(`testPii`) and shows the masked text, numbered as a fresh session would be,
plus each finding's type, value and score. No session's table is touched.

### 5.2 Masking is global, not per session

There is no per-session masking flag. Every session masks while §5.1 resolves
to a usable engine, and none does while it does not. The only per-session
surface is the view switch (§5.4), which is display only.

**Engine vs. rules.** *Engine* is what finds entities: `off` (nothing is
masked), `built-in` (regex + checksum, in-process) or `presidio` (an external
analyzer that adds NER). *Rules* exist only for `built-in`: which public
collection its regexes come from (CommonRegex, Presidio patterns, gitleaks).
Picking the engine does not pick the rules — `built-in` with no rules fetched is
not usable.

### 5.3 Credential store

- New `CredentialKind`: `'pii-detector'` in `shared/credentials.ts`'s
  `CredentialKind` union + `CREDENTIAL_KINDS` (fields: `url`, `apiKey` — both
  kind-specific like every other entry). `hosts: []`, excluded from
  `isGitKind` (same treatment as `agent-token` today).
- No new storage subsystem — same `~/.gurt/credentials.json`, same CRUD in
  `credentials.ts`.

### 5.4 The view toggle

An eye button on the composer bar (always there; dimmed with the reason while
masking is off and there are no tokens to show). **Open** (default): the chat shows real values, revealed from the
table. **Closed**: the chat shows the tokens the agent sees. Per session, kept
as a UI preference; display only — neither state changes what is sent or stored.
The renderer pulls the table (`getPiiTable`) and follows `pii-table` events,
which main emits before the timeline entry that uses a new token.

## 6. Where it hooks

- Encode: `sendTurn` in `src/main/sessions.ts` encodes the prompt text *first*,
  then pushes the user entry and sends `session/prompt` with the tokenized text
  — whenever masking is usable (§5.1). An encode failure ends the
  turn with a visible error; the cleartext is never sent.
- Inbound: `onSessionUpdate` stores text, tool titles and details as received.
- Reveal: `src/renderer/src/usePii.ts` maps the timeline (text, tool
  title/detail, permission title/detail) and the plan through `revealTokens`
  (shared/pii.ts) when the view is open.

## 7. Non-goals (this pass)

- Free-text NER in the built-in detector (§4) — regex/checksum only; NER is
  deferred to an external backend.
- Encrypting `pii-tables/*.json` or the `pii-detector` credential at rest — a
  possible later step; same tradeoff `requirements-git-access.md` §11 accepts
  for the rest of the store.
- Notifications built off the timeline show tokens (they are text main
  composes from stored entries).

## 8. Acceptance

1. `npm run typecheck` clean (all projects).
2. `scripts/pii-mask.test.mjs` and `scripts/acp-client.test.mjs` (the latter
   runs the fs/terminal handlers over real files and processes): encode→reveal identity per entity type,
   `[type:N]` grammar and ordinals, table file shape/mode, durability across a
   fresh manager, isolation between sessions, deletion with the session,
   reveal edge cases (unknown token, URL-encoded token).
3. `scripts/proxy-pii.test.mjs` and `scripts/pii-rewrite.test.mjs` cover the proxy
   rewrite (request/JSON/SSE/text, fail closed) and the host endpoint.
4. Smoke: with `built-in` and a fetched rule set selected in Settings →
   Masking, every session masks; a masked session shows reals with the eye open and tokens with
   it closed.
5. Rest of `scripts/*.test.mjs` passes unmodified (apart from the new API
   method/hook listed in the IPC contract tests).

## 9. ACP client methods (built) and MCP traffic (next)

### 9.1 `fs/*` and `terminal/*` — `src/main/acpClient.ts`

For a session that masks, `initialize` advertises `fs: {readTextFile,
writeTextFile: true}` and `terminal: true`, and gurt answers those methods
itself, in the session's container (`provision.spawnInContainer` — the same
`devcontainer exec` user/environment the agent has). A session that does not
mask still advertises `false` and its agent does both for itself, as before.

| method | toward the agent | from the agent |
|---|---|---|
| `fs/read_text_file` | content is **encoded**; `line`/`limit` select a window; a missing file is `-32002`; an encode failure rejects (fail closed) | — |
| `fs/write_text_file` | — | content is **revealed** before it is written; parent dirs are created |
| `terminal/create` | — | command, args, env values and cwd are **revealed**; a bare command line with spaces runs through `sh -c` |
| `terminal/output` | output is **encoded**; only whole lines while the process runs (a half-written value cannot be detected, so it is held back); `outputByteLimit` keeps the tail | — |
| `terminal/wait_for_exit`, `kill`, `release` | exit status / stop / free | — |

Each call logs `acp.client.call` with the method, agent kind and a byte count
(never a path or content) — that log is how to see which adapters actually use
the methods. A static look at the pinned adapters found `fs/*` calls only in
gemini-cli; advertising the capability is what changes that for the rest, if
they honor it. Limitations: a `kill` stops the host-side exec, which may not
reach every descendant inside the container; bash and file tools an adapter
runs itself (claude-code, codex today) stay outside the barrier until the
adapter routes them here.

### 9.2 MCP traffic — `resources/proxy/gurt-proxy.mjs` + `src/main/piiRewrite.ts`

Every MCP descriptor the agent holds is a URL on the session's proxy (gurt's own
`github` and `gurt` servers, local stdio bridges and remote registry entries all
resolve to one), so the proxy is the single place MCP traffic is rewritten. It
is a stock-alpine container with no table and no detector, so it asks the host:

- the scope file gains `pii: { url }` for a masking session (`ProxyConfig.pii`,
  written by `planProxy`); absent = forwarded as before;
- the host serves `POST <url>/reveal` and `<url>/encode`, each `{strings} →
  {strings}`, from one listener (`piiRewrite.ts`). The url's token exists only in
  the proxy's scope file — `reveal` is an oracle for what a token stands for, so
  without the token every path is a 404;
- **toward the server** (a POST body): every string in the JSON-RPC message is
  revealed. A `create_session` prompt, a `complete` commit message, a tool
  argument all reach their target with real values; a session that is drafted
  encodes its own prompt later, into its own table;
- **toward the agent**: only *content* is encoded — `result.content`,
  `structuredContent`, `contents`, `messages`, an error's `message`/`data`, and
  the `params` of a server-initiated message. Protocol strings (method names,
  tool listings, `serverInfo`) are left alone;
- only string values are rewritten, so the JSON stays valid whatever a value
  contains. JSON and text responses are buffered (bounded) and answered whole;
  an SSE stream is rewritten event by event, in order, never held past its
  event (an event that is not JSON is passed on);
- **fail closed**: a host that is unreachable or errors, a body past the bound,
  or a compressed response (the upstream is asked for `identity`) is a 502 — a
  message that could not be rewritten is never forwarded.

Not covered: arbitrary HTTPS the agent opens itself (a CONNECT tunnel is
opaque) — a token reaching an external host is harmless, and what the agent
reads from there it reads in the clear.
