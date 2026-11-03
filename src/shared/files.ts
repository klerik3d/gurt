/** Paths are relative to a scope, including its repository directory. */
export interface ScopeFile {
  ws: string
  task: string
  path: string
}

export interface FileEntry {
  name: string
  path: string
  kind: 'directory' | 'file' | 'symlink'
}

export interface FileDocument {
  content: string
  version: string
}

export interface FileLocation {
  path: string
  from: number
  to: number
  line: number
  column: number
  preview: string
}

export interface FileNavigation {
  kind: 'definition' | 'references'
  position: number
  /** Unsaved editor buffers in this repository participate in navigation. */
  documents: { path: string; content: string }[]
}

export interface FileNavigationResult {
  locations: FileLocation[]
  semantic: boolean
  limited: boolean
}

export const fileKey = (file: ScopeFile): string => JSON.stringify([file.ws, file.task, file.path])
