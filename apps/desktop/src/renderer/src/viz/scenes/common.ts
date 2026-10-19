import * as THREE from 'three'
import type { AudioState } from '../audio'
import type { Palette } from '../palette'

export interface FrameInput {
  /** 指针在画布内的归一化位置，-1..1。 */
  pointer: THREE.Vector2
}

export interface VizScene {
  readonly instrument?: boolean
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera | THREE.OrthographicCamera
  /** 该场景希望的泛光参数，宿主会平滑过渡过去。 */
  readonly bloom: { strength: number; radius: number; threshold: number }
  update(audio: AudioState, palette: Palette, input: FrameInput): void
  resize(width: number, height: number): void
  /**
   * 场景若自己画背景（不经过 `scene.background`），通过这里接收封面模糊纹理。
   * `texture` 为 `null` 表示恢复场景自带的背景。
   */
  setBackdrop?(texture: THREE.Texture | null, gain: number): void
  dispose(): void
}

export interface SceneDef {
  id: string
  name: string
  hint: string
  create(): VizScene
}

export function disposeScene(scene: THREE.Scene): void {
  scene.traverse((obj) => {
    const item = obj as Partial<THREE.Mesh>
    item.geometry?.dispose()
    const material = item.material
    if (Array.isArray(material)) material.forEach((m) => m.dispose())
    else material?.dispose()
  })
}

/** 对 0..1 位置上的频谱做线性插值。 */
export function sampleBand(bands: Float32Array, x: number): number {
  const f = Math.min(1, Math.max(0, x)) * (bands.length - 1)
  const i = Math.floor(f)
  const a = bands[i] ?? 0
  const b = bands[Math.min(i + 1, bands.length - 1)] ?? 0
  return a + (b - a) * (f - i)
}

/** 按固定节拍把频谱快照压入环形历史，供“随时间滚动”的场景使用。 */
export class SpectrumHistory {
  readonly data: Float32Array
  head = 0
  private acc = 0

  constructor(
    readonly cols: number,
    readonly rows: number,
    private readonly hz: number
  ) {
    this.data = new Float32Array(cols * rows)
  }

  /** 推进时间；若压入了新行返回 `true`。`frac` 是下一行到来前的进度（0..1）。 */
  tick(dt: number, bands: Float32Array): boolean {
    this.acc += dt
    const step = 1 / this.hz
    if (this.acc < step) return false
    this.acc = Math.min(this.acc - step, step)
    this.head = (this.head + 1) % this.rows
    const base = this.head * this.cols
    for (let i = 0; i < this.cols; i++) {
      this.data[base + i] = sampleBand(bands, i / (this.cols - 1))
    }
    return true
  }

  get frac(): number {
    return Math.min(1, this.acc * this.hz)
  }

  /** `age` 为 0 表示最新一行。 */
  at(age: number, col: number): number {
    const row = (this.head - age + this.rows * 4) % this.rows
    return this.data[row * this.cols + col] ?? 0
  }
}

/** 取样一个“围绕 0 点对称”的频谱位置：0 在中心、1 在两端。 */
export const mirror = (t: number): number => Math.abs(t * 2 - 1)

export const TAU = Math.PI * 2

/** 柔和的径向光晕贴图，给 Sprite 做发光核心用。 */
export function glowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 256
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.25, 'rgba(255,255,255,0.35)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 256, 256)
  return new THREE.CanvasTexture(canvas)
}

export function colorRamp(
  out: THREE.Color,
  palette: Palette,
  t: number
): THREE.Color {
  // 低 -> 主色，中 -> 邻近色，高 -> 对比色
  if (t < 0.5) return out.copy(palette.accent).lerp(palette.second, t * 2)
  return out.copy(palette.second).lerp(palette.third, (t - 0.5) * 2)
}
