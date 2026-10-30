import { usePreference, z } from '../persisted'
import { clientConfigPath, parseClientConfig, clientConfigExample } from '../../../shared/clientConfig'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type {
  AgentInstance,
  AgentsFile,
  EnvConfig,
  PublishResult,
  RepoConfig,
  Tree
} from '../../../shared/types'
import { OPERATOR_ENV_NAME, STARTER_ENV_NAME } from '../../../shared/types'
import type { EnvImageStatus } from '../../../shared/api'
import { parseEnvDevcontainer, validateEnvConfig } from '../../../shared/envConfig'
import type {
  CredentialEntry,
  CredentialKind,
  CredentialKindDef
} from '../../../shared/credentials'
import {
  CREDENTIAL_KINDS,
  OAUTH_PROVIDER_CHOICES,
  agentCredentials,
  credentialKindLabel,
  isGitKind,
  mcpCredentials,
  oauthSignedOut,
  piiCredentials,
  liftLegacyMcpCredential,
  resolveForRepo,
  resolveMcpSecret,
  signedOutError
} from '../../../shared/credentials'
import type { PiiBackendId, PiiSettings, PiiStatus } from '../../../shared/pii'
import { PII_BACKENDS, PII_DEFAULT_PORT, PII_SOURCES } from '../../../shared/pii'
import type {
  McpDef,
  McpEntryDraft,
  McpEntryKind,
  McpEnvRow,
  McpProbeResult,
  McpRegistryEntry,
  McpSnippetResult,
  McpValue
} from '../../../shared/mcp'
import {
  LOCAL_MCP_NOTICE,
  isEnvName,
  isHttpMcpEntry,
  isLocalMcpEntry,
  isMcpCredentialRef,
  mcpCredentialIds,
  mcpEntryDetail,
  mcpEntryKind,
  mcpEnvRecord,
  mcpEnvRows,
  mcpLabel,
  normalizeMcpEntry,
  parseMcpSnippet,
  pastedSecret,
  validateMcpEntry
} from '../../../shared/mcp'
import type { SkillEntry } from '../../../shared/skills'
import { skillNameProblem, skillTemplate, validateSkillDoc } from '../../../shared/skills'
import { canonicalRepoId } from '../../../shared/repoId'
import type { NotificationPrefs, NotificationType } from '../../../shared/notifications'
import type { HotkeyActionId, HotkeyBinding, HotkeyMap } from '../../../shared/hotkeys'
import {
  HOTKEY_DEFAULTS,
  HOTKEY_DEFS,
  bindingEquals,
  bindingFromEvent,
  bindingLabel,
  conflictsFor,
  isRecordable,
  modKeyLabel
} from '../../../shared/hotkeys'
import { AGENT_DEFS, agentDef } from '../../../shared/agents'
import { PREPARE_LOG_KEY, WELCOME_MODES } from '../../../shared/doctor'
import { logErr } from '../log'
import type { WelcomeMode } from '../../../shared/doctor'
import type { GcResult, GcSettings } from '../../../shared/gc'
import { GC_DISK_MAX, GC_DISK_MIN, GC_HOURS_MAX, GC_HOURS_MIN } from '../../../shared/gc'
import { MachineChecklist } from './Welcome'
import { refreshAgents, useAgents } from '../useAgents'
import { refreshHotkeys, useHotkeys } from '../useHotkeys'
import { useOutsideClose } from '../hooks'
import { confirmDialog } from '../dialog'
import type { IconName } from './icons'
import { Icon } from './icons'
import { AgentTag, agentIcon } from './tags'
import { Modal } from './Modal'
import { run } from '../async'

export type SettingsSection =
  | 'environments'
  | 'repos'
  | 'clients'
  | 'agentAccess'
  | 'mcp'
  | 'skills'
  | 'credentials'
  | 'masking'
  | 'notifications'
  | 'hotkeys'
  | 'machine'
  | 'docker'

/** Nav labels for sections whose id does not simply capitalize. */
const SECTION_LABEL: Partial<Record<SettingsSection, string>> = {
  mcp: 'MCP servers',
  agentAccess: 'Agent access',
  docker: 'Docker cleanup'
}

/** One icon per nav item, so the list reads at a glance instead of as a wall
 *  of text. */
const SECTION_ICON: Record<SettingsSection, IconName> = {
  environments: 'box',
  repos: 'branch',
  clients: 'plug',
  agentAccess: 'sliders',
  mcp: 'globe',
  skills: 'folder',
  credentials: 'key',
  masking: 'eye-lock',
  notifications: 'bell',
  hotkeys: 'grid',
  machine: 'info',
  docker: 'trash'
}

/** Registry group — the sections that define *what the workspace has*: the
 *  envs it can build, the repos and clients it knows, who may reach them, and
 *  the secrets behind that. Grouped under one heading so they read as one
 *  subject rather than five peers of the General group. */
const REGISTRY_SECTIONS = [
  'environments',
  'repos',
  'clients',
  'agentAccess',
  'credentials',
  'masking'
] as const satisfies readonly SettingsSection[]

/** General group — per-user preferences rather than registry entries. They
 *  head the list under their own heading instead of floating unlabelled
 *  between Registry and Advanced. `mcp` and `skills` sit apart, under the
 *  Advanced disclosure below — both are registries of pluggable capability
 *  (external servers, filesystem-backed skill packs) rather than everyday
 *  workspace config, so they cost a click instead of always taking up room. */
// `machine` heads the General group: it is per-host state (is Docker there,
// is its daemon up, are the images pulled) rather than a workspace registry,
// and it is the section a user is sent to when a start fails for a reason that
// is not in the configuration at all (docs/requirements-first-run.md §2.2).
const GENERAL_SECTIONS = [
  'machine',
  'docker',
  'notifications',
  'hotkeys'
] as const satisfies readonly SettingsSection[]

const ADVANCED_SECTIONS = ['mcp', 'skills'] as const satisfies readonly SettingsSection[]

/** Vendor tag shown beside each provider in the combobox (#4c). */
const PROVIDER_VENDOR: Record<string, string> = {
  'claude-code': 'Anthropic',
  codex: 'OpenAI',
  gemini: 'Google',
  opencode: 'local',
  pi: 'local'
}

/** Nav label for a section — the id capitalized, unless {@link SECTION_LABEL}
 *  overrides it. */
function sectionLabel(s: SettingsSection): string {
  return SECTION_LABEL[s] ?? s.slice(0, 1).toUpperCase() + s.slice(1)
}

function NavItem({
  section: s,
  active,
  onSection
}: {
  section: SettingsSection
  active: boolean
  onSection: (s: SettingsSection) => void
}): JSX.Element {
  return (
    <div className={`set-nav-item ${active ? 'active' : ''}`} onClick={() => onSection(s)}>
      <Icon name={SECTION_ICON[s]} size={14} style={{ flex: 'none' }} />
      {sectionLabel(s)}
    </div>
  )
}

type NavGroup = 'general' | 'registry' | 'advanced'

/** A group heading doubling as its own disclosure — click to fold/unfold the
 *  sections under it. Every group starts open; nothing here is hidden until
 *  the user chooses to hide it. */
function GroupFold({
  label,
  icon,
  open,
  onToggle
}: {
  label: string
  icon?: IconName
  open: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <div className="set-nav-item set-nav-fold" onClick={onToggle}>
      <Icon
        name="chevron"
        size={12}
        className="faint"
        style={{ flex: 'none', transform: open ? undefined : 'rotate(-90deg)' }}
      />
      {icon && <Icon name={icon} size={14} className="faint" style={{ flex: 'none' }} />}
      {label}
    </div>
  )
}

/** The checklist's permanent home — the same component the welcome screen
 *  embeds, so a machine that lost Docker after setup does not need an empty
 *  store to reach the rows (docs/requirements-first-run.md §2.2). */
function MachineSection(): JSX.Element {
  const [log, setLog] = useState<string[]>([])
  const [mode, setMode] = useState<WelcomeMode | null>(null)
  const [modeError, setModeError] = useState('')
  useEffect(
    () =>
      window.gurt.onProvisionLog(({ key, line }) => {
        if (key === PREPARE_LOG_KEY) setLog((prev) => [...prev.slice(-500), line])
      }),
    []
  )
  useEffect(() => {
    window.gurt.getWelcomeMode().then(setMode).catch(logErr('getWelcomeMode'))
  }, [])
  const pick = (next: WelcomeMode) =>
    void window.gurt
      .setWelcomeMode(next)
      .then(() => {
        setMode(next)
        setModeError('')
      })
      .catch((e: unknown) => setModeError(e instanceof Error ? e.message : String(e)))
  // A fragment, like every other section: `.set-head` and `.set-list` carry
  // this page's own horizontal padding, and a wrapper between them and
  // `.set-content` is what knocks it out of alignment.
  return (
    <>
      <div className="set-head">
        <div className="set-title-wrap">
          <span className="set-title">Machine</span>
          <span className="set-count mono">what a session needs from this host</span>
        </div>
      </div>
      {/* The checklist's own head is suppressed here: this section already has
          one, and two headings stacked ("Machine" over "This machine") was
          exactly the mess. Its Re-check lives inside the list instead. */}
      <div className="set-list">
        <MachineChecklist heading={null} log={log} />
      </div>
      {/* When the welcome screen shows itself
          (docs/requirements-first-run.md §2.1.1). `always` is what a demo
          machine wants; `never` is the way out for someone who deleted their
          last session and does not want the screen back. Either way ⌘K →
          "Welcome & machine setup" still reaches it. */}
      <div className="set-list">
        <div className="set-row">
          <span className="set-row-label">Welcome screen</span>
          <span className="spacer" />
          {WELCOME_MODES.map((m) => (
            <button
              key={m}
              type="button"
              className={`btn-link ${mode === m ? 'active' : ''}`}
              title={WELCOME_MODE_HINT[m]}
              disabled={mode === null}
              onClick={() => pick(m)}
            >
              {mode === m ? `${m} ✓` : m}
            </button>
          ))}
        </div>
        <div className="set-note">
          {mode ? WELCOME_MODE_HINT[mode] : 'loading…'} · <span className="mono">GURT_WELCOME</span>{' '}
          overrides this for one run.
        </div>
        {modeError && <div className="error">{modeError}</div>}
      </div>
    </>
  )
}

/** Retention policy for the Docker resources gurt creates, and the "clean now"
 *  button. The same pass runs on its own at startup and every few hours. */
function DockerCleanupSection(): JSX.Element {
  const [settings, setSettings] = useState<GcSettings | null>(null)
  const [result, setResult] = useState<GcResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    window.gurt.getGcSettings().then(setSettings).catch((e: unknown) => setError(String(e)))
  }, [])

  const save = async (patch: Partial<GcSettings>) => {
    if (!settings) return
    const prior = settings
    const next = { ...settings, ...patch }
    setSettings(next)
    setError('')
    try {
      await window.gurt.setGcSettings(next)
    } catch (e) {
      setSettings(prior)
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const cleanNow = async () => {
    setBusy(true)
    setError('')
    try {
      setResult(await window.gurt.gcRunNow())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const hoursField = (label: string, hint: string, key: 'stoppedContainerHours' | 'buildCacheHours') => (
    <div className="set-row">
      <span className="set-row-label">
        {label}
        <div className="fld-hint">{hint}</div>
      </span>
      <span className="spacer" />
      <input
        className="input"
        type="number"
        style={{ width: 80 }}
        min={GC_HOURS_MIN}
        max={GC_HOURS_MAX}
        disabled={!settings}
        value={settings?.[key] ?? ''}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (Number.isFinite(n) && n >= GC_HOURS_MIN) void save({ [key]: n })
        }}
      />
      <span className="faint">hours</span>
    </div>
  )
  return (
    <>
      <div className="set-head">
        <div className="set-title-wrap">
          <span className="set-title">Docker cleanup</span>
          <span className="set-count mono">frees disk used by stopped sessions, old env images and build cache</span>
        </div>
      </div>
      <div className="set-list">
        <div className="set-row">
          <span className="set-row-label">
            Automatic cleanup
            <div className="fld-hint">runs a minute after launch and every 6 hours</div>
          </span>
          <span className="spacer" />
          <button
            className={`chip-btn ${settings?.enabled ? 'on' : ''}`}
            disabled={!settings}
            onClick={run(() => save({ enabled: !settings?.enabled }))}
          >
            {settings?.enabled ? 'on' : 'off'}
          </button>
        </div>
        {hoursField(
          'Remove stopped containers after',
          'the session and its clone stay; the next start creates a fresh container',
          'stoppedContainerHours'
        )}
        <div className="set-row">
          <span className="set-row-label">
            Prune build cache
            <div className="fld-hint">
              daemon-wide — Docker cannot tell whose cache is whose, so on a shared Docker this
              also clears other projects’ build cache
            </div>
          </span>
          <span className="spacer" />
          <button
            className={`chip-btn ${settings?.pruneBuildCache ? 'on' : ''}`}
            disabled={!settings}
            onClick={run(() => save({ pruneBuildCache: !settings?.pruneBuildCache }))}
          >
            {settings?.pruneBuildCache ? 'on' : 'off'}
          </button>
        </div>
        {settings?.pruneBuildCache &&
          hoursField('Build cache older than', 'only cache unused for this long is pruned', 'buildCacheHours')}
        <div className="set-row">
          <span className="set-row-label">
            Disk-full threshold
            <div className="fld-hint">
              above this, a pass ignores the time limits: every stopped container goes and all
              unused build cache is pruned
            </div>
          </span>
          <span className="spacer" />
          <input
            className="input"
            type="number"
            style={{ width: 80 }}
            min={GC_DISK_MIN}
            max={GC_DISK_MAX}
            disabled={!settings}
            value={settings?.diskThresholdPercent ?? ''}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (Number.isFinite(n) && n >= GC_DISK_MIN && n <= GC_DISK_MAX) void save({ diskThresholdPercent: n })
            }}
          />
          <span className="faint">% used</span>
        </div>
        <div className="set-note">
          Also removed on every pass: env images no container uses (only the newest build per
          environment is kept).
        </div>
        <div className="set-row">
          <button className="btn" disabled={busy} onClick={run(cleanNow)}>
            {busy ? 'Cleaning…' : 'Clean now'}
          </button>
          {result && (
            <span className="fld-hint">
              {result.skipped
                ? `skipped: ${result.skipped}`
                : `removed ${result.containers} container(s), ${result.images} image(s)` +
                  (result.buildCacheReclaimed ? `; build cache ${result.buildCacheReclaimed}` : '') +
                  (result.emergency ? ` · disk ${result.diskPercent}% full — time limits ignored` : '') +
                  ` · ${(result.ms / 1000).toFixed(1)}s`}
            </span>
          )}
        </div>
      </div>
      {error && <div className="error">{error}</div>}
    </>
  )
}

const WELCOME_MODE_HINT: Record<WelcomeMode, string> = {
  auto: 'shown until this machine has its first session',
  always: 'shown on every launch',
  never: 'only from the command palette'
}

