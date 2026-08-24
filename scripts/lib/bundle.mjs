// The one esbuild call the test suite makes.
//
// Every scripts/*.test.mjs bundles the real TypeScript out of src/ and imports
// the bundle — that is the suite's rule (CONTRIBUTING.md, "Why the suite looks
// like this"). The options were copy-pasted into 32 files before this helper
// existed; coverage needed to add one more of them everywhere at once, which is
// what finally made the duplication worth collapsing.
//
// `npm test` builds exactly what it always built. Under `npm run coverage`
// (GURT_COVERAGE=1) the bundle also carries an inline source map, which is what
// makes V8's line counts land on src/**/*.ts instead of on the temp file.
import { build } from 'esbuild'
import fs from 'node:fs'

/** True when the suite is running under `npm run coverage`. */
export const COVERAGE = process.env.GURT_COVERAGE === '1'

const INLINE_MAP = /\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]*)/

/**
 * Bundle src/** for a test. Takes the same options object as esbuild's `build`,
 * with the five settings every test shares already applied.
 *
 * @param {import('esbuild').BuildOptions & { outfile: string }} options
 */
export async function bundle(options) {
  const result = await build({
    bundle: true,
    format: 'esm',
    platform: 'node',
    // jsonc-parser's `main` is a UMD build esbuild can't wrap into ESM output —
    // prefer each package's ESM entry, like vite does.
    mainFields: ['module', 'main'],
    logLevel: 'silent',
    ...(COVERAGE ? { sourcemap: 'inline', sourcesContent: true } : null),
    ...options
  })
  if (COVERAGE) fillOrphanSources(options.outfile)
  return result
}

/**
 * Repair the inline source map esbuild just wrote, in place.
 *
 * esbuild chains input source maps: a dependency shipping its own `.js.map`
 * gets folded into ours, and its `sources` then name the `.ts` files that
 * package was compiled from. `@modelcontextprotocol/sdk` publishes the maps but
 * not the sources, so those paths do not exist on disk and esbuild leaves the
 * matching `sourcesContent` slot `null`.
 *
 * Node's coverage reporter resolves *every* source in the map before it applies
 * any include/exclude filter. The first path it cannot read throws
 * ERR_SOURCE_MAP_MISSING_SOURCE and abandons the entire report — which is why
 * `--test-coverage-exclude='**\/node_modules/**'` does not help, and why one
 * phantom path costs you the numbers for all 32 files.
 *
 * The fix is to give those slots content, so nothing has to be read. Deleting
 * the entries is not an option: a `sources` index is field 2 of every mapping
 * segment and is delta-encoded along the whole `mappings` string, so dropping
 * element i means re-encoding every segment after it — a VLQ rewrite, for no
 * gain. Substituting empty content leaves `mappings` byte-identical, and the
 * phantom paths keep their node_modules/ prefix, so the reporter's own default
 * exclude drops them from the report exactly as it drops every other dependency.
 *
 * @param {string} outfile
 */
function fillOrphanSources(outfile) {
  const code = fs.readFileSync(outfile, 'utf8')
  const comment = code.match(INLINE_MAP)
  if (!comment) throw new Error(`no inline source map in ${outfile} — coverage would measure nothing`)
  const map = JSON.parse(Buffer.from(comment[1], 'base64').toString('utf8'))

  const orphans = map.sources.filter((_, i) => map.sourcesContent[i] == null)
  if (orphans.length === 0) return
  // Only dependencies are expected to have unreadable sources. One of ours
  // showing up here means the file moved mid-build and its coverage would be
  // silently blank, which is the failure mode this whole exercise exists to
  // prevent — so say so rather than paper over it.
  const ours = orphans.filter((src) => !src.includes('node_modules'))
  if (ours.length > 0) throw new Error(`source map for ${outfile} lost the contents of: ${ours.join(', ')}`)
  for (let i = 0; i < map.sources.length; i++) if (map.sourcesContent[i] == null) map.sourcesContent[i] = ''

  const patched = Buffer.from(JSON.stringify(map)).toString('base64')
  fs.writeFileSync(outfile, code.replace(INLINE_MAP, `//# sourceMappingURL=data:application/json;base64,${patched}`))
}
