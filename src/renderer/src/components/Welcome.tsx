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
//     in the main pane while the store has never produced a session (§2.1).
//
// The five forms this replaces are still there and still work; what this
// removes is having to know their order on a machine gurt has never seen.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { AGENT_DEFS, agentDef } from '../../../shared/agents'
import type { DoctorReport, DoctorRow, FirstRunResult } from '../../../shared/doctor'
import { OAUTH_PROVIDER_CHOICES } from '../../../shared/credentials'
import { Icon, Logo } from './icons'
import { AgentMark } from './tags'
import { logErr } from '../log'

/** Docker Desktop takes the better part of a minute to answer, so the poll
 *  after "Start Docker Desktop" has to outlast that — and give up, rather than
 *  spin, when the app never comes up. */
const DOCKER_POLL_MS = 3_000
const DOCKER_POLL_LIMIT_MS = 90_000

const DOT: Record<DoctorRow['state'], string> = {
  ok: 'dot-green',
  warn: 'dot-yellow',
  fail: 'dot-red',
  checking: 'dot-outline'
}

/** The checklist. `onReport` lets the embedding screen read `ready` without
 *  running the probes a second time. */
export function MachineChecklist({
  onReport,
  log
}: {
  onReport?: (r: DoctorReport) => void
  log?: string[] | undefined
}): JSX.Element {
  const [report, setReport] = useState<DoctorReport | null>(null)
  const [busy, setBusy] = useState<'' | 'checking' | 'preparing' | 'waiting'>('checking')
  const [error, setError] = useState('')
  // Invalidates an in-flight refresh: a reply that lands after a newer one
  // would roll the rows back to the older machine state.
  const seq = useRef(0)
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    []
  )

  const refresh = useCallback(async (): Promise<DoctorReport | null> => {
    const mine = ++seq.current
    setBusy('checking')
    try {
      const r = await window.gurt.machineDoctor()
      if (!alive.current || mine !== seq.current) return r
      setReport(r)
      onReport?.(r)
      return r
    } catch (e) {
      logErr('machineDoctor')(e)
      if (alive.current && mine === seq.current)
        setError(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      if (alive.current && mine === seq.current) setBusy('')
    }
  }, [onReport])

  useEffect(() => {
    void refresh()
  }, [refresh])

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
    for (;;) {
      await new Promise((r) => setTimeout(r, DOCKER_POLL_MS))
      if (!alive.current) return
      const r = await window.gurt.machineDoctor().catch(() => null)
      if (!alive.current) return
      if (r) {
        setReport(r)
        onReport?.(r)
        if (r.rows.find((x) => x.id === 'docker-daemon')?.state === 'ok') break
      }
      if (Date.now() > until) break
    }
    if (alive.current) setBusy('')
  }

  const rows = report?.rows ?? []
  return (
    <div className="wc-check">
      <div className="wc-check-head">
        <span className="wc-head-title">This machine</span>
        <span className="spacer" />
        <button className="btn-link" disabled={busy !== ''} onClick={() => void refresh()}>
          {busy === 'checking' ? 'checking…' : 'Re-check'}
        </button>
      </div>
      <div className="set-list">
        {!rows.length && <div className="wc-row faint">checking this machine…</div>}
        {rows.map((row) => (
          <div key={row.id} className="wc-row">
            <span
              className={`dot ${DOT[busy === 'waiting' && row.id === 'docker-daemon' ? 'checking' : row.state]}`}
            />
            <span className="wc-row-label">{row.label}</span>
            <span className="wc-row-detail mono">
              {busy === 'waiting' && row.id === 'docker-daemon'
                ? 'waiting for the daemon…'
                : row.detail}
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
          </div>
        ))}
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
 */
export function Welcome({
  log,
  preferredKind,
  onStarted
}: {
  log?: string[] | undefined
  preferredKind?: string | undefined
  onStarted: (sessionId: string) => void
}): JSX.Element {
  const [ready, setReady] = useState(false)
  const [kind, setKind] = useState(preferredKind || AGENT_DEFS[0]!.id)
  const [token, setToken] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState<'' | 'signin' | 'token'>('')
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')
  const onReport = useCallback((r: DoctorReport) => setReady(r.ready), [])

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
    <div className="wc">
      <div className="wc-logo">
        <Logo size={200} />
      </div>
      <div className="wc-body">
        <div className="wc-title">Welcome to gurt</div>
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
  )
}
