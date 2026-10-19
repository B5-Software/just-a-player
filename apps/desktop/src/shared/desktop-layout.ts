import type { WallpaperLayout } from './desktop'

/** Input coordinates are physical pixels; DIPs cannot be unioned across mixed DPI screens. */
export function desktopLayout(
  displays: { id: number; x: number; y: number; width: number; height: number }[]
): WallpaperLayout {
  if (!displays.length) return { width: 1, height: 1, displays: [] }
  const left = Math.min(...displays.map((d) => d.x)),
    top = Math.min(...displays.map((d) => d.y))
  return {
    width: Math.max(...displays.map((d) => d.x + d.width)) - left,
    height: Math.max(...displays.map((d) => d.y + d.height)) - top,
    displays: displays.map((d) => ({ ...d, x: d.x - left, y: d.y - top }))
  }
}
