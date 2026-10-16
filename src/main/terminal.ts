// Host "open a terminal here" escape hatch, mirroring the VS Code one in
// changes.ts. Linux has no terminal emulator every distro ships, so the
// Linux path tries common ones in turn until one is actually installed.
import { spawn } from 'node:child_process'

interface Candidate {
  cmd: string
  args: string[]
  /** Needed for emulators with no own `--working-directory`-style flag. */
  cwd?: string
}

/** Tries each candidate in turn; resolves on the first that actually spawns,
 *  rejects once all of them fail to launch. */
function spawnFirst(candidates: Candidate[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tryNext = (i: number): void => {
      if (i >= candidates.length) {
        reject(new Error('could not find a terminal emulator to launch'))
        return
      }
      const { cmd, args, cwd } = candidates[i]!
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true, ...(cwd ? { cwd } : {}) })
      child.on('error', () => tryNext(i + 1))
      child.on('spawn', () => {
        child.unref()
        resolve()
      })
    }
    tryNext(0)
  })
}

/** Open the platform's terminal app in `dir`, in its own window. */
export function openInTerminal(dir: string): Promise<void> {
  if (process.platform === 'darwin') return spawnFirst([{ cmd: 'open', args: ['-a', 'Terminal', dir] }])
  if (process.platform === 'win32')
    return spawnFirst([
      { cmd: 'wt.exe', args: ['-d', dir] },
      { cmd: 'cmd.exe', args: ['/c', 'start', 'cmd.exe', '/K', `cd /d "${dir}"`] }
    ])
  return spawnFirst([
    { cmd: 'gnome-terminal', args: [`--working-directory=${dir}`] },
    { cmd: 'konsole', args: ['--workdir', dir] },
    { cmd: 'xfce4-terminal', args: [`--working-directory=${dir}`] },
    { cmd: 'x-terminal-emulator', args: [], cwd: dir },
    { cmd: 'xterm', args: [], cwd: dir }
  ])
}
