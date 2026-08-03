import type { EnvRef, EnvState } from '../../../shared/types'
import { alertDialog } from '../dialog'
import { Icon } from './icons'

/** Header button that attaches VS Code to the session's devcontainer — only
 *  usable (and lit up as active) while its container is actually running. */
export function VscodeButton({ envRef, env }: { envRef: EnvRef; env: EnvState | undefined }) {
  const running = env?.status === 'running'
  return (
    <button
      className={`icon-sq${running ? ' active' : ''}`}
      title={running ? 'Open in VS Code (attached to container)' : 'VS Code — environment is not running'}
      disabled={!running}
      onClick={() => window.gurt.envOpenVscode(envRef).catch((e) => alertDialog(String(e)))}
    >
      <Icon name="vscode" size={14} />
    </button>
  )
}
