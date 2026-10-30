// The local presidio analyzer sidecar (docs/requirements-pii-mask.md §5.1).
//
// The stock image carries one pipeline, `en_core_web_lg`. Any other language
// set or model size is a derived image gurt builds itself: the stock image plus
// the spaCy pipelines, with presidio's own three config files rewritten to name
// them — the files its Dockerfile already points NLP_CONF_FILE,
// ANALYZER_CONF_FILE and RECOGNIZER_REGISTRY_CONF_FILE at. The tag is a hash of
// that plan, so a plan is built once and the sidecar is recreated only when the
// plan (or the port) changes.
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spacyModel, type PiiAnalyzerState, type PresidioModelSize } from '../shared/pii'
import { dockerImageExists, run } from './provision'
import { createLogger } from './log'

const log = createLogger('pii')

/**
 * Pinned, like every other image gurt runs. One minor behind the recognizer
 * source's own pin (§4.1) simply because that is the newest published image —
 * both are release-tagged, neither is `latest`.
 */
export const PRESIDIO_IMAGE = 'mcr.microsoft.com/presidio-analyzer:2.2.362'
/** Docker is the registry here too — the name *is* the lookup (see containers.ts). */
export const PRESIDIO_CONTAINER = 'gurt-presidio-analyzer'
const LABEL = 'gurt.pii=analyzer'
/** What the running sidecar was created from — `<image>@<port>`; a mismatch means recreate. */
const KEY_LABEL = 'gurt.pii.key'

/** First start loads every pipeline into memory; a large one takes a while. */
const HEALTH_TIMEOUT_MS = 240_000

export interface AnalyzerPlan {
  image: string
  /** Absent for the stock image, which is pulled rather than built. */
  build?: { languages: string[]; models: Record<string, string> } | undefined
}

export function analyzerPlan(languages: string[], size: PresidioModelSize): AnalyzerPlan {
  if (size === 'lg' && languages.length === 1 && languages[0] === 'en') return { image: PRESIDIO_IMAGE }
  const models = Object.fromEntries(languages.map((l) => [l, spacyModel(l, size)]))
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ base: PRESIDIO_IMAGE, languages, models, conf: CONF_SCRIPT }))
    .digest('hex')
    .slice(0, 12)
  return { image: `${PRESIDIO_CONTAINER}:${hash}`, build: { languages, models } }
}

/**
 * Runs inside the build, in /app, with the image's own python and pyyaml. Every
 * recognizer without explicit languages (email, phone, IP, …) inherits the
 * registry's top-level list, so patterns keep working in every language picked.
 */
const CONF_SCRIPT = `import json, sys, yaml
plan = json.loads(sys.argv[1])
conf = 'presidio_analyzer/conf/'
def rewrite(name, edit):
    with open(conf + name) as f:
        doc = yaml.safe_load(f)
    edit(doc)
    with open(conf + name, 'w') as f:
        yaml.safe_dump(doc, f, sort_keys=False)
rewrite('default.yaml', lambda d: d.update(models=[{'lang_code': l, 'model_name': m} for l, m in plan['models'].items()]))
rewrite('default_analyzer.yaml', lambda d: d.update(supported_languages=plan['languages']))
rewrite('default_recognizers.yaml', lambda d: d.update(supported_languages=plan['languages']))
`

const dockerfile = (plan: AnalyzerPlan): string =>
  [
    `FROM ${PRESIDIO_IMAGE}`,
    'USER root',
    'COPY gurt-conf.py /tmp/gurt-conf.py',
    `RUN python /tmp/gurt-conf.py '${JSON.stringify(plan.build)}' \\`,
    '  && python install_nlp_models.py --conf_file "$NLP_CONF_FILE" \\',
    '  && rm /tmp/gurt-conf.py',
    'USER 1001',
    ''
  ].join('\n')

type Phase = { state: PiiAnalyzerState; detail?: string | undefined }

/**
 * One sidecar, brought in line with the latest plan. Calls are serialized; a
 * call made while another runs supersedes it, so a burst of settings changes
 * ends in one container for the last of them.
 */
