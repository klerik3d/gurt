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

/** The scope's shared scratch directory: a root of the file view beside the
 *  repositories, and `/workspaces/artifacts` in every session container of the
 *  scope. It is not a repository, so nothing in it is committed or reviewed.
 *  Reports, screenshots, logs and notes that several sessions (and the user)
 *  should see go here instead of into a repo. Its name is reserved for repos. */
export const ARTIFACTS = 'artifacts'
/** Where a session container mounts the scope: `/workspaces/<repo>` per repo
 *  plus {@link ARTIFACTS}. */
export const CONTAINER_ROOT = '/workspaces'

/** The extensions the file view shows as an image instead of text. */
export const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml'
}
export const imageType = (path: string): string | undefined => IMAGE_TYPES[path.split('.').at(-1)?.toLowerCase() ?? '']
export const isMarkdown = (path: string): boolean => /\.(?:md|markdown|mdx)$/i.test(path)
export const isHtml = (path: string): boolean => /\.html?$/i.test(path)
/** How the file view can show a text file besides the editor, if at all. */
export const previewKind = (path: string): 'markdown' | 'html' | null => isMarkdown(path) ? 'markdown' : isHtml(path) ? 'html' : null

/** An image read for display, as a `data:` URL (the CSP allows those). */
export interface FileImage {
  dataUrl: string
  version: string
}

export const fileKey = (file: ScopeFile): string => JSON.stringify([file.ws, file.task, file.path])
