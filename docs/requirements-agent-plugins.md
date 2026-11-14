# Requirements: agent plugins, phase 1 — an agent-agnostic core

Status: implemented (phase 1, see §10) · Target: gurt Electron app (this repo)

This document is a work order for an implementing agent. Read
[architecture.md](architecture.md) first. Key code: `src/shared/agents.ts`
(the five kinds), `src/main/{sessions,containers,provision,agentProviders,planUsage,firstRun}.ts`,
`src/main/oauth/`, `src/shared/{agentConfig,clientConfig,planUsage,usage,credentials}.ts`
and the renderer components listed in §7.

Decide what you can derive from §1 yourself. Stop and ask the owner only when a
step would change user-visible behaviour beyond §6 or a persisted format (§4.6).

## 1. Why

The owner is building a plugin system and starts with agents. Three goals, in
order:

1. **A transparent core, independent of agents.** The core must not know any
   agent by name.
2. **Hand plugin maintenance to third parties.** Later phases will load agent
   plugins from outside the app (the owner's own registry service). This phase
   does not, but it must not shape the code in a way that blocks that.
3. **Learn plugin-system design on agents**, then extend the same approach to
   other things.

This phase delivers goal 1 only: every agent-specific fact and behaviour moves
out of the core into one folder per agent, and the core reaches agents only
through a registry. **Behaviour does not change** (§6).

## 2. Non-goals

Do none of these, even where the code invites it:

- Loading plugins from disk, the network or a registry. No plugin
  distribution, signing, install UI or versioning scheme. The owner's registry
  service covers that later; do not design for it beyond §4.5.
- The ACP Registry `agent.json` format, or any external manifest file format.
- Splitting a separate "provider" entity out of agents. The owner rejected it.
  OAuth sign-in configs move *into* the agent that uses them (§5.3).
- Changing how secrets reach the container (env var / materialized file stays
  exactly as is). No proxy-side token injection.
- New UI, new settings or new IPC methods. The renderer keeps reading agent
  data through a static import (§4.4).
- Bumping adapter versions or editing any pinned package string.
- Fixing unrelated bugs found on the way. List them in the As built section.
- Editing historical documents in `docs/` (anything other than
  architecture.md, docs/README.md and this file).

## 3. Terms

- **core**: `src/main`, `src/shared`, `src/renderer`, `src/preload`.
- **plugin**: one folder `src/plugins/agents/<id>/`, one per agent kind.
- **contract**: `src/shared/agentPlugin.ts`, the types (and only the neutral
  helpers) the core offers plugins. The core owns it; plugins implement it.
- **kind**: today's `AgentDef.id` (`claude-code`, `codex`, `gemini`,
  `opencode`, `pi`) — becomes the plugin id.

## 4. Layout and boundaries

```
src/shared/agentPlugin.ts        contract (core-owned): types + neutral defaults
src/plugins/agents/
  index.ts                       built-in list, shared half — main AND renderer import this
  main.ts                        built-in list, main-only half — only src/main imports this
  claude-code/
    manifest.ts                  pure data (§4.5)
    shared.ts                    optional: pure functions the renderer also needs
    main.ts                      optional: main-only hooks
  codex/  gemini/  opencode/  pi/   same shape; each file only if needed
```

1. **The core reaches plugins only through the two list files.** No core file
   imports `src/plugins/agents/<id>/…`. `src/renderer` and `src/shared` never
   import `src/plugins/agents/main.ts`.
2. **A plugin imports only the contract and npm packages already in
   `package.json`.** No imports from `src/main`, `src/renderer`, other
   `src/shared` modules, or another plugin. A shared type a plugin needs (e.g.
   `SessionConfigOption`) is re-exported from the contract. Anything a hook
   needs from the core — `fetch`, a logger, the clock, the session id — is a
   parameter. Duplicating a few lines between two plugins (e.g. the Anthropic
   API-key probe that opencode and pi share) is preferred over a cross-plugin
   import.
3. Rules 1–2 are enforced by ESLint (`no-restricted-imports` per file glob in
   `eslint.config.mjs`), not by convention.
4. **Shared halves are environment-neutral.** `manifest.ts`, `shared.ts` and
   `index.ts` are bundled into the renderer: no Node, no DOM. Add
   `src/plugins/**` to `tsconfig.node.json`; add only the shared halves to
   `tsconfig.web.json`. The renderer keeps a static import (via
   `src/plugins/agents/index.ts`) — moving it to IPC is a later phase, and
   going through the single list file is what makes that change local.
5. **A manifest is plain JSON-compatible data**: no functions, no `RegExp`
   objects (store regex *source strings*), no class instances, no `undefined`
   values. A unit test asserts `JSON.parse(JSON.stringify(m))` deep-equals `m`
   for every manifest. Reason: a later phase loads manifests from files, and
   whatever needs code must already be outside the manifest.
6. **Ids are persisted formats; keep them byte-identical.**
   - Plugin `id` = today's kind. It is stored as `AgentInstance.kind` in
     `~/.gurt/agents.json`, in the turn ledger (`TurnRecord.kind`), and read
     by `liftAgent`'s legacy layout.
   - OAuth `providerId` values `anthropic` / `openai` / `google` are stored in
     `credentials.json` — unchanged.
   - Plan-window ids (`five_hour`, `seven_day*`, `codex_*`, …) — unchanged.
   - Registry order = today's `AGENT_DEFS` order. The first entry is the
     default kind in Welcome and Settings → Clients.

