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
  /** Model ids the user can pick between at session start; undefined = no picker. */
  models?: string[]
  /** Preselected entry from `models`. */
  defaultModel?: string
  /**
   * ACP permission modes offered in the new-session form, by their real adapter
   * mode id (see the adapter's `availableModes`). Some modes are conditional at
   * runtime (e.g. `auto` needs model support, `bypassPermissions` a non-root
   * sandbox) — the chosen id is applied only if the live session advertises it.
   */
  modes?: { id: string; label: string }[]
  /** Preselected entry from `modes`. */
  defaultMode?: string
}

export const AGENT_DEFS: AgentDef[] = [
  {
    id: 'claude-code',
    label: 'claude code',
    // @agentclientprotocol/claude-agent-acp bundles the Claude Agent SDK — the
    // claude-code devcontainer feature is not needed.
    adapterPackages: ['@agentclientprotocol/claude-agent-acp'],
    bin: 'claude-agent-acp',
    binArgs: [],
    secretEnv: 'CLAUDE_CODE_OAUTH_TOKEN',
    models: ['opus', 'sonnet', 'haiku'],
    defaultModel: 'opus',
    // Real adapter mode ids. `auto` (model-classifier) is the default; it needs
    // model support, so it falls back to `default`/Manual when unavailable.
    // `bypassPermissions`/`dontAsk` are intentionally omitted here — reach them
    // from the composer's mode switcher, not the start form.
    modes: [
      { id: 'auto', label: 'auto — model decides each permission' },
      { id: 'default', label: 'manual — confirm dangerous operations' },
      { id: 'acceptEdits', label: 'accept edits — auto-accept file edits' },
      { id: 'plan', label: 'plan — no tool execution' }
    ],
    defaultMode: 'auto'
  },
  {
    id: 'codex',
    label: 'codex',
    // the adapter package bundles a compatible @openai/codex
    adapterPackages: ['@agentclientprotocol/codex-acp'],
    bin: 'codex-acp',
    binArgs: [],
    secretEnv: 'OPENAI_API_KEY'
  },
  {
    id: 'opencode',
    label: 'opencode',
    adapterPackages: ['opencode-ai'],
    bin: 'opencode',
    binArgs: ['acp'],
    secretEnv: 'ANTHROPIC_API_KEY'
  }
]

export const agentDef = (id: string): AgentDef | undefined => AGENT_DEFS.find((a) => a.id === id)
