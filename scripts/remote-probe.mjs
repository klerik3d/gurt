#!/usr/bin/env node
import { loadProtocol } from '../packages/remote-protocol/test/load.mjs'
import { dialProbe } from './lib/probe-socket.mjs'

const args = process.argv.slice(2)
const value = flag => args[args.indexOf(flag) + 1]
let probe
try {
  if (!args.includes('--pair') || args.some((arg, i) => i % 2 === 0 && !['--pair', '--relay'].includes(arg)) || args.length % 2) throw new Error('arguments')
  const p = await loadProtocol()
  const host = p.parsePairingUrl(value('--pair'))
  if (host.kind !== 'pair') throw new Error('pair URL required')
  probe = new p.RemoteProbe(h => dialProbe(h, args.includes('--relay') ? value('--relay') : h.r), p.generateKeypair())
  await probe.pair(host, code => console.log(`Код сверки: ${code}. Сравните и подтвердите на desktop.`))
  const hello = await probe.connect(host)
  console.log(JSON.stringify({ api: hello.api, methods: hello.methods }))
  console.log(JSON.stringify(await probe.call('tree.get', {}), null, 2))
} catch {
  // Never echo input URLs, PSKs, keys, or exception strings derived from them.
  console.error('Remote probe failed. Usage: node scripts/remote-probe.mjs [--relay ws://…] --pair gurt://pair#…')
  process.exitCode = 1
} finally { probe?.close() }