## 5. The contract

Derive the exact contract from the inventory in §7. Principles:

1. **Data first, code only where data cannot express it.** A model list, a
   path, an env-var name, a regex, a window label, an icon: data. A response
   parser, an auth-file builder: code.
2. **Narrow.** Add a field or hook only because a current behaviour in §7 needs
   it. No speculative fields "for later".
3. **Optional with a neutral default.** A missing field or hook means "this
   agent does not have the feature". The core's behaviour for a missing hook
   must equal what today's code does for a kind that has no branch for it
   (e.g. no `skillsDir` → no skills mount; no probe → "not checked"; no plan
   usage → not polled, no meters).
4. **Hooks take plain values, not core objects.** Never pass `SessionManager`,
   a `Session`, the store or the bus into a plugin.
5. **Move the comments with the knowledge.** The provenance notes in
   `agents.ts`, `materialize.ts`, `planUsage.ts` etc. ("verified against
   codex-acp@2.2.2 …", "§5.2.1 …", the supply-chain note on exact pins) are
   the most valuable part of those files. They move into the plugin next to
   the value they explain. Comments left in the core may name an agent only as
   a passing example, never to explain a branch.

### 5.1 Starting sketch (non-binding)

This is a summary of the seams found in §7. Rename, merge or split as the
code requires.

```ts
// data — manifest.ts
interface AgentManifest {
  id: string; label: string; vendor: string                 // vendor: SettingsPage PROVIDER_VENDOR
  icon: { /* svg path data, viewBox */ color?: string }    // icons.tsx / tags.tsx BRAND_COLOR
  install: { packages: string[]; bin: string; args: string[] }
  secretEnv: string
  oauth: { providerId: string; label: string } | null      // label: OAUTH_PROVIDER_CHOICES
  skillsDir: string | null
  historyPaths: string[]
  clientConfig?: { path: string; examples: { label: string; json: string; secretEnv?: string }[] }
  seedConfig?: AgentConfig                                  // defaultAgentConfig / CLAUDE_MODELS
  toolTitle?: string[]                                      // regex sources: mcp__a__b, "Tool: a/b"
  modes?: { /* the vocabulary desiredModeId / BLANKET_MODE_RE / setMode use */ }
  limitText?: string[]                                      // regex sources, from shared/usage.ts
  planWindows?: { labels: Record<string,string>; durations?: Record<string,number>; meters?: string[] }
}

// code — shared.ts (renderer + main)
interface AgentSharedHooks {
  optionView?: AgentOptionView                              // agentConfig.ts VIEWS, resolveClaudeModel, withFable
}

// code — main.ts
interface AgentMainHooks {
  launchEnv?(p: { sessionId: string }): Record<string, string>      // CLAUDE_CODE_PROJECT_DIR_NAME
  authFile?(p: { /* oauth credential data, access token, now */ }): { path: string; content: string } | null
  oauth?: AuthCodeConfig & { /* extraData / account hooks the provider file has */ }
  probeToken?(token: string): { label: string; url: string; headers: Record<string, string> }
  sessionMeta?(configValues: Record<string, string>): Record<string, unknown> | undefined  // startMeta
  normalizeConfigOptions?(opts: SessionConfigOption[]): SessionConfigOption[]              // withFable
  usageMeta?(meta: Record<string, unknown>): { /* windows, overage, rejected, resetAt */ } | undefined
  planUsage?: { eligible(/* instance, credential */): true | { error: string }; fetch(/* secret, credential, fetch */): Promise</* windows, overage */ unknown> }
}
```

### 5.2 Engines stay in the core

Only the agent-specific half moves. These generic engines stay where they are
and start taking the plugin's data/hooks as input:

- the OAuth engine: `oauth/flow.ts`, refresh, single-flight
  `resolveOAuthAccess` (`oauth/index.ts`); `OAUTH_PROVIDERS` and
  `OAUTH_PROVIDER_CHOICES` are *derived* from the registry;
- the token probe's three verdicts and HTTP handling (`agentProviders.ts`
  `probeAgentToken`); only the per-kind request builder moves;
- plan usage polling, caching, holds and thresholds (`planUsage.ts`,
  `shared/planUsage.ts`); only parsers, endpoints, headers, eligibility, window
  labels and durations move;
- adapter install/launch, skills and history mounts (`provision.ts`,
  `containers.ts`), driven by manifest data as today;
- the mode picker, limit detector and tool-title parser, driven by the
  session's manifest vocabulary.

### 5.3 OAuth sign-in configs belong to their agent

The three files in `src/main/oauth/providers/` are not independent providers:
each one borrows the public OAuth client of one CLI (anthropic → Claude Code,
openai → Codex, google → Gemini CLI; see the BORROWED CLIENT_ID notes). Each
moves into that agent's `main.ts`, with the same `providerId`. The core builds
its provider table from the plugins that declare `oauth`. Today each provider
id is used by exactly one kind; keep the lookup by `providerId` so a stored
credential resolves exactly as before.

## 6. Behaviour

Unchanged for each of the five agents: same packages, commands, env, files
written into the container, mounts, ACP messages, UI text and icons. The only
allowed changes are listed here, and each one is recorded in the As built
section:

a. **Narrowed heuristics.** Some heuristics run today for every kind but use
   one agent's vocabulary: Claude Code's limit wording in `shared/usage.ts`,
   `yolo`/`acceptEdits`/`auto_review` in mode picking, the `mcp__a__b` tool
   title. Their vocabulary moves into the owning plugin, so they then run only
   for that agent's sessions. Before narrowing one, check whether another kind
   can produce that input (its adapter at the pinned version). If it can, put
   the vocabulary in that plugin too.
