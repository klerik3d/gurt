import { useEffect, useRef, useState } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { codeEditorSetup, codeLanguage } from '../codeEditor'
import type { FilesController, FileTab } from '../useFiles'
import { fileKey } from '../../../shared/files'
import { logErr } from '../log'

const handlers = new Compartment()
const language = new Compartment()

export function FileEditor({ tab, controller, onView, onNavigate }: {
  tab: FileTab
  controller: FilesController
  onView: (view: EditorView | null) => void
  onNavigate: (kind: 'definition' | 'references', position?: number) => void
}) {
  const parent = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const latest = useRef({ tab, controller, onView, onNavigate })
  latest.current = { tab, controller, onView, onNavigate }
  const [status, setStatus] = useState({ line: 1, column: 1, language: 'Plain text' })
  const key = fileKey(tab.file)
  const generation = tab.generation

  useEffect(() => {
    if (!parent.current) return
    const { tab: current, controller: files } = latest.current
    const memory = files.editors.current.get(key)
    const callbacks = [
      keymap.of([
        { key: 'Mod-s', run: () => { void latest.current.controller.save(key); return true } },
        { key: 'Mod-w', run: () => { void latest.current.controller.close(key); return true } },
        { key: 'F12', run: () => { latest.current.onNavigate('definition'); return true } },
        { key: 'Shift-F12', run: () => { latest.current.onNavigate('references'); return true } },
        indentWithTab
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) latest.current.controller.patch(key, { content: update.state.sliceDoc() })
        if (update.selectionSet || update.docChanged) {
          const pos = update.state.selection.main.head
          const line = update.state.doc.lineAt(pos)
          setStatus((prev) => ({ ...prev, line: line.number, column: pos - line.from + 1 }))
        }
      }),
      EditorView.domEventHandlers({ mousedown: (event, view) => {
        if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return false
        const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (position === null) return false
        event.preventDefault()
        view.dispatch({ selection: { anchor: position } })
        latest.current.onNavigate('definition', position)
        return true
      } })
    ]
    const state = memory?.generation === generation
      ? memory.state.update({ effects: handlers.reconfigure(callbacks) }).state
      : EditorState.create({
          doc: current.content,
          extensions: [
            handlers.of(callbacks), codeEditorSetup,
            language.of([]), EditorView.contentAttributes.of({ 'aria-label': `Edit ${current.file.path}` }),
            ...(/\r\n/.test(current.content) && !/(?<!\r)\n/.test(current.content) ? [EditorState.lineSeparator.of('\r\n')] : [])
          ]
        })
    const view = new EditorView({ state, parent: parent.current })
    viewRef.current = view
    latest.current.onView(view)
    if (memory?.generation === generation) { view.scrollDOM.scrollTop = memory.top; view.scrollDOM.scrollLeft = memory.left }
    const pos = view.state.selection.main.head
    const line = view.state.doc.lineAt(pos)
    const description = codeLanguage(current.file.path)
    setStatus({ line: line.number, column: pos - line.from + 1, language: description?.name ?? 'Plain text' })
    let disposed = false
    if (description) description.load().then((support) => {
      if (!disposed) view.dispatch({ effects: language.reconfigure(support) })
    }).catch(logErr('file-language'))
    if (document.activeElement?.getAttribute('role') !== 'tab') view.focus()
    return () => {
      disposed = true
      files.editors.current.set(key, { state: view.state, top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft, generation })
      latest.current.onView(null)
      viewRef.current = null
      view.destroy()
    }
  }, [key, generation])

  const jump = controller.jump
  const consumeJump = controller.consumeJump
  useEffect(() => {
    const view = viewRef.current
    if (!view || !jump || jump.key !== key) return
    // Navigation returns UTF-16 offsets in the original buffer. CodeMirror
    // represents CRLF as one character internally.
    const offset = (raw: number) => Math.min(view.state.doc.length, latest.current.tab.content.slice(0, raw).replace(/\r\n/g, '\n').length)
    const from = offset(jump.from)
    view.dispatch({ selection: { anchor: from, head: offset(jump.to) }, effects: EditorView.scrollIntoView(from, { y: 'center' }) })
    view.focus()
    consumeJump(jump.seq)
  }, [jump, key, generation, consumeJump])

  return <>
    <div className="file-editor code-editor" ref={parent} />
    <div className="file-statusbar"><span>Ln {status.line}, Col {status.column}</span><span>{tab.content.includes('\r\n') ? 'CRLF' : 'LF'}</span><span>UTF-8</span><span>{status.language}</span></div>
  </>
}
