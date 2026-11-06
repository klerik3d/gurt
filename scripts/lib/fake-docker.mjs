// A fake `docker` for the runtime tests (docs/requirements-env-docker.md §13.4):
// an executable first on PATH that records every invocation — argv, stdin (for
// `exec -i`) and the values of the env vars named in `ctl.watch` — as one JSON
// line, and answers the subcommands the docker runtime uses from a control file
// the test rewrites between calls. No daemon, no network.
//
//   const fake = installFakeDocker(dir)
//   fake.ctl({ exec: [{ match: 'npm ci', codes: [1, 0] }] })
//   fake.calls()   // [{ args, stdin?, env? }, …] since the last reset()
import fs from 'node:fs'
import path from 'node:path'

const SCRIPT = `
const fs = require('fs')
const CTL = process.env.FAKE_DOCKER_CTL
const LOG = process.env.FAKE_DOCKER_LOG
const ctl = JSON.parse(fs.readFileSync(CTL, 'utf8'))
const save = () => fs.writeFileSync(CTL, JSON.stringify(ctl))
const a = process.argv.slice(2)
const entry = { args: a }
const watch = ctl.watch || []
if (watch.length) {
  entry.env = {}
  for (const n of watch) if (process.env[n] !== undefined) entry.env[n] = process.env[n]
}
const out = (s) => process.stdout.write(s)
const err = (s) => process.stderr.write(s)
const done = (code) => {
  fs.appendFileSync(LOG, JSON.stringify(entry) + '\\n')
  save()
  process.exit(code)
}
const flag = (n) => { const i = a.indexOf(n); return i < 0 ? '' : a[i + 1] }

if (a[0] === 'exec') {
  let i = 1
  const o = { env: [], i: false, t: false }
  while (i < a.length) {
    const x = a[i]
    if (x === '-i') { o.i = true; i++ }
    else if (x === '-t') { o.t = true; i++ }
    else if (x === '-u' || x === '-w') { o[x] = a[i + 1]; i += 2 }
    else if (x === '-e') { o.env.push(a[i + 1]); i += 2 }
    else break
  }
  const cmd = a.slice(i + 1)
  if (o.i) entry.stdin = fs.readFileSync(0, 'utf8')
  const joined = cmd.join('\\n')
  ctl.counts = ctl.counts || {}
  const rules = ctl.exec || []
  const idx = rules.findIndex((r) => joined.includes(r.match))
  if (idx >= 0) {
    const r = rules[idx]
    const n = ctl.counts[idx] || 0
    ctl.counts[idx] = n + 1
    const codes = r.codes || [0]
    if (r.stdout) out(r.stdout)
    if (r.stderr) err(r.stderr)
    done(codes[Math.min(n, codes.length - 1)])
  }
  if (joined.includes('__GURT_ENV__')) {
    out('noise__GURT_ENV__/home/dev__GURT_ENV__/usr/local/bin:/usr/bin:/bin__GURT_ENV__')
    done(0)
  }
  done(0)
}
if (a[0] === 'create') {
  ctl.creates = (ctl.creates || 0) + 1
  const fails = ctl.createFails || []
  if (fails.length) {
    const f = fails.shift()
    err(f.stderr || 'create failed')
    done(f.code || 125)
  }
  out('cid-' + ctl.creates + '\\n')
  done(0)
}
if (a[0] === 'info') { out('27.0.0\\n'); done(0) }
if (a[0] === 'image' && a[1] === 'inspect') {
  if (ctl.imageMissing) done(1)
  out(flag('-f').includes('Architecture') ? (ctl.image || 'dev|amd64') + '\\n' : 'sha256:abc\\n')
  done(0)
}
if (a[0] === 'volume' && a[1] === 'inspect') done(ctl.volumeExists ? 0 : 1)
if (a[0] === 'run' && a.includes('--entrypoint') && flag('--entrypoint') === 'test') done(ctl.volumeReady ? 0 : 1)
if (a[0] === 'ps') {
  if (ctl.psExit) done(ctl.psExit)
  const j = a.join(' ')
  if (j.includes('label=gurt.proxy')) out(ctl.psProxy || '')
  else if (j.includes('label=gurt.session=')) out(ctl.psSession || '')
  else out(ctl.ps || '')
  done(0)
}
if (a[0] === 'inspect') {
  if (ctl.inspectExit) { err('Error: No such object: ' + a[a.length - 1] + '\\n'); done(ctl.inspectExit) }
  const f = flag('-f')
  out(f.includes('Networks') ? 'bridge \\n' : f.includes('State.Running') ? (ctl.running === false ? 'false\\n' : 'true\\n') : 'id\\n')
  done(0)
}
if (a[0] === 'network' && a[1] === 'ls') { out(ctl.netLs || ''); done(0) }
done(0)
`

export function installFakeDocker(dir) {
  const bin = path.join(dir, 'fake-bin')
  fs.mkdirSync(bin, { recursive: true })
  const ctlFile = path.join(dir, 'fake-docker-ctl.json')
  const logFile = path.join(dir, 'fake-docker-log.jsonl')
  fs.writeFileSync(path.join(bin, 'docker'), `#!${process.execPath}\n${SCRIPT}`, { mode: 0o755 })
  process.env.FAKE_DOCKER_CTL = ctlFile
  process.env.FAKE_DOCKER_LOG = logFile
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
  const read = () => (fs.existsSync(ctlFile) ? JSON.parse(fs.readFileSync(ctlFile, 'utf8')) : {})
  const api = {
    /** Replace the control state (nothing carries over — counters included). */
    reset(ctl = {}) {
      fs.writeFileSync(ctlFile, JSON.stringify(ctl))
      fs.rmSync(logFile, { force: true })
    },
    /** Merge into the control state. */
    ctl(patch) {
      fs.writeFileSync(ctlFile, JSON.stringify({ ...read(), ...patch }))
    },
    state: read,
    calls() {
      const raw = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
      return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    },
    /** Calls whose argv starts with the given words, e.g. `of('rm')`. */
    of(...words) {
      return api.calls().filter((c) => words.every((w, i) => c.args[i] === w))
    },
    /** `exec` calls, parsed: the container, user, cwd, -e list and command. */
    execs() {
      return api.of('exec').map((c) => {
        const a = c.args
        let i = 1
        /** @type {{ env: string[], flags: string[], user?: string, cwd?: string }} */
        const o = { env: [], flags: [] }
        while (i < a.length) {
          const x = a[i]
          if (x === '-i' || x === '-t') { o.flags.push(x); i++ }
          else if (x === '-u') { o.user = a[i + 1]; i += 2 }
          else if (x === '-w') { o.cwd = a[i + 1]; i += 2 }
          else if (x === '-e') { o.env.push(a[i + 1]); i += 2 }
          else break
        }
        return { ...o, id: a[i], cmd: a.slice(i + 1), stdin: c.stdin, raw: c }
      })
    }
  }
  api.reset()
  return api
}
