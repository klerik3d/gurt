// createRpm (t3v2 §3.1): the journals and config on disk, your entries
// (verdict, severity, note, command, config), the reads (runs, state, marks),
// what other parts of the app ask (owns, quiets, stepRunning), the model tools,
// and the engine (engine.ts): subscriptions, steps, recovery.
import {
  fold,
  move,
  view,
  type ChatRef,
  type Entry,
  type EntryOf,
  type HistoryItem,
  type ReviewMark,
  type RpmBrief,
  type RpmCommand,
  type RpmConfig,
  type RpmState,
  type RunSummary,
  type Severity,
  type VerdictTo
} from '../core'
import type { Clock, Rpm } from './api'
import { Engine } from './engine'
import { Journals, type RunRec } from './journals'
import type { RpmPorts } from './ports'
import { createTools } from './tools'
import { treeId } from './trees'

const SEVERITIES: readonly Severity[] = ['blocker', 'major', 'minor', 'nit']
const REVIEWS = [1, 2, 3, 5, 10]
const VERDICT_STATE = { must: 'must', reject: 'rejected', defer: 'defer' } as const

export const systemClock: Clock = {
  now: () => Date.now(),
  every(ms, fn) {
    const t = setInterval(fn, ms)
    t.unref?.()
    return () => clearInterval(t)
  }
}

