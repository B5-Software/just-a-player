import { writeFileSync } from 'node:fs'
const vlq = (value) => {
  const out = [value & 127]
  while ((value >>= 7)) out.unshift((value & 127) | 128)
  return out
}
/** Original synthetic scale fixture, including program, pedal, tempo and percussion. */
export function writeMidi(path, notes = 24) {
  const track = [
    0,
    0xff,
    3,
    9,
    ...Buffer.from('HiFi MIDI'),
    0,
    0xff,
    0x51,
    3,
    7,
    0xa1,
    0x20,
    0,
    0xc0,
    0,
    0,
    0xb0,
    7,
    96,
    0,
    0xb0,
    10,
    64,
  ]
  for (let n = 0; n < notes; n++) {
    track.push(
      0,
      0x90,
      60 + [0, 2, 4, 5, 7, 9, 11, 12][n % 8],
      88,
      ...vlq(360),
      0x80,
      60 + [0, 2, 4, 5, 7, 9, 11, 12][n % 8],
      0,
      ...vlq(120),
      0x99,
      42,
      50,
      ...vlq(120),
      0x89,
      42,
      0
    )
  }
  track.push(0, 0xff, 0x2f, 0)
  const header = Buffer.from([77, 84, 104, 100, 0, 0, 0, 6, 0, 0, 0, 1, 1, 224]),
    length = Buffer.alloc(4)
  length.writeUInt32BE(track.length)
  writeFileSync(path, Buffer.concat([header, Buffer.from('MTrk'), length, Buffer.from(track)]))
}
