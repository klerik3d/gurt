// The first-run screen and its reusable half
// (docs/requirements-first-run.md §2, §3, §6).
//
// Two exports, one component each:
//
//   - {@link MachineChecklist} — the checklist, mounted in two places: here,
//     and permanently in Settings → Machine. One implementation, because a
//     machine that lost Docker after setup needs the rows and must not need an
//     empty store to reach them (§2.2).
//   - {@link Welcome} — the checklist plus the "Start operator" block, shown
//     as a popup over the main pane while the store has never produced a
//     session (§2.1). It can be skipped, and skipping it can be made
//     permanent from the popup itself.
//
// The five forms this replaces are still there and still work; what this
// removes is having to know their order on a machine gurt has never seen.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { AGENT_DEFS, agentDef } from '../../../shared/agents'
import type { DoctorReport, DoctorRow, FirstRunResult, WelcomeMode } from '../../../shared/doctor'
import { pendingRows, WELCOME_MODE_DEFAULT } from '../../../shared/doctor'
import { OAUTH_PROVIDER_CHOICES } from '../../../shared/credentials'
import { Icon, Logo } from './icons'
import { AgentMark } from './tags'
import { logErr } from '../log'

/** Docker Desktop takes the better part of a minute to answer, so the poll
 *  after "Start Docker Desktop" has to outlast that — and give up, rather than
 *  spin, when the app never comes up. */
const DOCKER_POLL_MS = 3_000
const DOCKER_POLL_LIMIT_MS = 90_000

/** The dot per state. A row being checked pulses green — the same "something
 *  is happening here" a running session's row uses (`status.ts`); a row not
 *  yet reached is a hollow outline, so the list reads as a queue rather than
 *  as three unanswered questions. */
const DOT: Record<DoctorRow['state'], string> = {
  pending: 'dot-faint dot-hollow',
  checking: 'dot-green dot-pulse',
  ok: 'dot-green',
  warn: 'dot-yellow',
  fail: 'dot-red'
}

/** Minimum time a row stays lit before the next one starts. The probes are
 *  fast (a few `stat`s, one `docker info`, two `docker image inspect`) and on a
 *  healthy machine the whole sweep is well under a second — which is the goal,
 *  and also the problem: with no floor the three rows would resolve in one
 *  frame and the sequence would not be seen at all. Small on purpose: this
 *  paces the reveal, it must never be what makes the check slow. */
const ROW_STEP_MS = 110

/**
 * The checklist.
 *
 * The rows are known before anything is probed (`DOCTOR_ROWS`), so the list is
 * drawn complete and greyed out the moment this mounts and then fills in
 * order, one row at a time, from the `doctor-row` events main emits as each
 * probe answers. The alternative — a "checking…" placeholder until the whole
 * report returns — showed nothing for as long as the slowest probe took and
 * then everything at once, which reads as a hang rather than as work.
 *
 * `onReport` lets the embedding screen read `ready` without running the probes
 * a second time. `heading` is the head row; pass null where the caller already
 * has one (Settings → Machine puts its Re-check in the section header).
 */