b. **Gurt-tools auto-allow.** `onPermission` in `sessions.ts` auto-allows
   `mcp__gurt__*` by matching Claude Code's title format only. `ToolStrip.tsx`
   records that codex titles MCP calls `Tool: gurt/complete`. Once tool titles
   are parsed per plugin, auto-allow uses the session's plugin. First verify
   that codex's *permission request* title has that form (adapter source at
   the pinned version, or a live run). If confirmed, codex gets auto-allow too:
   call this out as a fix. If not confirmed, keep today's behaviour exactly.
c. **`scripts/smoke-first-run.mjs`** asserts 4 kinds while there are 5. Derive
   the count from the registry.

Nothing else. In particular, do not "fix" the probe being keyed by kind rather
than by the instance's `secretEnv`. Note it in As built.

## 7. Inventory

Taken at `e673f9e`. Line numbers drift, so re-grep before relying on one.
Class: **D** data → manifest, **H** hook → plugin code, **E** engine stays in
the core, **U** renderer.

### Shared

- `src/shared/agents.ts`: `AgentDef` + `AGENT_DEFS` (five kinds) + `agentDef()`.
  **D**, and the bulk of the provenance comments. Becomes the five manifests
  plus a registry lookup; the file goes away or shrinks to re-exports during
  migration.
- `src/shared/agentConfig.ts`
  - `CLAUDE_MODELS`, `defaultAgentConfig(kind)`. **D** (`seedConfig`).
  - `withFable`, the `VIEWS` registry (`claudeCode` view), `resolveClaudeModel`. **H** (shared).
  - `withPickedValues`, `agentOptionView` fallback. **E**.
- `src/shared/clientConfig.ts`: `clientConfigPath` (claude / pi / opencode
  paths), `clientConfigFile` (throws for unsupported kinds), `clientConfigExample`. **D**.
- `src/shared/planUsage.ts`
  - `PLAN_WINDOW_LABELS` (Anthropic window keys). **D**.
  - `isOauthToken` (`/^sk-ant-oat/`). **H** (claude-code).
  - `windowElapsedPercent` hardcodes `five_hour`/`seven_day` durations. **D** (`durations`) + **E**.
  - Limit settings, `planHold`. **E**.
- `src/shared/usage.ts`: `LIMIT_PATTERNS` (Claude Code wording), `isLimitReply`,
  `limitResetAt` ("Claude AI usage limit reached|<epoch>"). Vocabulary **D**,
  matcher **E** (§6a).
