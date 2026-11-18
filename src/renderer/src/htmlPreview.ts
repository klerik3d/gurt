// An HTML file of the scope, previewed. Its content is untrusted — an agent
// wrote it, or a repository brought it — and it is shown inside the app's own
// renderer, which holds the `window.gurt` bridge. So it is made inert in
// layers, any one of which is enough on its own to keep script from running:
//
//   1. this module strips the markup: scripts, frames, plugins, <base>, <meta>
//      (refresh), <link>, event handlers, `javascript:` and remote URLs;
//   2. the document carries its own CSP (`PREVIEW_CSP`): no script, no network
//      — inline styles and `data:` images/fonts only;
//   3. the iframe it lands in is sandboxed without `allow-scripts`,
//      `allow-forms`, `allow-popups` or `allow-top-navigation`;
//   4. a `srcdoc` frame inherits the app's CSP too, which has no inline script.
//
// Parsing the raw file (DOMParser, below) is itself inert: the document it
// makes has no browsing context, so nothing in it is fetched, rendered or run
// — even without a CSP (scripts/smoke-html-preview.mjs checks exactly that).
//
// The frame keeps `allow-same-origin` so the app can intercept its link clicks
// and keep its scroll position; that is only safe because no script runs in it.

/** No script, no network: the file's own inline styles and `data:` resources. */
export const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'"

/** The sandbox tokens of the preview frame — deliberately not `allow-scripts`. */
export const PREVIEW_SANDBOX = 'allow-same-origin'

/** Elements dropped with their content: they run code, embed other documents
 *  or change how the document's URLs and navigation behave. */
const DROPPED = 'script, iframe, frame, frameset, object, embed, applet, portal, fencedframe, base, meta, link'

/** Attributes that hold a URL. Outside `a`/`area` `href`, the only URL kept is
 *  an in-document `#fragment` or a `data:image/…` — and `img` sources the
 *  caller resolved from the scope. */
const URL_ATTRS = new Set(['src', 'srcset', 'href', 'xlink:href', 'action', 'formaction', 'poster', 'background', 'data',
  'ping', 'codebase', 'cite', 'longdesc', 'lowsrc', 'dynsrc', 'manifest', 'imagesrcset', 'attributionsrc', 'archive', 'classid', 'usemap'])

/** Attributes dropped outright: declarative shadow roots would put markup this
 *  pass never saw on screen; the rest steal focus or open new windows. */
const DROPPED_ATTRS = new Set(['shadowrootmode', 'shadowroot', 'autofocus', 'target', 'srcdoc', 'http-equiv'])

const SCHEME = /^\s*([a-z][a-z0-9+.-]*):/i
/** Browsers skip control characters inside a URL (`java\tscript:`), so the
 *  scheme is read with them removed. */
const stripControls = (url: string): string => Array.from(url).filter((c) => c.charCodeAt(0) > 0x1f && c.charCodeAt(0) !== 0x7f).join('')
const scheme = (url: string): string | null => SCHEME.exec(stripControls(url))?.[1]?.toLowerCase() ?? null
// An SVG as an image runs no script, so `data:image/svg+xml` is as inert as a PNG.
const isDataImage = (url: string): boolean => /^\s*data:image\//i.test(url)

/** A link target the preview may keep: in-document, relative (a scope file),
 *  or a web/mail address the app hands to the OS browser on click. */
export const linkScheme = (href: string): 'fragment' | 'relative' | 'external' | null => {
  if (href.trim().startsWith('#')) return 'fragment'
  const s = scheme(href)
  if (s === null) return href.trim().startsWith('//') ? null : 'relative'
  return s === 'http' || s === 'https' || s === 'mailto' ? 'external' : null
}

/** An `img` source to read from the scope: relative, not a URL of any kind. */
export const isScopeImageSrc = (src: string): boolean => !!src.trim() && scheme(src) === null && !src.trim().startsWith('//') && !src.trim().startsWith('#')

/** Every element under `root`, template contents included. */
function* elements(root: ParentNode): Generator<Element> {
  for (const el of Array.from(root.querySelectorAll('*'))) {
    yield el
    if (el instanceof HTMLTemplateElement) yield* elements(el.content)
  }
}

/** The relative `img` sources of `html` — the ones to read from the scope. */
export function scopeImageSources(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const found = new Set<string>()
  for (const el of elements(doc)) {
    const src = el.localName === 'img' ? el.getAttribute('src') : null
    if (src && isScopeImageSrc(src)) found.add(src)
  }
  return [...found]
}

function sanitize(root: ParentNode, images: ReadonlyMap<string, string>): void {
  // Templates first, so their contents are cleaned before they are dropped or kept.
  for (const el of Array.from(root.querySelectorAll('template'))) sanitize(el.content, images)
  for (const el of Array.from(root.querySelectorAll(DROPPED))) el.remove()
  for (const el of Array.from(root.querySelectorAll('*'))) {
    const tag = el.localName
    for (const { name, value } of Array.from(el.attributes)) {
      const lower = name.toLowerCase()
      if (lower.startsWith('on') || DROPPED_ATTRS.has(lower)) { el.removeAttribute(name); continue }
      if (!URL_ATTRS.has(lower)) continue
      if ((tag === 'a' || tag === 'area') && (lower === 'href' || lower === 'xlink:href')) {
        if (!linkScheme(value)) el.removeAttribute(name)
        continue
      }
      if (lower === 'src' && tag === 'img' && images.has(value)) { el.setAttribute(name, images.get(value)!); continue }
      if ((lower === 'href' || lower === 'xlink:href') && value.trim().startsWith('#')) continue
      if ((lower === 'src' || lower === 'poster') && isDataImage(value)) continue
      el.removeAttribute(name)
    }
  }
}

/** `html` made inert, as a whole document for an iframe's `srcdoc`. Relative
 *  `img` sources found in `images` (source → `data:` URL) are swapped in. */
export function previewDocument(html: string, images: ReadonlyMap<string, string> = new Map()): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  sanitize(doc, images)
  const csp = doc.createElement('meta')
  csp.setAttribute('http-equiv', 'Content-Security-Policy')
  csp.setAttribute('content', PREVIEW_CSP)
  doc.head.prepend(csp)
  return `<!DOCTYPE html>${doc.documentElement.outerHTML}`
}
