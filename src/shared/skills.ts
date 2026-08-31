// Skill registry — pure data + validation, shared by main and renderer.
//
// A **skill** is Claude Code's unit of reusable procedure: a directory holding
// `SKILL.md` (YAML frontmatter over a markdown body) plus whatever supporting
// files that body points at. gurt keeps a registry of them per workspace, on
// disk under `~/.gurt/<ws>/skills/<name>/`, and a session records which of them
// it was given (docs/requirements-skills.md §4).
//
// This module is the model and the rules, and nothing else: it never touches
// the filesystem. `store.ts` reads the directories and hands the results here
// to be understood; the renderer reads the same shapes back over IPC. That is
// what lets the Settings editor preview the exact verdict the save path will
// reach, the way `shared/mcp.ts` does for MCP entries.
//
// Deliberately *not* modelled here: a repository's own `.claude/skills`. gurt
// does not list, merge or disable those (§3) — the agent sees the union of
// gurt's set and the repo's because Claude Code composes them, not because gurt
// arranges it.

import { z } from 'zod'

/** One skill of a workspace's registry, as read off disk.
 *
 *  `name` is the directory name, the selection key and the frontmatter's own
 *  `name`, all three of which have to agree — {@link validateSkillDoc} is what
 *  keeps them agreeing. */
export interface SkillEntry {
  name: string
  /** Frontmatter `description` — the one line Claude Code reads to decide
   *  whether to open the body, and the one line the picker shows. Empty when
   *  the entry could not be read (`problem` says why). */
  description: string
  /** Files beside `SKILL.md`, repo-relative, sorted. Listed read-only in the
   *  editor so a skill whose body references `references/palette.md` shows that
   *  the file actually travels with it. */
  files: string[]
  /** Why this entry is unusable, if it is: unreadable `SKILL.md`, frontmatter
   *  that does not parse, a name that disagrees with the directory. Reported
   *  rather than hidden — a skill that vanished from the picker over a missing
   *  colon could not be fixed from inside gurt. */
  problem?: string
}

/** Names are path segments, selection keys and Claude Code skill names at once.
 *  Claude Code's own rule (lowercase alphanumeric words joined by single
 *  hyphens) is the narrowest of the three, so it is the one gurt enforces. */
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const NAME_MAX = 64

/** null = ok. `takenNames` are the *other* skills' names — an update passes the
 *  registry minus the skill being saved. */
export function skillNameProblem(
  raw: string,
  takenNames: readonly string[] = []
): string | null {
  const name = raw.trim()
  if (!name) return 'a skill needs a name'
  if (name.length > NAME_MAX) return `name is longer than ${NAME_MAX} characters`
  if (!NAME_RE.test(name))
    return `"${name}" is not a valid skill name — lowercase letters, digits and single hyphens`
  if (takenNames.includes(name)) return `"${name}" already exists in this workspace`
  return null
}

/** The frontmatter gurt requires. Claude Code accepts more keys than this
 *  (`allowed-tools`, `license`, `metadata`, …) and they are carried through
 *  untouched — the schema is loose on purpose, it checks the two fields the
 *  registry itself depends on and refuses to have an opinion about the rest. */
export const SKILL_FRONTMATTER = z.looseObject({
  name: z.string().min(1, 'frontmatter `name` is empty'),
  description: z.string().min(1, 'frontmatter `description` is empty')
})

export type SkillFrontmatter = z.infer<typeof SKILL_FRONTMATTER>

/** `---` fence, on its own line, at the very top of the file. */
const FENCE_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/**
 * The frontmatter block of a `SKILL.md`, as `key: value` lines.
 *
 * A deliberate YAML subset, not a YAML parser: the block Claude Code's own
 * format calls for is flat scalars, gurt has no YAML dependency, and a parser
 * that accepted anchors and block scalars would only be able to produce values
 * this module would then have to reject. Anything that is not `key: value` at
 * the top level is ignored, which is how the extra keys above survive a
 * round-trip — nothing here rewrites the file.
 */
