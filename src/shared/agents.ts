// Agent definitions — pure data, shared by main and renderer.

export interface AgentDef {
  id: string
  label: string
  /** Devcontainer features injected at env start (agent runtime). */
  features: Record<string, object>
  /** npm packages installed globally in the container after up. */
  adapterPackages: string[]
  /** ACP adapter launch inside the container. */
  bin: string
  binArgs: string[]
  /** Default env var that receives the stored secret. */
  secretEnv: string
}

export const AGENT_DEFS: AgentDef[] = [
  {
    id: 'claude-code',
    label: 'claude code',
    features: { 'ghcr.io/anthropics/devcontainer-features/claude-code:1.0': {} },
    adapterPackages: ['@agentclientprotocol/claude-agent-acp'],
    bin: 'claude-agent-acp',
    binArgs: [],
    secretEnv: 'CLAUDE_CODE_OAUTH_TOKEN'
  },
  {
    id: 'codex',
    label: 'codex',
    features: {},
    // the adapter package bundles a compatible @openai/codex
    adapterPackages: ['@agentclientprotocol/codex-acp'],
    bin: 'codex-acp',
    binArgs: [],
    secretEnv: 'OPENAI_API_KEY'
  },
  {
    id: 'opencode',
    label: 'opencode',
    features: {},
    adapterPackages: ['opencode-ai'],
    bin: 'opencode',
    binArgs: ['acp'],
    secretEnv: 'ANTHROPIC_API_KEY'
  }
]

export const agentDef = (id: string): AgentDef | undefined => AGENT_DEFS.find((a) => a.id === id)
