import type { JSX } from 'react'
import type { Tone } from '../status'
import { agentDef } from '../../../shared/agents'
// Shared line-icon set (Feather/Lucide-style strokes, 1.75px, round caps) used
// across the whole UI — see the redesign handoff's Assets section.

export type IconName =
  | 'search'
  | 'plus'
  | 'message'
  | 'bot'
  | 'box'
  | 'branch'
  | 'sliders'
  | 'gear'
  | 'mic'
  | 'slash'
  | 'lock'
  | 'chevron'
  | 'image'
  | 'history'
  | 'grid'
  | 'send'
  | 'x'
  | 'key'
  | 'plug'
  | 'globe'
  | 'globe-lock'
  | 'eye'
  | 'eye-lock'
  | 'play'
  | 'file'
  | 'folder'
  | 'trash'
  | 'copy'
  | 'dots'
  | 'vscode'
  | 'terminal'
  | 'agent-generic'
  | 'bell'
  | 'fold'
  | 'sort'
  | 'info'
  | 'list'
  | 'tree'
  | 'check'
  | 'edit'
  | 'think'
  | 'move'

const PATHS: Record<IconName, JSX.Element> = {
  list: (
    <>
      <path d="M9 6h12M9 12h12M9 18h12" />
      <path d="M3 6h1M3 12h1M3 18h1" />
    </>
  ),
  tree: (
    <>
      <path d="M4 3v14h5M4 7h5" />
      <rect x="10" y="4" width="10" height="6" rx="1" />
      <rect x="10" y="14" width="10" height="6" rx="1" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </>
  ),
  plus: (
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>
  ),
  bot: (
    <>
      <path d="M12 8V4H8" />
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M2 14h2m16 0h2M9 13v2m6-2v2" />
    </>
  ),
  message: (
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z" />
  ),
  box: (
    <>
      <path d="M21 8v8a2 2 0 0 1-1 1.73l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8a2 2 0 0 1 1-1.73l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8z" />
      <polyline points="3.3 7 12 12 20.7 7" />
      <line x1="12" y1="22" x2="12" y2="12" />
    </>
  ),
  branch: (
    <>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </>
  ),
  sliders: (
    <>
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.09a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.09a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  mic: (
    <>
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
    </>
  ),
  slash: <line x1="16" y1="4" x2="8" y2="20" />,
  lock: (
    <>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  chevron: <polyline points="6 9 12 15 18 9" />,
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <polyline points="3 3 3 8 8 8" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  send: (
    <>
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </>
  ),
  x: (
    <>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </>
  ),
  plug: (
    <>
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z" />
      <line x1="9" y1="2" x2="9" y2="8" />
      <line x1="15" y1="2" x2="15" y2="8" />
      <line x1="12" y1="17" x2="12" y2="22" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </>
  ),
  // Isolated egress: Google's `vpn_lock` from Material Symbols, verbatim, under
  // the Apache 2.0 this project is already under (their repo ships no NOTICE and
  // their icons carry no headers, so there is nothing further to carry). Its
  // sphere sits where `globe`'s does — r10 on centre, 2 to 22 — so the two
  // egress modes are the same size, and the lock takes the top-right corner
  // without pushing the globe aside for it.
  //
  // It is the one mark in the set drawn as a solid rather than a stroke, which
  // is why it is in FILLED: Material draws its globe as landmasses, not as a
  // grid, and no stroke width makes that into a Feather outline. The wrapper
  // carries Material's own 0 -960 960 960 grid onto this file's 24 one, so the
  // path stays byte-identical to upstream's and can be re-pulled as such.
  'globe-lock': (
    <g transform="translate(0 24) scale(.025)">
      <path d="M480-80q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480q0-83 31.5-155.5t86-127Q252-817 325-848.5T480-880q32 0 61.5 4.5T600-862v102q0 33-23.5 56.5T520-680h-80v80q0 17-11.5 28.5T400-560h-80v80h240q17 0 28.5 11.5T600-440v120h40q27 0 47.5 16t28.5 40q39-44 61.5-98.5T800-480q0-11-1-20t-3-20h82q2 11 2 20v20q0 82-31.5 155t-86 127.5q-54.5 54.5-127 86T480-80Zm-40-82v-78q-33 0-56.5-23.5T360-320v-40L168-552q-3 18-5.5 36t-2.5 36q0 124 80.5 213.5T440-162Zm280-438q-17 0-28.5-11.5T680-640v-120q0-17 11.5-28.5T720-800v-40q0-33 23.5-56.5T800-920q33 0 56.5 23.5T880-840v40q17 0 28.5 11.5T920-760v120q0 17-11.5 28.5T880-600H720Zm40-200h80v-40q0-17-11.5-28.5T800-880q-17 0-28.5 11.5T760-840v40Z" />
    </g>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <line x1="10.85" y1="12.15" x2="19" y2="4" />
      <line x1="18" y1="5" x2="20" y2="7" />
      <line x1="15" y1="8" x2="17" y2="10" />
    </>
  ),
  eye: (
    <>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  // `eye` moved up-left to free its bottom-right corner for a lock, whose body
  // is filled because a stroked one closes into a blob at the sizes this renders
  // at — it looks, and it holds a lock while it does.
  'eye-lock': (
    <>
      <path d="M0.8 10.5s3.35-6.5 9.2-6.5 9.2 6.5 9.2 6.5-3.35 6.5-9.2 6.5-9.2-6.5-9.2-6.5z" />
      <circle cx="10" cy="10.5" r="2.6" />
      <rect x="16.6" y="17.8" width="6.8" height="5.2" rx="1.3" fill="currentColor" stroke="none" />
      <path d="M18.2 17.8v-1.2a1.8 1.8 0 0 1 3.6 0v1.2" strokeWidth={1.6} />
    </>
  ),
  play: <polygon points="6 4 20 12 6 20 6 4" />,
  file: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </>
  ),
  folder: (
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  ),
  trash: (
    <>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  dots: (
    <>
      <circle cx="5" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="19" cy="12" r="1.4" />
    </>
  ),
  vscode: (
    <path d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z" />
  ),
  terminal: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <polyline points="6 9 10 12.5 6 16" />
      <line x1="12" y1="16" x2="17" y2="16" />
    </>
  ),
  'agent-generic': (
    <>
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <circle cx="9" cy="14" r="1.3" />
      <circle cx="15" cy="14" r="1.3" />
      <line x1="12" y1="8" x2="12" y2="4" />
      <circle cx="12" cy="3" r="1.3" />
    </>
  ),
  bell: (
    <>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </>
  ),
  // Two stacked chevrons — collapse/expand-all toggle for the task tree.
  // Rotated 180° in place for the opposite (expand) state.
  fold: (
    <>
      <polyline points="7 6 12 11 17 6" />
      <polyline points="7 13 12 18 17 13" />
    </>
  ),
  // Descending bars beside a down arrow — flipped vertically for the reverse
  // direction (see the sidebar's sort button), which is why it is symmetric
  // about neither axis on its own.
  sort: (
    <>
      <line x1="4" y1="6" x2="14" y2="6" />
      <line x1="4" y1="12" x2="11" y2="12" />
      <line x1="4" y1="18" x2="8" y2="18" />
      <polyline points="16 14 19 17.5 22 14" />
      <line x1="19" y1="6" x2="19" y2="17" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <line x1="12" y1="7.6" x2="12.01" y2="7.6" />
    </>
  ),
  check: <polyline points="4 12 10 18 20 6" />,
  edit: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </>
  ),
  think: (
    <>
      <path d="M9 18h6" />
      <path d="M10 21h4" />
      <path d="M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3Z" />
    </>
  ),
  move: (
    <>
      <line x1="4" y1="12" x2="20" y2="12" />
      <polyline points="14 6 20 12 14 18" />
    </>
  )
}

/** Icons drawn as a solid mark (currentColor fill) rather than a stroke outline. */
const FILLED = new Set<IconName>([
  'play',
  'dots',
  'globe-lock',
  'vscode'
])

/** Brand marks keep their real color instead of inheriting currentColor —
 *  the whole point is at-a-glance recognition. (An agent kind's mark and its
 *  colour are its plugin's — see {@link AgentIcon}.) */
const BRAND_COLOR: Partial<Record<IconName, string>> = {
  vscode: '#0098FF'
}

type IconProps = {
  size?: number | undefined
  className?: string | undefined
  style?: React.CSSProperties | undefined
}

/** The one `<svg>` every glyph is drawn in. */
function Svg({
  size = 15,
  className,
  style,
  fill,
  children
}: IconProps & { fill: string | undefined; children: React.ReactNode }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ?? 'none'}
      stroke={fill ? 'none' : 'currentColor'}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
    >
      {children}
    </svg>
  )
}

