// The engine (t3v2 §6, §8.2, §10.2, §12): what moves a run by itself.
//
// - Subscriptions: an executor's settled turn starts a run (§6.1) or becomes a
//   `turn` entry; a reviewer's settled turn becomes `review` or `fail`.
// - At every boundary `next` decides; a step entry is written BEFORE its
//   effect starts (key `<executor>:<run>:<step>`), and the effect's result is
//   recorded only while that very step is still the running one.
// - Every journal write goes through `Journals.serial(executor, …)`. Effects
//   (check, the reviewer, the host message) run outside it and come back
//   through it, so a long check never blocks your entries.
// - `recover` (§8.2): replay the turn RPM did not get to record, interrupt a
//   check or a review that was cut by the restart, wait for an executor step.
import fs from 'node:fs'
import {
  checkMessage,
  chatLines,
  executorMessage,
  fold,
  next,
  ownerOf,
  reviewerPrompt,
  tracked,
  type CallReason,
  type CheckRun,
  type Entry,
  type EntryOf,
  type NewEntry,
  type RepoTree,
  type ReplyAct,
  type ReviewMark,
  type ReviewerInput,
  type RpmState,
  type RunState,
  type SettledTurn,
  type TreeId
} from '../core'
import type { Clock } from './api'
import type { Journals, RunRec } from './journals'
import type { RpmPorts, SessionFacts } from './ports'
import { treeId } from './trees'

/** Per repo, how much of the diff the reviewer gets in its prompt. */
const DIFF_MAX = 60_000
/** The reviewer's plan-limit poll, and the "check command changed while you were called" poll. */
const POLL_MS = 15_000

type Live = { rec: RunRec; state: RunState }

/** The detail of a `fail check-error` whose container was not confirmed stopped: until it is, no step starts and the clones stay held. */
const UNCONFIRMED = 'the check was not confirmed stopped'

/** seq of a `fail check-error` for an unconfirmed stop that no later check result superseded. */
function unconfirmedStop(entries: readonly Entry[]): number | undefined {
  let seq: number | undefined
  for (const e of entries) {
    if (e.kind === 'check' || (e.kind === 'step' && e.what === 'check')) seq = undefined
    else if (e.kind === 'fail' && e.reason === 'check-error' && e.detail.startsWith(UNCONFIRMED)) seq = e.seq
  }
  return seq
}

const keyOf = (executor: string, run: number, step: number): string => `${executor}:${run}:${step}`

export class Engine {
  /** The running check per executor: its step key and how to stop it. */
  private checks = new Map<string, { key: string; stop(): Promise<{ ok: boolean; detail?: string }> }>()
  /** Step keys that stop (or delete) cut: their effects start nothing more. */
  private cancelled = new Set<string>()
  /** `<executor>:<run>:<seq>` of unconfirmed stops confirmed since (memory only: after a restart they are confirmed once more). */
  private confirmed = new Set<string>()
  /** reviewer session id → its executor and step key (the session's facts are gone once it is deleted). */
  private reviewers = new Map<string, { executor: string; key: string }>()
  /** executor → the plan hold its running reviewer was last seen with (the poll emits a change). */
  private plans = new Map<string, string | undefined>()
  private subs: (() => void)[] = []

  constructor(
    private ports: RpmPorts,
    private journals: Journals,
    private clock: Clock,
    private warn: (msg: string) => void
  ) {}

  // --- lifecycle ----------------------------------------------------------------------

  start(): void {
    if (this.subs.length) return
    const s = this.ports.sessions
    this.subs.push(
      s.onSettled((t) => void this.settled(t)),
      s.onDeleted((id) => void this.deleted(id)),
      s.onCopied((from, to) => void this.copied(from, to)),
      this.clock.every(POLL_MS, () => this.poll())
    )
  }

  stop(): void {
    for (const off of this.subs.splice(0)) off()
  }

  /** `load` holds the clones of every live run (§8.2). */
  holdLive(): void {
    for (const e of this.journals.loaded()) if (this.journals.live(e.id)) this.ports.sessions.hold(e.id)
  }

