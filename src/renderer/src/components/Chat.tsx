import { useEffect, useRef, useState } from 'react'
import type {
  ChatEntry,
  CommandInfo,
  PlanEntry,
  PromptCapabilities,
  PromptContext,
  PromptImage,
  SessionConfigOption,
  SessionMode,
  SessionModes,
  SessionSnapshot
} from '../../../shared/types'
import { agentName, useAgents } from '../useAgents'

/** Don't ping the main process on every keystroke — once per this interval is enough
 *  to keep postponing the env's idle auto-stop while the user is composing. */
const ACTIVITY_PING_INTERVAL_MS = 5_000

export function Chat({ snapshot, sessionId }: { snapshot?: SessionSnapshot; sessionId: string }) {
  const [planOpen, setPlanOpen] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)
  const agents = useAgents()

  const entries = snapshot?.entries ?? []

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries.length, entries[entries.length - 1]?.id])

  if (!snapshot) return <div className="placeholder">loading session…</div>

  const { info, modes, plan, commands, configOptions, promptCapabilities, busy } = snapshot

  return (
    <div className="chat">
      <div className="chat-header">
        <span className="breadcrumb">
          {info.workspace}
          <span className="sep">/</span>
          {info.task}
          <span className="sep">/</span>
          <span className="leaf">{info.envRepo}</span>
        </span>
        {info.agent && <span className="chip">{agentName(agents, info.agent)}</span>}
        <span className="spacer" />
        {busy && (
          <>
            <span className="busy">working…</span>
            <button onClick={() => window.gurt.sessionCancel(sessionId)}>Stop</button>
          </>
        )}
      </div>

      <div className="chat-log">
        {entries.map((e, i) => (
          <EntryRow
            key={e.id}
            entry={e}
            sessionId={sessionId}
            last={i === entries.length - 1 && !busy}
          />
        ))}
        {busy && <ThinkingRow />}
        <div ref={bottomRef} />
      </div>

      {plan && plan.length > 0 && (
        <PlanPanel plan={plan} open={planOpen} onToggle={() => setPlanOpen((o) => !o)} />
      )}

      <Composer
        sessionId={sessionId}
        busy={busy}
        modes={modes}
        commands={commands ?? []}
        configOptions={configOptions ?? []}
        promptCaps={promptCapabilities}
      />
    </div>
  )
}

const MAX_TA_HEIGHT = 220

// ---- inline icon set (feather-style strokes, matching the Composer design) ----

type IconName =
  | 'file'
  | 'folder'
  | 'git'
  | 'search'
  | 'mic'
  | 'plus'
  | 'send'
  | 'auto'
  | 'plan'
  | 'ask'
  | 'image'
  | 'cpu'
  | 'gauge'
  | 'toggle'

const ICON_PATHS: Record<IconName, JSX.Element> = {
  file: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </>
  ),
  folder: <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />,
  git: (
    <>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M6 21V9a9 9 0 0 0 9 9" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </>
  ),
  plus: (
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>
  ),
  send: (
    <>
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </>
  ),
  auto: <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />,
  plan: (
    <>
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </>
  ),
  ask: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="M21 15l-5-5L5 21" />
    </>
  ),
  cpu: (
    <>
      <rect x="9" y="9" width="6" height="6" rx="1" />
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" />
    </>
  ),
  gauge: (
    <>
      <path d="M12 14l4-4" />
      <path d="M3.5 18a9 9 0 1 1 17 0" />
    </>
  ),
  toggle: (
    <>
      <rect x="1" y="6" width="22" height="12" rx="6" />
      <circle cx="16" cy="12" r="3" />
    </>
  )
}

function Icon({ name, size = 15 }: { name: IconName; size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICON_PATHS[name]}
    </svg>
  )
}

/** Pick an icon + accent colour for a session mode by matching its id/name. The
 *  ACP mode set is agent-defined, so this is a best-effort mapping with a default. */
function modeVisual(m: SessionMode): { icon: IconName; color: string } {
  const k = `${m.id} ${m.name}`.toLowerCase()
  if (k.includes('plan')) return { icon: 'plan', color: 'var(--accent)' }
  if (k.includes('ask') || k.includes('default') || k.includes('manual') || k.includes('confirm'))
    return { icon: 'ask', color: 'var(--yellow)' }
  return { icon: 'auto', color: 'var(--green)' }
}

