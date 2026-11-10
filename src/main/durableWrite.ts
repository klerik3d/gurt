import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await fs.open(dir, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Write JSON durably: a complete temp file, fsync'd, renamed over the target
 * (atomic on POSIX), then the directory fsync'd so the rename itself survives a
 * power loss. `fs.writeFile` truncates in place and never fsyncs — a crash
 * between the truncate and the flush leaves a 0-byte file, which is how one
 * task lost every session record on 2026-08-27.
 */
export async function writeJsonDurable(
  file: string,
  data: unknown,
  opts: { mode?: number; pretty?: boolean } = {}
): Promise<void> {
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`)
  const fh = await fs.open(tmp, 'wx', opts.mode ?? 0o644)
  try {
    try {
      await fh.writeFile(
        opts.pretty === false ? JSON.stringify(data) : JSON.stringify(data, null, 2) + '\n'
      )
      await fh.sync()
    } finally {
      await fh.close()
    }
    await fs.rename(tmp, file)
    await syncDirectory(dir)
  } finally {
    await fs.rm(tmp, { force: true })
  }
}
