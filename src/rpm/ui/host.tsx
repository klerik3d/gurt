// What rpm/ui needs from the app (t3v2 §3.3): the IPC methods, the link
// callbacks and the app's own components that RPM may not import (rpm/ui does
// not import src/renderer — t3v2 §1). The renderer builds one `RpmHost` per
// session pane and provides it with `RpmHostProvider`.
import { createContext, useContext, type ComponentType, type ReactNode } from 'react'
import type { GurtApi, GurtEvents } from '../../shared/api'
import type { RpmConfig } from '../core'
import type { Filter } from './labels'

/** Where `openReview` lands (t2v3 D): the run, the row to open, the quick filter. */
export interface ReviewFocus {
  /** The run the finding ids belong to; none = the last run. */
  run?: number
  finding?: string
  filter?: Filter
}

/** The `window.gurt.rpm*` methods (t3v2 §3.2) and the `rpm` event. */
export type RpmApi = Pick<
  GurtApi,
  'rpmRuns' | 'rpmState' | 'rpmConfig' | 'rpmSetConfig' | 'rpmVerdict' | 'rpmSeverity' | 'rpmNote' | 'rpmCommand'
> & {
  onRpm(cb: (event: GurtEvents['rpm']) => void): () => void
}

/** Step 2 of the reviewer pick (t2v3 A): the client, then its options with
 *  the session's own `OptionBlock`. The app renders it: the client list and
 *  the option views are app code. It renders the "Reviewer" field (label with
 *  `info` behind the "i", the client row), then one field per option.
 *  `agent: ''` = not chosen yet: the app offers a client other than the
 *  executor's (t2v3 A). */
export interface ReviewerFieldsProps {
  executor: string
  value: RpmConfig['reviewer']
  info: string
  /** Why the chosen client cannot review (`RpmHost.reviewerProblem`); shown at the field (t3v2 §12). */
  problem: string | undefined
  onChange: (value: RpmConfig['reviewer']) => void
}

export interface RpmHost {
  api: RpmApi
  /** `<repo>/<path>` of the executor's scope, opened in the File view. */
  openFile: (path: string, line?: number) => void
  /** A session's chat, scrolled to this entry. */
  openChat: (sessionId: string, entryId: number) => void
  /** A session's chat, scrolled to the RPM line of this journal entry (`ChatSystem.rpm`): an
   *  incoming handoff has no `HistoryItem.chat` while its step runs (t2v3 D). */
  openChatLine: (sessionId: string, line: { executor: string; run: number; seq: number }) => void
  /** The executor's Review tab, focused (t2v3 D: an F-number, the badge, a notification). */
  openReview: (executor: string, focus: ReviewFocus) => void
  /** The Diff view of a scope, filtered to these files (`<repo>/<path>`) —
   *  "marked N files" (t2v3 D, t3v2 §3.3). */
  openDiff: (ws: string, task: string, files: string[]) => void
  /** The scope an executor lives in (for `openDiff`); undefined when the app does not know it. */
  scopeOf: (executor: string) => { ws: string; task: string } | undefined
  /** The app's dialog; resolves to whether the user agreed. */
  confirm: (text: string, opts: { title: string; confirmText: string; danger?: boolean }) => Promise<boolean>
  /** Why this client cannot be the reviewer (none chosen, gone, denied, does
   *  not receive gurt's tools — t2v3 A), or undefined when it can. */
  reviewerProblem: (agent: string) => string | undefined
  InfoDot: ComponentType<{ text: string }>
  ReviewerFields: ComponentType<ReviewerFieldsProps>
}

const HostContext = createContext<RpmHost | null>(null)

export function RpmHostProvider({ host, children }: { host: RpmHost; children: ReactNode }) {
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>
}

/** The host, or null where the app provides none (an archived chat): links and popups are off there. */
export function useRpmHostOptional(): RpmHost | null {
  return useContext(HostContext)
}

export function useRpmHost(): RpmHost {
  const host = useContext(HostContext)
  if (!host) throw new Error('rpm/ui: no RpmHostProvider above this component')
  return host
}
