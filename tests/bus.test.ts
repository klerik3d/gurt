// Contract tests for the in-process domain-event bus (src/main/bus.ts):
// synchronous dispatch in subscription order, unsubscribe via the returned
// closure, and a throwing handler logged without breaking the emitter or
// the other handlers.
import { it } from 'vitest'
import assert from 'node:assert/strict'

import { createBus } from '../src/main/bus'

it('delivers to every subscriber, in subscription order, synchronously', () => {
  const bus = createBus()
  const calls: string[] = []
  bus.on('provision.log', (p) => calls.push(`a:${p.line}`))
  bus.on('provision.log', (p) => calls.push(`b:${p.line}`))
  bus.on('provision.log', (p) => calls.push(`c:${p.line}`))
  bus.emit('provision.log', { key: 'k', line: 'one' })
  // Dispatch is synchronous — everything already happened by the next statement.
  assert.deepEqual(calls, ['a:one', 'b:one', 'c:one'])
  bus.emit('provision.log', { key: 'k', line: 'two' })
  assert.deepEqual(calls.slice(3), ['a:two', 'b:two', 'c:two'])
})

it('passes the payload through by reference', () => {
  const bus = createBus()
  let got: unknown
  bus.on('session.changed', (p) => (got = p))
  const payload = { sessionId: 's1' }
  bus.emit('session.changed', payload)
  assert.equal(got, payload)
})

it('events are isolated per type; emitting with no subscribers is a no-op', () => {
  const bus = createBus()
  const seen: string[] = []
  bus.on('session.changed', (p) => seen.push(p.sessionId))
  bus.emit('tree.changed', undefined) // never subscribed — must not throw
  bus.emit('provision.log', { key: 'k', line: 'x' }) // different type — must not leak
  assert.deepEqual(seen, [])
  bus.emit('session.changed', { sessionId: 's1' })
  assert.deepEqual(seen, ['s1'])
})

it('unsubscribe removes only that handler; calling it twice is harmless', () => {
  const bus = createBus()
  const calls: string[] = []
  const offA = bus.on('provision.log', () => calls.push('a'))
  bus.on('provision.log', () => calls.push('b'))
  offA()
  offA() // idempotent
  bus.emit('provision.log', { key: 'k', line: 'x' })
  assert.deepEqual(calls, ['b'])
  // Re-subscribing appends at the end of the order again.
  bus.on('provision.log', () => calls.push('a2'))
  bus.emit('provision.log', { key: 'k', line: 'y' })
  assert.deepEqual(calls.slice(1), ['b', 'a2'])
})

it('a throwing handler is caught and logged; the others still run', () => {
  const bus = createBus()
  const calls: string[] = []
  const logged: unknown[][] = []
  const realError = console.error
  console.error = (...args: unknown[]) => {
    logged.push(args)
  }
  try {
    bus.on('provision.log', () => {
      throw new Error('boom')
    })
    bus.on('provision.log', () => calls.push('after'))
    bus.emit('provision.log', { key: 'k', line: 'x' }) // must not throw
    assert.deepEqual(calls, ['after'], 'the sibling handler still ran')
    assert.equal(logged.length, 1, 'the failure was logged exactly once')
    assert.ok(String(logged[0][0]).includes('"provision.log" handler failed'))
    assert.equal((logged[0][1] as Error).message, 'boom')
  } finally {
    console.error = realError
  }
})
