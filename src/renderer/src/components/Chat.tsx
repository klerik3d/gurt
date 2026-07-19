import { useEffect, useRef, useState } from 'react'
import type {
  ChatEntry,
  ChatPermission,
  ChatToolCall,
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
import { alertDialog } from '../dialog'
import { Icon, Dot } from './icons'

/** Don't ping the main process on every keystroke — once per this interval is enough
 *  to keep postponing the env's idle auto-stop while the user is composing. */
const ACTIVITY_PING_INTERVAL_MS = 5_000

/**
 * Blanket permission-bypass modes (Claude's "bypassPermissions", Codex's "yolo").
 * They disable every guardrail, so they're hidden from the mode picker — gurt's
 * "auto" already maps to the safer accept-edits mode. Kept out of the UI, not the
 * protocol: the agent may still report one as current.
 */
const BLANKET_MODE_RE = /bypass|yolo/i
const isBlanketMode = (m: SessionMode): boolean => BLANKET_MODE_RE.test(`${m.id} ${m.name}`)

export function Chat({ snapshot, sessionId }: { snapshot?: SessionSnapshot; sessionId: string }) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const agents = useAgents()

  const entries = snapshot?.entries ?? []

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries.length, entries[entries.length - 1]?.id])

  // Esc stops the current turn while the agent is working (replaces the Stop
  // button). Ignore Esc raised from a text field so it can close its own popup,
  // and while any modal/dialog is open — there Esc means "dismiss it", and both
  // listeners live on window, so this one must stand down explicitly.
  const busy = snapshot?.busy ?? false
  useEffect(() => {
    if (!busy) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      if (document.querySelector('.modal-backdrop, .cmp-menu, .gear-pop')) return
      e.preventDefault()
      window.gurt.sessionCancel(sessionId).catch(console.error)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, sessionId])

  if (!snapshot) return <div className="placeholder">loading session…</div>

  const { info, modes, plan, commands, configOptions, promptCapabilities } = snapshot

  const lastUser = [...entries]
    .reverse()
    .find((e): e is ChatEntry & { kind: 'user' } => e.kind === 'user' && !!e.text.trim())
  const hasPlan = !!plan && plan.length > 0

  return (
    <div className="chat">
      <div className="chat-head">
        <Dot tone={busy ? 'yellow' : info.awaitingInput ? 'yellow' : 'green'} pulse={busy} />
        <span className="chat-title">
          {info.task} / {info.title}
        </span>
        <span className="spacer" />
        <span className="chat-pill">
          {info.envRepo}
          {info.agent ? ` · ${agentName(agents, info.agent)}` : ''}
        </span>
        {busy && <span className="chat-hint mono">esc to stop</span>}
      </div>

      {lastUser && <PinnedRequest text={lastUser.text} />}

      <div className="feed">
        <div className="feed-inner">
          <div className="feed-rail" />
          {entries.map((e) => (
            <Msg key={e.id} entry={e} sessionId={sessionId} />
          ))}
          {busy && <ThinkingLive />}
          <div ref={bottomRef} />
        </div>
      </div>

      {hasPlan && <PlanPinned plan={plan!} />}

      <Composer
        sessionId={sessionId}
        busy={busy}
        flush={!hasPlan}
        modes={modes}
        commands={commands ?? []}
        configOptions={configOptions ?? []}
        promptCaps={promptCapabilities}
      />
    </div>
  )
}

/** Sticky one-line echo of the user's last request, expandable to full text. */
function PinnedRequest({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`pinned-req ${open ? 'open' : ''}`} onClick={() => setOpen((o) => !o)}>
      <span className="seclabel">↑ YOUR REQUEST</span>
      <span className="pinned-req-text">{text}</span>
      <span className="pinned-req-toggle mono">{open ? 'collapse ▴' : 'expand ▾'}</span>
    </div>
  )
}

// ---- feed entries ----

function Msg({ entry, sessionId }: { entry: ChatEntry; sessionId: string }) {
  switch (entry.kind) {
    case 'user':
      return (
        <div className="msg">
          <span className="msg-dot" style={{ background: 'var(--accent)' }} />
          <div className="msg-you seclabel">YOU</div>
          <div className="msg-text user">{entry.text}</div>
        </div>
      )
    case 'agent':
      return (
        <div className="msg">
          <span className="msg-dot" style={{ background: 'var(--accent)' }} />
          <div className="msg-text">{entry.text}</div>
        </div>
      )
    case 'thought':
      return <ThoughtMsg text={entry.text} />
    case 'tool':
      return <ToolMsg entry={entry} />
    case 'permission':
      return <PermissionMsg entry={entry} sessionId={sessionId} />
    case 'system':
      return (
        <div className="msg msg-tool">
          <span className="msg-dot msg-dot-sm" style={{ background: 'var(--border2)' }} />
          <div className="msg-sys mono">{entry.text}</div>
        </div>
      )
  }
}

