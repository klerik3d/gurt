import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { TerminalInfo, TerminalOutput } from '../../../shared/terminal'
import { bindingMatchesEvent } from '../../../shared/hotkeys'
import { useHotkeys } from '../useHotkeys'
import { Icon } from './icons'
import { logErr } from '../log'

const scopeKey = (ws: string, task: string) => JSON.stringify([ws, task])

/** Always mounted: hiding a scope must preserve xterm's screen, scroll position,
 * selection and partially typed input, as well as the main process's shell. */
function TerminalSession({ info, visible }: { info: TerminalInfo; visible: boolean }) {
  const container = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const fit = useRef<() => void>(() => {})
  const hotkeys = useHotkeys()
  const hotkeysRef = useRef(hotkeys)
  hotkeysRef.current = hotkeys
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const host = container.current!
    let disposed = false
    let attached = false
    let sequence = 0
    const pending: TerminalOutput[] = []
    const term = new Terminal({
      cols: 80, rows: 24, cursorBlink: true, scrollback: 10000,
      fontFamily: "'IBM Plex Mono', ui-monospace, Menlo, monospace",
      fontSize: 12,
      theme: { background: '#100f0d', foreground: '#eae8e4', cursor: '#eae8e4',
        selectionBackground: '#3f3c35', black: '#100f0d', brightBlack: '#726e66',
        red: '#e5544b', green: '#6cc47f', yellow: '#e0a020', blue: '#4da3ff',
        magenta: '#c792ea', cyan: '#4ec9b0', white: '#eae8e4' }
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(host)
    terminal.current = term
    // Leave application shortcuts to App, including when xterm owns focus.
    term.attachCustomKeyEventHandler((event) =>
      !Object.values(hotkeysRef.current).some((binding) => bindingMatchesEvent(binding, event))
    )
    const fail = (e: unknown) => {
      if (!disposed) setError(e instanceof Error ? e.message : String(e))
    }
    const apply = (event: TerminalOutput) => {
      if (event.sequence <= sequence) return
      sequence = event.sequence
      term.write(event.data)
    }
    const off = window.gurt.onTerminalOutput((event) => {
      if (event.id !== info.id) return
      if (!attached) pending.push(event)
      else apply(event)
    })
    const input = term.onData((data) => {
      if (attached) void window.gurt.terminalWrite(info.id, data).catch(fail)
    })
    const resize = term.onResize(({ cols, rows }) => {
      if (attached) void window.gurt.terminalResize(info.id, cols, rows).catch(fail)
    })
    fit.current = () => {
      if (attached && host.clientWidth > 0 && host.clientHeight > 0) fitAddon.fit()
    }
    const observer = new ResizeObserver(() => fit.current())
    observer.observe(host)
    // Subscribe before fetching the replay; sequence numbers avoid both a gap
    // and duplicate output when an event races the snapshot response.
    void window.gurt.terminalSnapshot(info.id).then((snapshot) => {
      if (disposed) return
      term.resize(snapshot.info.cols, snapshot.info.rows)
      sequence = snapshot.sequence
      // PTY output was produced at the snapshot's dimensions. Parse it at
      // that size before fitting the panel, otherwise wrapping and cursor
      // movements in the first prompt use the wrong width.
      const finishReplay = () => {
        if (disposed) return
        const batch = pending.splice(0).filter((event) => event.sequence > sequence)
        const last = batch.at(-1)
        if (last) {
          sequence = last.sequence
          term.write(batch.map((event) => event.data).join(''), finishReplay)
          return
        }
        attached = true
        fit.current()
        setReady(true)
      }
      term.write(snapshot.data, finishReplay)
    }).catch(fail)
    void document.fonts.ready.then(() => { if (!disposed) fit.current() })
    return () => {
      disposed = true
      observer.disconnect()
      off()
      input.dispose()
      resize.dispose()
      terminal.current = null
      fit.current = () => {}
      term.dispose()
    }
  }, [info.id])

  useEffect(() => {
    if (visible && ready) {
      fit.current()
      terminal.current?.focus()
    }
  }, [visible, ready])

  return (
    <div className="terminal-session" hidden={!visible}>
      <div className="terminal-screen" ref={container} />
      {info.exitCode !== null && <div className="terminal-status">Shell exited ({info.exitCode})</div>}
      {error && <div className="terminal-status error" role="alert">{error}</div>}
    </div>
  )
}