  /** §8.2: replay, interrupt, decide. */
  async recover(): Promise<void> {
    // Listen before any effect starts: a resent message or a new reviewer may settle before recover returns.
    this.start()
    this.scanReviewers()
    for (const e of this.journals.loaded()) {
      const executor = e.id
      await this.guarded(executor, 'recover', async () => {
        // A stop that was journaled but not carried out (a crash in between): carry it out now.
        const last = this.journals.live(executor)?.rec.entries.at(-1)
        if (last?.kind === 'command' && last.cmd === 'stop') return this.stopLocked(executor)
        let live = this.journals.live(executor)
        const step = live?.state.step
        if (!live || !step) return this.decide(executor)

        // 1. A turn that settled but did not get into the journal.
        // TODO(rpm): a turn with changes that should have opened a run (crash before `start`) is not replayed.
        if (step.what === 'executor') {
          const t = this.ports.sessions.lastSettled(executor)
          if (t && t.key === step.key && t.outcome !== 'limited') await this.recordTurn(executor, live, t)
        } else if (step.what === 'review') {
          const rid = this.reviewerFor(step.key)
          const t = rid ? this.ports.sessions.lastSettled(rid) : undefined
          if (rid && t && t.key === step.key && t.outcome !== 'limited') await this.recordReview(executor, live, rid, t)
        }

        // 2. The step that is still without a result.
        live = this.journals.live(executor)
        const still = live?.state.step
        if (live && still?.key === step.key) {
          if (step.what === 'check') {
            // §8.2 / §12: without a confirmed stop the old check may still run — call you instead of checking again.
            const r = await this.confirmStop(executor)
            await this.append(
              executor,
              live,
              r.ok
                ? { by: 'rpm', kind: 'fail', step: step.step, reason: 'interrupted', detail: 'gurt restarted during the check' }
                : { by: 'rpm', kind: 'fail', step: step.step, reason: 'check-error', detail: `${UNCONFIRMED} after a restart: ${r.detail ?? 'unknown'}` }
            )
          } else if (step.what === 'review') {
            const rid = this.reviewerFor(step.key)
            if (rid) void this.ports.sessions.stopContainer(rid).catch((err: unknown) => this.warn(`rpm: recover: stop ${rid}: ${String(err)}`))
            await this.append(executor, live, { by: 'rpm', kind: 'fail', step: step.step, reason: 'interrupted', detail: 'gurt restarted during the review' })
          } else if (this.ports.sessions.sent(executor, step.key) === 'unknown') {
            // The message never got to the session (a crash between the step and `send`): send it again.
            const entry = live.rec.entries.find((x): x is EntryOf<'step'> => x.kind === 'step' && x.key === step.key)
            if (entry) this.effect(this.sendExecutor(executor, live.rec, entry))
          }
          // queued / taken: the session delivers it, the turn settles as usual.
        }
        // 3. The boundary.
        await this.decide(executor)
      })
    }
  }

  // --- for rpm.ts ---------------------------------------------------------------------------

  /** A boundary now (your entry while no step runs is one, §6.3). */
  boundary(executor: string): Promise<void> {
    return this.guarded(executor, 'boundary', () => this.decide(executor))
  }

  /** After one of your entries: the note's chat line, stop, then the boundary. */
  async afterYou(executor: string, entry: Entry): Promise<void> {
    if (entry.kind === 'note') {
      const rec = this.journals.last(executor)
      if (rec) this.ports.sessions.chatLine(executor, chatLines.note(fold(rec.entries), entry))
    }
    if (entry.kind === 'command' && entry.cmd === 'stop') return // done by `stopLocked`, in the same write as the entry
    return this.boundary(executor)
  }

  /** What only the engine knows about a running review: the reviewer's id and its plan hold. */
  decorate(state: RpmState): RpmState {
    const st = state.status
    if (!state.live || st.phase !== 'review') return state
    const step = fold(state.journal).step
    const rid = step ? this.reviewerFor(step.key) : undefined
    if (!rid) return state
    const plan = this.ports.sessions.info(rid)?.planHoldUntil
    return { ...state, status: { ...st, session: st.session || rid, ...(plan && { waitingPlan: plan }) } }
  }

  // --- subscriptions -------------------------------------------------------------------------

