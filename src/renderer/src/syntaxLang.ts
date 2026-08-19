/**
 * File extension → highlight.js language id, for the split view's syntax
 * coloring. See docs/requirements-manual-review.md.
 *
 * Only languages actually registered (`syntaxHighlight.ts`) are worth
 * listing here — an unknown extension renders plain, which is a safe,
 * cosmetic-only fallback.
 */
const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  pyi: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  markdown: 'markdown',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  ini: 'ini',
  toml: 'ini',
  dockerfile: 'dockerfile'
}

/** `null` when the path's extension isn't one we highlight. */
export function langOf(path: string): string | null {
  const base = path.split('/').pop() ?? path
  if (/^dockerfile$/i.test(base)) return 'dockerfile'
  const ext = base.includes('.') ? base.split('.').pop() : undefined
  return (ext && EXT_LANG[ext.toLowerCase()]) || null
}
