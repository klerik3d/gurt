// The agent plugin contract (docs/requirements-agent-plugins.md): everything
// the core offers an agent plugin, and everything a plugin may hand back.
// Core-owned — plugins implement it; a plugin that needs more asks for a field
// here rather than reaching into the core.
//
// One plugin is one folder, `src/plugins/agents/<id>/`:
//
//   manifest.ts  pure, JSON-compatible data — an `AgentManifest`
//   shared.ts    optional: pure code the renderer needs too — `AgentPlugin` hooks
//   main.ts      optional: main-process hooks — an `AgentMainPlugin`
//
// and the core reaches it only through the two list files beside those
// folders: `src/plugins/agents/index.ts` (main and renderer) and
// `src/plugins/agents/main.ts` (main only). A plugin imports nothing but this
// file and npm packages (both enforced by eslint.config.mjs).
//
// Three rules shape every type below:
//
//   - **Data first.** A list, a path, an env-var name, a label, a regex (as its
//     source string) is manifest data; code only where data cannot say it. A
//     manifest has to survive `JSON.parse(JSON.stringify(m))` unchanged, so
//     that a later phase can load one from a file.
//   - **Optional means absent.** A missing field or hook is "this agent does
//     not have the feature", and the core then behaves exactly as it does for
//     a kind it knows nothing about: no mount, no probe, no polling, no meters.
//   - **Plain values in, plain values out.** A hook never sees a core object —
//     no session, store or bus. What it needs from the core (fetch, the clock,
//     the session id) arrives as a parameter.
//
// Types only, on purpose: the renderer bundles the shared halves, so nothing
// here may pull Node or the DOM in at runtime.

import type { AgentConfig, ConfigSelectOption, SessionConfigOption } from './types'
import type { PlanWindow } from './planUsage'

export type { AgentConfig, ConfigSelectOption, SessionConfigOption, PlanWindow }

/** Anything `JSON.stringify` round-trips — the only values a manifest holds. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

// --- the manifest: data ------------------------------------------------------

/**
 * One agent kind, as data. Read by main and the renderer alike.
 *
 * The first block is what a session needs to run the agent at all; everything
 * from `clientConfig` on is optional and drives one core feature each.
 */
export interface AgentManifest {
  /**
   * The kind. A persisted format, not a name: stored as `AgentInstance.kind`
   * in `~/.gurt/agents.json`, as `TurnRecord.kind` in the turn ledger, and
   * read as the key of the legacy per-kind agents.json layout (`liftAgent`).
   * Never rename one.
   */
  id: string
  label: string
  /** Whose product this is — shown beside the label in Settings → Clients'
   *  provider picker, and searched by it. */
  vendor: string
  /** The kind's mark wherever an agent is labelled. Absent: the generic agent
   *  glyph. */
  icon?: AgentIcon
  /**
   * npm packages installed globally in the container the first time this agent
   * connects to an env. The container itself is agent-agnostic (gurt's node runtime
   * volume only) — no per-agent image changes.
   */
  adapterPackages: string[]
  /** ACP adapter launch inside the container. */
  bin: string
  binArgs: string[]
  /** Default env var that receives the stored secret. */
  secretEnv: string
  /**
   * Which OAuth provider (the `oauth` hook of a plugin's main half, by
   * `OAuthClient.id`) signs this kind in, or null when the kind has no
   * sign-in path and needs a pasted API key. Sits beside {@link secretEnv}
   * because it answers the same question — how this kind is authenticated —
   * and because §5.2.1 of docs/requirements-oauth-credentials.md already
   * makes *delivery* a per-kind fact (`AgentMainPlugin.authFile`).
   *
   * A kind is only listed here once that document says how its CLI consumes a
   * subscription sign-in. Guessing would produce a "Sign in" button that
   * completes a browser round-trip and then fails at session start, which is a
   * worse outcome than asking for a key.
   *
   * Persisted: the value is stored as an oauth credential's `providerId` in
   * credentials.json.
   */
  oauthProvider: string | null
  /** How the sign-in is named in the UI — present exactly when
   *  {@link oauthProvider} is. `account` completes "Sign in with your …
   *  account"; `label` is the provider picker's entry and the Welcome
   *  screen's "Sign in with …" button. */
  signIn?: { account: string; label: string }
  /**
   * Where this kind discovers Claude-style skills (SKILL.md directories)
   * inside the container, relative to `$HOME` — the target
   * `linkContainerSkills` points at the read-only bind. `null` means the
   * pinned CLI reads no such directory: the session gets neither the mount
   * nor the link (it provisions as if the feature did not exist), and the
   * config tab says so instead of offering pickers
   * (docs/requirements-skills.md §5).
   *
   * Verified against the *pinned* adapter/CLI versions, not against whatever
   * the projects ship today — a bump of a pin re-checks this field.
   */
  skillsDir: string | null
  /** The `$HOME`-relative paths this kind persists its own conversation and
   *  resume state in, each linked into the read-write bind by
   *  `linkContainerHistory`. Empty means no delivery at all: the session
   *  provisions exactly as it does today.
   *
   *  A **list**, not a single directory, because no CLI examined keeps all
   *  of it in one place (§3.1) — and every entry MUST be separable from
   *  that kind's credential file (§6.2). A kind whose transcript cannot be
   *  separated from its secrets gets `[]` and stays there (§3.3).
   *
   *  Verified against the *pinned* versions, not whatever the projects ship
   *  today — a pin bump re-checks this field, same rule as `skillsDir`.
   *  (docs/requirements-agent-history.md §3) */
  historyPaths: readonly string[]

