import { clipboard } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const fromUris = (text: string): string[] => text.split(/\r?\n/).filter((l) => l.startsWith('file://')).flatMap((l) => {
  try { return [fileURLToPath(l)] } catch { return [] }
})

/** Absolute paths of the files and folders on the system clipboard, as a file
 * manager puts them there (best effort per platform; empty when it holds text). */
export function clipboardFilePaths(): string[] {
  const formats = clipboard.availableFormats()
  let found: string[] = []
  try {
    if (process.platform === 'win32') {
      const raw = clipboard.readBuffer('FileNameW').toString('utf16le')
      found = raw.split('\0').filter(Boolean)
    } else if (process.platform === 'darwin') {
      const plist = formats.includes('NSFilenamesPboardType') ? clipboard.read('NSFilenamesPboardType') : ''
      found = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))
      if (!found.length && formats.includes('public.file-url')) found = fromUris(clipboard.read('public.file-url'))
    } else {
      for (const format of ['x-special/gnome-copied-files', 'text/uri-list']) {
        if (formats.includes(format)) found = fromUris(clipboard.readBuffer(format).toString('utf8'))
        if (found.length) break
      }
    }
  } catch { return [] }
  return [...new Set(found.filter((p) => path.isAbsolute(p)))]
}
