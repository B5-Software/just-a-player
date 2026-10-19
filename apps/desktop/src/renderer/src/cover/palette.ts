import { hslToRgb, rgbToHex, rgbToHsl, type Rgb } from '../theme/color'

export interface CoverPalette {
  primary: string
  secondary: string
}

const SAMPLE = 64
const BINS = 12

interface Bin {
  w: number
  r: number
  g: number
  b: number
  h: number
}

const average = (bin: Bin): Rgb => [bin.r / bin.w, bin.g / bin.w, bin.b / bin.w]

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 1
  return Math.min(d, 1 - d)
}

/**
 * 从封面取两个强调色：把封面缩到 64×64，按色相分桶加权（饱和度 × 亮度适中度），
 * 取权重最大的一桶作主色，再取色相明显不同的一桶作第二色。黑白封面返回 `null`。
 */
export function extractPalette(source: CanvasImageSource): CoverPalette | null {
  const canvas = document.createElement('canvas')
  canvas.width = SAMPLE
  canvas.height = SAMPLE
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(source, 0, 0, SAMPLE, SAMPLE)
  const data = ctx.getImageData(0, 0, SAMPLE, SAMPLE).data

  const bins: Bin[] = Array.from({ length: BINS }, () => ({ w: 0, r: 0, g: 0, b: 0, h: 0 }))
  let total = 0
  for (let i = 0; i < data.length; i += 4) {
    const rgb: Rgb = [data[i]!, data[i + 1]!, data[i + 2]!]
    const [h, s, l] = rgbToHsl(rgb)
    if (s < 0.2 || l < 0.12 || l > 0.9) continue
    const w = s * (1 - Math.abs(l - 0.55) * 1.2)
    if (w <= 0) continue
    const bin = bins[Math.min(BINS - 1, Math.floor(h * BINS))]!
    bin.w += w
    bin.r += rgb[0] * w
    bin.g += rgb[1] * w
    bin.b += rgb[2] * w
    bin.h += h * w
    total += w
  }
  if (total < SAMPLE * SAMPLE * 0.02) return null

  const ranked = bins.filter((bin) => bin.w > 0).sort((a, b) => b.w - a.w)
  const top = ranked[0]
  if (!top) return null
  const primaryRgb = average(top)
  const [ph, ps, pl] = rgbToHsl(primaryRgb)
  const second = ranked
    .slice(1)
    .find((bin) => hueDistance(bin.h / bin.w, ph) > 0.12 && bin.w > top.w * 0.12)
  const secondRgb = second ? average(second) : hslToRgb([(ph + 0.12) % 1, ps, pl])

  return { primary: rgbToHex(primaryRgb), secondary: rgbToHex(secondRgb) }
}
