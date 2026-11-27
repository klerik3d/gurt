// The app's side of rpm/ui (t3v2 §3.3): IPC, the link callbacks and the app
// components the Review tab uses but may not import (the reviewer's client
// picker with the session's own OptionBlock, t2v3 A).
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { RpmHostProvider, type ReviewerFieldsProps, type RpmHost } from '../../../rpm/ui'
import type { AgentsFile, SessionConfigOption, SessionInfo, Tree } from '../../../shared/types'
import { agentDef } from '../../../shared/agents'
import { agentKind, agentName, useAgentConfig, useAgents } from '../useAgents'
import { DiffOpener, FileOpener } from '../fileLinks'
import { confirmDialog } from '../dialog'
import { requestChatJump } from '../chatJump'
import { requestReviewJump } from '../reviewJump'
import { AgentIcon, InfoDot } from './icons'
import { AgentMark } from './tags'
import { OptionBlock, PickRow } from './ConfigTab'

/** A kind can review when its adapter hands gurt's MCP server on — that is
 *  where `submit_review` lives (`AgentManifest.acpMcp`). A kind with no plugin
 *  any more cannot run at all. */
const kindCanReview = (kind: string | undefined): boolean => {
  const def = kind ? agentDef(kind) : undefined
  return !!def && def.acpMcp !== false
}

function reviewerProblem(agents: AgentsFile, denied: readonly string[], agent: string): string | undefined {
  if (!agent) return 'Pick a reviewer client first.'
  // Not loaded yet: say nothing rather than "gone".
  if (!Object.keys(agents).length) return undefined
  if (!agents[agent]) return `The client "${agent}" is no longer configured: pick another one.`
  if (denied.includes(agent)) return `${agentName(agents, agent)} is denied in this workspace: pick another client.`
  if (!kindCanReview(agentKind(agents, agent)))
    return `${agentName(agents, agent)} does not receive gurt's tools, so it cannot submit a review: pick another client.`
  return undefined
}

const deniedIn = (info: SessionInfo, tree: Tree | null): string[] =>
  tree?.workspaces.find((w) => w.name === info.workspace)?.deniedAgents ?? []

function scopeOf(tree: Tree | null, sessionId: string): { ws: string; task: string } | undefined {
  for (const w of tree?.workspaces ?? [])
    for (const t of w.tasks) if (t.sessions.some((s) => s.id === sessionId)) return { ws: w.name, task: t.name }
  return undefined
}

const SessionOf = createContext<{ info: SessionInfo; tree: Tree | null } | null>(null)

/** Provides rpm/ui's host for one session pane. */
export function ReviewHost({
  info,
  tree,
  onSelect,
  children
}: {
  info: SessionInfo
  tree: Tree | null
  /** Select another session (the "reviewer R2" / "executor" links). */
  onSelect: (id: string) => void
  children: ReactNode
}) {
  const openScopeFile = useContext(FileOpener)
  const openScopeDiff = useContext(DiffOpener)
  const agents = useAgents()
  const { workspace: ws, task } = info
  const denied = deniedIn(info, tree)
  const deniedKey = denied.join('\n')
  const host = useMemo<RpmHost>(
    () => ({
      api: window.gurt,
      openFile: (path, line) => openScopeFile?.(ws, task, path, line ? { line } : undefined),
      // The session opens on its Chat tab, scrolled to the entry (Chat's `useChatJump`).
      openChat: (sessionId, entryId) => {
        requestChatJump(sessionId, entryId)
        if (sessionId !== info.id) onSelect(sessionId)
      },
      openChatLine: (sessionId, line) => {
        requestChatJump(sessionId, line)
        if (sessionId !== info.id) onSelect(sessionId)
      },
      // The executor opens on its Review tab, focused (Chat's `useReviewJump`) —
      // unless this pane is one of its reviewers: that pane's Review tab shows
      // the same loop, so the jump lands here and nothing is selected.
      openReview: (executor, focus) => {
        const here = executor === info.id || info.reviewerOf?.executor === executor
        requestReviewJump(here ? info.id : executor, focus)
        if (!here) onSelect(executor)
      },
      openDiff: (dws, dtask, files) => openScopeDiff?.(dws, dtask, files),
      // A reviewer lives in its executor's scope, but look it up.
      scopeOf: (executor) => scopeOf(tree, executor) ?? (executor === info.id ? { ws, task } : undefined),
      confirm: (text, opts) => confirmDialog(text, opts),
      reviewerProblem: (agent) => reviewerProblem(agents, deniedKey ? deniedKey.split('\n') : [], agent),
      agentName: (agent) => agentName(agents, agent),
      InfoDot,
      ReviewerFields
    }),
    [openScopeFile, openScopeDiff, tree, ws, task, onSelect, agents, deniedKey, info.id, info.reviewerOf?.executor]
  )
  const scope = useMemo(() => ({ info, tree }), [info, tree])
  return (
    <SessionOf.Provider value={scope}>
      <RpmHostProvider host={host}>{children}</RpmHostProvider>
    </SessionOf.Provider>
  )
}