function TerminalTab({ info, active, onSelect, onError }: {
  info: TerminalInfo
  active: boolean
  onSelect: () => void
  onError: (message: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(info.title)
  const finished = useRef(false)
  const button = useRef<HTMLButtonElement>(null)
  const startRename = () => {
    finished.current = false
    setName(info.title)
    setEditing(true)
  }
  const finish = (save: boolean, refocus: boolean) => {
    if (finished.current) return
    finished.current = true
    setEditing(false)
    const title = name.trim()
    if (save && title && title !== info.title)
      void window.gurt.terminalRename(info.id, title).catch((e: unknown) =>
        onError(e instanceof Error ? e.message : String(e)))
    if (refocus) requestAnimationFrame(() => button.current?.focus())
  }
  useEffect(() => {
    if (active) button.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])
  return (
    <div className={`terminal-tab ${active ? 'active' : ''}`}>
      <button ref={button} className="terminal-tab-label" role="tab" aria-selected={active}
        hidden={editing} title={`${info.title} · Double-click or press F2 to rename`}
        onClick={onSelect} onDoubleClick={startRename}
        onKeyDown={(e) => {
          if (e.key === 'F2') { e.preventDefault(); startRename() }
        }}>
        {info.title}
      </button>
      {editing && <input autoFocus className="terminal-rename" aria-label="Terminal name"
        value={name} maxLength={80} onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setName(e.target.value)} onBlur={() => finish(true, false)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') { e.preventDefault(); finish(true, true) }
          else if (e.key === 'Escape') { e.preventDefault(); finish(false, true) }
        }} />}
      {info.exitCode !== null && <span className="terminal-exited" title={`Shell exited (${info.exitCode})`} aria-label="Exited" />}
      <button className="terminal-tab-close" title="Close terminal" aria-label={`Close ${info.title}`}
        onClick={() => {
          void window.gurt.terminalClose(info.id).catch((e: unknown) =>
            onError(e instanceof Error ? e.message : String(e)))
        }}>
        <Icon name="x" size={12} />
      </button>
    </div>
  )
}

export function TerminalSidebar({
  visible, scope, onHide
}: {
  visible: boolean
  scope: { ws: string; task: string } | null
  onHide: () => void
}) {
  const [sessions, setSessions] = useState<TerminalInfo[]>([])
  const [active, setActive] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [opening, setOpening] = useState(false)
  const [width, setWidth] = useState(420)
  const sidebar = useRef<HTMLElement>(null)
  const dragCleanup = useRef<() => void>(() => {})
  const ws = scope?.ws
  const task = scope?.task
  const key = ws && task ? scopeKey(ws, task) : ''
  const scoped = sessions.filter((s) => s.workspace === ws && s.task === task)
  const selected = scoped.find((s) => s.id === active[key]) ?? scoped.at(-1)

  useEffect(() => {
    let changed = false
    const off = window.gurt.onTerminalChanged((list) => {
      changed = true
      setSessions(list)
      setActive((prev) => {
        const next: Record<string, string> = {}
        for (const id of Object.values(prev)) {
          const session = list.find((s) => s.id === id)
          if (session) next[scopeKey(session.workspace, session.task)] = id
        }
        return next
      })
    })
    void window.gurt.terminalList().then((list) => {
      if (!changed) setSessions(list)
    }).catch(logErr('terminalList'))
    return () => { changed = true; off(); dragCleanup.current() }
  }, [])

  useEffect(() => {
    if (!visible || !ws || !task) return
    let cancelled = false
    setError('')
    setOpening(true)
    void window.gurt.terminalEnsure(ws, task).then((session) => {
      if (!cancelled)
        setActive((prev) => ({ ...prev, [key]: prev[key] ?? session.id }))
    }).catch((e: unknown) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e))
    }).finally(() => { if (!cancelled) setOpening(false) })
    return () => { cancelled = true }
  }, [visible, ws, task, key])

  const create = () => {
    if (!ws || !task) return
    setError('')
    setOpening(true)
    void window.gurt.terminalCreate(ws, task).then((session) => {
      setActive((prev) => ({ ...prev, [key]: session.id }))
    }).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e))
    }).finally(() => setOpening(false))
  }

  const startResize = useCallback((event: ReactMouseEvent) => {
    event.preventDefault()
    dragCleanup.current()
    const right = sidebar.current!.getBoundingClientRect().right
    const move = (e: MouseEvent) => setWidth(Math.max(260, Math.min(900, right - e.clientX)))
    const stop = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', stop)
      window.removeEventListener('blur', stop)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    dragCleanup.current = stop
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', stop)
    window.addEventListener('blur', stop)
  }, [])

  return (
    <>
      {visible && <div className="sidebar-resizer" onMouseDown={startResize} />}
      <aside className="terminal-sidebar" hidden={!visible} style={{ width }} ref={sidebar} aria-label="Terminal">
        <div className="terminal-header">
          <span className="terminal-icon" title={scope ? `${scope.ws}/${scope.task}` : 'Terminal'}>
            <Icon name="terminal" size={15} />
          </span>
          {scoped.length ? (
            <div className="terminal-tabs" role="tablist" aria-label="Terminal sessions">
              {scoped.map((session) => (
                <TerminalTab key={session.id} info={session} active={selected?.id === session.id}
                  onSelect={() => setActive((prev) => ({ ...prev, [key]: session.id }))}
                  onError={setError} />
              ))}
            </div>
          ) : <span className="terminal-heading">Terminal</span>}
          <div className="terminal-actions">
            <button title="New terminal" aria-label="New terminal" disabled={!scope || opening} onClick={create}>
              <Icon name="plus" size={15} />
            </button>
            <button title="Hide terminal" aria-label="Hide terminal" onClick={onHide}><Icon name="x" size={15} /></button>
          </div>
        </div>
        {error && <div className="terminal-status error" role="alert">{error}</div>}
        {!selected && <div className="terminal-empty">
          {!scope ? 'Select a scope to open its terminal.' : opening ? 'Opening terminal…' :
            <button onClick={create}>Open terminal</button>}
        </div>}
        {sessions.map((session) => (
          <TerminalSession key={session.id} info={session}
            visible={visible && selected?.id === session.id} />
        ))}
      </aside>
    </>
  )
}