/** Trailing-slash-tolerant basename, also handling `git:` pseudo-paths. */
const basename = (p: string): string => {
  if (p.startsWith('git:')) return p
  const cleaned = p.replace(/\/+$/, '')
  return cleaned.split('/').pop() || cleaned || p
}

const chipIcon = (path: string): IconName =>
  path.startsWith('git:') ? 'git' : path.endsWith('/') ? 'folder' : 'file'

function configIcon(category?: string): IconName {
  if (category === 'model') return 'cpu'
  if (category === 'thought_level') return 'gauge'
  return 'toggle'
}

/** Read a File as bare base64 (no `data:...;base64,` prefix), for an ACP image block. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

function Composer({
  sessionId,
  busy,
  modes,
  commands,
  configOptions,
  promptCaps
}: {
  sessionId: string
  busy: boolean
  modes?: SessionModes
  commands: CommandInfo[]
  configOptions: SessionConfigOption[]
  promptCaps?: PromptCapabilities
}) {
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  const [chips, setChips] = useState<PromptContext[]>([])
  const [images, setImages] = useState<PromptImage[]>([])
  const [slashOpen, setSlashOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [modeOpen, setModeOpen] = useState(false)
  /** id of the config-option select whose dropdown is open, or null. */
  const [openConfigId, setOpenConfigId] = useState<string | null>(null)
  const [cmdQuery, setCmdQuery] = useState('')
  const [cmdIdx, setCmdIdx] = useState(0)
  /** null → the add-context item list; 'file'/'folder' → an inline path input. */
  const [addKind, setAddKind] = useState<'file' | 'folder' | null>(null)
  const [addPath, setAddPath] = useState('')
  const [micOn, setMicOn] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const cmdRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLInputElement>(null)
  const recogRef = useRef<{ stop: () => void } | null>(null)
  const lastActivityPingRef = useRef(0)

  const pingActivity = () => {
    const now = performance.now()
    if (now - lastActivityPingRef.current < ACTIVITY_PING_INTERVAL_MS) return
    lastActivityPingRef.current = now
    window.gurt.sessionActivity(sessionId).catch(console.error)
  }

  const autoGrow = () => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, MAX_TA_HEIGHT) + 'px'
  }

  // Re-fit whenever the value changes (send clears it, pickCommand extends it).
  useEffect(autoGrow, [text])

  // Close every popup on an outside click.
  useEffect(() => {
    if (!slashOpen && !addOpen && !modeOpen && openConfigId === null) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) closeMenus()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [slashOpen, addOpen, modeOpen, openConfigId])

  // Stop any live dictation when the composer unmounts (session switch).
  useEffect(() => () => recogRef.current?.stop(), [])

  const filteredCmds = (() => {
    const q = cmdQuery.trim().toLowerCase().replace(/^\//, '')
    if (!q) return commands
    return commands.filter(
      (c) => c.name.toLowerCase().includes(q) || (c.description ?? '').toLowerCase().includes(q)
    )
  })()
  const showSlash = slashOpen && commands.length > 0

  // Keep the highlighted command in range as the filtered list shrinks.
  useEffect(() => {
    if (cmdIdx >= filteredCmds.length) setCmdIdx(0)
  }, [filteredCmds.length, cmdIdx])

  const closeMenus = () => {
    setSlashOpen(false)
    setAddOpen(false)
    setModeOpen(false)
    setOpenConfigId(null)
    setAddKind(null)
    setAddPath('')
  }

  const openSlash = (open: boolean) => {
    setAddOpen(false)
    setModeOpen(false)
    setOpenConfigId(null)
    setSlashOpen(open)
    setCmdQuery('')
    setCmdIdx(0)
    if (open) setTimeout(() => cmdRef.current?.focus(), 0)
  }

  const openAdd = (open: boolean) => {
    setSlashOpen(false)
    setModeOpen(false)
    setOpenConfigId(null)
    setAddKind(null)
    setAddPath('')
    setAddOpen(open)
  }

  const send = () => {
    const t = text.trim()
    if ((!t && images.length === 0) || busy) return
    const context = chips.length ? chips : undefined
    const imgs = images.length ? images : undefined
    setText('')
    setChips([])
    setImages([])
    closeMenus()
    window.gurt.sessionPrompt(sessionId, t, context, imgs).catch(console.error)
  }

  const pickImages = async (files: FileList | null) => {
    openAdd(false)
    if (!files?.length) return
    const added: PromptImage[] = []
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue
      try {
        added.push({ name: f.name, mimeType: f.type, data: await fileToBase64(f) })
      } catch (e) {
        console.error(e)
      }
    }
    if (added.length) setImages((imgs) => [...imgs, ...added])
    setTimeout(() => taRef.current?.focus(), 0)
  }

  const removeImage = (i: number) => setImages((imgs) => imgs.filter((_, j) => j !== i))

  const changeConfig = (opt: SessionConfigOption, value: string | boolean) => {
    setOpenConfigId(null)
    window.gurt.sessionSetConfigOption(sessionId, opt.id, value).catch((e) => alert(String(e)))
  }

  const pickCommand = (name: string) => {
    setText(`/${name} `)
    setSlashOpen(false)
    setCmdQuery('')
    setCmdIdx(0)
    setTimeout(() => taRef.current?.focus(), 0)
  }

  const addChip = (ctx: PromptContext) => {
    setChips((c) => [...c, ctx])
    openAdd(false)
    setTimeout(() => taRef.current?.focus(), 0)
  }

  const commitAddPath = () => {
    const raw = addPath.trim()
    if (!raw) return
    const path = addKind === 'folder' && !raw.endsWith('/') ? `${raw}/` : raw
    addChip({ name: basename(path), path })
  }

  const removeChip = (i: number) => setChips((c) => c.filter((_, j) => j !== i))

  const onCmdKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCmdIdx((i) => Math.min(i + 1, filteredCmds.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCmdIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const c = filteredCmds[cmdIdx]
      if (c) pickCommand(c.name)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setSlashOpen(false)
      taRef.current?.focus()
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
      return
    }
    if (e.key === 'Escape') closeMenus()
  }

  const toggleMic = () => {
    const SR =
      (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike })
        .webkitSpeechRecognition
    if (!SR) return // speech recognition unavailable on this platform — no-op
    if (recogRef.current) {
      recogRef.current.stop()
      return
    }
    const r = new SR()
    r.interimResults = false
    r.continuous = true
    r.onresult = (e: SpeechResultEvent) => {
      let add = ''
      for (let i = e.resultIndex; i < e.results.length; i++)
        if (e.results[i].isFinal) add += e.results[i][0].transcript
      add = add.trim()
      if (add) setText((t) => (t && !t.endsWith(' ') ? `${t} ${add}` : `${t}${add}`))
    }
    r.onend = () => {
      recogRef.current = null
      setMicOn(false)
    }
    r.onerror = () => {
      recogRef.current = null
      setMicOn(false)
    }
    try {
      r.start()
      recogRef.current = r
      setMicOn(true)
    } catch {
      recogRef.current = null
      setMicOn(false)
    }
  }

  const canSend = !busy && (text.trim().length > 0 || images.length > 0)
  const curMode = modes?.availableModes.find((m) => m.id === modes.currentModeId)
  const curVisual = curMode ? modeVisual(curMode) : null
  const hasModes = !!modes && modes.availableModes.length > 0
  // The agent may surface Mode as a config option too; we already render it as the
  // dedicated mode pill, so drop it here to avoid a duplicate control.
  const cfgOptions = configOptions.filter((o) => o.category !== 'mode')
  const openConfig = cfgOptions.find((o) => o.id === openConfigId && o.type === 'select')

  return (
    <div className="composer-wrap">
      {(chips.length > 0 || images.length > 0) && (
        <div className="composer-chips">
          {chips.map((c, i) => (
            <span className="ctx-chip" key={`${c.path}-${i}`}>
              <span className="ctx-ic">
                <Icon name={chipIcon(c.path)} size={12} />
              </span>
              <span className="ctx-name">{c.name}</span>
              <span className="ctx-x" title="Remove" onClick={() => removeChip(i)}>
                ×
              </span>
            </span>
          ))}
          {images.map((img, i) => (
            <span className="ctx-chip" key={`img-${img.name}-${i}`}>
              <span className="ctx-ic">
                <Icon name="image" size={12} />
              </span>
              <span className="ctx-name">{img.name}</span>
              <span className="ctx-x" title="Remove" onClick={() => removeImage(i)}>
                ×
              </span>
            </span>
          ))}
        </div>
      )}

      <div
        ref={rootRef}
        className={`composer ${busy ? 'disabled' : ''} ${focused && !busy ? 'focused' : ''}`}
      >
        {showSlash && (
          <div className="cmp-menu slash-menu">
            <div className="slash-filter-row">
              <span className="slash-search">
                <Icon name="search" size={13} />
              </span>
              <input
                ref={cmdRef}
                className="cmp-input slash-filter"
                placeholder="Filter commands…"
                value={cmdQuery}
                onChange={(e) => {
                  setCmdQuery(e.target.value)
                  setCmdIdx(0)
                }}
                onKeyDown={onCmdKey}
              />
            </div>
            <div className="slash-list">
              {filteredCmds.length === 0 ? (
                <div className="cmp-menu-empty">No matching commands</div>
              ) : (
                filteredCmds.map((c, i) => (
                  <div
                    key={c.name}
                    className={`cmp-menu-item ${i === cmdIdx ? 'active' : ''}`}
                    onMouseEnter={() => setCmdIdx(i)}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      pickCommand(c.name)
                    }}
                  >
                    <span className="cmd-name">/{c.name}</span>
                    {c.description && <span className="cmd-desc">{c.description}</span>}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {addOpen && (
          <div className="cmp-menu add-menu">
            {addKind === null ? (
              <>
                <div className="cmp-menu-head">ADD CONTEXT</div>
                <div
                  className="cmp-menu-item ctx-item"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    setAddKind('file')
                  }}
                >
                  <span className="ctx-ic">
                    <Icon name="file" />
                  </span>
                  <span>File…</span>
                </div>
                <div
                  className="cmp-menu-item ctx-item"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    setAddKind('folder')
                  }}
                >
                  <span className="ctx-ic">
                    <Icon name="folder" />
                  </span>
                  <span>Folder…</span>
                </div>
                <div
                  className="cmp-menu-item ctx-item"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    addChip({ name: 'git diff', path: 'git:diff' })
                  }}
                >
                  <span className="ctx-ic">
                    <Icon name="git" />
                  </span>
                  <span>Git diff</span>
                </div>
                {promptCaps?.image && (
                  <div
                    className="cmp-menu-item ctx-item"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      imgRef.current?.click()
                    }}
                  >
                    <span className="ctx-ic">
                      <Icon name="image" />
                    </span>
                    <span>Image…</span>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="cmp-menu-head">
                  {addKind === 'file' ? 'ADD FILE' : 'ADD FOLDER'}
                </div>
                <input
                  autoFocus
                  className="cmp-input add-path-input"
                  placeholder="path relative to repo root…"
                  value={addPath}
                  onChange={(e) => setAddPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      commitAddPath()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      setAddKind(null)
                      setAddPath('')
                    }
                  }}
                />
                <div className="add-path-hint">Enter to add · Esc to cancel</div>
              </>
            )}
          </div>
        )}

        {modeOpen && hasModes && (
          <div className="cmp-menu mode-menu">
            <div className="cmp-menu-head">MODE</div>
            {modes!.availableModes.map((m) => {
              const v = modeVisual(m)
              return (
                <div
                  key={m.id}
                  className="cmp-menu-item mode-row"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    setModeOpen(false)
                    window.gurt.sessionSetMode(sessionId, m.id).catch((er) => alert(String(er)))
                  }}
                >
                  <span className="mode-ic" style={{ color: v.color }}>
                    <Icon name={v.icon} size={14} />
                  </span>
                  <span className="mode-name">{m.name}</span>
                  {m.id === modes!.currentModeId && <span className="mode-check">✓</span>}
                </div>
              )
            })}
          </div>
        )}

        {openConfig && (
          <div className="cmp-menu mode-menu">
            <div className="cmp-menu-head">{openConfig.name.toUpperCase()}</div>
            <div className="slash-list">
              {(openConfig.options ?? []).map((o) => (
                <div
                  key={o.value}
                  className="cmp-menu-item mode-row"
                  title={o.description ?? undefined}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    changeConfig(openConfig, o.value)
                  }}
                >
                  <span className="mode-name">{o.name}</span>
                  {o.value === openConfig.currentValue && <span className="mode-check">✓</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        <input
          ref={imgRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            void pickImages(e.target.files)
            e.target.value = ''
          }}
        />

        <div className="composer-row">
          <textarea
            ref={taRef}
            rows={1}
            className="composer-input"
            placeholder={busy ? 'agent is working…' : 'Ask gurt to change your code, or type / for commands…'}
            value={text}
            disabled={busy}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(e) => {
              const v = e.target.value
              setText(v)
              if (v.trim() === '/' && !slashOpen) openSlash(true)
              else if (!v.startsWith('/')) setSlashOpen(false)
              pingActivity()
            }}
            onKeyDown={onKeyDown}
          />
          <button
            className={`mic-btn ${micOn ? 'on' : ''}`}
            title={micOn ? 'Stop dictation' : 'Dictate'}
            disabled={busy}
            onClick={toggleMic}
          >
            <Icon name="mic" size={17} />
          </button>
        </div>

        <div className="composer-toolbar">
          <button
            className={`tbtn ${addOpen ? 'active' : ''}`}
            title="Add context"
            disabled={busy}
            onClick={() => openAdd(!addOpen)}
          >
            <Icon name="plus" />
          </button>
          <button
            className={`tbtn tbtn-slash ${showSlash ? 'active' : ''}`}
            title="Commands"
            disabled={busy}
            onClick={() => openSlash(!slashOpen)}
          >
            /
          </button>
          <span className="spacer" />
          {text.length > 0 && <span className="char-count">{text.length} chars</span>}
          {hasModes && (
            <button
              className={`mode-pill ${modeOpen ? 'active' : ''}`}
              onClick={() => {
                setSlashOpen(false)
                setAddOpen(false)
                setModeOpen((o) => !o)
              }}
            >
              {curVisual && (
                <span className="mode-ic" style={{ color: curVisual.color }}>
                  <Icon name={curVisual.icon} size={14} />
                </span>
              )}
              {curMode?.name ?? 'Mode'}
              <span className="caret">▾</span>
            </button>
          )}
          {cfgOptions.map((opt) => {
            if (opt.type === 'boolean') {
              const on = opt.currentValue === true
              return (
                <button
                  key={opt.id}
                  className={`mode-pill ${on ? 'active' : ''}`}
                  title={opt.description ?? opt.name}
                  disabled={busy}
                  onClick={() => changeConfig(opt, !on)}
                >
                  <span className="mode-ic" style={{ color: on ? 'var(--green)' : 'var(--text-dim3)' }}>
                    <Icon name="toggle" size={14} />
                  </span>
                  {opt.name}
                </button>
              )
            }
            const cur = opt.options?.find((o) => o.value === opt.currentValue)
            return (
              <button
                key={opt.id}
                className={`mode-pill ${openConfigId === opt.id ? 'active' : ''}`}
                title={opt.description ?? opt.name}
                disabled={busy}
                onClick={() => {
                  setSlashOpen(false)
                  setAddOpen(false)
                  setModeOpen(false)
                  setOpenConfigId((id) => (id === opt.id ? null : opt.id))
                }}
              >
                <span className="mode-ic" style={{ color: 'var(--accent)' }}>
                  <Icon name={configIcon(opt.category)} size={14} />
                </span>
                {cur?.name ?? opt.name}
                <span className="caret">▾</span>
              </button>
            )
          })}
          <button className="send-btn" disabled={!canSend} onClick={send} title="Send">
            <Icon name="send" size={17} />
          </button>
        </div>
      </div>
      <div className="composer-hint">
        Enter to send · Shift+Enter for newline · <span className="k">/</span> for commands ·{' '}
        <span className="k">+</span> for context
      </div>
    </div>
  )
}

