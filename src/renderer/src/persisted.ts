import { useCallback, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { z } from 'zod'

/** Only UI preferences belong here: never credentials, prompts or live state. */
export function readPreference<T>(key: string, fallback: T, schema: z.ZodType<T>): T {
  try {
    const result = schema.safeParse(JSON.parse(localStorage.getItem(`gurt.ui.${key}`) ?? 'null'))
    return result.success ? result.data : fallback
  } catch {
    return fallback
  }
}

export function usePreference<T>(key: string, fallback: T, schema: z.ZodType<T>): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState(() => readPreference(key, fallback, schema))
  const update = useCallback<Dispatch<SetStateAction<T>>>((action) => {
    setValue((previous) => {
      const next = typeof action === 'function' ? (action as (v: T) => T)(previous) : action
      try { localStorage.setItem(`gurt.ui.${key}`, JSON.stringify(next)) } catch { /* Keep working without storage. */ }
      return next
    })
  }, [key])
  return [value, update]
}

export const selectionSchema = z.union([
  z.object({ type: z.literal('session'), id: z.string() }),
  z.object({ type: z.literal('task'), ws: z.string(), task: z.string() })
]).nullable()
export const diffFileSchema = z.object({ ws: z.string(), task: z.string(), repo: z.string(), path: z.string() }).nullable()
export { z }