function ThoughtMsg({ text }: { text: string }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="msg">
      <span className="msg-dot" style={{ background: 'var(--yellow)' }} />
      <div className="thought-head mono" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} thinking…
      </div>
      {open && <div className="thought-text">{text}</div>}
    </div>
  )
}

/** Live placeholder shown at the tail of the log while the agent is working. */
function ThinkingLive() {
  return (
    <div className="msg">
      <span className="msg-dot dot-pulse" style={{ background: 'var(--yellow)' }} />
      <div className="thought-head mono">▾ thinking…</div>
    </div>
  )
}

/** Uppercase kind label for the tool row; falls back to a generic tag. */
function toolLabel(entry: ChatToolCall): string {
  const k = entry.toolKind
  if (!k) return 'tool'
  if (k === 'execute') return 'run'
  return k
}

function ToolMsg({ entry }: { entry: ChatToolCall }) {
  const failed = entry.status === 'failed'
  const running = entry.status === 'in_progress' || entry.status === 'pending'
  const hasDetail = !!entry.detail
  // Run/edit output starts expanded (the design's default); everything else
  // starts collapsed and always expands on failure.
  const [open, setOpen] = useState(
    failed || entry.toolKind === 'edit' || entry.toolKind === 'execute'
  )
  useEffect(() => {
    if (failed) setOpen(true)
  }, [failed])

  const dotColor = failed ? 'var(--red)' : running ? 'var(--yellow)' : 'var(--border2)'

  const head = (
    <div className={`tool-head ${hasDetail ? 'clickable' : ''}`} onClick={() => hasDetail && setOpen((o) => !o)}>
      <span className="tool-kind mono">{toolLabel(entry)}</span>
      <span className="tool-title mono">{entry.title}</span>
      {failed && <span className="tool-exit mono">FAILED</span>}
      <span className="spacer" />
      {running && <span className="tool-meta mono" style={{ color: 'var(--yellow)' }}>running…</span>}
      {hasDetail && <span className="tool-meta mono">{open ? 'collapse ▾' : 'expand ▸'}</span>}
    </div>
  )

  return (
    <div className="msg msg-tool">
      <span
        className={`msg-dot msg-dot-sm ${running ? 'dot-pulse' : ''}`}
        style={{ background: dotColor }}
      />
      {hasDetail && open ? (
        <div className="tool-card">
          {head}
          <ToolDetail detail={entry.detail!} kind={entry.toolKind} />
        </div>
      ) : (
        <div className="tool-row">{head}</div>
      )}
    </div>
  )
}

/** Expanded tool output. Diff-looking lines get the +/− tinted treatment. */
function ToolDetail({ detail, kind }: { detail: string; kind?: string }) {
  const lines = detail.replace(/\n+$/, '').split('\n')
  const isDiff = kind === 'edit' || lines.some((l) => /^[+-](?![+-])/.test(l))
  if (!isDiff) return <pre className="tool-out mono">{detail}</pre>
  return (
    <div className="tool-diff mono">
      {lines.map((line, i) => {
        const cls = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : ''
        return (
          <div key={i} className={`diffline ${cls}`}>
            {line || ' '}
          </div>
        )
      })}
    </div>
  )
}