// Minimal typings for the Web Speech API (not in the DOM lib we target).
interface SpeechResultEvent {
  resultIndex: number
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>
}
interface SpeechRecognitionLike {
  interimResults: boolean
  continuous: boolean
  onresult: (e: SpeechResultEvent) => void
  onend: () => void
  onerror: () => void
  start: () => void
  stop: () => void
}

function EntryRow({
  entry,
  sessionId,
  last
}: {
  entry: ChatEntry
  sessionId: string
  last: boolean
}) {
  return (
    <div className="entry-row">
      <div className="rail">
        <RailNode entry={entry} />
        {!last && <span className="rail-line" />}
      </div>
      <div className="entry-body">
        <EntryBody entry={entry} sessionId={sessionId} />
      </div>
    </div>
  )
}

/** Live placeholder shown at the tail of the log while the agent is working,
 *  so there's visible feedback before its first output arrives. */
function ThinkingRow() {
  return (
    <div className="entry-row">
      <div className="rail">
        <span className="rail-node rn-agent thinking-node">G</span>
      </div>
      <div className="entry-body">
        <div className="entry-label">
          Thinking
          <span className="thinking-dots">
            <span>.</span>
            <span>.</span>
            <span>.</span>
          </span>
        </div>
      </div>
    </div>
  )
}

