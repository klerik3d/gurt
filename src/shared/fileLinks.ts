// Paths written in prose — an agent's message, a Markdown link — mapped onto
// the file view's scope paths (`<repo>/<path>` or `artifacts/<path>`). Pure,
// so the renderer's link handling is testable without a window.
import { ARTIFACTS, CONTAINER_ROOT } from './files'

export interface PathRef {
  path: string
  line?: number
  column?: number
}

/** A scheme (`https:`, `mailto:`, …) — anything that is not a file path. A
 *  Windows drive letter is one letter, so `c:` never counts here. */
const SCHEME = /^[a-z][a-z0-9+.-]+:/i

/** A path as an agent writes one: `src/a.ts`, `./a.ts`, `/workspaces/x/a.ts`,
 *  `a.ts:12`, `a.ts:12:3`, `a.ts#L12`, `a.ts#L12-L20`, `file:///…`. Null for
 *  anything else — a URL, a bare word, a sentence. To count, it needs a
 *  slash or a file extension, so `npm` and `v1` are not paths. */
export function parsePathRef(raw: string): PathRef | null {
  let text = raw.trim()
  if (!text || text.length > 1024 || /\s/.test(text)) return null
  if (/^file:\/\//i.test(text)) {
    try {
      text = decodeURIComponent(new URL(text).pathname)
    } catch {
      return null
    }
  } else if (SCHEME.test(text) && !/^[a-z0-9_.-]+:\d+(?::\d+)?$/i.test(text)) return null
  let line: number | undefined
  let column: number | undefined
  const anchor = /#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i.exec(text)
  if (anchor) {
    line = Number(anchor[1])
    if (anchor[2]) column = Number(anchor[2])
    text = text.slice(0, anchor.index)
  } else {
    const suffix = /:(\d+)(?::(\d+))?$/.exec(text)
    if (suffix) {
      line = Number(suffix[1])
      if (suffix[2]) column = Number(suffix[2])
      text = text.slice(0, suffix.index)
    }
  }
  text = text.replace(/[#?].*$/, '')
  if (!text || text.endsWith('/')) return null
  const name = text.split('/').at(-1) ?? ''
  // An extension holds a letter, so `v1.2` is a version, not a file. A dotted
  // identifier (`fs.readFile`) still passes: the caller checks the file exists.
  if (!text.includes('/') && !/^[^.]+\.[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*$|^\.[A-Za-z0-9_-]+$/.test(name)) return null
  return { path: text, ...(line ? { line } : {}), ...(column ? { column } : {}) }
}

/** `a/./b/../c` → `a/c`; null when it climbs out of its root. */
function normalize(segments: string[]): string | null {
  const out: string[] = []
  for (const part of segments) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!out.length) return null
      out.pop()
    } else out.push(part)
  }
  return out.length ? out.join('/') : null
}

/**
 * The scope paths `path` may mean, most likely first — the main process keeps
 * the first that exists (`findTaskFile`).
 *
 * - `/workspaces/<root>/…` is the container's own layout: exactly that root.
 * - Another absolute path is outside the scope: nothing.
 * - With `base` (the scope directory a Markdown file sits in), a relative
 *   path resolves against it — into any root, `../other-repo/…` included;
 *   main checks the root exists (`findTaskFile`).
 * - Otherwise a relative path is either already rooted at a repo or the
 *   artifacts dir, or relative to a repo's root — the agent's working
 *   directory when it has one repo, the usual way to name a file with several.
 */
export function scopeCandidates(path: string, repos: readonly string[], base?: string): string[] {
  const roots = [...repos, ARTIFACTS]
  if (path.startsWith('/')) {
    const prefix = `${CONTAINER_ROOT}/`
    if (!path.startsWith(prefix)) return []
    const scoped = normalize(path.slice(prefix.length).split('/'))
    return scoped && roots.includes(scoped.split('/')[0]!) ? [scoped] : []
  }
  if (base !== undefined) {
    const scoped = normalize([...base.split('/'), ...path.split('/')])
    return scoped?.includes('/') ? [scoped] : []
  }
  const scoped = normalize(path.split('/'))
  if (!scoped) return []
  const out: string[] = []
  if (roots.includes(scoped.split('/')[0]!) && scoped.includes('/')) out.push(scoped)
  for (const repo of repos) out.push(`${repo}/${scoped}`)
  return [...new Set(out)]
}
