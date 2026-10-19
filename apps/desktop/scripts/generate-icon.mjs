import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const output = resolve(fileURLToPath(import.meta.url), '../../build')
mkdirSync(output, { recursive: true })
const table = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1
  return n >>> 0
})
const crc = (bytes) => {
  let n = 0xffffffff
  for (const b of bytes) n = table[(n ^ b) & 255] ^ (n >>> 8)
  return (n ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const b = Buffer.alloc(data.length + 12)
  b.writeUInt32BE(data.length)
  b.write(type, 4)
  data.copy(b, 8)
  b.writeUInt32BE(crc(b.subarray(4, -4)), b.length - 4)
  return b
}
function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const nx = (x + 0.5) / size,
        ny = (y + 0.5) / size,
        index = y * (size * 4 + 1) + x * 4 + 1
      const dx = Math.max(0.23 - nx, 0, nx - 0.77),
        dy = Math.max(0.23 - ny, 0, ny - 0.77)
      const alpha = Math.max(0, Math.min(1, (0.23 - Math.hypot(dx, dy)) * size + 0.5))
      const wave = [
        { x: 0.3, h: 0.22 },
        { x: 0.5, h: 0.5 },
        { x: 0.7, h: 0.34 }
      ].some((b) => Math.abs(nx - b.x) < 0.045 && Math.abs(ny - 0.5) < b.h / 2)
      const blend = Math.min(1, (nx + ny) / 2)
      raw[index] = wave ? 255 : Math.round(132 + blend * 58)
      raw[index + 1] = wave ? 255 : Math.round(118 - blend * 38)
      raw[index + 2] = 255
      raw[index + 3] = Math.round(alpha * 255)
    }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}
writeFileSync(resolve(output, 'icon.png'), png(1024))
const icon = png(256),
  ico = Buffer.alloc(22)
ico.writeUInt16LE(1, 2)
ico.writeUInt16LE(1, 4)
ico.writeUInt16LE(1, 10)
ico.writeUInt16LE(32, 12)
ico.writeUInt32LE(icon.length, 14)
ico.writeUInt32LE(22, 18)
writeFileSync(resolve(output, 'icon.ico'), Buffer.concat([ico, icon]))
const chunks = [
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024]
].map(([name, size]) => {
  const data = png(size),
    h = Buffer.alloc(8)
  h.write(name)
  h.writeUInt32BE(data.length + 8, 4)
  return Buffer.concat([h, data])
})
const header = Buffer.alloc(8)
header.write('icns')
header.writeUInt32BE(8 + chunks.reduce((n, c) => n + c.length, 0), 4)
writeFileSync(resolve(output, 'icon.icns'), Buffer.concat([header, ...chunks]))