function RailNode({ entry }: { entry: ChatEntry }) {
  switch (entry.kind) {
    case 'user':
      return <span className="rail-dot" style={{ background: 'var(--accent)' }} />
    case 'agent':
      return <span className="rail-node rn-agent">G</span>
    case 'thought':
      return <span className="rail-node rn-thought">◔</span>
    case 'tool': {
      const cls =
        entry.status === 'completed' ? 'rn-ok' : entry.status === 'failed' ? 'rn-fail' : 'rn-run'
      const mark = entry.status === 'completed' ? '✓' : entry.status === 'failed' ? '✕' : '◔'
      return <span className={`rail-node ${cls}`}>{mark}</span>
    }
    case 'permission':
      return <span className="rail-node rn-perm">!</span>
    case 'system':
      return <span className="rail-node rn-sys">·</span>
  }
}

function EntryBody({ entry, sessionId }: { entry: ChatEntry; sessionId: string }) {
  switch (entry.kind) {
    case 'user':
      return (
        <>
          <div className="entry-label">You</div>
          <div className="entry-text user">{entry.text}</div>
        </>
      )
    case 'agent':
      return <div className="entry-text">{entry.text}</div>
    case 'thought':
      return (
        <>
          <div className="entry-label">Thinking</div>
          <div className="entry-text thought">{entry.text}</div>
        </>
      )
    case 'tool':
      return (
        <div className="tool-block">
          <div className="tool-chip">
            <span className={`tool-status tool-${entry.status}`}>{entry.status}</span>
            {entry.toolKind && <span className="tk">[{entry.toolKind}]</span>}
            <span>{entry.title}</span>
          </div>
          {entry.detail && (
            <details>
              <summary className="tool-chip" style={{ borderRadius: '0 0 7px 7px', borderTop: 'none' }}>
                <span className="tk">output ▸</span>
              </summary>
              <pre className="tool-detail">{entry.detail}</pre>
            </details>
          )}
        </div>
      )
    case 'permission':
      return (
        <div className="perm-card">
          <div className="perm-title">
            <span style={{ color: 'var(--yellow)' }}>🔓</span>
            {entry.title}
          </div>
          {entry.chosen ? (
            <div className="perm-chosen">
              → {entry.options.find((o) => o.optionId === entry.chosen)?.name ?? entry.chosen}
              {entry.chosen === 'auto' ? ' (auto)' : ''}
            </div>
          ) : (
            <div className="perm-buttons">
              {entry.options.map((o) => (
                <button
                  key={o.optionId}
                  className={o.kind?.startsWith('allow') ? 'allow-btn' : 'reject-btn'}
                  onClick={() =>
                    window.gurt.sessionPermission(sessionId, entry.id, o.optionId).catch(console.error)
                  }
                >
                  {o.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )
    case 'system':
      return <div className="entry-text sys">{entry.text}</div>
  }
}

function PlanPanel({
  plan,
  open,
  onToggle
}: {
  plan: PlanEntry[]
  open: boolean
  onToggle: () => void
}) {
  const done = plan.filter((p) => p.status === 'completed').length
  const running = plan.some((p) => p.status === 'in_progress')
  const pct = plan.length ? Math.round((done / plan.length) * 100) : 0
  return (
    <div className="plan-panel">
      <div className="plan-toggle" onClick={onToggle}>
        <svg
          className="plan-chevron"
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
        <span>TODO</span>
        <span style={{ color: 'var(--text-dim3)', fontWeight: 400 }}>
          {done} / {plan.length}
        </span>
        <div className="plan-bar">
          <div style={{ width: `${pct}%` }} />
        </div>
        {running && <span className="plan-running">running</span>}
      </div>
      {open && (
        <div className="plan-list">
          {plan.map((p, i) => (
            <div
              key={i}
              className={`plan-item ${
                p.status === 'completed' ? 'done' : p.status === 'in_progress' ? 'active' : ''
              }`}
            >
              <span className="pm">
                {p.status === 'completed' ? '✓' : p.status === 'in_progress' ? '›' : '·'}
              </span>
              {p.content}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
