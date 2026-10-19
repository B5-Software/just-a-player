export type Rgb = readonly [number, number, number]
export type Hsl = readonly [number, number, number]

const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i

/** 规范成 `#rrggbb`，不合法返回 `null`。 */
export function normalizeHex(input: string): string | null {
  const match = HEX.exec(input.trim())
  if (!match) return null
  let hex = match[1]!.toLowerCase()
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join('')
  return `#${hex}`
}

export function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function rgbToHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`
}

export function rgbToHsl([r, g, b]: Rgb): Hsl {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255] as const
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0)
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  return [h / 6, s, l]
}

export function hslToRgb([h, s, l]: Hsl): Rgb {
  if (s === 0) return [l * 255, l * 255, l * 255]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t: number): number => {
    const x = ((t % 1) + 1) % 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  return [channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255]
}

/** WCAG 相对亮度，用来决定强调色上的文字用黑还是白。 */
export function luminance([r, g, b]: Rgb): number {
  const lin = (v: number): number => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

const triplet = ([r, g, b]: Rgb): string => `${Math.round(r)} ${Math.round(g)} ${Math.round(b)}`
const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))

export interface AccentScheme {
  accent: Rgb
  text: Rgb
  second: Rgb
  /** 与主色相距较远的第三色，给 3D 场景做冷暖对比。 */
  third: Rgb
  onAccent: Rgb
}

/**
 * 由一个强调色派生整套配色：
 * - `accent` 原色，用于填充；
 * - `text` 按明暗主题调整亮度，保证作为文字/图标时清晰；
 * - `second` 邻近色相，用于渐变与流体背景；
 * - `onAccent` 强调色填充上的前景色。
 */
export function deriveAccent(hex: string, resolved: 'light' | 'dark'): AccentScheme {
  const accent = hexToRgb(hex)
  const [h, s, l] = rgbToHsl(accent)

  return {
    accent,
    text: hslToRgb([h, s, resolved === 'dark' ? Math.max(l, 0.7) : Math.min(l, 0.4)]),
    second: hslToRgb([(h + 0.11) % 1, clamp(s, 0.45, 1), clamp(l, 0.5, 0.64)]),
    third: hslToRgb([(h + 0.52) % 1, clamp(s, 0.5, 1), clamp(l, 0.52, 0.62)]),
    onAccent: luminance(accent) > 0.42 ? [16, 16, 24] : [255, 255, 255]
  }
}

/** `secondHex` 为封面取得的第二色；缺省时由主色派生。 */
const accentTransitions = new WeakMap<HTMLElement, { key: string; frame: number }>()
export function applyAccent(
  root: HTMLElement,
  hex: string,
  resolved: 'light' | 'dark',
  secondHex: string | null = null
): void {
  const scheme = deriveAccent(hex, resolved)
  const second = secondHex ? deriveAccent(secondHex, resolved).accent : scheme.second
  const style = root.style
  const [h, s, l] = rgbToHsl(scheme.accent)
  const target: Record<string, Rgb> = {
    '--accent': scheme.accent,
    '--accent-focus': hslToRgb([
      h,
      Math.max(s, 0.58),
      resolved === 'light' ? Math.min(l, 0.34) : Math.max(l, 0.62)
    ]),
    '--accent-text': scheme.text,
    '--accent-2': second,
    '--on-accent': scheme.onAccent
  }
  const key = JSON.stringify([hex, resolved, secondHex]),
    previous = accentTransitions.get(root)
  if (previous?.key === key) return
  if (previous) cancelAnimationFrame(previous.frame)
  const first = !style.getPropertyValue('--accent'),
    from = Object.fromEntries(
      Object.entries(target).map(([name, value]) => [
        name,
        style.getPropertyValue(name).trim().split(/\s+/).map(Number).filter(Number.isFinite)
          .length === 3
          ? style.getPropertyValue(name).trim().split(/\s+/).map(Number)
          : value
      ])
    )
  const state = { key, frame: 0 },
    start = performance.now()
  accentTransitions.set(root, state)
  const paint = (now: number): void => {
    const t = first ? 1 : Math.min(1, (now - start) / 850),
      eased = t * t * (3 - 2 * t)
    for (const [name, rgb] of Object.entries(target))
      style.setProperty(
        name,
        rgb.map((v, i) => Math.round(from[name]![i]! + (v - from[name]![i]!) * eased)).join(' ')
      )
    if (t < 1) state.frame = requestAnimationFrame(paint)
  }
  paint(start)
}
