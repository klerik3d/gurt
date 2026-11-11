// claude-code — Anthropic's Claude Code, through the claude-agent-acp adapter.
import type { AgentManifest } from '../../../shared/agentPlugin'

// Adapter packages are pinned to exact versions on purpose (supply chain):
// they are installed from npm at runtime inside user containers, so a mutable
// range would let a compromised release reach users without a gurt release.
// Bumping these versions happens only through gurt releases.
export const manifest: AgentManifest = {
  id: 'claude-code',
  label: 'claude code',
  vendor: 'Anthropic',
  // The provider's actual logo (nominative use: it only ever labels "this
  // session runs Claude", unmodified, never as gurt's own mark). Path data from
  // lobehub/lobe-icons (MIT-packaged; the mark itself remains the vendor's
  // trademark, per that project's README). Kept in its real colour instead of
  // inheriting the text's — the whole point is at-a-glance recognition.
  icon: {
    path: 'M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z',
    fillRule: 'evenodd',
    color: '#D97757'
  },
  // @agentclientprotocol/claude-agent-acp bundles the Claude Agent SDK — the
  // claude-code image feature is not needed.
  adapterPackages: ['@agentclientprotocol/claude-agent-acp@0.100.0'],
  bin: 'claude-agent-acp',
  binArgs: [],
  secretEnv: 'CLAUDE_CODE_OAUTH_TOKEN',
  // §5.2.1: the access token rides that variable directly — the one kind for
  // which the original env-var assumption held.
  oauthProvider: 'anthropic',
  signIn: { account: 'Claude', label: 'Claude (Anthropic)' },
  // Claude Code's own user-level skills directory — the path this feature
  // was built against (docs/requirements-skills.md §5).
  skillsDir: '.claude/skills',
  // Rechecked against claude-agent-acp@0.94.0 (SDK 0.3.303): conversation +
  // resume state lives in `.claude/projects/<mangled-cwd>/<sessionId>.jsonl`.
  // Keep `.claude/todos` for state from earlier SDKs. There is no
  // auth file anywhere in `~/.claude` (the credential rides the
  // CLAUDE_CODE_OAUTH_TOKEN env var / a materialized-nowhere secret), so
  // nothing here can collide with §6.2. The cwd-keyed directory name is
  // overridden by CLAUDE_CODE_PROJECT_DIR_NAME (see main.ts `launchEnv`),
  // pinned to the session id, so this kind's history
  // survives a repo-set change too (docs/requirements-agent-history.md
  // §3.2). Phase 1 of that document.
  historyPaths: ['.claude/projects', '.claude/todos'],
  // Project memory, its local variant, project settings / agents / commands,
  // and the project MCP servers it offers to load.
  instructionPaths: ['CLAUDE.md', 'CLAUDE.local.md', '.claude/', '.mcp.json'],

  clientConfig: {
    path: '.claude/settings.json',
    example: { label: 'no attribution', config: { attribution: { commit: '', pr: '', sessionUrl: false } } }
  },
  instanceHints: {
    label: 'claude · personal',
    env: 'ANTHROPIC_BASE_URL=http://host.docker.internal:1234'
  },
  // A hardcoded model row, so the New Session modal and the composer offer a
  // model pick before the agent has ever run and populated the cache. The
  // families are bare aliases (no version numbers — those churn as new models
  // ship; the alias resolves to whatever's current). `fable` also stays
  // force-merged into the live list (main.ts `withFable`), since accounts have
  // shipped `session/new` reports that silently drop it.
  seedConfig: {
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        // A concrete default (not '') so a chip reads as selected right away
        // instead of the gear popup falling into its "no chip claims the
        // live value" note. Display only — actually starting a session never
        // sends `model` unless the user touches the chip (see main.ts
        // `sessionMeta`).
        currentValue: 'opus',
        options: [
          { value: 'fable', name: 'Fable' },
          { value: 'opus', name: 'Opus' },
          { value: 'sonnet', name: 'Sonnet' },
          { value: 'haiku', name: 'Haiku' }
        ]
      }
    ],
    commands: []
  },
  // Rechecked in claude-agent-acp@0.94.0: an MCP tool call is titled with the
  // SDK's raw tool name, `mcp__<server>__<tool>` (GenericReporter), and its
  // permission request reuses that title — which is what lets gurt's own
  // `mcp__gurt__*` tools be allowed without a prompt.
  toolTitles: ['^mcp__(.+?)__(.+)$'],
  // The adapter reports, in this order, `acceptEdits` ("Accept edits") and then
  // `auto` ("Auto", `auto_review`) — a plain name match over "accept|auto"
  // would always land on accept-edits, so the kind is asked for first. Its
  // blanket mode is `bypassPermissions`, which the core's own "bypass"
  // covers. (claude-agent-acp@0.94.0 nests the kind as
  // `_meta.jetbrains.air.kind`, for JetBrains AIR clients only; the top-level
  // `_meta.kind` this matches is what earlier versions sent. `auto` is still
  // found by its id.)
  modes: { autoReviewKinds: ['auto_review'] },
  limits: {
    // Claude Code's own wording, verbatim: "You've hit your session limit" (the
    // 5-hour window), "…your weekly limit", "…your Opus limit" (model-specific,
    // and the one case where switching models keeps you working), and the older
    // "Claude AI usage limit reached". Rechecked in the SDK 0.3.303 binary
    // claude-agent-acp@0.94.0 ships: "You've hit your {session|weekly|Opus|
    // Sonnet|Fable|usage credit} limit" + " · resets {time}", forwarded as
    // agent text and then as the failed prompt's error.
    errors: ['hit your .{0,24}limit', '\\b(session|weekly|hourly|daily|opus) limit\\b', 'usage limit reached'],
    // Claude Code answers a refused turn with the notice as plain text — "You've
    // hit your session limit · resets 3pm", "5-hour limit reached ∙ resets 3pm",
    // or the older "Claude AI usage limit reached|1760000000" — and a clean
    // `end_turn`.
    replies: ['hit your .{0,24}limit', 'usage limit reached', '\\blimit reached\\b.{0,40}\\breset'],
    // "Claude AI usage limit reached|1760000000" — the stamp after the pipe.
    resetStamps: ['limit reached\\|(\\d{10}(?:\\d{3})?)\\b']
  },
  planWindows: {
    // How the provider keys its windows — both the keyed form (`five_hour: {…}`)
    // and the `kind` of a `limits[]` entry resolve through this. Unknown keys are
    // kept, not dropped: a window we have no label for still has a real number on
    // it, and renders under its humanized key. `weekly_scoped` entries carry the
    // model (or surface) they are scoped to in `scope.*.display_name`, which the
    // parser appends — "Current week (Fable)". Read out of the CLI binary, not
    // guessed (see main.ts on the usage endpoint's provenance).
    labels: {
      five_hour: 'Current session',
      seven_day: 'Current week (all models)',
      seven_day_opus: 'Current week (Opus)',
      seven_day_sonnet: 'Current week (Sonnet)',
      seven_day_oauth_apps: 'Current week (apps)',
      weekly_scoped: 'Current week',
      extra_usage: 'Extra usage'
    },
    // Neither the usage endpoint nor the live events report a window's length;
    // the keys say it.
    durations: [
      { match: '^five_hour$', seconds: 5 * 3600 },
      { match: '^(seven_day(_.*)?|weekly_scoped)$', seconds: 7 * 24 * 3600 }
    ],
    meters: ['five_hour', 'seven_day'],
    meterLabels: { five_hour: '5h', seven_day: 'week' }
  }
}
