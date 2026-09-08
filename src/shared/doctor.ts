// The machine checklist and the first-run create
// (docs/requirements-first-run.md §3, §6), shared by main and renderer.
//
// Everything a cold machine has to be told before it is worth filling in five
// forms: is there a `docker` binary, is its daemon answering, are the images a
// first session needs already local. The report is computed on demand and
// never persisted — a cached answer to "why will nothing start" is worse than
// no answer, because the thing it describes changes while the app is open.

/**
 * A row's verdict, plus the two states it passes through on the way there.
 *
 * `pending` and `checking` are renderer-side only — main never returns them.
 * They exist because the checklist is watched, not read: the rows are known
 * before any probe runs (see {@link DOCTOR_ROWS}), so the screen can draw all
 * three the instant it mounts and then light them up one at a time, instead of
 * showing a placeholder until every probe has answered.
 */
export type DoctorState = 'pending' | 'checking' | 'ok' | 'warn' | 'fail'

/** Rows of the phase-1 checklist, in display order. */
export type DoctorRowId = 'docker-cli' | 'docker-daemon' | 'images'

/** The one action a row offers, beyond "re-check". `start-docker` is macOS
 *  only (§3.4: the Linux daemon is a system service and gurt does not sudo);
 *  main omits it there rather than offering a button that does nothing. */
export type DoctorAction = 'start-docker' | 'prepare'

export interface DoctorRow {
  id: DoctorRowId
  label: string
  state: DoctorState
  /** One line under the label: the resolved path, the daemon's version, the
   *  image refs — or the failure sentence. Never a stack trace. */
  detail: string
  /** A non-`ok` row here disables "Start operator" (§3.3). Only the two
   *  docker rows gate; a missing image is a pull the click does itself. */
  gates: boolean
  action?: DoctorAction
}

/**
 * The rows, their labels and what gates — known statically, because the
 * checklist always asks the same three questions in the same order. The
 * renderer draws this list before it has asked main anything, so the screen is
 * never a spinner over an empty box; main builds its answers on the same list,
 * so the two cannot disagree about what is being checked or in what order.
 */
export const DOCTOR_ROWS: readonly { id: DoctorRowId; label: string; gates: boolean }[] = [
  { id: 'docker-cli', label: 'Docker CLI', gates: true },
  { id: 'docker-daemon', label: 'Docker daemon', gates: true },
  { id: 'images', label: 'Images', gates: false }
]

/** The skeleton the renderer mounts with: every row, unasked. */
export const pendingRows = (): DoctorRow[] =>
  DOCTOR_ROWS.map((r) => ({ ...r, state: 'pending' as const, detail: '' }))

export interface DoctorReport {
  rows: DoctorRow[]
  /** Every gating row is `ok` — what the button reads. */
  ready: boolean
}

/** True when no gating row is failing. Exported so the renderer's disabled
 *  state and main's own checks cannot disagree about the rule. */
export const doctorReady = (rows: DoctorRow[]): boolean =>
  rows.every((r) => !r.gates || r.state === 'ok')

/** `provision.log` key the image pull streams under — the third non-session
 *  key, after a session id and `env-build:<ws>/<env>` (§5.3). It runs through
 *  `fileId` like the others, so the log lands at
 *  `~/.gurt/logs/session-machine-prepare.log`. */
export const PREPARE_LOG_KEY = 'machine:prepare'

/** Names the one-click create uses when it has to invent one (§6.2). Both are
 *  legal under `store.validateName` today; a future reservation must not take
 *  them without moving this. */
export const FIRST_RUN_WORKSPACE = 'default'
export const FIRST_RUN_TASK = 'setup'

/** What the auto-created operator session is asked first (§6.5). Fixed and
 *  shipped with the app so a test and the renderer read the same text. It says
 *  what the role can and cannot do on purpose: phase 1 of the operator surface
 *  is read-only, and a first turn that offers to fix things it cannot write
 *  would be a bad first impression twice over. */
export const FIRST_RUN_PROMPT = [
  "You are gurt's operator session for this machine.",
  'Introduce yourself in two sentences, then read this workspace’s configuration',
  'and tell me what it has and what it is missing before I can run a coding',
  'session: repositories, environments, MCP servers, credentials.',
  'You can read everything and change nothing yet — say what you would change',
  'and I will do it.'
].join(' ')

/** What a token probe concluded (§7.3). Three outcomes and no fourth: a
 *  provider that cannot be reached is not a provider that said no. */
export type TokenVerdict = 'ok' | 'rejected' | 'unreachable'

export interface TokenProbe {
  verdict: TokenVerdict
  /** Shown under the token field. Empty on `ok`. */
  detail: string
}

/** Result of the one-click create. `warning` carries an `unreachable` probe's
 *  sentence — the session was created anyway (§7.3: the probe runs on the
 *  host, and the container's route out is the session proxy's). */
export interface FirstRunResult {
  sessionId: string
  warning?: string
}

/**
 * When the welcome screen appears on its own (docs/requirements-first-run.md
 * §2.1). Three states rather than a boolean, because two of them answer
 * questions a boolean cannot:
 *
 *   - `auto`   — the default: while the store has never produced a session.
 *   - `always` — every launch, whatever the store holds. What a demo machine
 *                wants, and what lets a smoke reach the screen without having
 *                to empty the store first.
 *   - `never`  — only ⌘K → "Welcome & machine setup" reaches it. The answer
 *                for someone who deleted their last session and does not want
 *                the screen back.
 */
export type WelcomeMode = 'auto' | 'always' | 'never'

export const WELCOME_MODES: readonly WelcomeMode[] = ['auto', 'always', 'never']

export const WELCOME_MODE_DEFAULT: WelcomeMode = 'auto'

/** The IPC boundary and a hand-edited `welcome.json` are both untrusted input:
 *  anything unrecognized degrades to the default rather than to a screen that
 *  never appears. */
export const sanitizeWelcomeMode = (raw: unknown): WelcomeMode =>
  WELCOME_MODES.includes(raw as WelcomeMode) ? (raw as WelcomeMode) : WELCOME_MODE_DEFAULT

/** Whether the screen shows itself, given the mode and whether the store has
 *  ever produced a session. One function so main's tests and the renderer's
 *  render condition cannot disagree about the rule. */
export const welcomeShows = (mode: WelcomeMode, firstRun: boolean): boolean =>
  mode === 'always' || (mode === 'auto' && firstRun)
