// createRpm (t3v2 §3.1) without the engine (task 9): the journals and config on
// disk, your entries (verdict, severity, note, command, config), the reads
// (runs, state, marks), what other parts of the app ask (owns, quiets,
// stepRunning) and the model tools. `recover`, `start` and `stop` do nothing yet.
import {
  fold,
  move,
  view,
  type EntryOf,
  type ReviewMark,
  type RpmCommand,
  type RpmConfig,
  type RunSummary,
  type Severity,
  type VerdictTo
} from '../core'
import type { Clock, Rpm } from './api'
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

  /** Your entry into the live run: checked inside the executor's write queue. */
  function yours(executor: string, build: (run: ReturnType<typeof fold>) => Parameters<Journals['append']>[2]): Promise<void> {
    return journals.serial(executor, async () => {
      const live = journals.live(executor)
      if (!live) throw new Error(journals.last(executor) ? 'The run is over.' : 'There is no review run for this session.')
      await journals.append(executor, live.rec, build(live.state))
    })
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

  const liveFor = (sessionId: string): boolean => journals.live(sessionId) !== undefined

  return {
    async load() {
      for (const id of ports.sessions.list()) {
        if (ports.sessions.info(id)?.role === 'executor') journals.get(id)
      }
    },
    async recover() {
      // TODO(rpm): task 9 (§8.2).
    },
    start() {
      // TODO(rpm): task 9 — subscriptions and the reviewer's plan-limit poll.
    },
    stop() {
      // TODO(rpm): task 9.
    },

    runs: (executor) => journals.runs(executor).map(summary),
    state(executor, n) {
      const rec = n === undefined ? journals.last(executor) : journals.runs(executor).find((r) => r.n === n)
      return rec ? view(fold(rec.entries), rec.entries) : undefined
    },
    config: (executor) => journals.config(executor),
    async setConfig(executor, patch) {
      checkPatch(patch)
      await journals.serial(executor, async () => {
        const cur = journals.config(executor)
        const next: RpmConfig = { ...cur, ...patch, ...(patch.reviewer && { reviewer: { ...patch.reviewer } }) }
        await journals.writeConfig(executor, next)
        const live = journals.live(executor)
        if (live) await journals.append(executor, live.rec, { by: 'you', kind: 'config', patch })
        else journals.emit(executor, journals.last(executor)?.n ?? 0)
      })
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
        if (cmd === 'resume' && !run.paused) throw new Error('The run is not paused.')
        if (!['pause', 'resume', 'stop', 'rerun-check', 'rerun-review'].includes(cmd)) throw new Error(`Unknown command: ${String(cmd)}.`)
        // TODO(rpm): task 9 acts on it — stop interrupts the step and writes `end stopped`, the rest decide at the boundary.
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