function PermissionMsg({
  entry,
  sessionId
}: {
  entry: ChatPermission & { id: number }
  sessionId: string
}) {
  const pending = !entry.chosen
  return (
    <div className="msg">
      <span
        className={`msg-dot ${pending ? 'dot-pulse' : ''}`}
        style={{ background: pending ? 'var(--yellow)' : 'var(--border2)' }}
      />
      <div className={`perm-card ${pending ? '' : 'settled'}`}>
        <div className="perm-head">
          <Icon name="lock" size={14} style={{ color: 'var(--yellow)', flex: 'none' }} />
          <span className="perm-title">{entry.title}</span>
        </div>
        <div className="perm-foot">
          {entry.chosen ? (
            <span className="perm-chosen mono">
              → {entry.options.find((o) => o.optionId === entry.chosen)?.name ?? entry.chosen}
              {entry.chosen === 'auto' ? ' (auto)' : ''}
            </span>
          ) : (
            entry.options.map((o) => (
              <button
                key={o.optionId}
                className={o.kind?.startsWith('allow') ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
                onClick={() =>
                  window.gurt.sessionPermission(sessionId, entry.id, o.optionId).catch(console.error)
                }
              >
                {o.name}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

// ---- pinned plan bar (bottom) ----

function PlanPinned({ plan }: { plan: PlanEntry[] }) {
  const [open, setOpen] = useState(false)
  const done = plan.filter((p) => p.status === 'completed').length
  const current = plan.find((p) => p.status === 'in_progress') ?? plan.find((p) => p.status !== 'completed')
  return (
    <div className="plan-pin">
      <div className="plan-pin-bar" onClick={() => setOpen((o) => !o)}>
        <span className="seclabel">{open ? '▾' : '▸'} PLAN</span>
        <span className="plan-count mono">
          {done} / {plan.length}
        </span>
        {!open && current && <span className="plan-current">◪ {current.content}</span>}
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
              <span className="pm mono">
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

// ---- composer ----

const MAX_TA_HEIGHT = 220

/** Trailing-slash-tolerant basename, also handling `git:` pseudo-paths. */
const basename = (p: string): string => {
  if (p.startsWith('git:')) return p
  const cleaned = p.replace(/\/+$/, '')
  return cleaned.split('/').pop() || cleaned || p
}

const chipIcon = (path: string): 'branch' | 'folder' | 'file' =>
  path.startsWith('git:') ? 'branch' : path.endsWith('/') ? 'folder' : 'file'

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
  flush,
  modes,
  commands,
  configOptions,
  promptCaps
}: {
  sessionId: string
  busy: boolean
  /** No plan bar above — the composer sits flush against the feed. */
  flush: boolean
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
  const [gearOpen, setGearOpen] = useState(false)
  const [cmdQuery, setCmdQuery] = useState('')
  const [cmdIdx, setCmdIdx] = useState(0)
  /** null → the add-context item list; 'file'/'folder' → an inline path input. */
  const [addKind, setAddKind] = useState<'file' | 'folder' | null>(null)
  const [addPath, setAddPath] = useState('')
  const [micOn, setMicOn] = useState(false)
  /** Last dictation failure, shown inline so the mic never fails silently (#audio). */
  const [micError, setMicError] = useState<string | null>(null)
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

  // Close every popup on an outside click or Esc. The textarea/slash input
  // handle their own Esc; this document listener covers the rest (e.g. focus
  // left on the button that opened the menu).
  useEffect(() => {
    if (!slashOpen && !addOpen && !gearOpen) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) closeMenus()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenus()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [slashOpen, addOpen, gearOpen])

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
    setGearOpen(false)
    setAddKind(null)
    setAddPath('')
  }

  const openSlash = (open: boolean) => {
    setAddOpen(false)
    setGearOpen(false)
    setSlashOpen(open)
    setCmdQuery('')
    setCmdIdx(0)
    if (open) setTimeout(() => cmdRef.current?.focus(), 0)
  }

  const openAdd = (open: boolean) => {
    setSlashOpen(false)
    setGearOpen(false)
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

  /** Read image files into attachment chips (shared by the picker and paste). */
  const addImageFiles = async (files: File[]) => {
    const added: PromptImage[] = []
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue
      try {
        added.push({ name: f.name || 'pasted image', mimeType: f.type, data: await fileToBase64(f) })
      } catch (e) {
        console.error(e)
      }
    }
    if (added.length) setImages((imgs) => [...imgs, ...added])
  }

  const pickImages = async (files: FileList | null) => {
    openAdd(false)
    if (files?.length) await addImageFiles(Array.from(files))
    setTimeout(() => taRef.current?.focus(), 0)
  }

  /** Paste an image straight into the composer (gated on the agent accepting images). */
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!promptCaps?.image) return
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f != null)
    if (files.length) {
      e.preventDefault()
      void addImageFiles(files)
    }
  }

  const removeImage = (i: number) => setImages((imgs) => imgs.filter((_, j) => j !== i))

  const pickCommand = (name: string) => {
    setText(`/${name} `)
    closeMenus()
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
    if (!SR) {
      setMicError('dictation is not available in this build')
      return
    }
    if (recogRef.current) {
      recogRef.current.stop()
      return
    }
    setMicError(null)
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
    r.onerror = (e: SpeechErrorEvent) => {
      recogRef.current = null
      setMicOn(false)
      setMicError(speechErrorMessage(e?.error))
    }
    try {
      r.start()
      recogRef.current = r
      setMicOn(true)
    } catch (e) {
      recogRef.current = null
      setMicOn(false)
      setMicError(e instanceof Error ? e.message : 'could not start dictation')
    }
  }

  const canSend = !busy && (text.trim().length > 0 || images.length > 0)
  const hasGearContent =
    (!!modes && modes.availableModes.length > 0) || configOptions.length > 0 || commands.length > 0

  return (
    <div className={`composer-wrap ${flush ? 'flush' : ''}`}>
      <div ref={rootRef} className={`composer ${busy ? 'disabled' : ''} ${focused && !busy ? 'focused' : ''}`}>
        {showSlash && (
          <div className="cmp-menu slash-menu">
            <div className="slash-filter-row">
              <Icon name="search" size={13} className="faint" />
              <input
                ref={cmdRef}
                className="cmp-input"
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
                    className={`menu-item ${i === cmdIdx ? 'active' : ''}`}
                    onMouseEnter={() => setCmdIdx(i)}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      pickCommand(c.name)
                    }}
                  >
                    <span className="cmd-name mono">/{c.name}</span>
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
                <div className="cmp-menu-head seclabel">ADD CONTEXT</div>
                <div
                  className="menu-item"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    setAddKind('file')
                  }}
                >
                  <Icon name="file" size={14} className="code" />
                  <span>File…</span>
                </div>
                <div
                  className="menu-item"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    setAddKind('folder')
                  }}
                >
                  <Icon name="folder" size={14} className="code" />
                  <span>Folder…</span>
                </div>
                <div
                  className="menu-item"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    addChip({ name: 'git diff', path: 'git:diff' })
                  }}
                >
                  <Icon name="branch" size={14} className="code" />
                  <span>Git diff</span>
                </div>
                {promptCaps?.image && (
                  <div
                    className="menu-item"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      imgRef.current?.click()
                    }}
                  >
                    <Icon name="image" size={14} className="code" />
                    <span>Image…</span>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="cmp-menu-head seclabel">
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

        {gearOpen && (
          <GearPopup
            sessionId={sessionId}
            modes={modes}
            configOptions={configOptions}
            commands={commands}
            onPickCommand={pickCommand}
          />
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

        <div className="composer-top">
          <textarea
            ref={taRef}
            rows={1}
            className="composer-input"
            placeholder={busy ? 'agent is working…' : 'Ask gurt to change your code…'}
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
            onPaste={onPaste}
          />
          <button
            className={`mic-btn ${micOn ? 'on' : ''}`}
            title={micOn ? 'Stop dictation' : 'Dictate'}
            disabled={busy}
            onClick={toggleMic}
          >
            <Icon name="mic" size={14} />
          </button>
        </div>

        <div className="composer-bar">
          <button
            className={`icon-sq ${addOpen ? 'active' : ''}`}
            title="Add context"
            disabled={busy}
            onClick={() => openAdd(!addOpen)}
          >
            <Icon name="plus" size={14} />
          </button>
          <button
            className={`icon-sq ${showSlash ? 'active' : ''}`}
            title="Commands"
            disabled={busy || commands.length === 0}
            onClick={() => openSlash(!slashOpen)}
          >
            <Icon name="slash" size={14} />
          </button>
          {chips.map((c, i) => (
            <button
              key={`${c.path}-${i}`}
              className="icon-sq att"
              title={`${c.name} — click to remove`}
              onClick={() => removeChip(i)}
            >
              <Icon name={chipIcon(c.path)} size={13} />
            </button>
          ))}
          {images.map((img, i) => (
            <button
              key={`img-${img.name}-${i}`}
              className="icon-sq att"
              title={`${img.name} — click to remove`}
              onClick={() => removeImage(i)}
            >
              <Icon name="image" size={13} />
            </button>
          ))}
          <span className="spacer" />
          {hasGearContent && (
            <button
              className={`icon-sq ${gearOpen ? 'active' : ''}`}
              title="Session settings"
              onClick={() => {
                setSlashOpen(false)
                setAddOpen(false)
                setGearOpen((o) => !o)
              }}
            >
              <Icon name="gear" size={14} />
            </button>
          )}
          <button className="send-btn" disabled={!canSend} onClick={send} title="Send">
            <Icon name="send" size={12} />
            send
          </button>
        </div>
      </div>
      {micError && (
        <div className="composer-mic-error" onClick={() => setMicError(null)} title="dismiss">
          {micError}
        </div>
      )}
    </div>
  )
}

