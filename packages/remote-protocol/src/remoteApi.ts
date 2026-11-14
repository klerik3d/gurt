// The remote API (requirements-remote-protocol.md §7): what the app may call
// on Gurt, in the app's own types. Not a mirror of Gurt's `GurtApi` — a method
// exists here because a screen of the app needs it (design-mobile-app.md §7),
// and a `GurtApi` method that is not listed is simply unreachable.
//
// Phase 1 only. Phase 2 and 3 methods are added when they are built; each one
// is feature-detected from `RemoteHello.methods`.
//
// Conventions:
// - params are always an object of named parameters (`{}` when there are none);
// - a result the protocol tables show as "—" is `null`;
// - optional fields are absent rather than `null`;
// - unknown fields are ignored by the receiver (§2), so fields are only ever
//   added within one API version.

import type { NotificationType, PushPlatform } from './frames'

/** Remote API version Gurt speaks, and the oldest app API version it serves
 *  (§7.1). Integers, bumped only by an incompatible change. */
export const REMOTE_API_VERSION = 1
export const REMOTE_API_MIN = 1

export type NoParams = Record<string, never>

// ------------------------------------------------------------- shared shapes

/** The desktop's session status (Gurt's `SessionStatus`): `running` is
 *  "working", `waiting` is "needs you", `idle-read` is "seen". */
export type RemoteSessionStatus = 'draft' | 'queued' | 'starting' | 'running' | 'waiting' | 'idle' | 'idle-read'

export type RemoteSessionRole = 'executor' | 'researcher' | 'reviewer' | 'operator' | 'proactive'

/** One session row of the tree. */
export interface RemoteSessionRow {
  id: string
  title: string
  status: RemoteSessionStatus
  role: RemoteSessionRole
  /** The agent's display name. Absent on a draft with no agent yet. */
  agent?: string
  /** One line of the latest activity, plain text. */
  activity?: string
  /** The turn ended without `complete`, or the last start failed. */
  problem?: string
}

export interface RemoteScope {
  name: string
  /** ISO timestamp; the desktop orders scopes by it. */
  createdAt: string
  sessions: RemoteSessionRow[]
}

export interface RemoteWorkspace {
  name: string
  scopes: RemoteScope[]
}

/** `tree.get`: workspaces → scopes → sessions. */
export interface RemoteTree {
  workspaces: RemoteWorkspace[]
}

/** A chat entry as the app sees it: the desktop's timeline entry, with a tool
 *  call's output left out (fetched on expand with `session.entry`). */
export type RemoteChatEntry = {
  id: number
  /** Epoch ms the entry was created. */
  at?: number
  /** Epoch ms it finished (last chunk of a text, terminal status of a tool). */
  endAt?: number
} & (
  | { kind: 'user' | 'agent' | 'thought'; text: string }
  | {
      kind: 'tool'
      toolCallId: string
      title: string
      status: string
      /** ACP tool kind: read | edit | execute | search | fetch | … */
      toolKind?: string
      /** There is output to fetch with `session.entry`. */
      hasDetail?: boolean
    }
  | { kind: 'system'; text: string }
  | {
      kind: 'permission'
      title: string
      options: RemotePermissionOption[]
      /** The option picked (or `auto` / `cancelled`) once answered. */
      chosen?: string
      /** What exactly is being confirmed, when Gurt itself asks. */
      detail?: string
    }
)

/** One session-log record (requirements-session-log.md), as the app applies
 *  it. Every record is applied exactly once: the app drops a record whose
 *  `seq` is not above the `lastSeq` it holds (§7.5). Unknown record types are
 *  ignored. */
export type RemoteLogRecord =
  | { seq: number; type: 'entry'; entry: RemoteChatEntry }
  | { seq: number; type: 'append'; id: number; text: string; at?: number }
  | {
      seq: number
      type: 'patch'
      id: number
      patch: { status?: string; title?: string; chosen?: string; endAt?: number; hasDetail?: boolean }
    }

export interface RemotePermissionOption {
  optionId: string
  name: string
  /** ACP option kind: allow_once | allow_always | reject_once | reject_always.
   *  An `allow_always` answer needs `confirm: true`. */
  kind?: string
}

