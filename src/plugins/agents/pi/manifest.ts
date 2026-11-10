// pi — the pi coding agent, through the pi-acp bridge.
import type { AgentManifest } from '../../../shared/agentPlugin'

// Adapter packages are pinned to exact versions on purpose (supply chain):
// they are installed from npm at runtime inside user containers, so a mutable
// range would let a compromised release reach users without a gurt release.
// Bumping these versions happens only through gurt releases.
export const manifest: AgentManifest = {
  id: 'pi',
  label: 'pi',
  vendor: 'local',
  // pi ships no mark of its own here — a plain π glyph, drawn for gurt. Not a
  // brand mark, so no brand colour: it takes the text's.
  icon: { path: 'M3 4h18v3h-4v10.5c0 .83.67 1.5 1.5 1.5H20v3h-1.5a4.5 4.5 0 0 1-4.5-4.5V7h-4v14H7V7H3z' },
  // pi itself speaks only its own RPC (`pi --mode rpc`); pi-acp is the ACP
  // bridge and spawns `pi` from PATH, so the CLI is installed beside it —
  // the adapter does not depend on it. pi-acp@0.0.34 asks for pi >= 0.81
  // and names @earendil-works/pi-coding-agent (fka @mariozechner/…) as the
  // package; that CLI needs node >= 22.19, which gurt's node runtime (the
  // LTS pinned in NODE_RUNTIME_IMAGE) covers.
  //
  // MCP does not reach this kind yet: pi-acp@0.0.34 advertises
  // `mcpCapabilities: { http: false, sse: false }` and keeps the
  // `session/new` `mcpServers` without handing them to pi (which reads its
  // own `~/.pi/agent/mcp.json` instead). So the gurt server — and with it
  // `complete` — is invisible to pi, and every turn ends in the nudge and
  // then `incomplete` (docs/requirements-turn-contract.md §4).
  // The same fact as the paragraph above, as data: a review loop reads it to
  // refuse pi as executor and not offer it as reviewer.
  acpMcp: false,
  adapterPackages: ['pi-acp@0.0.34', '@earendil-works/pi-coding-agent@1.5.0'],
  bin: 'pi-acp',
  binArgs: [],
  // pi is multi-provider and reads each provider's standard key variable
  // (its docs/providers.md); Anthropic's is the default here, the same as
  // opencode — an instance pointed elsewhere renames the env var.
  secretEnv: 'ANTHROPIC_API_KEY',
  // No sign-in path: pi's own `/login` stores OAuth tokens in
  // `~/.pi/agent/auth.json`, a delivery docs/requirements-oauth-credentials.md
  // §5.2.1 has not verified. A pasted key until it has.
  oauthProvider: null,
  // Verified in the @earendil-works/pi-coding-agent@1.4.0 docs (skills.md)
  // and pi-acp@0.0.34's startup listing: global skills load from
  // `<agentDir>/skills`, agentDir defaulting to `~/.pi/agent`, plus the
  // `~/.agents/skills` alias — SKILL.md format, surfaced as `/skill:<name>`.
  // Link the native directory.
  skillsDir: '.pi/agent/skills',
  // Not yet: transcripts live in `.pi/agent/sessions` (grouped by cwd) and
  // pi-acp keeps its ACP→pi map in `.pi/pi-acp/session-map.json` with
  // absolute session-file paths, while `auth.json` sits in `.pi/agent`
  // beside the sessions directory. Separable, but the resume path needs a
  // live check first — the codex rule (docs/requirements-agent-history.md).
  historyPaths: [],

  // pi names an MCP tool `mcp__<server>__<tool>` (pi-coding-agent@1.4.0
  // extensions/mcp/tools.js) and pi-acp@0.0.34 titles a tool call with the
  // tool's name — for the servers in pi's own `mcp.json`, since the ACP
  // `mcpServers` never reach it (see `adapterPackages`).
  toolTitles: ['^mcp__(.+?)__(.+)$'],

  clientConfig: {
    path: '.pi/agent/settings.json',
    example: {
      label: 'OpenRouter',
      secretEnv: 'OPENROUTER_API_KEY',
      config: { defaultProvider: 'openrouter', defaultModel: 'anthropic/claude-sonnet-4.5' }
    }
  }
}
