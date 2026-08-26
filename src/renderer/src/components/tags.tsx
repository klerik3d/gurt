// Environment and repository labels. An env is normally named after the repo it
// serves, so the two labels read identically when they sit side by side — the
// leading icon is what tells them apart. `box` = env, `branch` = repo, the same
// marks the env/repository pickers use in the new-session sidebar.

import { Fragment } from 'react'
import type { JSX } from 'react'
import type { McpSelection, SessionNetwork, SessionRole } from '../../../shared/types'
import type { DomainPolicy } from '../../../shared/proxy'
import { explicitAllows } from '../../../shared/proxy'
import type { McpFailure, ResolvedMcpSelection } from '../../../shared/mcp'
import { Icon, type IconName } from './icons'

/** kind (an `AgentDef.id`) → glyph. Unmatched/custom kinds fall back to a
 *  generic mark rather than breaking — agents.json can outlive this map. */
const AGENT_ICONS: Record<string, IconName> = {
  'claude-code': 'agent-claude',
  codex: 'agent-codex',
  gemini: 'agent-gemini',
  opencode: 'agent-opencode'
}

export const agentIcon = (kind?: string): IconName => (kind && AGENT_ICONS[kind]) || 'agent-generic'

export function EnvTag({ name }: { name: string }): JSX.Element {
  return (
    <span className="tag tag-ico" title={`environment ${name}`}>
      <Icon name="box" size={10} />
      {name}
    </span>
  )
}

export function RepoTag({ name, title }: { name: string; title?: string }): JSX.Element {
  return (
    <span className="tag tag-ico" title={title ?? `repository ${name}`}>
      <Icon name="branch" size={10} />
      {name}
    </span>
  )
}

/**
 * What each session role means, in the UI's own words — the new-session picker,
 * the draft settings row and the chat header all read from here, so the wording
 * stays one thing. Glyphs follow the trade-off, not the name: `play` = it does
 * the work, `eye` = it only looks, `lock` = it only looks but nobody else may
 * touch the tree while it does. See docs/requirements-session-roles.md.
 */
export const ROLE_INFO: Record<SessionRole, { label: string; hint: string; icon: IconName }> = {
  executor: {
    label: 'executor',
    hint: 'writes code: read-write clone, locked while it runs, proposes a commit when done',
    icon: 'play'
  },
  researcher: {
    label: 'researcher',
    hint: 'reads only: any number of repos, locks nothing, answers in chat, can draft other sessions',
    icon: 'eye'
  },
  reviewer: {
    label: 'reviewer',
    hint: "judges one clone's uncommitted changes: writable, so it can install deps and run tests, but holds the lock so nothing moves under it",
    icon: 'lock'
  }
}

/** Session-role tag — same pill as `EnvTag`/`RepoTag`. */
export function RoleTag({ role }: { role: SessionRole }): JSX.Element {
  const info = ROLE_INFO[role]
  return (
    <span className="tag tag-ico" title={`${role} session — ${info.hint}`}>
      <Icon name={info.icon} size={10} />
      {info.label}
    </span>
  )
}

/** Unpilled role mark for the header pills, next to the env/repo marks. */
export function RoleMark({ role }: { role: SessionRole }): JSX.Element {
  const info = ROLE_INFO[role]
  return (
    <span className="agent-mark" title={`${role} session — ${info.hint}`}>
      <Icon name={info.icon} size={11} className="faint" />
      {info.label}
    </span>
  )
}

/** Agent-kind tag — same pill as `EnvTag`/`RepoTag`, marked with the kind's glyph. */
export function AgentTag({
  kind,
  name,
  title
}: {
  kind?: string | undefined
  name: string
  title?: string | undefined
}): JSX.Element {
  return (
    <span className="tag tag-ico" title={title ?? name}>
      <Icon name={agentIcon(kind)} size={10} />
      {name}
    </span>
  )
}

/** What one selected server is, in the words the pill and the mark share:
 *  built-ins say what the agent may do with them, a registry entry says where
 *  it points, and an id the workspace no longer offers says so (§3.3). */
function mcpTitle({ selection, entry }: ResolvedMcpSelection<McpSelection>): string {
  if (!entry)
    return `MCP "${selection.id}" — selected, but this workspace no longer offers it (removed from the registry?)`
  if (entry.source === 'builtin') return `MCP ${entry.label} — built-in · ${selection.mode}`
  return `MCP ${entry.label} — ${entry.description}`
}

/** Name to show for one selection: the entry's label, or the bare id when the
 *  id is all that is left of it. */
const mcpName = ({ selection, entry }: ResolvedMcpSelection<McpSelection>): string =>
  entry?.label ?? selection.id

/**
 * One MCP server a session carries — same pill as `EnvTag`/`RepoTag`.
 *
 * `read-only` is marked (built-ins only, where it means something); a registry
 * entry is off or on, so an attached one carries no mode mark. An unresolvable
 * id goes red rather than vanishing: the session still names it, and hiding it
 * would make the scope the agent gets look like the scope the user chose.
 */
export function McpTag(resolved: ResolvedMcpSelection<McpSelection>): JSX.Element {
  const { selection, entry } = resolved
  const readOnly = entry?.source === 'builtin' && selection.mode === 'read-only'
  return (
    <span className={`tag tag-ico ${entry ? 'tag-accent' : 'tag-red'}`} title={mcpTitle(resolved)}>
      <Icon name="plug" size={10} />
      {mcpName(resolved)}
      {readOnly ? ' ᴿᴼ' : ''}
      {entry ? '' : ' ?'}
    </span>
  )
}

/** The session's whole MCP scope as one header mark — names inline, the rest in
 *  the tooltip. Nothing at all when the session carries no servers. */