/** The permission prompt a session is stopped on. */
export interface RemotePermissionPrompt {
  /** Names this prompt in `permission.answer`; a different prompt pending
   *  later has a different id. */
  promptId: string
  /** The timeline entry that shows it. */
  entryId: number
  title: string
  /** The whole request — command, paths, diff preview — never truncated. */
  detail?: string
  /** In the agent's order and words. */
  options: RemotePermissionOption[]
}

export interface RemotePlanEntry {
  content: string
  status: string
  priority?: string
}

/** A prompt accepted but not yet run, oldest first. */
export interface RemoteQueuedPrompt {
  id: string
  text: string
  /** How many images ride with it. */
  images?: number
  /** The "continue" a session cut off by a plan limit sends by itself. */
  auto?: true
}

/** `session.get`: one page of the chat and the session's current state. */
export interface RemoteSessionPage {
  session: RemoteSessionRow & { workspace: string; scope: string }
  /** Oldest first, ending just before `before` (or at the end). */
  entries: RemoteChatEntry[]
  /** Older entries exist before the first one here. */
  hasMore: boolean
  /** `seq` of the last log record folded into this state (§7.5). */
  logSeq: number
  plan?: RemotePlanEntry[]
  queue?: RemoteQueuedPrompt[]
  /** 1-based position in Gurt's queue while the session is queued. */
  queuePosition?: number
  /** Why a queued or waiting session is not moving (clone busy, plan limit). */
  waiting?: string
  permission?: RemotePermissionPrompt
  /** Context-window usage, when the agent reports it. */
  usage?: { used: number; size: number }
}

/** `session.entry`: one entry's expanded output. */
export interface RemoteEntryDetail {
  entryId: number
  /** Flattened tool output or diff, plain text. */
  detail: string
}

/** A "needs you" item: the desktop's notification. */
export interface RemoteInboxItem {
  id: string
  type: NotificationType
  sessionId: string
  workspace: string
  scope: string
  sessionTitle: string
  detail: string
  /** ISO timestamp. */
  ts: string
  read: boolean
}

// ----------------------------------------------------------------- the API

/** Phase 1 of the remote API (§7.2). */
export interface RemoteApi {
  'tree.get'(params: NoParams): Promise<RemoteTree>
  /** `before`: an entry id; the page ends just before it. `limit`: entries per
   *  page, Gurt's default when absent and capped by Gurt. */
  'session.get'(params: { id: string; before?: number; limit?: number }): Promise<RemoteSessionPage>
  'session.entry'(params: { id: string; entryId: number }): Promise<RemoteEntryDetail>
  /** A repeated `clientMsgId` is a no-op that answers like the first call. */
  'session.send'(params: { id: string; clientMsgId: string; text: string }): Promise<{ queued: boolean }>
  'session.cancelQueued'(params: { id: string; queueItemId: string }): Promise<null>
  'session.stop'(params: { id: string }): Promise<null>
  /** `-32010` when `promptId` is not the pending prompt; `-32011` for an
   *  `allow_always` option without `confirm: true`. */
  'permission.answer'(params: {
    sessionId: string
    promptId: string
    optionId: string
    confirm?: boolean
  }): Promise<null>
  /** Newest first. */
  'inbox.list'(params: NoParams): Promise<{ items: RemoteInboxItem[] }>
  'inbox.markRead'(params: { ids: string[] } | { all: true }): Promise<null>
  /** The calling device removes itself (remote-access §5.3). */
  'host.unpair'(params: NoParams): Promise<null>
}

export type RemoteMethod = keyof RemoteApi
export type RemoteParams<M extends RemoteMethod> = Parameters<RemoteApi[M]>[0]
export type RemoteResult<M extends RemoteMethod> = Awaited<ReturnType<RemoteApi[M]>>

/** Every phase 1 method. A unit test pins this list, so adding a method is a
 *  deliberate diff (remote-access §6.2). */
