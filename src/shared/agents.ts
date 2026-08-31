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
  /**
   * Where this kind discovers Claude-style skills (SKILL.md directories)
   * inside the container, relative to `$HOME` — the target
   * `linkContainerSkills` points at the read-only bind. `null` means the
   * pinned CLI reads no such directory: the session gets neither the mount
   * nor the link (it provisions as if the feature did not exist), and the
   * config tab says so instead of offering pickers
   * (docs/requirements-skills.md §5).
   *
   * Verified against the *pinned* adapter/CLI versions below, not against
   * whatever the projects ship today — a bump of a pin re-checks this field.
   */
  skillsDir: string | null
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
    secretEnv: 'CLAUDE_CODE_OAUTH_TOKEN',
    // Claude Code's own user-level skills directory — the path this feature
    // was built against (docs/requirements-skills.md §5).
    skillsDir: '.claude/skills'
  },
  {
    id: 'codex',
    label: 'codex',
    // the adapter package bundles a compatible @openai/codex
    adapterPackages: ['@agentclientprotocol/codex-acp@1.6.2'],
    bin: 'codex-acp',
    binArgs: [],
    secretEnv: 'OPENAI_API_KEY',
    // Verified in the @openai/codex@0.148.0 binary codex-acp@1.6.2 resolves
    // to: a default-on skills subsystem reads `~/.agents/skills` (canonical)
    // and `~/.codex/skills` (deprecated but still loaded) — SKILL.md format,
    // surfaced as `$<name>` commands over ACP. It never reads
    // `~/.claude/skills`. Link the canonical directory.
    skillsDir: '.agents/skills'
  },
  {
    id: 'gemini',
    label: 'gemini',
    // gemini cli speaks ACP itself (`--experimental-acp`) — no adapter package
    // besides the CLI, so `bin` is the CLI and the flag rides in `binArgs`.
    adapterPackages: ['@google/gemini-cli@0.56.0'],
    bin: 'gemini',
    binArgs: ['--experimental-acp'],
    secretEnv: 'GEMINI_API_KEY',
    // Verified in the @google/gemini-cli@0.56.0 tarball: Agent Skills are
    // default-on since v0.26.0 (`skillsSupport ?? true`), discovered from
    // `~/.gemini/skills` and the `~/.agents/skills` alias — SKILL.md
    // frontmatter format, activated through its `activate_skill` tool. It
    // never reads `~/.claude/skills`. Link the primary documented directory.
    skillsDir: '.gemini/skills'
  },
  {
    id: 'opencode',
    label: 'opencode',
    adapterPackages: ['opencode-ai@1.18.21'],
    bin: 'opencode',
    binArgs: ['acp'],
    secretEnv: 'ANTHROPIC_API_KEY',
    // Verified in the opencode-linux-x64@1.18.21 binary (the -ai package is a
    // wrapper): global skills load from `~/.config/opencode/{skill,skills}/`,
    // same SKILL.md frontmatter format. It also auto-reads `~/.claude/skills`,
    // but that compat scan sits behind opt-out env vars
    // (OPENCODE_DISABLE_EXTERNAL_SKILLS / …_CLAUDE_CODE[_SKILLS]) a user env
    // could set — the native config dir is unconditional, so link there.
    skillsDir: '.config/opencode/skills'
  }
]

export const agentDef = (id: string): AgentDef | undefined => AGENT_DEFS.find((a) => a.id === id)