  private settled(t: SettledTurn): Promise<void> | undefined {
    if (t.outcome === 'limited') return // not a boundary: the turn continues by itself (§12)
    const f = this.ports.sessions.info(t.sessionId)
    if (f?.role === 'reviewer' && f.reviewerOf) {
      const of = f.reviewerOf
      this.reviewers.set(t.sessionId, of)
      // The reviewer's container goes down after its turn, whatever came of it (§6.2).
      void this.ports.sessions.stopContainer(t.sessionId).catch((err: unknown) => this.warn(`rpm: stop reviewer ${t.sessionId}: ${String(err)}`))
      return this.guarded(of.executor, 'review', async () => {
        const live = this.journals.live(of.executor)
        if (live) await this.recordReview(of.executor, live, t.sessionId, t)
        await this.decide(of.executor)
      })
    }
    if (f?.role !== 'executor') return
    const executor = t.sessionId
    return this.guarded(executor, 'turn', async () => {
      const live = this.journals.live(executor)
      if (!live) {
        // An RPM turn belongs to a step of a run that is over (a late settle after stop): it opens nothing.
        if (t.origin !== 'rpm' && t.outcome === 'changes' && this.journals.config(executor).enabled) await this.startRun(executor, f, t)
        return
      }
      await this.recordTurn(executor, live, t)
      await this.decide(executor)
    })
  }

