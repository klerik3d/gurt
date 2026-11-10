// opencode — the opencode CLI, which speaks ACP itself (`opencode acp`).
import type { AgentManifest } from '../../../shared/agentPlugin'

// Adapter packages are pinned to exact versions on purpose (supply chain):
// they are installed from npm at runtime inside user containers, so a mutable
// range would let a compromised release reach users without a gurt release.
// Bumping these versions happens only through gurt releases.
export const manifest: AgentManifest = {
  id: 'opencode',
  label: 'opencode',
  vendor: 'local',
  // The project's actual logo (nominative use: it only ever labels "this
  // session runs opencode", unmodified, never as gurt's own mark). Path data
  // from lobehub/lobe-icons (MIT-packaged; the mark itself remains the
  // project's trademark, per that project's README). No colour: opencode has
  // no signature colour in its own branding, so the mark takes the text's.
  icon: { path: 'M16 6H8v12h8V6zm4 16H4V2h16v20z', fillRule: 'evenodd' },
  adapterPackages: ['opencode-ai@1.19.5'],
  bin: 'opencode',
  binArgs: ['acp'],
  secretEnv: 'ANTHROPIC_API_KEY',
  // No sign-in path: docs/requirements-oauth-credentials.md §5.2.1 verified
  // delivery for the three kinds above and not for this one. Pointing it at
  // the anthropic provider would buy a browser round-trip and a failure at
  // session start; a pasted key is the honest answer until that is checked.
  oauthProvider: null,
  // Verified in the opencode-linux-x64@1.19.3 binary (the -ai package is a
  // wrapper): global skills load from `~/.config/opencode/{skill,skills}/`,
  // same SKILL.md frontmatter format. It also auto-reads `~/.claude/skills`,
  // but that compat scan sits behind opt-out env vars
  // (OPENCODE_DISABLE_EXTERNAL_SKILLS / …_CLAUDE_CODE[_SKILLS]) a user env
  // could set — the native config dir is unconditional, so link there.
  skillsDir: '.config/opencode/skills',
  // No phase — verified permanently empty (docs/requirements-agent-history.md
  // §3.3). opencode-ai@1.19.3 keeps sessions, messages and parts in
  // `~/.local/share/opencode/opencode.db`, and its `account` /
  // `control_account` / `credential` rows — live OAuth tokens — sit in that
  // same sqlite file. There is no path that separates the transcript from
  // the secret, so this stays `[]` unless upstream splits the store.
  historyPaths: [],

  clientConfig: {
    path: '.config/opencode/opencode.json',
    example: {
      label: 'OpenRouter',
      secretEnv: 'OPENROUTER_API_KEY',
      config: {
        $schema: 'https://opencode.ai/config.json',
        model: 'openrouter/anthropic/claude-sonnet-4.5',
        provider: {
          openrouter: {
            options: { apiKey: '{env:OPENROUTER_API_KEY}' },
            models: { 'anthropic/claude-sonnet-4.5': {} }
          }
        }
      }
    }
  }
}
