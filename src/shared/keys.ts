// Centralized entity-key derivation, shared by main and renderer.
//
// Names double as disk paths and as identity, so the `${ws}/${task}/${env}`
// template used to be hand-built in several files. Keeping every derivation
// here makes a future name→id migration a one-file change.

import type { EnvRef } from './types'

export const taskKey = (ws: string, task: string): string => `${ws}/${task}`

export const envKey = (ref: EnvRef): string =>
  `${ref.workspace}/${ref.task}/${ref.env}`

/** One ACP connection (adapter process) per (env, agent). */
export const connKey = (ref: EnvRef, agent: string): string => `${envKey(ref)}::${agent}`

/** One host MCP server per (env, mcp id). */
export const mcpServerKey = (ref: EnvRef, mcpId: string): string => `${envKey(ref)}::${mcpId}`
