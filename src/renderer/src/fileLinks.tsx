import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode
} from 'react'
import { parsePathRef, scopeCandidates, type PathRef } from '../../shared/fileLinks'
import type { FileJump } from './useFiles'
import { showToast } from './toast'
import { logErr } from './log'

// Paths in an agent's messages become links into the file view: the session
// says which scope and repos they are relative to (`FileLinkScope`), App says
// how to open one (`FileOpener`). Outside both — an archived session — they
// stay plain text.

export interface FileLinkScope {
  ws: string
  task: string
  repos: readonly string[]
}

/** Opens `path` (scope-relative) in the file view, switching to it. */
export type OpenScopeFile = (ws: string, task: string, path: string, jump?: FileJump) => void

export const FileOpener = createContext<OpenScopeFile | null>(null)

/** Opens a scope's uncommitted changes in the Diff view, switching to it. */
export type OpenScopeDiff = (ws: string, task: string) => void

export const DiffOpener = createContext<OpenScopeDiff | null>(null)
export const FileLinkScopeContext = createContext<FileLinkScope | null>(null)

const jumpOf = (ref: PathRef): FileJump | undefined => ref.line ? { line: ref.line, column: ref.column } : undefined

/** A miss is retried after this long — the agent may write the file next. */
const MISS_TTL_MS = 15_000
const lookups = new Map<string, { at: number; found: Promise<string | null> }>()

/** The existing scope path behind `candidates`, cached per scope: a message
 *  re-renders on every streamed chunk, and the same path recurs across it. */
function lookup(scope: FileLinkScope, candidates: string[]): Promise<string | null> {
  const key = JSON.stringify([scope.ws, scope.task, candidates])
  const hit = lookups.get(key)
  if (hit) return hit.found
  const found = window.gurt.findTaskFile(scope.ws, scope.task, candidates).catch((e: unknown) => {
    logErr('findTaskFile')(e)
    return null
  })
  const entry = { at: Date.now(), found }
  lookups.set(key, entry)
  void found.then((path) => {
    if (path === null) setTimeout(() => { if (lookups.get(key) === entry) lookups.delete(key) }, MISS_TTL_MS)
  })
  if (lookups.size > 2000) lookups.delete(lookups.keys().next().value!)
  return found
}

const activate = (go: () => void) => ({
  onClick: (event: MouseEvent) => {
    event.preventDefault()
    go()
  },
  onKeyDown: (event: KeyboardEvent) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    go()
  }
})

/** Inline code (`` `src/a.ts:12` ``) that names an existing file of the scope
 *  turns into a link once the lookup confirms it; until then, and when it
 *  names nothing, it is ordinary inline code. Fenced blocks stay as they are. */
export function CodeWithFileLink({ node: _node, children, ...rest }: ComponentPropsWithoutRef<'code'> & { node?: unknown }) {
  const scope = useContext(FileLinkScopeContext)
  const open = useContext(FileOpener)
  const text = typeof children === 'string' ? children : Array.isArray(children) && children.every((c) => typeof c === 'string') ? children.join('') : null
  // Inline code never holds a newline; a fenced block's text always ends in one.
  const ref = scope && open && text !== null && !text.includes('\n') ? parsePathRef(text) : null
  const candidates = ref && scope ? scopeCandidates(ref.path, scope.repos) : []
  const candidatesKey = JSON.stringify(candidates)
  const [found, setFound] = useState<string | null>(null)
  useEffect(() => {
    setFound(null)
    if (!scope || !candidates.length) return
    let live = true
    void lookup(scope, candidates).then((path) => { if (live) setFound(path) })
    return () => { live = false }
    // `candidates` is keyed by its JSON, `scope` by its identity fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope?.ws, scope?.task, candidatesKey])
  if (!found || !ref || !scope || !open) return <code {...rest}>{children}</code>
  return (
    <code {...rest} className={`${rest.className ?? ''} file-link`.trim()} role="link" tabIndex={0}
      title={`Open ${found}${ref.line ? `:${ref.line}` : ''} in the file view`}
      {...activate(() => open(scope.ws, scope.task, found, jumpOf(ref)))}>
      {children}
    </code>
  )
}

/** A Markdown link whose target is a file path (`[a.ts](src/a.ts#L3)`) opens
 *  the file view; a URL stays an ordinary link. `base`, when given, is the
 *  scope directory relative targets resolve against (a Markdown file's own). */
export function linkToFile(href: string | undefined, scope: FileLinkScope | null, open: ((path: string, jump?: FileJump) => void) | null, base?: string): (() => void) | null {
  if (!href || !scope || !open || href.startsWith('#')) return null
  const ref = parsePathRef(href)
  if (!ref) return null
  const candidates = scopeCandidates(ref.path, scope.repos, base)
  return () => {
    if (!candidates.length) {
      showToast(`${ref.path} is outside this scope`)
      return
    }
    void lookup(scope, candidates).then((path) => {
      if (path) open(path, jumpOf(ref))
      else showToast(`${ref.path} was not found in this scope`)
    })
  }
}

export function AnchorWithFileLink({ node: _node, href, children, ...rest }: ComponentPropsWithoutRef<'a'> & { node?: unknown }) {
  const scope = useContext(FileLinkScopeContext)
  const open = useContext(FileOpener)
  const go = linkToFile(href, scope, scope && open ? (path, jump) => open(scope.ws, scope.task, path, jump) : null)
  if (!go) return <a href={href} {...rest}>{children}</a>
  return <a href={href} {...rest} className="file-link" title={`Open ${href} in the file view`} {...activate(go)}>{children}</a>
}

/** Provides the scope a session's messages are relative to. */
export function FileLinkScopeProvider({ scope, children }: { scope: FileLinkScope | null; children: ReactNode }) {
  return <FileLinkScopeContext.Provider value={scope}>{children}</FileLinkScopeContext.Provider>
}
