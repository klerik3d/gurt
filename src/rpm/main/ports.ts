// What RPM requires from the app (t3v2 §4). Interfaces only: the adapters live
// in src/main/rpmPorts/ and kernel.ts assembles them. RPM never imports app
// code — everything it knows about sessions, git, containers and
// notifications comes through here.
import type { SessionRole } from '../../shared/types'
import type { CheckRun, FileChange, RepoTree, RpmChatLine, TurnOutcome } from '../core'

export interface RpmPorts {
  sessions: SessionsPort
  git: GitPort
  check: CheckPort
  notify: NotifyPort
  store: StorePort
}

// --- §4.1 SessionsPort — the session manager -------------------------------------

export interface SessionFacts {
  id: string
  ws: string
  task: string
  title: string
  role: SessionRole
  agent: string
  writeRepos: string[]
  state: 'draft' | 'queued' | 'starting' | 'started'
  /** The session's account sits on a plan limit until then (ISO). */
  planHoldUntil?: string
}

export interface SettledTurn {
  sessionId: string
  /** `<sessionId>:<n>`, numbers are never reused. */
  turnId: string
  origin: 'user' | 'rpm' | 'other'
  /** When the turn was started by a `send` message. */
  key?: string
  /** limited: the turn was cut by a plan limit and will continue by itself — not a boundary. */
  outcome: TurnOutcome | 'limited'
  /** blocked: the reason from `complete`. */
  reason?: string
  /** Accepted RPM tool calls of the turn, in order (§5). */
  tools: { name: string; payload: unknown }[]
}

export interface SessionsPort {
  info(id: string): SessionFacts | undefined
  /** What the user typed to this session after turn `afterTurnId` (or from the start): the reviewer's task. */
  userPrompts(id: string, afterTurnId?: string): string[]
  /** The write repos' snapshot before the user message that started this turn (checkpoint): a commit per repo.
   *  No snapshot — undefined. */
  checkpointBefore(id: string, turnId: string): { repo: string; commit: string }[] | undefined

  /** A logical turn (prompt + its nudge) ended and is classified. Written to disk first (`lastSettled`),
   *  then delivered. Only for executors and reviewers. */
  onSettled(fn: (t: SettledTurn) => void): () => void
  /** The last classified turn: on load RPM replays a turn it did not get to record. */
  lastSettled(id: string): SettledTurn | undefined
  onDeleted(fn: (id: string) => void): () => void
  /** A draft was copied (Duplicate/Recreate): RPM copies the config. */
  onCopied(fn: (from: string, to: string) => void): () => void

  /** A host message to the executor. Queued like a typed one, not a user action.
   *  Shows in chat as `line`. Idempotent by key. */
  send(id: string, m: { key: string; text: string; line: RpmChatLine }): Promise<void>
  /** Where the message with this key is: queued, taken into a turn (it may have reached the agent), or unknown. */
  sent(id: string, key: string): 'queued' | 'taken' | 'unknown'
  /** Cancel the running turn. The host does it, not the user. */
  cancelTurn(id: string): Promise<void>
  /** Create and start a reviewer at once. Idempotent by key: a second call returns the same id. */
  createReviewer(r: {
    key: string
    executor: string
    agent: string
    options: Record<string, string | boolean>
    title: string
    prompt: string
    line: RpmChatLine
  }): Promise<string>
  /** Stop the session's container; the session stays (a reviewer after its turn). */
  stopContainer(id: string): Promise<void>
  /** Keep the executor's write clones held by it, even while its container is stopped. */
  hold(executor: string): void
  release(executor: string): void
  /** Keep the container alive (a step is running) or let it go to the usual idle. */
  keepAlive(executor: string, on: boolean): void
  /** RPM's service line in the session's chat; written to its log. Returns the entry id. */
  chatLine(id: string, line: RpmChatLine): number | undefined
}

// --- §4.2 GitPort, CheckPort, NotifyPort, StorePort -------------------------------

export interface GitPort {
  trees(ws: string, task: string, repos: string[]): Promise<RepoTree[]>
  /** Diff of the working tree (untracked files included) against the base commit. Cut to maxChars per repo. */
  diff(
    ws: string,
    task: string,
    repo: string,
    base: string,
    maxChars: number
  ): Promise<{ text: string; truncated: boolean; files: FileChange[] }>
}

export interface CheckPort {
  /** Login shell in the executor's container, cwd /workspaces/<repo>, tail ring 60 lines / 8 KB, timeout 20 min.
   *  This is the existing CheckRunner. */
  run(executor: string, repo: string, command: string): { done: Promise<CheckRun>; stop(): Promise<{ ok: boolean; detail?: string }> }
  /** The repos' check commands now (RepoConfig.check). */
  commands(ws: string, repos: string[]): { repo: string; command: string }[]
}

export interface NotifyPort {
  notify(n: { sessionId: string; kind: 'called' | 'passed'; text: string; open: { finding?: string; filter?: 'you' } }): void
}

export interface StorePort {
  /** The scope's RPM directory: `<gurtRoot>/<ws>/<task>/rpm`. Renaming and archiving the scope move it. */
  dir(ws: string, task: string): string
}
