// A scope's name *is* its branch: every clone of the scope works on a branch
// of exactly that name (provision.ts checks it out, changes.ts pushes it). So
// the rules for a new scope name are git's rules for a branch name
// (`git check-ref-format --branch`), plus the few gurt adds for the places the
// name travels besides git — a directory on disk and a forge URL. Shared by
// main, which enforces them, and the renderer, which explains them as the
// user types.

/** Longest scope name accepted. Generous for a branch, short enough to stay
 *  readable as one directory name. */
export const SCOPE_NAME_MAX = 100

/** Taken by the default branch of nearly every repo: a scope of that name would
 *  check out the default branch itself and work on it directly. Provisioning
 *  also refuses whatever each clone's actual default branch is. */
const DEFAULT_BRANCHES = ['main', 'master']

/** First components that make a branch name read as something else: `refs/…`
 *  is a full ref spelled as a branch, `origin/…` a remote-tracking branch. */
const MISLEADING_PREFIXES = ['refs', 'origin']

/** Why git, or gurt, cannot take `name` as a scope's branch — or null when it
 *  can. `name` is checked exactly as given: nothing is trimmed or rewritten
 *  here (see {@link normalizeScopeName} for the input side). */
export function scopeNameProblem(name: string): string | null {
  if (!name) return 'Scope name must not be empty'
  if (name.length > SCOPE_NAME_MAX) return `Scope name must be at most ${SCOPE_NAME_MAX} characters`
  if (name !== name.normalize('NFC')) return 'Scope name must be in Unicode NFC form'
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f]/.test(name)) return 'Scope name must not contain spaces or control characters'
  const bad = /[~^:?*[\\%]/.exec(name)
  if (bad) return `Scope name must not contain "${bad[0]}"`
  if (name.startsWith('-')) return 'Scope name must not start with "-"'
  if (name.startsWith('/') || name.endsWith('/')) return 'Scope name must not start or end with "/"'
  if (name.includes('//')) return 'Scope name must not contain "//"'
  if (name.includes('..')) return 'Scope name must not contain ".."'
  if (name.includes('@{')) return 'Scope name must not contain "@{"'
  if (name === '@' || name === 'HEAD') return `"${name}" is not a branch name`
  if (name.endsWith('.')) return 'Scope name must not end with "."'
  for (const part of name.split('/')) {
    if (part.startsWith('.')) return 'No part of a scope name may start with "."'
    if (part.endsWith('.lock')) return 'No part of a scope name may end with ".lock"'
  }
  const lower = name.toLowerCase()
  if (DEFAULT_BRANCHES.includes(lower)) return `"${name}" is a default branch — pick another scope name`
  const first = lower.split('/')[0]!
  if (name.includes('/') && MISLEADING_PREFIXES.includes(first))
    return `Scope name must not start with "${first}/"`
  return null
}

/** What the user most likely meant by `input` as a branch: trimmed, NFC, and
 *  whitespace runs turned into `-`. Never makes an invalid name valid by
 *  dropping characters — that is left for {@link scopeNameProblem} to explain. */
export function normalizeScopeName(input: string): string {
  return input.normalize('NFC').trim().replace(/\s+/g, '-')
}

/** Why `name` cannot sit next to the scopes in `existing` — or null. Git keeps
 *  each branch as a file under `refs/heads/`, so `feat` and `feat/login` cannot
 *  both exist (one would have to be a file and a directory at once), and on a
 *  case-insensitive filesystem neither can `Fix` and `fix`. `except` is the
 *  scope being renamed, which does not stand in its own way. */
export function scopeNameConflict(
  name: string,
  existing: readonly string[],
  except?: string
): string | null {
  const lower = name.toLowerCase()
  for (const other of existing) {
    if (other === except) continue
    const o = other.toLowerCase()
    if (o === lower) return `Scope "${other}" already exists`
    if (lower.startsWith(`${o}/`) || o.startsWith(`${lower}/`))
      return `"${name}" and scope "${other}" cannot both be branches — git keeps one inside the other`
  }
  return null
}

/** The branch a scope's clones work on. */
export const scopeBranch = (scope: string): string => scope

/** The scope's directory name under its workspace: one path segment, so `/` is
 *  written `%2F`. Bijective because a scope name may not contain `%`; names
 *  from before that rule hold no `/`, so they map to themselves. */
export const scopeDirName = (scope: string): string => scope.replaceAll('/', '%2F')

/** Inverse of {@link scopeDirName}. */
export const scopeFromDirName = (dir: string): string => dir.replaceAll('%2F', '/')

/** An input field's view of a scope name being typed: the name it would
 *  submit, and why that name cannot be taken — null when it can, or when
 *  there is nothing typed yet to complain about. */
export function scopeNameInput(
  input: string,
  existing: readonly string[],
  except?: string
): { name: string; error: string | null } {
  // A rename left as it was is no rename — even of a name from before these
  // rules, which normalizing would otherwise quietly change.
  if (except !== undefined && input.trim() === except) return { name: except, error: null }
  const name = normalizeScopeName(input)
  if (!name || name === except) return { name, error: null }
  return { name, error: scopeNameProblem(name) ?? scopeNameConflict(name, existing, except) }
}