export function SettingsPage({
  tree,
  ws,
  section,
  onSection
}: {
  tree: Tree | null
  ws: string | null
  section: SettingsSection
  onSection: (s: SettingsSection) => void
}) {
  const [openGroups, setOpenGroups] = usePreference<Record<NavGroup, boolean>>('settingsGroups', { general: true, registry: true, advanced: true }, z.object({ general: z.boolean(), registry: z.boolean(), advanced: z.boolean() }))
  const toggleGroup = (g: NavGroup) => setOpenGroups((prev) => ({ ...prev, [g]: !prev[g] }))
  return (
    <div className="settings">
      <div className="set-nav">
        <div className="set-nav-head">Settings</div>
        <div className="set-nav-list">
          <GroupFold label="General" open={openGroups.general} onToggle={() => toggleGroup('general')} />
          {openGroups.general &&
            GENERAL_SECTIONS.map((s) => (
              <NavItem key={s} section={s} active={section === s} onSection={onSection} />
            ))}
          <div className="set-nav-sep" />
          <GroupFold label="Registry" open={openGroups.registry} onToggle={() => toggleGroup('registry')} />
          {openGroups.registry &&
            REGISTRY_SECTIONS.map((s) => (
              <NavItem key={s} section={s} active={section === s} onSection={onSection} />
            ))}
          <div className="set-nav-sep" />
          <GroupFold
            label="Advanced"
            icon="gear"
            open={openGroups.advanced}
            onToggle={() => toggleGroup('advanced')}
          />
          {openGroups.advanced && (
            <div className="set-nav-sub">
              {ADVANCED_SECTIONS.map((s) => (
                <NavItem key={s} section={s} active={section === s} onSection={onSection} />
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="set-content">
        {section === 'environments' && <EnvironmentsSection tree={tree} ws={ws} />}
        {section === 'repos' && <ReposSection tree={tree} ws={ws} />}
        {section === 'clients' && <ClientsSection />}
        {section === 'agentAccess' && <AgentAccessSection tree={tree} ws={ws} />}
        {section === 'mcp' && <McpServersSection ws={ws} />}
        {section === 'skills' && <SkillsSection tree={tree} ws={ws} />}
        {section === 'credentials' && <CredentialsSection />}
        {section === 'masking' && <MaskingSection />}
        {section === 'notifications' && <NotificationsSection />}
        {section === 'hotkeys' && <HotkeysSection />}
        {section === 'machine' && <MachineSection />}
        {section === 'docker' && <DockerCleanupSection />}
      </div>
    </div>
  )
}

/** `https://github.com/acme/x.git` → `github.com/acme/x`. */
function stripProtocol(url: string): string {
  return url.replace(/^[a-z+]+:\/\//, '').replace(/^git@/, '').replace(/\.git$/, '')
}

// ---- Environments (#4a) — the workspace's env definitions ----

function EnvironmentsSection({ tree, ws }: { tree: Tree | null; ws: string | null }) {
  const [editing, setEditing] = useState<EnvConfig | null>(null)
  const [adding, setAdding] = useState(false)
  const [operatorError, setOperatorError] = useState('')
  const [statuses, setStatuses] = useState<Record<string, EnvImageStatus>>({})
  const [building, setBuilding] = useState<Set<string>>(new Set())
  const [buildLogs, setBuildLogs] = useState<Record<string, string[]>>({})
  const [buildErrors, setBuildErrors] = useState<Record<string, string>>({})
  const wsData = tree?.workspaces.find((w) => w.name === ws)
  const envs = wsData?.envs ?? []
  const repos = wsData?.repos ?? []

  // These maps are keyed by env *name*, which is only unique within one
  // workspace — switching workspaces must drop them, and a reply that raced
  // the switch must not land under the new workspace's same-named env.
  const wsRef = useRef(ws)
  useEffect(() => {
    wsRef.current = ws
    setStatuses({})
    setBuildLogs({})
    setBuildErrors({})
  }, [ws])

  // Memoized on `ws` alone — the only thing it closes over — so the effect
  // below can name it as a dependency instead of suppressing it.
  const loadStatus = useCallback(
    (env: string) => {
      if (!ws) return
      window.gurt
        .envImageStatus(ws, env)
        .then((s) => {
          if (wsRef.current === ws) setStatuses((prev) => ({ ...prev, [env]: s }))
        })
        .catch(() => {})
    },
    [ws]
  )

  // Badges load lazily when the section opens; refreshed per-env after a build.
  // `envNames` is a joined string, not the array: the env list is rebuilt on
  // every render, and only its *contents* should re-trigger the load.
  const envNames = envs.map((e) => e.name).join('\n')
  useEffect(() => {
    for (const name of envNames ? envNames.split('\n') : []) loadStatus(name)
  }, [envNames, loadStatus])

  // Build-log tail: main streams `provision.log` with key `env-build:<ws>/<env>`.
  useEffect(() => {
    if (!ws) return
    const prefix = `env-build:${ws}/`
    return window.gurt.onProvisionLog(({ key, line }) => {
      if (!key.startsWith(prefix)) return
      const env = key.slice(prefix.length)
      setBuildLogs((prev) => ({ ...prev, [env]: [...(prev[env] ?? []).slice(-20), line] }))
    })
  }, [ws])

  const build = async (env: string) => {
    if (!ws) return
    setBuilding((prev) => new Set(prev).add(env))
    setBuildLogs((prev) => ({ ...prev, [env]: [] }))
    setBuildErrors((prev) => ({ ...prev, [env]: '' }))
    try {
      await window.gurt.envBuildImage(ws, env)
      setBuildLogs((prev) => ({ ...prev, [env]: [] }))
    } catch (e) {
      setBuildErrors((prev) => ({
        ...prev,
        [env]: e instanceof Error ? e.message : String(e)
      }))
    } finally {
      setBuilding((prev) => {
        const next = new Set(prev)
        next.delete(env)
        return next
      })
      loadStatus(env)
    }
  }

  return (
    <>
      <div className="set-head">
        <div className="set-title-wrap">
          <span className="set-title">Environments</span>
          <span className="set-count mono">
            {envs.length} env{envs.length === 1 ? '' : 's'}
            {ws ? ` · ${ws}` : ''}
          </span>
        </div>
        <span className="spacer" />
        <button className="btn btn-primary" disabled={!ws} onClick={() => setAdding(true)}>
          + New environment
        </button>
      </div>
      {/* Which env the workspace's operator sessions run on — the twin of the
          default agent, beside the thing it points at
          (docs/requirements-session-operator.md §2.2). Absent = the bundled,
          always-startable default. */}
      {ws && (
        <div className="set-list">
          <div className="set-row">
            <span className="set-row-label">Operator environment</span>
            <span className="spacer" />
            <button
              type="button"
              className={`btn-link ${!wsData?.operatorEnv ? 'active' : ''}`}
              title={`the image-only default gurt ships (${OPERATOR_ENV_NAME}) — needs no repo and no setup`}
              onClick={() =>
                void window.gurt
                  .setOperatorEnv(ws, undefined)
                  .then(() => setOperatorError(''))
                  .catch((e: unknown) =>
                    setOperatorError(e instanceof Error ? e.message : String(e))
                  )
              }
            >
              {!wsData?.operatorEnv ? 'bundled default ✓' : 'bundled default'}
            </button>
            {envs.map((e) => (
              <button
                key={e.name}
                type="button"
                className={`btn-link ${wsData?.operatorEnv === e.name ? 'active' : ''}`}
                onClick={() =>
                  void window.gurt
                    .setOperatorEnv(ws, e.name)
                    .then(() => setOperatorError(''))
                    .catch((err: unknown) =>
                      setOperatorError(err instanceof Error ? err.message : String(err))
                    )
                }
              >
                {wsData?.operatorEnv === e.name ? `${e.name} ✓` : e.name}
              </button>
            ))}
          </div>
          {operatorError && <div className="error">{operatorError}</div>}
        </div>
      )}
      <div className="set-list">
        {/* Read-only: the bundled starter is code, not workspace data
            (docs/requirements-new-projects.md §3) — listed so it is not a
            surprise in the session's env picker. */}
        {ws && (
          <div className="set-row" title="offered in every session's env picker; not editable">
            <span className="set-row-label">{STARTER_ENV_NAME}</span>
            <span className="set-row-url mono">
              bundled · node 22 on Debian 13, git, python3, build tools — for a repo with no devcontainer yet
            </span>
          </div>
        )}
        {envs.map((e) => {
          const st = statuses[e.name]
          const isBuilding = building.has(e.name)
          const tail = buildLogs[e.name] ?? []
          const buildError = buildErrors[e.name]
          return (
            <div key={e.name}>
              <div className="set-row">
                <span className="set-row-label">{e.name}</span>
                <span className="set-row-url mono">
                  {e.repo ? e.repo : 'no default repo'}
                  {e.dockerfile
                    ? ` · Dockerfile${e.dockerfilePath ? `: ${e.dockerfilePath}` : ''}`
                    : ''}
                </span>
                {st?.state === 'exists' && (
                  <span className="tag tag-green">image ✓ {st.tag}</span>
                )}
                {st?.state === 'missing' && <span className="tag tag-red">image ✗ {st.tag}</span>}
                {st?.state === 'no-repo' && (
                  <span className="env-image-hint mono">no repo to build from</span>
                )}
                {st?.state === 'invalid' && (
                  <span className="env-image-hint mono">invalid config</span>
                )}
                {(st?.state === 'missing' || st?.state === 'exists') &&
                  (isBuilding ? (
                    <span className="env-building mono">building…</span>
                  ) : (
                    <button className="btn-link" onClick={() => void build(e.name)}>
                      build
                    </button>
                  ))}
                <button className="btn-link" onClick={() => setEditing(e)}>
                  edit
                </button>
              </div>
              {(isBuilding || buildError) && (tail.length > 0 || buildError) && (
                <div className="env-build-log mono">
                  {tail.slice(-5).map((l, i) => (
                    <div key={i}>{l}</div>
                  ))}
                  {buildError && <div className="error">{buildError}</div>}
                </div>
              )}
            </div>
          )
        })}
        {envs.length === 0 && (
          <div className="tp-dashed">no environments yet — add one to run sessions</div>
        )}
      </div>
      {(editing || adding) && ws && (
        <EnvModal
          key={editing?.name ?? '__new'}
          ws={ws}
          repos={repos}
          initial={editing ?? undefined}
          onClose={() => {
            setEditing(null)
            setAdding(false)
            // The config may have changed — recompute the badges.
            for (const e of envs) loadStatus(e.name)
          }}
        />
      )}
    </>
  )
}

// ---- Edit environment popup (#4b) — name, default repo, devcontainer ----

function EnvModal({
  ws,
  repos,
  initial,
  onClose
}: {
  ws: string
  repos: RepoConfig[]
  initial?: EnvConfig | undefined
  onClose: () => void
}) {
  const editing = !!initial
  const [name, setName] = useState(initial?.name ?? '')
  const [repo, setRepo] = useState<string | null>(initial?.repo ?? null)
  const [devcontainer, setDevcontainer] = useState(initial?.devcontainer ?? '')
  const [repoMenu, setRepoMenu] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [discoverMsg, setDiscoverMsg] = useState('')
  const [error, setError] = useState('')
  const repoRef = useRef<HTMLDivElement>(null)
  useOutsideClose(repoMenu, repoRef, () => setRepoMenu(false))

  const [dockerfile, setDockerfile] = useState(initial?.dockerfile ?? '')
  const [dockerfilePath, setDockerfilePath] = useState(initial?.dockerfilePath ?? '')
  const [dockerfileCandidates, setDockerfileCandidates] = useState<
    { path: string; content: string }[] | null
  >(null)
  const [dockerfileMenu, setDockerfileMenu] = useState(false)
  const [detectingDockerfiles, setDetectingDockerfiles] = useState(false)
  const [dockerfileMsg, setDockerfileMsg] = useState('')
  const dockerfileRef = useRef<HTMLDivElement>(null)
  useOutsideClose(dockerfileMenu, dockerfileRef, () => setDockerfileMenu(false))

  // The devcontainer is the single runtime description; the Dockerfile section
  // exists only while the (parseable) config carries a `build` section.
  const hasBuild = !!parseEnvDevcontainer(devcontainer).build
  // Built by spread rather than by writing `undefined`: this is the record that
  // gets saved, and a key carrying nothing would be stored as one.
  const draft: EnvConfig = {
    name: name.trim(),
    devcontainer,
    ...(hasBuild && dockerfile ? { dockerfile } : {}),
    ...(hasBuild && dockerfile && dockerfilePath ? { dockerfilePath } : {}),
    ...(repo ? { repo } : {})
  }
  const cfgError = validateEnvConfig(draft)
  const valid = !!name.trim() && cfgError === null
  const repoUrl = repo ? repos.find((r) => r.name === repo)?.url : undefined

  const discover = async () => {
    if (!repo) return
    setDiscoverMsg('')
    setDiscovering(true)
    try {
      const found = await window.gurt.discoverDevcontainer(ws, repo)
      if (found) {
        setDevcontainer(found.content)
        if (found.dockerfile) {
          setDockerfile(found.dockerfile.content)
          setDockerfilePath(found.dockerfile.path)
          setDiscoverMsg(`loaded ${found.path} + ${found.dockerfile.path}`)
        } else {
          setDiscoverMsg(`loaded ${found.path}`)
        }
      } else {
        setDiscoverMsg('no devcontainer.json found in repo')
      }
    } catch (e) {
      setDiscoverMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setDiscovering(false)
    }
  }

  const detectDockerfiles = async () => {
    if (!repo) return
    setDockerfileMsg('')
    setDetectingDockerfiles(true)
    try {
      const found = await window.gurt.discoverDockerfiles(ws, repo)
      setDockerfileCandidates(found)
      const [single] = found
      if (found.length === 0) setDockerfileMsg('no Dockerfile found in repo')
      else if (single && found.length === 1) {
        setDockerfilePath(single.path)
        setDockerfile(single.content)
        setDockerfileMsg(`loaded ${single.path}`)
      } else {
        setDockerfileMsg(`${found.length} candidates — pick one below`)
      }
    } catch (e) {
      setDockerfileMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setDetectingDockerfiles(false)
    }
  }

  const save = async () => {
    setError('')
    try {
      await (editing ? window.gurt.updateEnv(ws, draft) : window.gurt.addEnv(ws, draft))
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const del = async () => {
    if (
      !(await confirmDialog(`Delete environment "${initial!.name}"?`, {
        title: 'Delete environment',
        confirmText: 'Delete',
        danger: true
      }))
    )
      return
    try {
      await window.gurt.removeEnv(ws, initial!.name)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal title={editing ? 'Edit environment' : 'New environment'} width={500} onClose={onClose}>
      <div className="modal-body env-modal">
        <label className="fld">
          <span className="seclabel">NAME</span>
          <input
            className="input"
            autoFocus={!editing}
            placeholder="web-app"
            value={name}
            disabled={editing}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <div className="fld">
          <span className="seclabel">DEFAULT REPOSITORY</span>
          <div className="pick-wrap" ref={repoRef}>
            <button type="button" className="pick-row" onClick={() => setRepoMenu((o) => !o)}>
              <span className={`pick-value ${repo ? '' : 'faint'}`}>
                {repo ?? 'no repository'}
              </span>
              {repoUrl && <span className="pick-meta mono">{stripProtocol(repoUrl)}</span>}
              <span className="spacer" />
              <Icon name="chevron" size={12} className="faint" style={{ flex: 'none' }} />
            </button>
            {repoMenu && (
              <div className="menu pick-menu">
                <div
                  className={`menu-item ${repo == null ? 'active' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    setRepo(null)
                    setRepoMenu(false)
                  }}
                >
                  no repository
                </div>
                {repos.map((r) => (
                  <div
                    key={r.name}
                    className={`menu-item ${r.name === repo ? 'active' : ''}`}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      setRepo(r.name)
                      setRepoMenu(false)
                    }}
                  >
                    <Icon name="branch" size={11} className="faint" />
                    {r.name}
                    <span className="menu-meta mono">{stripProtocol(r.url)}</span>
                  </div>
                ))}
                {repos.length === 0 && (
                  <div className="menu-empty">no repos — add one in Settings → Repos</div>
                )}
              </div>
            )}
          </div>
          <span className="fld-hint">seeds the repo of new sessions on this env; changeable per session</span>
        </div>

        <div className="fld">
          <div className="fld-head">
            <span className="seclabel">DEVCONTAINER</span>
            <span className="fld-hint mono">{devcontainer.trim() ? '' : 'required'}</span>
            <span className="spacer" />
            <button
              className="btn-link mono"
              disabled={!repoUrl || discovering}
              title={!repoUrl ? 'set a default repository first' : undefined}
              onClick={run(discover)}
            >
              {discovering ? 'detecting…' : '⤢ detect from repo'}
            </button>
          </div>
          <JsonEditor value={devcontainer} onChange={setDevcontainer} />
          {discoverMsg && <div className="fld-hint mono">{discoverMsg}</div>}
        </div>

        {hasBuild && (
          <div className="fld">
            <div className="fld-head">
              <span className="seclabel">DOCKERFILE</span>
              <span className="fld-hint mono">
                {dockerfile
                  ? dockerfilePath
                    ? `from ${dockerfilePath}`
                    : 'custom'
                  : 'required by the build section'}
              </span>
              <span className="spacer" />
              <button
                className="btn-link mono"
                disabled={!repoUrl || detectingDockerfiles}
                title={!repoUrl ? 'set a default repository first' : undefined}
                onClick={run(detectDockerfiles)}
              >
                {detectingDockerfiles ? 'detecting…' : '⤢ detect Dockerfiles in repo'}
              </button>
            </div>
            {dockerfileCandidates && dockerfileCandidates.length > 1 && (
              <div className="pick-wrap" ref={dockerfileRef}>
                <button
                  type="button"
                  className="pick-row"
                  onClick={() => setDockerfileMenu((o) => !o)}
                >
                  <span className={`pick-value mono ${dockerfilePath ? '' : 'faint'}`}>
                    {dockerfilePath || 'choose a Dockerfile'}
                  </span>
                  <span className="spacer" />
                  <Icon name="chevron" size={12} className="faint" style={{ flex: 'none' }} />
                </button>
                {dockerfileMenu && (
                  <div className="menu pick-menu">
                    {dockerfileCandidates.map((c) => (
                      <div
                        key={c.path}
                        className={`menu-item ${c.path === dockerfilePath ? 'active' : ''}`}
                        onMouseDown={(e) => {
                          e.preventDefault()
                          setDockerfilePath(c.path)
                          setDockerfile(c.content)
                          setDockerfileMsg(`loaded ${c.path}`)
                          setDockerfileMenu(false)
                        }}
                      >
                        {c.path}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <CodeEditor
              value={dockerfile}
              onChange={setDockerfile}
              placeholder={'FROM node:20\nWORKDIR /app\nCOPY . .\nRUN npm ci'}
            />
            {dockerfileMsg && <div className="fld-hint mono">{dockerfileMsg}</div>}
            <div className="fld-hint">
              gurt builds this Dockerfile in a temporary snapshot of the repo at HEAD (build
              context = repo root); the image is cached and reused until the Dockerfile, the
              build args, or the repo's committed content change.
            </div>
          </div>
        )}

        {cfgError && <div className="fld-hint mono">⚠ {cfgError}</div>}
        {error && <div className="error">{error}</div>}
      </div>
      <div className="modal-foot">
        {editing && (
          <button className="btn btn-danger-text" onClick={run(del)}>
            Delete
          </button>
        )}
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!valid} onClick={run(save)}>
          Save
        </button>
      </div>
    </Modal>
  )
}

// ---- Repos — the workspace's repo identities (url + credential) ----

function ReposSection({ tree, ws }: { tree: Tree | null; ws: string | null }) {
  const [editing, setEditing] = useState<RepoConfig | null>(null)
  const [adding, setAdding] = useState(false)
  const repos = tree?.workspaces.find((w) => w.name === ws)?.repos ?? []

  return (
    <>
      <div className="set-head">
        <div className="set-title-wrap">
          <span className="set-title">Repos</span>
          <span className="set-count mono">
            {repos.length} repo{repos.length === 1 ? '' : 's'}
            {ws ? ` · ${ws}` : ''}
          </span>
        </div>
        <span className="spacer" />
        <button className="btn btn-primary" disabled={!ws} onClick={() => setAdding(true)}>
          + New repo
        </button>
      </div>
      <div className="set-list">
        {repos.map((r) => (
          <div key={r.name} className="set-row">
            <span className="set-row-label">{r.name}</span>
            <span className="set-row-url mono">
              {r.local ? 'local · not published' : stripProtocol(r.url)}
            </span>
            <button className="btn-link" onClick={() => setEditing(r)}>
              edit
            </button>
          </div>
        ))}
        {repos.length === 0 && (
          <div className="tp-dashed">no repos yet — add one to clone in a session</div>
        )}
      </div>
      {(editing || adding) && ws && (
        <RepoModal
          key={editing?.name ?? '__new'}
          ws={ws}
          initial={editing ?? undefined}
          onClose={() => {
            setEditing(null)
            setAdding(false)
          }}
        />
      )}
    </>
  )
}

function RepoModal({
  ws,
  initial,
  onClose
}: {
  ws: string
  initial?: RepoConfig | undefined
  onClose: () => void
}) {
  const editing = !!initial
  // A new repo is either registered by URL or created by gurt as a local one
  // (docs/requirements-new-projects.md §2); an existing local repo has no url
  // to edit, only a publish to offer.
  const [local, setLocal] = useState(!!initial?.local)
  const [publishing, setPublishing] = useState(false)
  const [name, setName] = useState(initial?.name ?? '')
  const [url, setUrl] = useState(initial?.url ?? '')
  const [credentialId, setCredentialId] = useState(initial?.credentialId ?? '')
  const [credentials, setCredentials] = useState<CredentialEntry[]>([])
  const [credMenu, setCredMenu] = useState(false)
  const [error, setError] = useState('')
  const credRef = useRef<HTMLDivElement>(null)
  useOutsideClose(credMenu, credRef, () => setCredMenu(false))

  useEffect(() => {
    window.gurt.getCredentials().then((f) => setCredentials(f.credentials)).catch(() => {})
  }, [])

  const valid = name.trim() && (local || url.trim())
  const draft: RepoConfig = {
    name: name.trim(),
    url: url.trim(),
    ...(credentialId ? { credentialId } : {})
  }

  const linked = credentials.find((c) => c.id === credentialId)
  const resolution = url.trim() ? resolveForRepo(credentials, draft) : null
  const host = url.trim() ? canonicalRepoId(url.trim())?.host : undefined
  const accessNote = !url.trim()
    ? null
    : !host
      ? 'cannot parse a host from the url'
      : resolution?.error
        ? `⚠ ${resolution.error}`
        : linked
          ? null
          : resolution?.entry
            ? `auto → ${resolution.entry.label} · ${credentialKindLabel(resolution.entry.kind)} (${host})`
            : `host credentials (ambient) — ${host}`

  const save = async () => {
    setError('')
    try {
      if (local && !editing) await window.gurt.createLocalRepo(ws, draft.name)
      else await (editing ? window.gurt.updateRepo(ws, draft) : window.gurt.addRepo(ws, draft))
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const del = async () => {
    // A local repo's storage goes with it (store.removeRepo) — and it is the
    // only copy of whatever was merged into it, so the prompt says so.
    const message = initial!.local
      ? `Delete repo "${initial!.name}"? It is local and unpublished — its history, kept only by gurt on this machine, is deleted with it.`
      : `Delete repo "${initial!.name}"?`
    if (!(await confirmDialog(message, { title: 'Delete repo', confirmText: 'Delete', danger: true })))
      return
    try {
      await window.gurt.removeRepo(ws, initial!.name)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal title={editing ? 'Edit repo' : 'New repo'} width={500} onClose={onClose}>
      <div className="modal-body env-modal">
        {!editing && (
          <div className="fld">
            <span className="seclabel">SOURCE</span>
            <div className="seg">
              <button
                className={`seg-btn ${!local ? 'active' : ''}`}
                title="a repository that already exists on a forge or git server"
                onClick={() => setLocal(false)}
              >
                existing, by URL
              </button>
              <button
                className={`seg-btn ${local ? 'active' : ''}`}
                title="a new, empty repository kept by gurt on this machine — publish it to a forge later"
                onClick={() => setLocal(true)}
              >
                new, local
              </button>
            </div>
          </div>
        )}
        <label className="fld">
          <span className="seclabel">NAME</span>
          <input
            className="input"
            autoFocus={!editing}
            placeholder="checkout-web"
            value={name}
            disabled={editing}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        {local ? (
          <div className="fld">
            <span className="seclabel">STORAGE</span>
            <div className="env-access-note">
              {editing
                ? 'kept by gurt on this machine, not on any forge yet — tasks clone it and "Merge into main" lands their work in it'
                : 'an empty repository with one initial commit, kept by gurt on this machine — no forge or credential needed'}
            </div>
            {editing && (
              <div className="changes-actions">
                <button className="btn btn-sm" onClick={() => setPublishing(true)}>
                  Publish to GitHub…
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="fld">
            <span className="seclabel">REPOSITORY URL</span>
            <input
              className="input mono"
              placeholder="https://github.com/acme/checkout-web"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <div className="env-access">
              <span className="seclabel">REPO ACCESS</span>
              <div className="env-access-chips" ref={credRef}>
                {linked ? (
                  <span className="chip-tag">
                    <Icon name="key" size={11} style={{ color: 'var(--yellow)' }} />
                    {linked.label}
                    <span className="chip-x" title="unlink" onClick={() => setCredentialId('')}>
                      ×
                    </span>
                  </span>
                ) : (
                  <span className="chip-dashed clickable" onClick={() => setCredMenu((o) => !o)}>
                    + credential
                  </span>
                )}
                {credMenu && (
                  <div className="menu pick-menu">
                    <div
                      className="menu-item"
                      onMouseDown={(e) => {
                        e.preventDefault()
                        setCredentialId('')
                        setCredMenu(false)
                      }}
                    >
                      auto (match by host)
                    </div>
                    {credentials.filter((c) => isGitKind(c.kind)).map((c) => (
                      <div
                        key={c.id}
                        className="menu-item"
                        onMouseDown={(e) => {
                          e.preventDefault()
                          setCredentialId(c.id)
                          setCredMenu(false)
                        }}
                      >
                        <Icon name="key" size={11} className="faint" />
                        {c.label} · {credentialKindLabel(c.kind)}
                      </div>
                    ))}
                  </div>
                )}
                {accessNote && <span className="env-access-note mono">{accessNote}</span>}
              </div>
            </div>
          </div>
        )}

        {error && <div className="error">{error}</div>}
      </div>
      <div className="modal-foot">
        {editing && (
          <button className="btn btn-danger-text" onClick={run(del)}>
            Delete
          </button>
        )}
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!valid} onClick={run(save)}>
          Save
        </button>
      </div>
      {publishing && initial && (
        <PublishRepoModal
          ws={ws}
          repo={initial}
          onClose={() => setPublishing(false)}
          onPublished={onClose}
        />
      )}
    </Modal>
  )
}

/**
 * Publish a local repo (docs/requirements-new-projects.md §6): one form that
 * creates the GitHub repository, pushes the history there, re-points every
 * clone — and, in the same go, turns the repo's own devcontainer into a
 * workspace env, which is when it has usually just been written.
 */
function PublishRepoModal({
  ws,
  repo,
  onClose,
  onPublished
}: {
  ws: string
  repo: RepoConfig
  onClose: () => void
  onPublished: () => void
}) {
  const [credentials, setCredentials] = useState<CredentialEntry[]>([])
  const [credentialId, setCredentialId] = useState('')
  const [remoteName, setRemoteName] = useState(repo.name)
  const [owner, setOwner] = useState('')
  const [priv, setPriv] = useState(true)
  const [adoptEnv, setAdoptEnv] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<PublishResult | null>(null)

  // Only a token can create a repository through the forge API, and only on a
  // forge gurt has a provider for — GitHub today.
  const usable = credentials.filter(
    (c) => c.kind === 'git-token' && c.hosts.some((h) => h.includes('github'))
  )
  useEffect(() => {
    window.gurt
      .getCredentials()
      .then((f) => {
        setCredentials(f.credentials)
        const first = f.credentials.find(
          (c) => c.kind === 'git-token' && c.hosts.some((h) => h.includes('github'))
        )
        if (first) setCredentialId((id) => id || first.id)
      })
      .catch(() => {})
  }, [])

  const publish = async () => {
    setError('')
    setBusy(true)
    try {
      setResult(
        await window.gurt.publishRepo(ws, repo.name, {
          credentialId,
          remoteName,
          owner,
          private: priv,
          adoptEnv
        })
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (result)
    return (
      <Modal title="Published" width={500} onClose={onPublished}>
        <div className="modal-body env-modal">
          <div className="fld">
            <span className="seclabel">REPOSITORY</span>
            <span className="mono">{result.webUrl}</span>
          </div>
          <div className="fld">
            <span className="seclabel">ENVIRONMENT</span>
            <span className="env-access-note">
              {result.env
                ? `created "${result.env}" from the repo's devcontainer — new sessions on ${repo.name} can run in it`
                : adoptEnv
                  ? `none created: ${result.envNote ?? 'nothing found'}`
                  : 'not requested'}
            </span>
          </div>
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button className="btn btn-primary" onClick={onPublished}>
            Done
          </button>
        </div>
      </Modal>
    )

  return (
    <Modal title={`Publish "${repo.name}"`} width={500} onClose={busy ? () => {} : onClose}>
      <div className="modal-body env-modal">
        <div className="fld">
          <span className="seclabel">GITHUB CREDENTIAL</span>
          {usable.length ? (
            <div className="seg">
              {usable.map((c) => (
                <button
                  key={c.id}
                  className={`seg-btn ${credentialId === c.id ? 'active' : ''}`}
                  onClick={() => setCredentialId(c.id)}
                >
                  {c.label}
                </button>
              ))}
            </div>
          ) : (
            <div className="env-access-note">
              no GitHub token yet — add a git-token credential for github.com (🔑 in the sidebar)
            </div>
          )}
        </div>
        <label className="fld">
          <span className="seclabel">NAME ON GITHUB</span>
          <input className="input" value={remoteName} onChange={(e) => setRemoteName(e.target.value)} />
        </label>
        <label className="fld">
          <span className="seclabel">ORGANIZATION</span>
          <input
            className="input"
            placeholder="empty = the token's own account"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
          />
        </label>
        <div className="fld">
          <span className="seclabel">VISIBILITY</span>
          <div className="seg">
            <button className={`seg-btn ${priv ? 'active' : ''}`} onClick={() => setPriv(true)}>
              private
            </button>
            <button className={`seg-btn ${!priv ? 'active' : ''}`} onClick={() => setPriv(false)}>
              public
            </button>
          </div>
        </div>
        <div className="fld">
          <span className="seclabel">ENVIRONMENT</span>
          <div className="seg">
            <button
              className={`seg-btn ${adoptEnv ? 'active' : ''}`}
              title="if the repo has a .devcontainer, create a workspace env from it, defaulting to this repo"
              onClick={() => setAdoptEnv(true)}
            >
              adopt the repo&apos;s devcontainer
            </button>
            <button className={`seg-btn ${!adoptEnv ? 'active' : ''}`} onClick={() => setAdoptEnv(false)}>
              leave envs as they are
            </button>
          </div>
        </div>
        <div className="env-access-note">
          Every branch is pushed, every task&apos;s clone follows the new origin, and gurt&apos;s local
          copy is removed. Uncommitted work in the clones is untouched.
        </div>
        {error && <div className="error">{error}</div>}
      </div>
      <div className="modal-foot">
        <span className="spacer" />
        <button className="btn" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          disabled={busy || !credentialId || !remoteName.trim()}
          onClick={run(publish)}
        >
          {busy ? 'Publishing…' : 'Publish'}
        </button>
      </div>
    </Modal>
  )
}

/** Line-numbered code editor with an optional highlight overlay behind a
 *  transparent textarea — plain text when `highlight` is omitted. */
function CodeEditor({
  value,
  onChange,
  highlight,
  placeholder
}: {
  value: string
  onChange: (v: string) => void
  highlight?: (src: string) => JSX.Element[]
  placeholder?: string
}) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const hlRef = useRef<HTMLPreElement>(null)
  const gutRef = useRef<HTMLDivElement>(null)
  const lines = value ? value.split('\n').length : 1

  const sync = () => {
    const ta = taRef.current
    if (!ta) return
    if (hlRef.current) {
      hlRef.current.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`
    }
    if (gutRef.current) gutRef.current.style.transform = `translateY(${-ta.scrollTop}px)`
  }

  return (
    <div className="jsoned">
      <div className="jsoned-gutter">
        <div ref={gutRef} className="jsoned-gutter-inner mono">
          {Array.from({ length: lines }, (_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
      </div>
      <div className="jsoned-area">
        <pre ref={hlRef} className="jsoned-hl mono" aria-hidden>
          {highlight ? highlight(value) : value}
          {'\n'}
        </pre>
        <textarea
          ref={taRef}
          className="jsoned-input mono"
          spellCheck={false}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={sync}
        />
      </div>
    </div>
  )
}

/** JSON-flavored `CodeEditor` — devcontainer.json inline overrides. */
function JsonEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <CodeEditor
      value={value}
      onChange={onChange}
      highlight={highlightJson}
      placeholder='{ "image": "mcr.microsoft.com/devcontainers/base:ubuntu" }'
    />
  )
}

/** Tokenized JSON for the editor overlay: keys accent, strings teal, punctuation faint. */
function highlightJson(src: string): JSX.Element[] {
  const out: JSX.Element[] = []
  const re =
    /("(?:[^"\\]|\\.)*")(\s*:)|("(?:[^"\\]|\\.)*")|(\btrue\b|\bfalse\b|\bnull\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],:])/g
  let last = 0
  let k = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    if (m.index > last) out.push(<span key={k++}>{src.slice(last, m.index)}</span>)
    if (m[1] != null) {
      out.push(
        <span key={k++} className="j-key">
          {m[1]}
        </span>,
        <span key={k++} className="j-punc">
          {m[2]}
        </span>
      )
    } else if (m[3] != null)
      out.push(
        <span key={k++} className="j-str">
          {m[3]}
        </span>
      )
    else if (m[4] != null)
      out.push(
        <span key={k++} className="j-lit">
          {m[4]}
        </span>
      )
    else if (m[5] != null)
      out.push(
        <span key={k++} className="j-num">
          {m[5]}
        </span>
      )
    else
      out.push(
        <span key={k++} className="j-punc">
          {m[6]}
        </span>
      )
    last = re.lastIndex
  }
  if (last < src.length) out.push(<span key={k}>{src.slice(last)}</span>)
  return out
}

// ---- Clients (#4c) — agent instances ----

/** Temp-keyed rows are new instances whose id is minted from the label on save. */
const isTemp = (id: string) => id.startsWith('__new__:')

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

function uniqueId(label: string, kind: string, taken: Set<string>): string {
  const base = slug(label) || kind
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  return id
}

/** Serialize/parse the extra-env map as `KEY=VALUE` lines for the textarea. */
const envToText = (env?: Record<string, string>) =>
  Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n')

function textToEnv(text: string): Record<string, string> | undefined {
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
  }
  return Object.keys(env).length ? env : undefined
}

// ---- MCP servers (docs/requirements-mcp-proxy.md §3, §11 ·
//      docs/requirements-mcp-stdio.md §3, §5, §8.2) ----

/** The three transports, in the order the picker offers them: what the
 *  ecosystem publishes first, the original remote shape second, the escape
 *  hatch last (docs/requirements-mcp-stdio.md §3). */
const MCP_KINDS: { kind: McpEntryKind; label: string; hint: string }[] = [
  { kind: 'npm', label: 'npm package', hint: 'gurt installs it and runs it on this machine' },
  { kind: 'http', label: 'Remote URL', hint: 'an http(s) endpoint the session proxy calls' },
  { kind: 'command', label: 'Command (advanced)', hint: 'uvx, docker, a script — run as written' }
]

/** argv as text: one argument per line, so a value containing a space needs no
 *  quoting rules of gurt's own invention. */
const argsToText = (args?: readonly string[]): string => (args ?? []).join('\n')
const textToArgs = (text: string): string[] =>
  text
    .split('\n')
    .map((a) => a.trim())
    .filter(Boolean)

// ---- Agent access (workspace-scoped): default agent + deny-list ----
// The agents themselves stay a global registry (see `ClientsSection`); this is
// which of them a session in *this* workspace may use, and which one it gets
// when it names none — the same "registry is global, use is per-workspace"
// split `EnvironmentsSection`/`ReposSection` don't need because envs/repos
// were workspace-scoped from the start.

function AgentAccessSection({ tree, ws }: { tree: Tree | null; ws: string | null }) {
  const agents = useAgents()
  const [error, setError] = useState('')
  const wsData = tree?.workspaces.find((w) => w.name === ws)
  const defaultAgent = wsData?.defaultAgent
  const denied = new Set(wsData?.deniedAgents ?? [])
  const entries = Object.entries(agents)

  const pickDefault = async (id: string | undefined) => {
    if (!ws) return
    setError('')
    try {
      await window.gurt.setDefaultAgent(ws, id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const toggleDenied = async (id: string) => {
    if (!ws) return
    setError('')
    const next = denied.has(id) ? [...denied].filter((x) => x !== id) : [...denied, id]
    try {
      await window.gurt.setDeniedAgents(ws, next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <>
      <div className="set-head">
        <div className="set-title-wrap">
          <span className="set-title">Agent access</span>
          <span className="set-count mono">
            {entries.length} client{entries.length === 1 ? '' : 's'}
            {ws ? ` · ${ws}` : ''}
          </span>
        </div>
      </div>
      <div className="set-list">
        {entries.map(([id, a]) => {
          const isDefault = defaultAgent === id
          const isDenied = denied.has(id)
          return (
            <div key={id} className="set-row">
              <span className="set-row-label">{a.label || id}</span>
              <AgentTag kind={a.kind} name={agentDef(a.kind)?.label ?? a.kind} />
              <span className="spacer" />
              <button
                type="button"
                className={`btn-link ${isDefault ? 'active' : ''}`}
                disabled={!ws || isDenied}
                title={isDenied ? 'denied agents cannot be the default' : undefined}
                onClick={() => void pickDefault(isDefault ? undefined : id)}
              >
                {isDefault ? 'default ✓' : 'set default'}
              </button>
              <button
                type="button"
                className={`btn-link ${isDenied ? 'active' : ''}`}
                disabled={!ws || isDefault}
                title={isDefault ? 'the default agent cannot be denied' : undefined}
                onClick={() => void toggleDenied(id)}
              >
                {isDenied ? 'denied' : 'deny'}
              </button>
            </div>
          )
        })}
        {entries.length === 0 && (
          <div className="tp-dashed">no clients configured yet — add one in Settings → Clients</div>
        )}
      </div>
      {error && <div className="error">{error}</div>}
    </>
  )
}

/** The workspace's MCP registry, plus the built-ins listed read-only so both
 *  sources of the composer's picker are visible in one place (§11). */
function McpServersSection({ ws }: { ws: string | null }) {
  const [servers, setServers] = useState<McpRegistryEntry[]>([])
  const [builtins, setBuiltins] = useState<McpDef[]>([])
  const [editing, setEditing] = useState<McpRegistryEntry | null>(null)
  /** The kind a `+ Add` pick chose, i.e. "a new entry of this shape". */
  const [adding, setAdding] = useState<McpEntryKind | null>(null)
  const [addMenu, setAddMenu] = useState(false)
  const [error, setError] = useState('')
  const addRef = useRef<HTMLDivElement>(null)
  useOutsideClose(addMenu, addRef, () => setAddMenu(false))

  const refresh = useCallback(() => {
    if (!ws) {
      setServers([])
      return
    }
    window.gurt
      .getMcpServers(ws)
      .then(setServers)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [ws])

  // Mutations elsewhere (another window, a workspace switch) announce over
  // tree.changed, the same signal the repo/env lists ride.
  useEffect(() => {
    refresh()
    return window.gurt.onTreeChanged(refresh)
  }, [refresh])

  useEffect(() => {
    window.gurt.getMcpDefs().then(setBuiltins).catch(() => {})
  }, [])

  return (
    <>
      <div className="set-head">
        <div className="set-title-wrap">
          <span className="set-title">MCP servers</span>
          <span className="set-count mono">
            {servers.length} server{servers.length === 1 ? '' : 's'}
            {ws ? ` · ${ws}` : ''}
          </span>
        </div>
        <span className="spacer" />
        {/* Three transports, so the transport is chosen before the form rather
            than as a field inside one shape's editor. */}
        <div className="pick-wrap" ref={addRef}>
          <button
            className="btn btn-primary"
            disabled={!ws}
            onClick={() => setAddMenu((o) => !o)}
          >
            + Add
            <Icon name="chevron" size={11} />
          </button>
          {addMenu && (
            <div className="menu pick-menu right">
              {MCP_KINDS.map((k) => (
                <div
                  key={k.kind}
                  className="menu-item"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    setAddMenu(false)
                    setAdding(k.kind)
                  }}
                >
                  {k.label}
                  <span className="menu-hint">{k.hint}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="set-list">
        {servers.map((m) => (
          <div key={m.id} className="set-row">
            <span className="set-row-label">{mcpLabel(m)}</span>
            <span className="set-row-url mono">{mcpEntryDetail(m)}</span>
            {mcpCredentialIds(m).length > 0 && (
              <Icon name="key" size={11} style={{ color: 'var(--yellow)', flex: 'none' }} />
            )}
            {/* Said here, in the editor and in the composer's picker — every
                surface that offers a local entry carries the same line
                (docs/requirements-mcp-stdio.md §2). */}
            {isLocalMcpEntry(m) && <span className="mcp-local-note">{LOCAL_MCP_NOTICE}</span>}
            <button className="btn-link" onClick={() => setEditing(m)}>
              edit
            </button>
          </div>
        ))}
        {servers.length === 0 && (
          <div className="tp-dashed">
            no MCP servers yet — add one to offer it to this workspace&apos;s sessions
          </div>
        )}
        {builtins.length > 0 && (
          <>
            <div className="set-sub">Built-in · provided by gurt, not editable</div>
            {builtins.map((def) => (
              <div key={def.id} className="set-row faint" title={def.description}>
                <span className="set-row-label">{def.label}</span>
                <span className="set-row-url">{def.description}</span>
              </div>
            ))}
          </>
        )}
        {error && <div className="error">{error}</div>}
      </div>
      {(editing || adding) && ws && (
        <McpServerModal
          key={editing?.id ?? `__new:${adding}`}
          ws={ws}
          taken={servers.filter((m) => m.id !== editing?.id).map((m) => m.id)}
          initial={editing ?? undefined}
          initialKind={adding ?? 'npm'}
          onClose={() => {
            setEditing(null)
            setAdding(null)
            refresh()
          }}
        />
      )}
    </>
  )
}

/**
 * The workspace's skill registry (docs/requirements-skills.md §7).
 *
 * Modelled on `McpServersSection`, and different in one place: the "enabled by
 * default" toggle lives on the *row*, not in the editor, because it is a
 * property of the workspace (`defaultSkills`) rather than of the skill — the
 * same reason `AgentAccessSection` puts "set default" beside each client
 * instead of inside the client's form.
 */
function SkillsSection({ tree, ws }: { tree: Tree | null; ws: string | null }) {
  const [skills, setSkills] = useState<SkillEntry[]>([])
  const [editing, setEditing] = useState<SkillEntry | null>(null)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const defaults = new Set(tree?.workspaces.find((w) => w.name === ws)?.defaultSkills ?? [])

  const refresh = useCallback(() => {
    if (!ws) {
      setSkills([])
      return
    }
    window.gurt
      .getSkills(ws)
      .then(setSkills)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [ws])

  // Every registry write announces itself on tree.changed (ipc.ts), the same
  // signal the repo/env/MCP lists ride.
  useEffect(() => {
    refresh()
    return window.gurt.onTreeChanged(refresh)
  }, [refresh])

  const toggleDefault = async (name: string) => {
    if (!ws) return
    setError('')
    const next = defaults.has(name)
      ? [...defaults].filter((n) => n !== name)
      : [...defaults, name]
    try {
      await window.gurt.setDefaultSkills(ws, next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <>
      <div className="set-head">
        <div className="set-title-wrap">
          <span className="set-title">Skills</span>
          <span className="set-count mono">
            {skills.length} skill{skills.length === 1 ? '' : 's'}
            {ws ? ` · ${ws}` : ''}
          </span>
        </div>
        <span className="spacer" />
        <button className="btn btn-primary" disabled={!ws} onClick={() => setAdding(true)}>
          + Add
        </button>
      </div>
      <div className="set-list">
        {skills.map((k) => (
          <div key={k.name} className="set-row">
            <span className="set-row-label mono">{k.name}</span>
            <span
              className="set-row-url"
              // `.set-row-url` wins the cascade over `.error`, so the colour is
              // set here rather than by stacking the two classes.
              style={k.problem ? { color: 'var(--red)' } : undefined}
              title={k.problem ?? k.description}
            >
              {k.problem ?? k.description}
            </span>
            {k.files.length > 0 && (
              <span className="mono faint" title={k.files.join('\n')}>
                +{k.files.length} file{k.files.length === 1 ? '' : 's'}
              </span>
            )}
            <span className="spacer" />
            <button
              type="button"
              className={`btn-link ${defaults.has(k.name) ? 'active' : ''}`}
              disabled={!ws}
              title="switch this skill on in every new draft of this workspace"
              onClick={() => void toggleDefault(k.name)}
            >
              {defaults.has(k.name) ? 'default ✓' : 'enable by default'}
            </button>
            <button className="btn-link" onClick={() => setEditing(k)}>
              edit
            </button>
          </div>
        ))}
        {skills.length === 0 && (
          <div className="tp-dashed">
            no skills yet — add one to offer it to this workspace&apos;s sessions
          </div>
        )}
        <div className="set-sub">
          Stored under ~/.gurt/{ws || '<workspace>'}/skills and mounted read-only into a
          session&apos;s container. A repository&apos;s own .claude/skills is the repository&apos;s
          — gurt neither lists nor disables those.
        </div>
        {error && <div className="error">{error}</div>}
      </div>
      {(editing || adding) && ws && (
        <SkillModal
          key={editing?.name ?? '__new'}
          ws={ws}
          taken={skills.filter((k) => k.name !== editing?.name).map((k) => k.name)}
          initial={editing ?? undefined}
          onClose={() => {
            setEditing(null)
            setAdding(false)
            refresh()
          }}
        />
      )}
    </>
  )
}

/** Name + `SKILL.md`. The document is validated as it is typed — with the same
 *  function the store runs at save, so the verdict previewed here is the
 *  verdict that decides — and the supporting files found beside it are listed
 *  read-only, so a skill whose body points at `references/x.md` shows whether
 *  that file actually travels with it. */
function SkillModal({
  ws,
  taken,
  initial,
  onClose
}: {
  ws: string
  /** The other skills' names — uniqueness is previewed here and enforced in the
   *  store. */
  taken: string[]
  initial?: SkillEntry | undefined
  onClose: () => void
}) {
  const editing = !!initial
  const [name, setName] = useState(initial?.name ?? '')
  const [doc, setDoc] = useState('')
  const [loaded, setLoaded] = useState(!editing)
  const [error, setError] = useState('')

  // An existing skill's body is fetched on open rather than carried in the
  // list: `getSkills` is read on every tree.changed by two other surfaces, and
  // whole documents have no business in that payload.
  useEffect(() => {
    if (!initial) {
      setDoc(skillTemplate(''))
      return
    }
    let live = true
    window.gurt
      .getSkillDoc(ws, initial.name)
      .then((text) => {
        if (!live) return
        setDoc(text)
        setLoaded(true)
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [ws, initial])

  const clean = name.trim()
  const nameProblem = skillNameProblem(clean, taken)
  // Only once the document is the user's: an editor still fetching would
  // otherwise flash the template's mismatched name as an error.
  const docProblem = loaded && !nameProblem ? validateSkillDoc(clean, doc).error : undefined
  const invalid = nameProblem ?? docProblem

  const save = async () => {
    setError('')
    try {
      await (editing
        ? window.gurt.updateSkill(ws, clean, doc)
        : window.gurt.addSkill(ws, clean, doc))
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const del = async () => {
    setError('')
    // Asked before the confirm, not after: the store refuses this delete, so a
    // dialog offering to go ahead anyway would be offering something that
    // cannot happen (docs/requirements-skills.md §7).
    const used = await window.gurt.skillUsedBy(ws, initial!.name).catch(() => [] as string[])
    if (used.length) {
      setError(
        `selected by session(s) in scope(s): ${used.join(', ')} — unselect it there first`
      )
      return
    }
    if (
      !(await confirmDialog(
        `Delete skill "${initial!.name}"? Its directory and every supporting file in it go with it.`,
        { title: 'Delete skill', confirmText: 'Delete', danger: true }
      ))
    )
      return
    try {
      await window.gurt.removeSkill(ws, initial!.name)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal title={editing ? 'Edit skill' : 'New skill'} width={620} onClose={onClose}>
      <div className="modal-body env-modal">
        <label className="fld">
          <span className="seclabel">NAME</span>
          <input
            className="input mono"
            placeholder="review-checklist"
            value={name}
            // Immutable once saved: the name is the directory, and it is what
            // every session's selection stores.
            disabled={editing}
            onChange={(e) => {
              const next = e.target.value
              // Keep the template's frontmatter in step while it is still the
              // template — otherwise a fresh form is invalid the moment the
              // first character is typed, which reads as the editor being broken.
              setDoc((prev) => (prev === skillTemplate(name) ? skillTemplate(next) : prev))
              setName(next)
            }}
          />
          <span className="fld-hint">
            {editing
              ? 'fixed — a session selects a skill by name; add a new one to rename'
              : 'lowercase letters, digits and single hyphens; it is the directory name and the frontmatter `name`'}
          </span>
        </label>

        <div className="fld">
          <span className="seclabel">SKILL.md</span>
          <textarea
            className="input mono snippet-input"
            rows={18}
            spellCheck={false}
            value={doc}
            onChange={(e) => setDoc(e.target.value)}
          />
          <span className="fld-hint">
            YAML frontmatter (`name`, `description`) over the markdown body. The description is all
            the agent reads until it decides to open the body — write it as a trigger, not a title.
          </span>
        </div>

        {!!initial?.files.length && (
          <div className="fld">
            <span className="seclabel">SUPPORTING FILES</span>
            <span className="fld-hint mono">{initial.files.join('  ·  ')}</span>
            <span className="fld-hint">
              Found beside SKILL.md and mounted with it. Add or remove them in the directory itself
              — this editor writes SKILL.md and nothing else.
            </span>
          </div>
        )}

        {(error || invalid) && <div className="error">{error || invalid}</div>}
      </div>
      <div className="modal-foot">
        {editing && (
          <button className="btn btn-danger-text" onClick={run(del)}>
            Delete
          </button>
        )}
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!!invalid || !loaded} onClick={run(save)}>
          Save
        </button>
      </div>
    </Modal>
  )
}

/** A secret lifted out of a pasted value and held here until Save (§5): it goes
 *  into the credential store, never into `workspace.json`. Until then its row
 *  links it under a {@link PENDING_PREFIX} id, so the draft the user sees
 *  validated is the draft that will be written. */
interface PendingSecret {
  /** The header or variable it was found in — the credential's label on Save. */
  name: string
  value: string
}

/** Stands in for a credential Save is going to create. It never leaves this
 *  modal: Save swaps it for the real id, the probe for the value itself. */
const PENDING_PREFIX = '__pending__:'
const isPending = (credentialId: string): boolean => credentialId.startsWith(PENDING_PREFIX)

/** What a newly linked value is prefixed with: `Bearer ` for an
 *  `Authorization` header, which is nearly always what it wants, and nothing
 *  for anything else. Editable on the row either way. */
const defaultPrefix = (kind: 'header' | 'env', name: string): string =>
  kind === 'header' && /^authorization$/i.test(name.trim()) ? 'Bearer ' : ''

/** One header or environment row. Same shape for both — `McpHeader` and
 *  `McpEnvRow` differ only in where the value goes. */
type McpRow = McpEnvRow

/**
 * One header or environment variable: a name, and a value that is either typed
 * in — stored in workspace.json, sent verbatim — or linked to a credential,
 * resolved on this machine when it is used and never written to the workspace.
 */
function McpValueRowEditor({
  kind,
  row,
  credentials,
  pending,
  onChange,
  onLift,
  onUnlink,
  onRemove
}: {
  kind: 'header' | 'env'
  row: McpRow
  credentials: CredentialEntry[]
  pending: Record<string, PendingSecret>
  onChange: (patch: Partial<McpRow>) => void
  onLift: () => void
  onUnlink: () => void
  onRemove: () => void
}): JSX.Element {
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useOutsideClose(menu, menuRef, () => setMenu(false))
  const { name, value } = row
  const linked = isMcpCredentialRef(value) ? value : null
  const pend = linked && isPending(linked.credentialId) ? pending[linked.credentialId] : undefined
  const cred = linked ? credentials.find((c) => c.id === linked.credentialId) : undefined
  const lift = typeof value === 'string' ? pastedSecret(kind, name, value) : null
  const badName = kind === 'env' && !!name.trim() && !isEnvName(name.trim())
  const options = mcpCredentials(credentials)

  const link = (credentialId: string) => {
    const prefix = linked ? (linked.prefix ?? '') : defaultPrefix(kind, name)
    onChange({ value: { credentialId, ...(prefix ? { prefix } : {}) } })
    setMenu(false)
  }

  return (
    <div>
      <div className="mcp-hdr">
        <input
          className="input mono"
          placeholder={kind === 'env' ? 'KUBECONFIG' : 'X-Workspace'}
          value={name}
          onChange={(e) => onChange({ name: e.target.value })}
        />
        {linked ? (
          <div className="mcp-ref">
            <input
              className="input mono mcp-prefix"
              placeholder="prefix"
              title="sent in front of the secret, verbatim — “Bearer ” for most Authorization headers"
              value={linked.prefix ?? ''}
              onChange={(e) =>
                onChange({
                  value: {
                    credentialId: linked.credentialId,
                    ...(e.target.value ? { prefix: e.target.value } : {})
                  }
                })
              }
            />
            <span className="chip-tag mcp-ref-chip">
              <Icon name="key" size={11} style={{ color: 'var(--yellow)', flex: 'none' }} />
              <span className="menu-item-name">
                {pend ? `new credential · ${pend.name}` : (cred?.label ?? 'missing credential')}
              </span>
              <span
                className="chip-x"
                title={pend ? 'keep it inline instead' : 'unlink'}
                onClick={onUnlink}
              >
                ×
              </span>
            </span>
          </div>
        ) : (
          <input
            className="input mono"
            placeholder="value"
            value={value as string}
            onChange={(e) => onChange({ value: e.target.value })}
          />
        )}
        <div className="pick-wrap" ref={menuRef}>
          <button
            className="btn-link"
            title="take the value from a credential"
            onClick={() => setMenu((o) => !o)}
          >
            <Icon name="key" size={11} />
          </button>
          {menu && (
            <div className="menu pick-menu right">
              {options.map((c) => (
                <div
                  key={c.id}
                  className="menu-item"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    link(c.id)
                  }}
                >
                  <Icon name="key" size={11} className="faint" />
                  {c.label} · {credentialKindLabel(c.kind)}
                </div>
              ))}
              {options.length === 0 && (
                <div className="menu-item faint">no mcp token — add one in Credentials</div>
              )}
            </div>
          )}
        </div>
        <button
          className="btn-link"
          title={kind === 'env' ? 'remove variable' : 'remove header'}
          onClick={onRemove}
        >
          ×
        </button>
      </div>
      {badName && <span className="error">{name.trim()} is not an environment variable name</span>}
      {lift && (
        <span className="mcp-local-note">
          that value looks like a secret — workspace.json is a plain file{' '}
          <button className="btn-link" onClick={onLift}>
            store it as a credential
          </button>
        </span>
      )}
    </div>
  )
}

function McpServerModal({
  ws,
  taken,
  initial,
  initialKind,
  onClose
}: {
  ws: string
  /** Ids of the other entries — id uniqueness is previewed here and enforced
   *  in the store validator (§3.3). */
  taken: string[]
  initial?: McpRegistryEntry | undefined
  /** Shape of a *new* entry, as the `+ Add` menu chose it. Ignored when editing:
   *  an existing entry's kind comes from the entry, and the picker below can
   *  still change it. */
  initialKind: McpEntryKind
  onClose: () => void
}) {
  const editing = !!initial
  const http = initial && isHttpMcpEntry(initial) ? initial : undefined
  const local = initial && isLocalMcpEntry(initial) ? initial : undefined
  const [kind, setKind] = useState<McpEntryKind>(initial ? mcpEntryKind(initial) : initialKind)
  const [id, setId] = useState(initial?.id ?? '')
  const [label, setLabel] = useState(initial?.label ?? '')
  const [url, setUrl] = useState(http?.url ?? '')
  const [headers, setHeaders] = useState<McpRow[]>(http?.headers?.map((h) => ({ ...h })) ?? [])
  const [pkg, setPkg] = useState(local?.kind === 'npm' ? local.package : '')
  const [version, setVersion] = useState((local?.kind === 'npm' && local.version) || '')
  const [command, setCommand] = useState(local?.kind === 'command' ? local.command : '')
  const [cwd, setCwd] = useState((local?.kind === 'command' && local.cwd) || '')
  const [argsText, setArgsText] = useState(argsToText(local?.args))
  const [envRows, setEnvRows] = useState<McpRow[]>(mcpEnvRows(local?.env))
  /** An http entry's legacy single link, until the credentials arrive to lift
   *  it into the header row it means — kept in the draft until then, so a save
   *  in that instant does not drop it. */
  const [legacy, setLegacy] = useState(http?.credentialId ? http : undefined)
  const [pending, setPending] = useState<Record<string, PendingSecret>>({})
  const [snippet, setSnippet] = useState('')
  const [snippetError, setSnippetError] = useState('')
  const [credentials, setCredentials] = useState<CredentialEntry[]>([])
  const [probing, setProbing] = useState(false)
  /** The last probe, keyed by the entry it was run against — an edit made after
   *  it invalidates it, and a stale green tick is worse than none. */
  const [probed, setProbed] = useState<{ key: string; result: McpProbeResult } | null>(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    window.gurt
      .getCredentials()
      .then((f) => {
        setCredentials(f.credentials)
        if (!legacy) return
        // The form only ever saves the lifted shape: the header name and scheme
        // that used to live on the token become this entry's header row.
        setHeaders(
          (prev) => liftLegacyMcpCredential(f.credentials, { ...legacy, headers: prev }).headers ?? []
        )
        setLegacy(undefined)
      })
      .catch(() => {})
  }, [legacy])

  const isLocal = kind !== 'http'

  /**
   * The entry the form currently describes.
   *
   * `inline` is the probe's version of it (§4.6): a lifted-but-unsaved secret
   * goes back into its row as text, because there is no credential to link to
   * until Save — and a probe that always failed on "linked credential no
   * longer exists" would be useless in exactly the flow it exists for.
   * `relink` is Save's: pending ids swapped for the credentials just created.
   */
  const buildDraft = ({
    inline = false,
    relink = {}
  }: { inline?: boolean; relink?: Record<string, string> } = {}): McpEntryDraft => {
    const resolve = (value: McpValue): McpValue => {
      if (!isMcpCredentialRef(value)) return value
      const secret = pending[value.credentialId]
      if (inline && secret) return `${value.prefix ?? ''}${secret.value}`
      const real = relink[value.credentialId]
      return real ? { ...value, credentialId: real } : value
    }
    const rows = (list: McpRow[]): McpRow[] => list.map((r) => ({ name: r.name, value: resolve(r.value) }))
    const tail = { id: id.trim(), label }
    const localTail = { args: textToArgs(argsText), env: mcpEnvRecord(rows(envRows)) }
    return kind === 'http'
      ? {
          ...tail,
          url,
          headers: rows(headers),
          ...(legacy?.credentialId ? { credentialId: legacy.credentialId } : {})
        }
      : kind === 'npm'
        ? { kind: 'npm', ...tail, ...localTail, package: pkg, version }
        : { kind: 'command', ...tail, ...localTail, command, cwd }
  }

  const entry = normalizeMcpEntry(buildDraft())
  const probeEntry = normalizeMcpEntry(buildDraft({ inline: true }))
  const probeKey = JSON.stringify(probeEntry)
  // The same validator the store runs — the modal only previews its verdict.
  const invalid = validateMcpEntry(entry, { takenIds: taken })
  // A pending secret has no stored credential to resolve yet; it is checked by
  // being created, at save time. The renderer holds masks only, so whether a
  // secret can be *carried* is main's check, on save.
  const credError = mcpCredentialIds(entry)
    .filter((cid) => !isPending(cid))
    .map((cid) => resolveMcpSecret(credentials, cid).error)
    .find(Boolean)

  const setRows = (k: 'header' | 'env') => (k === 'header' ? setHeaders : setEnvRows)
  const patchRow = (k: 'header' | 'env', i: number, patch: Partial<McpRow>) =>
    setRows(k)((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  /** Rows with every value that looks like a secret moved into a pending
   *  credential — nothing is written to the credential store by looking at a
   *  form; Save does that. */
  const liftRows = (k: 'header' | 'env', list: McpRow[]): McpRow[] => {
    const fresh: Record<string, PendingSecret> = {}
    const out = list.map((r) => {
      const found = typeof r.value === 'string' ? pastedSecret(k, r.name, r.value) : null
      if (!found) return r
      const pid = `${PENDING_PREFIX}${crypto.randomUUID()}`
      fresh[pid] = { name: r.name.trim(), value: found.secret }
      return { name: r.name, value: { credentialId: pid, ...(found.prefix ? { prefix: found.prefix } : {}) } }
    })
    setPending((prev) => ({ ...prev, ...fresh }))
    return out
  }

  const liftRow = (k: 'header' | 'env', i: number) => {
    const list = k === 'header' ? headers : envRows
    const row = list[i]
    if (!row) return
    const [lifted] = liftRows(k, [row])
    patchRow(k, i, { value: lifted!.value })
  }

  /** Unlink a row. A pending secret goes back where the paste had it — the
   *  user's call, and the only way back to an inline value; a stored credential
   *  just leaves an empty value to type into. */
  const unlinkRow = (k: 'header' | 'env', i: number) => {
    const row = (k === 'header' ? headers : envRows)[i]
    if (!row || !isMcpCredentialRef(row.value)) return
    const secret = pending[row.value.credentialId]
    patchRow(k, i, { value: secret ? `${row.value.prefix ?? ''}${secret.value}` : '' })
  }

  const rowEditor = (k: 'header' | 'env', row: McpRow, i: number) => (
    <McpValueRowEditor
      key={i}
      kind={k}
      row={row}
      credentials={credentials}
      pending={pending}
      onChange={(patch) => patchRow(k, i, patch)}
      onLift={() => liftRow(k, i)}
      onUnlink={() => unlinkRow(k, i)}
      onRemove={() => setRows(k)((prev) => prev.filter((_, j) => j !== i))}
    />
  )

  /**
   * A published snippet, straight into the form (§5). `parseMcpSnippet` does all
   * of the reading — the kind, the id, the package and version, the argv, the
   * env — so a `uvx` or `docker` snippet switches this form to `command` rather
   * than being refused. Its error is a sentence written for the user; it is
   * shown as it is.
   */
  const applySnippet = (text: string) => {
    if (!text.trim()) return
    const result: McpSnippetResult = parseMcpSnippet(text)
    if (!result.entry) {
      setSnippetError(result.error ?? 'that snippet could not be read')
      return
    }
    const parsed = result.entry
    setSnippetError('')
    setNote('')
    setKind(mcpEntryKind(parsed))
    // The id is a route segment and a selection key, so an existing entry keeps
    // the one its sessions already name.
    if (!editing) setId(parsed.id)
    if (parsed.label) setLabel(parsed.label)
    // A snippet's `env` and `headers` are where READMEs put a real token, and
    // `workspace.json` is a plain file meant to be shared and committed. So a
    // value that looks like a secret is lifted out here, by default, rather
    // than being saved inline and warned about afterwards (§5).
    if (isHttpMcpEntry(parsed)) {
      setUrl(parsed.url)
      setHeaders(liftRows('header', parsed.headers?.map((h) => ({ ...h })) ?? []))
      return
    }
    setPkg(parsed.kind === 'npm' ? parsed.package : '')
    setVersion((parsed.kind === 'npm' && parsed.version) || '')
    setCommand(parsed.kind === 'command' ? parsed.command : '')
    setCwd((parsed.kind === 'command' && parsed.cwd) || '')
    setArgsText(argsToText(parsed.args))
    setEnvRows(liftRows('env', mcpEnvRows(parsed.env)))
  }

  /** Store every pending secret the entry still links as an `mcp-token`, in one
   *  write, and return pending id → real id. Written before the entry, so a
   *  failure here leaves no entry pointing at a credential that does not
   *  exist; and swapped into the rows at once, so a retry after the entry's
   *  own save fails does not store them twice. */
  const createCredentials = async (): Promise<Record<string, string>> => {
    const used = mcpCredentialIds(entry).filter((cid) => isPending(cid) && pending[cid])
    if (!used.length) return {}
    const fresh: CredentialEntry[] = used.map((pid) => ({
      id: crypto.randomUUID(),
      label: `${id.trim() || 'mcp'} ${pending[pid]!.name}`,
      kind: 'mcp-token',
      hosts: [],
      data: { secret: pending[pid]!.value }
    }))
    const file = await window.gurt.getCredentials()
    await window.gurt.setCredentials({ credentials: [...file.credentials, ...fresh] })
    const relink = Object.fromEntries(used.map((pid, k) => [pid, fresh[k]!.id]))
    const swap = (list: McpRow[]): McpRow[] =>
      list.map((r) =>
        isMcpCredentialRef(r.value) && relink[r.value.credentialId]
          ? { ...r, value: { ...r.value, credentialId: relink[r.value.credentialId]! } }
          : r
      )
    setHeaders(swap)
    setEnvRows(swap)
    setCredentials((await window.gurt.getCredentials()).credentials)
    return relink
  }

  const save = async () => {
    setError('')
    try {
      const relink = await createCredentials()
      const saved = normalizeMcpEntry(buildDraft({ relink }))
      await (editing
        ? window.gurt.updateMcpServer(ws, saved)
        : window.gurt.addMcpServer(ws, saved))
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * Run it. For a local entry that means installing the package if it is not
   * installed, spawning the process on this machine, doing the MCP handshake,
   * listing what it offers and stopping it again (§4.6) — every failure the
   * static checks cannot see, moved to a button the user presses while the form
   * that caused it is still open.
   *
   * Only ever from here. Nothing about saving an entry runs it: a local entry
   * is third-party code with the user's privileges, which is what the notice
   * above this form says, and "I typed a package name" must not quietly mean
   * "I ran it" (§2).
   */
  const probe = async () => {
    setError('')
    setNote('')
    setProbing(true)
    const key = probeKey
    try {
      setProbed({ key, result: await window.gurt.probeMcpServer(ws, probeEntry) })
    } catch (e) {
      // The probe answers rather than throws, so this is the call itself
      // failing — shown in the same place, so the button always resolves.
      setProbed({ key, result: { ok: false, kind, error: e instanceof Error ? e.message : String(e) } })
    } finally {
      setProbing(false)
    }
  }

  /** Forget what is installed, so the next session start installs it again —
   *  the button behind a pinned `latest` (§4.2). A running process keeps
   *  running: gurt does not restart a local server under its holders (§10). */
  const reinstall = async () => {
    setError('')
    try {
      await window.gurt.reinstallMcpServer(ws, initial!.id)
      setNote('will be installed again the next time a session starts it')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const del = async () => {
    if (
      !(await confirmDialog(`Delete MCP server "${mcpLabel(initial!)}"?`, {
        title: 'Delete MCP server',
        confirmText: 'Delete',
        danger: true
      }))
    )
      return
    try {
      await window.gurt.removeMcpServer(ws, initial!.id)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const filledIn = id.trim() || url.trim() || pkg.trim() || command.trim()

  return (
    <Modal title={editing ? 'Edit MCP server' : 'New MCP server'} width={520} onClose={onClose}>
      <div className="modal-body env-modal">
        <div className="fld">
          <span className="seclabel">TRANSPORT</span>
          <div className="seg">
            {MCP_KINDS.map((k) => (
              <button
                key={k.kind}
                className={`seg-btn ${kind === k.kind ? 'active' : ''}`}
                title={k.hint}
                onClick={() => setKind(k.kind)}
              >
                {k.label}
              </button>
            ))}
          </div>
        </div>

        {/* Every surface that offers a local entry says this, in these words
            (docs/requirements-mcp-stdio.md §2). */}
        {isLocal && (
          <div className="mcp-notice">
            <Icon name="key" size={12} />
            <span>
              {LOCAL_MCP_NOTICE} The session container still sees nothing but a proxy URL — this
              process does not run in it.
            </span>
          </div>
        )}

        {isLocal && (
          <div className="fld">
            <div className="fld-head">
              <span className="seclabel">PASTE FROM README</span>
              <span className="spacer" />
              <button className="btn-link" onClick={() => applySnippet(snippet)}>
                fill the form
              </button>
            </div>
            <textarea
              className="input mono snippet-input"
              rows={4}
              spellCheck={false}
              placeholder={'{"mcpServers": {"kubernetes": {"command": "npx", "args": ["-y", "kubernetes-mcp-server@latest", "--read-only"]}}}'}
              value={snippet}
              onChange={(e) => setSnippet(e.target.value)}
              onPaste={(e) => {
                // Applied from the clipboard rather than from state: the paste
                // event fires before React has the new value.
                const text = e.clipboardData.getData('text')
                if (!text.trim()) return
                e.preventDefault()
                setSnippet(text)
                applySnippet(text)
              }}
            />
            {snippetError ? (
              <span className="error">{snippetError}</span>
            ) : (
              <span className="fld-hint">
                The block a README gives you — `mcpServers`, `servers`, or the bare body. A `uvx`
                or `docker` invocation fills in the command form instead. <b>Test</b> then runs
                exactly what it filled in, so you can see what the snippet meant before saving it.
              </span>
            )}
          </div>
        )}

        <div className="cred-grid">
          <label className="fld">
            <span className="seclabel">ID</span>
            <input
              className="input mono"
              autoFocus={!editing}
              placeholder="linear"
              value={id}
              disabled={editing}
              onChange={(e) => setId(e.target.value)}
            />
          </label>
          <label className="fld">
            <span className="seclabel">NAME (OPTIONAL)</span>
            <input
              className="input"
              placeholder={id.trim() || 'Linear'}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
        </div>

        {kind === 'http' && (
          <div className="fld">
            <span className="seclabel">ENDPOINT URL</span>
            <input
              className="input mono"
              placeholder="https://mcp.example.com/mcp"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <span className="fld-hint">
              A remote http(s) endpoint the session proxy calls — nothing runs on this machine.
            </span>
          </div>
        )}

        {kind === 'npm' && (
          <div className="cred-grid">
            <label className="fld">
              <span className="seclabel">PACKAGE</span>
              <input
                className="input mono"
                placeholder="kubernetes-mcp-server"
                value={pkg}
                onChange={(e) => setPkg(e.target.value)}
              />
            </label>
            <label className="fld cred-type">
              <span className="seclabel">VERSION</span>
              <input
                className="input mono"
                placeholder="latest"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
              />
            </label>
          </div>
        )}
        {kind === 'npm' && (
          <span className="fld-hint">
            Installed once under ~/.gurt/mcp/{id.trim() || '<id>'} and pinned to what it resolved
            to — a version or dist-tag here, never <span className="mono">name@version</span> in
            the package field.
          </span>
        )}

        {kind === 'command' && (
          <div className="cred-grid">
            <label className="fld">
              <span className="seclabel">COMMAND</span>
              <input
                className="input mono"
                placeholder="uvx"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
              />
            </label>
            <label className="fld cred-type">
              <span className="seclabel">WORKING DIR</span>
              <input
                className="input mono"
                placeholder="(optional)"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
              />
            </label>
          </div>
        )}
        {kind === 'command' && (
          <span className="fld-hint">
            A name is resolved against your PATH when this is saved, so a missing tool is an error
            here rather than an hour later; an absolute path is used as given.
          </span>
        )}

        {isLocal && (
          <div className="fld">
            <span className="seclabel">ARGUMENTS</span>
            <textarea
              className="input mono snippet-input"
              rows={3}
              spellCheck={false}
              placeholder={'--read-only'}
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
            />
            <span className="fld-hint">
              One per line, passed verbatim. A server&apos;s own read-only flag lives here — gurt
              reports the argv, and does not claim to enforce what it means.
            </span>
          </div>
        )}

        {kind === 'http' && (
          <div className="fld">
            <div className="fld-head">
              <span className="seclabel">HEADERS</span>
              <span className="spacer" />
              <button
                className="btn-link"
                onClick={() => setHeaders((prev) => [...prev, { name: '', value: '' }])}
              >
                + header
              </button>
            </div>
            {headers.map((h, i) => rowEditor('header', h, i))}
            <span className="fld-hint">
              A typed value is stored in workspace.json and sent verbatim. A secret is taken from a
              credential (<Icon name="key" size={10} />) — the proxy adds it upstream; it is never
              written here and the container never sees it.
            </span>
          </div>
        )}

        {isLocal && (
          <div className="fld">
            <div className="fld-head">
              <span className="seclabel">ENVIRONMENT</span>
              <span className="spacer" />
              <button
                className="btn-link"
                onClick={() => setEnvRows((prev) => [...prev, { name: '', value: '' }])}
              >
                + variable
              </button>
            </div>
            {envRows.map((row, i) => rowEditor('env', row, i))}
            <span className="fld-hint">
              A typed value is stored in workspace.json and given to the process verbatim. A secret
              is taken from a credential (<Icon name="key" size={10} />) — resolved on this machine
              when the process starts, never written here.
            </span>
          </div>
        )}

        {Object.keys(pending).some((pid) => mcpCredentialIds(entry).includes(pid)) && (
          <div className="fld-hint">
            New credentials are saved to the credential store on Save, not to workspace.json.
          </div>
        )}
        {credError && <div className="error">⚠ {credError}</div>}

        {/* Idle shows nothing: the probe has a button, and a form that
            volunteered a verdict it did not earn would read as one. */}
        {probing ? (
          <div className="mcp-probe">
            <span className="fld-hint">
              {isLocal
                ? 'starting it on this machine — an npm entry installs its package the first time…'
                : 'connecting to the endpoint…'}
            </span>
          </div>
        ) : (
          probed?.key === probeKey && <McpProbeReport result={probed.result} />
        )}
        {note && <div className="fld-hint">{note}</div>}
        {(error || (invalid && filledIn)) && <div className="error">{error || invalid}</div>}
      </div>
      <div className="modal-foot">
        {editing && (
          <button className="btn btn-danger-text" onClick={run(del)}>
            Delete
          </button>
        )}
        {editing && local?.kind === 'npm' && kind === 'npm' && (
          <button
            className="btn btn-text"
            title="forget what is installed, so the next start installs the package again"
            onClick={run(reinstall)}
          >
            Reinstall
          </button>
        )}
        <button
          className="btn btn-text"
          title={
            isLocal
              ? 'start this server on your machine now, do the MCP handshake, list its tools and stop it again'
              : 'do the MCP handshake against this endpoint, with the headers a session would send'
          }
          disabled={probing || !!invalid || !!credError}
          onClick={run(probe)}
        >
          {probing ? 'Testing…' : 'Test'}
        </button>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          disabled={!!invalid || !!credError}
          onClick={run(save)}
        >
          Save
        </button>
      </div>
    </Modal>
  )
}

/** Tool names shown before the list is cut short. A server with a hundred tools
 *  is a real thing; a dialog listing all hundred is not. What is dropped is
 *  counted out loud. */
const PROBE_TOOLS_SHOWN = 24

/**
 * What the probe found (§4.6) — the success and failure halves of the button's
 * four states; idle and in-flight are rendered by the caller.
 *
 * The tool list is here to be *read*. It narrows nothing: `mcpHasModes` still
 * says a registry entry has no read-only mode, because a name does not say
 * whether the tool writes (§3.3).
 */
function McpProbeReport({ result }: { result: McpProbeResult }): JSX.Element {
  // Open when it failed, because that is the question the reader now has;
  // folded when it worked, because then the answer is the line above it.
  const [openLog, setOpenLog] = useState(!result.ok)
  const launchLog = <McpProbeLog result={result} open={openLog} onToggle={() => setOpenLog((o) => !o)} />

  if (!result.ok)
    return (
      <div className="mcp-probe">
        <span className="error">
          {result.error || 'it did not come up, and said nothing about why'}
        </span>
        {launchLog}
      </div>
    )
  const tools = result.tools ?? []
  const shown = tools.slice(0, PROBE_TOOLS_SHOWN)
  return (
    <div className="mcp-probe">
      <span className="mcp-probe-head">
        <Icon name="plug" size={12} />
        {result.kind === 'http'
          ? 'the endpoint answered the MCP handshake'
          : 'it started and answered the MCP handshake'}
        {result.server ? ` · ${result.server}` : ''}
      </span>
      {result.tools &&
        (tools.length ? (
          <span className="mcp-probe-tools">
            {shown.map((t, i) => (
              // Keyed by position: nothing stops a server listing a name twice.
              <span key={`${t.name}:${i}`} className="mono" title={t.summary}>
                {t.name}
              </span>
            ))}
            {tools.length > shown.length && (
              <span className="faint">+{tools.length - shown.length} more</span>
            )}
          </span>
        ) : (
          <span className="fld-hint">it offers no tools</span>
        ))}
      {result.toolsError && (
        <span className="fld-hint">it did not list its tools — {result.toolsError}</span>
      )}
      <span className="fld-hint">
        {result.kind === 'http'
          ? 'Checked from gurt, on this machine. A session reaches this endpoint through its own proxy, from the container — so this says the URL, the headers and the credential are right, not that a session can get there.'
          : 'Started and stopped again just now. The list is what the server offers; gurt does not know which of them write, so it reports them and does not restrict them.'}
      </span>
      {launchLog}
    </div>
  )
}

/**
 * The launch itself, line by line: what was installed, what argv was spawned,
 * what the process printed, which MCP calls were made, how it ended.
 *
 * This is the server's *own* output, shown where the person who started it is
 * standing. gurt keeps no copy of it — closing the dialog is the end of it (see
 * §4.6) — so **copy** is not a convenience here, it is the only way to carry it
 * into an issue.
 */
function McpProbeLog({
  result,
  open,
  onToggle
}: {
  result: McpProbeResult
  open: boolean
  onToggle: () => void
}): JSX.Element | null {
  const lines = result.transcript ?? []
  if (!lines.length) return null
  const text = lines.map((l) => `+${l.at}ms ${l.stream}\t${l.line}`).join('\n')
  return (
    <div className="mcp-probe-log">
      <div className="fld-head">
        <button className="btn-link" onClick={onToggle}>
          {open ? 'hide' : 'show'} launch log ({lines.length} lines)
        </button>
        <span className="spacer" />
        {open && (
          <button className="btn-link" onClick={() => void navigator.clipboard.writeText(text)}>
            copy
          </button>
        )}
      </div>
      {open && (
        <div className="mcp-probe-lines mono">
          {lines.map((l, i) => (
            <div key={i} className={`mcp-probe-row ${l.stream}`}>
              <span className="faint">+{l.at}ms</span>
              <span className="faint">{l.stream}</span>
              <span>{l.line}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ClientsSection() {
  const [agents, setAgents] = useState<AgentsFile | null>(null)
  const [credentials, setCredentials] = useState<CredentialEntry[]>([])
  const [open, setOpen] = useState<string | null>(null)
  /** Draft of the expanded card, editable without touching the saved file. */
  const [draft, setDraft] = useState<AgentInstance | null>(null)
  const [draftEnv, setDraftEnv] = useState('')
  const [draftConfig, setDraftConfig] = useState('')
  const [error, setError] = useState('')

  const load = () => {
    window.gurt.getAgents().then(setAgents).catch((e: unknown) => setError(String(e)))
    window.gurt.getCredentials().then((f) => setCredentials(f.credentials)).catch(() => {})
  }
  useEffect(load, [])

  const tokens = agentCredentials(credentials)
  const entries = Object.entries(agents ?? {})

  const expand = (id: string, inst: AgentInstance) => {
    setOpen(id)
    setDraft({ ...inst })
    setDraftEnv(envToText(inst.env))
    setDraftConfig(inst.config ? JSON.stringify(inst.config, null, 2) : '')
    setError('')
  }

  const collapse = () => {
    setOpen(null)
    setDraft(null)
    setError('')
    // Drop an unsaved new row when its card is dismissed.
    setAgents((prev) => {
      if (!prev) return prev
      const next = { ...prev }
      for (const id of Object.keys(next)) if (isTemp(id)) delete next[id]
      return next
    })
  }

  const add = () => {
    const key = `__new__:${crypto.randomUUID()}`
    const inst: AgentInstance = { kind: 'claude-code', label: '' }
    setAgents((prev) => ({ ...(prev ?? {}), [key]: inst }))
    expand(key, inst)
  }

  const persist = async (next: AgentsFile) => {
    await window.gurt.setAgents(next)
    refreshAgents()
    setAgents(next)
  }

  const save = async () => {
    if (!agents || !open || !draft) return
    if (!draft.label.trim()) {
      setError('label must not be empty')
      return
    }
    const env = textToEnv(draftEnv)
    const inst: AgentInstance = { ...draft, ...(env ? { env } : {}) }
    if (!env) delete inst.env
    try {
      if (clientConfigPath(inst.kind) && (draftConfig.trim() || draft.config !== undefined)) {
        inst.config = parseClientConfig(draftConfig)
      } else {
        delete inst.config
      }
    } catch (e) {
      setError(`Invalid config: ${String(e)}`)
      return
    }
    const out: AgentsFile = {}
    const taken = new Set(Object.keys(agents).filter((id) => !isTemp(id) && id !== open))
    for (const [id, a] of Object.entries(agents)) {
      if (id === open) {
        const finalId = isTemp(id) ? uniqueId(inst.label, inst.kind, taken) : id
        out[finalId] = inst
      } else if (!isTemp(id)) {
        out[id] = a
      }
    }
    try {
      await persist(out)
      setOpen(null)
      setDraft(null)
    } catch (e) {
      setError(String(e))
    }
  }

  const remove = async (id: string, label: string) => {
    if (
      !(await confirmDialog(`Delete client "${label || id}"?`, {
        title: 'Delete client',
        confirmText: 'Delete',
        danger: true
      }))
    )
      return
    if (isTemp(id)) {
      collapse()
      return
    }
    const next = { ...(agents ?? {}) }
    delete next[id]
    try {
      await persist(next)
      if (open === id) collapse()
    } catch (e) {
      setError(String(e))
    }
  }

  const count = entries.filter(([id]) => !isTemp(id)).length

  return (
    <>
      <div className="set-head">
        <div className="set-title-wrap">
          <span className="set-title">Clients</span>
          <span className="set-count mono">{count} configured</span>
        </div>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={add}>
          + New client
        </button>
      </div>
      <div className="set-list">
        {entries.map(([id, cfg]) => {
          const kindLabel = agentDef(cfg.kind)?.label ?? cfg.kind
          if (open !== id)
            return (
              <div key={id} className="set-row clickable" onClick={() => expand(id, cfg)}>
                <span className="set-row-label">{cfg.label || 'unnamed'}</span>
                <AgentTag kind={cfg.kind} name={kindLabel} />
                <span className="spacer" />
                <Icon name="chevron" size={12} className="faint" style={{ transform: 'rotate(-90deg)' }} />
              </div>
            )
          return (
            <div key={id} className="set-card">
              <div className="set-card-head" onClick={collapse}>
                <span className="set-row-label">{draft?.label || cfg.label || 'new client'}</span>
                <AgentTag
                  kind={draft?.kind ?? cfg.kind}
                  name={agentDef(draft?.kind ?? cfg.kind)?.label ?? cfg.kind}
                />
                <span className="spacer" />
                <button
                  className="btn-danger-text sm"
                  onClick={(e) => {
                    e.stopPropagation()
                    void remove(id, cfg.label)
                  }}
                >
                  delete
                </button>
                <Icon name="chevron" size={12} className="faint" />
              </div>
              {draft && (
                <div className="set-card-body">
                  <label className="fld narrow">
                    <span className="seclabel">LABEL</span>
                    <input
                      className="input"
                      autoFocus={isTemp(id)}
                      placeholder="claude · personal"
                      value={draft.label}
                      onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                    />
                  </label>
                  <ProviderCombo
                    value={draft.kind}
                    onPick={(kind) => {
                      if (kind === draft.kind) return
                      const next = { ...draft, kind }
                      delete next.config
                      setDraft(next)
                      setDraftConfig('')
                    }}
                  />
                  <div className="fld narrow">
                    <div className="fld-head">
                      <span className="seclabel">CREDENTIAL</span>
                      <span className="fld-hint">— which secret this client authenticates with</span>
                    </div>
                    <CredentialPick
                      tokens={tokens}
                      value={draft.credentialId}
                      onPick={(credentialId) => setDraft({ ...draft, credentialId })}
                    />
                    {tokens.length === 0 && (
                      <div className="fld-hint">no agent tokens yet — add one in Credentials</div>
                    )}
                  </div>
                  <label className="fld narrow">
                    <span className="seclabel">SECRET ENV VAR</span>
                    <input
                      className="input mono"
                      value={draft.secretEnv ?? agentDef(draft.kind)?.secretEnv ?? ''}
                      placeholder={agentDef(draft.kind)?.secretEnv}
                      onChange={(e) => setDraft({ ...draft, secretEnv: e.target.value })}
                    />
                  </label>
                  <label className="fld narrow">
                    <span className="seclabel">EXTRA ENV</span>
                    <textarea
                      className="input mono"
                      rows={2}
                      placeholder="ANTHROPIC_BASE_URL=http://host.docker.internal:1234"
                      value={draftEnv}
                      onChange={(e) => setDraftEnv(e.target.value)}
                    />
                  </label>
                  {clientConfigPath(draft.kind) && (
                    <div className="fld">
                      <label className="seclabel" htmlFor="client-config-json">CONFIG JSON</label>
                      <textarea
                        id="client-config-json"
                        className="input mono"
                        rows={10}
                        spellCheck={false}
                        placeholder="{}"
                        value={draftConfig}
                        onChange={(e) => setDraftConfig(e.target.value)}
                      />
                      <div className="fld-hint">
                        Native client settings. Applied on the next session start or restart.
                        Clear to reset. Keep API keys in Credentials.
                        {(draft.kind === 'opencode' || draft.kind === 'pi') && ' For OpenRouter, set Secret env var to OPENROUTER_API_KEY.'}
                      </div>
                      {!draftConfig.trim() && (
                        <button className="btn" type="button" onClick={() => {
                          setDraftConfig(JSON.stringify(clientConfigExample(draft.kind), null, 2))
                          if (draft.kind === 'opencode' || draft.kind === 'pi') setDraft({ ...draft, secretEnv: 'OPENROUTER_API_KEY' })
                        }}>
                          {draft.kind === 'claude-code' ? 'Example: no attribution' : 'Example: OpenRouter'}
                        </button>
                      )}
                    </div>
                  )}
                  {error && <div className="error">{error}</div>}
                  <div className="set-card-foot">
                    <span className="spacer" />
                    <button className="btn" onClick={collapse}>
                      Cancel
                    </button>
                    <button className="btn btn-primary" onClick={run(save)}>
                      Save
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
        {count === 0 && open === null && (
          <div className="tp-dashed">no clients yet — add one and link its token</div>
        )}
      </div>
    </>
  )
}

/** Provider combobox with search (#4c): field row → filterable menu of AGENT_DEFS. */
function ProviderCombo({ value, onPick }: { value: string; onPick: (kind: string) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(open, ref, () => setOpen(false))

  const cur = agentDef(value)
  const q = query.trim().toLowerCase()
  const filtered = AGENT_DEFS.filter(
    (d) =>
      !q ||
      d.label.toLowerCase().includes(q) ||
      (PROVIDER_VENDOR[d.id] ?? '').toLowerCase().includes(q)
  )

  return (
    <div className="fld narrow">
      <span className="seclabel">PROVIDER</span>
      <div className="pick-wrap" ref={ref}>
        <button
          type="button"
          className={`pick-row provider-row ${open ? 'focus' : ''}`}
          onClick={() => {
            setOpen((o) => !o)
            setQuery('')
          }}
        >
          <Icon name={agentIcon(value)} size={13} className="faint" style={{ flex: 'none' }} />
          <span className="pick-value">{cur?.label ?? value}</span>
          <span className="spacer" />
          <Icon name="chevron" size={12} className="faint" style={{ flex: 'none' }} />
        </button>
        {open && (
          <div className="menu pick-menu combo-menu">
            <div className="combo-search">
              <Icon name="search" size={12} className="faint" />
              <input
                autoFocus
                className="cmp-input"
                placeholder="Search providers…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  const first = filtered[0]
                  if (e.key === 'Enter' && first) {
                    onPick(first.id)
                    setOpen(false)
                  }
                }}
              />
            </div>
            {filtered.map((d) => (
              <div
                key={d.id}
                className={`menu-item ${d.id === value ? 'active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  onPick(d.id)
                  setOpen(false)
                }}
              >
                <Icon name={agentIcon(d.id)} size={13} className="faint" />
                <span className={d.id === value ? 'strong' : undefined}>{d.label}</span>
                <span className="menu-meta mono">{PROVIDER_VENDOR[d.id] ?? ''}</span>
              </div>
            ))}
            {filtered.length === 0 && <div className="menu-empty">no matching providers</div>}
          </div>
        )}
      </div>
    </div>
  )
}

/** Agent-token picker for a client's CREDENTIAL field. */
function CredentialPick({
  tokens,
  value,
  onPick
}: {
  tokens: CredentialEntry[]
  value: string | undefined
  onPick: (id: string | undefined) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(open, ref, () => setOpen(false))
  const cur = tokens.find((t) => t.id === value)
  return (
    <div className="pick-wrap" ref={ref}>
      <button type="button" className="pick-row" onClick={() => setOpen((o) => !o)}>
        <span className={`pick-value mono ${cur ? '' : 'faint'}`}>
          {cur ? cur.label : 'none — adapter reports its own auth error'}
        </span>
        {cur && <span className="tag">oauth</span>}
        <span className="spacer" />
        <Icon name="chevron" size={12} className="faint" style={{ flex: 'none' }} />
      </button>
      {open && (
        <div className="menu pick-menu">
          <div
            className="menu-item"
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(undefined)
              setOpen(false)
            }}
          >
            none — adapter reports its own auth error
          </div>
          {tokens.map((t) => (
            <div
              key={t.id}
              className={`menu-item ${t.id === value ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                onPick(t.id)
                setOpen(false)
              }}
            >
              <Icon name="key" size={11} className="faint" />
              {t.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---- Notifications — per-type on/off matrix (§4.4) ----

const NOTIFICATION_COPY: Record<NotificationType, { label: string; hint: string }> = {
  awaiting: { label: 'Awaiting', hint: 'needs your input — a permission request is pending' },
  proposal: { label: 'Proposal', hint: 'changes are ready to review' },
  error: { label: 'Error', hint: 'a session or its container failed' },
  'turn-ended': { label: 'Turn ended', hint: 'turn finished, nothing to review' }
}

const NOTIFICATION_ORDER: NotificationType[] = ['awaiting', 'proposal', 'error', 'turn-ended']

function NotificationsSection() {
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    window.gurt.getNotificationPrefs().then(setPrefs).catch((e: unknown) => setError(String(e)))
  }, [])

  const toggle = async (type: NotificationType, key: 'inApp' | 'external') => {
    if (!prefs) return
    const prior = prefs
    const next: NotificationPrefs = { ...prefs, [type]: { ...prefs[type], [key]: !prefs[type][key] } }
    setPrefs(next)
    setError('')
    try {
      await window.gurt.setNotificationPrefs(next)
    } catch (e) {
      setPrefs(prior)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <>
      <div className="set-head">
        <div className="set-title-wrap">
          <span className="set-title">Notifications</span>
          <span className="set-count mono">applies across every workspace</span>
        </div>
      </div>
      <div className="set-list notif-prefs">
        <div className="notif-prefs-row notif-prefs-head">
          <span className="seclabel">TYPE</span>
          <span className="seclabel">IN-APP</span>
          <span className="seclabel">
            EXTERNAL <span className="fld-hint">— stub — not sent anywhere yet</span>
          </span>
        </div>
        {NOTIFICATION_ORDER.map((type) => {
          const p = prefs?.[type]
          const copy = NOTIFICATION_COPY[type]
          return (
            <div key={type} className="notif-prefs-row">
              <span className="set-row-label">
                {copy.label}
                <div className="fld-hint">{copy.hint}</div>
              </span>
              <button
                className={`chip-btn ${p?.inApp ? 'on' : ''}`}
                disabled={!prefs}
                onClick={run(() => toggle(type, 'inApp'))}
              >
                {p?.inApp ? 'on' : 'off'}
              </button>
              <button
                className={`chip-btn ${p?.external ? 'on' : ''}`}
                disabled={!prefs}
                onClick={run(() => toggle(type, 'external'))}
              >
                {p?.external ? 'on' : 'off'}
              </button>
            </div>
          )
        })}
      </div>
      {error && <div className="error">{error}</div>}
    </>
  )
}

// ---- Masking — the PII/secret layer's global switch (docs/requirements-pii-mask.md §5.1) ----

/** `2026-08-20T…` → `20 Aug 2026`, for the "fetched" line under a source. */
const fetchedLabel = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString()
}

/**
 * Picks the active detector backend, and for the built-in one the pattern
 * source it runs (§4.1: nothing ships in the repo — a source is fetched once,
 * pinned to a commit/tag, and cached). No backend selected *is* "off": nothing
 * is masked anywhere, and the New Session chip stays disabled.
 */
function MaskingSection() {
  const [status, setStatus] = useState<PiiStatus | null>(null)
  const [credentials, setCredentials] = useState<CredentialEntry[]>([])
  /** Source id currently being fetched — the network is only touched here. */
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    window.gurt.getPiiStatus().then(setStatus).catch((e) => setError(String(e)))
    window.gurt.getCredentials().then((f) => setCredentials(f.credentials)).catch(() => {})
  }, [])

  const settings = status?.settings ?? {}
  const detectors = piiCredentials(credentials)

  const save = async (patch: Partial<PiiSettings>) => {
    if (!status) return
    setError('')
    setBusy('save')
    try {
      setStatus(await window.gurt.setPiiSettings({ ...settings, ...patch }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const refresh = async (sourceId: string) => {
    setError('')
    setBusy(sourceId)
    try {
      setStatus(await window.gurt.refreshPiiSource(sourceId))
    } catch (e) {
      setError(`could not fetch patterns: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }

  const pickBackend = (backend: PiiBackendId | undefined) =>
    save({
      backend,
      // Selecting presidio for the first time lands on the mode that needs no
      // external service; the local sidecar comes up on save.
      presidioMode: backend === 'presidio' ? (settings.presidioMode ?? 'local') : settings.presidioMode
    })

  return (
    <>
      <div className="set-head">
        <div className="set-title-wrap">
          <span className="set-title">Masking</span>
          <span className="set-count mono">
            {status ? (status.ready ? 'on' : 'off') : '…'} · every session, every workspace
          </span>
        </div>
      </div>
      <div className="set-list">
        <div className="set-card">
          <div className="set-card-body">
            <div className="fld">
              <span className="seclabel">ENGINE</span>
              <div className="chip-row">
                <button
                  type="button"
                  className={`chip-btn ${settings.backend ? '' : 'on'}`}
                  disabled={!status || !!busy}
                  onClick={run(() => pickBackend(undefined))}
                >
                  off
                </button>
                {PII_BACKENDS.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    className={`chip-btn ${settings.backend === b.id ? 'on' : ''}`}
                    disabled={!status || !!busy}
                    onClick={run(() => pickBackend(b.id))}
                  >
                    {b.label}
                  </button>
                ))}
              </div>
              <div className="hc-note">
                {settings.backend === 'built-in'
                  ? 'Regex rules run inside gurt. Pick the rules below.'
                  : settings.backend === 'presidio'
                    ? 'Microsoft Presidio analyzer: rules plus recognition of names and places.'
                    : 'Nothing is masked.'}
              </div>
            </div>

            {settings.backend === 'built-in' && (
              <div className="fld">
                <span className="seclabel">RULES</span>
                {PII_SOURCES.map((src) => {
                  const cached = status?.sources[src.id]
                  const active = settings.source === src.id
                  const stale = cached && cached.ref !== src.ref
                  return (
                    <div key={src.id} className="mask-src">
                      <div className="mask-src-main">
                        <div className="mask-src-name">
                          {src.label} <span className="tag">{src.license}</span>
                        </div>
                        <div className="fld-hint">{src.description}</div>
                        <div className="fld-hint mono">
                          {cached
                            ? `${cached.patterns} patterns${cached.skipped ? ` · ${cached.skipped} skipped` : ''} · fetched ${fetchedLabel(cached.fetchedAt)}${stale ? ' · update available' : ''}`
                            : 'not fetched yet'}
                        </div>
                      </div>
                      <button
                        type="button"
                        className={`chip-btn ${active ? 'on' : ''}`}
                        disabled={!status || !!busy}
                        onClick={run(() => save({ source: src.id }))}
                      >
                        {active ? 'active' : 'use'}
                      </button>
                      <button
                        type="button"
                        className="chip-btn"
                        disabled={!status || !!busy}
                        onClick={() => void refresh(src.id)}
                        title={`GET ${src.repo} at ${src.ref}`}
                      >
                        {busy === src.id ? 'fetching…' : cached ? 'update' : 'fetch'}
                      </button>
                    </div>
                  )
                })}
              </div>
            )}

            {settings.backend === 'presidio' && (
              <>
                <div className="fld narrow">
                  <span className="seclabel">ANALYZER</span>
                  <div className="chip-row">
                    <button
                      type="button"
                      className={`chip-btn ${settings.presidioMode !== 'remote' ? 'on' : ''}`}
                      disabled={!status || !!busy}
                      onClick={run(() => save({ presidioMode: 'local' }))}
                      title="gurt runs the analyzer image as a local docker sidecar"
                    >
                      run locally
                    </button>
                    <button
                      type="button"
                      className={`chip-btn ${settings.presidioMode === 'remote' ? 'on' : ''}`}
                      disabled={!status || !!busy}
                      onClick={run(() => save({ presidioMode: 'remote' }))}
                      title="an analyzer you already run"
                    >
                      remote
                    </button>
                  </div>
                </div>
                {settings.presidioMode === 'remote' ? (
                  <>
                    <label className="fld narrow">
                      <span className="seclabel">ANALYZER URL</span>
                      <input
                        className="input mono"
                        placeholder="https://presidio.internal:3000"
                        defaultValue={settings.presidioUrl ?? ''}
                        onBlur={(e) => {
                          if (e.target.value.trim() !== (settings.presidioUrl ?? ''))
                            void save({ presidioUrl: e.target.value })
                        }}
                      />
                      <span className="fld-hint">
                        left empty, the linked credential&apos;s own url is used
                      </span>
                    </label>
                    <div className="fld narrow">
                      <div className="fld-head">
                        <span className="seclabel">CREDENTIAL</span>
                        <span className="fld-hint">— api key for that analyzer</span>
                      </div>
                      <CredentialPick
                        tokens={detectors}
                        value={settings.credentialId}
                        onPick={(credentialId) => void save({ credentialId })}
                      />
                      {detectors.length === 0 && (
                        <div className="fld-hint">
                          no pii detector credentials yet — add one in Credentials
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <label className="fld narrow">
                    <span className="seclabel">HOST PORT</span>
                    <input
                      className="input mono"
                      placeholder={String(PII_DEFAULT_PORT)}
                      defaultValue={String(settings.presidioPort ?? PII_DEFAULT_PORT)}
                      onBlur={(e) => {
                        const port = Number(e.target.value)
                        if (Number.isInteger(port) && port > 0 && port !== settings.presidioPort)
                          void save({ presidioPort: port })
                      }}
                    />
                    <span className="fld-hint">
                      the sidecar&apos;s 3000 is published on 127.0.0.1 at this port
                    </span>
                  </label>
                )}
              </>
            )}

            {status && (
              <div className="fld-hint">
                {status.ready
                  ? 'Masking every session: the agent sees [type:N] tokens, your chat shows the real values (eye button in the composer).'
                  : `Masking is off — ${status.reason ?? ''}`}
              </div>
            )}
            {error && <div className="error">{error}</div>}
          </div>
        </div>
      </div>
    </>
  )
}

// ---- Hotkeys — remap the global keyboard shortcuts, tracking conflicts ----

/** Set while a row waits for the user's next keypress instead of a typed
 *  value — Escape cancels, a bare modifier is ignored, anything else becomes
 *  the candidate binding. */
interface Recording {
  id: HotkeyActionId
}

/** A captured binding that already belongs to another action — surfaced
 *  instead of silently overwriting it, since two actions on the same
 *  combination would both fire and there would be no way to tell which one
 *  the keypress meant. */
interface PendingConflict {
  id: HotkeyActionId
  binding: HotkeyBinding
  withIds: HotkeyActionId[]
}

function HotkeysSection() {
  const map = useHotkeys()
  const [recording, setRecording] = useState<Recording | null>(null)
  const [pending, setPending] = useState<PendingConflict | null>(null)
  const [hint, setHint] = useState('')
  const [error, setError] = useState('')

  const save = async (next: HotkeyMap) => {
    setError('')
    try {
      await window.gurt.setHotkeys(next)
      refreshHotkeys()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // Captures the very next keydown while a row is recording — preventDefault
  // and stopPropagation keep it from also reaching App's own hotkey listener
  // (which would otherwise fire whatever the *old* binding for that key does)
  // or landing in some focused text field behind the modal-less settings page.
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.code === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        setRecording(null)
        setHint('')
        return
      }
      if (!isRecordable(e.code)) return // a bare modifier — keep waiting
      const binding = bindingFromEvent(e)
      if (!binding.mod) {
        setHint(`hold ${modKeyLabel()} while pressing a key`)
        return
      }
      const id = recording.id
      const withIds = conflictsFor(id, binding, map)
      setRecording(null)
      setHint('')
      if (withIds.length === 0) {
        void save({ ...map, [id]: binding })
      } else {
        setPending({ id, binding, withIds })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, map])

  const startRecording = (id: HotkeyActionId) => {
    setPending(null)
    setHint('')
    setError('')
    setRecording({ id })
  }

  // The only way to accept a conflicting combination: give the other side
  // back what this action is giving up, so every action stays bound to
  // something and the map never ends up with two actions sharing one
  // combination (§ the invariant `conflictsFor` relies on to only ever find
  // one owner).
  const swap = async () => {
    if (!pending || pending.withIds.length !== 1) return
    const [other] = pending.withIds
    if (!other) return
    const displaced = map[pending.id]
    await save({ ...map, [pending.id]: pending.binding, [other]: displaced })
    setPending(null)
  }

  return (
    <>
      <div className="set-head">
        <div className="set-title-wrap">
          <span className="set-title">Hotkeys</span>
          <span className="set-count mono">applies across every workspace</span>
        </div>
      </div>
      <div className="set-list">
        {HOTKEY_DEFS.map((def) => {
          const binding = map[def.id]
          const isRecording = recording?.id === def.id
          const conflict = pending?.id === def.id ? pending : null
          const isDefault = bindingEquals(binding, HOTKEY_DEFAULTS[def.id])
          return (
            <div key={def.id}>
              <div className="set-row">
                <span className="set-row-label">{def.label}</span>
                <span className="set-row-url">{def.hint}</span>
                {isRecording ? (
                  <span className="kbd hotkey-recording">{hint || 'press a key…'}</span>
                ) : (
                  <span className="kbd">{bindingLabel(binding)}</span>
                )}
                {!isDefault && !isRecording && (
                  <button
                    className="btn-link"
                    title="reset to default"
                    onClick={run(() => save({ ...map, [def.id]: HOTKEY_DEFAULTS[def.id] }))}
                  >
                    reset
                  </button>
                )}
                <button
                  className="btn-link"
                  onClick={() => (isRecording ? setRecording(null) : startRecording(def.id))}
                >
                  {isRecording ? 'cancel' : 'change'}
                </button>
              </div>
              {conflict && (
                <div className="hc-note hc-warn hotkey-conflict">
                  {bindingLabel(conflict.binding)} is already{' '}
                  {conflict.withIds.length === 1 ? 'used by' : 'used by multiple actions:'}{' '}
                  {conflict.withIds
                    .map((id) => HOTKEY_DEFS.find((d) => d.id === id)?.label ?? id)
                    .join(', ')}
                  .
                  {conflict.withIds.length === 1 ? (
                    <>
                      {' '}
                      <button className="btn-link" onClick={run(swap)}>
                        swap
                      </button>
                    </>
                  ) : null}{' '}
                  <button className="btn-link" onClick={() => setPending(null)}>
                    cancel
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      {error && <div className="error">{error}</div>}
    </>
  )
}

// ---- Credentials (#4d) ----

const hostsToText = (hosts: string[]) => hosts.join(', ')
const textToHosts = (text: string) => text.split(',').map((h) => h.trim()).filter(Boolean)

/** Preview of an entry's secret field for the collapsed row. `data.secret` is
 *  already masked server-side (getCredentials() never serves plaintext) — used
 *  as-is. */
function maskedPreview(c: CredentialEntry): string {
  if (c.kind === 'oauth')
    return c.data['account'] ? `signed in as ${c.data['account']}` : 'not signed in'
  if (c.data['secret']) return c.data['secret']
  return c.kind === 'git-host' ? 'ambient host auth' : '—'
}

const KIND_TAG: Record<CredentialKind, string> = {
  'git-token': 'token',
  'git-app': 'app',
  'git-host': 'host',
  'agent-token': 'agent',
  'mcp-token': 'mcp',
  oauth: 'oauth',
  'pii-detector': 'pii'
}

/** Tag for a stored entry, tolerating a kind this build retired (§10.1) — such
 *  an entry still round-trips through credentials.json, so the UI has to be
 *  able to draw it. */
const kindTag = (kind: string): string => KIND_TAG[kind as CredentialKind] ?? kind

function CredentialsSection() {
  const [usage, setUsage] = useState<Record<string, string[] | null>>({})
  const [filter, setFilter] = usePreference<'all' | 'unused' | 'used'>('credentialFilter', 'all', z.enum(['all', 'unused', 'used']))
  const [query, setQuery] = usePreference('credentialSearch', '', z.string())
  const [entries, setEntries] = useState<CredentialEntry[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [draft, setDraft] = useState<CredentialEntry | null>(null)
  const [draftHosts, setDraftHosts] = useState('')
  const [plaintext, setPlaintext] = useState(false)
  const [error, setError] = useState('')
  // A browser sign-in round-trip is pending for the open card (§4 of
  // docs/requirements-oauth-credentials.md). One attempt at most: the button
  // becomes Cancel, and main cancels-and-restarts if asked again anyway.
  const [signingIn, setSigningIn] = useState(false)
  // Entries created this session: their secret must be typed in before the
  // first save. For anything already stored, an empty secret field means
  // "keep the stored one" — so only fresh entries get the required check.
  const freshIds = useRef(new Set<string>())

  useEffect(() => {
    window.gurt
      .getCredentials()
      .then((f) => {
        setEntries(f.credentials)
        setPlaintext(!!f.plaintext)
      })
      .catch((e: unknown) => setError(String(e)))
  }, [])

  useEffect(() => {
    let cancelled = false
    setUsage({})
    void Promise.all((entries ?? []).map(async (entry) => {
      try { return [entry.id, await window.gurt.credentialUsedBy(entry.id)] as const }
      catch { return [entry.id, null] as const }
    })).then((pairs) => { if (!cancelled) setUsage(Object.fromEntries(pairs)) })
    return () => { cancelled = true }
  }, [entries])

  const expand = (c: CredentialEntry) => {
    setOpen(c.id)
    // Secret fields open empty — the served value is only ever a mask, and an
    // empty field on save means "keep what's stored" (main's sentinel
    // resolution). The mask shows up as the input's placeholder instead.
    const data = { ...c.data }
    for (const f of kindDef(c.kind)?.fields ?? []) if (f.secret) data[f.key] = ''
    setDraft({ ...c, data })
    setDraftHosts(hostsToText(c.hosts))
    setError('')
  }

  const collapse = () => {
    // Dismissing the card abandons its pending sign-in: the loopback listener
    // must not outlive the UI that started it.
    if (signingIn && open) void window.gurt.oauthCancel(open)
    setSigningIn(false)
    setOpen(null)
    setDraft(null)
    setError('')
    setEntries((prev) => prev && prev.filter((c) => c.label.trim() || c.id !== open))
  }

  const add = () => {
    const e: CredentialEntry = {
      id: crypto.randomUUID(),
      label: '',
      kind: 'git-token',
      hosts: [],
      data: {}
    }
    freshIds.current.add(e.id)
    setEntries((prev) => [...(prev ?? []), e])
    expand(e)
  }

  const persist = async (out: CredentialEntry[]) => {
    await window.gurt.setCredentials({ credentials: out })
    // Re-read: save-time verification may stamp identity fields.
    const f = await window.gurt.getCredentials()
    setEntries(f.credentials)
    setPlaintext(!!f.plaintext)
  }

  const save = async () => {
    if (!entries || !draft) return
    if (!draft.label.trim()) {
      setError('name must not be empty')
      return
    }
    if (freshIds.current.has(draft.id)) {
      // Hidden fields are the flow-obtained ones (oauth) — there is nothing
      // the user could type, so the required check skips them: saving a
      // not-yet-signed-in entry is legal, it just blocks at resolve time.
      const missing = (kindDef(draft.kind)?.fields ?? []).find(
        (f) => f.secret && !f.hidden && !(draft.data[f.key] ?? '').trim()
      )
      if (missing) {
        setError(`${missing.label} must not be empty`)
        return
      }
    }
    const cleaned: CredentialEntry = {
      ...draft,
      // Non-git kinds never host-match; drop hosts a kind switch may have left behind.
      hosts: isGitKind(draft.kind) ? textToHosts(draftHosts) : []
    }
    const out = entries
      .map((c) => (c.id === draft.id ? cleaned : c))
      .filter((c) => c.label.trim())
    setError('')
    try {
      await persist(out)
      freshIds.current.delete(draft.id)
      setOpen(null)
      setDraft(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * Run the browser sign-in for the open `oauth` draft
   * (docs/requirements-oauth-credentials.md §4). Main owns the whole flow —
   * system browser, loopback listener, code exchange — and persists the token
   * set itself; the renderer only ever sees the refreshed masked view. A
   * successful sign-in *is* the save for a fresh entry, so the label has to be
   * there first. On failure the entry stays as it was and the provider's
   * error shows as a sentence.
   */
  const signIn = async () => {
    if (!draft) return
    if (!draft.label.trim()) {
      setError('name must not be empty')
      return
    }
    if (!(draft.data['providerId'] ?? '').trim()) {
      setError('choose a provider first')
      return
    }
    setError('')
    setSigningIn(true)
    try {
      await window.gurt.oauthSignIn({ ...draft, kind: 'oauth', hosts: [] })
      freshIds.current.delete(draft.id)
      const f = await window.gurt.getCredentials()
      setEntries(f.credentials)
      setPlaintext(!!f.plaintext)
      // Reopen from the stored view, the way expand() does, so the card now
      // shows "signed in as <account>" and Re-authenticate.
      const stored = f.credentials.find((x) => x.id === draft.id)
      if (stored) {
        const data = { ...stored.data }
        for (const fld of kindDef(stored.kind)?.fields ?? []) if (fld.secret) data[fld.key] = ''
        setDraft({ ...stored, data })
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // Cancelled by the user (the Cancel button, or a restart) — not an error.
      if (!message.includes('cancelled')) setError(message)
    } finally {
      setSigningIn(false)
    }
  }

  const remove = async (c: CredentialEntry) => {
    setError('')
    // Block deleting an entry a repo, client or MCP server still links to (§9).
    const used = await window.gurt.credentialUsedBy(c.id).catch(() => [])
    if (used.length) {
      setError(`linked by ${used.join(', ')} — unlink it (repo / client / MCP settings) first`)
      return
    }
    if (
      !(await confirmDialog(`Delete credential "${c.label || 'unnamed'}"?`, {
        title: 'Delete credential',
        confirmText: 'Delete',
        danger: true
      }))
    )
      return
    const out = (entries ?? []).filter((e) => e.id !== c.id && e.label.trim())
    try {
      await persist(out)
      if (open === c.id) {
        setOpen(null)
        setDraft(null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const visible = (entries ?? []).filter((c) => c.id === open || (
    (filter === 'all' || (Array.isArray(usage[c.id]) && (filter === 'unused' ? usage[c.id]!.length === 0 : usage[c.id]!.length > 0))) &&
    [c.label, kindTag(c.kind), ...c.hosts, ...(usage[c.id] ?? [])].join(' ').toLowerCase().includes(query.toLowerCase())
  ))
  const usageMarkers = (id: string) => <span className="cred-usage">
    {usage[id] === undefined ? <span className="faint">Checking usage…</span> : usage[id] === null ? <span className="yellow">Usage unavailable</span> :
      usage[id].length ? usage[id].map((label) => <span key={label} className="tag" title={label}>{label}</span>) : <span className="tag faint">Unused</span>}
  </span>
  const count = (entries ?? []).filter((c) => c.label.trim()).length
  const kindDef = (kind: CredentialKind): CredentialKindDef | undefined =>
    CREDENTIAL_KINDS.find((k) => k.kind === kind)

  return (
    <>
      <div className="set-head">
        <div className="set-title-wrap">
          <span className="set-title">Credentials</span>
          <span className="set-count mono">
            {count} stored · <Icon name="lock" size={10} /> stored locally, plaintext never sent
          </span>
        </div>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={add}>
          + New credential
        </button>
      </div>
      {plaintext && (
        <div className="error">
          secrets are stored unencrypted — no system keystore available
        </div>
      )}
      <div className="set-list">
        <div className="cred-filters">
          <div className="cred-filter-options" role="group" aria-label="Credential usage">
            {(['all', 'unused', 'used'] as const).map((value) => <button key={value} className={`btn btn-xs${filter === value ? ' active' : ''}`} aria-pressed={filter === value} onClick={() => setFilter(value)}>
              {value === 'all' ? 'All' : value === 'unused' ? 'Unused' : 'In use'}
            </button>)}
          </div>
          <input className="input" aria-label="Search credentials" placeholder="Search name, type, host or usage…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {visible.map((c) => {
          if (open !== c.id) {
            if (!c.label.trim()) return null
            return (
              <div key={c.id} className="set-row clickable" onClick={() => expand(c)}>
                <Icon name="key" size={13} className="faint" style={{ flex: 'none' }} />
                <span className="cred-name mono">{c.label}</span>
                <span className="cred-tag">
                  <span className="tag">{kindTag(c.kind)}</span>
                </span>
                {usageMarkers(c.id)}
                <span className="cred-preview mono">{maskedPreview(c)}</span>
                <Icon name="chevron" size={12} className="faint" style={{ transform: 'rotate(-90deg)' }} />
              </div>
            )
          }
          const def = draft ? kindDef(draft.kind) : null
          return (
            <div key={c.id} className="set-card">
              <div className="set-card-head" onClick={collapse}>
                <Icon name="key" size={13} style={{ color: 'var(--yellow)', flex: 'none' }} />
                <span className="cred-name mono">{draft?.label || c.label || 'new credential'}</span>
                <span className="cred-tag">
                  <span className="tag">{kindTag(draft?.kind ?? c.kind)}</span>
                </span>
                {usageMarkers(c.id)}
                <span className="cred-preview mono">{maskedPreview(c)}</span>
                <Icon name="chevron" size={12} className="faint" />
              </div>
              {draft && (
                <div className="set-card-body">
                  <div className="cred-grid">
                    <label className="fld">
                      <span className="seclabel">NAME</span>
                      <input
                        className="input mono"
                        autoFocus={!c.label}
                        placeholder="GITHUB_TOKEN"
                        value={draft.label}
                        onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                      />
                    </label>
                    <div className="fld cred-type">
                      <span className="seclabel">TYPE</span>
                      <KindPick
                        value={draft.kind}
                        onPick={(kind) => setDraft({ ...draft, kind })}
                      />
                    </div>
                  </div>
                  <div className={def ? 'fld-hint' : 'error'}>
                    {def ? (
                      <>
                        {def.hint}
                        {!def.implemented && ' — stored, runtime not wired yet'}
                      </>
                    ) : (
                      `"${draft.kind}" credentials are no longer supported — ssh git access was ` +
                      'removed; anything resolving to this entry is blocked. Switch it to a token ' +
                      'credential above, or delete it.'
                    )}
                  </div>
                  {(def?.fields ?? []).filter((f) => !f.hidden).map((f) => (
                    <label key={f.key} className="fld">
                      <span className="seclabel">{f.label.toUpperCase()}</span>
                      <input
                        className="input mono"
                        type={f.secret ? 'password' : 'text'}
                        placeholder={f.secret ? c.data[f.key] || f.placeholder : f.placeholder}
                        value={draft.data[f.key] ?? ''}
                        onChange={(e) =>
                          setDraft({ ...draft, data: { ...draft.data, [f.key]: e.target.value } })
                        }
                      />
                    </label>
                  ))}
                  {draft.kind === 'oauth' && (
                    <>
                      <div className="fld cred-type">
                        <span className="seclabel">PROVIDER</span>
                        <ProviderPick
                          value={draft.data['providerId'] ?? ''}
                          onPick={(id) =>
                            setDraft({ ...draft, data: { ...draft.data, providerId: id } })
                          }
                        />
                      </div>
                      {/* State is read from the *stored* masked entry `c`, not
                          the draft — expand() blanks the draft's secret fields,
                          which would read as signed out. */}
                      {c.data['refresh'] && !oauthSignedOut(c) && (
                        <div className="fld-hint">
                          signed in as {c.data['account'] || 'an unnamed account'}
                        </div>
                      )}
                      {oauthSignedOut(c) && c.data['account'] && (
                        <div className="error">{signedOutError(c)}</div>
                      )}
                      <div className="set-card-foot" style={{ justifyContent: 'flex-start' }}>
                        {signingIn ? (
                          <>
                            <span className="fld-hint">waiting for the browser sign-in…</span>
                            <button
                              className="btn"
                              onClick={() => void window.gurt.oauthCancel(draft.id)}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button className="btn" onClick={run(signIn)}>
                            {c.data['refresh'] && !oauthSignedOut(c) ? 'Re-authenticate' : 'Sign in'}
                          </button>
                        )}
                      </div>
                    </>
                  )}
                  {draft.kind === 'git-token' && draft.data['gitEmail'] && (
                    <div className="fld-hint">
                      verified identity: {draft.data['gitName']} &lt;{draft.data['gitEmail']}&gt;
                    </div>
                  )}
                  {isGitKind(draft.kind) && (
                    <label className="fld">
                      <span className="seclabel">HOSTS</span>
                      <input
                        className="input mono"
                        placeholder="github.com (comma-separated; empty = link-only)"
                        value={draftHosts}
                        onChange={(e) => setDraftHosts(e.target.value)}
                      />
                    </label>
                  )}
                  {error && <div className="error">{error}</div>}
                  <div className="set-card-foot">
                    <button className="btn-danger-text" onClick={run(() => remove(c))}>
                      Delete
                    </button>
                    <span className="spacer" />
                    <button className="btn" onClick={collapse}>
                      Cancel
                    </button>
                    <button className="btn btn-primary" onClick={run(save)}>
                      Save
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
        {count > 0 && visible.length === 0 && <div className="tp-dashed">No credentials match these filters</div>}
        {count === 0 && open === null && <div className="tp-dashed">no credentials yet</div>}
      </div>
    </>
  )
}

/** Provider picker for an `oauth sign-in` entry — which of main's provider
 *  modules owns it (`data.providerId`). */
function ProviderPick({ value, onPick }: { value: string; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(open, ref, () => setOpen(false))
  const cur = OAUTH_PROVIDER_CHOICES.find((p) => p.id === value)
  return (
    <div className="pick-wrap" ref={ref}>
      <button type="button" className="pick-row" onClick={() => setOpen((o) => !o)}>
        <span className="pick-value">{cur?.label ?? 'choose provider…'}</span>
        <span className="spacer" />
        <Icon name="chevron" size={12} className="faint" style={{ flex: 'none' }} />
      </button>
      {open && (
        <div className="menu pick-menu">
          {OAUTH_PROVIDER_CHOICES.map((p) => (
            <div
              key={p.id}
              className={`menu-item ${p.id === value ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                onPick(p.id)
                setOpen(false)
              }}
            >
              {p.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Credential kind picker for the TYPE column. */
function KindPick({ value, onPick }: { value: CredentialKind; onPick: (k: CredentialKind) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(open, ref, () => setOpen(false))
  const cur = CREDENTIAL_KINDS.find((k) => k.kind === value)
  return (
    <div className="pick-wrap" ref={ref}>
      <button type="button" className="pick-row" onClick={() => setOpen((o) => !o)}>
        <span className="pick-value">{cur?.label ?? value}</span>
        <span className="spacer" />
        <Icon name="chevron" size={12} className="faint" style={{ flex: 'none' }} />
      </button>
      {open && (
        <div className="menu pick-menu">
          {CREDENTIAL_KINDS.map((k) => (
            <div
              key={k.kind}
              className={`menu-item ${k.kind === value ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                onPick(k.kind)
                setOpen(false)
              }}
            >
              {k.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
