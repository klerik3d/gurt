// "Open this session's chat at this entry" — asked from elsewhere (the Review
// tab's history links, rpm/ui `openChat`), carried out by that session's Chat
// once it is mounted and the entry is rendered.
import { useSyncExternalStore } from 'react'

export interface ChatJump {
  sessionId: string
  entryId: number
  /** Distinguishes two jumps to the same entry. */
  n: number
}

let pending: ChatJump | undefined
let n = 0
const listeners = new Set<() => void>()
const notify = (): void => listeners.forEach((fn) => fn())

export function requestChatJump(sessionId: string, entryId: number): void {
  pending = { sessionId, entryId, n: ++n }
  notify()
}

/** The jump done (or given up): it is not repeated on the next render. */
export function clearChatJump(jump: ChatJump): void {
  if (pending?.n !== jump.n) return
  pending = undefined
  notify()
}

/** The jump waiting for this session, if any. */
export function useChatJump(sessionId: string): ChatJump | undefined {
  const jump = useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => pending
  )
  return jump?.sessionId === sessionId ? jump : undefined
}
