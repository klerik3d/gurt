import type { ContainerStatus, SessionFlow, SessionStatus } from '../../shared/types'

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
 *   blue    — waiting its turn in the queue (a held-back review too)
 *   yellow  — attention: blinking while the ground is still being prepared,
 *             solid when the thing is stuck on a human; an idle executor
 *             blinks it too while its check or review runs (FLOW_DOT)
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

/** An idle executor whose RPM run is working around it — never a ring: it is
 *  not settled, it is going to come back. */
export const FLOW_DOT: Record<SessionFlow, DotSpec> = {
  check: { tone: 'yellow', pulse: true, label: 'checking — gurt is running the check' },
  review: { tone: 'yellow', pulse: true, label: 'review in progress' },
  queued: { tone: 'accent', label: 'review queued — waiting for the plan limit' }
}

/** A session's mark: its status; an idle one with a run going on shows that instead. */
export function sessionDot(status: SessionStatus, flow?: SessionFlow): DotSpec {
  if (flow && (status === 'idle' || status === 'idle-read')) return FLOW_DOT[flow]
  return SESSION_DOT[status]
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
