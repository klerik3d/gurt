import type {
  ConfigSelectOption,
  SessionConfigOption,
  SessionInfo,
  SessionMode,
  SessionModes
} from '../../shared/types'
import { AUTO_WORDS, MANUAL_WORDS, agentVocabulary, modeHas, type ModeWords } from '../../shared/agentVocabulary'
import { agentMain } from '../agentPlugins'
import { CONFIG_OPTION, MODES } from '../acp'

/**
 * Normalize ACP `SessionConfigOption[]` into our flat shape. `select` options may be
 * either a flat list or grouped under headers — we inline groups (prefixing each label
 * with its group name) so the renderer sees one flat option list. Malformed entries are
 * skipped. Returns undefined when the agent reports no config options at all.
 */
/** `kind` is the reporting session's: its plugin's `normalizeConfigOptions`
 *  gets the last word over the list; a kind without one keeps it exactly as
 *  reported. */
export function normalizeConfigOptions(
  raw: unknown,
  kind?: string
): SessionConfigOption[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: SessionConfigOption[] = []
  for (const item of raw) {
    // Per entry, not per list: one option the agent reports in a shape we do
    // not recognize is skipped, the rest of its selectors still reach the UI.
    const o = CONFIG_OPTION.safeParse(item)
    if (!o.success) continue
    // Absent, not `undefined`: these records are persisted and shipped over
    // IPC, where a key present only to say "nothing" is noise.
    const common = {
      id: o.data.id,
      name: o.data.name,
      ...(o.data.description ? { description: o.data.description } : {}),
      ...(o.data.category ? { category: o.data.category } : {})
    }
    if (o.data.type === 'boolean') {
      out.push({ ...common, type: 'boolean', currentValue: !!o.data.currentValue })
    } else {
      const flat: ConfigSelectOption[] = []
      for (const entry of o.data.options ?? []) {
        if (entry.options) {
          for (const v of entry.options)
            if (v.value !== undefined)
              flat.push({
                value: v.value,
                name: `${entry.name ?? ''} · ${v.name ?? v.value}`,
                ...(v.description ? { description: v.description } : {})
              })
        } else if (entry.value !== undefined) {
          flat.push({
            value: entry.value,
            name: entry.name ?? entry.value,
            ...(entry.description ? { description: entry.description } : {})
          })
        }
      }
      out.push({
        ...common,
        type: 'select',
        currentValue: typeof o.data.currentValue === 'string' ? o.data.currentValue : '',
        options: flat
      })
    }
  }
  return agentMain(kind)?.normalizeConfigOptions?.(out) ?? out
}

/** The mode's `_meta.kind`, if it reports one. ACP's `_meta` is a free-form
 *  envelope the schema keeps but does not type, so it is read defensively —
 *  an adapter that puts a `kind` straight on the mode is honored too. */
function modeKind(raw: Record<string, unknown>): string | undefined {
  const meta = raw['_meta']
  const fromMeta =
    meta && typeof meta === 'object' ? (meta as Record<string, unknown>)['kind'] : undefined
  const kind = typeof fromMeta === 'string' ? fromMeta : raw['kind']
  return typeof kind === 'string' && kind ? kind : undefined
}

/** Normalize an ACP `session/new`/`session/load` mode report into our shape:
 *  the same modes, with `_meta.kind` lifted onto each one so mode matching can
 *  key on what a mode *is* rather than on what it happens to be called (see
 *  {@link SessionMode.kind}). Returns undefined when the agent reported none,
 *  which every caller reads as "keep what we had". */
export function normalizeModes(raw: unknown): SessionModes | undefined {
  const parsed = MODES.safeParse(raw)
  if (!parsed.success) return undefined
  return {
    currentModeId: parsed.data.currentModeId,
    availableModes: parsed.data.availableModes.map((m) => {
      const kind = modeKind(m)
      // Absent, not `undefined`: this rides IPC, where a key present only to
      // say "nothing" is noise (same rule as `normalizeConfigOptions`).
      return { id: m.id, name: m.name, ...(kind ? { kind } : {}) }
    })
  }
}

/** No words beyond the core's own — what a kind without a mode vocabulary
 *  gets. */
const PLAIN_MODES: ModeWords = agentVocabulary(undefined).modes

/**
 * Pick the ACP mode that matches a session's auto-allow preference. Modes are
 * agent-defined, so this is a best-effort match over kind/id/name (mirrors the
 * renderer's `modeVisual`), in the session's agent's own words (`words`, from
 * its plugin) on top of the core's plain ones. Returns undefined if the
 * current mode already fits or no matching mode is exposed.
 *
 * Order matters on the auto side. An adapter can list an accept-edits mode
 * *before* its auto-review one (claude-code does), so a plain name match over
 * "accept|auto" would always land on accept-edits and gurt's "auto" could
 * never be reached. The real auto mode is asked for by kind (or by the
 * literal id) first; the accept/auto-edit family is the fallback for agents
 * that expose no such mode, and a blanket bypass only for agents that expose
 * neither.
 */
export function desiredModeId(
  autoAllow: boolean,
  modes: SessionModes | undefined,
  words: ModeWords = PLAIN_MODES
): string | undefined {
  const list = modes?.availableModes
  if (!list?.length) return undefined
  const pick = (pred: (m: SessionMode) => boolean) => list.find(pred)?.id
  const target = autoAllow
    ? // "auto" = review the risky calls, auto-accept the rest. Fall back to
      // accept-edits, and to a full bypass only for agents that expose neither.
      pick((m) => !!m.kind && words.autoReviewKinds.includes(m.kind)) ??
      pick((m) => m.id === 'auto') ??
      pick((m) => modeHas(m, AUTO_WORDS)) ??
      pick((m) => modeHas(m, words.bypass))
    : pick((m) => m.id === 'default') ?? pick((m) => modeHas(m, MANUAL_WORDS))
  if (!target || target === modes!.currentModeId) return undefined
  return target
}

/** The mode a freshly (re)opened ACP session should be switched into: the
 *  user's own last pick, when the agent still offers it, and only otherwise
 *  the one derived from the auto/manual choice. Without this a reattach
 *  re-derived the mode from a bool and silently overwrote the pick on every
 *  start and every wake. Undefined = the session is already where it belongs. */
export function nextModeId(
  info: Pick<SessionInfo, 'modeId' | 'autoAllow'>,
  modes: SessionModes | undefined,
  words: ModeWords = PLAIN_MODES
): string | undefined {
  const saved = info.modeId
  if (saved && modes?.availableModes.some((m) => m.id === saved))
    return saved === modes.currentModeId ? undefined : saved
  return desiredModeId(info.autoAllow ?? true, modes, words)
}