/** Reviewer in two steps (t2v3 A): the client, then its options. */
function ReviewerFields({ value, info: text, problem, onChange }: ReviewerFieldsProps) {
  const session = useContext(SessionOf)
  const agents = useAgents()
  const [open, setOpen] = useState(false)
  // Kept current: a session of this client starting (or switching model)
  // changes the options it offers.
  const agentConfig = useAgentConfig(value.agent || undefined)
  const executorAgent = session?.info.agent ?? ''
  const denied = session ? deniedIn(session.info, session.tree) : []
  // Only clients that receive gurt's tools can review (t2v3 A).
  const list = Object.entries(agents)
    .filter(([id, a]) => !denied.includes(id) && kindCanReview(a.kind))
    .map(([id, a]) => ({ id, label: a.label, kind: a.kind }))

  // Not chosen yet: offer a client other than the executor's (t2v3 A).
  const suggested = list.find((a) => a.id !== executorAgent && agentKind(agents, a.id) !== agentKind(agents, executorAgent))
    ?? list.find((a) => a.id !== executorAgent)
    ?? list[0]
  useEffect(() => {
    if (!value.agent && suggested) onChange({ agent: suggested.id, options: {} })
    // Only the first offer matters; onChange is a fresh closure every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.agent, suggested?.id])

  const kind = agentKind(agents, value.agent)
  const same = !!value.agent && kind !== undefined && kind === agentKind(agents, executorAgent)
  const info = same
    ? `${text} This reviewer runs on the same client as the executor: it may go easy on its own kind of output.`
    : text
  const options = (agentConfig?.configOptions ?? []).filter((o) => o.category !== 'mode')
  // Only the option picked: main lays it over the stored ones of the same client
  // (`setConfig`). The whole set as this pane last read it would undo a pick
  // made just before whose refresh has not arrived yet.
  const pick = (opt: SessionConfigOption, v: string | boolean): void =>
    onChange({ agent: value.agent, options: { [opt.id]: v } })

  return (
    <>
      <div className="ns-section">
        <div className="seclabel-row">
          <span className="seclabel">Reviewer</span>
          <InfoDot text={info} />
        </div>
        <PickRow
          open={open}
          onToggle={() => setOpen(!open)}
          onClose={() => setOpen(false)}
          menu={
            list.length ? (
              list.map((a) => (
                <div
                  key={a.id}
                  className={`menu-item ${a.id === value.agent ? 'active' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    // Options belong to a client: a new one starts from its own defaults.
                    if (a.id !== value.agent) onChange({ agent: a.id, options: {} })
                    setOpen(false)
                  }}
                >
                  <AgentIcon kind={a.kind} size={12} className="faint" />
                  {a.label}
                </div>
              ))
            ) : (
              <div className="menu-empty">no client here receives gurt's tools — add one in Settings → Clients</div>
            )
          }
        >
          {value.agent ? (
            <span className="pick-value strong">
              <AgentMark kind={kind} name={agentName(agents, value.agent)} />
            </span>
          ) : (
            <span className="pick-value faint">pick a client</span>
          )}
          <span className="spacer" />
        </PickRow>
        {problem && <div className="error">{problem}</div>}
      </div>
      {options.map((opt) => (
        <div className="ns-section" key={opt.id}>
          <OptionBlock opt={opt} values={value.options} kind={kind} onPick={pick} />
        </div>
      ))}
    </>
  )
}
