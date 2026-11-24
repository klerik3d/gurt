// The Review tab of an executor (t2v3 A, B; t3v2 §3.3): settings before the
// first run; afterwards the status line with its buttons, the run picker, the
// quick filters, the findings table with the expanded row, History and the
// folded Settings. Standard components and metrics only — no dots, no header
// badges, no coloured rails.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Entry, RpmCommand, RpmConfig, RpmFinding, RpmState, RunSummary, Severity, VerdictTo } from '../core'
import { useRpmHost } from './host'
import {
  FILTERS,
  OWNER_TONE,
  SEVERITIES,
  STATE_LABEL,
  STATUS_BUTTON,
  actorLabel,
  clock,
  entryLine,
  historyMove,
  inFilter,
  sortFindings,
  statusLine,
  where,
  type Filter,
  type SortKey
} from './labels'
import { Settings, settingsSummary } from './Settings'
import { useRpm, type RpmData } from './useRpm'

export function ReviewTab({ executor }: { executor: string }) {
  // Everything local (run picked, filter, open row) belongs to one executor.
  return <ReviewTabOf key={executor} executor={executor} />
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))

function ReviewTabOf({ executor }: { executor: string }) {
  const [run, setRun] = useState<number | undefined>(undefined)
  const data = useRpm(executor, run)
  return <ReviewTabView executor={executor} data={data} onRun={setRun} />
}

/** The tab over data already read — what `ReviewTab` shows (exported for the tests). */
export function ReviewTabView({
  executor,
  data,
  onRun
}: {
  executor: string
  data: RpmData
  onRun: (run: number | undefined) => void
}) {
  const { api } = useRpmHost()
  const [error, setError] = useState('')

  const act = (p: Promise<unknown>): Promise<boolean> =>
    p.then(
      () => {
        setError('')
        return true
      },
      (e: unknown) => {
        setError(errorText(e))
        return false
      }
    )
  const patch = (p: Partial<RpmConfig>): void => void act(api.rpmSetConfig(executor, p))

  if (!data.loaded) return <div className="ns-body"><span className="faint">loading…</span></div>
  const err = error || data.error
  return (
    <div className="ns-body rpm-tab">
      {err && <div className="error rpm-error">{err}</div>}
      {data.state ? (
        <RunView executor={executor} state={data.state} runs={data.runs} config={data.config} onRun={onRun} act={act} onPatch={patch} />
      ) : (
        data.config && (
          <>
            <Settings executor={executor} config={data.config} onPatch={patch} />
            {data.config.enabled && (
              <div className="rpm-hint faint">The review starts after the executor's next turn that changes code.</div>
            )}
          </>
        )
      )}
    </div>
  )
}

