import type { ContainerStatus, HostBusy, SessionStatus } from '../../shared/types'

export type Tone = 'green' | 'yellow' | 'red' | 'accent' | 'faint'

export interface DotSpec {
  tone: Tone
  pulse?: boolean
  /** Drawn as a ring instead of a disc — see the grammar below. */
  hollow?: boolean
  /** Human wording for tooltips and status text. */
  label: string
}

/**
 * One grammar for every status mark in the app, read on two axes.
 *
 * Colour says what the thing is doing:
 *   faint   — nothing is there yet, or it is over
 *   blue    — waiting its turn in the queue
 *   yellow  — attention: blinking while the ground is still being prepared
 *             or gurt itself is working on the thing (the review loop's
 *             automatic check), solid when the thing is stuck on a human
 *   green   — the thing itself is alive: blinking while it works, solid when
 *             it is done and usable
 *   red     — failed
 *
 * Fill says whether it still wants you:
 *   disc    — unhandled, look here
 *   ring    — settled: either nothing has happened yet, or you have seen it
 */
export const SESSION_DOT: Record<SessionStatus, DotSpec> = {
  draft: { tone: 'faint', hollow: true, label: 'draft' },
  queued: { tone: 'accent', label: 'queued' },
  starting: { tone: 'yellow', pulse: true, label: 'starting — container coming up' },
  running: { tone: 'green', pulse: true, label: 'working' },
  waiting: { tone: 'yellow', label: 'needs you' },
  idle: { tone: 'green', label: 'idle — turn ended' },
  'idle-read': { tone: 'green', hollow: true, label: 'idle — turn ended, seen' }
}

/** What gurt itself is doing on a session between its turns. */
export const HOST_DOT: Record<HostBusy, DotSpec> = {
  check: { tone: 'yellow', pulse: true, label: 'gurt is running the check' }
}

/** Whether gurt's own work is what a session is doing now: it is, and the
 *  session's turn has ended. Something that needs the user still wins over it. */
export function hostWorking(status: SessionStatus, hostBusy: HostBusy | undefined): hostBusy is HostBusy {
  return !!hostBusy && (status === 'idle' || status === 'idle-read')
}

/** A session's mark: its status, except that gurt's own work on a session whose
 *  turn has ended blinks the system's yellow ({@link hostWorking}). */
export function sessionDot(status: SessionStatus, hostBusy?: HostBusy): DotSpec {
  return hostWorking(status, hostBusy) ? HOST_DOT[hostBusy] : SESSION_DOT[status]
}

/** The same grammar one level down, over the session's own container. */
export const CONTAINER_DOT: Record<ContainerStatus, DotSpec> = {
  stopped: { tone: 'faint', hollow: true, label: 'stopped' },
  building: { tone: 'yellow', pulse: true, label: 'building image' },
  post: { tone: 'green', pulse: true, label: 'post-commands' },
  running: { tone: 'green', label: 'running' },
  error: { tone: 'red', label: 'error' }
}

/** Tolerates a status from an older record — those read as `stopped`. */
export const containerDot = (status: ContainerStatus): DotSpec =>
  CONTAINER_DOT[status] ?? CONTAINER_DOT.stopped
