/** Terminal sessions are memory-only and belong to a scope, not an agent session. */
export interface TerminalInfo {
  id: string
  workspace: string
  task: string
  title: string
  cols: number
  rows: number
  exitCode: number | null
}

export interface TerminalOutput {
  id: string
  sequence: number
  data: string
}

export interface TerminalSnapshot {
  info: TerminalInfo
  sequence: number
  data: string
}