export function MachineChecklist({
  onReport,
  log,
  heading = 'This machine'
}: {
  onReport?: (r: DoctorReport) => void
  log?: string[] | undefined
  heading?: string | null
}): JSX.Element {
  const [rows, setRows] = useState<DoctorRow[]>(pendingRows)
  const [busy, setBusy] = useState<'' | 'checking' | 'preparing' | 'waiting'>('checking')
  const [error, setError] = useState('')
  // Invalidates an in-flight sweep: a row from an older run must not land on
  // top of a newer one's.
  const seq = useRef(0)
  const alive = useRef(true)

  /** Rows arrive faster than they can be read, so they are queued here and
   *  drained one per `ROW_STEP_MS`. */
  const queue = useRef<DoctorRow[]>([])
  const draining = useRef(false)
  /**
   * The report is the truth; the event stream is only the reveal.
   *
   * Nothing about correctness may depend on an event arriving: one that is
   * dropped, or that fires before this component subscribed, would otherwise
   * strand its row in `checking` forever with no way back. So the reply is
   * kept here and applied wholesale once the queue drains — idempotent when
   * every event did arrive, and the whole answer when none did.
   */
  const settled = useRef<DoctorRow[] | null>(null)

  const applySettled = useCallback((mine: number) => {
    const final = settled.current
    if (!final || !alive.current || mine !== seq.current) return
    setRows(final)
  }, [])

  const drain = useCallback(
    (mine: number) => {
      if (draining.current) return
      draining.current = true
      const step = (): void => {
        if (!alive.current || mine !== seq.current) {
          draining.current = false
          return
        }
        const next = queue.current.shift()
        if (!next) {
          draining.current = false
          // Queue empty — land on the report, if it has come back yet.
          applySettled(mine)
          return
        }
        setRows((prev) => {
          const at = prev.findIndex((r) => r.id === next.id)
          if (at < 0) return prev
          const out = [...prev]
          out[at] = next
          // Light the next unanswered row: the list should always show where
          // the sweep currently is, not go blank between two answers.
          const after = out[at + 1]
          if (after && after.state === 'pending') out[at + 1] = { ...after, state: 'checking' }
          return out
        })
        setTimeout(step, ROW_STEP_MS)
      }
      step()
    },
    [applySettled]
  )

  const refresh = useCallback(async (): Promise<DoctorReport | null> => {
    const mine = ++seq.current
    queue.current = []
    settled.current = null
    setBusy('checking')
    setError('')
    // Back to a full, unanswered list — a re-check re-runs every probe, and
    // showing the previous answers while it does would be showing stale ones.
    setRows(() => {
      const fresh = pendingRows()
      if (fresh[0]) fresh[0] = { ...fresh[0], state: 'checking' }
      return fresh
    })
    try {
      const r = await window.gurt.machineDoctor()
      if (!alive.current || mine !== seq.current) return r
      settled.current = r.rows
      // Nothing is animating (every event was lost, or they all drained while
      // this was in flight) — land on the answer now rather than never.
      if (!draining.current) applySettled(mine)
      onReport?.(r)
      return r
    } catch (e) {
      logErr('machineDoctor')(e)
      if (alive.current && mine === seq.current) {
        setError(e instanceof Error ? e.message : String(e))
        // Never leave a row pulsing over a check that will not finish.
        setRows((prev) =>
          prev.map((r) =>
            r.state === 'pending' || r.state === 'checking'
              ? { ...r, state: 'fail' as const, detail: 'the check could not run' }
              : r
          )
        )
      }
      return null
    } finally {
      if (alive.current && mine === seq.current) setBusy('')
    }
  }, [onReport, applySettled])

  // Subscribe before the first sweep: a probe that answers in under a
  // millisecond must not beat the listener that draws its row.
  //
  // `alive` is re-armed here, not just cleared on unmount: StrictMode runs
  // mount → cleanup → mount on the SAME instance, so a ref only ever set to
  // false in the cleanup stays false for the life of the component — every
  // guard below it then fails silently and the list hangs on its first row.
  useEffect(() => {
    alive.current = true
    draining.current = false
    const off = window.gurt.onDoctorRow((row) => {
      queue.current.push(row)
      drain(seq.current)
    })
    void refresh()
    return () => {
      alive.current = false
      off()
    }
  }, [refresh, drain])

  const prepare = async (): Promise<void> => {
    setBusy('preparing')
    setError('')
    try {
      await window.gurt.machinePrepare()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    await refresh()
  }

  /** Ask the host to launch Docker Desktop, then watch for the daemon rather
   *  than telling the user to press the button again. Bounded: an app that
   *  never comes up leaves the row's original sentence in place. */
  const startDocker = async (): Promise<void> => {
    setError('')
    await window.gurt.machineStartDocker().catch(logErr('machineStartDocker'))
    setBusy('waiting')
    const until = Date.now() + DOCKER_POLL_LIMIT_MS
    const mine = ++seq.current
    for (;;) {
      await new Promise((r) => setTimeout(r, DOCKER_POLL_MS))
      if (!alive.current || mine !== seq.current) return
      const r = await window.gurt.machineDoctor().catch(() => null)
      if (!alive.current || mine !== seq.current) return
      // Each poll emits its own row events. They are dropped rather than
      // drained: replaying the whole reveal every three seconds while the
      // user waits for Docker Desktop would be motion, not information — the
      // daemon row already says "waiting for the daemon…". The report is
      // applied straight, which is the same "the reply is the truth" rule the
      // sweep ends on.
      queue.current = []
      if (r) {
        setRows(r.rows)
        onReport?.(r)
        if (r.rows.find((x) => x.id === 'docker-daemon')?.state === 'ok') break
      }
      if (Date.now() > until) break
    }
    if (alive.current && mine === seq.current) setBusy('')
  }

  const recheck = (
    <button className="btn-link" disabled={busy !== ''} onClick={() => void refresh()}>
      {busy === 'checking' ? 'checking…' : 'Re-check'}
    </button>
  )

  return (
    <div className="wc-check">
      {heading !== null && (
        <div className="wc-check-head">
          <span className="wc-head-title">{heading}</span>
          <span className="spacer" />
          {recheck}
        </div>
      )}
      <div className="wc-rows">
        {rows.map((row) => {
          // The daemon poll owns its row's appearance while it runs.
          const waiting = busy === 'waiting' && row.id === 'docker-daemon'
          const state = waiting ? 'checking' : row.state
          return (
            <div key={row.id} className={`wc-row wc-${state}`}>
              <span className={`dot ${DOT[state]}`} />
              <span className="wc-row-label">{row.label}</span>
              <span className="wc-row-detail mono">
                {waiting ? 'waiting for the daemon…' : state === 'pending' ? '' : row.detail}
              </span>
              <span className="spacer" />
              {row.action === 'prepare' && (
                <button className="btn" disabled={busy !== ''} onClick={() => void prepare()}>
                  {busy === 'preparing' ? 'pulling…' : 'Prepare'}
                </button>
              )}
              {row.action === 'start-docker' && (
                <button className="btn" disabled={busy !== ''} onClick={() => void startDocker()}>
                  Start Docker Desktop
                </button>
              )}
              {/* The tick is the "done, and fine" mark — a row that failed
                  says so in its own colour and its detail, not with a mark. */}
              {state === 'ok' && <span className="wc-tick">✓</span>}
            </div>
          )
        })}
      </div>
      {error && <div className="error">{error}</div>}
      {/* The pull's own output, in the provisioning-log style the session pane
          uses — "why is this taking three minutes" deserves an answer before
          it is asked (§5.3). */}
      {!!log?.length && <pre className="env-log">{log.join('\n')}</pre>}
    </div>
  )
}

/**
 * The welcome screen. Everything below the checklist is §6's second block:
 * pick a kind, sign in, one button.
 *
 * **Signing in is the primary path and pasting a key is the fallback**, and
 * the layout says so: the sign-in button is the one that is always visible,
 * the key field lives behind a disclosure. The reason is
 * docs/requirements-oauth-credentials.md §1 — the credential a user standing
 * in front of a fresh gurt actually *has* is a login, not a string. Claude,
 * ChatGPT and Gemini subscriptions authenticate by sign-in, and those tokens
 * are not something anyone can extract from another tool's keychain and paste
 * into a form.
 *
 * It is not the *only* path, for two reasons that are not preference: opencode
 * has no verified sign-in delivery at all (`AgentDef.oauthProvider` is null for
 * it, §5.2.1 of that document), and API keys are the right shape for CI,
 * self-hosted gateways and enterprise proxies — which is why that document's
 * §1 says OAuth "complements `agent-token`; it never replaces it".
 *
 * `preferredKind` seeds the picker from an agent instance that already exists
 * — a returning user with a registry and no sessions is still a first run
 * (§2.1), and asking them which kind they meant would be asking twice.
 *
 * **It is a popup, and it can be skipped.** The screen opens over the main
 * pane rather than in place of it, so what is behind it stays where it was,
 * and Esc, the backdrop, the × and "Skip for now" all mean the same thing:
 * not now. The one gesture that outlives the click is the checkbox in the
 * footer, which writes §2.1.1's `never` mode — that is the distinction the
 * mode was built for, a dismissal being about this launch and a preference
 * being about every one after it. Neither puts the screen out of reach: ⌘K →
 * "Welcome & machine setup" opens it under all three modes, which is also why
 * the checkbox can be unticked from here.
 *
 * Dismissal is refused while a sign-in or a start is in flight: those own a
 * browser window and a half-created session, and the Cancel beside the
 * sign-in button is the way out that also tells main to stop.
 */
export function Welcome({
  log,
  preferredKind,
  onStarted,
  onClose
}: {
  log?: string[] | undefined
  preferredKind?: string | undefined
  onStarted: (sessionId: string) => void
  onClose: () => void
}): JSX.Element {
  const [ready, setReady] = useState(false)
  const [kind, setKind] = useState(preferredKind || AGENT_DEFS[0]!.id)
  const [token, setToken] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState<'' | 'signin' | 'token'>('')
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')
  const onReport = useCallback((r: DoctorReport) => setReady(r.ready), [])
  /** The stored mode (§2.1.1), so the checkbox can be unticked as well as
   *  ticked — and so unticking restores what was there rather than assuming
   *  `auto`: a demo machine on `always` that ticks and unticks must end up
   *  back on `always`. Null until the read lands, and the checkbox is disabled
   *  until then rather than showing an answer it does not have yet. */
  const [savedMode, setSavedMode] = useState<WelcomeMode | null>(null)
  const wasMode = useRef<WelcomeMode>(WELCOME_MODE_DEFAULT)
  useEffect(() => {
    window.gurt
      .getWelcomeMode()
      .then((m) => {
        setSavedMode(m)
        if (m !== 'never') wasMode.current = m
      })
      .catch(logErr('getWelcomeMode'))
  }, [])

  const setHidden = (hide: boolean): void => {
    const next: WelcomeMode = hide ? 'never' : wasMode.current
    setSavedMode(next)
    window.gurt.setWelcomeMode(next).catch(logErr('setWelcomeMode'))
  }

  /** Esc, the backdrop, the × and Skip are one gesture with one guard: a
   *  sign-in waiting on the browser is not dismissed out from under itself. */
  const close = useCallback((): void => {
    if (busy === '') onClose()
  }, [busy, onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  const def = agentDef(kind)
  const provider = def?.oauthProvider
    ? OAUTH_PROVIDER_CHOICES.find((p) => p.id === def.oauthProvider)
    : undefined

  /** Both entrances land here: same result shape, same clearing rules. */
  const run = async (mode: 'signin' | 'token', call: () => Promise<FirstRunResult>) => {
    setBusy(mode)
    setError('')
    setWarning('')
    try {
      const res = await call()
      // Cleared on both paths: a retry retypes the key rather than
      // resubmitting a value this component kept (§7.1).
      setToken('')
      if (res.warning) setWarning(res.warning)
      onStarted(res.sessionId)
    } catch (e) {
      setToken('')
      const message = e instanceof Error ? e.message : String(e)
      // A cancelled browser flow is a decision, not a failure — the oauth
      // modal in Settings makes the same distinction.
      if (!/cancelled/i.test(message)) setError(message)
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="modal-backdrop wc-backdrop" onMouseDown={close}>
      <div className="modal wc-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">Welcome to gurt</span>
          <span className="spacer" />
          {busy === '' && <span className="kbd-tag">esc</span>}
          <button className="icon-sq" disabled={busy !== ''} onClick={close} title="close">
            <Icon name="x" size={13} />
          </button>
        </div>
        <div className="wc">
          <div className="wc-logo">
            <Logo size={200} />
          </div>
          <div className="wc-body">
            <div className="wc-sub">
              gurt runs every coding agent in its own container. Two things to check, then one
              agent to talk to.
            </div>

            <MachineChecklist onReport={onReport} log={log} />

            <div className="wc-start">
              <div className="wc-head-title">Start an operator</div>
              <div className="wc-sub">
                An operator is a session whose subject is gurt itself — it reads your
                configuration and tells you what to fix. It holds no repository, so it can always
                run.
              </div>
              <div className="wc-kinds">
                {AGENT_DEFS.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className={`btn ${kind === a.id ? 'btn-primary' : ''}`}
                    disabled={busy !== ''}
                    onClick={() => {
                      setKind(a.id)
                      setError('')
                      // A kind with no sign-in path has only the key field, so
                      // open it rather than hiding the only thing that works.
                      setShowKey(!agentDef(a.id)?.oauthProvider)
                    }}
                  >
                    <AgentMark kind={a.id} name={a.label} />
                  </button>
                ))}
              </div>

              {provider ? (
                <div className="row-buttons">
                  <button
                    className="btn btn-primary"
                    // Only the two docker rows gate. A missing image is a pull
                    // this click does itself (§3.3) — gating on it would cost a
                    // second click for nothing.
                    disabled={!ready || busy !== ''}
                    onClick={() => void run('signin', () => window.gurt.firstRunSignIn(kind))}
                  >
                    {busy === 'signin' ? 'waiting for the browser…' : `Sign in with ${provider.label}`}
                  </button>
                  {busy === 'signin' && (
                    <button
                      className="btn"
                      onClick={() => void window.gurt.firstRunCancelSignIn()}
                    >
                      Cancel
                    </button>
                  )}
                  <span className="wc-hint faint">
                    {!ready
                      ? 'fix the red rows above first'
                      : 'opens your browser, then creates a workspace, a task and an operator session'}
                  </span>
                </div>
              ) : (
                <div className="wc-hint faint">
                  {def?.label} has no sign-in — it needs an API key.
                </div>
              )}

              {/* The key path, demoted but never hidden: opencode has no sign-in
                  at all, and a key is the right shape for CI and self-hosted
                  gateways (requirements-oauth-credentials.md §1). */}
              {provider && !showKey && (
                <button className="btn-link wc-alt" onClick={() => setShowKey(true)}>
                  or paste an API key instead
                </button>
              )}
              {showKey && (
                <div className="wc-keyblock">
                  <input
                    className="wc-token"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={def?.secretEnv ? `API key for ${def.secretEnv}` : 'API key'}
                    value={token}
                    disabled={busy !== ''}
                    onChange={(e) => setToken(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && ready && token.trim() && !busy)
                        void run('token', () => window.gurt.firstRunStart(kind, token))
                    }}
                  />
                  <div className="row-buttons">
                    <button
                      className={`btn ${provider ? '' : 'btn-primary'}`}
                      disabled={!ready || !token.trim() || busy !== ''}
                      onClick={() => void run('token', () => window.gurt.firstRunStart(kind, token))}
                    >
                      {busy === 'token' ? 'starting…' : 'Start operator'}
                    </button>
                    <span className="wc-hint faint">
                      the key is stored in this machine’s credential store and never leaves it
                    </span>
                  </div>
                </div>
              )}

              {error && <div className="error">{error}</div>}
              {warning && (
                <div className="wc-warn">
                  <Icon name="info" size={13} /> {warning}
                </div>
              )}
            </div>
          </div>
        </div>
        {/* The one thing here that outlives the click: it writes §2.1.1's
            mode, which is what Settings → Machine edits too. A toggling
            `btn-link` rather than a checkbox, because that is how this app
            already writes this exact setting — the mode picker in Settings →
            Machine is three of them — and because a lone form control in a
            footer of buttons reads as something to fill in.

            The reassurance is the title rather than a line of its own: the
            footer has one decision in it, and a sentence beside it competes
            with the button that ends the screen. No key glyph in it — the
            palette hotkey is rebindable and platform-dependent, and a wrong
            one printed next to the control that hides a screen is the one
            place it must not be wrong. */}
        <div className="modal-foot">
          <button
            type="button"
            className={`btn-link wc-again${savedMode === 'never' ? ' active' : ''}`}
            disabled={savedMode === null}
            title="the command palette still opens this screen under every mode"
            onClick={() => setHidden(savedMode !== 'never')}
          >
            {savedMode === 'never' ? 'don’t show this again ✓' : 'don’t show this again'}
          </button>
          <span className="spacer" />
          <button className="btn" disabled={busy !== ''} onClick={close}>
            Skip for now
          </button>
        </div>
      </div>
    </div>
  )
}
