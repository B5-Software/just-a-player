import * as THREE from 'three'
import { deriveAccent, type Rgb } from '../theme/color'

const toColor = (target: THREE.Color, [r, g, b]: Rgb): void => {
  target.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace)
}

/**
 * 3D 场景统一取色。主色来自强调色（或封面取色），第二色优先用封面取得的颜色。
 * 画布永远是深色底，所以始终按深色主题的亮度来派生。
 */
export class Palette {
  readonly accent = new THREE.Color()
  readonly second = new THREE.Color()
  readonly third = new THREE.Color()
  private readonly targetA = new THREE.Color()
  private readonly targetB = new THREE.Color()
  private readonly targetC = new THREE.Color()

  constructor(primary: string, secondary: string | null = null) {
    this.update(primary, secondary)
    this.accent.copy(this.targetA)
    this.second.copy(this.targetB)
    this.third.copy(this.targetC)
  }

  update(primary: string, secondary: string | null = null): void {
    const scheme = deriveAccent(primary, 'dark')
    toColor(this.targetA, scheme.accent)
    toColor(this.targetB, secondary ? deriveAccent(secondary, 'dark').accent : scheme.second)
    toColor(this.targetC, scheme.third)
  }
  step(dt: number): void {
    const k = 1 - Math.exp(-dt * 4)
    this.accent.lerp(this.targetA, k)
    this.second.lerp(this.targetB, k)
    this.third.lerp(this.targetC, k)
  }
}