  private async deleted(id: string): Promise<void> {
    const of = this.reviewers.get(id)
    if (of) {
      this.reviewers.delete(id)
      await this.guarded(of.executor, 'reviewer-gone', async () => {
        const live = this.journals.live(of.executor)
        const step = live?.state.step
        if (!live || step?.what !== 'review' || step.key !== of.key) return
        await this.append(of.executor, live, { by: 'rpm', kind: 'fail', step: step.step, reason: 'reviewer-gone', detail: 'the reviewer session was deleted' })
        await this.decide(of.executor)
      })
      return
    }
    if (!this.journals.loaded().some((e) => e.id === id)) return
    // The executor is gone (§12): stop what runs for it, let its clones go, drop its directory.
    await this.journals.serial(id, async () => {
      const step = this.journals.live(id)?.state.step
      if (step) this.cancelled.add(step.key)
      if (step?.what === 'check') await this.checks.get(id)?.stop().catch(() => undefined)
      if (step?.what === 'review') {
        const rid = this.reviewerFor(step.key)
        if (rid) void this.ports.sessions.stopContainer(rid).catch(() => undefined)
      }
      this.ports.sessions.keepAlive(id, false)
      this.ports.sessions.release(id)
      const dir = this.journals.dirOf(id)
      this.journals.forget(id)
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true }).catch((err: unknown) => this.warn(`rpm: rm ${dir}: ${String(err)}`))
    })
  }

  private async copied(from: string, to: string): Promise<void> {
    await this.journals
      .serial(to, () => this.journals.writeConfig(to, this.journals.config(from)))
      .catch((err: unknown) => this.warn(`rpm: copy config ${from} → ${to}: ${String(err)}`))
  }

  private poll(): void {
    for (const e of this.journals.loaded()) {
      const live = this.journals.live(e.id)
      if (!live) continue
      const run = live.state
      if (run.step?.what === 'review') {
        const rid = this.reviewerFor(run.step.key)
        const plan = rid ? this.ports.sessions.info(rid)?.planHoldUntil : undefined
        if (this.plans.get(e.id) !== plan) {
          this.plans.set(e.id, plan)
          this.journals.emit(e.id, run.run)
        }
      } else if (!run.step && (run.called === 'check-red' || run.called === 'check-unchanged') && run.lastCheck) {
        // A new check command in Settings → Repos while you are called about the check runs it (t1v6 §3).
        const f = this.ports.sessions.info(e.id)
        if (!f) continue
        const now = this.ports.check.commands(f.ws, run.base.map((b) => b.repo))
        const key = (c: { repo: string; command: string }[]): string => c.map((x) => `${x.repo}\0${x.command}`).sort().join('\n')
        if (key(now) !== key(run.lastCheck.commands)) void this.boundary(e.id)
      }
    }
  }

  // --- the boundary ----------------------------------------------------------------------------

  /** Decide and act (inside `serial`). */
  private async decide(executor: string): Promise<void> {
    const live = this.journals.live(executor)
    if (!live) return
    const run = live.state
    if (run.step) return
    // A check that may still run blocks everything: no new step, no release (§7, §12).
    if (!(await this.ensureStopped(executor, live))) {
      if (run.called) this.ports.sessions.keepAlive(executor, false)
      else await this.call(executor, live, 'check-error')
      return
    }
    if (!run.config.enabled) return this.finish(executor, live, 'disabled')
    const f = this.ports.sessions.info(executor)
    if (!f) return
    const repos = run.base.map((b) => b.repo)
    const checks = this.ports.check.commands(f.ws, repos)
    const trees = await this.ports.git.trees(f.ws, f.task, repos)
    const tree = treeId(trees)
    const n = next(run, { tree, checks })
    switch (n.do) {
      case 'wait':
        this.ports.sessions.keepAlive(executor, false)
        return
      case 'check': {
        const e = await this.step(executor, live, { what: 'check', rule: run.rerun === 'check' ? 'rerun' : '2', tree })
        this.effect(this.runCheck(executor, live.rec.n, e, checks, repos))
        return
      }
      case 'fix-check': {
        const e = await this.step(executor, live, { what: 'executor', rule: '3в', tree, items: [] })
        this.effect(this.sendExecutor(executor, live.rec, e))
        return
      }
      case 'executor': {
        const e = await this.step(executor, live, { what: 'executor', rule: '9', tree, items: n.items })
        this.effect(this.sendExecutor(executor, live.rec, e))
        return
      }
      case 'review': {
        const e = await this.step(executor, live, {
          what: 'review',
          rule: run.rerun === 'review' ? 'rerun' : '6',
          tree,
          full: n.full,
          items: n.verify
        })
        this.effect(this.runReview(executor, live.rec, e, f, checks.length > 0))
        return
      }
      case 'call':
        return this.call(executor, live, n.why)
      case 'mark':
        return this.mark(executor, live, f, trees, tree)
    }
  }

  private async step(executor: string, live: Live, body: { what: 'check' | 'review' | 'executor'; rule: '2' | '3в' | '6' | '9' | 'rerun'; tree: TreeId; full?: boolean; items?: string[] }): Promise<EntryOf<'step'>> {
    const step = live.state.lastStep + 1
    return (await this.append(executor, live, { by: 'rpm', kind: 'step', step, key: keyOf(executor, live.rec.n, step), ...body })) as EntryOf<'step'>
  }

  private async call(executor: string, live: Live, why: CallReason): Promise<void> {
    const before = live.state
    const e = (await this.append(executor, live, { by: 'rpm', kind: 'call', why })) as EntryOf<'call'>
    this.ports.sessions.keepAlive(executor, false)
    this.ports.sessions.chatLine(executor, chatLines.call(before, e))
    const yours = before.findings.filter((f) => tracked(before, f) && ownerOf(f.state) === 'you')
    this.ports.notify.notify({
      sessionId: executor,
      kind: 'called',
      text: calledText(before, why, yours.length),
      open: { filter: 'you', ...(yours.length === 1 && yours[0] && { finding: yours[0].id }) }
    })
  }

  private async mark(executor: string, live: Live, f: SessionFacts, trees: RepoTree[], tree: TreeId): Promise<void> {
    const run = live.state
    const repos = await Promise.all(
      run.base.map(async (b) => {
        const t = trees.find((x) => x.repo === b.repo)
        const d = await this.ports.git.diff(f.ws, f.task, b.repo, b.commit, 0)
        return { repo: b.repo, base: b.commit, head: t?.head ?? '', tree: t?.tree ?? '', files: d.files }
      })
    )
    // §9: the files must describe the marked tree. Changed meanwhile (Files view, terminal) — decide again.
    if (treeId(await this.ports.git.trees(f.ws, f.task, run.base.map((b) => b.repo))) !== tree) return this.decide(executor)
    const counts = { closed: 0, rejected: 0, deferred: 0, below: 0 }
    for (const x of run.findings) {
      if (!tracked(run, x)) counts.below++
      else if (x.state === 'closed' || x.state === 'rejected' || x.state === 'deferred') counts[x.state]++
    }
    const mark: ReviewMark = {
      executor,
      run: run.run,
      at: new Date(this.clock.now()).toISOString(),
      tree,
      repos,
      reviews: run.reviews,
      findings: counts
    }
    const e = (await this.append(executor, live, { by: 'rpm', kind: 'mark', mark })) as EntryOf<'mark'>
    this.ports.sessions.keepAlive(executor, false)
    this.ports.sessions.release(executor)
    this.ports.sessions.chatLine(executor, chatLines.mark(fold(live.rec.entries), e))
    const files = repos.reduce((n, r) => n + r.files.length, 0)
    this.ports.notify.notify({ sessionId: executor, kind: 'passed', text: `Review passed · marked ${files} file${files === 1 ? '' : 's'}`, open: {} })
  }

  private async finish(executor: string, live: Live, why: 'stopped' | 'disabled', comment?: string): Promise<void> {
    await this.append(executor, live, { by: 'rpm', kind: 'end', why, ...(comment && { comment }) })
    this.ports.sessions.keepAlive(executor, false)
    this.ports.sessions.release(executor)
  }

  /**
   * `stop` (§6.3): interrupt the running step, then `end stopped`. Call it
   * inside `serial`, in the same write as the `command stop` entry, so no
   * result recorded in between can start the next step.
   * A check whose stop is not confirmed (§7, §12) does not end the run:
   * `fail check-error`, you are called, the clones stay held.
   */
  async stopLocked(executor: string): Promise<void> {
    try {
      await this.doStop(executor)
    } catch (e) {
      this.warn(`rpm: stop ${executor}: ${errText(e)}`)
    }
  }

  private async doStop(executor: string): Promise<void> {
    const live = this.journals.live(executor)
    if (!live) return
    const step = live.state.step
    if (step) this.cancelled.add(step.key)
    if (step?.what === 'check') {
      const h = this.checks.get(executor)
      // After a restart there is no handle: stop the executor's container itself, with confirmation.
      const r = h?.key === step.key ? await h.stop().catch((err: unknown) => ({ ok: false, detail: errText(err) })) : await this.confirmStop(executor)
      if (!r.ok) {
        await this.append(executor, live, { by: 'rpm', kind: 'fail', step: step.step, reason: 'check-error', detail: `${UNCONFIRMED}: ${r.detail ?? 'unknown'}` })
        // One more try (docker inspect again); still not down — you are called, the clones stay held.
        if (!(await this.ensureStopped(executor, live))) return this.call(executor, live, 'check-error')
      }
    } else if (!step && !(await this.ensureStopped(executor, live))) {
      // An earlier check is still not confirmed stopped: the run cannot end and let its clones go.
      return this.call(executor, live, 'check-error')
    } else if (step?.what === 'review') {
      const rid = this.reviewerFor(step.key)
      if (rid) void this.ports.sessions.stopContainer(rid).catch((err: unknown) => this.warn(`rpm: stop reviewer ${rid}: ${String(err)}`))
    } else if (step?.what === 'executor') {
      // TODO(rpm): a message still in the queue (`queued`) stays there; there is no port to take it back.
      if (this.ports.sessions.sent(executor, step.key) === 'taken') {
        void this.ports.sessions.cancelTurn(executor).catch((err: unknown) => this.warn(`rpm: cancel ${executor}: ${String(err)}`))
      }
    }
    await this.finish(executor, live, 'stopped')
  }

  // --- effects -------------------------------------------------------------------------------------

  private async runCheck(executor: string, n: number, e: EntryOf<'step'>, checks: { repo: string; command: string }[], repos: string[]): Promise<void> {
    this.ports.sessions.keepAlive(executor, true)
    const runs: CheckRun[] = []
    try {
      for (const c of checks) {
        if (this.cancelled.has(e.key) || !this.isStep(executor, n, e.key)) return
        const h = this.ports.check.run(executor, c.repo, c.command)
        this.checks.set(executor, { key: e.key, stop: () => h.stop() })
        runs.push(await h.done)
      }
    } catch (err) {
      // A container not confirmed stopped (a timeout) is the same gate as an unconfirmed Stop: `ensureStopped`.
      const unconfirmed = (err as { unconfirmed?: unknown } | undefined)?.unconfirmed === true
      const detail = unconfirmed ? `${UNCONFIRMED}: ${errText(err)}` : errText(err)
      await this.record(executor, n, e.key, () => ({ by: 'rpm', kind: 'fail', step: e.step, reason: 'check-error', detail }))
      return
    } finally {
      if (this.checks.get(executor)?.key === e.key) this.checks.delete(executor)
      this.ports.sessions.keepAlive(executor, false)
    }
    await this.record(executor, n, e.key, async () => {
      // The tree AFTER the check, by contract (t1v6 §3, t3v2 §12): a check that edits files (lint --fix) is not rerun.
      // An edit from the Files view during the check cannot be told apart from that, so it is credited the same way.
      const f = this.ports.sessions.info(executor)
      const tree = f ? treeId(await this.ports.git.trees(f.ws, f.task, repos)) : e.tree
      const ok = runs.every((r) => r.code === 0 && !r.timedOut)
      return { by: 'check', kind: 'check', step: e.step, tree, ok, runs }
    })
  }

  private async runReview(executor: string, rec: RunRec, e: EntryOf<'step'>, f: SessionFacts, hasChecks: boolean): Promise<void> {
    try {
      const run = fold(rec.entries)
      const lastCheck = [...rec.entries].reverse().find((x): x is EntryOf<'check'> => x.kind === 'check')
      const input: ReviewerInput = {
        task: this.ports.sessions.userPrompts(executor, this.prevRunEnd(executor, rec.n)),
        diffs: await Promise.all(run.base.map(async (b) => ({ repo: b.repo, ...(await this.ports.git.diff(f.ws, f.task, b.repo, b.commit, DIFF_MAX)) }))),
        check: hasChecks && lastCheck ? { ok: lastCheck.ok, runs: lastCheck.runs } : 'not-configured',
        verify: e.items ?? [],
        full: e.full ?? true
      }
      const prompt = reviewerPrompt(run, input)
      if (this.cancelled.has(e.key) || !this.isStep(executor, rec.n, e.key)) return // stopped while the diff was read
      const id = await this.ports.sessions.createReviewer({
        key: e.key,
        executor,
        agent: run.config.reviewer.agent,
        options: run.config.reviewer.options,
        title: `review R${run.reviews + 1} — ${f.title}`,
        prompt,
        line: chatLines.reviewStep(run, e, prompt)
      })
      this.reviewers.set(id, { executor, key: e.key })
      if (this.cancelled.has(e.key) || !this.isStep(executor, rec.n, e.key)) {
        // A stop overlapped the creation: the reviewer stays, its container goes (§6.3).
        void this.ports.sessions.stopContainer(id).catch((err: unknown) => this.warn(`rpm: stop reviewer ${id}: ${String(err)}`))
        return
      }
      this.journals.emit(executor, rec.n) // the status now knows the reviewer
    } catch (err) {
      await this.record(executor, rec.n, e.key, () => ({ by: 'rpm', kind: 'fail', step: e.step, reason: 'reviewer-failed', detail: errText(err) }))
    }
  }

  /** The host message of an executor step: the findings (9), or the check's output (3в). */
  private async sendExecutor(executor: string, rec: RunRec, e: EntryOf<'step'>): Promise<void> {
    const i = rec.entries.findIndex((x) => x.seq === e.seq)
    const before = fold(rec.entries.slice(0, i))
    const withStep = fold(rec.entries.slice(0, i + 1))
    let text: string
    let line
    if (e.rule === '3в') {
      const runs = [...rec.entries.slice(0, i)].reverse().find((x): x is EntryOf<'check'> => x.kind === 'check')?.runs ?? []
      text = checkMessage(runs)
      line = chatLines.checkRed(withStep, e, runs, text)
    } else {
      text = executorMessage(before, e.items ?? [], before.pendingNotes)
      line = chatLines.executorStep(withStep, e, text)
    }
    try {
      await this.ports.sessions.send(executor, { key: e.key, text, line })
    } catch (err) {
      // TODO(rpm): the step stays running until a restart re-sends it (recover: `sent` = unknown).
      this.warn(`rpm: send to ${executor} (${e.key}): ${errText(err)}`)
    }
  }

  // --- recording results (inside serial) --------------------------------------------------------------

  /** An executor turn: with its step when RPM started it, without one when you did. */
  private async recordTurn(executor: string, live: Live, t: SettledTurn): Promise<void> {
    if (t.outcome === 'limited') return
    const step = live.state.step
    let stepNo: number | undefined
    if (t.origin === 'rpm') {
      // A replayed or stale turn of an older step changes nothing.
      if (step?.what !== 'executor' || step.key !== t.key) return
      stepNo = step.step
    } else if (t.origin !== 'user') {
      // TODO(rpm): 'other' turns (a wake) are not journaled; the next boundary sees their tree.
      return
    }
    const f = this.ports.sessions.info(executor)
    if (!f) return
    const tree = treeId(await this.ports.git.trees(f.ws, f.task, live.state.base.map((b) => b.repo)))
    const e = (await this.append(executor, live, {
      by: 'executor',
      kind: 'turn',
      ...(stepNo !== undefined && { step: stepNo }),
      turnId: t.turnId,
      origin: t.origin,
      tree,
      outcome: t.outcome,
      ...(t.reason && { reason: t.reason }),
      replies: lastReplies(t.tools)
    })) as EntryOf<'turn'>
    const after = fold(live.rec.entries)
    for (const line of chatLines.turn(after, e)) this.ports.sessions.chatLine(executor, line)
  }

  /** A reviewer turn: `review` from its last accepted `submit_review`, or `fail reviewer-failed`. */
  private async recordReview(executor: string, live: Live, reviewer: string, t: SettledTurn): Promise<void> {
    const step = live.state.step
    if (step?.what !== 'review' || step.key !== t.key) return
    const sub = [...t.tools].reverse().find((x) => x.name === 'submit_review')?.payload as
      | { findings: { severity: 'blocker' | 'major' | 'minor' | 'nit'; file?: string; line?: number; claim: string; scenario: string }[]; verify: { id: string; accept: boolean; comment: string }[] }
      | undefined
    if (!sub) {
      await this.append(executor, live, { by: 'rpm', kind: 'fail', step: step.step, reason: 'reviewer-failed', detail: `the reviewer's turn ended (${t.outcome}) without submit_review` })
      return
    }
    const base = live.state.findings.length
    const e = (await this.append(executor, live, {
      by: 'reviewer',
      kind: 'review',
      step: step.step,
      tree: step.tree,
      full: step.full ?? true,
      findings: sub.findings.map((x, i) => ({ ...x, id: `F${base + i + 1}` })),
      verify: sub.verify
    })) as EntryOf<'review'>
    this.ports.sessions.chatLine(reviewer, chatLines.review(fold(live.rec.entries), e))
  }

  // --- helpers --------------------------------------------------------------------------------------------

  /** §6.1: open a run on an executor turn with changes. */
  private async startRun(executor: string, f: SessionFacts, t: SettledTurn): Promise<void> {
    const repos = f.writeRepos
    if (!repos.length) return // TODO(rpm): an executor without write repos has nothing to review.
    const cp = this.ports.sessions.checkpointBefore(executor, t.turnId) ?? []
    const prevMark = [...this.journals.runs(executor)].reverse().flatMap((r) => r.entries.filter((x): x is EntryOf<'mark'> => x.kind === 'mark'))[0]?.mark
    let trees: RepoTree[] | undefined
    const base: { repo: string; commit: string }[] = []
    for (const repo of repos) {
      // TODO(rpm): the mark's HEAD, not its tree — a known, deferred gap by owner decision (t3v2 §6.1, «Решение владельца»).
      const commit = cp.find((c) => c.repo === repo)?.commit ?? prevMark?.repos.find((r) => r.repo === repo)?.head
      if (commit) {
        base.push({ repo, commit })
        continue
      }
      trees ??= await this.ports.git.trees(f.ws, f.task, repos)
      // TODO(rpm): an unborn repo has no HEAD; its diff will fail and the review with it.
      base.push({ repo, commit: trees.find((x) => x.repo === repo)?.head ?? '' })
    }
    await this.journals.startRun(executor, { turnId: t.turnId, base, config: this.journals.config(executor) })
    this.ports.sessions.hold(executor)
    await this.decide(executor)
  }

  /** The turn that closed the previous run (§6.1): the reviewer's task is what was typed after it. */
  private prevRunEnd(executor: string, n: number): string | undefined {
    const prev = this.journals.runs(executor).filter((r) => r.n < n).at(-1)
    if (!prev) return undefined
    let id: string | undefined
    for (const e of prev.entries) if (e.kind === 'turn' || e.kind === 'start') id = e.turnId
    return id
  }

  /** Stop the executor's container with confirmation; a throw counts as unconfirmed. */
  private confirmStop(executor: string): Promise<{ ok: boolean; detail?: string }> {
    return this.ports.check.stopContainer(executor).catch((err: unknown) => ({ ok: false, detail: errText(err) }))
  }

  /** True unless an unconfirmed check stop is pending and still cannot be confirmed. */
  private async ensureStopped(executor: string, live: Live): Promise<boolean> {
    const seq = unconfirmedStop(live.rec.entries)
    if (seq === undefined) return true
    const id = `${executor}:${live.rec.n}:${seq}`
    if (this.confirmed.has(id)) return true
    const r = await this.confirmStop(executor)
    if (!r.ok) {
      this.warn(`rpm: ${executor}: ${UNCONFIRMED}: ${r.detail ?? 'unknown'}`)
      return false
    }
    this.confirmed.add(id)
    return true
  }

  private reviewerFor(key: string): string | undefined {
    for (const [id, of] of this.reviewers) if (of.key === key) return id
    return undefined
  }

  private scanReviewers(): void {
    for (const id of this.ports.sessions.list()) {
      const of = this.ports.sessions.info(id)?.reviewerOf
      if (of) this.reviewers.set(id, of)
    }
  }

  private isStep(executor: string, n: number, key: string): boolean {
    const live = this.journals.live(executor)
    return live?.rec.n === n && live.state.step?.key === key
  }

  /** Record a step's result if that step is still the running one, then decide. */
  private record(executor: string, n: number, key: string, build: () => NewEntry | Promise<NewEntry>): Promise<void> {
    return this.guarded(executor, 'record', async () => {
      const live = this.journals.live(executor)
      if (!live || live.rec.n !== n || live.state.step?.key !== key) return
      await this.append(executor, live, await build())
      await this.decide(executor)
    })
  }

  private append(executor: string, live: Live, e: NewEntry): Promise<Entry> {
    return this.journals.append(executor, live.rec, e)
  }

  /** `serial` that logs instead of throwing: an engine failure must not break the caller (an event, your entry). */
  private guarded(executor: string, what: string, fn: () => Promise<void>): Promise<void> {
    return this.journals.serial(executor, fn).catch((err: unknown) => this.warn(`rpm: ${what} ${executor}: ${errText(err)}`))
  }

  /** An effect runs outside `serial`; its failure is logged. */
  private effect(p: Promise<void>): void {
    p.catch((err: unknown) => this.warn(`rpm: effect: ${errText(err)}`))
  }
}