export function Icon({ name, ...props }: IconProps & { name: IconName }): JSX.Element {
  return (
    <Svg {...props} fill={FILLED.has(name) ? (BRAND_COLOR[name] ?? 'currentColor') : undefined}>
      {PATHS[name]}
    </Svg>
  )
}

/** An agent kind's mark — the one its plugin brings (`AgentManifest.icon`),
 *  drawn solid in its brand colour, or the generic agent glyph for a kind
 *  that brings none (agents.json can outlive a plugin). */
export function AgentIcon({ kind, ...props }: IconProps & { kind?: string | undefined }): JSX.Element {
  const icon = kind ? agentDef(kind)?.icon : undefined
  if (!icon) return <Icon name="agent-generic" {...props} />
  return (
    <Svg {...props} fill={icon.color ?? 'currentColor'}>
      <path {...(icon.fillRule ? { fillRule: icon.fillRule } : {})} d={icon.path} />
    </Svg>
  )
}

/** Round 'i' mark hiding a hint until hovered or focused — how the config
 *  surfaces keep their explanations without spending a layout line on each. */
export function InfoDot({ text }: { text: string }): JSX.Element {
  return (
    <span className="info-dot" tabIndex={0} aria-label={text}>
      <Icon name="info" size={13} />
      <span className="info-pop">{text}</span>
    </span>
  )
}