/** ⚙ popup (#1b): model / effort / mode chip groups + quick commands. */
function GearPopup({
  sessionId,
  modes,
  configOptions,
  commands,
  onPickCommand
}: {
  sessionId: string
  modes?: SessionModes
  configOptions: SessionConfigOption[]
  commands: CommandInfo[]
  onPickCommand: (name: string) => void
}) {
  const setMode = (id: string) =>
    window.gurt.sessionSetMode(sessionId, id).catch((e) => alertDialog(String(e)))
  const setConfig = (opt: SessionConfigOption, value: string | boolean) =>
    window.gurt.sessionSetConfigOption(sessionId, opt.id, value).catch((e) => alertDialog(String(e)))

  // The agent may surface Mode as a config option too; the dedicated mode group
  // already renders it, so drop the duplicate control.
  const cfg = configOptions.filter((o) => o.category !== 'mode')
  const sectionTitle = (o: SessionConfigOption) =>
    o.category === 'model' ? 'MODEL' : o.category === 'thought_level' ? 'EFFORT' : o.name.toUpperCase()

  return (
    <div className="cmp-menu gear-pop">
      <div className="gear-groups">
        {cfg.map((opt) =>
          opt.type === 'select' ? (
            <div key={opt.id} className="gear-group">
              <div className="seclabel">{sectionTitle(opt)}</div>
              <div className="chip-row">
                {(opt.options ?? []).map((o) => (
                  <button
                    key={o.value}
                    className={`chip-btn ${o.value === opt.currentValue ? 'on' : ''}`}
                    title={o.description ?? undefined}
                    onClick={() => setConfig(opt, o.value)}
                  >
                    {o.name}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div key={opt.id} className="gear-group">
              <div className="seclabel">{sectionTitle(opt)}</div>
              <div className="chip-row">
                <button
                  className={`chip-btn ${opt.currentValue === true ? 'on' : ''}`}
                  onClick={() => setConfig(opt, true)}
                >
                  on
                </button>
                <button
                  className={`chip-btn ${opt.currentValue === false ? 'on' : ''}`}
                  onClick={() => setConfig(opt, false)}
                >
                  off
                </button>
              </div>
            </div>
          )
        )}
        {modes && modes.availableModes.length > 0 && (
          <div className="gear-group">
            <div className="seclabel">MODE</div>
            <div className="chip-row">
              {modes.availableModes
                .filter((m) => !isBlanketMode(m))
                .map((m) => (
                  <button
                    key={m.id}
                    className={`chip-btn ${m.id === modes.currentModeId ? 'on' : ''}`}
                    onClick={() => setMode(m.id)}
                  >
                    {m.name}
                  </button>
                ))}
            </div>
          </div>
        )}
      </div>
      {commands.length > 0 && (
        <div className="gear-cmds">
          <div className="seclabel">QUICK COMMANDS</div>
          <div className="gear-cmd-list">
            {commands.map((c) => (
              <div
                key={c.name}
                className="menu-item"
                onMouseDown={(e) => {
                  e.preventDefault()
                  onPickCommand(c.name)
                }}
              >
                <span className="cmd-name mono code">/{c.name}</span>
                {c.description && <span className="cmd-desc right">{c.description}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// Minimal typings for the Web Speech API (not in the DOM lib we target).
interface SpeechResultEvent {
  resultIndex: number
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>
}
interface SpeechErrorEvent {
  error?: string
}
interface SpeechRecognitionLike {
  interimResults: boolean
  continuous: boolean
  onresult: (e: SpeechResultEvent) => void
  onend: () => void
  onerror: (e: SpeechErrorEvent) => void
  start: () => void
  stop: () => void
}

/** Turn a Web Speech API error code into a legible, actionable message. */
function speechErrorMessage(code?: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'microphone blocked — allow mic access for gurt in your system settings'
    case 'no-speech':
      return 'no speech detected — try again'
    case 'audio-capture':
      return 'no microphone found'
    case 'network':
      // In Electron this usually means the build ships no speech backend
      // (missing service API key), not that the machine is offline.
      return 'could not reach the speech service — dictation may not be supported in this build'
    default:
      return `dictation error: ${code ?? 'unknown'}`
  }
}
