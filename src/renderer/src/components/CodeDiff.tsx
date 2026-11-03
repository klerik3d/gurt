import { useEffect, useRef } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { MergeView, unifiedMergeView } from '@codemirror/merge'
import { codeEditorSetup, codeLanguage } from '../codeEditor'
import { logErr } from '../log'

/** Git comparisons share the file editor's theme, languages and search. */
export function CodeDiff({ before, after, path, mode }: {
  before: string
  after: string
  path: string
  mode: 'split' | 'unified'
}) {
  const parent = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!parent.current) return
    const language = new Compartment()
    const extensions = (side: string) => [
      codeEditorSetup, language.of([]), EditorState.readOnly.of(true), EditorView.editable.of(false),
      EditorView.contentAttributes.of({ 'aria-label': `${side} ${path}`, tabindex: '0' })
    ]
    const collapseUnchanged = { margin: 3, minSize: 8 }
    const merge = mode === 'split' ? new MergeView({
      parent: parent.current,
      a: { doc: before, extensions: extensions('Before') },
      b: { doc: after, extensions: extensions('After') },
      collapseUnchanged
    }) : null
    const unified = mode === 'unified' ? new EditorView({
      parent: parent.current,
      doc: after,
      extensions: [extensions('Changes in'), unifiedMergeView({ original: before, mergeControls: false, collapseUnchanged })]
    }) : null
    let disposed = false
    const description = codeLanguage(path)
    if (description) description.load().then((support) => {
      if (disposed) return
      for (const view of merge ? [merge.a, merge.b] : unified ? [unified] : [])
        view.dispatch({ effects: language.reconfigure(support) })
    }).catch(logErr('diff-language'))
    return () => { disposed = true; merge?.destroy(); unified?.destroy() }
  }, [before, after, path, mode])

  return <div ref={parent} className={`code-editor code-diff code-diff-${mode}`} />
}
