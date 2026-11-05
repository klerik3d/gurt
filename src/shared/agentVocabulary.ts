// What a session's agent says, compiled for the core's engines: how it names
// its modes, titles its MCP tool calls and words a plan-limit refusal
// (`AgentManifest.modes` / `toolTitles` / `limits`). The engines themselves —
// the mode picker (main/sessions.ts and the renderer's pickers), the tool-title
// reader (ToolStrip, the gurt-tools auto-allow) and the limit detector
// (shared/usage.ts) — are core and take one of these; a kind with no
// vocabulary gets the empty one, and they run on the core's own plain words
// alone.
import type { SessionMode } from './types'
import { agentDef } from './agents'

/** Mode words, the core's plain ones merged with the kind's own. */
export interface ModeWords {
  /** `_meta.kind` values of an auto-review mode. */
  autoReviewKinds: readonly string[]
  /** Lowercase words marking a blanket bypass mode. */
  bypass: readonly string[]
}

/** The plan-limit wording of one kind, beyond the generic patterns
 *  shared/usage.ts always applies. */
export interface LimitPatterns {
  errors: readonly RegExp[]
  replies: readonly RegExp[]
  /** Group 1 is a unix stamp. */
  resetStamps: readonly RegExp[]
}

export interface Vocabulary {
  modes: ModeWords
  /** Group 1 the server, group 2 the tool. */
  toolTitles: readonly RegExp[]
  limits: LimitPatterns
}

/** The core's own blanket-bypass word. */
const BYPASS = 'bypass'
/** Words of an auto(-accepting) mode the core reads for every kind, the
 *  blanket ones aside. */
export const AUTO_WORDS: readonly string[] = ['accept', 'auto']
/** Words of a manual mode the core reads for every kind. */
export const MANUAL_WORDS: readonly string[] = ['default', 'manual', 'ask', 'confirm']

export const NO_LIMITS: LimitPatterns = { errors: [], replies: [], resetStamps: [] }

const EMPTY: Vocabulary = {
  modes: { autoReviewKinds: [], bypass: [BYPASS] },
  toolTitles: [],
  limits: NO_LIMITS
}

const compiled = new Map<string, Vocabulary>()

/** The vocabulary of one kind — the empty one for a kind no plugin knows.
 *  Compiled once per kind. */
export function agentVocabulary(kind: string | undefined): Vocabulary {
  const def = kind ? agentDef(kind) : undefined
  if (!def) return EMPTY
  const hit = compiled.get(def.id)
  if (hit) return hit
  const ci = (sources: readonly string[] | undefined): RegExp[] => (sources ?? []).map((s) => new RegExp(s, 'i'))
  const vocab: Vocabulary = {
    modes: {
      autoReviewKinds: def.modes?.autoReviewKinds ?? [],
      bypass: [BYPASS, ...(def.modes?.bypassWords ?? [])]
    },
    toolTitles: (def.toolTitles ?? []).map((s) => new RegExp(s)),
    limits: {
      errors: ci(def.limits?.errors),
      replies: ci(def.limits?.replies),
      resetStamps: ci(def.limits?.resetStamps)
    }
  }
  compiled.set(def.id, vocab)
  return vocab
}

/** Whether a mode's id or name has one of these words in it. */
export const modeHas = (m: Pick<SessionMode, 'id' | 'name'>, words: readonly string[]): boolean => {
  const k = `${m.id} ${m.name}`.toLowerCase()
  return words.some((w) => k.includes(w))
}

/**
 * Blanket permission-bypass modes. They disable every guardrail, so the pickers
 * hide them — gurt's "auto" already maps to the safer auto-review/accept-edits
 * mode. Kept out of the UI, not the protocol: the agent may still report one
 * as current.
 */
export const isBlanketMode = (m: SessionMode, words: ModeWords): boolean => modeHas(m, words.bypass)

/** An MCP tool call's server and tool, read off its title — undefined when the
 *  title is not one. */
export function mcpToolOf(
  title: string,
  patterns: readonly RegExp[]
): { server: string; tool: string } | undefined {
  for (const re of patterns) {
    const m = re.exec(title)
    if (m?.[1] && m[2]) return { server: m[1], tool: m[2] }
  }
  return undefined
}
