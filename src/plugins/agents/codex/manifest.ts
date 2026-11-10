// codex — OpenAI's Codex CLI, through the codex-acp adapter.
import type { AgentManifest } from '../../../shared/agentPlugin'

// Adapter packages are pinned to exact versions on purpose (supply chain):
// they are installed from npm at runtime inside user containers, so a mutable
// range would let a compromised release reach users without a gurt release.
// Bumping these versions happens only through gurt releases.
export const manifest: AgentManifest = {
  id: 'codex',
  label: 'codex',
  vendor: 'OpenAI',
  // The provider's actual logo (nominative use: it only ever labels "this
  // session runs Codex", unmodified, never as gurt's own mark). Path data from
  // lobehub/lobe-icons (MIT-packaged; the mark itself remains the vendor's
  // trademark, per that project's README).
  icon: {
    path: 'M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z',
    fillRule: 'evenodd',
    color: '#7A9DFF'
  },
  // the adapter package bundles a compatible @openai/codex
  adapterPackages: ['@agentclientprotocol/codex-acp@2.5.0'],
  bin: 'codex-acp',
  binArgs: [],
  secretEnv: 'OPENAI_API_KEY',
  // §5.2.1: fed through a materialized `~/.codex/auth.json`, with the env var
  // suppressed — a non-key value there wins and forces the API-key path.
  oauthProvider: 'openai',
  signIn: { account: 'ChatGPT', label: 'ChatGPT (OpenAI)' },
  // Verified in the @openai/codex@0.160.1 binary (codex-acp@2.2.2
  // range-depends on @openai/codex@^0.160.1): a default-on skills subsystem reads
  // `~/.agents/skills` (canonical)
  // and `~/.codex/skills` (deprecated but still loaded) — SKILL.md format,
  // surfaced as `$<name>` commands over ACP. It never reads
  // `~/.claude/skills`. Link the canonical directory.
  skillsDir: '.agents/skills',
  // Not phase 1 (docs/requirements-agent-history.md §10 item 3): the
  // rollout files live under `.codex/sessions`, but the resume index
  // (`state_5.sqlite` / `thread_history_1.sqlite`) sits top-level, beside
  // `auth.json`, and stores an absolute `rollout_path` — binding those
  // files individually needs a live resume check first. Empty until then.
  historyPaths: [],
  // Instructions come from the cross-vendor AGENTS.md (the core's); project
  // config from `.codex/`.
  instructionPaths: ['.codex/'],

  // An MCP tool call titled `Tool: <server>/<tool>` — the form gurt has read
  // for codex. Stale: codex-acp@2.2.2 titles one `mcp.<server>.<tool>`, and
  // has no `Tool: ` string at all; kept as read until the pin is rechecked.
  toolTitles: ['^Tool:\\s*([\\w.-]+)\\/([\\w.-]+)$'],
  // codex-acp@2.2.2 reports `read-only`, `workspace-write`, `agent` ("Auto
  // review") and `agent-full-access` ("Full access"). Its auto-review mode has
  // carried `auto_review` as its kind (nested as `_meta.jetbrains.air.kind`,
  // AIR clients only, at this pin — "Auto review" is found by its name).
  modes: { autoReviewKinds: ['auto_review'] },
  limits: {
    // The @openai/codex@0.160.1 binary's own wording: "You’ve hit your usage
    // limit. Upgrade to Plus…", "…your usage limit for {model}…", with " Try
    // again at {time}." — forwarded as agent text, then as the failed
    // prompt's error data (`codexErrorInfo: usageLimitExceeded`).
    errors: ['hit your .{0,24}limit'],
    replies: ['hit your .{0,24}limit']
  }
}
