import { usePreference, z } from '../persisted'
import type { JSX } from 'react'
import type { Tree } from '../../../shared/types'
import type { IconName } from './icons'
import { Icon } from './icons'
import { MachineSection, DockerCleanupSection } from './settings/MachineSection'
import { EnvironmentsSection } from './settings/EnvironmentsSection'
import { ReposSection } from './settings/ReposSection'
import { ClientsSection } from './settings/ClientsSection'
import { McpServersSection } from './settings/McpServersSection'
import { AgentAccessSection } from './settings/AgentAccessSection'
import { SkillsSection } from './settings/SkillsSection'
import { NotificationsSection } from './settings/NotificationsSection'
import { MaskingSection } from './settings/MaskingSection'
import { HotkeysSection } from './settings/HotkeysSection'
import { CredentialsSection } from './settings/CredentialsSection'
import { ArchiveSection } from './settings/ArchiveSection'

export const SETTINGS_SECTIONS = [
  'environments',
  'repos',
  'clients',
  'agentAccess',
  'mcp',
  'skills',
  'credentials',
  'masking',
  'notifications',
  'hotkeys',
  'machine',
  'docker',
  'archive',
] as const

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

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
  docker: 'trash',
  archive: 'archive'
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
  'archive',
  'notifications',
  'hotkeys'
] as const satisfies readonly SettingsSection[]

const ADVANCED_SECTIONS = ['mcp', 'skills'] as const satisfies readonly SettingsSection[]

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
        {section === 'archive' && <ArchiveSection />}
      </div>
    </div>
  )
}
