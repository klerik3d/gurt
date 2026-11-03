import { constants, promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import type ts from 'typescript'
import type { FileDocument, FileEntry, FileLocation, FileNavigation, FileNavigationResult } from '../shared/files'
import { cloneDir, taskClones, taskExists, validateName } from './store'

const MAX_FILE = 2 * 1024 * 1024
const MAX_INDEX_FILES = 3000
const MAX_INDEX_BYTES = 24 * 1024 * 1024
const SKIP = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', 'out', 'coverage', '.next', '.venv', 'venv', '__pycache__'])
const JS_TS = /\.(?:[cm]?[jt]sx?)$/i
const versionOf = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

function checkScope(ws: string, task: string): void {
  validateName('workspace', ws)
  validateName('task', task)
  if (!taskExists(ws, task)) throw new Error('Scope no longer exists')
}

/** No traversal or symlinks, including intermediate directories and clone roots.
 * Only actual clones are visible; scope metadata and session logs stay private. */
async function resolveFile(ws: string, task: string, relative: string): Promise<{ absolute: string; root: string; repo: string }> {
  checkScope(ws, task)
  if (typeof relative !== 'string' || relative.includes('\\') || relative.includes('\0'))
    throw new Error('Invalid file path')
  const parts = relative.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || part === '.git'))
    throw new Error('Invalid file path')
  const repo = parts[0]!
  if (!(await taskClones(ws, task)).includes(repo)) throw new Error('Repository no longer exists')
  const root = cloneDir(ws, task, repo)
  const scopeRoot = await fs.realpath(path.dirname(root))
  let absolute = scopeRoot
  for (const part of parts) {
    absolute = path.join(absolute, part)
    if ((await fs.lstat(absolute)).isSymbolicLink()) throw new Error('Symbolic links cannot be opened in the file editor')
  }
  return { absolute, root: path.join(scopeRoot, repo), repo }
}

export async function listTaskFiles(ws: string, task: string, directory: string): Promise<FileEntry[]> {
  checkScope(ws, task)
  if (directory === '') {
    const clones = await taskClones(ws, task)
    return clones.sort().map((name) => ({ name, path: name, kind: 'directory' }))
  }
  const { absolute } = await resolveFile(ws, task, directory)
  const entries = await fs.readdir(absolute, { withFileTypes: true })
  return entries.filter((e) => e.name !== '.git' && (e.isDirectory() || e.isFile() || e.isSymbolicLink()))
    .map((e): FileEntry => ({ name: e.name, path: `${directory}/${e.name}`, kind: e.isSymbolicLink() ? 'symlink' : e.isDirectory() ? 'directory' : 'file' }))
    .sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, undefined, { numeric: true }))
}

export async function taskFilePath(ws: string, task: string, relative: string): Promise<string> {
  return (await resolveFile(ws, task, relative)).absolute
}

export async function renameTaskFile(ws: string, task: string, relative: string, name: string): Promise<string> {
  if (typeof name !== 'string' || !name.trim() || /[/\\\0]/.test(name) || ['.', '..', '.git'].includes(name)) throw new Error('Invalid file name')
  if (!relative.includes('/')) throw new Error('Repository roots cannot be renamed')
  const { absolute } = await resolveFile(ws, task, relative)
  const destination = path.join(path.dirname(absolute), name)
  try { await fs.lstat(destination) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await fs.rename(absolute, destination)
    return relative.slice(0, relative.lastIndexOf('/') + 1) + name
  }
  throw new Error('A file with this name already exists')
}

export async function deleteTaskFile(ws: string, task: string, relative: string): Promise<void> {
  if (!relative.includes('/')) throw new Error('Repository roots cannot be deleted')
  const { absolute } = await resolveFile(ws, task, relative)
  await fs.rm(absolute, { recursive: true })
}

async function readText(absolute: string): Promise<{ data: Buffer; content: string }> {
  const handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('Only regular files can be opened')
    if (stat.size > MAX_FILE) throw new Error('This file is larger than the 2 MiB editor limit')
    const data = Buffer.alloc(stat.size + 1)
    let size = 0
    while (size < data.length) {
      const { bytesRead } = await handle.read(data, size, data.length - size, size)
      if (!bytesRead) break
      size += bytesRead
    }
    const after = await handle.stat()
    if (size !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      throw new Error('File changed while reading. Try again.')
    const bytes = data.subarray(0, size)
    if (bytes.includes(0)) throw new Error('Binary file — no text editor available')
    let content: string
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
    catch { throw new Error('This file is not UTF-8 text') }
    return { data: bytes, content }
  } finally { await handle.close() }
}

export async function readTaskFile(ws: string, task: string, relative: string): Promise<FileDocument> {
  const { absolute } = await resolveFile(ws, task, relative)
  const { data, content } = await readText(absolute)
  return { content, version: versionOf(data) }
}

// Serialize editor saves; a second save based on an old version must conflict.
const saves = new Map<string, Promise<unknown>>()

export async function writeTaskFile(ws: string, task: string, relative: string, content: string, version: string): Promise<FileDocument> {
  if (typeof content !== 'string' || content.includes('\0') || Buffer.byteLength(content) > MAX_FILE)
    throw new Error('Only UTF-8 text files up to 2 MiB can be saved')
  const { absolute } = await resolveFile(ws, task, relative)
  const save = async (): Promise<FileDocument> => {
    // O_NOFOLLOW protects the final file even if it was replaced after validation.
    await resolveFile(ws, task, relative)
    const handle = await fs.open(absolute, constants.O_RDWR | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('File can no longer be saved')
      const data = await handle.readFile()
      if (versionOf(data) !== version) throw new Error('File changed on disk. Reload it before saving to avoid overwriting external changes.')
      const bytes = Buffer.from(content, 'utf8')
      let written = 0
      while (written < bytes.length) written += (await handle.write(bytes, written, bytes.length - written, written)).bytesWritten
      await handle.truncate(bytes.length)
      return { content, version: versionOf(bytes) }
    } finally { await handle.close() }
  }
  const next = Promise.resolve(saves.get(absolute)).catch(() => {}).then(save)
  saves.set(absolute, next)
  try { return await next }
  finally { if (saves.get(absolute) === next) saves.delete(absolute) }
}

