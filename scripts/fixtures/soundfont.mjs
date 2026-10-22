import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
const u16 = (n) => {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return b
}
const u32 = (n) => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}
const name = (s) => {
  const b = Buffer.alloc(20)
  b.write(s)
  return b
}
const chunk = (id, data) =>
  Buffer.concat([
    Buffer.from(id),
    u32(data.length),
    data,
    ...(data.length % 2 ? [Buffer.alloc(1)] : []),
  ])
const list = (id, chunks) => chunk('LIST', Buffer.concat([Buffer.from(id), ...chunks]))
/** Original, small looping sine bank for tests; no third-party samples. CC0. */
export function writeTestSoundfont(target) {
  const n = 4410,
    samples = Buffer.alloc((n + 46) * 2)
  for (let i = 0; i < n; i++)
    samples.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 440) / 44100) * 12000), i * 2)
  const info = list('INFO', [
    chunk('ifil', Buffer.concat([u16(2), u16(1)])),
    chunk('isng', Buffer.from('EMU8000\0')),
    chunk('INAM', Buffer.from('JAP original sine fixture\0')),
  ])
  const ph = (s, index) =>
    Buffer.concat([name(s), u16(0), u16(0), u16(index), u32(0), u32(0), u32(0)])
  const ih = (s, index) => Buffer.concat([name(s), u16(index)])
  const bag = (gen, mod = 0) => Buffer.concat([u16(gen), u16(mod)])
  const gen = (op, val) => Buffer.concat([u16(op), u16(val)])
  const sh = (s, start, end) =>
    Buffer.concat([
      name(s),
      u32(start),
      u32(end),
      u32(start),
      u32(end),
      u32(44100),
      Buffer.from([69, 0]),
      u16(0),
      u16(1),
    ])
  const pdta = list('pdta', [
    chunk('phdr', Buffer.concat([ph('Sine', 0), ph('EOP', 1)])),
    chunk('pbag', Buffer.concat([bag(0), bag(1)])),
    chunk('pmod', Buffer.alloc(10)),
    chunk('pgen', Buffer.concat([gen(41, 0), gen(0, 0)])),
    chunk('inst', Buffer.concat([ih('Sine', 0), ih('EOI', 1)])),
    chunk('ibag', Buffer.concat([bag(0), bag(3)])),
    chunk('imod', Buffer.alloc(10)),
    chunk('igen', Buffer.concat([gen(54, 1), gen(58, 69), gen(53, 0), gen(0, 0)])),
    chunk('shdr', Buffer.concat([sh('Sine', 0, n), sh('EOS', n, n)])),
  ])
  const body = Buffer.concat([
    Buffer.from('sfbk'),
    info,
    list('sdta', [chunk('smpl', samples)]),
    pdta,
  ])
  fs.writeFileSync(target, Buffer.concat([Buffer.from('RIFF'), u32(body.length), body]))
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  writeTestSoundfont(fileURLToPath(new URL('./sine.sf2', import.meta.url)))
