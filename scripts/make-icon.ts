/** Writes src-tauri/app-icon.png (1024x1024). Run `npx tauri icon src-tauri/app-icon.png` after. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

const SIZE = 1024
const RADIUS = 224

function crc32(buf: Buffer): number {
  let c = ~0
  for (const byte of buf) {
    c ^= byte
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return ~c >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function insideRounded(x: number, y: number): boolean {
  const cx = Math.min(Math.max(x, RADIUS), SIZE - RADIUS)
  const cy = Math.min(Math.max(y, RADIUS), SIZE - RADIUS)
  return (x - cx) ** 2 + (y - cy) ** 2 <= RADIUS ** 2
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0
  for (let x = 0; x < SIZE; x += 1) {
    const i = y * (SIZE * 4 + 1) + 1 + x * 4
    if (!insideRounded(x, y)) continue
    const t = y / SIZE
    // Dark glass tile with a soft accent ring.
    let r = 22 + 14 * (1 - t)
    let g = 22 + 14 * (1 - t)
    let b = 28 + 18 * (1 - t)
    const d = Math.hypot(x - SIZE / 2, y - SIZE / 2)
    const ring = Math.exp(-(((d - 250) / 26) ** 2))
    r += (10 - r) * ring
    g += (132 - g) * ring
    b += (255 - b) * ring
    raw[i] = r
    raw[i + 1] = g
    raw[i + 2] = b
    raw[i + 3] = 255
  }
}

const header = Buffer.alloc(13)
header.writeUInt32BE(SIZE, 0)
header.writeUInt32BE(SIZE, 4)
header[8] = 8
header[9] = 6
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
const out = join(process.cwd(), 'src-tauri', 'app-icon.png')
writeFileSync(out, png)
process.stdout.write(`wrote ${out}\n`)
