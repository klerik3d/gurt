import { useCallback, useEffect, useRef, useState } from 'react'
import type { EditorState } from '@codemirror/state'
import type { FileLocation, ScopeFile } from '../../shared/files'
import { fileKey } from '../../shared/files'
import { confirmDialog } from './dialog'
import { readPreference, usePreference, z } from './persisted'

const fileSchema = z.object({ ws: z.string(), task: z.string(), path: z.string() })
const scopeKey = (file: { ws: string; task: string }): string => JSON.stringify([file.ws, file.task])

export interface FileTab {
  file: ScopeFile
  content: string
  saved: string
  version: string
  loading: boolean
  saving: boolean
  error: string
  generation: number
}

export interface EditorMemory {
  state: EditorState
  top: number
  left: number
  generation: number
}

export const isDirty = (tab: FileTab): boolean => tab.content !== tab.saved
const emptyTab = (file: ScopeFile): FileTab => ({ file, content: '', saved: '', version: '', loading: true, saving: false, error: '', generation: 0 })
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Buffers and editor history outlive mode, workspace and scope switches. Only
 * file identities are persisted — source code never goes into localStorage. */
export function useFiles(scope: { ws: string; task: string } | null, onSaved: (ws: string, task: string) => void) {
  const [tabs, setTabs] = useState<FileTab[]>(() => readPreference('fileTabs', [], z.array(fileSchema)).map(emptyTab))
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const [active, setActive] = usePreference('activeFiles', {}, z.record(z.string(), z.string()))
  const [jump, setJump] = useState<{ key: string; from: number; to: number; seq: number } | null>(null)
  const editors = useRef(new Map<string, EditorMemory>())
  const loading = useRef(new Map<string, symbol>())
  const closing = useRef(new Set<string>())
  const mutate = useCallback((fn: (previous: FileTab[]) => FileTab[]) => {
    const next = fn(tabsRef.current)
    tabsRef.current = next
    setTabs(next)
  }, [])
  const patch = useCallback((key: string, change: Partial<FileTab>) => {
    mutate((prev) => prev.map((tab) => fileKey(tab.file) === key ? { ...tab, ...change } : tab))
  }, [mutate])

  const load = useCallback(async (file: ScopeFile) => {
    const key = fileKey(file)
    const token = Symbol()
    loading.current.set(key, token)
    patch(key, { loading: true, error: '' })
    try {
      const doc = await window.gurt.readTaskFile(file.ws, file.task, file.path)
      if (loading.current.get(key) !== token) return
      editors.current.delete(key)
      mutate((prev) => prev.map((tab) => fileKey(tab.file) === key ? {
        ...tab, content: doc.content, saved: doc.content, version: doc.version, error: '', loading: false, generation: tab.generation + 1
      } : tab))
    } catch (error) {
      if (loading.current.get(key) === token) patch(key, { loading: false, error: message(error) })
    } finally { if (loading.current.get(key) === token) loading.current.delete(key) }
  }, [mutate, patch])

  useEffect(() => {
    for (const tab of tabs) if (tab.loading && !loading.current.has(fileKey(tab.file))) void load(tab.file)
    const keys = new Set(tabs.map((tab) => fileKey(tab.file)))
    for (const key of editors.current.keys()) if (!keys.has(key)) editors.current.delete(key)
    try { localStorage.setItem('gurt.ui.fileTabs', JSON.stringify(tabs.map((t) => t.file))) } catch { /* Optional storage. */ }
  }, [tabs, load])

  const open = useCallback((file: ScopeFile, location?: Pick<FileLocation, 'from' | 'to'>) => {
    const key = fileKey(file)
    mutate((prev) => prev.some((t) => fileKey(t.file) === key) ? prev : [...prev, emptyTab(file)])
    setActive((prev) => ({ ...prev, [scopeKey(file)]: key }))
    if (location) setJump({ key, from: location.from, to: location.to, seq: Date.now() + Math.random() })
  }, [mutate, setActive])
  const consumeJump = useCallback((seq: number) => {
    setJump((previous) => previous?.seq === seq ? null : previous)
  }, [])

  const close = useCallback(async (key: string) => {
    const tab = tabsRef.current.find((t) => fileKey(t.file) === key)
    if (!tab || tab.saving || closing.current.has(key)) return
    closing.current.add(key)
    try {
      if (isDirty(tab) && !await confirmDialog(`Discard unsaved changes in ${tab.file.path}?`, {
        title: 'Close file', confirmText: 'Discard changes', cancelText: 'Keep editing', danger: true
      })) return
      loading.current.delete(key)
      editors.current.delete(key)
      const siblings = tabsRef.current.filter((t) => scopeKey(t.file) === scopeKey(tab.file))
      const index = siblings.findIndex((t) => fileKey(t.file) === key)
      const neighbor = siblings[index + 1] ?? siblings[index - 1]
      setActive((prev) => prev[scopeKey(tab.file)] === key ? { ...prev, [scopeKey(tab.file)]: neighbor ? fileKey(neighbor.file) : '' } : prev)
      mutate((prev) => prev.filter((t) => fileKey(t.file) !== key))
    } finally { closing.current.delete(key) }
  }, [mutate, setActive])

  const save = useCallback(async (key: string) => {
    const tab = tabsRef.current.find((t) => fileKey(t.file) === key)
    if (!tab || tab.loading || tab.saving || !tab.version || !isDirty(tab)) return
    patch(key, { saving: true, error: '' })
    try {
      const saved = await window.gurt.writeTaskFile(tab.file.ws, tab.file.task, tab.file.path, tab.content, tab.version)
      // Further edits while saving remain dirty against the content just saved.
      patch(key, { saved: saved.content, version: saved.version, saving: false })
      onSaved(tab.file.ws, tab.file.task)
    } catch (error) { patch(key, { saving: false, error: message(error) }) }
  }, [patch, onSaved])

  const reload = useCallback(async (key: string) => {
    const tab = tabsRef.current.find((t) => fileKey(t.file) === key)
    if (!tab || tab.saving || tab.loading) return
    if (isDirty(tab) && !await confirmDialog(`Reload ${tab.file.path} from disk and discard your unsaved changes?`, {
      title: 'Reload file', confirmText: 'Reload', cancelText: 'Keep editing', danger: true
    })) return
    await load(tab.file)
  }, [load])

  // Refresh clean buffers when returning from an agent or another application.
  // Dirty buffers keep their version so Save can detect concurrent changes.
  const refresh = useCallback(async (key: string) => {
    const tab = tabsRef.current.find((t) => fileKey(t.file) === key)
    if (!tab || tab.loading || tab.saving || !tab.version || isDirty(tab)) return
    try {
      const doc = await window.gurt.readTaskFile(tab.file.ws, tab.file.task, tab.file.path)
      const current = tabsRef.current.find((t) => fileKey(t.file) === key)
      if (!current || current.version !== tab.version || current.loading || current.saving || isDirty(current) || current.version === doc.version) return
      editors.current.delete(key)
      patch(key, { content: doc.content, saved: doc.content, version: doc.version, error: '', generation: current.generation + 1 })
    } catch (error) { patch(key, { error: message(error) }) }
  }, [patch])

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (tabsRef.current.some((tab) => isDirty(tab) || tab.saving)) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [])

  const movePath = (file: ScopeFile, destination?: string) => {
    const matches = (other: ScopeFile) => other.ws === file.ws && other.task === file.task && (other.path === file.path || other.path.startsWith(file.path + '/'))
    setActive((prev) => {
      const next = { ...prev }
      for (const tab of tabsRef.current.filter((t) => matches(t.file))) {
        const key = fileKey(tab.file)
        if (next[scopeKey(tab.file)] === key) next[scopeKey(tab.file)] = destination ? fileKey({ ...tab.file, path: destination + tab.file.path.slice(file.path.length) }) : ''
        loading.current.delete(key)
        const memory = editors.current.get(key)
        if (memory && destination) editors.current.set(fileKey({ ...tab.file, path: destination + tab.file.path.slice(file.path.length) }), memory)
      }
      return next
    })
    mutate((prev) => prev.flatMap((tab) => !matches(tab.file) ? [tab] : destination ? [{ ...tab, file: { ...tab.file, path: destination + tab.file.path.slice(file.path.length) } }] : []))
  }

  const scoped = scope ? tabs.filter((t) => t.file.ws === scope.ws && t.file.task === scope.task) : []
  const activeTab = scoped.find((t) => fileKey(t.file) === (scope ? active[scopeKey(scope)] : '')) ?? scoped.at(-1)
  return { movePath, tabs, scoped, activeTab, open, close, save, reload, refresh, patch, jump, consumeJump, editors }
}

export type FilesController = ReturnType<typeof useFiles>
