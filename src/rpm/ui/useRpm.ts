// useRpm (t3v2 §3.3): an executor's review state over IPC, re-read on every
// `rpm` event for that executor.
import { useCallback, useEffect, useState } from 'react'
import type { RpmConfig, RpmState, RunSummary } from '../core'
import { useRpmHost } from './host'

export interface RpmData {
  /** False until the first read for this executor/run answered. */
  loaded: boolean
  /** The run asked for, or the last one; undefined when there is none yet. */
  state: RpmState | undefined
  runs: RunSummary[]
  /** The executor's settings (also for a draft): what the next run starts with. */
  config: RpmConfig | undefined
  error: string | undefined
}

const EMPTY: RpmData = { loaded: false, state: undefined, runs: [], config: undefined, error: undefined }

export function useRpm(executor: string, run?: number): RpmData & { reload: () => void } {
  const { api } = useRpmHost()
  const [data, setData] = useState<RpmData & { key: string }>({ ...EMPTY, key: '' })
  const [tick, setTick] = useState(0)
  const key = `${executor}:${run ?? ''}`

  useEffect(() => {
    let live = true
    let seq = 0
    const load = (): void => {
      const mine = ++seq
      Promise.all([api.rpmState(executor, run), api.rpmRuns(executor), api.rpmConfig(executor)])
        .then(([state, runs, config]) => {
          if (live && mine === seq) setData({ key, loaded: true, state, runs, config, error: undefined })
        })
        .catch((e: unknown) => {
          if (live && mine === seq)
            setData((d) => ({ ...d, key, loaded: true, error: e instanceof Error ? e.message : String(e) }))
        })
    }
    load()
    const off = api.onRpm((e) => {
      if (e.executor === executor) load()
    })
    return () => {
      live = false
      off()
    }
  }, [api, executor, run, key, tick])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  // A read for another executor/run is not shown while the new one loads.
  const shown = data.key === key ? data : EMPTY
  return { loaded: shown.loaded, state: shown.state, runs: shown.runs, config: shown.config, error: shown.error, reload }
}