/** Bounded, asynchronous index. It never executes project code or follows links. */
async function indexFiles(root: string, semantic: boolean): Promise<{ documents: Map<string, string>; limited: boolean }> {
  const documents = new Map<string, string>()
  let total = 0
  let visited = 0
  let limited = false
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue
      if (++visited > MAX_INDEX_FILES || total >= MAX_INDEX_BYTES) { limited = true; return }
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory() && !entry.name.startsWith('.')) await walk(absolute)
      else if (entry.isFile() && (!semantic || JS_TS.test(entry.name) || entry.name === 'tsconfig.json' || entry.name === 'jsconfig.json')) {
        const text = await readText(absolute).catch(() => null)
        if (text) {
          if (total + text.data.length > MAX_INDEX_BYTES) { limited = true; return }
          total += text.data.length
          documents.set(absolute, text.content)
        }
      }
      if (limited) return
    }
  }
  await walk(root)
  return { documents, limited }
}

export async function navigateTaskFile(ws: string, task: string, relative: string, request: FileNavigation): Promise<FileNavigationResult> {
  const { absolute, root, repo } = await resolveFile(ws, task, relative)
  if (!request || !['definition', 'references'].includes(request.kind) || !Number.isInteger(request.position) || request.position < 0 ||
      !Array.isArray(request.documents) || request.documents.length > 100)
    throw new Error('Invalid navigation request')
  const semantic = JS_TS.test(relative)
  if (!semantic && request.kind === 'definition') return { locations: [], semantic, limited: false }
  const { documents, limited } = await indexFiles(root, semantic)
  let bufferBytes = 0
  for (const doc of request.documents) {
    if (typeof doc.path !== 'string' || typeof doc.content !== 'string' || (bufferBytes += Buffer.byteLength(doc.content)) > MAX_INDEX_BYTES)
      throw new Error('Editor buffers exceed the navigation limit')
    const resolved = await resolveFile(ws, task, doc.path)
    if (resolved.root === root) documents.set(resolved.absolute, doc.content)
  }
  if (!documents.has(absolute)) documents.set(absolute, (await readText(absolute)).content)
  const content = documents.get(absolute)!
  if (request.position > content.length) throw new Error('Cursor is outside the file')
  const locations: FileLocation[] = []
  const locate = (filename: string, from: number, length: number): void => {
    const text = documents.get(filename)
    if (text === undefined || locations.length >= 500) return
    const start = text.lastIndexOf('\n', Math.max(0, from - 1)) + 1
    locations.push({ path: `${repo}/${path.relative(root, filename).split(path.sep).join('/')}`, from, to: from + length,
      line: text.slice(0, from).split('\n').length, column: from - start + 1,
      preview: text.slice(start, text.indexOf('\n', from) < 0 ? undefined : text.indexOf('\n', from)).slice(0, 240).trim() })
  }
  if (semantic) {
    const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript')
    const configName = ts.findConfigFile(path.dirname(absolute), (name) => documents.has(name), 'tsconfig.json') ??
      ts.findConfigFile(path.dirname(absolute), (name) => documents.has(name), 'jsconfig.json')
    const rawConfig = configName ? ts.parseConfigFileTextToJson(configName, documents.get(configName)!).config as { compilerOptions?: Record<string, unknown> } | undefined : undefined
    const options: ts.CompilerOptions = {
      ...ts.convertCompilerOptionsFromJson(rawConfig?.compilerOptions ?? {}, configName ? path.dirname(configName) : root).options,
      allowJs: true, checkJs: false, noLib: true, noEmit: true, jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler
    }
    const service = ts.createLanguageService({
      getCompilationSettings: () => options,
      getScriptFileNames: () => [...documents.keys()].filter((p) => JS_TS.test(p)),
      getScriptVersion: () => '1',
      getScriptSnapshot: (name) => { const text = documents.get(name); return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text) },
      getCurrentDirectory: () => root,
      getDefaultLibFileName: () => '',
      fileExists: (name) => documents.has(name),
      readFile: (name) => documents.get(name),
      directoryExists: (name) => [...documents.keys()].some((p) => p.startsWith(`${name}${path.sep}`)),
      readDirectory: () => [...documents.keys()]
    })
    try {
      const hits = request.kind === 'definition' ? service.getDefinitionAtPosition(absolute, request.position) : service.getReferencesAtPosition(absolute, request.position)
      for (const hit of hits ?? []) locate(hit.fileName, hit.textSpan.start, hit.textSpan.length)
      return { locations, semantic, limited: limited || (hits?.length ?? 0) > 500 }
    } finally { service.dispose() }
  }
  // Other languages get an explicitly labelled word search, not guessed definitions.
  const left = content.slice(0, request.position).match(/[\p{L}\p{N}_$]+$/u)?.[0] ?? ''
  const right = content.slice(request.position).match(/^[\p{L}\p{N}_$]+/u)?.[0] ?? ''
  const word = left + right
  if (!word) return { locations, semantic, limited }
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_$])${escaped}(?![\\p{L}\\p{N}_$])`, 'gu')
  for (const [name, text] of documents) {
    for (const match of text.matchAll(pattern)) {
      locate(name, match.index, word.length)
      if (locations.length >= 500) return { locations, semantic, limited: true }
    }
  }
  return { locations, semantic, limited }
}
