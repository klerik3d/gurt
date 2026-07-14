import type { EnvRef, Tree } from '../../../shared/types'

export function EnvPane({
  tree,
  envRef,
  log,
  onSelectSession,
  onDeleted
}: {
  tree: Tree | null
  envRef: EnvRef
  log: string[]
  onSelectSession: (id: string) => void
  onDeleted: () => void
}) {
  const env = tree?.workspaces
    .find((w) => w.name === envRef.workspace)
    ?.tasks.find((t) => t.name === envRef.task)
    ?.envs.find((e) => e.repo === envRef.repo)

  if (!env) return <div className="placeholder">environment not found</div>

  return (
    <div className="env-pane">
      <div className="chat-header">
        <span>
          {envRef.workspace} / {envRef.task} / {envRef.repo} — {env.status}
        </span>
        <span className="agent-badge">{env.agent ?? 'claude-code'}</span>
        <span className="spacer" />
        {(env.status === 'stopped' || env.status === 'error') && (
          <>
            <button onClick={() => window.gurt.startEnv(envRef).catch(() => {})}>Start</button>
            <button
              onClick={() => {
                if (window.confirm(`Delete env "${envRef.repo}" with its container, clone and sessions? Uncommitted work will be lost.`))
                  window.gurt.removeEnv(envRef).then(onDeleted).catch((e) => alert(String(e)))
              }}
            >
              Delete
            </button>
          </>
        )}
        {env.status === 'running' && (
          <>
            <button
              onClick={() =>
                window.gurt.createSession(envRef).then((s) => onSelectSession(s.id)).catch((e) => alert(String(e)))
              }
            >
              New session
            </button>
            <button onClick={() => window.gurt.stopEnv(envRef).catch((e) => alert(String(e)))}>
              Stop
            </button>
          </>
        )}
      </div>
      {env.error && <div className="error env-error">{env.error}</div>}
      <pre className="env-log">{log.length ? log.join('\n') : 'no provisioning output yet'}</pre>
    </div>
  )
}
