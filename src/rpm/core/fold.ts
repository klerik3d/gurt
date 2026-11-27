// The fold (t3v2 §2.2): a run's state from its journal and nothing else.
//
// - A move that is not allowed in the finding's state is kept in the journal
//   but changes nothing: its seq goes to `ignored` (t1v6 §2).
// - Your entries change the state at once (t3v2 §6.3); `next` only decides at
//   a step boundary.
// - Counters of rules 3а, 3б, 5, 8 run since your last entry. `turn { origin:
//   'user' }` counts as your entry too, and lifts `called`. A `config` entry
//   does not: changing the settings answers nothing (a budget raised above the
//   reviews made since you lifts a budget call).
// - Findings are numbered F1, F2… in the order reviews raise them.
import { move, ownerOf } from './machine'
import type { Act, Actor, Entry, Finding, HistoryItem, RunState } from './model'

/** The id the next new finding of this run gets. */
export function nextFindingId(run: Pick<RunState, 'findings'>): string {
  return `F${run.findings.length + 1}`
}

export function fold(journal: readonly Entry[]): RunState {
  const first = journal[0]
  if (!first || first.kind !== 'start') throw new Error('rpm: a journal begins with a start entry')
  const run: RunState = {
    executor: first.executor,
    run: first.run,
    base: first.base,
    config: first.config,
    findings: [],
    lastStep: 0,
    paused: false,
    reviews: 0,
    sinceYou: { reviews: 0, redChecks: 0 },
    pendingNotes: [],
    ignored: [],
    ignoredMoves: [],
    decided: [],
    lastYou: 0,
    fresh: [],
    history: {}
  }
  for (const e of journal.slice(1)) apply(run, e)
  return run
}

