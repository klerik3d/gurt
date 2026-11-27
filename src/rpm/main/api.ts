// RPM's public interface for the app (t3v2 §3.1, §4.3).
import type { SessionRole } from '../../shared/types'
import type { ReviewMark, RpmBrief, RpmCommand, RpmConfig, RpmState, RpmToolDef, RunSummary, Severity, VerdictTo } from '../core'
import type { RpmPorts } from './ports'
import { createRpmImpl } from './rpm'

/** Time, injectable for tests. */
export interface Clock {
  /** ms since epoch */
  now(): number
  /** Call `fn` every `ms` until the returned function is called (the reviewer's plan-limit poll). */
  every(ms: number, fn: () => void): () => void
}

/** What RPM gives mcp/gurtServer (§4.3, §5). */
export interface RpmTools {
  /** The tools for a role: definitions come from rpm/core, gurtServer only registers them. */
  for(role: SessionRole): RpmToolDef[]
  /** Check a call against the current state. Refusal — throw (isError with the text).
   *  Success — what the session manager puts into the turn (`SettledTurn.tools`), and the model's answer text. */
  call(sessionId: string, name: string, input: unknown): { payload: unknown; text: string }
  /** A paragraph for the session's instructions. */
  instructions(role: SessionRole): string | undefined
}

/** Errors are `throw Error` with a text for the user («прогон закончен», «нет такой находки»…). */
export interface Rpm {
  // lifecycle (kernel)
  /** Read every journal after sessions are restored, before the scheduler's first pass. */
  load(): Promise<void>
  /** §8.2 */
  recover(): Promise<void>
  start(): void
  stop(): void

  // for IPC (§3.2): every method takes the executor session's id
  runs(executor: string): RunSummary[]
  /** run omitted = the last one. */
  state(executor: string, run?: number): RpmState | undefined
  /** Works for a draft too. */
  config(executor: string): RpmConfig
  /** Every executor's switch and last-run status at once — the scope rows'
   *  review slot, without a `state` read per executor. */
  overview(): RpmBrief[]
  setConfig(executor: string, patch: Partial<RpmConfig>): Promise<void>
  verdict(executor: string, id: string, to: VerdictTo, comment?: string): Promise<void>
  severity(executor: string, id: string, to: Severity, comment?: string): Promise<void>
  note(executor: string, text: string): Promise<void>
  command(executor: string, cmd: RpmCommand): Promise<void>

  // for other parts of the app
  /** §5: the model tools' handlers. */
  tools: RpmTools
  /** An RPM reviewer, or an executor with a live run. */
  owns(sessionId: string): boolean
  /** Its usual proposal/turn-ended notifications stay quiet (§11). */
  quiets(sessionId: string): boolean
  /** Archiving refuses (§12). */
  stepRunning(ws: string, task: string): boolean
  /** For the Diff view now and DPM later. */
  marks(executor: string): ReviewMark[]
  /** The tree now matches the marked one. */
  markHolds(mark: ReviewMark): Promise<boolean>
  onChange(fn: (e: { executor: string; run: number }) => void): () => void
}

export function createRpm(ports: RpmPorts, opts?: { clock?: Clock }): Rpm {
  return createRpmImpl(ports, opts)
}
