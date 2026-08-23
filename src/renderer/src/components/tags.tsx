// Environment and repository labels. An env is normally named after the repo it
// serves, so the two labels read identically when they sit side by side — the
// leading icon is what tells them apart. `box` = env, `branch` = repo, the same
// marks the env/repository pickers use in the new-session sidebar.

import { Fragment } from 'react'
import type { JSX } from 'react'
import type { SessionRole } from '../../../shared/types'
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
    hint: "judges one clone's uncommitted changes: read-only, but holds the lock so nothing moves under it",
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
  kind?: string
  name: string
  title?: string
}): JSX.Element {
  return (
    <span className="tag tag-ico" title={title ?? name}>
      <Icon name={agentIcon(kind)} size={10} />
      {name}
    </span>
  )
}

/** Unpilled agent mark for inline mentions (chat header, session list, palette). */
export function AgentMark({ kind, name }: { kind?: string; name: string }): JSX.Element {
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
      {env}
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
