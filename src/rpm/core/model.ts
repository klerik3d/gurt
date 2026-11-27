// RPM — the model and the journal (requirements: t3v2 §2, §3.2, §9, §10.2;
// t1v6 §1–6). Types only, plus the defaults: the logic over them (move, fold,
// next, view, the texts) lives next to this file and is exported through
// ./index.ts.
//
// Pure TypeScript: no Node, no DOM. rpm/main, rpm/ui, src/shared (type-only)
// and the tests import it — always through src/rpm/core/index.ts.

import type { ZodType } from 'zod'

// --- findings -------------------------------------------------------------------

export type Severity = 'blocker' | 'major' | 'minor' | 'nit'

export type FindingState =
  | 'open' | 'must' | 'defer'             // the executor's move
  | 'fixed' | 'contested' | 'documented'  // the reviewer's move
  | 'disputed' | 'cant'                   // your move
  | 'closed' | 'rejected' | 'deferred'    // final

export type Actor = 'you' | 'rpm' | 'executor' | 'reviewer' | 'check'

/** Whose move a finding waits for; `none` = final. */
export type Owner = 'you' | 'executor' | 'reviewer' | 'none'

export interface Finding {
  /** F1, F2… numbered through the run. */
  id: string
  /** Current severity; the original one is in the history. */
  severity: Severity
  /** `<repo>/<path>` */
  file?: string
  line?: number
  claim: string
  scenario: string
  state: FindingState
  /** Where a refusal sends the finding back to. */
  back: 'open' | 'must'
  attempts: number
  /** Review number R<n> the finding was raised in. */
  raisedIn: number
}

/** A finding as the reviewer submits it — RPM assigns the id. */
export interface NewFinding {
  severity: Severity
  file?: string
  line?: number
  claim: string
  scenario: string
}

/** The executor's answers (`reply_findings`). */
export type ReplyAct = 'fixed' | 'contested' | 'cant' | 'documented'

/** A move on a finding (t1v6 §1–2): the executor's act, the reviewer's yes/no, your verdict. */
export type Act =
  | ReplyAct                                // executor
  | { verify: boolean }                     // reviewer: yes / no
  | { verdict: 'must' | 'reject' | 'defer' } // you

// --- config ---------------------------------------------------------------------

export interface RpmConfig {
  enabled: boolean
  /** Client + its OptionBlock values. `agent: ''` = not chosen yet: the UI
   *  offers a client other than the executor's (t2v3 A). */
  reviewer: { agent: string; options: Record<string, string | boolean> }
  /** Default 'major'. */
  threshold: Severity
  /** 1..5, default 2. */
  attempts: number
  /** 1|2|3|5|10, default 3 — reviews before you are called. */
  reviews: number
}

/** The defaults of every new session — nothing is inherited (t3v2 §6.1). */
export const DEFAULT_CONFIG: RpmConfig = {
  enabled: false,
  reviewer: { agent: '', options: {} },
  threshold: 'major',
  attempts: 2,
  reviews: 3
}

/** Red checks in a row before you are called (rule 3б). Not a setting. */
export const CHECK_RED_LIMIT = 3

// --- trees, check, files ----------------------------------------------------------

/** One write repo's working tree: HEAD and `git write-tree` of a temporary index. */
export interface RepoTree {
  repo: string
  head: string
  tree: string
}

/** sha256 of RepoTree[] sorted by repo. */
export type TreeId = string

export interface FileChange {
  path: string
  status: 'A' | 'M' | 'D' | 'R'
}

export interface CheckRun {
  repo: string
  command: string
  code: number
  ms: number
  tail: string[]
  timedOut?: boolean
}

// --- the journal -------------------------------------------------------------------

export type TurnOutcome = 'changes' | 'no_changes' | 'blocked' | 'incomplete' | 'failed' | 'cancelled'

/** A classified executor/reviewer turn (t3v2 §4.1). A port type: rpm/main re-exports it from ports.ts;
 *  it lives here so src/shared can import it without the node-side rpm/main (task 8). */
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

export type CallReason =
  | 'findings' | 'idle-executor' | 'budget' | 'check-unchanged' | 'check-red'
  | 'executor-failed' | 'executor-blocked' | 'reviewer-failed' | 'check-error'

/** Why a step produced no result. */
export type FailReason = 'reviewer-failed' | 'reviewer-gone' | 'check-error' | 'interrupted'

/** The "what next" rule (t1v6 §4) that started a step. */
export type RuleId = '2' | '3в' | '6' | '9' | 'rerun'

export type StepWhat = 'check' | 'review' | 'executor'

export type RpmCommand = 'pause' | 'resume' | 'stop' | 'rerun-check' | 'rerun-review'

export type EndReason = 'stopped' | 'disabled' | 'deleted' | 'archived'

export type VerdictTo = 'must' | 'reject' | 'defer'

/** What a turn ran on, as its session reported it when the turn settled: the
 *  client (agent instance id) and the names of its model and effort. */
export interface RanOn {
  agent: string
  model?: string
  effort?: string
}

