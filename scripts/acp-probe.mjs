// Probe an ACP adapter: spawn, send initialize (+ session/new), print responses.
// usage: node acp-probe.mjs <command> [args...]
import { spawn } from 'node:child_process'

const [cmd, ...args] = process.argv.slice(2)
const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
child.stderr.on('data', (d) => console.log('[stderr]', d.toString().trim().slice(0, 300)))
child.on('close', (c) => {
  console.log('[exit]', c)
  process.exit(0)
})

let buf = ''
child.stdout.on('data', (d) => {
  buf += d.toString()
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (line) console.log('[recv]', line.slice(0, 500))
    if (line.includes('"id":1')) {
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'session/new',
          params: { cwd: process.cwd(), mcpServers: [] }
        }) + '\n'
      )
    }
    if (line.includes('"id":2')) {
      console.log('PROBE OK')
      child.kill()
    }
  }
})

child.stdin.write(
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
    }
  }) + '\n'
)

setTimeout(() => {
  console.log('TIMEOUT')
  child.kill()
  process.exit(1)
}, 60000)
