/**
 * Generate the extension icons procedurally.
 *
 * Zero dependencies: the PNG encoder below is minimal (8-bit RGBA, filter 0,
 * zlib deflate) and the glyph is drawn with supersampled coverage so the small
 * sizes stay crisp without shipping a binary asset anyone has to redraw.
 *
 *   node tools/make-icons.mjs
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', 'icons')
const SIZES = [16, 32, 48, 128]

/* ------------------------------------------------------------- PNG encoder */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ------------------------------------------------------------------- glyph */

/** Rounded-rectangle membership test in normalized 0..1 coordinates. */
function roundedRect(x0, y0, x1, y1, radius) {
  return (x, y) => {
    const cx = Math.min(Math.max(x, x0 + radius), x1 - radius)
    const cy = Math.min(Math.max(y, y0 + radius), y1 - radius)
    const dx = x - cx
    const dy = y - cy
    return dx * dx + dy * dy <= radius * radius
  }
}

const inBackground = roundedRect(0, 0, 1, 1, 0.22)

/** Three tabs sitting on a tray — the universal "tab group" pictogram. */
const inTab = [
  roundedRect(0.175, 0.28, 0.33, 0.68, 0.045),
  roundedRect(0.4225, 0.28, 0.5775, 0.68, 0.045),
  roundedRect(0.67, 0.28, 0.825, 0.68, 0.045),
]
const inTray = roundedRect(0.135, 0.6, 0.865, 0.735, 0.055)

function shapeAt(x, y) {
  if (!inBackground(x, y)) return null
  if (inTray(x, y)) return 'white'
  for (const test of inTab) if (test(x, y)) return 'white'
  return 'bg'
}

/** Vertical blue gradient, top lighter, for a bit of depth. */
function backgroundRgba(y) {
  const t = Math.min(Math.max(y, 0), 1)
  const from = [0x4f, 0x84, 0xff]
  const to = [0x17, 0x3a, 0xad]
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t),
  ]
}

function renderIcon(size, supersample = 8) {
  const rgba = Buffer.alloc(size * size * 4)
  const step = 1 / (size * supersample)
  const samples = supersample * supersample

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0

      for (let sy = 0; sy < supersample; sy += 1) {
        const y = (py * supersample + sy + 0.5) * step
        for (let sx = 0; sx < supersample; sx += 1) {
          const x = (px * supersample + sx + 0.5) * step
          const shape = shapeAt(x, y)
          if (shape === null) continue
          a += 1
          if (shape === 'white') {
            r += 0xff
            g += 0xff
            b += 0xff
          } else {
            const [br, bg, bb] = backgroundRgba(y)
            r += br
            g += bg
            b += bb
          }
        }
      }

      const offset = (py * size + px) * 4
      if (a === 0) continue
      rgba[offset] = Math.round(r / a)
      rgba[offset + 1] = Math.round(g / a)
      rgba[offset + 2] = Math.round(b / a)
      rgba[offset + 3] = Math.round((255 * a) / samples)
    }
  }

  return encodePng(size, size, rgba)
}

mkdirSync(OUT_DIR, { recursive: true })
for (const size of SIZES) {
  const file = join(OUT_DIR, `icon${size}.png`)
  const png = renderIcon(size, size <= 16 ? 10 : 6)
  writeFileSync(file, png)
  console.log(`wrote ${file} (${png.length} bytes)`)
}
