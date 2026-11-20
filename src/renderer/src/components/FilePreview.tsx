import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { FilesController, FileTab } from '../useFiles'
import { scopeCandidates } from '../../../shared/fileLinks'
import { imageType } from '../../../shared/files'
import { linkToFile, type FileLinkScope } from '../fileLinks'
import { logErr } from '../log'
import { linkScheme, PREVIEW_SANDBOX, previewDocument, scopeImageSources } from '../htmlPreview'

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

/** At most this many of an HTML file's relative images are read from the scope. */
const MAX_HTML_IMAGES = 200

/** The `a`/`area` an event went through, if any — across the frame's realm, so
 *  not by `instanceof`. */
const anchorOf = (event: Event): Element | undefined => event.composedPath()
  .find((node): node is Element => 'localName' in node && ((node as Element).localName === 'a' || (node as Element).localName === 'area'))

/** An HTML file rendered — the live buffer, made inert (see `htmlPreview.ts`)
 *  in a sandboxed frame: no script, no network. Links to files of the scope
 *  open in the file view, web links in the browser; relative images load from
 *  the scope like a Markdown file's. */
export function HtmlView({ tab, controller }: { tab: FileTab; controller: FilesController }) {
  const { ws, task, path } = tab.file
  const base = dirOf(path)
  const repos = useMemo(() => [path.split('/')[0]!], [path])
  const sources = useMemo(() => scopeImageSources(tab.content), [tab.content])
  const sourcesKey = JSON.stringify(sources)
  const [images, setImages] = useState<ReadonlyMap<string, string>>(new Map())
  // Read once per file view; a source repeated across edits is not re-read.
  const reads = useRef(new Map<string, Promise<string | null>>())
  useEffect(() => {
    const wanted = sources.slice(0, MAX_HTML_IMAGES).flatMap((src) => {
      const [target] = scopeCandidates(src, repos, base)
      return target && imageType(target) ? [[src, target] as const] : []
    })
    if (!wanted.length) { setImages((prev) => prev.size ? new Map() : prev); return }
    let live = true
    void Promise.all(wanted.map(async ([src, target]) => {
      let read = reads.current.get(target)
      if (!read) {
        read = window.gurt.readTaskImage(ws, task, target).then((img) => img.dataUrl, (e: unknown) => { logErr('html-image')(e); return null })
        reads.current.set(target, read)
      }
      return [src, await read] as const
    })).then((pairs) => {
      if (live) setImages(new Map(pairs.filter((pair): pair is readonly [string, string] => pair[1] !== null)))
    })
    return () => { live = false }
    // `sourcesKey` stands for `sources`: a new array of the same images is no change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcesKey, repos, base, ws, task])
  const srcDoc = useMemo(() => previewDocument(tab.content, images), [tab.content, images])

  const frameRef = useRef<HTMLIFrameElement>(null)
  // Kept across reloads of the frame (an edit, an image arriving).
  const scroll = useRef({ x: 0, y: 0 })
  // The handlers outlive the render that attached them (until the next load).
  const links = useRef({ ws, task, repos, base, open: controller.open })
  links.current = { ws, task, repos, base, open: controller.open }
  const onLoad = useCallback(() => {
    const frame = frameRef.current
    const win = frame?.contentWindow
    const doc = frame?.contentDocument
    if (!frame || !win || !doc) return
    win.scrollTo(scroll.current.x, scroll.current.y)
    doc.addEventListener('scroll', () => { scroll.current = { x: win.scrollX, y: win.scrollY } }, { passive: true })
    // Every link click is the app's to handle: the frame itself never navigates.
    doc.addEventListener('click', (event) => {
      const anchor = anchorOf(event)
      if (!anchor) return
      event.preventDefault()
      const href = anchor.getAttribute('href') ?? anchor.getAttribute('xlink:href')
      const kind = href ? linkScheme(href) : null
      if (!href || !kind) return
      if (kind === 'fragment') {
        let id = href.trim().slice(1)
        try { id = decodeURIComponent(id) } catch { /* as written */ }
        if (!id) win.scrollTo(0, 0)
        else (doc.getElementById(id) ?? doc.getElementsByName(id)[0])?.scrollIntoView()
      } else if (kind === 'external') {
        // Main hands any window the renderer opens to the OS browser.
        window.open(href, '_blank', 'noopener')
      } else {
        let target = href.trim().replace(/[?#].*$/, '')
        try { target = decodeURI(target) } catch { /* as written */ }
        const { ws, task, repos, base, open } = links.current
        linkToFile(target, { ws, task, repos }, (file, jump) => open({ ws, task, path: file }, jump), base)?.()
      }
    })
    // Shortcuts pressed inside the frame (save, close, the app's hotkeys)
    // would stop at its document: hand them to the app's.
    doc.addEventListener('keydown', (event) => {
      if (!event.metaKey && !event.ctrlKey) return
      const { key, code, ctrlKey, metaKey, shiftKey, altKey, repeat } = event
      if (!frame.dispatchEvent(new KeyboardEvent('keydown', { key, code, ctrlKey, metaKey, shiftKey, altKey, repeat, bubbles: true, cancelable: true }))) event.preventDefault()
    })
  }, [])

  return <iframe ref={frameRef} className="file-html" title={path} sandbox={PREVIEW_SANDBOX} srcDoc={srcDoc} onLoad={onLoad} />
}