function RunView({
  executor,
  state,
  runs,
  config,
  onRun,
  act,
  onPatch
}: {
  executor: string
  state: RpmState
  runs: RunSummary[]
  config: RpmConfig | undefined
  onRun: (run: number | undefined) => void
  act: (p: Promise<unknown>) => Promise<boolean>
  onPatch: (p: Partial<RpmConfig>) => void
}) {
  const { api } = useRpmHost()
  // The badge counts what waits for you, so that is where the tab opens when
  // anything does (t2v3 B: the filter stands by itself).
  const [filter, setFilter] = useState<Filter>(state.counts.you > 0 ? 'you' : 'all')
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'severity', desc: true })
  const [open, setOpen] = useState<string | undefined>(undefined)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Something new waits for you while the tab is open: show it.
  const you = state.counts.you
  const prevYou = useRef(you)
  useEffect(() => {
    if (you > 0 && prevYou.current === 0) setFilter('you')
    prevYou.current = you
  }, [you])

  const shown = sortFindings(state.findings.filter((f) => inFilter(f, filter)), sort.key, sort.desc)
  const head = (key: SortKey, label: string, width?: number): ReactNode => (
    <th
      className={sort.key === key ? 'sorted' : undefined}
      style={width ? { width } : undefined}
      onClick={() =>
        setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key === 'severity' || key === 'state' }))
      }
    >
      {label}
      {sort.key === key ? (sort.desc ? ' ▾' : ' ▴') : ''}
    </th>
  )

  return (
    <>
      <StatusBar executor={executor} state={state} runs={runs} onRun={onRun} act={act} />

      <div className="chip-row rpm-filters">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" className={`chip-btn ${filter === f.id ? 'on' : ''}`} onClick={() => setFilter(f.id)}>
            {f.label}
            <span className="rpm-n">{state.counts[f.id]}</span>
          </button>
        ))}
      </div>

      {shown.length ? (
        <table className="rpm-table">
          <thead>
            <tr>
              {head('id', 'id', 52)}
              {head('severity', 'severity', 92)}
              {head('where', 'where', 190)}
              {head('claim', 'claim')}
              {head('state', 'state', 96)}
              {head('tries', 'tries', 56)}
            </tr>
          </thead>
          <tbody>
            {shown.map((f) => (
              <FindingRow
                key={f.id}
                finding={f}
                state={state}
                open={open === f.id}
                onToggle={() => setOpen(open === f.id ? undefined : f.id)}
                verdict={(to, comment) => act(api.rpmVerdict(executor, f.id, to, comment))}
                severity={(to, comment) => act(api.rpmSeverity(executor, f.id, to, comment))}
              />
            ))}
          </tbody>
        </table>
      ) : (
        <div className="rpm-hint faint">{state.findings.length ? 'Nothing here.' : 'No findings yet.'}</div>
      )}

      <Fold label="History" meta={`${state.journal.length} entries`} open={historyOpen} onToggle={() => setHistoryOpen(!historyOpen)}>
        <History journal={state.journal} />
      </Fold>
      <Fold
        label="Settings"
        meta={config ? settingsSummary(config) : ''}
        open={settingsOpen}
        onToggle={() => setSettingsOpen(!settingsOpen)}
      >
        {config && <Settings executor={executor} config={config} onPatch={onPatch} />}
      </Fold>
    </>
  )
}

// --- the status line ---------------------------------------------------------------------

function StatusBar({
  executor,
  state,
  runs,
  onRun,
  act
}: {
  executor: string
  state: RpmState
  runs: RunSummary[]
  onRun: (run: number | undefined) => void
  act: (p: Promise<unknown>) => Promise<boolean>
}) {
  const { api, confirm } = useRpmHost()
  const [output, setOutput] = useState(false)
  const [menu, setMenu] = useState<'runs' | 'more' | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const line = statusLine(state)
  const st = state.status
  const last = runs[runs.length - 1]?.run

  const command = async (cmd: RpmCommand): Promise<void> => {
    if (
      cmd === 'stop' &&
      !(await confirm('Stop this review run? The executor keeps its changes; the next turn with changes starts a new run.', {
        title: 'Stop review',
        confirmText: 'Stop',
        danger: true
      }))
    )
      return
    await act(api.rpmCommand(executor, cmd))
  }
  const sendNote = async (): Promise<void> => {
    if (!note?.trim()) return
    if (await act(api.rpmNote(executor, note.trim()))) setNote(null)
  }

  return (
    <>
      <div className="rpm-status">
        <span>{line.text}</span>
        {line.marked !== undefined && (
          <>
            <span className="faint">·</span>
            {/* TODO(rpm): task 12 links this to Diff with the marked files. */}
            <span className="dim">marked {line.marked} {line.marked === 1 ? 'file' : 'files'}</span>
          </>
        )}
        {line.output && (
          <>
            <span className="faint">·</span>
            <button type="button" className="btn-link rpm-link" onClick={() => setOutput(!output)}>
              output {output ? '▾' : '▸'}
            </button>
          </>
        )}
        <span className="faint">·</span>
        <Menu
          open={menu === 'runs'}
          onToggle={() => setMenu(menu === 'runs' ? null : 'runs')}
          onClose={() => setMenu(null)}
          button={<span className="dim">run {state.run} ▾</span>}
        >
          {[...runs].reverse().map((r) => (
            <button
              key={r.run}
              type="button"
              className={`menu-item ${r.run === state.run ? 'active' : ''}`}
              onClick={() => {
                onRun(r.run === last ? undefined : r.run)
                setMenu(null)
              }}
            >
              run {r.run}
              <span className="menu-meta">
                {r.result} · {r.findings} {r.findings === 1 ? 'finding' : 'findings'} · {clock(r.startedAt)}
              </span>
            </button>
          ))}
        </Menu>
        {state.live && (
          <>
            <span className="faint">·</span>
            <span className="dim">
              reviews {st.reviewsSinceYou} of {state.config.reviews}
            </span>
          </>
        )}
        {st.lastCheck && (
          <>
            <span className="faint">·</span>
            <span className="dim">check {st.lastCheck.ok ? 'passed' : 'failed'}</span>
          </>
        )}
        <span className="spacer" />
        {line.buttons.map((b) => (
          <button
            key={b}
            type="button"
            className={`btn btn-xs ${b === 'stop' ? 'btn-danger-text' : ''}`}
            onClick={() => void command(STATUS_BUTTON[b].cmd)}
          >
            {STATUS_BUTTON[b].label}
          </button>
        ))}
        {state.live && (
          <Menu
            open={menu === 'more'}
            onToggle={() => setMenu(menu === 'more' ? null : 'more')}
            onClose={() => setMenu(null)}
            button={<span className="btn btn-xs">⋯</span>}
            right
          >
            <button type="button" className="menu-item" onClick={() => { setMenu(null); void command('rerun-check') }}>
              Run the check again
            </button>
            <button type="button" className="menu-item" onClick={() => { setMenu(null); void command('rerun-review') }}>
              Review again
            </button>
            <button type="button" className="menu-item" onClick={() => { setMenu(null); setNote('') }}>
              Note to the executor…
            </button>
          </Menu>
        )}
      </div>
      {output && <CheckOutput journal={state.journal} />}
      {note !== null && (
        <div className="rpm-acts rpm-note">
          <input
            className="input"
            autoFocus
            placeholder="goes to the executor with its next message…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void sendNote()
              if (e.key === 'Escape') setNote(null)
            }}
          />
          <button type="button" className="btn btn-xs" disabled={!note.trim()} onClick={() => void sendNote()}>
            Add note
          </button>
          <button type="button" className="btn btn-xs btn-text" onClick={() => setNote(null)}>
            Cancel
          </button>
        </div>
      )}
    </>
  )
}

