// The session manager and the pure rules around it (see docs/architecture.md).
// What this file lists is the module's public surface: consumers import it
// through `src/main/sessions.ts`.
export { SessionManager } from './manager'
export { adapterExitCode, isDefaultSessionTitle, limitBackoffMs, LIMIT_CONTINUE_PROMPT } from './pure'
export { desiredModeId, nextModeId, normalizeModes } from './modes'
export {
  assertProposalFits,
  contractToolFor,
  nudgePromptFor,
  NUDGE_PROMPT,
  PROACTIVE_NUDGE_PROMPT,
  postTurnDecision,
  proposalForRepo
} from './turnContract'
export type {
  CreateAction,
  DraftInheritance,
  PostTurnAction,
  PreparedDraft,
  RestoredSession,
  SessionEvents,
  WatcherHooks
} from './types'
