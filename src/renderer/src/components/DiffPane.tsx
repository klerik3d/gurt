import { useEffect, useState } from 'react'
import type { DiffPair, RepoChanges } from '../../../shared/types'
import type { DiffFileSelection } from './DiffSidebar'
import { Icon } from './icons'
import { ReadOnlyDiff } from './ReviewModal'

export function DiffPane({ file, changes, task }: {
  file: DiffFileSelection | null
  changes: RepoChanges[] | undefined
  task: string | undefined
}) {
  const repo = changes?.find((r) => r.repo === file?.repo)
  const exists = !!repo?.files.some((f) => f.path === file?.path)
  return (
    <div className="diff-pane">
      <div className="chat-head">
        <Icon name="branch" size={15} className="faint" />
        <span className="chat-title">{task ?? 'Diff'}</span>
        <span className="spacer" />
        <span className="diff-scope">Uncommitted changes</span>
      </div>
      {file && exists ? (
        <FileDiff key={`${file.ws}/${file.task}/${file.repo}/${file.path}`} file={file} revision={repo} />
      ) : (
        <div className="diff-placeholder">
          <Icon name="branch" size={36} />
          <span>{file ? 'This file has no uncommitted changes' : 'Select a changed file'}</span>
          <span className="dim">Expand a repository in the sidebar to view its diff.</span>
        </div>
      )}
    </div>
  )
}

function FileDiff({ file, revision }: { file: DiffFileSelection; revision: RepoChanges | undefined }) {
  const [pair, setPair] = useState<DiffPair | null>(null)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'split' | 'unified'>(() =>
    localStorage.getItem('gurt.diff.view') === 'unified' ? 'unified' : 'split'
  )
  const { ws, task, repo, path } = file
  useEffect(() => {
    let live = true
    setPair(null)
    setError('')
    window.gurt.getDiffPair(ws, task, repo, { kind: 'uncommitted' }, path)
      .then((value) => { if (live) setPair(value) })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [ws, task, repo, path, revision])

  return (
    <div className="review-diff">
      <div className="review-diff-head">
        <span className="diff-file-repo">{repo}</span>
        <span className="faint">/</span>
        <span className="mono review-diff-path" title={path}>{path}</span>
        <span className="spacer" />
        <div className="review-view" role="group" aria-label="Diff layout">
          {(['split', 'unified'] as const).map((view) => (
            <button key={view} className={`btn btn-xs${mode === view ? ' active' : ''}`} aria-pressed={mode === view} onClick={() => {
              setMode(view)
              localStorage.setItem('gurt.diff.view', view)
            }}>
              {view === 'split' ? 'Split' : 'Unified'}
            </button>
          ))}
        </div>
      </div>
      {mode === 'split' && <div className="diff-sides mono"><span>HEAD</span><span>Working tree</span></div>}
      {error && <div className="error review-error">{error}</div>}
      {!pair && !error && <div className="tp-empty">loading diff…</div>}
      {pair?.binary && <div className="tp-empty">binary file — no text diff</div>}
      {pair && !pair.binary && <ReadOnlyDiff before={pair.before} after={pair.after} path={path} mode={mode} />}
    </div>
  )
}
