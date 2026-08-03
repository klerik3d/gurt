import type { SessionInfo } from '../../../shared/types'
import { alertDialog } from '../dialog'
import { Icon } from './icons'

/** Header button that attaches VS Code to the session's own container — only
 *  usable (and lit up as active) while that container is actually running. */
export function VscodeButton({ info }: { info: SessionInfo }) {
  const running = info.container?.status === 'running'
  return (
    <button
      className={`icon-sq${running ? ' active' : ''}`}
      title={running ? 'Open in VS Code (attached to container)' : 'VS Code — container is not running'}
      disabled={!running}
      onClick={() => window.gurt.sessionOpenVscode(info.id).catch((e) => alertDialog(String(e)))}
    >
      <Icon name="vscode" size={14} />
    </button>
  )
}
