// A plain-text rendering of a chat timeline, for handing a conversation to an
// agent that does not remember it: the fallback of a rewind or a branch when the
// adapter cannot fork its own session at the chosen point.
import type { ChatEntry } from './types'

/** Newest turns win when the transcript has to be cut to fit. */
const MAX_CHARS = 60_000

/** User and agent messages plus a one-line note per tool call. Thoughts,
 *  system lines and permission prompts are not part of what was said. Entries
 *  hold masked tokens, so the result is as safe to send as the log itself. */
export function transcriptOf(entries: readonly ChatEntry[], maxChars = MAX_CHARS): string {
  const lines: string[] = []
  for (const e of entries) {
    if (e.kind === 'user') lines.push(`User: ${e.text.trim()}`)
    else if (e.kind === 'agent') lines.push(`Assistant: ${e.text.trim()}`)
    else if (e.kind === 'tool') lines.push(`[tool: ${e.title} (${e.status})]`)
  }
  let out = ''
  let cut = false
  for (let i = lines.length - 1; i >= 0; i--) {
    const next = `${lines[i]}\n\n${out}`
    if (next.length > maxChars) {
      cut = true
      break
    }
    out = next
  }
  return (cut ? '[earlier part of the conversation omitted]\n\n' : '') + out.trimEnd()
}

/** The block sent ahead of the next prompt after a rewind. */
export function rewindPreface(entries: readonly ChatEntry[], filesRestored = false): string {
  return (
    'This conversation was rewound to an earlier point. What follows is the conversation up to ' +
    'that point; treat it as your memory of it. ' +
    (filesRestored ? 'Working trees were restored to before the removed prompt. External effects were not reverted; ' : 'Files in the working tree were NOT reverted — ') +
    'inspect their actual state before relying on what you remember of them.\n\n' +
    `<conversation>\n${transcriptOf(entries)}\n</conversation>\n\n`
  )
}

/** The first prompt of a branch: the shared history, then room for the new turn. */
export function branchPrompt(entries: readonly ChatEntry[]): string {
  return (
    'This is a branch of an earlier conversation. Below is the conversation up to the branch ' +
    'point; treat it as your memory of it. The files in the working tree are whatever they are ' +
    'now — inspect them before relying on what you remember.\n\n' +
    `<conversation>\n${transcriptOf(entries)}\n</conversation>\n\n` +
    'Now continue with: '
  )
}
