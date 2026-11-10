// gemini — Google's Gemini CLI, which speaks ACP itself.
import type { AgentManifest } from '../../../shared/agentPlugin'

// Adapter packages are pinned to exact versions on purpose (supply chain):
// they are installed from npm at runtime inside user containers, so a mutable
// range would let a compromised release reach users without a gurt release.
// Bumping these versions happens only through gurt releases.
export const manifest: AgentManifest = {
  id: 'gemini',
  label: 'gemini',
  vendor: 'Google',
  // The provider's actual logo (nominative use: it only ever labels "this
  // session runs Gemini", unmodified, never as gurt's own mark). Path data from
  // lobehub/lobe-icons (MIT-packaged; the mark itself remains the vendor's
  // trademark, per that project's README).
  icon: {
    path: 'M12 24A14.304 14.304 0 000 12 14.304 14.304 0 0012 0a14.305 14.305 0 0012 12 14.305 14.305 0 00-12 12',
    fillRule: 'evenodd',
    color: '#4285F4'
  },
  // gemini cli speaks ACP itself (`--experimental-acp`) — no adapter package
  // besides the CLI, so `bin` is the CLI and the flag rides in `binArgs`.
  adapterPackages: ['@google/gemini-cli@0.66.0'],
  bin: 'gemini',
  binArgs: ['--experimental-acp'],
  secretEnv: 'GEMINI_API_KEY',
  // §5.2.1: fed through a materialized `~/.gemini/oauth_creds.json`, env var
  // likewise suppressed.
  oauthProvider: 'google',
  signIn: { account: 'Gemini', label: 'Gemini (Google)' },
  // Verified in the @google/gemini-cli@0.65.0 tarball: Agent Skills are
  // default-on since v0.26.0 (`skillsSupport ?? true`), discovered from
  // `~/.gemini/skills` and the `~/.agents/skills` alias — SKILL.md
  // frontmatter format, activated through its `activate_skill` tool. It
  // never reads `~/.claude/skills`. Link the primary documented directory.
  skillsDir: '.gemini/skills',
  // Not phase 1 (docs/requirements-agent-history.md §10 item 2): the
  // transcripts live in `.gemini/tmp`/`.gemini/history`, plus the
  // `projects.json` registry file that assigns the shortId — the first
  // kind that needs §3.1's file-entry case. Empty until that phase.
  historyPaths: [],
  instructionPaths: ['GEMINI.md', '.gemini/'],

  // Verified in the @google/gemini-cli@0.65.0 bundle: its ACP modes are
  // `default`, `autoEdit` ("Auto Edit"), `yolo` ("YOLO") and, with plan mode
  // on, `plan`. YOLO approves every tool call — a blanket bypass.
  modes: { bypassWords: ['yolo'] }
}
