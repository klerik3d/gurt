// The view (t3v2 §3.2): RpmState for IPC and the UI, from the fold and the
// journal. `status` follows §3.2; the history per finding comes from the fold
// (`RunState.history`), `chat` is not filled yet.
import { ownerOf, tracked } from './machine'
import { CHECK_RED_LIMIT, type Entry, type EntryOf, type RpmFinding, type RpmState, type RunState, type RunStatus } from './model'

export function view(run: RunState, journal: readonly Entry[]): RpmState {
  const findings: RpmFinding[] = run.findings.map((f) => ({
    ...f,
    tracked: tracked(run, f),
    owner: ownerOf(f.state),
    history: run.history[f.id] ?? []
  }))
  const counts = { you: 0, executor: 0, reviewer: 0, final: 0, below: 0, all: findings.length }
  for (const f of findings) {
    if (!f.tracked) counts.below++
    else if (f.owner === 'none') counts.final++
    else counts[f.owner]++
  }
  const mark = journal.find((e): e is EntryOf<'mark'> => e.kind === 'mark')?.mark
  return {
    executor: run.executor,
    run: run.run,
    live: !run.ended,
    status: status(run, journal, findings),
    config: run.config,
    findings,
    counts,
    journal: [...journal],
    ...(mark && { mark })
  }
}

function status(run: RunState, journal: readonly Entry[], findings: RpmFinding[]): RunStatus {
  let redStreak = 0
  for (const e of journal) if (e.kind === 'check') redStreak = e.ok ? 0 : redStreak + 1
  const common = {
    reviewsSinceYou: run.sinceYou.reviews,
    ...(run.lastCheck && { lastCheck: { ok: run.lastCheck.ok, redStreak } })
  }
  return { ...phase(run, journal, findings), ...common }
}

type Phase = RunStatus extends infer T ? (T extends unknown ? Omit<T, 'reviewsSinceYou' | 'lastCheck'> : never) : never

function phase(run: RunState, journal: readonly Entry[], findings: RpmFinding[]): Phase {
  if (run.ended === 'passed') {
    const mark = journal.find((e): e is EntryOf<'mark'> => e.kind === 'mark')?.mark
    return { phase: 'passed', files: mark ? mark.repos.reduce((n, r) => n + r.files.length, 0) : 0 }
  }
  if (run.ended) return { phase: 'ended', why: run.ended }
  const step = run.step
  if (step) {
    if (step.what === 'check') {
      // TODO(rpm): the step entry does not name its repos; the last check's (or the base's) stand in.
      const repos = run.lastCheck?.commands.map((c) => c.repo) ?? run.base.map((b) => b.repo)
      return { phase: 'check', repos }
    }
    if (step.what === 'review') {
      // TODO(rpm): `waitingPlan` is known only to the engine (task 9), which adds it.
      return { phase: 'review', review: run.reviews + 1, full: step.full ?? true, items: step.items?.length ?? 0, session: step.session ?? '' }
    }
    const entry = journal.find((e): e is EntryOf<'step'> => e.kind === 'step' && e.step === step.step)
    if (entry?.rule === '3в') return { phase: 'fix-check', try: Math.max(1, run.sinceYou.redChecks), of: CHECK_RED_LIMIT }
    return { phase: 'executor', items: step.items?.length ?? 0 }
  }
  if (run.called) {
    const live = findings.filter((f) => f.tracked)
    const items =
      run.called === 'findings' ? live.filter((f) => f.owner === 'you')
      : run.called === 'budget' || run.called === 'idle-executor' ? live.filter((f) => f.owner !== 'none')
      : []
    return { phase: 'called', why: run.called, items: items.map((f) => f.id) }
  }
  if (run.paused) return { phase: 'paused' }
  // At a boundary the engine writes the next step at once, so this is brief.
  // TODO(rpm): RunStatus has no "deciding" phase; show the executor's side.
  return { phase: 'executor', items: findings.filter((f) => f.tracked && f.owner === 'executor').length }
}
