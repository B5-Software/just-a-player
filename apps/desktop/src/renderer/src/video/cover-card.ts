import type { TrackInfo } from '@shared/protocol/TrackInfo'
import type { LyricsFontId } from '@shared/settings'
import { fontOf, ensureFont } from '../fonts/catalog'

const smooth = (n: number): number => {
  const t = Math.max(0, Math.min(1, n))
  return t * t * (3 - 2 * t)
}
/** Both the first and final encoded frames are transparent, including short clips. */
export function metadataOpacity(time: number, duration: number, fps: number): number {
  const last = Math.max(0, duration - 1 / fps),
    fade = Math.min(0.65, last * 0.35)
  return fade > 0 ? Math.min(smooth(time / fade), smooth((last - time) / fade)) : 0
}
function rounded(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  c.beginPath()
  c.roundRect(x, y, w, h, r)
}
function wrap(
  c: CanvasRenderingContext2D,
  text: string,
  width: number,
  maxLines: number
): string[] {
  const result: string[] = [],
    chars = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(
      (s) => s.segment
    )
  let line = ''
  for (const char of chars) {
    if (line && c.measureText(line + char).width > width) {
      result.push(line)
      line = ''
      if (result.length >= maxLines - 1) break
    }
    line += char
  }
  if (result.length < maxLines) {
    const used = result.join('').length
    let tail = text.slice(used)
    while (tail.length > 1 && c.measureText(tail).width > width) tail = tail.slice(0, -1)
    if (tail.length < text.slice(used).length) tail = tail.slice(0, -1) + '…'
    if (tail) result.push(tail)
  }
  return result
}
export async function createCoverCard(
  track: TrackInfo,
  artUrl: string | null,
  accent: string,
  width: number,
  height: number,
  fontId: LyricsFontId,
  signature: string
): Promise<HTMLCanvasElement> {
  await ensureFont(fontId)
  const font = fontOf(fontId),
    title =
      track.title ||
      track.path
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.[^.]+$/, '') ||
      '音乐'
  await document.fonts.load(`${font.weight} 80px "${font.family}"`, title + signature)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const c = canvas.getContext('2d')!,
    w = width,
    h = height,
    unit = Math.min(w, h),
    landscape = w / h > 1.3
  let art: HTMLImageElement | null = null
  if (artUrl) {
    art = new Image()
    art.src = artUrl
    await art.decode().catch(() => {
      art = null
    })
  }
  c.fillStyle = '#090a11'
  c.fillRect(0, 0, w, h)
  if (art) {
    c.save()
    c.globalAlpha = 0.24
    c.filter = `blur(${unit * 0.07}px)`
    const scale = Math.max(w / art.naturalWidth, h / art.naturalHeight) * 1.16
    c.drawImage(
      art,
      (w - art.naturalWidth * scale) / 2,
      (h - art.naturalHeight * scale) / 2,
      art.naturalWidth * scale,
      art.naturalHeight * scale
    )
    c.restore()
  }
  const glow = c.createRadialGradient(w * 0.15, h * 0.15, 0, w * 0.2, h * 0.3, Math.max(w, h))
  glow.addColorStop(0, accent + '70')
  glow.addColorStop(0.65, accent + '0b')
  glow.addColorStop(1, '#070910bb')
  c.fillStyle = glow
  c.fillRect(0, 0, w, h)
  const shade = c.createLinearGradient(0, 0, 0, h)
  shade.addColorStop(0, '#080a1300')
  shade.addColorStop(1, '#060812b0')
  c.fillStyle = shade
  c.fillRect(0, 0, w, h)
  const pad = unit * 0.085
  c.strokeStyle = '#ffffff1c'
  c.lineWidth = Math.max(1, unit / 1000)
  c.beginPath()
  c.moveTo(pad, pad * 0.8)
  c.lineTo(w - pad, pad * 0.8)
  c.stroke()
  c.fillStyle = '#ffffff80'
  c.font = `500 ${unit * 0.018}px "Noto Sans Mono"`
  c.textBaseline = 'top'
  c.fillText('J U S T  A  P L A Y E R', pad, pad * 1.05)
  c.textAlign = 'right'
  c.fillText('M U S I C  /  V I S U A L S', w - pad, pad * 1.05)
  c.textAlign = 'left'
  let x: number, y: number, textWidth: number
  let centeredTitleSize = unit * 0.075
  c.font = `${font.weight} ${centeredTitleSize}px "${font.family}", "Noto Sans SC"`
  if (wrap(c, title, w * 0.84, 3).length > 1) centeredTitleSize *= 0.78
  c.font = `${font.weight} ${centeredTitleSize}px "${font.family}", "Noto Sans SC"`
  const centerLines = wrap(c, title, w * 0.84, 3).length
  const textHeight =
    centerLines * centeredTitleSize * 1.24 +
    unit * (0.115 + (track.artist ? 0.055 : 0) + (track.album ? 0.05 : 0))
  if (art) {
    const size = landscape
      ? unit * 0.58
      : Math.max(
          unit * 0.16,
          Math.min(
            w * 0.64,
            h * 0.38,
            h - pad * 0.95 - unit * 0.04 - h * 0.16 - unit * 0.06 - textHeight
          )
        )
    const ax = landscape ? w * 0.09 : (w - size) / 2,
      ay = landscape ? (h - size) / 2 : h * 0.16
    c.save()
    c.shadowColor = '#00000099'
    c.shadowBlur = unit * 0.065
    c.shadowOffsetY = unit * 0.025
    rounded(c, ax, ay, size, size, size * 0.035)
    c.fillStyle = '#14141a'
    c.fill()
    c.shadowBlur = 0
    c.shadowOffsetY = 0
    c.clip()
    const coverScale = Math.max(size / art.naturalWidth, size / art.naturalHeight)
    c.drawImage(
      art,
      ax + (size - art.naturalWidth * coverScale) / 2,
      ay + (size - art.naturalHeight * coverScale) / 2,
      art.naturalWidth * coverScale,
      art.naturalHeight * coverScale
    )
    c.restore()
    rounded(c, ax, ay, size, size, size * 0.035)
    c.strokeStyle = '#ffffff33'
    c.stroke()
    x = landscape ? ax + size + unit * 0.1 : w / 2
    y = landscape ? h * 0.3 : ay + size + unit * 0.06
    textWidth = landscape ? w - x - w * 0.08 : w * 0.84
  } else {
    x = w / 2
    y = h * 0.32
    textWidth = w * 0.78
  }
  const centered = !art || !landscape
  c.textAlign = centered ? 'center' : 'left'
  const titleSize = centered ? centeredTitleSize : unit * 0.082
  c.fillStyle = '#fff8ee'
  c.font = `${font.weight} ${titleSize}px "${font.family}", "Noto Sans SC"`
  const titleLines = wrap(c, title, textWidth, 3)
  for (const line of titleLines) {
    c.fillText(line, x, y)
    y += titleSize * 1.24
  }
  y += unit * 0.035
  c.strokeStyle = accent
  c.lineWidth = unit * 0.004
  c.beginPath()
  c.moveTo(centered ? x - unit * 0.04 : x, y)
  c.lineTo(centered ? x + unit * 0.04 : x + unit * 0.08, y)
  c.stroke()
  y += unit * 0.035
  c.fillStyle = '#f1edffdc'
  c.font = `400 ${unit * 0.031}px "Noto Sans SC"`
  if (track.artist) {
    c.fillText(track.artist, x, y, textWidth)
    y += unit * 0.055
  }
  if (track.album) {
    c.fillStyle = '#e4dfffa0'
    c.font = `400 ${unit * 0.023}px "Noto Sans SC"`
    c.fillText(track.album, x, y, textWidth)
    y += unit * 0.05
  }
  c.fillStyle = '#e7e2ff66'
  c.font = `400 ${unit * 0.017}px "Noto Sans Mono", "Noto Sans SC"`
  c.fillText(
    `${track.codec}  /  ${track.format.sampleRate >= 1000000 ? (track.format.sampleRate / 1e6).toFixed(3) + ' MHz' : track.format.sampleRate / 1000 + ' kHz'}${track.format.bits ? `  /  ${track.format.bits} bit` : ''}`,
    x,
    y + unit * 0.012,
    textWidth
  )
  c.textAlign = 'left'
  c.fillStyle = '#ffffff55'
  c.font = `400 ${unit * 0.017}px "Noto Sans Mono"`
  c.fillText('S O U N D  I N  M O T I O N', pad, h - pad)
  if (signature.trim()) {
    c.textAlign = 'right'
    c.fillStyle = '#ffffffa8'
    c.font = `400 ${unit * 0.022}px "${font.family}", "Noto Sans SC"`
    c.fillText(signature.trim().slice(0, 80), w - pad, h - pad, w * 0.45)
  }
  return canvas
}
