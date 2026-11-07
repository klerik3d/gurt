// Versioned, streaming gzip container. Files are chunked, checksummed and never
// followed through symlinks. Extraction writes links last into a fresh directory.
import { createReadStream, createWriteStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip, createGunzip } from 'node:zlib'
import { createInterface } from 'node:readline'
import { z } from 'zod'

const recordSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('header'), version: z.literal(1) }),
  z.object({ type: z.literal('dir'), path: z.string(), mode: z.number().int(), mtime: z.number().optional() }),
  z.object({ type: z.literal('link'), path: z.string(), target: z.string() }),
  z.object({ type: z.literal('file'), path: z.string(), mode: z.number().int(), size: z.number().nonnegative(), mtime: z.number().optional() }),
  z.object({ type: z.literal('chunk'), data: z.string().max(90_000) }),
  z.object({ type: z.literal('end'), sha256: z.string() }),
  z.object({ type: z.literal('complete') })
])
type Record = z.infer<typeof recordSchema>

function safePath(name: string): string {
  if (!name || /[\\\0:]/.test(name) || name.split('/').some((p) => !p || p === '.' || p === '..'))
    throw new Error('Unsafe path in archive')
  return name
}

export async function packScope(source: string, destination: string): Promise<number> {
  let bytes = 0
  const stamps = new Map<string, string>()
  const stamp = (stat: Awaited<ReturnType<typeof fs.lstat>>): string =>
    `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}`
  const generated = (name: string): boolean => /^\.multirepo\/[^/]+\/(skills|repos|devcontainer\.json)$/.test(name)
  async function* walk(relative = ''): AsyncGenerator<Record> {
    for (const entry of await fs.readdir(path.join(source, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name
      safePath(name)
      // These mounts/configs are regenerated from the session configuration.
      // Keep opaque agent history and any unknown files; never prune repo files.
      if (generated(name)) continue
      const file = path.join(source, name)
      const stat = await fs.lstat(file)
      stamps.set(name, stamp(stat))
      if (stat.isSymbolicLink()) {
        yield { type: 'link', path: name, target: await fs.readlink(file) }
      } else if (stat.isDirectory()) {
        yield { type: 'dir', path: name, mode: stat.mode & 0o777, mtime: stat.mtimeMs }
        yield* walk(name)
      } else if (stat.isFile()) {
        yield { type: 'file', path: name, mode: stat.mode & 0o777, size: stat.size, mtime: stat.mtimeMs }
        const hash = createHash('sha256')
        let read = 0
        for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) {
          const data = chunk as Buffer
          hash.update(data)
          read += data.length
          yield { type: 'chunk', data: data.toString('base64') }
        }
        if (read !== stat.size) throw new Error('Scope changed during archiving; try again')
        bytes += read
        yield { type: 'end', sha256: hash.digest('hex') }
      } else {
        throw new Error(`Cannot archive special file: ${name}`)
      }
    }
  }
  async function* records(): AsyncGenerator<string> {
    yield JSON.stringify({ type: 'header', version: 1 }) + '\n'
    for await (const record of walk()) yield JSON.stringify(record) + '\n'
    // Catch changes during compression (including same-size edits and newly
    // created files) before the caller can retire the original directory.
    async function verify(relative = ''): Promise<void> {
      for (const entry of await fs.readdir(path.join(source, relative), { withFileTypes: true })) {
        const name = relative ? `${relative}/${entry.name}` : entry.name
        if (generated(name)) continue
        const stat = await fs.lstat(path.join(source, name))
        if (stamps.get(name) !== stamp(stat)) throw new Error('Scope changed during archiving; try again')
        stamps.delete(name)
        if (stat.isDirectory()) await verify(name)
      }
    }
    await verify()
    if (stamps.size) throw new Error('Scope changed during archiving; try again')
    yield JSON.stringify({ type: 'complete' }) + '\n'
  }
  await pipeline(Readable.from(records()), createGzip({ level: 9 }), createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
  return bytes
}

/** Validates every byte even when only one file is requested for chat preview. */
export async function unpackScope(archive: string, destination?: string, wanted?: string): Promise<Buffer> {
  const input = createReadStream(archive)
  const unzip = createGunzip()
  const pumping = pipeline(input, unzip)
  // The consumer handles the same error below; attach immediately to avoid an
  // unhandled rejection while readline is unwinding after a corrupt gzip.
  void pumping.catch(() => {})
  const lines = createInterface({ input: unzip, crlfDelay: Infinity })
  const known = new Map<string, 'dir' | 'file' | 'link'>()
  const links: { path: string; target: string }[] = []
  const directories: { path: string; mode: number; mtime?: number | undefined }[] = []
  const selected: Buffer[] = []
  let current: { path: string; size: number; bytes: number; mode: number; mtime?: number; hash: ReturnType<typeof createHash>; handle?: Awaited<ReturnType<typeof fs.open>> } | undefined
  let header = false
  let complete = false
  try {
    for await (const line of lines) {
      if (complete || line.length > 100_000) throw new Error('Invalid archive record')
      const r = recordSchema.parse(JSON.parse(line) as unknown)
      if (!header) {
        if (r.type !== 'header') throw new Error('Missing archive header')
        header = true
        continue
      }
      if (r.type === 'chunk') {
        if (!current) throw new Error('Unexpected archive chunk')
        const data = Buffer.from(r.data, 'base64')
        current.bytes += data.length
        if (current.bytes > current.size) throw new Error('Archive file size mismatch')
        current.hash.update(data)
        if (current.handle) await current.handle.writeFile(data)
        if (current.path === wanted) selected.push(data)
      } else if (r.type === 'end') {
        if (!current || current.bytes !== current.size || current.hash.digest('hex') !== r.sha256)
          throw new Error('Archive checksum mismatch')
        if (current.handle) {
          await current.handle.chmod(current.mode & 0o777)
          if (current.mtime !== undefined) await current.handle.utimes(current.mtime / 1000, current.mtime / 1000)
          await current.handle.sync()
        }
        await current.handle?.close()
        current = undefined
      } else {
        if (current) throw new Error('Unfinished file in archive')
        if (r.type === 'complete') { complete = true; continue }
        if (r.type === 'header') throw new Error('Duplicate archive header')
        safePath(r.path)
        const parent = path.posix.dirname(r.path)
        if (known.has(r.path) || (parent !== '.' && known.get(parent) !== 'dir'))
          throw new Error('Invalid archive hierarchy')
        known.set(r.path, r.type)
        const target = destination ? path.join(destination, r.path) : undefined
        if (r.type === 'dir') {
          directories.push(r)
          if (target) await fs.mkdir(target, { mode: 0o700 })
        }
        if (r.type === 'link') links.push(r)
        if (r.type === 'file') {
          current = { path: r.path, size: r.size, bytes: 0, mode: r.mode,
            ...(r.mtime === undefined ? {} : { mtime: r.mtime }), hash: createHash('sha256') }
          if (target) current.handle = await fs.open(target, 'wx', r.mode & 0o777)
        }
      }
    }
    await pumping
    if (!header || !complete || current) throw new Error('Incomplete archive')
    if (wanted && known.get(wanted) !== 'file') throw new Error('File is missing from archive')
    if (destination) for (const link of links) await fs.symlink(link.target, path.join(destination, link.path))
    if (destination) for (const dir of directories.reverse()) {
      const file = path.join(destination, dir.path)
      const handle = process.platform === 'win32' ? undefined : await fs.open(file, 'r')
      try {
        await fs.chmod(file, dir.mode & 0o777)
        if (dir.mtime !== undefined) await fs.utimes(file, dir.mtime / 1000, dir.mtime / 1000)
        await handle?.sync()
      } finally { await handle?.close() }
    }
    return Buffer.concat(selected)
  } finally {
    await current?.handle?.close()
    lines.close()
    unzip.destroy()
    input.destroy()
  }
}
