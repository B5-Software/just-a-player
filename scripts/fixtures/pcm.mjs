// Original synthetic PCM fixtures, CC0-1.0, B5-Software.
export const WORD_LYRICS =
  '[ar:B5-Software]\n[ti:逐字歌词测试]\n[00:00.000]测[00:00.500]试[00:01.000]逐[00:01.500]字[00:02.000]歌[00:02.500]词[00:03.000]\n[00:03.000]Just A Player\n'
export function wave({ rate = 48000, seconds = 4, rf64 = false, bits = 16 } = {}) {
  const frames = Math.round(rate * seconds),
    width = bits / 8,
    offset = rf64 ? 80 : 44
  const b = Buffer.alloc(offset + frames * width * 2)
  b.write(rf64 ? 'RF64' : 'RIFF')
  b.writeUInt32LE(rf64 ? 0xffffffff : b.length - 8, 4)
  b.write('WAVE', 8)
  let at = 12
  if (rf64) {
    b.write('ds64', at)
    b.writeUInt32LE(28, at + 4)
    b.writeBigUInt64LE(BigInt(b.length - 8), at + 8)
    b.writeBigUInt64LE(BigInt(frames * width * 2), at + 16)
    b.writeBigUInt64LE(BigInt(frames), at + 24)
    at += 36
  }
  b.write('fmt ', at)
  b.writeUInt32LE(16, at + 4)
  b.writeUInt16LE(bits === 64 ? 3 : 1, at + 8)
  b.writeUInt16LE(2, at + 10)
  b.writeUInt32LE(rate, at + 12)
  b.writeUInt32LE(rate * width * 2, at + 16)
  b.writeUInt16LE(width * 2, at + 20)
  b.writeUInt16LE(bits, at + 22)
  b.write('data', at + 24)
  b.writeUInt32LE(rf64 ? 0xffffffff : frames * width * 2, at + 28)
  for (let i = 0; i < frames; i++)
    for (let ch = 0; ch < 2; ch++) {
      const value = Math.sin((i / rate) * (ch ? 1500 : 1000) * Math.PI * 2) * 0.25
      if (bits === 64) b.writeDoubleLE(value, offset + (i * 2 + ch) * width)
      else b.writeInt16LE(Math.round(value * 32767), offset + (i * 2 + ch) * width)
    }
  return b
}
export function flacLyrics(original, lyrics = WORD_LYRICS) {
  if (original.toString('ascii', 0, 4) !== 'fLaC') throw Error('Not FLAC')
  const b = Buffer.from(original)
  let at = 4
  while (at + 4 <= b.length) {
    const last = !!(b[at] & 128),
      length = b.readUIntBE(at + 1, 3)
    b[at] &= 127
    at += length + 4
    if (last) break
  }
  const tag = Buffer.from('LYRICS=' + lyrics),
    vendor = Buffer.from('Just A Player CC0 QA')
  const block = Buffer.alloc(4 + 4 + vendor.length + 4 + 4 + tag.length)
  block[0] = 0x84
  block.writeUIntBE(block.length - 4, 1, 3)
  block.writeUInt32LE(vendor.length, 4)
  vendor.copy(block, 8)
  block.writeUInt32LE(1, 8 + vendor.length)
  block.writeUInt32LE(tag.length, 12 + vendor.length)
  tag.copy(block, 16 + vendor.length)
  return Buffer.concat([b.subarray(0, at), block, b.subarray(at)])
}
