import type { ContainerStatus, SessionStatus } from '../../shared/types'

export type Tone = 'green' | 'yellow' | 'red' | 'accent' | 'outline'

export interface DotSpec {
  tone: Tone
  pulse?: boolean
  /** Human wording for tooltips and status text. */
  label: string
}

/**
 * One grammar for every status mark in the app:
 *   hollow  — nothing is there yet
 *   blue    — waiting its turn in the queue
 *   yellow  — attention: blinking while the ground is still being prepared,
 *             solid when the thing is stuck on a human
 *   green   — the thing itself is alive: blinking while it works, solid when
 *             it is done and usable
 *   red     — failed
 */
export const SESSION_DOT: Record<SessionStatus, DotSpec> = {
  draft: { tone: 'outline', label: 'draft' },
  queued: { tone: 'accent', label: 'queued' },
  starting: { tone: 'yellow', pulse: true, label: 'starting — container coming up' },
  running: { tone: 'green', pulse: true, label: 'working' },
  waiting: { tone: 'yellow', label: 'needs you' },
  idle: { tone: 'green', label: 'idle — turn ended' }
}

/** The same grammar one level down, over the session's own container. */
export const CONTAINER_DOT: Record<ContainerStatus, DotSpec> = {
  stopped: { tone: 'outline', label: 'stopped' },
  building: { tone: 'yellow', pulse: true, label: 'building image' },
  post: { tone: 'green', pulse: true, label: 'post-commands' },
  running: { tone: 'green', label: 'running' },
  error: { tone: 'red', label: 'error' }
}

/** Tolerates a status from an older record — those read as `stopped`. */
export const containerDot = (status: ContainerStatus): DotSpec =>
  CONTAINER_DOT[status] ?? CONTAINER_DOT.stopped
