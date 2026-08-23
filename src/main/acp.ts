// Schemas for everything an ACP adapter sends us.
//
// The adapter is a subprocess we do not control: its stdout is untrusted input,
// and jsonrpc.ts only guarantees that a line was a well-formed JSON-RPC frame —
// `params` and `result` arrive as `unknown` on purpose. This is where they stop
// being unknown. Nothing below reaches into a payload without parsing it first.
//
// Two rules shape these schemas:
//  - Tolerant, not strict. ACP evolves and adapters differ (claude-code, codex,
//    opencode …), so every object is loose (unknown members ride along), every
//    field the app does not need is optional, and a cosmetic field that arrives
//    with the wrong type degrades to `undefined` via `.catch()` instead of
//    failing the whole payload. A newer agent must never break an older gurt.
//  - Payloads are never logged. A parse failure is reported by path and issue
//    code (see `issuePaths`); the values are prompt text, agent output and tool
//    arguments.
import { z } from 'zod'
import type { SessionConfigOption } from '../shared/types'
import { issuePaths } from './jsonrpc'
import { createLogger } from './log'

const log = createLogger('acp')

/** A cosmetic string: absent, null, or the wrong type all read as "not set",
 *  so a label gurt only displays cannot cost it the payload carrying it. */
const soft = z.string().nullish().catch(undefined)

/**
 * Parse a payload gurt is about to act on, dropping it when it does not match.
 * Dropping is the pre-schema behavior for anything unrecognized (the update
 * switch has always ignored kinds it does not know), so a shape change in an
 * adapter degrades exactly as before instead of throwing into the read loop.
 */
export function parseOrDrop<T>(schema: z.ZodType<T>, value: unknown, what: string): T | undefined {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  log.debug('acp.dropped', { what, at: issuePaths(parsed.error) })
  return undefined
}

// ---------------------------------------------------------------------------
// Session modes and config options
// ---------------------------------------------------------------------------

export const MODES = z.looseObject({
  currentModeId: z.string(),
  availableModes: z.array(z.looseObject({ id: z.string(), name: z.string() })).default([])
})

/** One entry of a `select` option: either a plain value or a group of them. */
const CONFIG_SELECT_ITEM = z.looseObject({
  value: z.string().optional(),
  name: soft,
  description: soft,
  options: z
    .array(z.looseObject({ value: z.string().optional(), name: soft, description: soft }))
    .optional()
})

/**
 * One ACP `SessionConfigOption`. `id`/`name`/`type` carry the option's identity
 * and are required — an entry missing them is the "malformed entry" the
 * normalizer has always skipped.
 */
export const CONFIG_OPTION = z.looseObject({
  id: z.string(),
  name: z.string(),
  description: soft,
  category: soft,
  type: z.enum(['boolean', 'select']),
  currentValue: z.unknown(),
  options: z.array(CONFIG_SELECT_ITEM).optional()
})
export type AcpConfigOption = z.infer<typeof CONFIG_OPTION>

/** The `configOptions` member of every response that carries one. Items stay
 *  `unknown` so one malformed entry is skipped rather than dropping the list. */
export const CONFIG_OPTIONS = z.array(z.unknown()).optional()

// ---------------------------------------------------------------------------
// Request results
// ---------------------------------------------------------------------------

export const INITIALIZE_RESULT = z.looseObject({
  agentCapabilities: z
    .looseObject({
      promptCapabilities: z
        .looseObject({
          image: z.boolean().optional(),
          audio: z.boolean().optional(),
          embeddedContext: z.boolean().optional()
        })
        .optional()
    })
    .optional()
})

/** `session/new`. The session id is the one field with no fallback: without it
 *  there is no session to prompt, so a response without it must fail loudly. */
export const SESSION_NEW_RESULT = z.looseObject({
  sessionId: z.string(),
  modes: MODES.optional(),
  configOptions: CONFIG_OPTIONS
})

export const SESSION_LOAD_RESULT = z.looseObject({
  modes: MODES.optional(),
  configOptions: CONFIG_OPTIONS
})

export const SET_CONFIG_OPTION_RESULT = z.looseObject({ configOptions: CONFIG_OPTIONS })

export const PROMPT_RESULT = z.looseObject({ stopReason: soft })

// ---------------------------------------------------------------------------
// session/update notification
// ---------------------------------------------------------------------------

/** The envelope of a `session/update`: which session, and which variant. The
 *  variant's own payload is parsed per case, so one unknown or malformed
 *  variant cannot cost the session the updates around it. */
export const SESSION_UPDATE = z.looseObject({
  // Required: an update that names no session addresses nothing. (It used to
  // match a session that had not started yet — both sides `undefined`.)
  sessionId: z.string(),
  update: z.looseObject({ sessionUpdate: z.string().optional() }).optional()
})

/** Tool-call content blocks, as flattened into the timeline preview. */
const TOOL_CONTENT = z.array(
  z.looseObject({
    type: soft,
    path: soft,
    newText: soft,
    content: z.looseObject({ type: soft, text: soft }).optional()
  })
)
export type AcpToolContent = z.infer<typeof TOOL_CONTENT>

export const TEXT_CHUNK = z.looseObject({
  content: z.looseObject({ type: soft, text: soft }).optional()
})

export const TOOL_CALL = z.looseObject({
  // The correlation key: a call without one can never be updated, and a
  // `tool_call_update` without one matches no entry.
  toolCallId: z.string(),
  title: soft,
  kind: soft,
  status: soft,
  content: TOOL_CONTENT.optional()
})

export const PLAN_UPDATE = z.looseObject({
  entries: z
    .array(z.looseObject({ content: z.string(), priority: soft, status: z.string() }))
    .default([])
})

export const COMMANDS_UPDATE = z.looseObject({
  availableCommands: z
    .array(z.looseObject({ name: z.string(), description: soft }))
    .default([])
})

export const MODE_UPDATE = z.looseObject({ currentModeId: z.string() })

export const CONFIG_OPTION_UPDATE = z.looseObject({ configOptions: CONFIG_OPTIONS })

/** Context-window accounting. `used`/`size` are the meter itself — a report
 *  without them is not a usage update. */
export const USAGE_UPDATE = z.looseObject({
  used: z.number(),
  size: z.number(),
  cost: z
    .looseObject({ amount: z.number(), currency: z.string() })
    .nullish()
    .catch(undefined)
})

// ---------------------------------------------------------------------------
// session/request_permission
// ---------------------------------------------------------------------------

export const PERMISSION_REQUEST = z.looseObject({
  sessionId: z.string(),
  toolCall: z.looseObject({ title: soft }).optional(),
  options: z
    .array(z.looseObject({ optionId: z.string(), name: soft, kind: soft }))
    .default([])
})

/** Re-exported so callers name the type they normalize into in one place. */
export type NormalizedConfigOption = SessionConfigOption
