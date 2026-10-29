import type { SessionInfo } from '../../../shared/types'
import { alertDialog } from '../dialog'
import { Icon } from './icons'
import { run } from '../async'

export function ContainerTerminalButton({ info }: { info: SessionInfo }) {
  const running = info.container?.status === 'running'
  return (
    <button
      className={`icon-sq${running ? ' active' : ''}`}
      title={running ? 'Open terminal in container' : 'Terminal — container is not running'}
      aria-label="Open terminal in container"
      disabled={!running}
      onClick={run(() => window.gurt.sessionOpenTerminal(info.id).catch((e: unknown) => alertDialog(String(e))))}
    >
      <Icon name="terminal" size={14} />
    </button>
  )
}
