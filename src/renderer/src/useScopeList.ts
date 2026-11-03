import { useMemo, useState } from 'react'

export type TaskSortKey = 'name' | 'created'
export type TaskSortDir = 'asc' | 'desc'
export interface TaskSort {
  key: TaskSortKey
  dir: TaskSortDir
}

const TASK_SORT_KEY = 'gurt.sidebar.taskSort'
const DEFAULT_SORT: TaskSort = { key: 'name', dir: 'asc' }
export const SORT_KEY_LABEL: Record<TaskSortKey, string> = { name: 'Name', created: 'Created' }
export const SORT_DIR_LABEL: Record<TaskSortKey, Record<TaskSortDir, string>> = {
  name: { asc: 'A → Z', desc: 'Z → A' },
  created: { asc: 'Oldest first', desc: 'Newest first' }
}

const byName = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0)

/** Shared by rendering and keyboard navigation in all scope panels. */
export function sortTasks<T extends { name: string; createdAt?: string }>(tasks: readonly T[], sort: TaskSort): T[] {
  const cmp = sort.key === 'name'
    ? (a: T, b: T) => byName(a.name, b.name)
    : (a: T, b: T) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || byName(a.name, b.name)
  const out = [...tasks].sort(cmp)
  return sort.dir === 'desc' ? out.reverse() : out
}

export function scopeFilter(query: string): { pattern: RegExp | null; error: string } {
  try {
    return { pattern: query ? new RegExp(query, 'i') : null, error: '' }
  } catch {
    return { pattern: null, error: 'Invalid regular expression' }
  }
}

/** App owns the controller so filters and sorting survive panel switches. */
export function useScopeList() {
  const [sort, updateSort] = useState<TaskSort>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(TASK_SORT_KEY) ?? 'null') as Partial<TaskSort> | null
      if ((raw?.key === 'name' || raw?.key === 'created') && (raw.dir === 'asc' || raw.dir === 'desc'))
        return { key: raw.key, dir: raw.dir }
    } catch { /* Fall back to the default order. */ }
    return DEFAULT_SORT
  })
  const setSort = (next: TaskSort) => {
    updateSort(next)
    try { localStorage.setItem(TASK_SORT_KEY, JSON.stringify(next)) } catch { /* Keep sorting without storage. */ }
  }
  const [query, setQuery] = useState('')
  const filter = useMemo(() => scopeFilter(query), [query])
  return { sort, setSort, query, setQuery, ...filter }
}

export type ScopeListController = ReturnType<typeof useScopeList>