/** The last check's failing commands with their output tail, on the spot (t2v3 D). */
function CheckOutput({ journal }: { journal: Entry[] }) {
  const check = [...journal].reverse().find((e) => e.kind === 'check')
  const fail = [...journal].reverse().find((e) => e.kind === 'fail')
  const text =
    check?.kind === 'check'
      ? check.runs
          .filter((r) => r.code !== 0 || !check.ok)
          .map((r) => `${r.repo} $ ${r.command} → ${r.timedOut ? 'timed out' : `exit ${r.code}`}\n${r.tail.join('\n')}`)
          .join('\n\n')
      : ''
  const detail = fail?.kind === 'fail' && fail.reason === 'check-error' ? fail.detail : ''
  return <pre className="env-log rpm-output">{[detail, text].filter(Boolean).join('\n\n') || 'no check output'}</pre>
}

// --- the findings table --------------------------------------------------------------------

function FindingRow({
  finding: f,
  state,
  open,
  onToggle,
  verdict,
  severity
}: {
  finding: RpmFinding
  state: RpmState
  open: boolean
  onToggle: () => void
  verdict: (to: VerdictTo, comment?: string) => Promise<boolean>
  severity: (to: Severity, comment?: string) => Promise<boolean>
}) {
  const { openFile, openChat } = useRpmHost()
  const [comment, setComment] = useState('')
  const [sevMenu, setSevMenu] = useState(false)
  const c = comment.trim() || undefined
  const done = (ok: boolean): void => {
    if (ok) setComment('')
  }
  return (
    <>
      <tr className={`rpm-row ${open ? 'open' : ''}`} onClick={onToggle}>
        <td className="mono">
          {f.id}
          {!open && <span className="faint"> ▸</span>}
        </td>
        <td className={`rpm-sev rpm-sev-${f.severity}`}>{f.severity}</td>
        <td>
          {f.file && (
            <button
              type="button"
              className="btn-link rpm-link mono"
              onClick={(e) => {
                e.stopPropagation()
                openFile(f.file!, f.line)
              }}
            >
              {where(f)}
            </button>
          )}
        </td>
        <td>{f.claim}</td>
        <td className={OWNER_TONE[f.owner]}>{STATE_LABEL[f.state]}</td>
        <td className="faint">
          {f.attempts}/{state.config.attempts}
        </td>
      </tr>
      {open && (
        <tr className="rpm-x">
          <td colSpan={6}>
            <div className="rpm-hist">
              {f.history.map((h, i) => (
                <div key={`${h.seq}-${i}`} className={`rpm-hist-row ${h.ignored ? 'faint' : ''}`}>
                  <span className="rpm-t">{clock(h.at)}</span>
                  <span className="rpm-w">
                    {h.chat ? (
                      <button type="button" className="btn-link rpm-link" onClick={() => openChat(h.chat!.sessionId, h.chat!.entryId)}>
                        {actorLabel(h.by, h.review)}
                      </button>
                    ) : (
                      // Your moves and lines no longer in a chat log have no message to open.
                      actorLabel(h.by, h.review)
                    )}
                    {' · '}
                    {historyMove(h, i === 0)}
                  </span>
                  <span>{i === 0 && !h.comment ? f.scenario : h.comment}</span>
                </div>
              ))}
              {!f.history.length && <span className="faint">{f.scenario}</span>}
            </div>
            {state.live && (
              <div className="rpm-acts">
                <input
                  className="input"
                  placeholder="comment…"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                />
                <button type="button" className="btn btn-xs" onClick={() => void verdict('must', c).then(done)}>
                  Must do
                </button>
                <button type="button" className="btn btn-xs" onClick={() => void verdict('reject', c).then(done)}>
                  Reject
                </button>
                <button type="button" className="btn btn-xs" onClick={() => void verdict('defer', c).then(done)}>
                  Defer
                </button>
                <span className="faint">·</span>
                <Menu
                  open={sevMenu}
                  onToggle={() => setSevMenu(!sevMenu)}
                  onClose={() => setSevMenu(false)}
                  button={<span className="btn btn-xs">{f.severity} ▾</span>}
                >
                  {SEVERITIES.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={`menu-item ${s === f.severity ? 'active' : ''}`}
                      onClick={() => {
                        setSevMenu(false)
                        if (s !== f.severity) void severity(s, c).then(done)
                      }}
                    >
                      {s}
                    </button>
                  ))}
                </Menu>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

// --- History, folds, menus -----------------------------------------------------------------------

function History({ journal }: { journal: Entry[] }) {
  let reviews = 0
  return (
    <div className="rpm-hist">
      {journal.map((e) => {
        if (e.kind === 'review') reviews++
        return (
          <div key={e.seq} className="rpm-hist-row">
            <span className="rpm-t">{clock(e.at)}</span>
            <span className="rpm-w">{actorLabel(e.by, e.kind === 'review' ? reviews : undefined)}</span>
            <span>
              {entryLine(e, reviews)}
              {e.comment && <span className="dim"> — {e.comment}</span>}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function Fold({
  label,
  meta,
  open,
  onToggle,
  children
}: {
  label: string
  meta: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className="rpm-fold">
      <button type="button" className="rpm-fold-head" onClick={onToggle} aria-expanded={open}>
        <span className="faint">{open ? '▾' : '▸'}</span>
        <span className="seclabel">{label}</span>
        <span className="faint rpm-fold-meta">{meta}</span>
      </button>
      {open && <div className="rpm-fold-body">{children}</div>}
    </div>
  )
}

/** A button with a `.menu` under it; closes on a click outside. */
function Menu({
  open,
  onToggle,
  onClose,
  button,
  right,
  children
}: {
  open: boolean
  onToggle: () => void
  onClose: () => void
  button: ReactNode
  right?: boolean
  children: ReactNode
}) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [open, onClose])
  return (
    <span className="rpm-menu-wrap" ref={ref}>
      <button type="button" className="rpm-menu-btn" aria-haspopup aria-expanded={open} onClick={onToggle}>
        {button}
      </button>
      {open && <div className={`menu rpm-menu ${right ? 'rpm-menu-right' : ''}`}>{children}</div>}
    </span>
  )
}
