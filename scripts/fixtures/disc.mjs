// Original synthetic CD-DA / Scarlet Book fixture; no commercial recording.
import fs from 'node:fs'
import path from 'node:path'
export function writeDiscFixtures(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const frames = 75,
    start = 600,
    sectors = frames * 5,
    b = Buffer.alloc((start + sectors * 2) * 2048)
  b.write('SACDMTOC', 510 * 2048)
  b.writeUInt32BE(544, 510 * 2048 + 64)
  b[510 * 2048 + 138] = 2
  const master = 511 * 2048
  b.write('SACDText', master)
  b.writeUInt16BE(64, master + 16)
  b.write('Original Album\0', master + 64)
  b.writeUInt16BE(96, master + 18)
  b.write('B5-Software\0', master + 96)
  const toc = 544 * 2048
  b.write('TWOCHTOC', toc)
  b.writeUInt16BE(8, toc + 10)
  b[toc + 21] = 2
  b[toc + 32] = 2
  b[toc + 69] = 2
  b[toc + 90] = 2
  b.writeUInt32BE(start, toc + 72)
  b.writeUInt32BE(start + sectors * 2 - 1, toc + 76)
  b.write('SACDTRL1', 545 * 2048)
  b.write('SACDTRL2', 546 * 2048)
  b.write('SACDTTxt', 549 * 2048)
  for (let track = 0; track < 2; track++) {
    b.writeUInt32BE(start + sectors * track, 545 * 2048 + 8 + track * 4)
    b.writeUInt32BE(sectors, 545 * 2048 + 1028 + track * 4)
    b[546 * 2048 + 9 + track * 4] = 2 + track
    b[546 * 2048 + 1029 + track * 4] = 1
    const pos = 4096 + track * 64,
      names = 549 * 2048
    b.writeUInt16BE(pos, names + 8 + track * 2)
    b[names + pos] = 1
    b[names + pos + 4] = 1
    b[names + pos + 5] = 0x20
    b.write(`SACD Track ${track + 1}\0`, names + pos + 6)
    for (let frame = 0; frame < frames; frame++)
      for (let part = 0; part < 5; part++) {
        const at = (start + track * sectors + frame * 5 + part) * 2048,
          len = part === 4 ? 1408 : 2000
        b[at] = 32 + (part === 0 ? 4 : 0)
        b[at + 1] = 16 + (part === 0 ? 128 : 0) + (len >> 8)
        b[at + 2] = len & 255
        if (!part) {
          b[at + 4] = 2 + track
          b[at + 5] = frame
        }
        b.fill(0x69 + track, at + (part === 0 ? 6 : 3), at + (part === 0 ? 6 : 3) + len)
      }
  }
  const iso = path.join(dir, '原创 SACD.iso'),
    cue = path.join(dir, 'Original CD.cue'),
    bin = path.join(dir, 'Original CD.bin')
  fs.writeFileSync(iso, b)
  const pcm = Buffer.alloc(2352 * 150)
  for (let i = 0; i < 44100 * 2; i++) {
    const value = i < 44100 ? 1024 : -2048
    pcm.writeInt16LE(value, i * 4)
    pcm.writeInt16LE(value, i * 4 + 2)
  }
  fs.writeFileSync(bin, pcm)
  fs.writeFileSync(
    cue,
    'TITLE "Original CD"\nPERFORMER "B5-Software"\nFILE "Original CD.bin" BINARY\nTRACK 01 AUDIO\nTITLE "CD First"\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nTITLE "CD Second"\nINDEX 01 00:01:00\n'
  )
  return { iso, cue, bin }
}
