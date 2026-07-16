import type { DomainEvents } from '../shared/events'

export interface Bus {
  emit<K extends keyof DomainEvents>(type: K, payload: DomainEvents[K]): void
  on<K extends keyof DomainEvents>(type: K, fn: (p: DomainEvents[K]) => void): () => void
}

type Handler = (p: never) => void

/**
 * Synchronous dispatch in subscription order. A throwing handler is caught and
 * logged; it never breaks the emitter or the other handlers.
 */
export function createBus(): Bus {
  const handlers = new Map<keyof DomainEvents, Set<Handler>>()
  return {
    emit(type, payload) {
      for (const fn of handlers.get(type) ?? []) {
        try {
          ;(fn as (p: DomainEvents[typeof type]) => void)(payload)
        } catch (e) {
          console.error(`bus: "${type}" handler failed:`, e)
        }
      }
    },
    on(type, fn) {
      let set = handlers.get(type)
      if (!set) handlers.set(type, (set = new Set()))
      set.add(fn as Handler)
      return () => set.delete(fn as Handler)
    }
  }
}
