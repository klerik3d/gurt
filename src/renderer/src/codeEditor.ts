import { basicSetup } from 'codemirror'
import { EditorView } from '@codemirror/view'
import { LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark'

const editorTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--app)', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', fontSize: '12px', lineHeight: '1.65' },
  '.cm-content': { caretColor: 'var(--text)', padding: '10px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '.cm-gutters': { backgroundColor: 'var(--app)', color: 'var(--faint)', borderRight: '1px solid var(--border)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--surface)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: '#31527680' },
  '.cm-panels, .cm-tooltip': { backgroundColor: 'var(--panel)', color: 'var(--text)', borderColor: 'var(--border2)' },
  '.cm-searchMatch': { backgroundColor: '#e0a02040' },
  '.cm-searchMatch-selected': { backgroundColor: '#4da3ff60' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--hover)', color: 'var(--dim)', borderColor: 'var(--border)' }
}, { dark: true })

export const codeEditorSetup = [basicSetup, editorTheme, syntaxHighlighting(oneDarkHighlightStyle)]

export function codeLanguage(path: string) {
  const filename = path.split('/').at(-1) ?? ''
  return LanguageDescription.matchFilename(languages, filename) ??
    (/\.json[cl]$/.test(filename) ? LanguageDescription.matchLanguageName(languages, 'JSON') : null)
}