/** For each finding the last reply of the turn counts (§5.1). */
function lastReplies(tools: SettledTurn['tools']): { id: string; act: ReplyAct; comment: string }[] {
  const byId = new Map<string, { id: string; act: ReplyAct; comment: string }>()
  for (const t of tools) {
    if (t.name !== 'reply_findings') continue
    const p = t.payload as { replies?: { id: string; act: ReplyAct; comment: string }[] }
    for (const r of p.replies ?? []) {
      byId.delete(r.id)
      byId.set(r.id, { id: r.id, act: r.act, comment: r.comment })
    }
  }
  return [...byId.values()]
}

/** §11: «Review waits for you · …». */
function calledText(run: RunState, why: CallReason, yours: number): string {
  const tail: Record<CallReason, string> = {
    findings: `${yours} finding${yours === 1 ? '' : 's'}`,
    'check-red': `check failed ${run.sinceYou.redChecks} times`,
    'check-unchanged': 'check failed, code unchanged',
    budget: `${run.sinceYou.reviews} reviews without you`,
    'idle-executor': 'the executor made no progress',
    'executor-failed': 'executor failed',
    'executor-blocked': 'executor blocked',
    'reviewer-failed': 'reviewer failed',
    'check-error': 'check could not run'
  }
  return `Review waits for you · ${tail[why]}`
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
