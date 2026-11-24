// RPM on disk (t3v2 §8.1):
//
//   <store.dir(ws, task)>/<executorId>/
//     config.json      RpmConfig — durable write (temp file, fsync, rename, fsync dir)
//     runs/<n>.jsonl   run n's journal: one Entry per line; append + fsync per entry
//
// A torn last line (a crash mid-append) is dropped and cut off the file, so the
// next append starts on a clean line. A broken line in the middle stops the
// read there: the caller shows the run up to it and treats it as ended.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Entry, RpmConfig } from '../core'

export const configFile = (dir: string): string => path.join(dir, 'config.json')
export const runsDir = (dir: string): string => path.join(dir, 'runs')
export const runFile = (dir: string, n: number): string => path.join(runsDir(dir), `${n}.jsonl`)

/** Run numbers present in `<dir>/runs`, ascending. */
export function listRuns(dir: string): number[] {
  let names: string[]
  try {
    names = fs.readdirSync(runsDir(dir))
  } catch {
    return []
  }
  return names
    .map((n) => /^(\d+)\.jsonl$/.exec(n)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .sort((a, b) => a - b)
}

export interface ReadJournal {
  entries: Entry[]
  /** 1-based line number of a broken line in the middle; the entries stop before it. */
  brokenAt?: number
}

/** Read a journal. Drops (and truncates away) a torn last line. */
export function readJournal(file: string, warn: (msg: string) => void): ReadJournal {
  const buf = fs.readFileSync(file)
  const text = buf.toString('utf8')
  const lines = text.split('\n')
  // The text after the last '\n' is either '' (a clean file) or a torn write.
  const tail = lines.pop() ?? ''
  const entries: Entry[] = []
  let goodBytes = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const parsed = parseLine(line)
    if (!parsed) {
      if (i === lines.length - 1 && tail === '') {
        // A broken last full line is torn too.
        warn(`rpm: ${file}: dropped a torn last line`)
        truncate(file, goodBytes)
        return { entries }
      }
      warn(`rpm: ${file}: broken line ${i + 1}; the run is shown up to it and treated as ended`)
      return { entries, brokenAt: i + 1 }
    }
    entries.push(parsed)
    goodBytes += Buffer.byteLength(line, 'utf8') + 1
  }
  if (tail !== '') {
    const parsed = parseLine(tail)
    if (parsed) {
      // A complete entry whose newline did not make it: keep it, finish the line.
      entries.push(parsed)
      fs.appendFileSync(file, '\n')
    } else {
      warn(`rpm: ${file}: dropped a torn last line`)
      truncate(file, goodBytes)
    }
  }
  return { entries }
}

function parseLine(line: string): Entry | undefined {
  if (line.trim() === '') return undefined
  try {
    const v = JSON.parse(line) as Entry
    return v && typeof v === 'object' && typeof v.kind === 'string' && typeof v.seq === 'number' ? v : undefined
  } catch {
    return undefined
  }
}

function truncate(file: string, bytes: number): void {
  fs.truncateSync(file, bytes)
}

/** Append one entry as a line and fsync it. Creates the file (and its directory) on first use. */
export async function appendEntry(file: string, entry: Entry): Promise<void> {
  const dir = path.dirname(file)
  const fresh = !fs.existsSync(file)
  await fs.promises.mkdir(dir, { recursive: true })
  const fh = await fs.promises.open(file, 'a')
  try {
    await fh.appendFile(JSON.stringify(entry) + '\n')
    await fh.sync()
  } finally {
    await fh.close()
  }
  if (fresh) await syncDir(dir)
}

export function readConfig(dir: string, warn: (msg: string) => void): Partial<RpmConfig> | undefined {
  const file = configFile(dir)
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  try {
    const v = JSON.parse(text) as unknown
    return v && typeof v === 'object' ? (v) : undefined
  } catch {
    warn(`rpm: ${file}: unreadable config, using the defaults`)
    return undefined
  }
}

/** Durable write: a complete temp file, fsync'd, renamed over the target, then the directory fsync'd. */
export async function writeConfig(dir: string, config: RpmConfig): Promise<void> {
  const file = configFile(dir)
  await fs.promises.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.config.json.${process.pid}.${randomUUID()}.tmp`)
  const fh = await fs.promises.open(tmp, 'wx', 0o644)
  try {
    try {
      await fh.writeFile(JSON.stringify(config, null, 2) + '\n')
      await fh.sync()
    } finally {
      await fh.close()
    }
    await fs.promises.rename(tmp, file)
    await syncDir(dir)
  } finally {
    await fs.promises.rm(tmp, { force: true })
  }
}

async function syncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return
  const fh = await fs.promises.open(dir, 'r')
  try {
    await fh.sync()
  } finally {
    await fh.close()
  }
}
