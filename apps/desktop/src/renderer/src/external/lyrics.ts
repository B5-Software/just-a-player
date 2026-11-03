import type { ExternalSnapshot } from '../../../shared/external-player'

function stamp(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000))
  return `[${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}]`
}
/** Feed the same enhanced-LRC parser used by the 2D and 3D lyric renderers. */
export function externalLyrics(s: ExternalSnapshot): string | null {
  const l = s.lyrics
  if (l.trackId !== s.track.id && l.trackId !== s.track.localPath) return null
  const lines: string[] = []
  if (typeof l.yrc === 'string' && l.yrc) {
    for (const raw of l.yrc.split(/\r?\n/)) {
      const line = /^\[(\d+),(\d+)\](.*)$/.exec(raw)
      if (!line) continue
      let text = stamp(Number(line[1]) / 1000 - l.offset)
      for (const word of line[3]!.matchAll(/\((\d+),(\d+),\d+\)(.*?)(?=\(\d+,\d+,\d+\)|$)/g)) {
        const at = Number(word[1]) / 1000 - l.offset
        text += stamp(at) + word[3] + stamp(at + Number(word[2]) / 1000)
      }
      lines.push(text)
    }
  }
  if (!lines.length) for (const line of l.lines) if (Number.isFinite(line.time)) lines.push(stamp(line.time) + line.lyric)
  for (const line of l.translation) if (Number.isFinite(line.time)) lines.push(stamp(line.time) + line.lyric)
  return lines.length ? lines.join('\n') : null
}
