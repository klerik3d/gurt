// Usage ledger: the append-only record of every agent turn gurt ran — what
// the dashboard's sessions board reads for finishes and failures. A plain bus
// subscriber, same shape as the notifications one in notifications.ts.
//
// Scope note: a turn is filed against the *agent instance* that served it, not
// the session, and records outlive the session that produced them — the quota
// it consumed was spent whether or not the session still exists. Deleting a
// session therefore does not delete its turns.
import type { Bus } from './bus'
import type { TurnRecord } from '../shared/usage'
import { DAY } from '../shared/usage'
import * as store from './store'
import { createLogger } from './log'

const log = createLogger('usage')

/** How far back the ledger is kept. Nine weeks — enough history for any
 *  per-window view a card may grow, while keeping the file bounded. */
export const USAGE_RETENTION_MS = 63 * DAY

/** Prune only when the ledger has drifted a full day past retention, so a busy
 *  day doesn't rewrite the whole file on every turn. */
const PRUNE_SLACK_MS = DAY

export interface UsageLedger {
  /** Every retained turn, oldest first. */
  list(): TurnRecord[]
  /** Settles once the on-disk ledger is loaded (and pruned). Never rejects. */
  ready: Promise<void>
}

export function createUsageLedger(bus: Bus, now: () => number = Date.now): UsageLedger {
  /** Kept sorted by `ts`: the file is append-ordered and turns are filed at
   *  their end, so pushes are already in order. */
  let records: TurnRecord[] = []
  /** Disk writes are chained inside the store; this only keeps the ledger from
   *  pruning while a prune it already started is still in flight. */
  let pruning = false

  const cutoff = (): number => now() - USAGE_RETENTION_MS

  const prune = (): void => {
    if (pruning) return
    const keep = records.filter((r) => Date.parse(r.ts) >= cutoff())
    if (keep.length === records.length) return
    records = keep
    pruning = true
    store
      .writeUsage(keep)
      .catch((e) => log.error('internal.fail', { site: 'usage-prune', err: e }))
      .finally(() => {
        pruning = false
      })
  }

  const ready = (async () => {
    const loaded = await store.readUsage()
    // Merge rather than assign: a turn can finish between this read starting
    // and it landing, and that record is already in `records`.
    const seen = new Set(records.map((r) => `${r.ts}|${r.sessionId}`))
    records = [...loaded.filter((r) => !seen.has(`${r.ts}|${r.sessionId}`)), ...records].sort(
      (a, b) => a.ts.localeCompare(b.ts)
    )
    prune()
    bus.emit('usage.changed', undefined)
  })().catch((e) => log.error('internal.fail', { site: 'usage-load', err: e }))

  bus.on('agent.turn', (record) => {
    records.push(record)
    store
      .appendUsage([record])
      .catch((e) => log.error('internal.fail', { site: 'usage-append', err: e }))
    // The oldest record is the cheap test for "worth rewriting the file".
    if (records.length && Date.parse(records[0].ts) < cutoff() - PRUNE_SLACK_MS) prune()
    bus.emit('usage.changed', undefined)
  })

  return {
    list: () => records.slice(),
    ready
  }
}