- `src/shared/credentials.ts`: `OAUTH_PROVIDER_CHOICES` (hand-synced with
  main's `OAUTH_PROVIDERS`), derive it from the registry. The oauth `idToken`
  field is OpenAI-shaped; leave the stored shape alone.
- `src/shared/types.ts`, `src/shared/events.ts`: comments only (`_meta.claudeCode`,
  `auto_review`, "Claude response"). Reword.
- `src/shared/skills.ts`: the SKILL.md format is used by every kind. It stays
  in the core; its Claude Code references are provenance, not a branch.

### Main

- `src/main/containers.ts`
  - `resolveLaunch`: `agentDef(cfg.kind)`, `oauthAuthFile(def.id, …)`,
    `clientConfigFile(cfg.kind, …)`, and
    `def.id === 'claude-code' ? { CLAUDE_CODE_PROJECT_DIR_NAME: sessionId }`. **H** (`launchEnv`).
  - Skills and history mounts from `skillsDir`/`historyPaths`; `installAdapter`. **E**.
- `src/main/provision.ts`: `installAcpAdapter` (`npm install -g` + version
  marker), `spawnAcpAdapter`, `linkContainerSkills`, `linkContainerHistory`. **E**. Comments name kinds as examples.
- `src/main/sessions.ts`
  - `normalizeConfigOptions(raw, kind)`: `withFable` only for claude-code. **H**.
  - `modeKind` / `desiredModeId`: claude-code's `acceptEdits` → `auto` (`_meta.kind: auto_review`), codex's `yolo`. Vocabulary **D**, picker **E**.
  - `setMode`: `/bypass|yolo|accept|auto/` vs `/default|manual|ask|confirm/`. Same as above.
  - `startMeta`: `agent.id !== 'claude-code'` → undefined, else `{ claudeCode: { options: { model, effort } } }`, sent on `session/new` and `session/load`. **H**.
  - `set_config_option` `/invalid value/` pinning (claude-code behaviour). Check whether it is kind-gated; if it is, **H**.
  - `withLimit` → `isLimitReply`/`limitResetAt`. **E** + §6a.
  - `usage_update`: `agentKinds.get(agent) === 'claude-code'` → `parseClaudeRateLimitState(_meta['_claude/rateLimit'])`, emits `agent.planUsage`, may set `turnRejected`. **H** (`usageMeta`).
  - `onPermission`: `/^mcp__gurt__/` auto-allow. §6b.
  - `loadAgentKinds`, `defaultAgentConfig(kind)` fallbacks, the draft agent-change container release. **E**.
- `src/main/acp.ts`, `src/main/jsonrpc.ts`: tolerant parsing; comments name adapters. **E**.
- `src/main/agentProviders.ts`: `PROVIDERS` record keyed by kind (claude-code: `sk-ant-oat` → `/api/oauth/usage` with the oauth beta header and claude-cli user agent, else `/v1/models`; codex; gemini; opencode and pi: the Anthropic API-key probe). Request builders **H**, `probeAgentToken` **E**. `canProbeAgentToken` is used only by tests.
- `src/main/planUsage.ts`: `parsePlanWindows`, `parseClaudeRateLimit(State)`, `parseOverage(body, codex)`, `parseCodexPlanWindows`, endpoints (`api.anthropic.com/api/oauth/usage`, `chatgpt.com/backend-api/wham/usage`), `fetchUsage` headers, `poll` (codex needs `providerId === 'openai'`), `refreshAll` (polls only claude-code and codex; claude only with an oauth-shaped secret). Agent parts **H**, polling **E**. Wiring in `kernel.ts` (`freshCredential`) and `ipc.ts` (3-minute poll) stays.
- `src/main/oauth/`
  - `provider.ts`, `flow.ts`, `index.ts` (refresh, single-flight). **E**.
  - `providers/{anthropic,openai,google}.ts`. **H**, moved per §5.3.
  - `materialize.ts` `oauthAuthFile(agentKind, …)`: codex `.codex/auth.json`, gemini `.gemini/oauth_creds.json`, else env path. **H** (`authFile`). Its "verified against" notes cite older CLI versions than the current pins; keep them as they are and note this in As built.
- `src/main/firstRun.ts`: `probeAgentToken(kind)`, `def.label`, `def.oauthProvider`. Through the registry. **E**.
- `src/main/store.ts`: `STORED_AGENT`/`liftAgent` (legacy key = kind), `setAgents` validating `clientConfigFile`, the agent-config cache falling back to `defaultAgentConfig`. **E**.
- Smaller consumers: `credentials.ts` `migrateAgentSecrets`, `ipc.ts`/`adminWrites.ts` `setAgents` → `loadAgentKinds`, `adminSurface.ts` `getAgentConfig`. **E**.

### Renderer (all **U**, driven by manifest data or shared hooks)

- `components/tags.tsx`: `AGENT_ICONS` (kind → icon), `agentIcon()` falls back to `agent-generic`.
- `components/icons.tsx`: `agent-*` names in the `IconName` union, the brand-mark SVG paths, `BRAND_COLOR`. Brand marks move into manifests; `agent-generic` stays in the core as the fallback.
- `components/SettingsPage.tsx`: imports `AGENT_DEFS`; `PROVIDER_VENDOR`; a new client defaults to `'claude-code'` (→ first registry entry); config-JSON field gated on `clientConfigPath(kind)`; secret-env placeholder; `ANTHROPIC_BASE_URL` placeholder; the OpenRouter hint for opencode/pi that sets `secretEnv='OPENROUTER_API_KEY'`; "Example: no attribution" for claude-code; `ProviderCombo` over `AGENT_DEFS`; `ProviderPick` over `OAUTH_PROVIDER_CHOICES`.
- `components/Welcome.tsx`: default kind `AGENT_DEFS[0]`, `oauthProvider` → sign-in label, kind buttons, "has no sign-in", `API key for ${def.secretEnv}`.
- `components/ConfigTab.tsx`, `components/Chat.tsx`: `BLANKET_MODE_RE` (`/bypass|yolo/`), "does not support skills" when `skillsDir === null`, `agentOptionView(kind)`. Chat's word-count fallback for adapters without `usage_update` is generic; only its comment names codex.
- `components/ToolStrip.tsx` `parseMcp`: `mcp__srv__method` (claude-code) and `Tool: srv/method` (codex).
- `components/Dashboard.tsx` `PlanMeters`: `codex_*` window ids vs `['five_hour','seven_day']` with `5h`/`week` labels.
- Kind → icon sites: `CommandPalette.tsx`, `SessionPane.tsx`, `TaskPane.tsx`, `Sidebar.tsx`, `useAgents.ts`. `time.ts` has a comment only.

### Tests (`scripts/`)

These pin per-kind facts and must keep passing with the same expectations;
only their imports/bundle entry points change: `agent-providers`,
`skills-selection`, `session-history-mount`, `oauth-credentials`,
`plan-usage`, `plan-limits`, `usage`, `usage-ledger`, `client-config`,
`agent-config`, `session-mode`, `first-run`, `agent-migration` (all
`*.test.mjs`), plus fixtures that seed `'claude-code'`. Tests are not core:
they may import plugin folders directly. Do not weaken an assertion to make a
move pass.

## 8. Order of work

Keep `npm run typecheck`, `npm run lint` and `npm test` green at the end of
every step.

1. **Contract + registry + manifests.** Add `src/shared/agentPlugin.ts`, the two
   list files and five `manifest.ts` copied byte-for-byte from `AGENT_DEFS`
   (values *and* comments). Reimplement `agentDef()` over the registry, switch
   its callers, delete `AGENT_DEFS`. tsconfig and ESLint boundaries (§4.1–4.4)
   land here.
2. **Main-side hooks**, one seam at a time, in this order: `launchEnv`;
   `authFile`; OAuth configs (§5.3); probe request builders; client config
   paths and examples; plan usage (parsers, endpoints, eligibility, window
   labels and durations); ACP (`sessionMeta`, `normalizeConfigOptions`,
   `usageMeta`); vocabularies for limits, modes and tool titles, with §6a/§6b.
3. **Renderer**: icons and colours, vendor, Settings/Welcome hints and
   examples, option views, `BLANKET_MODE_RE`, `parseMcp`, plan meters — all
   through `src/plugins/agents/index.ts`.
4. **Gates** (§9).
5. **Docs**: in `architecture.md`, say where agents live and how to add one,
   and replace the inline package list in the start sequence with a pointer to
   the plugin folders. Update this document's row in `docs/README.md`. Append
   an **As built** section here (§10).

## 9. Acceptance

1. **Agent-agnostic core, machine-checked.** Add `scripts/agent-agnostic-core.test.mjs`
   (it runs under `npm test`). It tokenizes every `.ts`/`.tsx` file in the core
   with the TypeScript scanner (`typescript` is already a dependency) and fails
   on any string literal, template-literal part, regex literal or identifier
   matching
   `/claude|codex|gemini|opencode|anthropic|openai|chatgpt|google|sk-ant|mcp__|yolo|auto_review|five_hour|seven_day/i`,
   or equal to `pi` / starting with `pi-` (case-sensitive; `Math.PI` must not
   trip it). Comments are not tokens and are not checked; §5 principle 5
   governs them.
   Any exception sits in an allowlist inside the test, each entry with a
   reason, and is listed in As built. Aim for zero.
2. **ESLint boundaries** from §4.1–4.3 are on, and `npm run lint` passes.
3. **A sixth agent needs no core change.** A unit test builds a minimal,
   data-only fixture agent (no hooks) and runs it through the *real* core code
   paths: launch resolution (bin, args, secret env), no skills mount when
   `skillsDir` is null, no history mount, empty seed config, generic icon, probe
   → "not checked", not polled for plan usage, neutral mode/tool-title/limit
   behaviour. If a code path cannot take a fixture without a test-only seam,
   add the smallest seam (e.g. a registry built from a list) rather than
   re-implementing the path in the test. As built lists the exact steps to add
   an agent: one folder plus one line in each list file.
4. **Manifests round-trip through JSON** (§4.5) and the registry has unique ids
   equal to the persisted set `claude-code, codex, gemini, opencode, pi`.
5. **Nothing else changed.** `npm run typecheck`, `npm run lint` and `npm test`
   pass. These smoke scripts pass: `smoke-first-run`, `smoke-crud`,
   `smoke.linux`, `smoke-roles`, `smoke-operator`, `smoke-proactive`,
   `smoke-session-copy` (see development.md for how to run them). If Docker is
   available, also run `smoke-provisioning`. If a docker/token-dependent smoke
   cannot run in your environment, say so in As built rather than skipping it
   silently.

## 10. As built

Phase 1 as implemented on top of `e673f9e`.

### 10.1 The contract

`src/shared/agentPlugin.ts` (types only — nothing in it runs, so the renderer
can import it freely):

- **`AgentManifest`** — the data. The `AgentDef` fields keep their names and
  shape (`id`, `label`, `adapterPackages`, `bin`, `binArgs`, `secretEnv`,
  `oauthProvider`, `skillsDir`, `historyPaths`), plus `vendor`, `icon`
  (`AgentIcon`: one filled path in a 24×24 box, `fillRule?`, `color?`),
  `signIn?` (`{ account, label }` — "Sign in with your *account* account", and
  the picker/button label), `clientConfig?` (`{ path, example: { label,
  config, secretEnv? } }`), `instanceHints?` (`{ label, env }` placeholders),
  `seedConfig?` (an `AgentConfig`), `toolTitles?` (regex sources, group 1
  server, group 2 tool), `modes?` (`{ autoReviewKinds?, bypassWords? }`),
  `limits?` (`{ errors?, replies?, resetStamps? }`, regex sources, compiled
  case-insensitively) and `planWindows?` (`{ labels?, durations?: { match,
  seconds }[], meters?, meterLabels? }`).
- **`AgentPlugin`** — one entry of the shared list: `{ manifest, optionView? }`.
- **`AgentMainPlugin`** — one entry of the main list: `{ id, launchEnv?,
  authFile?, oauth?, probeToken?, sessionMeta?, normalizeConfigOptions?,
  usageMeta?, planUsage? }`, with `AgentOAuth` (`{ client: OAuthClient,
  account(tokens, tools), extraData?(tokens, current, tools) }`, `tools` =
  `{ fetch, idTokenClaims }` lent by the core) and `PlanUsagePoll`
  (`{ eligible(link), freshSignIn?, request(link), parse(body) }`).
- Re-exported for plugins: `AgentConfig`, `ConfigSelectOption`,
  `SessionConfigOption`, `PlanWindow`. `TokenSet` now lives here (re-exported
  by `main/oauth/provider.ts`); `AuthCodeConfig` (`main/oauth/flow.ts`)
  extends the contract's `OAuthClient`.

The core's side of the registry: `src/shared/agents.ts` (`AGENT_MANIFESTS`,
`DEFAULT_AGENT_KIND`, `agentPlugin()`, `agentDef()` — `AGENT_DEFS` is gone),
`src/main/agentPlugins.ts` (`agentMain()`, `agentMains()`) — both check their
list at load and throw on what they could not answer unambiguously
(`assertAgentManifests`: a kind declared twice, a sign-in without its name or
the reverse; `assertAgentMains`: two main halves of one kind, a main half
without a manifest, a sign-in declared twice, a sign-in other than the one its
manifest names, a manifest naming a sign-in no main half declares) — and
`src/shared/agentVocabulary.ts`, which compiles a kind's `modes` /
`toolTitles` / `limits` once and holds the core's plain mode words (`auto`,
`accept`, `bypass`; `default`, `manual`, `ask`, `confirm`).

