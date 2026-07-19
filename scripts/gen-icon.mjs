// Generate resources/icon.png (1024x1024) — the gurt app icon.
// Pure Node: draws a macOS-style rounded square in warm graphite with the
// 2x2 dot logo (top-left dot in accent blue), supersampled 2x for AA, and
// encodes the PNG by hand (zlib + CRC32). No image dependencies.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'resources/icon.png')

const SIZE = 1024
const SS = 2 // supersample factor
const S = SIZE * SS

// geometry (in supersampled units)
const inset = 100 * SS // transparent margin, macOS icons keep ~10%
const radius = 186 * SS
const dotR = 88 * SS
const dotD = 264 * SS // center-to-center
const cx = S / 2
const cy = S / 2

// colors
const bgTop = [0x26, 0x24, 0x20]
const bgBot = [0x15, 0x14, 0x11]
const border = [0x4a, 0x47, 0x40]
const dim = [0xa3, 0xa0, 0x99]
const accent = [0x4d, 0xa3, 0xff]

/** Signed distance to the rounded-square border (<0 inside). */
const sdRoundRect = (x, y) => {
  const half = S / 2 - inset
  const qx = Math.abs(x - cx) - (half - radius)
  const qy = Math.abs(y - cy) - (half - radius)
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - radius
}

const dots = [-1, 1].flatMap((gy) =>
  [-1, 1].map((gx) => ({
    x: cx + (gx * dotD) / 2,
    y: cy + (gy * dotD) / 2,
    color: gx === -1 && gy === -1 ? accent : dim
  }))
)

const img = new Uint8Array(S * S * 4)
for (let y = 0; y < S; y++) {
  const t = y / S
  const bg = bgTop.map((c, i) => c + (bgBot[i] - c) * t)
  for (let x = 0; x < S; x++) {
    const d = sdRoundRect(x + 0.5, y + 0.5)
    if (d > 0.5) continue // outside — transparent
    let [r, g, b] = bg
    // faint inner border highlight along the edge
    if (d > -3 * SS) {
      const k = 0.35
      r = r * (1 - k) + border[0] * k
      g = g * (1 - k) + border[1] * k
      b = b * (1 - k) + border[2] * k
    }
    for (const dot of dots) {
      const dd = Math.hypot(x + 0.5 - dot.x, y + 0.5 - dot.y) - dotR
      if (dd < 0.5) {
        const k = Math.min(1, 0.5 - dd) // 1px AA ramp on the dot edge
        r = r * (1 - k) + dot.color[0] * k
        g = g * (1 - k) + dot.color[1] * k
        b = b * (1 - k) + dot.color[2] * k
      }
    }
    const a = Math.min(1, 0.5 - d) // AA ramp on the square edge
    const o = (y * S + x) * 4
    img[o] = r
    img[o + 1] = g
    img[o + 2] = b
    img[o + 3] = Math.round(a * 255)
  }
}

// box-downsample SS^2 -> 1 (premultiply over the transparent margin)
const out = new Uint8Array(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y++)
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0
    for (let sy = 0; sy < SS; sy++)
      for (let sx = 0; sx < SS; sx++) {
        const o = ((y * SS + sy) * S + x * SS + sx) * 4
        const al = img[o + 3] / 255
        r += img[o] * al
        g += img[o + 1] * al
        b += img[o + 2] * al
        a += al
      }
    const o = (y * SIZE + x) * 4
    if (a > 0) {
      out[o] = Math.round(r / a)
      out[o + 1] = Math.round(g / a)
      out[o + 2] = Math.round(b / a)
    }
    out[o + 3] = Math.round((a / (SS * SS)) * 255)
  }

// --- PNG encoding ---
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0 // filter: none
  Buffer.from(out.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1)
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, png)
console.log('wrote', OUT, `${png.length} bytes`)
