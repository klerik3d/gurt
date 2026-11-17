import { basicSetup } from 'codemirror'
import { Compartment, type EditorState, type Extension, type StateEffect } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'
import { LanguageDescription, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark'
import { colorScheme, onColorSchemeChange, type ColorScheme } from './colorScheme'

// Colours come from the app palette's CSS variables, so this one theme fits
// both schemes; only CodeMirror's own light/dark flag (which picks its base
// styles for buttons, merge gutters, search matches…) and the syntax palette
// differ between them.
const editorTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--app)', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', fontSize: '12px', lineHeight: '1.65' },
  '.cm-content': { caretColor: 'var(--text)', padding: '10px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '.cm-gutters': { backgroundColor: 'var(--app)', color: 'var(--faint)', borderRight: '1px solid var(--border)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--surface)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection)' },
  '.cm-panels, .cm-tooltip': { backgroundColor: 'var(--panel)', color: 'var(--text)', borderColor: 'var(--border2)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--yellow) 25%, transparent)' },
  '.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--accent) 38%, transparent)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--hover)', color: 'var(--dim)', borderColor: 'var(--border)' }
})

/** Built once per scheme, so a state's compartment content can be compared
 *  by identity with what the scheme in effect wants. */
const SCHEME_EXTENSION: Record<ColorScheme, Extension> = {
  dark: [EditorView.darkTheme.of(true), syntaxHighlighting(oneDarkHighlightStyle)],
  light: [syntaxHighlighting(defaultHighlightStyle)]
}

/** One compartment shared by every editor — each state keeps its own content
 *  for it — swapped when the scheme flips, so an open file or diff recolours
 *  in place instead of waiting for a remount. */
const scheme = new Compartment()

/** The effect that brings `state` to the scheme in effect now — empty when
 *  it already is. For a cached `EditorState` brought back after an unmount:
 *  the scheme may have changed while no view was listening (Settings →
 *  Appearance itself unmounts the file editor). */
export function schemeRefresh(state: EditorState): StateEffect<unknown>[] {
  const want = SCHEME_EXTENSION[colorScheme()]
  return scheme.get(state) === want ? [] : [scheme.reconfigure(want)]
}

const followScheme = ViewPlugin.define((view) => {
  let live = true
  // A view built on a stale state (one a caller restored without
  // `schemeRefresh`) catches up right after construction — a plugin may not
  // dispatch from inside the update that creates it.
  if (schemeRefresh(view.state).length) {
    queueMicrotask(() => {
      const effects = live ? schemeRefresh(view.state) : []
      if (effects.length) view.dispatch({ effects })
    })
  }
  const off = onColorSchemeChange((next) => view.dispatch({ effects: scheme.reconfigure(SCHEME_EXTENSION[next]) }))
  return {
    destroy: () => {
      live = false
      off()
    }
  }
})

/** Built per editor: the scheme it starts in is the one in effect now. */
export function codeEditorSetup() {
  return [basicSetup, editorTheme, scheme.of(SCHEME_EXTENSION[colorScheme()]), followScheme]
}

export function codeLanguage(path: string) {
  const filename = path.split('/').at(-1) ?? ''
  return LanguageDescription.matchFilename(languages, filename) ??
    (/\.json[cl]$/.test(filename) ? LanguageDescription.matchLanguageName(languages, 'JSON') : null)
}