export function createAnalyzer() {
  /** Set while an operation is under way, or after one failed; cleared once it is up. */
  let phase: Phase | undefined
  let chain: Promise<void> = Promise.resolve()
  let generation = 0

  const sink = (line: string): void => log.debug('presidio.docker', { line })

  async function ensureImage(plan: AnalyzerPlan): Promise<void> {
    if (await dockerImageExists(plan.image)) return
    if (!plan.build) {
      phase = { state: 'pulling' }
      await run('docker', ['pull', plan.image], sink)
      return
    }
    phase = { state: 'building', detail: Object.values(plan.build.models).join(', ') }
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gurt-presidio-'))
    try {
      await fsp.writeFile(path.join(dir, 'Dockerfile'), dockerfile(plan))
      await fsp.writeFile(path.join(dir, 'gurt-conf.py'), CONF_SCRIPT)
      await run('docker', ['build', '--label', LABEL, '-t', plan.image, dir], sink)
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  async function ensureContainer(plan: AnalyzerPlan, port: number): Promise<void> {
    const key = `${plan.image}@${port}`
    const current = await inspect()
    if (current && current.key === key) {
      if (current.status !== 'running') await run('docker', ['start', PRESIDIO_CONTAINER], sink)
      return
    }
    if (current) await run('docker', ['rm', '-f', PRESIDIO_CONTAINER], sink)
    phase = { state: 'starting' }
    await run(
      'docker',
      [
        'run', '-d',
        '--name', PRESIDIO_CONTAINER,
        '--label', LABEL,
        '--label', `${KEY_LABEL}=${key}`,
        '--restart', 'unless-stopped',
        '-p', `127.0.0.1:${port}:3000`,
        plan.image
      ],
      sink
    )
  }

  async function waitHealthy(url: string, gen: number): Promise<void> {
    phase = { state: 'starting' }
    const deadline = Date.now() + HEALTH_TIMEOUT_MS
    while (gen === generation) {
      if (await healthy(url)) return
      if (Date.now() > deadline) throw new Error('the analyzer did not answer /health in time')
      await new Promise((r) => setTimeout(r, 1000))
    }
  }

  return {
    /** Bring the sidecar in line with `plan` on `port`. Never rejects: a failure becomes the `error` phase. */
    ensure(plan: AnalyzerPlan, port: number, opts: { recreate?: boolean } = {}): Promise<void> {
      const gen = ++generation
      // Set now, not inside the chain: the settings page probes right after
      // saving and must see work under way, or it stops polling.
      phase = { state: 'starting' }
      chain = chain.then(async () => {
        if (gen !== generation) return
        try {
          if (opts.recreate) await run('docker', ['rm', '-f', PRESIDIO_CONTAINER], sink).catch(() => '')
          await ensureImage(plan)
          if (gen !== generation) return
          await ensureContainer(plan, port)
          await waitHealthy(`http://127.0.0.1:${port}`, gen)
          if (gen === generation) phase = undefined
        } catch (e) {
          if (gen !== generation) return
          const detail = e instanceof Error ? e.message : String(e)
          phase = { state: 'error', detail }
          log.warn('pii.sidecar-failed', { image: plan.image, err: e })
        }
      })
      return chain
    },

    /** What is under way right now — `encode` fails fast with it instead of a refused connection. */
    pending(): string | undefined {
      return phase && phase.state !== 'error' ? phase.state : undefined
    },

    /** Live state: the operation in flight, else what docker and /health say.
     *  Rejects when docker itself cannot be asked. */
    async status(plan: AnalyzerPlan, port: number): Promise<Phase> {
      if (phase) return phase
      const current = await inspect()
      if (!current) return { state: 'missing' }
      if (current.key !== `${plan.image}@${port}`) return { state: 'stopped', detail: 'settings changed' }
      if (current.status !== 'running') return { state: 'stopped' }
      return (await healthy(`http://127.0.0.1:${port}`)) ? { state: 'running' } : { state: 'starting' }
    }
  }
}

export type Analyzer = ReturnType<typeof createAnalyzer>

async function inspect(): Promise<{ status: string; key: string } | undefined> {
  const out = await run(
    'docker',
    ['ps', '-a', '--filter', `name=^${PRESIDIO_CONTAINER}$`, '--format', `{{.State}}|{{.Label "${KEY_LABEL}"}}`],
    () => {}
  )
  const line = out.trim().split('\n')[0]
  if (!line) return undefined
  const [status = '', key = ''] = line.split('|')
  return { status, key }
}

export async function healthy(url: string, apiKey?: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(3000)
    })
    return res.ok
  } catch {
    return false
  }
}

/** Entity types the analyzer supports, across `languages`. Empty when it cannot say. */
export async function supportedEntities(url: string, languages: string[], apiKey?: string): Promise<string[]> {
  const all = new Set<string>()
  await Promise.all(
    languages.map(async (language) => {
      try {
        const res = await fetch(`${url}/supportedentities?language=${encodeURIComponent(language)}`, {
          headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
          signal: AbortSignal.timeout(5000)
        })
        if (!res.ok) return
        const list: unknown = await res.json()
        if (Array.isArray(list)) for (const e of list) if (typeof e === 'string') all.add(e)
      } catch {
        // An analyzer that cannot list its entities still analyzes; the UI just offers no filter.
      }
    })
  )
  return [...all].sort()
}
