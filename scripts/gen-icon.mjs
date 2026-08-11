// Generate resources/icon.png (1024x1024) — the gurt app icon.
// Pure Node: draws a macOS-style rounded square in warm graphite with the
// 2x2 dot logo, supersampled 2x for AA, and encodes the PNG by hand
// (zlib + CRC32). No image dependencies.
//
// The dots are literal session states, in the same colors the UI uses:
// top-left done (green), two idle (grey), bottom-right empty (outline).
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
const ringW = 30 * SS // stroke of the outline dot
const cx = S / 2
const cy = S / 2

// colors
const bgTop = [0x26, 0x24, 0x20]
const bgBot = [0x15, 0x14, 0x11]
const dim = [0xa3, 0xa0, 0x99]
const green = [0x6c, 0xc4, 0x7f]

// The flat graphite square reads as a black hole on a dark dock/menu bar.
// A beveled edge — lit from the upper-left, dark on the lower-right —
// plus a thin all-around rim keeps the silhouette visible on any background.
const specular = [0xf0, 0xed, 0xe4]
const bevelShadow = [0x06, 0x06, 0x05]
const rimTint = [0xc8, 0xc5, 0xbc]
const edgeBand = 44 * SS
const rimBand = 3 * SS
const gradStep = 2 * SS
const lightLen = Math.hypot(-0.45, -0.9)
const Lx = -0.45 / lightLen
const Ly = -0.9 / lightLen
// The specular glint is confined to the top-left corner (rather than
// running the full length of the top and left edges) by fading it out
// with distance from the corner's arc center.
const glintCx = inset + radius
const glintCy = inset + radius
const glintRadius = S * 0.32

/** Signed distance to the rounded-square border (<0 inside). */
const sdRoundRect = (x, y) => {
  const half = S / 2 - inset
  const qx = Math.abs(x - cx) - (half - radius)
  const qy = Math.abs(y - cy) - (half - radius)
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - radius
}

/** Outward normal of the rounded-square border, via a numeric SDF gradient. */
const sdNormal = (x, y) => {
  const dx = sdRoundRect(x + gradStep, y) - sdRoundRect(x - gradStep, y)
  const dy = sdRoundRect(x, y + gradStep) - sdRoundRect(x, y - gradStep)
  const len = Math.hypot(dx, dy) || 1
  return [dx / len, dy / len]
}

const dots = [-1, 1].flatMap((gy) =>
  [-1, 1].map((gx) => ({
    x: cx + (gx * dotD) / 2,
    y: cy + (gy * dotD) / 2,
    color: gx === -1 && gy === -1 ? green : dim,
    ring: gx === 1 && gy === 1
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
    // beveled edge: lit from the upper-left, so the top-left corner catches
    // a bright glint and the bottom-right corner falls into shadow.
    if (d > -edgeBand) {
      const [nx, ny] = sdNormal(x + 0.5, y + 0.5)
      const dot = nx * Lx + ny * Ly
      let et = Math.min(1, Math.max(0, 1 + d / edgeBand))
      et = et * et * (3 - 2 * et)
      if (dot > 0) {
        const cdist = Math.hypot(x - glintCx, y - glintCy)
        let ct = Math.min(1, Math.max(0, 1 - cdist / glintRadius))
        ct = ct * ct * (3 - 2 * ct)
        const k = dot * et * 0.55 * ct
        r = r * (1 - k) + specular[0] * k
        g = g * (1 - k) + specular[1] * k
        b = b * (1 - k) + specular[2] * k
      } else {
        const k = -dot * et * 0.5
        r = r * (1 - k) + bevelShadow[0] * k
        g = g * (1 - k) + bevelShadow[1] * k
        b = b * (1 - k) + bevelShadow[2] * k
      }
    }
    // thin all-around rim so the silhouette separates from any background
    if (d > -rimBand) {
      const rt = Math.min(1, Math.max(0, 1 + d / rimBand))
      const k = rt * 0.22
      r = r * (1 - k) + rimTint[0] * k
      g = g * (1 - k) + rimTint[1] * k
      b = b * (1 - k) + rimTint[2] * k
    }
    for (const dot of dots) {
      const dist = Math.hypot(x + 0.5 - dot.x, y + 0.5 - dot.y)
      // 1px AA ramps: outer edge for every dot, inner edge for the ring only.
      let k = Math.min(1, 0.5 - (dist - dotR))
      if (dot.ring) k = Math.min(k, Math.min(1, 0.5 - (dotR - ringW - dist)))
      if (k > 0) {
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
