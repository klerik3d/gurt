/** Node WebSocket adapter. Keeps binary messages queued, including hello immediately after handshake. */
export function socketStream(socket, timeoutMs = 10000) {
  socket.binaryType = 'arraybuffer'
  const queue = []
  let waiter
  let failure
  const fail = (error) => {
    failure = error
    if (waiter) { const w = waiter; waiter = undefined; w.reject(error) }
  }
  socket.onmessage = ({ data }) => {
    if (!(data instanceof ArrayBuffer)) { fail(new Error('non-binary relay message')); socket.close(); return }
    const bytes = new Uint8Array(data)
    if (waiter) { const w = waiter; waiter = undefined; w.resolve(bytes) }
    else queue.push(bytes)
  }
  socket.onclose = ({ code }) => fail(new Error(`relay closed (${code})`))
  socket.onerror = () => fail(new Error('relay socket error'))
  return {
    send: data => socket.send(data),
    receive() {
      if (queue.length) return Promise.resolve(queue.shift())
      if (failure) return Promise.reject(failure)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiter = undefined; reject(new Error('relay read timeout')) }, timeoutMs)
        waiter = { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } }
      })
    },
    close() { fail(new Error('stream closed')); socket.close() }
  }
}

export async function dialProbe(host, relay = host.r, factory = url => new WebSocket(url)) {
  const url = new URL(relay)
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('invalid relay URL')
  url.pathname = '/v1/client'
  url.searchParams.set('host', host.h)
  const socket = factory(url.href)
  const stream = socketStream(socket, 310000) // desktop confirmation may take the QR's full lifetime
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('relay connect timeout')) }, 10000)
    socket.onopen = () => { clearTimeout(timer); resolve(undefined) }
    const onclose = socket.onclose
    socket.onclose = event => { clearTimeout(timer); onclose.call(socket, event); reject(new Error(`relay closed (${event.code})`)) }
    const onerror = socket.onerror
    socket.onerror = event => { clearTimeout(timer); onerror.call(socket, event); reject(new Error('relay socket error')) }
  })
  return stream
}
