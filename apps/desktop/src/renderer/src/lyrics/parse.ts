export interface LyricLine {
  /** 秒。 */
  t: number
  text: string
  /** 同一时间戳的第二行（双语歌词的译文）。 */
  sub: string
}

/**
 * 解析 LRC：支持一行多个时间戳、`[offset:]`、增强型逐字标签（去掉只留文本）。
 * 同一时间戳出现两行时，第二行作为译文。
 */
export function parseLRC(src: string): LyricLine[] {
  const raw: { t: number; text: string }[] = []
  let offset = 0
  for (const line of src.split(/\r?\n/)) {
    const tags = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)]
    if (tags.length === 0) {
      const match = /^\s*\[offset:\s*([+-]?\d+)\]/i.exec(line)
      if (match) offset = Number(match[1]) / 1000
      continue
    }
    const text = line.replace(/\[[^\]]*\]|<[^>]*>/g, '').trim()
    for (const tag of tags) raw.push({ t: Number(tag[1]) * 60 + Number(tag[2]), text })
  }

  raw.sort((a, b) => a.t - b.t)
  const out: LyricLine[] = []
  for (const item of raw) {
    const t = Math.max(0, item.t - offset)
    const last = out[out.length - 1]
    if (last && Math.abs(last.t - t) < 0.005 && last.text && item.text && !last.sub) {
      last.sub = item.text
    } else {
      out.push({ t, text: item.text, sub: '' })
    }
  }
  return out
}
