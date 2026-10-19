/** 背景纹理固定 16:9，3D 场景拉伸到窗口时模糊图案不会露馅。 */
const WIDTH = 480
const HEIGHT = 270

/** 把封面裁成 16:9 并做大半径高斯模糊；放大一点让模糊的透明边缘落在画外。 */
export function renderBackdrop(image: HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  const sw = image.naturalWidth || image.width
  const sh = image.naturalHeight || image.height
  const scale = Math.max(WIDTH / sw, HEIGHT / sh) * 1.25
  const dw = sw * scale
  const dh = sh * scale
  ctx.filter = 'blur(28px) saturate(1.35)'
  ctx.drawImage(image, (WIDTH - dw) / 2, (HEIGHT - dh) / 2, dw, dh)
  return canvas
}
