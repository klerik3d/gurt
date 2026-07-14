import { useCallback, useEffect, useRef, useState } from 'react'
import type { EnvRef, SessionSnapshot, Tree } from '../../shared/types'
import { Sidebar } from './components/Sidebar'
import { Chat } from './components/Chat'
import { EnvPane } from './components/EnvPane'
import { AgentsModal } from './components/AgentsModal'

export type Selection = { type: 'session'; id: string } | { type: 'env'; ref: EnvRef } | null

export const envKey = (ref: EnvRef) => `${ref.workspace}/${ref.task}/${ref.repo}`

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

  return (
    <div className="app">
      <Sidebar
        tree={tree}
        selection={selection}
        onSelectEnv={(ref) => setSelection({ type: 'env', ref })}
        onSelectSession={selectSession}
        onOpenAgents={() => setAgentsOpen(true)}
      />
      <main className="main">
        {selection?.type === 'session' && (
          <Chat snapshot={snapshots[selection.id]} sessionId={selection.id} />
        )}
        {selection?.type === 'env' && (
          <EnvPane
            tree={tree}
            envRef={selection.ref}
            log={logs[envKey(selection.ref)] ?? []}
            onSelectSession={selectSession}
            onDeleted={() => setSelection(null)}
          />
        )}
        {!selection && (
          <div className="placeholder">
            select a session on the left, or create a workspace to get started
          </div>
        )}
      </main>
      {agentsOpen && <AgentsModal onClose={() => setAgentsOpen(false)} />}
    </div>
  )
}