export function parseSkillFrontmatter(source: string): Record<string, string> | null {
  const block = FENCE_RE.exec(source.replace(/^\uFEFF/, ''))
  if (!block?.[1]) return null
  const out: Record<string, string> = {}
  for (const line of block[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const at = line.indexOf(':')
    if (at < 0) continue
    const key = line.slice(0, at).trim()
    if (!key || /\s/.test(key)) continue
    out[key] = unquote(line.slice(at + 1).trim())
  }
  return out
}

/** Strip one layer of matching quotes — the form a description with a leading
 *  `>` or a trailing `:` has to be written in. */
function unquote(value: string): string {
  const first = value[0]
  if ((first === '"' || first === "'") && value.length > 1 && value.endsWith(first))
    return value.slice(1, -1)
  return value
}

/** What a validated `SKILL.md` yielded, or why it is not one. */
export interface SkillDocResult {
  frontmatter?: SkillFrontmatter
  error?: string
}

/**
 * null-ish = ok. Checks the document a user typed into the editor before it
 * becomes a directory: it has a frontmatter block, that block carries a `name`
 * and a `description`, and the `name` is the one the directory will be called.
 *
 * The last rule is the one worth spelling out. Claude Code identifies a skill by
 * its frontmatter `name`, gurt identifies it by its directory (that is what a
 * selection stores and what a mount copies), and a file where the two disagree
 * is a skill that is enabled under one name and answers to another. Rejecting
 * the disagreement is cheaper than choosing a winner.
 */
export function validateSkillDoc(name: string, source: string): SkillDocResult {
  const raw = parseSkillFrontmatter(source)
  if (!raw)
    return {
      error:
        'SKILL.md needs a frontmatter block — `---`, then `name:` and `description:`, then `---`'
    }
  const parsed = SKILL_FRONTMATTER.safeParse(raw)
  if (!parsed.success)
    return { error: parsed.error.issues.map((i) => i.message).join('; ') }
  const declared = parsed.data.name.trim()
  if (declared !== name.trim())
    return {
      error: `frontmatter says name: ${declared} — it has to match the skill's own name "${name.trim()}"`
    }
  return { frontmatter: parsed.data }
}

/**
 * Every skill a workspace can offer a session, in name order, first occurrence
 * of a name winning.
 *
 * The MCP twin (`mcpEntries`) unions two sources because half of its entries
 * are code; a skill is always user data, so this one only orders and
 * de-duplicates. It exists anyway, as the single place a caller goes for "what
 * is on offer" — the picker, the resolver and the start path all read it, and
 * none of them should be sorting a directory listing itself.
 */
export function skillEntries(registry: readonly SkillEntry[] | undefined): SkillEntry[] {
  const seen = new Set<string>()
  const out: SkillEntry[] = []
  for (const entry of registry ?? []) {
    if (seen.has(entry.name)) continue
    seen.add(entry.name)
    out.push(entry)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** One entry of a session's skill selection, paired with what its name resolves
 *  to *now*. `entry: undefined` is the name that has gone away — a skill
 *  deleted out from under a saved selection. */
export interface ResolvedSkillSelection<S extends { name: string }> {
  selection: S
  entry: SkillEntry | undefined
}

/**
 * Pair a session's stored selection with the skills it names, in the user's
 * order, first occurrence of a name winning.
 *
 * A missing name is *kept*, not dropped, for the reason `resolveMcpSelection`
 * keeps a missing id: the selection is the session's record of what the user
 * asked for, and a picker that silently swallowed a deleted name would re-save
 * the draft without it. The draft's picker shows it as an error row, the start
 * path leaves it out of the materialization and says so in the provision log —
 * but they both see it.
 *
 * Generic over the element so this module keeps the domain model
 * (`SkillSelection`, src/shared/types.ts) at arm's length; that file imports
 * this one, not the other way round.
 */
export function resolveSkillSelection<S extends { name: string }>(
  selection: readonly S[] | undefined,
  entries: readonly SkillEntry[]
): ResolvedSkillSelection<S>[] {
  const seen = new Set<string>()
  const out: ResolvedSkillSelection<S>[] = []
  for (const sel of selection ?? []) {
    if (seen.has(sel.name)) continue
    seen.add(sel.name)
    out.push({ selection: sel, entry: entries.find((e) => e.name === sel.name) })
  }
  return out
}

/** Selection names, de-duplicated and stripped of blanks — what a caller that
 *  only needs "which skills" (the store's delete-block, the materializer) reads
 *  instead of the record shape. */
export const skillNames = (selection: readonly { name: string }[] | undefined): string[] => [
  ...new Set((selection ?? []).map((s) => s.name.trim()).filter(Boolean))
]

/**
 * Normalize an untrusted list of names into a selection: trimmed,
 * de-duplicated, blanks dropped, and every survivor a syntactically valid name.
 * Used at both boundaries an outside caller reaches — the renderer's IPC and an
 * agent's `create_session` — so a name that could never be a directory is
 * refused where it arrives rather than at the mount.
 *
 * Resolvability is *not* checked here: a name that could exist but does not is
 * the "selected but unavailable" case, which the draft has to be able to hold
 * and show (docs/requirements-skills.md §4.4).
 */
export function sanitizeSkillSelection(
  input: readonly { name: string }[] | readonly string[] | undefined
): { name: string }[] {
  const names = skillNames(
    (input ?? []).map((v) => (typeof v === 'string' ? { name: v } : v))
  )
  for (const name of names) {
    const bad = skillNameProblem(name)
    if (bad) throw new Error(`skill "${name}": ${bad}`)
  }
  return names.map((name) => ({ name }))
}

/** The file every skill directory is required to hold. */
export const SKILL_FILE = 'SKILL.md'

/** What a new skill's `SKILL.md` starts as in the editor — a valid document, so
 *  the first thing the user sees is a form that would save. */
export const skillTemplate = (name: string): string =>
  `---
name: ${name || 'my-skill'}
description: One line telling the agent when to reach for this — it is all the agent sees until it opens the body.
---

# ${name || 'my-skill'}

Write the procedure here.
`
