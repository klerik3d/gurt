import { useEffect, useMemo, useState } from 'react'
import type { ComponentPropsWithoutRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { FilesController, FileTab } from '../useFiles'
import { scopeCandidates } from '../../../shared/fileLinks'
import { imageType } from '../../../shared/files'
import { linkToFile, type FileLinkScope } from '../fileLinks'
import { logErr } from '../log'

/** An image file: fitted to the pane, or at its own size (click to switch),
 *  over a checkerboard so transparency reads as such. */
export function ImageView({ tab }: { tab: FileTab }) {
  const [actual, setActual] = useState(false)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  return <>
    <div className={`file-image${actual ? ' actual' : ''}`}>
      <img src={tab.image} alt={tab.file.path} title={actual ? 'Click to fit the pane' : 'Click for the actual size'}
        onClick={() => setActual((a) => !a)}
        onLoad={(event) => setSize({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight })} />
    </div>
    <div className="file-statusbar">
      {size && <span>{size.w} × {size.h}</span>}
      <span>{actual ? '100%' : 'Fit'}</span>
      <span>{imageType(tab.file.path)}</span>
    </div>
  </>
}

/** The scope directory a scope path sits in (`repo/docs/a.md` → `repo/docs`). */
const dirOf = (path: string) => path.split('/').slice(0, -1).join('/')

/** An image a Markdown file references, read from the scope like any other —
 *  the CSP admits only `data:` images, so a relative `src` cannot load as is. */
function ScopeImage({ scope, base, src, alt, ...rest }: ComponentPropsWithoutRef<'img'> & { scope: FileLinkScope; base: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const candidates = useMemo(() => src && !/^[a-z][a-z0-9+.-]*:/i.test(src) ? scopeCandidates(src, scope.repos, base) : [], [src, scope.repos, base])
  const [path] = candidates
  const loadable = !!path && !!imageType(path)
  useEffect(() => {
    setUrl(null)
    setFailed(false)
    if (!path || !imageType(path)) return
    let live = true
    window.gurt.readTaskImage(scope.ws, scope.task, path)
      .then((img) => { if (live) setUrl(img.dataUrl) })
      .catch((e: unknown) => { if (live) setFailed(true); logErr('markdown-image')(e) })
    return () => { live = false }
  }, [path, scope.ws, scope.task])
  if (src?.startsWith('data:image/')) return <img src={src} alt={alt} {...rest} />
  if (url) return <img src={url} alt={alt} {...rest} />
  // Remote images are blocked by the CSP: say so instead of a broken icon.
  return <span className="md-image-missing" title={src}>{failed || !loadable ? `🖼 ${alt || src}` : '…'}</span>
}

/** A Markdown file rendered — the live buffer, so unsaved edits show. Links to
 *  files of the scope open in the file view; images load from the scope. */
export function MarkdownView({ tab, controller }: { tab: FileTab; controller: FilesController }) {
  const { ws, task, path } = tab.file
  const base = dirOf(path)
  // Relative targets resolve against this file's directory (`base`), so the
  // repo list only matters for absolute `/workspaces/<root>/…` targets — and
  // main checks whatever root a target names.
  const scope = useMemo<FileLinkScope>(() => ({ ws, task, repos: [path.split('/')[0]!] }), [ws, task, path])
  const open = controller.open
  const components = useMemo(() => ({
    a: ({ node: _node, href, children, ...rest }: ComponentPropsWithoutRef<'a'> & { node?: unknown }) => {
      if (href?.startsWith('#')) return <a {...rest} href={href} onClick={(e) => e.preventDefault()}>{children}</a>
      const go = linkToFile(href, scope, (target, jump) => open({ ws, task, path: target }, jump), base)
      if (!go) return <a {...rest} href={href}>{children}</a>
      return <a {...rest} href={href} className="file-link" onClick={(e) => { e.preventDefault(); go() }}>{children}</a>
    },
    img: ({ node: _node, ...rest }: ComponentPropsWithoutRef<'img'> & { node?: unknown }) => <ScopeImage {...rest} scope={scope} base={base} />
  }), [scope, base, open, ws, task])
  return <div className="file-markdown markdown">
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{tab.content}</ReactMarkdown>
  </div>
}
