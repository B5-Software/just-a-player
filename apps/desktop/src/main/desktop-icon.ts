import { nativeImage } from 'electron'
import { deflateSync } from 'node:zlib'
// Small original PNG icon; no system font or external icon asset.
export function icon(kind = 'logo'): Electron.NativeImage {
  const w = 32,
    raw = Buffer.alloc((w * 4 + 1) * w)
  for (let y = 0; y < w; y++)
    for (let x = 0; x < w; x++) {
      const i = y * (w * 4 + 1) + 1 + x * 4
      const bar =
        kind === 'previous'
          ? (x > 8 && x < 12 && y > 8 && y < 25) ||
            (x > 12 && x < 25 && Math.abs(y - 16) < (25 - x) * 0.7)
          : kind === 'next'
            ? (x > 22 && x < 26 && y > 8 && y < 25) ||
              (x > 6 && x < 22 && Math.abs(y - 16) < (x - 6) * 0.7)
            : kind === 'play'
              ? x > 10 && x < 24 && Math.abs(y - 16) < (24 - x) * 0.7
              : [9, 15, 21].some((b, k) => x >= b && x < b + 3 && Math.abs(y - 16) < [5, 10, 7][k]!)
      raw[i] = bar ? 255 : 132
      raw[i + 1] = bar ? 255 : 118
      raw[i + 2] = 255
      const corner =
        Math.max(0, 8 - Math.min(x, w - 1 - x)) ** 2 + Math.max(0, 8 - Math.min(y, w - 1 - y)) ** 2
      raw[i + 3] = corner > 64 ? 0 : 255
    }
  const crc = (b: Buffer): number => {
    let c = 0xffffffff
    for (const v of b) {
      c ^= v
      for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0)
    }
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const t = Buffer.from(type)
    const head = Buffer.alloc(4),
      tail = Buffer.alloc(4)
    head.writeUInt32BE(data.length)
    tail.writeUInt32BE(crc(Buffer.concat([t, data])))
    return Buffer.concat([head, t, data, tail])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(w)
  header.writeUInt32BE(w, 4)
  header[8] = 8
  header[9] = 6
  return nativeImage.createFromBuffer(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0))
    ])
  )
}
