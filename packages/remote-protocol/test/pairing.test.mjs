// The pairing payload (protocol §5) against testdata/pairing.json.
//
//   node --test packages/remote-protocol/test/pairing.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadProtocol, testdata } from './load.mjs'

const p = await loadProtocol()
const { fromHex, toHex } = p
const doc = testdata('pairing.json')

const neutral = (r) => ({
  kind: r.kind,
  v: r.v,
  r: r.r,
  h: r.h,
  k: toHex(r.k),
  ...(r.kind === 'pair' ? { s: toHex(r.s) } : {}),
  n: r.n
})

for (const c of doc.cases) {
  test(`${c.error ? 'rejects' : 'parses'}: ${c.name}`, () => {
    if (c.error) {
      assert.throws(
        () => p.parsePairingUrl(c.url),
        (e) => e instanceof p.PairingParseError && e.code === c.error,
        `expected ${c.error}`
      )
      return
    }
    assert.deepEqual(neutral(p.parsePairingUrl(c.url)), c.value)
    if (c.canonical) {
      const v = { ...c.value, k: fromHex(c.value.k), ...(c.value.s ? { s: fromHex(c.value.s) } : {}) }
      const built = c.value.kind === 'pair' ? p.buildPairingUrl(v) : p.buildRelayUrl(v)
      assert.equal(built, c.url, 'builds the same URL')
    }
  })
}

test('base64url: strict, unpadded, canonical', () => {
  for (const n of [0, 1, 2, 3, 4, 5, 31, 32, 33]) {
    const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255)
    const s = p.toB64u(b)
    assert.ok(!s.includes('='))
    assert.deepEqual(p.fromB64u(s), b)
    assert.equal(s, Buffer.from(b).toString('base64url'), 'matches Node’s encoder')
  }
  assert.throws(() => p.fromB64u('AB=='))
  assert.throws(() => p.fromB64u('A'))
  assert.throws(() => p.fromB64u('AB'), 'non-zero trailing bits: AB is not canonical for one byte')
  assert.deepEqual(p.fromB64u('AA'), Uint8Array.of(0))
})