  /** The CLI's native settings file, written from an instance's config JSON
   *  on every adapter launch. Absent: the kind takes no config JSON, and
   *  Settings → Clients offers no field for it. */
  clientConfig?: ClientConfigSpec
  /** Example values Settings → Clients shows as placeholders while an instance
   *  of this kind is edited: `label` for its name, `env` for one line of extra
   *  env. A kind without them shows the default (first) kind's. */
  instanceHints?: { label: string; env: string }
  /** The config surface offered before a live session of this kind has ever
   *  reported its own (`defaultAgentConfig`). Absent: nothing — no model row,
   *  no commands. */
  seedConfig?: AgentConfig
  /** How the adapter titles an MCP tool call — regex sources, case-sensitive,
   *  group 1 the server and group 2 the tool. Drives the chat's MCP marks and
   *  the auto-allow of gurt's own tools. Absent: no title reads as MCP. */
  toolTitles?: string[]
  /** What the adapter's modes say beyond the plain words the core already
   *  reads. */
  modes?: ModeVocabulary
  /** How the adapter words a plan-limit refusal, beyond the generic
   *  rate-limit/429/quota wording the core already reads. */
  limits?: LimitVocabulary
  /** How the provider's plan windows are labelled, timed and drawn. */
  planWindows?: PlanWindowSpec
}

/** A brand mark: one filled path in a 24×24 box. */
export interface AgentIcon {
  /** SVG path data. */
  path: string
  /** For marks whose holes are cut by winding. */
  fillRule?: 'evenodd'
  /** The brand's own colour; absent, the mark takes the text colour. */
  color?: string
}

export interface ClientConfigSpec {
  /** `$HOME`-relative path of the native settings file — fixed, never
   *  user-supplied. */
  path: string
  /** What the "Example: {label}" button fills the config field with. With
   *  `secretEnv`, the button also points the instance's secret at that
   *  variable, and the field's hint says so ("For {label}, set Secret env var
   *  to {secretEnv}."). */
  example: { label: string; config: JsonObject; secretEnv?: string }
}

/**
 * The core picks and reads modes by plain words — `auto`, `accept`, `bypass`
 * for the auto side, `default`, `manual`, `ask`, `confirm` for the manual one
 * (main/sessions.ts `desiredModeId`, `setMode`; the renderer's mode pickers).
 * A plugin adds what its adapter says beyond them.
 */
export interface ModeVocabulary {
  /** `_meta.kind` values marking the adapter's auto-review mode: review the
   *  risky calls, accept the rest. gurt's "auto" asks for one of these before
   *  anything else. */
  autoReviewKinds?: string[]
  /** Lowercase words that, in a mode's id or name, mark a blanket permission
   *  bypass — besides "bypass" itself. Such a mode is hidden from the pickers,
   *  is gurt's "auto" only when nothing safer exists, and reads as auto-allow
   *  when picked. */
  bypassWords?: string[]
}

