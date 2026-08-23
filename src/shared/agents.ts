// Agent definitions — pure data, shared by main and renderer.

export interface AgentDef {
  id: string
  label: string
  /**
   * npm packages installed globally in the container the first time this agent
   * connects to an env. The container itself is agent-agnostic (node feature
   * only) — no per-agent devcontainer features.
   */
  adapterPackages: string[]
  /** ACP adapter launch inside the container. */
  bin: string
  binArgs: string[]
  /** Default env var that receives the stored secret. */
  secretEnv: string
}

// Adapter packages are pinned to exact versions on purpose (supply chain):
// they are installed from npm at runtime inside user containers, so a mutable
// range would let a compromised release reach users without a gurt release.
// Bumping these versions happens only through gurt releases.
export const AGENT_DEFS: AgentDef[] = [
  {
    id: 'claude-code',
    label: 'claude code',
    // @agentclientprotocol/claude-agent-acp bundles the Claude Agent SDK — the
    // claude-code devcontainer feature is not needed.
    adapterPackages: ['@agentclientprotocol/claude-agent-acp@0.70.0'],
    bin: 'claude-agent-acp',
    binArgs: [],
    secretEnv: 'CLAUDE_CODE_OAUTH_TOKEN'
  },
  {
    id: 'codex',
    label: 'codex',
    // the adapter package bundles a compatible @openai/codex
    adapterPackages: ['@agentclientprotocol/codex-acp@1.6.2'],
    bin: 'codex-acp',
    binArgs: [],
    secretEnv: 'OPENAI_API_KEY'
  },
  {
    id: 'gemini',
    label: 'gemini',
    // gemini cli speaks ACP itself (`--experimental-acp`) — no adapter package
    // besides the CLI, so `bin` is the CLI and the flag rides in `binArgs`.
    adapterPackages: ['@google/gemini-cli@0.56.0'],
    bin: 'gemini',
    binArgs: ['--experimental-acp'],
    secretEnv: 'GEMINI_API_KEY'
  },
  {
    id: 'opencode',
    label: 'opencode',
    adapterPackages: ['opencode-ai@1.18.21'],
    bin: 'opencode',
    binArgs: ['acp'],
    secretEnv: 'ANTHROPIC_API_KEY'
  }
]

export const agentDef = (id: string): AgentDef | undefined => AGENT_DEFS.find((a) => a.id === id)