Differences from the §5.1 sketch:

- Flat `AgentDef` field names instead of `install: {…}` and `oauth: {…}`, so
  the manifests are the `AGENT_DEFS` entries byte for byte and the pinned tests
  read the same fields; the sign-in's UI names went into a sibling `signIn`.
- No `viewBox` on `icon` (every mark is 24×24 — narrow); one `example` per
  `clientConfig`, not a list (each kind has one), holding the config as JSON
  data rather than a string.
- `instanceHints` is new: the Clients form's label/env placeholders.
- The `fable` merge is a main hook (`normalizeConfigOptions`), not part of the
  shared option view — only main ever ran it.
- `planUsage` does not fetch. The plugin says whether to poll (`eligible`, with
  `live` for "a live source may still fill this — keep what is cached"),
  whether the sign-in must be refreshed first (`freshSignIn`), what to GET
  (`request`) and how to read the body (`parse`); the HTTP call, its timeout,
  the 429/Retry-After handling, the cache, floor and single flight stay in
  `main/planUsage.ts`.
- `usageMeta` receives the whole `usage_update._meta`, not a pre-picked key.
- Hooks are function-typed properties, not methods: plain functions with no
  `this` (typescript-eslint's `unbound-method` holds the core to that).

### 10.2 Adding an agent

1. Create `src/plugins/agents/<id>/manifest.ts` exporting `manifest:
   AgentManifest`. The `id` is a persisted format — pick it once. Pin
   `adapterPackages` to exact versions and put the provenance of every value
   next to it.
2. Only for what data cannot express: `shared.ts` (exporting the shared hooks,
   e.g. `optionView`) and/or `main.ts` (exporting `main: AgentMainPlugin` with
   `id: manifest.id`). A plugin imports nothing but
   `../../../shared/agentPlugin`, its own folder and npm packages, and nothing
   in the folder imports its `main.ts` — only the main list does.
3. In `src/plugins/agents/index.ts`: import the manifest (and shared hooks) and
   add `{ manifest, … }` to `AGENT_PLUGINS`. Order is picker order; the first
   entry is the default kind.
4. With a `main.ts`: import it in `src/plugins/agents/main.ts` and add it to
   `AGENT_MAIN_PLUGINS`.
5. Extend the expected id list in `scripts/agent-plugins.test.mjs` (it pins the
   persisted set on purpose).

So: one folder, plus an import and an entry in each list file the plugin has a
half for. `scripts/agent-fixture.test.mjs` does steps 1 and 3 for a data-only
sixth agent at bundle time and runs it through the real core.

### 10.3 Behaviour changes (§6)

Evidence for a and b comes from the pinned packages (`npm pack`, read-only;
nothing executed): claude-agent-acp@0.94.0 with its SDK 0.3.303 binary,
codex-acp@2.2.2 with the @openai/codex@0.160.1 linux binary, gemini-cli@0.65.0,
opencode-linux-x64@1.19.3, pi-acp@0.0.34 and pi-coding-agent@1.4.0.

**a. Narrowed heuristics.** The core keeps what any provider might say; each
plugin carries its adapter's own words, read for its sessions only.

- *Limit wording* (`shared/usage.ts`). Core: rate limit, quota exceeded,
  "limit (will) reset", "too many requests", 429, and an ISO/unix stamp after
  "reset". claude-code: errors `hit your … limit`, `(session|weekly|hourly|
  daily|opus) limit`, `usage limit reached`; replies `hit your … limit`,
  `usage limit reached`, `limit reached … reset`; reset stamp `limit
  reached|<epoch>`. codex can produce the input too, so it gets `hit your …
  limit` (errors and replies): @openai/codex@0.160.1 words it "You’ve hit your
  usage limit. Upgrade to Plus…" / "…for {model}…", which codex-acp forwards
  as agent text and then as the failed prompt's error data
  (`codexErrorInfo: usageLimitExceeded`). Not added, because the text never
  reaches ACP: pi-coding-agent has "You have hit your ChatGPT usage limit…" but
  pi-acp@0.0.34 does not forward `message_end`/`errorMessage`; opencode's "…
  usage limit reached. It will reset in …" lives only in its session-retry
  status, which its ACP handler ignores; gemini's "Usage limit reached for
  {model}" lives only in its interactive UI (its ACP errors are "Rate limit
  exceeded. Try again later." — generic — and "You have exhausted your daily
  quota on this model."). Effect at the pins: none for any refusal an adapter
  actually sends; a gemini/opencode/pi *reply* in Claude's words is no longer
  filed as a limit hit.
- *Modes* (`desiredModeId`, `setMode`, the pickers' blanket filter). `yolo` →
  gemini (its modes: `default`, `autoEdit`, `yolo` "YOLO", `plan`); codex-acp
  has no yolo mode (`read-only`, `workspace-write`, `agent` "Auto review",
  `agent-full-access` "Full access"), so the old comments' "Codex's yolo" was
  stale. `auto_review` → claude-code and codex, the two whose modes carry it —
  but at the pins both nest it as `_meta.jetbrains.air.kind`, for JetBrains AIR
  clients only, and no adapter sends the top-level `_meta.kind` this reads, so
  the kind match is dormant (claude's `auto` is found by id, codex's "Auto
  review" by name). §6a also names `acceptEdits`: the core reads it through the
  plain word "accept", which stays core — an ordinary permission word, and only
  claude-agent-acp reports such a mode, so the choice is unobservable. opencode
  reports its agents (`build`, `plan`), pi-acp thinking levels. Effect: none.
- *Tool titles* (ToolStrip's MCP marks; the auto-allow below).
  `mcp__<server>__<tool>` → claude-code (claude-agent-acp titles a call, and
  its permission request, with the SDK tool name) and pi (pi-coding-agent names
  its MCP tools so and pi-acp titles calls by tool name — for servers in pi's
  own `mcp.json`, since ACP `mcpServers` never reach it). `Tool:
  <server>/<tool>` → codex, as read today (stale, see 10.5). gemini titles an
  MCP call `complete(args)` / `complete (gurt MCP Server)`, opencode
  `gurt_complete`: neither form. Effect: none.
- Also now plugin-driven, behaviour identical: the dashboard picks meters by
  kind (`planWindows.meters`, else every reported window) instead of by the
  `codex_` id prefix; a window that reports no duration is timed by its own
  kind's manifest (`windowElapsedPercent(window, now, kind)`), never by
  another plugin's; `defaultAgentConfig` and `clientConfigExample` return
  copies of the manifest data.

**b. Gurt-tools auto-allow: not confirmed, behaviour kept.** codex-acp@2.2.2
titles an ordinary MCP `tool_call` `mcp.<server>.<tool>`; an MCP approval
arrives from codex as an elicitation and is bridged to
`session/request_permission` with *no* title when it correlates with the
pending call (`toolCallId` of that call, `_meta.is_mcp_tool_approval`), and
titled "MCP tool call approval" when it does not. There is no `Tool: ` string
anywhere in codex-acp 2.2.2. Auto-allow now asks the session's plugin
(`toolTitles`, server `gurt`): claude-code as before, pi as before (it never
sends a tool permission request anyway), and nothing codex sends matches — so
codex sessions are still prompted, as today. Caveat: codex's `Tool:` pattern
does feed auto-allow; if a later codex-acp titled a permission request `Tool:
gurt/…`, it would be allowed — recheck with the pin bump.

**c.** `scripts/smoke-first-run.mjs` bundles the registry and asserts the
Welcome screen shows `AGENT_MANIFESTS.length` kinds (the old `4` already failed
against five kinds at `e673f9e`).

Untouched as required: the probe is still keyed by kind (10.5).

### 10.4 The §9.1 allowlist

The test checks JSX text too, which §9.1 does not list, and that is where both
exceptions are:

- `SettingsPage.tsx` (Settings → Skills) and `ConfigTab.tsx` (a session's
  skills): "A repository's own .claude/skills is the repository's…". UI prose,
  not a branch: a repo may carry skills in the convention SKILL.md comes from,
  which gurt deliberately neither lists nor manages (`shared/skills.ts`).
  Rewording would change UI text (§6); modelling it per kind would invent facts
  for the other four CLIs, and Settings → Skills has no kind to ask. The test
  also fails on an allowlist entry that no longer matches anything.

### 10.5 Found, not fixed

- The token probe is keyed by kind, not by the instance's `secretEnv`: an
  opencode/pi instance pointed at `OPENROUTER_API_KEY` is still probed against
  Anthropic.
- The "verified against" notes in the auth-file hooks (formerly
  `materialize.ts`, now `codex/main.ts`, `gemini/main.ts`) cite
  @openai/codex@0.153.4 / codex-acp@1.11.0 and gemini-cli@0.59.0, older than
  the pins (codex-acp@2.2.2 → @openai/codex@^0.160.1, gemini-cli@0.65.0). Kept
  verbatim.
- codex MCP titles: codex-acp@2.2.2 titles MCP calls `mcp.<server>.<tool>`, so
  codex chats show no MCP marks; the `Tool: <server>/<tool>` form gurt reads is
  stale.
- codex's blanket mode is `agent-full-access` ("Full access"); no word in
  either vocabulary marks it, so the pickers offer it and picking it leaves the
  auto/manual flag as it was. The `_meta.kind: auto_review` match is dormant at
  every pin (above).
- "Claude AI usage limit reached|<epoch>" and "5-hour limit reached ∙ resets"
  are not in SDK 0.3.303 (which builds "You've hit your {session|weekly|Opus|
  Sonnet|Fable|usage credit} limit · resets {time}"); kept for older SDKs.
- `canProbeAgentToken` is used only by tests; left as it was.
- `docs/development.md` says `scripts/*.test.mjs` is "currently 78" files
  (83 at `e673f9e`, 86 now); a historical doc under §2, not edited.
- Smokes that fail identically on an untouched build of `e673f9e` in this
  environment: `smoke-first-run` (`.placeholder` count is 2, not 1, and its
  relaunch leg times out because the first launch ends in Settings and Electron
  restores that view), `smoke.linux` ("client registry starts empty" counts the
  plan-limit row under the client list), `smoke-crud` (stops at a sidebar
  workspace check; it also needs docker).

### 10.6 Gates and runs

- `npm run typecheck`, `npm run lint`: pass. `npm test`: 802 tests, 796 pass;
  the 6 failures are `env-image-build.test.mjs`, which needs a docker CLI this
  environment does not have (the same 6 fail at `e673f9e`).
- New: `scripts/agent-agnostic-core.test.mjs` (§9.1; it self-tests that it sees
  literals, regexes, identifiers and JSX text and skips comments),
  `scripts/agent-plugins.test.mjs` (§9.4 plus main/shared consistency),
  `scripts/agent-fixture.test.mjs` (§9.3: launch resolution through the real
  `resolveLaunch` with only `ensure` and the install/proxy step stubbed, the
  adapter argv from `spawnAcpAdapter`, no skills/history mount, empty seed
  config, the generic icon rendered, no sign-in, probe "not checked", never
  polled, plain mode/tool-title/limit behaviour, no plan state from another
  agent's `_meta`, no window duration borrowed from another plugin), and
  `scripts/agent-plugin-boundaries.test.mjs`: the boundary rule against the
  spellings that slip past a string match (`./../`, `a//b`, a shared half
  re-exporting `./main`, `import()`, `require()`, type imports) and against
  what must stay allowed, plus a walk of the real import graph from the
  renderer's entry, the shared list and every `src/shared` file that fails —
  printing the chain — on any path to `src/main`, the main list or a plugin's
  `main.ts`; it self-tests the walk on a miniature tree.
- **§4.3 deviation:** the boundaries are one local ESLint rule
  (`scripts/lib/agent-plugin-boundaries.mjs`, wired in `eslint.config.mjs`)
  rather than `no-restricted-imports` patterns per glob. The patterns matched
  the specifier as written and were bypassable (review finding: `./../…`,
  `a//b`, and a shared half re-exporting `./main` all passed); the rule decides
  on the resolved, normalized path. A per-file rule still cannot see a chain
  of allowed hops, which is what the graph test is for.
- Pinned tests: only imports and bundle entries changed. Where a test called
  an engine that now takes a vocabulary without one, its bundle entry supplies
  one: `usage` (claude-code's limit words — the texts are Claude Code's),
  `session-mode` (every plugin's mode words at once — its mode lists come from
  several adapters), `plan-usage` (`withLimit` on a bare manager that maps the
  test's instance to claude-code; `parseOverage(body, codex)` composed from the
  two plugins' parsers; `windowElapsedPercent` for claude-code, whose window
  ids these are), `oauth-credentials` (codex's `extraData` with the core's
  `idTokenClaims`).
- Smokes, run against `npm run build` on Xvfb, each with its own
  `XDG_CONFIG_HOME`, and repeated on an untouched build of `e673f9e`:
  `smoke-roles`, `smoke-operator`, `smoke-proactive`, `smoke-session-copy`
  pass on both. `smoke-first-run`, `smoke.linux`, `smoke-crud` fail on both at
  the pre-existing points above. With only those pre-existing assertions
  relaxed (throwaway copies, not committed): `smoke.linux` passes end to end on
  both (client created with the default kind, persisted, linked); in
  `smoke-first-run` every step before the relaunch passes, including the kind
  count from the registry and the per-kind sign-in labels, where the baseline
  needs the old `4` relaxed as well. `smoke-provisioning` and the docker legs of
  `smoke-crud` were not run: no docker here.

### 10.7 What did not fit cleanly

- **Static examples that were one agent's for every kind.** The Clients form's
  "claude · personal" / `ANTHROPIC_BASE_URL=…` placeholders showed for every
  kind. They became per-kind `instanceHints` that fall back to the default
  (first) kind's — a field whose neutral default is another plugin's data. The
  `.claude/skills` prose (10.4) did not fit at all.
- **Window ids are not namespaced.** They are each provider's own keys (codex
  prefixes its ids, Anthropic's are bare), so a window's duration has to come
  from the kind it was reported for: `windowElapsedPercent` takes the kind.
  The first cut merged every manifest's durations by id, first match wins — a
  colliding id took another plugin's length (review finding, fixed). It means
  a plan window is only meaningful together with its kind.
- **Vocabularies are conventions, not types.** Limits compile
  case-insensitively, titles case-sensitively, a title needs two groups and a
  stamp one — documented per field and checked by a test, not by the type
  system. Where "plain words" end and an adapter's vocabulary begins
  (`accept`, `bypass` core; `yolo`, `auto_review` plugin) is a judgment call.
- **One vocabulary, two uses.** `toolTitles` drives both the chat's MCP marks
  and the gurt-tools auto-allow, but codex shows the two can differ (call
  `mcp.gurt.complete`, permission untitled). A separate permission-title field
  was not added (narrow), at the cost of 10.3b's caveat.
- **Hooks shaped by today's control flow.** Codex's post-refresh re-check lives
  in `request()` throwing "no ChatGPT sign-in linked"; the `live` flag on a
  plan-usage skip encodes how two hooks (`usageMeta`, `planUsage`) of the same
  plugin interact. Both preserve behaviour exactly; neither is a model a third
  party would guess.
- **Three ids that must agree.** `manifest.oauthProvider`, `signIn` and
  `main.oauth.client.id` are one fact in two halves, as is a main half's `id`.
  The types cannot say so; the registry checks it at load and throws.
- **Engines that used to need no context now do.** The mode picker, limit
  detector and title reader take a vocabulary, so every caller has to know the
  session's kind — which is why five pinned tests needed bundle-entry wrappers,
  and why ToolStrip and the gear popup grew an `agentKind` input.
- **Lent tools.** `fetch` and `idTokenClaims` reach OAuth hooks as parameters
  (rule 2); a hook exported for a test is then not callable without them.
- **Comments ship.** The renderer build is not minified, so manifest comments
  (provenance notes) are in the renderer bundle. Harmless — the main halves,
  with OAuth client ids and endpoints, are not — but a later phase that loads
  manifests from files loses them unless the file format keeps notes.