/**
 * Regex sources, all compiled case-insensitively. The core keeps the wording
 * any provider might use (rate limit, quota, 429, "too many requests", "limit
 * will reset", an ISO or unix reset stamp) and runs a plugin's own wording only
 * for that plugin's sessions.
 */
export interface LimitVocabulary {
  /** An error or stop text that means the plan, not the code, ended the turn. */
  errors?: string[]
  /** A whole short agent reply that *is* a limit notice — for adapters that
   *  answer a refused turn as ordinary text and a clean `end_turn`. */
  replies?: string[]
  /** A refusal carrying its reset as a unix stamp (seconds or ms) in group 1. */
  resetStamps?: string[]
}

export interface PlanWindowSpec {
  /** Display label per window id the provider reports; an id with none is
   *  humanized. Read by the plugin's own parsers. */
  labels?: Record<string, string>
  /** Length of windows whose reports carry no duration — `match` is a regex
   *  source tested against the whole window id. Drives the dashboard's
   *  time-elapsed bar. */
  durations?: { match: string; seconds: number }[]
  /** The windows the dashboard card always draws, in this order — a missing
   *  one as "—". Absent: every reported window, in reported order. */
  meters?: string[]
  /** The card's short label per window id; absent, the window's own label. */
  meterLabels?: Record<string, string>
}

// --- the shared half: pure code main and the renderer both run --------------

/**
 * How an agent kind's config options are *presented* — which select entries
 * become chips and which value reads as active. Pure display: nothing here may
 * change what is sent back to the agent.
 */
export interface AgentOptionView {
  /** The entries to render as chips for a select option. */
  selectOptions(opt: SessionConfigOption): ConfigSelectOption[]
  /** The value to highlight as active. */
  activeValue(opt: SessionConfigOption): string | boolean
}

/** One entry of the shared list (`src/plugins/agents/index.ts`). */
export interface AgentPlugin {
  manifest: AgentManifest
  /** Absent: options are shown exactly as the adapter reports them. */
  optionView?: AgentOptionView
}

// --- the main half: hooks only the main process runs -------------------------

/** One entry of the main-only list (`src/plugins/agents/main.ts`). Every hook
 *  is optional; `id` pairs it with the manifest of the same id. */
export interface AgentMainPlugin {
  id: string
  /** Extra non-secret env for every adapter launch, composed under the
   *  instance's own env (which wins on a clash). */
  launchEnv?: (p: { sessionId: string }) => Record<string, string>
  /**
   * The CLI's native auth file for an oauth sign-in, written into the
   * container before the adapter spawns — access token only, the refresh
   * token never enters a container. Returning a file also keeps the
   * `secretEnv` var unset. Null (or no hook): the access token rides
   * `secretEnv`. May throw a sentence the user can act on.
   */
  authFile?: (p: { credential: CredentialView; access: string; now: number }) => AuthFile | null
  /** The sign-in this kind's {@link AgentManifest.oauthProvider} names. */
  oauth?: AgentOAuth
  /** One authenticated GET that creates nothing and consumes no tokens —
   *  whether the provider accepts a pasted token. The core makes the request
   *  and reads the status. Absent: "not checked". */
  probeToken?: (token: string) => TokenProbeRequest
  /** `_meta` for `session/new` and `session/load`, from the session's own
   *  config picks. Undefined: none sent. */
  sessionMeta?: (configValues: Readonly<Record<string, string | boolean>>) => Record<string, unknown> | undefined
  /** A last pass over every config option list the adapter reports. */
  normalizeConfigOptions?: (options: SessionConfigOption[]) => SessionConfigOption[]
  /** Plan state riding a `usage_update`'s `_meta` — read on every update of
   *  this kind's sessions. */
  usageMeta?: (meta: Readonly<Record<string, unknown>> | undefined) => LivePlanState
  /** Polling the provider's plan usage. Absent: never polled. */
  planUsage?: PlanUsagePoll
}

/** A stored credential as a hook sees it. */
export interface CredentialView {
  id: string
  /** `oauth`, `agent-token`, … */
  kind: string
  label: string
  data: Readonly<Record<string, string>>
}

export interface AuthFile {
  /** Path relative to the container `$HOME`. */
  path: string
  /** The exact file content. */
  content: string
}

