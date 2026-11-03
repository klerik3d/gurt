import { useEffect, useRef, useState } from 'react'
import type { GitCommitOptions, GitPushOptions } from '../../../shared/api'
import { run } from '../async'
import { Modal } from './Modal'

export const commitInputId = (ws: string, task: string, repo: string): string =>
  `git-commit-${JSON.stringify([ws, task, repo])}`

function PushOptions({ value, onChange, disabled }: {
  value: GitPushOptions
  onChange: (value: GitPushOptions) => void
  disabled: boolean
}) {
  return <fieldset className="git-options" disabled={disabled}>
    <legend>Push options</legend>
    <label title="Update a rewritten branch only if the remote still matches the last fetched version">
      <input type="checkbox" checked={!!value.forceWithLease} onChange={(e) => onChange({ ...value, forceWithLease: e.target.checked })} />
      <span>--force-with-lease</span>
    </label>
    <label title="Push annotated tags reachable from the commits being pushed">
      <input type="checkbox" checked={!!value.followTags} onChange={(e) => onChange({ ...value, followTags: e.target.checked })} />
      <span>--follow-tags</span>
    </label>
    <label title="Skip the pre-push hook">
      <input type="checkbox" checked={!!value.noVerify} onChange={(e) => onChange({ ...value, noVerify: e.target.checked })} />
      <span>--no-verify</span>
    </label>
  </fieldset>
}

/** The selected clone's commit form. Drafts belong to the sidebar so walking to
 * another repository and back preserves the message, including on failed git. */
export function GitCommitPanel({ ws, task, repo, message, onMessage, busy, act }: {
  ws: string
  task: string
  repo: string
  message: string | undefined
  onMessage: (message: string) => void
  busy: boolean
  act: (fn: () => Promise<void>) => Promise<boolean>
}) {
  const [commitOptions, setCommitOptions] = useState<GitCommitOptions>({})
  const [pushOptions, setPushOptions] = useState<GitPushOptions>({})
  const touched = useRef(message !== undefined)
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage
  useEffect(() => {
    let live = true
    window.gurt.latestProposal(ws, task, repo).then((p) => {
      if (!live || touched.current || !p?.commit) return
      onMessageRef.current(p.commit.body ? `${p.commit.subject}\n\n${p.commit.body}` : p.commit.subject)
    }).catch(() => {})
    return () => { live = false }
  }, [ws, task, repo])

  const text = message ?? `gurt: ${task}`
  const commit = async (push: boolean) => {
    if (busy || !text.trim()) return
    await act(async () => {
      await window.gurt.changesCommit(ws, task, repo, text.trim(), commitOptions)
      touched.current = true
      onMessage('')
      // A failed push must not look like a failed commit or invite a second one.
      if (push) {
        try {
          await window.gurt.changesPush(ws, task, repo, pushOptions)
        } catch (e) {
          throw new Error(`Commit created; push failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
        }
      }
    })
  }

  return <section className="git-commit-panel" aria-label={`Commit in ${repo}`} aria-busy={busy}>
    <div className="git-commit-heading"><span className="seclabel">COMMIT</span><span title={`${ws} / ${task} / ${repo}`}>{task} / {repo}</span></div>
    <label className="fld">
      <span className="seclabel">MESSAGE</span>
      <textarea id={commitInputId(ws, task, repo)} className="input commit-message" rows={3}
        placeholder="Commit message" aria-label={`Commit message for ${repo}`} value={text} disabled={busy}
        onChange={(e) => { touched.current = true; onMessage(e.target.value) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void commit(e.shiftKey) }
        }} />
    </label>
    <div className="git-commit-hint">Commits all changed files · Ctrl/⌘+Enter</div>
    <details className="git-parameters">
      <summary>Parameters{commitOptions.signoff || commitOptions.noVerify || pushOptions.forceWithLease || pushOptions.followTags || pushOptions.noVerify ? ' · enabled' : ''}</summary>
      <fieldset className="git-options" disabled={busy}>
        <legend>Commit options</legend>
        <label title="Add a Signed-off-by trailer using your Git identity"><input type="checkbox" checked={!!commitOptions.signoff} onChange={(e) => setCommitOptions({ ...commitOptions, signoff: e.target.checked })} /><span>--signoff</span></label>
        <label title="Skip the pre-commit and commit-msg hooks"><input type="checkbox" checked={!!commitOptions.noVerify} onChange={(e) => setCommitOptions({ ...commitOptions, noVerify: e.target.checked })} /><span>--no-verify</span></label>
      </fieldset>
      <PushOptions value={pushOptions} onChange={setPushOptions} disabled={busy} />
    </details>
    {pushOptions.forceWithLease && <div className="git-commit-hint">Push will use --force-with-lease</div>}
    <div className="git-commit-buttons">
      <button className="btn btn-sm" disabled={busy || !text.trim()} onClick={run(() => commit(false))}>Commit</button>
      <button className="btn btn-sm btn-primary" disabled={busy || !text.trim()} onClick={run(() => commit(true))}>Commit &amp; Push</button>
    </div>
  </section>
}

/** Also available without dirty files: a rebase can require a lease-protected
 * push even when the working tree is already clean. Options reset on close. */
export function GitPushModal({ repo, busy, onClose, onPush }: {
  repo: string
  busy: boolean
  onClose: () => void
  onPush: (options: GitPushOptions) => Promise<boolean>
}) {
  const [options, setOptions] = useState<GitPushOptions>({})
  return <Modal title={`Push ${repo}`} onClose={() => { if (!busy) onClose() }}>
    <div className="modal-body">
      <PushOptions value={options} onChange={setOptions} disabled={busy} />
      {options.forceWithLease && <p className="dim">Rewrites the remote branch only if it still matches your last fetched version.</p>}
    </div>
    <div className="modal-foot">
      <button className="btn" disabled={busy} onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy} onClick={run(async () => { if (await onPush(options)) onClose() })}>{busy ? 'Pushing…' : 'Push'}</button>
    </div>
  </Modal>
}