/** The body of each journal entry, by kind. */
export type EntryBody =
  | {
      kind: 'start'
      /** Not in t3v2 §2.1: the journal names its own executor and run so that
       *  fold/view need nothing but the entries (rpm-contract-changes.md, task 2). */
      executor: string
      run: number
      turnId: string
      base: { repo: string; commit: string }[]
      config: RpmConfig
    } // by rpm
  | {
      kind: 'step'
      step: number
      what: StepWhat
      rule: RuleId
      tree: TreeId
      full?: boolean
      items?: string[]
      /** `<executor>:<run>:<step>` — idempotent in every port. */
      key: string
      session?: string
    } // by rpm, BEFORE the effect
  | { kind: 'check'; step: number; tree: TreeId; ok: boolean; runs: CheckRun[] } // by check; tree = after the check
  | {
      kind: 'review'
      step: number
      tree: TreeId
      full: boolean
      findings: (NewFinding & { id: string })[]
      verify: { id: string; accept: boolean; comment: string }[]
      /** The reviewer's client, model and effort. */
      ran?: RanOn
    } // by reviewer
  | {
      kind: 'turn'
      /** No step = a turn you started, not RPM (t3v2 §6.3). */
      step?: number
      turnId: string
      origin: 'rpm' | 'user'
      tree: TreeId
      outcome: TurnOutcome
      reason?: string
      replies: { id: string; act: ReplyAct; comment: string }[]
      /** The executor's client, model and effort. */
      ran?: RanOn
    } // by executor
  | { kind: 'fail'; step: number; reason: FailReason; detail: string } // by rpm: the step gave no result
  | { kind: 'verdict'; id: string; to: VerdictTo } // by you
  | { kind: 'severity'; id: string; to: Severity } // by you
  | { kind: 'note'; text: string } // by you, to the executor on its turn
  | { kind: 'config'; patch: Partial<RpmConfig> } // by you
  | { kind: 'command'; cmd: RpmCommand } // by you
  | { kind: 'call'; why: CallReason } // by rpm: you are called
  | { kind: 'mark'; mark: ReviewMark } // by rpm: the end, passed
  | { kind: 'end'; why: EndReason } // by rpm: the end, not passed

export interface EntryHead {
  seq: number
  at: string
  by: Actor
  comment?: string
}

/** One line of `runs/<n>.jsonl`. */
export type Entry = EntryHead & EntryBody

export type EntryKind = Entry['kind']
export type EntryOf<K extends EntryKind> = Extract<Entry, { kind: K }>

/** An entry before the journal stamps `seq` and `at`. */
export type NewEntry = { by: Actor; comment?: string } & EntryBody

// --- the fold and "what next" ---------------------------------------------------------

/** What `next` needs beyond the fold: the tree now and the check commands now. */
export interface Facts {
  tree: TreeId
  /** From RepoConfig.check of the executor's write repos, now. */
  checks: { repo: string; command: string }[]
}

export type Next =
  | { do: 'wait'; why: 'paused' | 'called' | 'step-running' }
  | { do: 'check' }
  | { do: 'fix-check' }                                // 3в
  | { do: 'call'; why: CallReason }                    // 3а, 3б, 4, 5, 8
  | { do: 'review'; full: boolean; verify: string[] }  // 6
  | { do: 'mark' }                                     // 7
  | { do: 'executor'; items: string[] }                // 9

/** The step in progress (a `step` entry without a result yet). */
export interface RunningStep {
  step: number
  what: StepWhat
  key: string
  session?: string
  items?: string[]
  full?: boolean
  /** The tree when the step began (task 3: rule 5 compares the executor's turn with it). */
  tree: TreeId
  /** Task 9: true for a `rerun` step, so a restart that interrupts it asks for the rerun again. */
  rerun?: true
}

/** The fold of one run's journal — internal to RPM. Task 3 may add fields,
 *  never rename them. */