export const REMOTE_API_METHODS = [
  'tree.get',
  'session.get',
  'session.entry',
  'session.send',
  'session.cancelQueued',
  'session.stop',
  'permission.answer',
  'inbox.list',
  'inbox.markRead',
  'host.unpair'
] as const satisfies readonly RemoteMethod[]

// Compile-time: the list names every method of the interface.
type _Exhaustive = Exclude<RemoteMethod, (typeof REMOTE_API_METHODS)[number]> extends never ? true : never
const _exhaustive: _Exhaustive = true
void _exhaustive

// ------------------------------------------------------------------ events

export type HostState = 'restarting'

/** The forwarded event set (§7.4): name → payload. */
export interface RemoteEvents {
  /** Refetch `tree.get`. Carries no payload. */
  'tree-changed': undefined
  /** Status, plan, queue or pending prompt changed — refetch `session.get`'s
   *  head, or apply what the app already has. */
  'session-changed': { id: string }
  'session-log': { id: string; record: RemoteLogRecord }
  notification: RemoteInboxItem
  'notification-read': { ids: string[] }
  /** Sent before Gurt closes streams with reason 5. */
  'host-state': { state: HostState }
}

export type RemoteEventName = keyof RemoteEvents

export const REMOTE_EVENTS = [
  'tree-changed',
  'session-changed',
  'session-log',
  'notification',
  'notification-read',
  'host-state'
] as const satisfies readonly RemoteEventName[]

type _EventsExhaustive = Exclude<RemoteEventName, (typeof REMOTE_EVENTS)[number]> extends never ? true : never
const _eventsExhaustive: _EventsExhaustive = true
void _eventsExhaustive

/** `remote.event` params: `{"ch":"<event>","p":<payload>}`; `p` is absent
 *  for an event with no payload. */
export type RemoteEventMessage = {
  [E in RemoteEventName]: RemoteEvents[E] extends undefined ? { ch: E } : { ch: E; p: RemoteEvents[E] }
}[RemoteEventName]

// ------------------------------------------------- remote.* (the channel)

/** `remote.hello`, Gurt's first message on a connect-mode stream (§7.1). */
export interface RemoteHello {
  v: number
  /** Gurt's version. */
  gurt: string
  api: { version: number; min: number }
  device: { id: string; name: string }
  host: { name: string }
  methods: string[]
  events: string[]
}

export type PairingState =
  | { state: 'pending' }
  | { state: 'accepted'; deviceId: string }
  | { state: 'rejected' }
  | { state: 'expired' }

/** Notifications Gurt → App. */
export interface RemoteChannelNotifications {
  'remote.hello': RemoteHello
  'remote.pairing': PairingState
  'remote.event': RemoteEventMessage
}

/** Requests App → Gurt about the channel itself (§7.3). */
export interface RemoteChannelApi {
  /** Per open session, the last `seq` the app applied → `ok` (the records
   *  after it follow as `session-log` events) or `reset` (refetch). */
  'remote.resume'(params: { sessions: Record<string, number> }): Promise<Record<string, 'ok' | 'reset'>>
  'remote.ping'(params: NoParams): Promise<NoParams>
  'remote.pushRegister'(params: { platform: PushPlatform; token: string }): Promise<NoParams>
  'remote.pushUnregister'(params: NoParams): Promise<NoParams>
}

export const REMOTE_CHANNEL_METHODS = [
  'remote.resume',
  'remote.ping',
  'remote.pushRegister',
  'remote.pushUnregister'
] as const satisfies readonly (keyof RemoteChannelApi)[]

export type ApiCompatibility = { ok: true } | { ok: false; update: 'gurt' | 'app' }

/**
 * Whether two API ranges overlap (§7.1, remote-access §7.2). Each side
 * speaks `version` and still serves down to `min`. When they do not overlap,
 * the side with the lower `version` is the one to update.
 */
export function apiCompatibility(
  host: { version: number; min: number },
  app: { version: number; min: number } = { version: REMOTE_API_VERSION, min: REMOTE_API_MIN }
): ApiCompatibility {
  if (host.min <= app.version && app.min <= host.version) return { ok: true }
  return { ok: false, update: host.version < app.version ? 'gurt' : 'app' }
}
