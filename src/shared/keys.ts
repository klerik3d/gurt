// Centralized entity-key derivation, shared by main and renderer.
//
// Names double as disk paths and as identity, so the `${ws}/${task}/${session}`
// template used to be hand-built in several files. Keeping every derivation
// here makes a future name→id migration a one-file change.

import type { EnvRef } from './types'

export const taskKey = (ws: string, task: string): string => `${ws}/${task}`

/** An env instance belongs to exactly one session, so the session is its identity. */
export const envKey = (ref: EnvRef): string =>
  `${ref.workspace}/${ref.task}/${ref.session}`

/** One ACP connection (adapter process) per session's container (and agent). */
export const connKey = (ref: EnvRef, agent: string): string => `${envKey(ref)}::${agent}`

/** One host MCP server per (session, mcp id). */
export const mcpServerKey = (ref: EnvRef, mcpId: string): string => `${envKey(ref)}::${mcpId}`