export interface RunState {
  executor: string
  run: number
  base: { repo: string; commit: string }[]
  /** The current config: the start snapshot with every `config` patch applied. */
  config: RpmConfig
  findings: Finding[]
  step?: RunningStep
  lastStep: number
  paused: boolean
  called?: CallReason
  ended?: 'passed' | EndReason
  lastCheck?: { tree: TreeId; ok: boolean; commands: { repo: string; command: string }[]; step: number; seq: number }
  /** n = review number R<n>. */
  lastReview?: { tree: TreeId; n: number }
  /** Reviews in the whole run. */
  reviews: number
  /** Counters since your last entry (rules 3а, 3б, 5, 8). */
  sinceYou: { reviews: number; redChecks: number }
  /** replies = how many replies the turn carried. */
  lastTurn?: {
    tree: TreeId
    replies: number
    step?: number
    seq: number
    /** Tree when the RPM step of this turn began; none for your turns. */
    before?: TreeId
    /** The step carried only findings below the threshold: doing nothing on
     *  them is not idle (rule 5). */
    optional?: true
  }
  /** Notes waiting for the executor's next RPM message. */
  pendingNotes: string[]
  rerun?: 'check' | 'review'
  /** seq of entries that were not allowed and changed nothing (or, for a
   *  review/turn, carried at least one move that was not allowed). */
  ignored: number[]
  // --- added by task 3 -----------------------------------------------------------
  /** Each move that was not allowed: the entry and the finding. */
  ignoredMoves: { seq: number; id: string }[]
  /** Ids of findings that have your verdict — tracked whatever the threshold. */
  decided: string[]
  /** seq of your last entry (`by: 'you'` but not `config`, or `turn { origin: 'user' }`); 0 = none yet. */
  lastYou: number
  /** The last step gave no usable result (a `fail`, a failed/blocked RPM turn):
   *  `next` calls you with this reason. Cleared by your entry or the next step. */
  failed?: CallReason
  /** Findings that were stuck with you (disputed/cant) and that your verdict
   *  sent back to the executor (must/defer), not yet carried by an executor
   *  step: rule 6 waits for them (t1v6 §1 "остальные ждут", §7 run в). */
  fresh: string[]
  /** Findings an executor step has carried at least once. A finding below the
   *  threshold that no step carried yet gets one step of its own before the
   *  mark (rule 7); after that it never holds the run (t1v6 §4). */
  sent: string[]
  // --- added by task 4 -----------------------------------------------------------
  /** Per finding id: every transition and severity change with its comment
   *  (t3v2 §10.1). `chat` is not filled by the fold. The texts for the models
   *  take only `RunState`, and they show this history. */
  history: Record<string, HistoryItem[]>
}

// --- what the models see ----------------------------------------------------------------

/** Input of `reviewerPrompt(run, input)` beyond the fold (t4v1 task 4). Not
 *  spelled out in t3v2 — added by task 2. */
export interface ReviewerInput {
  /** What the user typed to the executor: the task. */
  task: string[]
  /** base → now, per write repo. */
  diffs: { repo: string; text: string; truncated: boolean; files: FileChange[] }[]
  /** The last check, or none configured. */
  check: { ok: boolean; runs: CheckRun[] } | 'not-configured'
  /** Items to verify. */
  verify: string[]
  full: boolean
}

export type RpmToolName = 'submit_review' | 'reply_findings'

/** A model tool as gurtServer registers it; task 4 builds them (`rpmToolSchemas`). */
export interface RpmToolDef {
  name: RpmToolName
  description: string
  schema: ZodType
}

// --- the view (IPC) ------------------------------------------------------------------------

export interface ChatRef {
  sessionId: string
  entryId: number
}

export interface HistoryItem {
  seq: number
  at: string
  by: Actor
  review?: number
  from?: FindingState
  to?: FindingState
  severity?: { from: Severity; to: Severity }
  comment?: string
  ignored?: true
  chat?: ChatRef
}

export type RpmFinding = Finding & { tracked: boolean; owner: Owner; history: HistoryItem[] }

export type RunStatus = (
  | { phase: 'check'; repos: string[] }
  | { phase: 'fix-check'; try: number; of: typeof CHECK_RED_LIMIT }
  | { phase: 'review'; review: number; full: boolean; items: number; session: string; waitingPlan?: string }
  | { phase: 'executor'; items: number }
  | { phase: 'called'; why: CallReason; items: string[] }
  | { phase: 'paused' }
  | { phase: 'passed'; files: number }
  | { phase: 'ended'; why: EndReason }
) & { reviewsSinceYou: number; lastCheck?: { ok: boolean; redStreak: number } }

export interface RpmState {
  executor: string
  run: number
  live: boolean
  status: RunStatus
  config: RpmConfig
  findings: RpmFinding[]
  counts: { you: number; executor: number; reviewer: number; final: number; below: number; all: number }
  journal: Entry[]
  mark?: ReviewMark
}

export interface RunSummary {
  run: number
  startedAt: string
  result: 'live' | 'passed' | 'ended'
  findings: number
  reviews: number
}

// --- the review mark (t3v2 §9) --------------------------------------------------------------

export interface ReviewMark {
  executor: string
  run: number
  at: string
  tree: TreeId
  /** Changes base → the marked tree. */
  repos: { repo: string; base: string; head: string; tree: string; files: FileChange[] }[]
  reviews: number
  findings: { closed: number; rejected: number; deferred: number; below: number }
}

// --- the handoff line in chat (t3v2 §10.2) -----------------------------------------------------

export interface RpmChatLine {
  executor: string
  run: number
  /** The journal entry the line comes from. */
  seq: number
  from: 'reviewer' | 'executor' | 'you' | 'check' | 'rpm'
  /** R<n> for the reviewer. */
  review?: number
  to: 'executor' | 'reviewer' | 'you' | 'gurt'
  /** «F1 fixed», «F2 contested», «F7 can't» */
  items: { id: string; label: string }[]
  /** «+2 below threshold», «new F8» */
  more?: string
  /** The full text the agent received (▾). */
  text?: string
  kind: 'handoff' | 'check-red' | 'passed' | 'note-queued'
}