export interface TokenProbeRequest {
  /** Who is being asked, in the sentence the user reads ("Anthropic"). */
  label: string
  url: string
  headers: Record<string, string>
}

/** What a live usage event says, when it says anything. */
export interface LivePlanState {
  windows: PlanWindow[]
  /** Overage (extra usage) can absorb an exhausted window. */
  overage?: boolean
  /** The request was refused (`true`) or accepted (`false`). */
  rejected?: boolean
  /** The refusal's own reset instant (ISO). */
  rejectedUntil?: string
}

/** What an agent instance is linked to, resolved by the core. */
export interface AgentLink {
  /** The secret the link resolves to — '' when there is none. */
  secret: string
  credential?: CredentialView | undefined
  /** Why the link does not resolve, when it does not. */
  error?: string | undefined
}

export interface PlanUsagePoll {
  /**
   * Whether an instance on this link has a plan to poll. A skip names why
   * not. `live` says the numbers can still arrive with session responses
   * (`usageMeta`): the core then keeps whatever it holds and shows the reason
   * only while it holds nothing. Without it the reason replaces the snapshot.
   */
  eligible: (link: AgentLink) => true | { error: string; live?: boolean }
  /** Refresh the linked sign-in before every poll and resolve the link anew,
   *  the way a session launch does. */
  freshSignIn?: boolean
  /** The GET to make. Throwing ends the poll with that message. */
  request: (link: AgentLink) => { url: string; headers: Record<string, string> }
  /** Windows and overage out of a 200 body. No windows means a body the
   *  parser cannot read, and the core keeps the previous ones. */
  parse: (body: unknown) => { windows: PlanWindow[]; overage: boolean }
}

/** Display-safe token set of one sign-in. */
export interface TokenSet {
  access: string
  refresh: string
  /** When `access` expires (ISO 8601). */
  expiresAt: string
  /** Display identity of the signed-in user ("jane@example.com"). */
  account: string
  /**
   * Provider-specific extra entry `data` (§2: legal, named by the provider)
   * — e.g. an `idToken`/`accountId` a CLI's native auth file needs (§5.2.1).
   * Persisted alongside the core fields; a key declared secret in
   * CREDENTIAL_KINDS seals and redacts like the tokens.
   */
  extra?: Record<string, string>
}

/** How one provider's authorization-code flow differs — the data the core's
 *  OAuth engine (main/oauth/flow.ts) runs. */
export interface OAuthClient {
  /** Provider id — stored as an oauth credential's `providerId`, and named in
   *  error sentences ("anthropic answered: …"). */
  id: string
  authorizationEndpoint: string
  tokenEndpoint: string
  clientId: string
  /** Google installed-app registrations carry a *published* "secret" (it ships
   *  in the official CLI's source); the flow is still a public client with
   *  PKCE — this is not a confidential-client credential. */
  clientSecret?: string
  scopes: string[]
  /** Extra authorize-URL params (`access_type=offline`, …). */
  authParams?: Record<string, string>
  /** How the token endpoint wants its body: RFC 6749 form encoding, or JSON. */
  tokenBody: 'form' | 'json'
  /** Loopback port the borrowed registration pins; 0/absent = random, per
   *  RFC 8252 and §4. The listener binds 127.0.0.1 either way. */
  port?: number
  /** Path of the registered redirect; default `/callback`. */
  redirectPath?: string
  /** Hostname the registered redirect_uri spells (`localhost` for the CLIs
   *  that registered it that way); the socket still binds 127.0.0.1 only. */
  redirectHost?: string
}

/** What the core lends an OAuth hook. */
export interface OAuthTools {
  fetch: typeof fetch
  /** The payload claims of a JWT, or {} — no signature check. */
  idTokenClaims: (idToken: unknown) => Record<string, unknown>
}

export interface AgentOAuth {
  client: OAuthClient
  /** The display identity out of a token response. */
  account: (tokens: Record<string, unknown>, tools: OAuthTools) => Promise<string> | string
  /** Provider-specific extra `TokenSet.extra` fields mined from a token
   *  response (§2). On the refresh grant it also receives the current set,
   *  so a value the response omits (a non-rotated id_token, say) can be
   *  carried forward instead of erased. */
  extraData?: (
    tokens: Record<string, unknown>,
    current: TokenSet | undefined,
    tools: OAuthTools
  ) => Record<string, string>
}
