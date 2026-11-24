import {
  roleIsManagerOwned,
  sessionRole,
  type PendingPromptInfo,
  type SessionInfo,
  type SessionRole
} from '../../shared/types'
import type { Claim, PendingPrompt } from './types'

/** A signal-killed child reports `code: null`; keep the exit code non-zero and
 *  shell-conventional (128 + signum) so "it died" is never read as "it exited
 *  cleanly" — `kill -9` on an adapter must show up as 137 in `agent.exit` and
 *  `session.end`, not as a missing field. Unlisted signals fall back to 128.
 *  Pure and unit-tested (scripts/turn-contract.test.mjs). */
const SIGNUM: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGABRT: 6,
  SIGKILL: 9,
  SIGSEGV: 11,
  SIGTERM: 15
}
export const adapterExitCode = (code: number | null, signal: NodeJS.Signals | null): number =>
  code ?? (signal ? 128 + (SIGNUM[signal] ?? 0) : -1)

/** What an interrupted session sends once its limit resets. */
export const LIMIT_CONTINUE_PROMPT = 'continue'

/**
 * How long to wait when a limit hit named no reset and no window explains it:
 * 15 minutes, doubling with each consecutive hit, capped at the 5-hour window
 * itself — so a hold that keeps being wrong never turns into a tight loop of
 * refused "continue"s.
 */
export function limitBackoffMs(strikes: number): number {
  return Math.min(5 * 60 * 60_000, 15 * 60_000 * 2 ** Math.max(0, strikes - 1))
}

/** Readers–writer per clone: two claim sets collide on a clone they share
 *  when at least one of the two claims is exclusive. */
export const claimsCollide = (a: readonly Claim[], b: readonly Claim[]): boolean =>
  a.some((x) => b.some((y) => x.key === y.key && (x.exclusive || y.exclusive)))

/** The wire form of a queued prompt: everything but the images, which stay
 *  here (see {@link PendingPromptInfo}). */
export const pendingInfo = (p: PendingPrompt): PendingPromptInfo => ({
  id: p.id,
  text: p.text,
  ...(p.queuedAt ? { queuedAt: p.queuedAt } : {}),
  ...(p.context?.length ? { context: p.context } : {}),
  ...(p.images?.length ? { images: p.images.length } : {}),
  ...(p.auto ? { auto: true } : {})
})

/** A tool call that will not change status again. */
export const isTerminalToolStatus = (status: string | null | undefined): boolean =>
  status === 'completed' || status === 'failed'

/** True when `title` is still the auto-generated default for `role` — the
 *  bare role name, or role name + index — rather than something the user
 *  typed themselves. Used to decide whether a role change should carry the
 *  title along with it. */
export function isDefaultSessionTitle(title: string, role: SessionRole): boolean {
  return title === role || new RegExp(`^${role} \\d+$`).test(title)
}

/** A proactive agent's template never runs itself — every run is a copy of it
 *  (docs/design-proactive-agents.md §2). Checked at every entrance a start
 *  can come through. */
export function assertNotTemplate(info: SessionInfo): void {
  if (info.template)
    throw new Error("this is a proactive agent's template — it never runs itself; use the agent's Run now")
}

/** Only its manager creates a watcher, so nothing copies it. */
export function assertNotManagerOwned(info: SessionInfo): void {
  if (roleIsManagerOwned(sessionRole(info)))
    throw new Error('this is a watcher — only the Watchers mode creates one, so it cannot be duplicated or recreated')
}

/** Bound on ACP control-plane calls (initialize, session/new, session/load,
 *  set_config_option): they answer in seconds when the adapter is healthy, and
 *  a hung one would otherwise pin the session in `starting` forever. Never
 *  applied to `session/prompt` — a turn takes as long as it takes. */
export const ACP_REQUEST_TIMEOUT_MS = 60_000
