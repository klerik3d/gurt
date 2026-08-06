import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionStatus, Tree } from '../../../shared/types'
import { sessionStatus } from '../../../shared/types'
import { agentKind, agentName, useAgents } from '../useAgents'
import { logErr } from '../log'
import type { Tone } from '../status'
import { SESSION_DOT } from '../status'
import { Icon, Dot } from './icons'
import { AgentMark } from './tags'

interface SessionItem {
  kind: 'session'
  id: string
  title: string
  client: string
  clientKind?: string
  status: SessionStatus
}

interface TaskItem {
  kind: 'task'
  ws: string
  task: string
  sessions: number
}

interface ActionItem {
  kind: 'action'
  id: 'new-session' | 'new-task' | 'open-logs'
  title: string
  keys: string
}

/** Icon per action row. */
const ACTION_ICON: Record<ActionItem['id'], 'plus' | 'branch' | 'folder'> = {
  'new-session': 'plus',
  'new-task': 'branch',
  'open-logs': 'folder'
}

type Item = ActionItem | SessionItem | TaskItem

/** Short wording for the result row; its colour comes from the shared mark. */
const STATUS_WORD: Record<SessionStatus, string> = {
  draft: 'draft',
  queued: 'queued',
  starting: 'starting',
  running: 'working',
  waiting: 'waits',
  idle: 'idle'
}

const wordClass = (tone: Tone) => (tone === 'outline' ? 'faint' : tone)

export function CommandPalette({
  tree,
  activity,
  onClose,
  onNewSession,
  onNewTask,
  onSelectSession,
  onSelectTask
}: {
  tree: Tree
  activity: Record<string, { busy?: boolean; awaitingInput?: boolean }>
  onClose: () => void
  onNewSession: () => void
  onNewTask: () => void
  onSelectSession: (id: string) => void
  onSelectTask: (ws: string, task: string) => void
}) {
  const [query, setQuery] = useState('')
  const [idx, setIdx] = useState(0)
  const agents = useAgents()
  const listRef = useRef<HTMLDivElement>(null)

  const { items, groups } = useMemo(() => {
    const q = query.trim().toLowerCase()
    const match = (s: string) => !q || s.toLowerCase().includes(q)

    const actions: ActionItem[] = [
      { kind: 'action', id: 'new-session', title: 'New session…', keys: '⌘N' },
      { kind: 'action', id: 'new-task', title: 'New task…', keys: '⌘⇧N' },
      { kind: 'action', id: 'open-logs', title: 'Open logs folder', keys: '' }
    ].filter((a) => match(a.title)) as ActionItem[]

    const sessions: SessionItem[] = []
    const tasks: TaskItem[] = []
    for (const ws of tree.workspaces)
      for (const task of ws.tasks) {
        if (match(task.name)) tasks.push({ kind: 'task', ws: ws.name, task: task.name, sessions: task.sessions.length })
        for (const s of task.sessions)
          if (match(s.title))
            sessions.push({
              kind: 'session',
              id: s.id,
              title: s.title,
              client: agentName(agents, s.agent),
              clientKind: agentKind(agents, s.agent),
              status: sessionStatus({ ...s, ...activity[s.id] })
            })
      }

    const shownSessions = sessions.slice(0, 6)
    const shownTasks = tasks.slice(0, 5)
    const all: Item[] = [...actions, ...shownSessions, ...shownTasks]
    return { items: all, groups: { actions, sessions: shownSessions, tasks: shownTasks } }
  }, [tree, activity, agents, query])

  useEffect(() => {
    if (idx >= items.length) setIdx(0)
  }, [items.length, idx])

  const run = (item: Item) => {
    if (item.kind === 'action') {
      if (item.id === 'new-session') onNewSession()
      else if (item.id === 'new-task') onNewTask()
      else {
        // Reveals ~/.gurt/logs — the log is local, so "open it" is the whole
        // support story (see docs/logging.md).
        window.gurt.openLogsFolder().catch(logErr('openLogsFolder'))
        onClose()
      }
    } else if (item.kind === 'session') onSelectSession(item.id)
    else onSelectTask(item.ws, item.task)
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIdx((i) => Math.min(i + 1, items.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = items[idx]
      if (item) run(item)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  // Keep the active row in view while arrowing through a long list.
  useEffect(() => {
    listRef.current?.querySelector('.pal-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [idx])

  const itemIndex = (item: Item) => items.indexOf(item)

  const row = (item: Item) => {
    const i = itemIndex(item)
    const active = i === idx
    const common = {
      className: `pal-item ${active ? 'active' : ''}`,
      onMouseEnter: () => setIdx(i),
      onMouseDown: (e: React.MouseEvent) => {
        e.preventDefault()
        run(item)
      }
    }
    if (item.kind === 'action')
      return (
        <div key={item.id} {...common}>
          <Icon name={ACTION_ICON[item.id]} size={15} className={active ? '' : 'dim'} />
          <span className={`pal-title ${active ? 'strong' : ''}`}>{item.title}</span>
          <span className="pal-meta mono">{item.keys}</span>
        </div>
      )
    if (item.kind === 'session') {
      const dot = SESSION_DOT[item.status]
      return (
        <div key={item.id} {...common}>
          <Dot tone={dot.tone} pulse={dot.pulse} />
          <span className={`pal-title ${active ? 'strong' : ''}`}>{item.title}</span>
          <span className="pal-meta mono">
            {item.client && (
              <>
                <AgentMark kind={item.clientKind} name={item.client} /> ·{' '}
              </>
            )}
            <span className={wordClass(dot.tone)}>{STATUS_WORD[item.status]}</span>
          </span>
        </div>
      )
    }
    return (
      <div key={`${item.ws}/${item.task}`} {...common}>
        <Icon name="branch" size={15} className="dim" />
        <span className={`pal-title ${active ? 'strong' : ''}`}>{item.task}</span>
        <span className="pal-meta mono">
          task · {item.sessions} session{item.sessions === 1 ? '' : 's'}
        </span>
      </div>
    )
  }

  return (
    <div className="modal-backdrop pal-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="pal-head">
          <Icon name="search" size={15} className="dim" />
          <input
            autoFocus
            className="pal-input"
            placeholder="Jump to a session, task, or run a command…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setIdx(0)
            }}
            onKeyDown={onKey}
          />
          <span className="kbd-tag">esc</span>
        </div>
        <div className="pal-list" ref={listRef}>
          {groups.actions.length > 0 && <div className="seclabel pal-group">ACTIONS</div>}
          {groups.actions.map(row)}
          {groups.sessions.length > 0 && <div className="seclabel pal-group">SESSIONS</div>}
          {groups.sessions.map(row)}
          {groups.tasks.length > 0 && <div className="seclabel pal-group">TASKS</div>}
          {groups.tasks.map(row)}
          {items.length === 0 && <div className="menu-empty">nothing matches “{query}”</div>}
        </div>
        <div className="pal-foot mono">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span className="spacer" />
          <span>⌘K</span>
        </div>
      </div>
    </div>
  )
}