/** App mark — the same four-dot layout as the window/dock icon (three filled,
 *  one outlined), redrawn flat for in-UI use (e.g. the session placeholder's
 *  watermark) rather than embedding the packaged app-icon image. */
export function Logo({ size = 64, className }: { size?: number; className?: string }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
      <rect x="1" y="1" width="22" height="22" rx="5" fill="none" stroke="var(--faint)" strokeWidth="1.2" />
      <circle cx="7.5" cy="7.5" r="3.4" fill="var(--green)" />
      <circle cx="16.5" cy="7.5" r="3.4" fill="var(--accent)" />
      <circle cx="7.5" cy="16.5" r="3.4" fill="var(--accent)" />
      <circle cx="16.5" cy="16.5" r="3.4" fill="none" stroke="var(--faint)" strokeWidth="1.75" />
    </svg>
  )
}

/** Status dot used everywhere (sidebar, headers, palette, env rows). `tone` is
 *  the colour axis, `hollow` the fill axis and `pulse` marks live work — see the
 *  grammar on `SESSION_DOT`. */
export function Dot({
  tone,
  pulse,
  hollow,
  size = 8
}: {
  tone: Tone
  pulse?: boolean | undefined
  hollow?: boolean | undefined
  size?: number | undefined
}): JSX.Element {
  return (
    <span
      className={`dot dot-${tone}${hollow ? ' dot-hollow' : ''}${pulse ? ' dot-pulse' : ''}`}
      style={size !== 8 ? { width: size, height: size } : undefined}
    />
  )
}