function apply(run: RunState, e: Entry): void {
  // TODO(rpm): entries after mark/end are folded as usual; the journal should not have any.
  // A settings change is not an answer: it neither lifts a call nor starts the
  // counters again (only a larger review budget lifts a budget call, below).
  if ((e.by === 'you' && e.kind !== 'config') || (e.kind === 'turn' && e.origin === 'user')) {
    run.lastYou = e.seq
    run.sinceYou = { reviews: 0, redChecks: 0 }
    delete run.called
    delete run.failed
  }
  const log = (id: string, item: Omit<HistoryItem, 'seq' | 'at' | 'by'>, comment: string | undefined): void => {
    const h = (run.history[id] ??= [])
    h.push({ seq: e.seq, at: e.at, by: e.by, ...item, ...(comment ? { comment } : {}) })
  }
  const doMove = (id: string, by: Actor, act: Act, comment: string | undefined, review?: number): void => {
    const i = run.findings.findIndex((f) => f.id === id)
    const f = run.findings[i]
    const moved = f ? move(f, by, act, run.config) : 'not-allowed'
    const rev = review !== undefined ? { review } : {}
    if (!f || moved === 'not-allowed') {
      if (!run.ignored.includes(e.seq)) run.ignored.push(e.seq)
      run.ignoredMoves.push({ seq: e.seq, id })
      // An executor act names the state it asked for; a refused verify has no target.
      if (f) log(id, { ...rev, from: f.state, ...(typeof act === 'string' && { to: act }), ignored: true }, comment)
      return
    }
    run.findings[i] = moved
    log(id, { ...rev, from: f.state, to: moved.state }, comment)
  }
  /** A result entry closes the running step it belongs to. */
  const settle = (step: number | undefined): void => {
    if (step !== undefined && run.step?.step === step) delete run.step
  }

  switch (e.kind) {
    case 'start':
      break
    case 'step':
      run.lastStep = e.step
      run.step = {
        step: e.step, what: e.what, key: e.key, tree: e.tree,
        ...(e.rule === 'rerun' && { rerun: true as const }),
        ...(e.session !== undefined && { session: e.session }),
        ...(e.items !== undefined && { items: e.items }),
        ...(e.full !== undefined && { full: e.full })
      }
      // A step starting ends any waiting: the call was answered or overridden.
      delete run.called
      delete run.failed
      if (e.rule === 'rerun') delete run.rerun
      if (e.what === 'executor') {
        // A 3в step carries only the check's output (t1v6 §6): notes wait for the next findings message.
        if (e.rule !== '3в') run.pendingNotes = []
        // Only the items this step carries reach the executor; a fix-check step carries none.
        const carried = e.items ?? []
        run.fresh = run.fresh.filter((id) => !carried.includes(id))
      }
      break
    case 'check':
      settle(e.step)
      run.lastCheck = { tree: e.tree, ok: e.ok, commands: e.runs.map((r) => ({ repo: r.repo, command: r.command })), step: e.step, seq: e.seq }
      run.sinceYou.redChecks = e.ok ? 0 : run.sinceYou.redChecks + 1
      break
    case 'review': {
      settle(e.step)
      run.reviews += 1
      run.sinceYou.reviews += 1
      run.lastReview = { tree: e.tree, n: run.reviews }
      for (const v of e.verify) doMove(v.id, 'reviewer', { verify: v.accept }, v.comment, run.reviews)
      for (const nf of e.findings) {
        // Numbered by order; the id in the entry is what the writer took from nextFindingId.
        const f: Finding = {
          id: nextFindingId(run),
          severity: nf.severity,
          ...(nf.file !== undefined && { file: nf.file }),
          ...(nf.line !== undefined && { line: nf.line }),
          claim: nf.claim,
          scenario: nf.scenario,
          state: 'open',
          back: 'open',
          attempts: 0,
          raisedIn: run.reviews
        }
        run.findings.push(f)
        log(f.id, { review: run.reviews, to: 'open' }, undefined)
      }
      break
    }
    case 'turn': {
      const before = e.step !== undefined && run.step?.step === e.step ? run.step.tree : undefined
      settle(e.step)
      run.lastTurn = {
        tree: e.tree, replies: e.replies.length, seq: e.seq,
        ...(e.step !== undefined && { step: e.step }),
        ...(before !== undefined && { before })
      }
      for (const r of e.replies) doMove(r.id, 'executor', r.act, r.comment)
      if (e.step !== undefined) {
        // Only turns RPM started: your own turns are yours to judge.
        if (e.outcome === 'failed') run.failed = 'executor-failed'
        else if (e.outcome === 'blocked') run.failed = 'executor-blocked'
        else if (e.outcome === 'cancelled') run.paused = true // Esc on an RPM turn pauses the run (t3v2 §6.3)
      }
      break
    }
    case 'fail':
      // A rerun you asked for, cut by a restart, is still asked for (it runs at the next boundary).
      if (e.reason === 'interrupted' && run.step?.step === e.step && run.step.rerun && run.step.what !== 'executor') {
        run.rerun = run.step.what
      }
      settle(e.step)
      if (e.reason === 'reviewer-failed' || e.reason === 'reviewer-gone') run.failed = 'reviewer-failed'
      else if (e.reason === 'check-error') run.failed = 'check-error'
      // 'interrupted' (a restart): nothing to call about, `next` decides afresh.
      break
    case 'verdict':
    {
      // Only a finding that was stuck with you rejoins the batch ahead of the
      // review; a verdict on any other finding leaves the rules as they are.
      const wasYours = ownerOf(run.findings.find((f) => f.id === e.id)?.state ?? 'closed') === 'you'
      doMove(e.id, 'you', { verdict: e.to }, e.comment)
      if (wasYours && e.to !== 'reject' && !run.fresh.includes(e.id)) run.fresh = [...run.fresh, e.id]
      if (!run.decided.includes(e.id) && run.findings.some((f) => f.id === e.id)) run.decided.push(e.id)
      break
    }
    case 'severity': {
      const i = run.findings.findIndex((f) => f.id === e.id)
      const f = run.findings[i]
      if (f) {
        run.findings[i] = { ...f, severity: e.to }
        log(e.id, { severity: { from: f.severity, to: e.to } }, e.comment)
      } else run.ignored.push(e.seq)
      break
    }
    case 'note':
      run.pendingNotes = [...run.pendingNotes, e.text]
      break
    case 'config':
      run.config = { ...run.config, ...e.patch }
      // More reviews than were made since you: the budget is not spent any more, the run goes on.
      if (run.called === 'budget' && run.sinceYou.reviews < run.config.reviews) delete run.called
      break
    case 'command':
      if (e.cmd === 'pause') run.paused = true
      else if (e.cmd === 'resume') run.paused = false
      else if (e.cmd === 'rerun-check') run.rerun = 'check'
      else if (e.cmd === 'rerun-review') run.rerun = 'review'
      // 'stop': the engine interrupts the step and writes `end stopped`.
      break
    case 'call':
      run.called = e.why
      break
    case 'mark':
      delete run.step
      run.ended = 'passed'
      break
    case 'end':
      delete run.step
      run.ended = e.why
      break
  }
}