export function McpMarks({
  resolved
}: {
  resolved: ResolvedMcpSelection<McpSelection>[]
}): JSX.Element | null {
  if (!resolved.length) return null
  const missing = resolved.some((r) => !r.entry)
  return (
    <span
      className={`agent-mark${missing ? ' tag-red' : ''}`}
      title={`MCP servers\n${resolved.map((r) => mcpTitle(r)).join('\n')}`}
    >
      <Icon name="plug" size={11} className={missing ? undefined : 'faint'} />
      {resolved.map(mcpName).join(', ')}
    </span>
  )
}

/**
 * The local MCP servers this session selected and did not get, with the reason
 * each one gave (docs/requirements-mcp-stdio.md §8.2).
 *
 * A remote entry that cannot be reached fails per request, inside the agent's
 * own tool call; a local one is a process that never came up, and until this
 * banner the only trace of *why* was a line in `~/.gurt/logs`. The session still
 * runs — a server that will not start does not fail a start (§6) — so nothing
 * else on this pane would say it.
 *
 * The reason and nothing else: a local server's environment is where its
 * credential lands, and it is never carried this far (§7).
 */
export function McpFailBanner({ failures }: { failures: McpFailure[] }): JSX.Element | null {
  if (!failures.length) return null
  return (
    <div className="mcp-fail">
      {failures.map((f) => (
        <div key={f.id} className="mcp-fail-row">
          <Icon name="plug" size={11} />
          <span className="mono">{f.id}</span>
          <span className="mcp-fail-why">
            did not start ({f.kind}) — {f.err}
          </span>
        </div>
      ))}
    </div>
  )
}

/** Unpilled agent mark for inline mentions (chat header, session list, palette). */
export function AgentMark({
  kind,
  name
}: {
  kind?: string | undefined
  name: string
}): JSX.Element {
  return (
    <span className="agent-mark">
      <Icon name={agentIcon(kind)} size={11} className="faint" />
      {name}
    </span>
  )
}

/** The same pair unpilled, for the header pills and the footer — the chip around
 *  them already carries the frame, and both lay their children out with a gap.
 *  `task`, when given alongside `repos`, appends the task's branch name — every
 *  clone's task branch is named `<task>` (see `branchFor` in changes.ts).
 *  More than one repo (a discovery session) shows one branch mark per repo. */
export function EnvRepoMarks({
  env,
  repos,
  task
}: {
  env: string
  repos?: string[]
  task?: string
}): JSX.Element {
  const list = repos ?? []
  return (
    <>
      <Icon name="box" size={11} className="faint" />
      {env || 'no env'}
      {list.map((r) => (
        <Fragment key={r}>
          <Icon name="branch" size={11} className="faint" />
          {r}
        </Fragment>
      ))}
      {list.length > 0 && task && <span className="dim">{task}</span>}
    </>
  )
}

// --- network ---------------------------------------------------------------

/**
 * The two egress modes in the UI's own words (docs/requirements-mcp-proxy.md
 * §6.2), read by the composer's picker, the draft settings row and the chat
 * header — so the promise each mode makes is phrased once.
 *
 * The wording is deliberate on the default: it *logs*, it does not *enforce*.
 * A process that ignores `HTTP_PROXY` goes straight out, and a UI that implied
 * otherwise would be selling a guarantee that is not there.
 */
export const NET_INFO: Record<'open' | 'internal', { label: string; hint: string; icon: IconName }> = {
  open: {
    label: 'open network',
    hint: 'normal network: the container keeps its own route out. MCP goes through the session proxy, and so does anything that honours HTTP_PROXY — which makes this visibility, not enforcement: a process that ignores those variables is not stopped, only unlogged.',
    icon: 'globe'
  },
  internal: {
    label: 'internal',
    hint: "isolated: the session network is created with no route out, so the proxy is the session's only egress and the allow list is enforced on every host it asks for. Two caveats: setup (image build, devcontainer features, postCreate, the agent install) runs before the switch, with unrestricted network; and SSH git is unsupported — git over the proxy is HTTPS, via the github MCP.",
    icon: 'lock'
  }
}

export const networkMode = (network?: SessionNetwork): 'open' | 'internal' =>
  network?.internal ? 'internal' : 'open'

/** The policy in three words — the allow list is the whole of it, and whether
 *  it is empty is the whole of what it means. */
export const policySummary = (policy?: DomainPolicy): string => {
  const n = explicitAllows(policy).length
  return n ? `allow list (${n} ${n === 1 ? 'entry' : 'entries'})` : 'all domains allowed, all logged'
}

const netTitle = (network?: SessionNetwork): string => {
  const info = NET_INFO[networkMode(network)]
  return `${info.label} — ${info.hint}\npolicy: ${policySummary(network?.policy)}`
}

/** The session's egress mode as a pill — same shape as `EnvTag`/`RoleTag`.
 *  Internal is marked (it is the restriction); open is plain. */
export function NetTag({ network }: { network?: SessionNetwork | undefined }): JSX.Element {
  const mode = networkMode(network)
  return (
    <span className={`tag tag-ico ${mode === 'internal' ? 'tag-accent' : ''}`} title={netTitle(network)}>
      <Icon name={NET_INFO[mode].icon} size={10} />
      {NET_INFO[mode].label}
    </span>
  )
}

/** Unpilled network mark for the header pills. Nothing at all in the default
 *  mode: every session is on an open network unless it says otherwise, and a
 *  mark that is always there marks nothing. */
export function NetMark({ network }: { network?: SessionNetwork | undefined }): JSX.Element | null {
  if (!network?.internal) return null
  return (
    <span className="agent-mark" title={netTitle(network)}>
      <Icon name={NET_INFO.internal.icon} size={11} className="faint" />
      {NET_INFO.internal.label}
    </span>
  )
}
