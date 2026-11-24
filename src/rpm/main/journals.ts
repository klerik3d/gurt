// The journals in memory, over disk.ts: per executor its config and its runs.
// Loaded lazily per executor (or all at once by `Rpm.load`); every write goes
// through `serial(executor, …)` so `seq` is assigned in order and a check
// against the state sees every earlier write.
//
// RPM keeps no paths: the directory is `store.dir(ws, task)/<executor>` with
// ws/task taken from `SessionsPort.info` at every use (a renamed scope moves it).
import path from 'node:path'
import { DEFAULT_CONFIG, fold, type Entry, type NewEntry, type RpmConfig, type RunState } from '../core'
import { appendEntry, listRuns, readConfig, readJournal, runFile, writeConfig } from './disk'
import type { Clock } from './api'
import type { RpmPorts } from './ports'

export interface RunRec {
  n: number
  entries: Entry[]
}

export interface ExecRec {
  id: string
  config: Partial<RpmConfig> | undefined
  runs: RunRec[]
}

export class Journals {
  private execs = new Map<string, ExecRec>()
  private chains = new Map<string, Promise<unknown>>()
  private listeners = new Set<(e: { executor: string; run: number }) => void>()

  constructor(
    private ports: RpmPorts,
    private clock: Clock,
    private warn: (msg: string) => void
  ) {}

  /** `<store>/<executor>` now, or undefined when the session is unknown. */
  dirOf(executor: string): string | undefined {
    const f = this.ports.sessions.info(executor)
    return f ? path.join(this.ports.store.dir(f.ws, f.task), executor) : undefined
  }

  /** The executor's record, read from disk on first use. An unknown session gives an empty record (not cached). */
  get(executor: string): ExecRec {
    const cached = this.execs.get(executor)
    if (cached) return cached
    const dir = this.dirOf(executor)
    if (!dir) return { id: executor, config: undefined, runs: [] }
    const rec = this.read(executor, dir)
    this.execs.set(executor, rec)
    return rec
  }

  loaded(): ExecRec[] {
    return [...this.execs.values()]
  }

  forget(executor: string): void {
    this.execs.delete(executor)
  }

  private read(executor: string, dir: string): ExecRec {
    const runs: RunRec[] = []
    for (const n of listRuns(dir)) {
      try {
        const { entries, brokenAt } = readJournal(runFile(dir, n), this.warn)
        if (entries[0]?.kind !== 'start') {
          this.warn(`rpm: ${runFile(dir, n)}: no start entry, skipped`)
          continue
        }
        if (brokenAt !== undefined && !fold(entries).ended) {
          // §8.1: a broken line in the middle — the run is shown up to it and is over.
          // TODO(rpm): the end is in memory only; it is not written to the journal.
          const last = entries[entries.length - 1]
          entries.push({
            seq: (last?.seq ?? 0) + 1,
            at: new Date(this.clock.now()).toISOString(),
            by: 'rpm',
            comment: `the journal is broken at line ${brokenAt}`,
            kind: 'end',
            why: 'stopped'
          })
        }
        runs.push({ n, entries })
      } catch (err) {
        this.warn(`rpm: ${runFile(dir, n)}: ${String(err)}`)
      }
    }
    return { id: executor, config: readConfig(dir, this.warn), runs }
  }

  config(executor: string): RpmConfig {
    const c = this.get(executor).config
    return { ...DEFAULT_CONFIG, ...c, reviewer: { ...DEFAULT_CONFIG.reviewer, ...c?.reviewer } }
  }

  async writeConfig(executor: string, config: RpmConfig): Promise<void> {
    const dir = this.dirOf(executor)
    if (!dir) throw new Error('no such session')
    await writeConfig(dir, config)
    this.get(executor).config = config
  }

  /** The executor's runs that have their `start` written. */
  runs(executor: string): RunRec[] {
    return this.get(executor).runs.filter((r) => r.entries.length > 0)
  }

  last(executor: string): RunRec | undefined {
    const runs = this.runs(executor)
    return runs[runs.length - 1]
  }

  /** The live run (the last one, not ended) and its fold. */
  live(executor: string): { rec: RunRec; state: RunState } | undefined {
    const rec = this.last(executor)
    if (!rec) return undefined
    const state = fold(rec.entries)
    return state.ended ? undefined : { rec, state }
  }

  /** Run `fn` after every earlier write of this executor. */
  serial<T>(executor: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(executor) ?? Promise.resolve()
    const p = prev.then(fn, fn)
    this.chains.set(executor, p.catch(() => undefined))
    return p
  }

  /** Append an entry to run `rec` (call inside `serial`): stamps seq/at, writes, then updates memory. */
  async append(executor: string, rec: RunRec, e: NewEntry): Promise<Entry> {
    const dir = this.dirOf(executor)
    if (!dir) throw new Error('no such session')
    const last = rec.entries[rec.entries.length - 1]
    const entry = { ...e, seq: (last?.seq ?? 0) + 1, at: new Date(this.clock.now()).toISOString() }
    await appendEntry(runFile(dir, rec.n), entry)
    rec.entries.push(entry)
    this.emit(executor, rec.n)
    return entry
  }

  /** Open run n+1 with its `start` entry (call inside `serial`). For the engine (task 9). */
  async startRun(
    executor: string,
    start: { turnId: string; base: { repo: string; commit: string }[]; config: RpmConfig }
  ): Promise<RunRec> {
    const exec = this.get(executor)
    const n = (exec.runs[exec.runs.length - 1]?.n ?? 0) + 1
    const rec: RunRec = { n, entries: [] }
    exec.runs.push(rec)
    try {
      await this.append(executor, rec, { by: 'rpm', kind: 'start', executor, run: n, ...start })
    } catch (err) {
      exec.runs.pop()
      throw err
    }
    return rec
  }

  onChange(fn: (e: { executor: string; run: number }) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  emit(executor: string, run: number): void {
    for (const fn of this.listeners) {
      try {
        fn({ executor, run })
      } catch (err) {
        this.warn(`rpm: onChange listener: ${String(err)}`)
      }
    }
  }
}
