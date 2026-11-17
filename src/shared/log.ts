// The app log's vocabulary, shared by main (which owns the file, the threshold
// and the validation of renderer records), preload (which mirrors main's
// threshold onto the bridge) and the renderer (which filters by it before
// sending). One definition, so the two sides of the IPC channel cannot drift
// apart without typecheck noticing. Imports nothing, so any layer may take it.

export type Level = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(msg: string, ctx?: object): void
  info(msg: string, ctx?: object): void
  warn(msg: string, ctx?: object): void
  error(msg: string, ctx?: object): void
}

/** Severity order: a record passes when its rank is >= the threshold's. */
export const LEVEL_RANK: Readonly<Record<Level, number>> = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 })

/** True for exactly the four level names — own keys only, so prototype
 *  property names (`constructor`, `__proto__`, …) arriving from an env var or
 *  over IPC are rejected. */
export const isLevel = (v: unknown): v is Level =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(LEVEL_RANK, v)