export function createRpmImpl(ports: RpmPorts, opts?: { clock?: Clock; warn?: (msg: string) => void }): Rpm {
  const clock = opts?.clock ?? systemClock
  const warn = opts?.warn ?? ((msg: string) => console.warn(msg))
  const journals = new Journals(ports, clock, warn)
  const engine = new Engine(ports, journals, clock, warn)

  /** Your entry into the live run: checked inside the executor's write queue; then the engine acts on it. */
  async function yours(executor: string, build: (run: ReturnType<typeof fold>) => Parameters<Journals['append']>[2]): Promise<void> {
    const entry = await journals.serial(executor, async (): Promise<Entry> => {
      const live = journals.live(executor)
      if (!live) throw new Error(journals.last(executor) ? 'The run is over.' : 'There is no review run for this session.')
      const e = await journals.append(executor, live.rec, build(live.state))
      // Stop acts in this same write: nothing queued behind it may start a step first.
      if (e.kind === 'command' && e.cmd === 'stop') await engine.stopLocked(executor)
      return e
    })
    await engine.afterYou(executor, entry)
  }

  const finding = (run: ReturnType<typeof fold>, id: string) => {
    const f = run.findings.find((x) => x.id === id)
    if (!f) throw new Error(`No such finding: ${id}.`)
    return f
  }

  const summary = (rec: RunRec): RunSummary => {
    const run = fold(rec.entries)
    return {
      run: rec.n,
      startedAt: rec.entries[0]?.at ?? '',
      result: run.ended === 'passed' ? 'passed' : run.ended ? 'ended' : 'live',
      findings: run.findings.length,
      reviews: run.reviews
    }
  }

  /** `HistoryItem.chat` (t3v2 §3.2): a reviewer's move → its `review` line in the reviewer's chat, an
   *  executor's move → its `turn` line in the executor's chat. Matched by (executor, run, seq) and the
   *  finding: a turn writes one line to the reviewer and another to you, both with the turn's seq. */
  const withChat = (state: RpmState): RpmState => {
    const bySeq = new Map(state.journal.map((e) => [e.seq, e]))
    const refs = new Map<string, ReturnType<RpmPorts['sessions']['chatRefs']>>()
    const refsOf = (id: string) => {
      let r = refs.get(id)
      if (!r) refs.set(id, (r = ports.sessions.chatRefs(id)))
      return r
    }
    let reviewerOfKey: Map<string, string> | undefined
    const reviewer = (key: string): string | undefined => {
      if (!reviewerOfKey) {
        reviewerOfKey = new Map()
        for (const id of ports.sessions.list()) {
          const k = ports.sessions.info(id)?.reviewerOf?.key
          if (k) reviewerOfKey.set(k, id)
        }
      }
      return reviewerOfKey.get(key)
    }
    const chatOf = (id: string, h: HistoryItem): ChatRef | undefined => {
      const e = bySeq.get(h.seq)
      const session =
        h.by === 'reviewer' && e?.kind === 'review' ? reviewer(`${state.executor}:${state.run}:${e.step}`)
        : h.by === 'executor' && e?.kind === 'turn' ? state.executor
        : undefined
      if (!session) return undefined
      const same = refsOf(session).filter((r) => r.executor === state.executor && r.run === state.run && r.seq === h.seq)
      // The line that names this finding; a review line names only some (new ones, verified ones) — then the first.
      const ref = same.find((r) => r.items.includes(id)) ?? same[0]
      return ref && { sessionId: session, entryId: ref.entryId }
    }
    return {
      ...state,
      findings: state.findings.map((f) => ({
        ...f,
        history: f.history.map((h) => {
          const chat = h.chat ?? chatOf(f.id, h)
          return chat ? { ...h, chat } : h
        })
      }))
    }
  }

  const liveFor = (sessionId: string): boolean => journals.live(sessionId) !== undefined

  return {
    async load() {
      for (const id of ports.sessions.list()) {
        if (ports.sessions.info(id)?.role === 'executor') journals.get(id)
      }
      engine.holdLive()
    },
    recover: () => engine.recover(),
    start: () => engine.start(),
    stop: () => engine.stop(),

    runs: (executor) => journals.runs(executor).map(summary),
    state(executor, n) {
      const rec = n === undefined ? journals.last(executor) : journals.runs(executor).find((r) => r.n === n)
      return rec ? withChat(engine.decorate(view(fold(rec.entries), rec.entries))) : undefined
    },
    config: (executor) => journals.config(executor),
    overview: () =>
      ports.sessions.list().flatMap((executor): RpmBrief[] => {
        if (ports.sessions.info(executor)?.role !== 'executor') return []
        const enabled = journals.config(executor).enabled
        const rec = journals.last(executor)
        if (!rec) return [{ executor, enabled, live: false }]
        // The status only, but through the same view and decoration as
        // `state`, so the two never disagree (`waitingPlan` is the engine's).
        const { live, status } = engine.decorate(view(fold(rec.entries), rec.entries))
        return [{ executor, enabled, live, status }]
      }),
    async setConfig(executor, patch) {
      checkPatch(patch)
      await journals.serial(executor, async () => {
        const cur = journals.config(executor)
        // The same client: the patch's options land on the stored ones, so a pick that
        // sends only its own option (the Review tab's) keeps the picks made before it,
        // also those whose refresh the pane has not seen yet. Another client starts
        // from the patch's options alone.
        const reviewer = patch.reviewer && {
          agent: patch.reviewer.agent,
          options: patch.reviewer.agent === cur.reviewer.agent ? { ...cur.reviewer.options, ...patch.reviewer.options } : { ...patch.reviewer.options }
        }
        const next: RpmConfig = { ...cur, ...patch, ...(reviewer && { reviewer }) }
        await journals.writeConfig(executor, next)
        const live = journals.live(executor)
        if (live) await journals.append(executor, live.rec, { by: 'you', kind: 'config', patch: { ...patch, ...(reviewer && { reviewer }) } })
        else journals.emit(executor, journals.last(executor)?.n ?? 0)
      })
      // A patch is your entry: at a boundary it is acted on now (e.g. `end disabled`).
      await engine.boundary(executor)
    },
    verdict: (executor, id, to: VerdictTo, comment) =>
      yours(executor, (run) => {
        if (!(to in VERDICT_STATE)) throw new Error(`Unknown verdict: ${String(to)}.`)
        const f = finding(run, id)
        if (f.state === VERDICT_STATE[to]) throw new Error(`The verdict does not change: ${id} is already ${f.state}.`)
        if (move(f, 'you', { verdict: to }, run.config) === 'not-allowed') throw new Error(`${id}: this verdict is not possible now.`)
        return { by: 'you', kind: 'verdict', id, to, ...(comment?.trim() && { comment: comment.trim() }) }
      }),
    severity: (executor, id, to, comment) =>
      yours(executor, (run) => {
        if (!SEVERITIES.includes(to)) throw new Error(`Unknown severity: ${String(to)}.`)
        const f = finding(run, id)
        if (f.severity === to) throw new Error(`The severity does not change: ${id} is already ${to}.`)
        return { by: 'you', kind: 'severity', id, to, ...(comment?.trim() && { comment: comment.trim() }) }
      }),
    note: (executor, text) =>
      yours(executor, () => {
        const t = text.trim()
        if (!t) throw new Error('The note is empty.')
        return { by: 'you', kind: 'note', text: t }
      }),
    command: (executor, cmd: RpmCommand) =>
      yours(executor, (run) => {
        if (cmd === 'pause' && run.paused) throw new Error('The run is already paused.')
        // Resume is also Continue on a call (t3v2 §12, t2v3 B): like any entry of yours it lifts
        // `called`, and the boundary after it goes on or repeats the failed step.
        if (cmd === 'resume' && !run.paused && !run.called && !run.failed) throw new Error('The run is neither paused nor waiting for you.')
        if (!['pause', 'resume', 'stop', 'rerun-check', 'rerun-review'].includes(cmd)) throw new Error(`Unknown command: ${String(cmd)}.`)
        return { by: 'you', kind: 'command', cmd }
      }),

    tools: createTools(ports, journals),
    owns: (id) => ports.sessions.info(id)?.role === 'reviewer' || liveFor(id),
    quiets: (id) => ports.sessions.info(id)?.role === 'reviewer' || liveFor(id),
    stepRunning(ws, task) {
      // TODO(rpm): only executors already loaded (load() reads them all) are looked at.
      return journals.loaded().some((e) => {
        const f = ports.sessions.info(e.id)
        return f?.ws === ws && f.task === task && journals.live(e.id)?.state.step !== undefined
      })
    },
    marks: (executor) =>
      journals
        .runs(executor)
        .flatMap((r) => r.entries.filter((e): e is EntryOf<'mark'> => e.kind === 'mark').map((e): ReviewMark => e.mark)),
    async markHolds(mark) {
      const f = ports.sessions.info(mark.executor)
      if (!f) return false
      const trees = await ports.git.trees(f.ws, f.task, mark.repos.map((r) => r.repo))
      return treeId(trees) === mark.tree
    },
    onChange: (fn) => journals.onChange(fn)
  }
}

/** A config patch from IPC: known keys with valid values only. */
function checkPatch(patch: Partial<RpmConfig>): void {
  if (!patch || typeof patch !== 'object') throw new Error('The config patch is not an object.')
  for (const [k, v] of Object.entries(patch)) {
    switch (k) {
      case 'enabled':
        if (typeof v !== 'boolean') throw new Error('enabled must be true or false.')
        break
      case 'threshold':
        if (!SEVERITIES.includes(v as Severity)) throw new Error(`threshold must be one of ${SEVERITIES.join(', ')}.`)
        break
      case 'attempts':
        if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 5) throw new Error('attempts must be 1..5.')
        break
      case 'reviews':
        if (!REVIEWS.includes(v as number)) throw new Error(`reviews must be one of ${REVIEWS.join(', ')}.`)
        break
      case 'reviewer': {
        const r = v as RpmConfig['reviewer']
        if (!r || typeof r !== 'object' || typeof r.agent !== 'string' || !r.options || typeof r.options !== 'object') {
          throw new Error('reviewer must be { agent, options }.')
        }
        break
      }
      default:
        throw new Error(`Unknown config field: ${k}.`)
    }
  }
}
