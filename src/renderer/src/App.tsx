import { useCallback, useEffect, useRef, useState } from 'react'
import type { EnvRef, SessionInfo, SessionSnapshot, Tree } from '../../shared/types'
import { Sidebar } from './components/Sidebar'
import { SessionPane } from './components/SessionPane'
import { TaskPane } from './components/TaskPane'
import { AgentsModal } from './components/AgentsModal'

export type Selection =
  | { type: 'session'; id: string }
  | { type: 'task'; ws: string; task: string }
  | null

export const envKey = (ref: EnvRef) => `${ref.workspace}/${ref.task}/${ref.repo}`

/** Global FIFO positions (1-based) of every queued session, keyed by id. */
export function queuePositions(tree: Tree | null): Record<string, number> {
  const queued: SessionInfo[] = []
  for (const ws of tree?.workspaces ?? [])
    for (const task of ws.tasks)
      for (const s of task.sessions) if (s.state === 'queued') queued.push(s)
  queued.sort((a, b) => (a.queuedAt ?? '').localeCompare(b.queuedAt ?? ''))
  const map: Record<string, number> = {}
  queued.forEach((s, i) => (map[s.id] = i + 1))
  return map
}

export default function App() {
  const [tree, setTree] = useState<Tree | null>(null)
  const [selection, setSelection] = useState<Selection>(null)
  const [snapshots, setSnapshots] = useState<Record<string, SessionSnapshot>>({})
  const [logs, setLogs] = useState<Record<string, string[]>>({})
  const [agentsOpen, setAgentsOpen] = useState(false)
  const selectionRef = useRef(selection)
  selectionRef.current = selection

  const refreshTree = useCallback(() => {
    window.gurt.getTree().then(setTree).catch(console.error)
  }, [])

  useEffect(() => {
    refreshTree()
    const offTree = window.gurt.onTreeChanged(refreshTree)
    const offSession = window.gurt.onSessionChanged((snap) => {
      setSnapshots((prev) => ({ ...prev, [snap.info.id]: snap }))
    })
    const offLog = window.gurt.onProvisionLog(({ key, line }) => {
      setLogs((prev) => ({ ...prev, [key]: [...(prev[key] ?? []).slice(-500), line] }))
    })
    return () => {
      offTree()
      offSession()
      offLog()
    }
  }, [refreshTree])

  const selectSession = useCallback((id: string) => {
    setSelection({ type: 'session', id })
    window.gurt
      .sessionSnapshot(id)
      .then((snap) => {
        if (snap) setSnapshots((prev) => ({ ...prev, [id]: snap }))
      })
      .catch(console.error)
  }, [])

  const positions = queuePositions(tree)

  const activeSnap = selection?.type === 'session' ? snapshots[selection.id] : undefined
  const activeInfo = activeSnap?.info
  const activeEnv =
    activeInfo &&
    tree?.workspaces
      .find((w) => w.name === activeInfo.workspace)
      ?.tasks.find((t) => t.name === activeInfo.task)
      ?.envs.find((e) => e.repo === activeInfo.envRepo)

  const titleText = activeInfo
    ? `gurt — ${activeInfo.envRepo} · ${activeInfo.title}`
    : selection?.type === 'task'
      ? `gurt — ${selection.ws} / ${selection.task}`
      : 'gurt'

  return (
    <div className="app">
      <div className="titlebar">
        <div className="titlebar-pill">
          <span style={{ opacity: 0.8 }}>⌕</span>
          {titleText}
        </div>
        <div className="titlebar-icons">▤ ▦ ⬓</div>
      </div>
      <div className="workbench">
        <Sidebar
          tree={tree}
          selection={selection}
          onSelectTask={(ws, task) => setSelection({ type: 'task', ws, task })}
          onSelectSession={selectSession}
          onOpenAgents={() => setAgentsOpen(true)}
        />
        <main className="main">
        {selection?.type === 'session' && (
          <SessionPane
            snapshot={snapshots[selection.id]}
            sessionId={selection.id}
            queuePosition={positions[selection.id]}
            log={
              snapshots[selection.id]
                ? logs[
                    envKey({
                      workspace: snapshots[selection.id].info.workspace,
                      task: snapshots[selection.id].info.task,
                      repo: snapshots[selection.id].info.envRepo
                    })
                  ] ?? []
                : []
            }
            onDeleted={() => setSelection(null)}
          />
        )}
        {selection?.type === 'task' && (
          <TaskPane
            tree={tree}
            ws={selection.ws}
            task={selection.task}
            logs={logs}
            positions={positions}
            onSelectSession={selectSession}
          />
        )}
        {!selection && (
          <div className="placeholder">
            select a session on the left, or create a workspace to get started
          </div>
        )}
        </main>
      </div>
      <div className="statusbar">
        {activeEnv ? (
          <>
            <span className={activeEnv.status === 'running' ? 'ok' : ''}>
              {activeEnv.status === 'running' ? '● ' : '○ '}
              {activeInfo!.envRepo} {activeEnv.status}
            </span>
            <span>gurt/{activeInfo!.task}</span>
          </>
        ) : (
          <span>gurt</span>
        )}
      </div>
      {agentsOpen && <AgentsModal onClose={() => setAgentsOpen(false)} />}
    </div>
  )
}
