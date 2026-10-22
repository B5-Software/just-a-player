import { surfacePixelRatio } from '../../lib/pixel-ratio'
import * as THREE from 'three'
import { type SceneDef, type VizScene } from './common'
import type { AudioState } from '../audio'
import type { Palette } from '../palette'
import { useSettings } from '../../settings/store'
type Mode = 'scope' | 'spectrum' | 'spectrogram' | 'vectorscope'
const frequencies = [25, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
const db = (v: number): string => (v > 1e-6 ? (20 * Math.log10(v)).toFixed(1) : '−∞')
const titles: Record<Mode, string> = {
  scope: '示波器',
  spectrum: '频谱分析仪',
  spectrogram: '时频谱',
  vectorscope: '立体声相位仪',
}
/** Viewport-sized transparent instrumentation; fonts are bundled under the OFL. */
class Instrument implements VizScene {
  readonly instrument = true
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
  readonly bloom = { strength: 0, radius: 0.25, threshold: 0.85 }
  private readonly canvas = document.createElement('canvas')
  private readonly ctx = this.canvas.getContext('2d')!
  private readonly texture = new THREE.CanvasTexture(this.canvas)
  private readonly mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      toneMapped: false,
      depthWrite: false,
    })
  )
  private readonly history = document.createElement('canvas')
  private readonly historyCtx = this.history.getContext('2d')!
  private peaks = new Float32Array(128)
  private last = -1
  private historyTime = 0
  private width = 1
  private height = 1
  private dpr = 1
  private accent = ''
  private ink = '#ffffff'
  private colors: string[] = []
  constructor(private readonly mode: Mode) {
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.texture.generateMipmaps = false
    this.texture.minFilter = THREE.LinearFilter
    this.scene.add(this.mesh)
    this.scene.background = new THREE.Color('#0c0b14')
    this.camera.position.z = 1
    this.history.width = 128
    this.history.height = 360
    void document.fonts.load('400 14px "Noto Sans Mono"')
    void document.fonts.load('700 24px "Noto Sans SC"')
  }
  resize(w: number, h: number): void {
    this.width = Math.max(1, w)
    this.height = Math.max(1, h)
    this.dpr = surfacePixelRatio() * useSettings.getState().renderScale
    this.canvas.width = Math.round(this.width * this.dpr)
    this.canvas.height = Math.round(this.height * this.dpr)
    this.last = -1
    // Immutable WebGL texture storage cannot change dimensions in place.
    // Reallocate when the canvas changes size, otherwise old texels remain.
    this.texture.dispose()
    this.texture.needsUpdate = true
  }
  private text(text: string, x: number, y: number, size = 12, alpha = 0.75): void {
    const c = this.ctx
    c.font = `${size}px "Noto Sans Mono", "Noto Sans SC"`
    c.fillStyle = this.ink
    c.globalAlpha = alpha
    c.fillText(text, x, y)
    c.globalAlpha = 1
  }
  update(audio: AudioState, palette: Palette): void {
    const fps = useSettings.getState().renderFps
    if (fps > 0 && this.last >= 0 && audio.time - this.last < 1 / fps - 0.001) return
    const dt = this.last < 0 ? 1 / 60 : Math.min(0.2, audio.time - this.last)
    this.last = audio.time
    const accent = '#' + palette.accent.getHexString()
    if (accent !== this.accent) {
      this.accent = accent
      const rgb = new THREE.Color(accent)
      this.ink = '#' + rgb.clone().lerp(new THREE.Color('white'), 0.72).getHexString()
      this.colors = Array.from(
        { length: 256 },
        (_, i) =>
          '#' +
          rgb
            .clone()
            .lerp(new THREE.Color('white'), Math.max(0, i / 255 - 0.65) * 1.5)
            .getHexString() +
          Math.round((i / 255) ** 1.4 * 230)
            .toString(16)
            .padStart(2, '0')
      )
    }
    const c = this.ctx,
      w = this.width,
      h = this.height,
      narrow = w < 800
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    c.clearRect(0, 0, w, h)
    const wallpaper = document.documentElement.dataset['windowMode'] === 'wallpaper'
    const margin = Math.max(32, Math.min(80, w * 0.055)),
      top = wallpaper ? (h < 500 ? 64 : 92) : h < 500 ? 94 : 130,
      bottom = wallpaper ? 100 : h < 500 ? 126 : 280
    const p = {
      x: margin,
      y: top,
      w: Math.max(20, w - margin * 2),
      h: Math.max(30, h - top - bottom),
    }
    const fx = (hz: number): number => p.x + (Math.log(hz / 25) / Math.log(800)) * p.w
    c.shadowColor = accent
    c.shadowBlur = 10
    c.font = `700 ${narrow ? 22 : 30}px "Noto Sans SC"`
    c.fillStyle = this.ink
    c.fillText(titles[this.mode], margin, top - 35)
    c.shadowBlur = 0
    if (!narrow) this.text('AUDIO INSTRUMENTS / LIVE', w - margin - 220, top - 38, 11)
    c.strokeStyle = this.ink + '22'
    c.lineWidth = 1
    if (this.mode !== 'vectorscope') {
      for (let i = 0; i <= 4; i++) {
        const y = p.y + (p.h * i) / 4
        c.beginPath()
        c.moveTo(p.x, y)
        c.lineTo(p.x + p.w, y)
        c.stroke()
        this.text(
          this.mode === 'scope'
            ? (1 - i / 2).toFixed(1)
            : this.mode === 'spectrogram'
              ? '−' + i * 3 + 's'
              : String(-6 - i * 21),
          6,
          y + 4,
          10,
          0.65
        )
      }
      if (this.mode === 'scope') {
        for (let i = 0; i <= 10; i++) {
          const x = p.x + (p.w * i) / 10
          c.beginPath()
          c.moveTo(x, p.y)
          c.lineTo(x, p.y + p.h)
          c.stroke()
        }
      } else
        for (const hz of frequencies) {
          if (narrow && ![50, 200, 1000, 5000, 20000].includes(hz)) continue
          const x = fx(hz)
          c.beginPath()
          c.moveTo(x, p.y)
          c.lineTo(x, p.y + p.h)
          c.stroke()
          this.text(hz >= 1000 ? hz / 1000 + 'k' : String(hz), x - 12, p.y + p.h + 24, 11)
        }
    }
    if (this.mode === 'spectrum') {
      const gradient = c.createLinearGradient(0, p.y, 0, p.y + p.h)
      gradient.addColorStop(0, this.ink)
      gradient.addColorStop(0.4, accent)
      gradient.addColorStop(1, accent + '12')
      const bw = p.w / audio.bands.length
      audio.bands.forEach((v, i) => {
        this.peaks[i] = Math.max(v, this.peaks[i]! - dt * 0.14)
        c.fillStyle = gradient
        c.fillRect(p.x + i * bw + 0.6, p.y + p.h * (1 - v), Math.max(0.5, bw - 1.2), v * p.h)
        c.fillStyle = this.ink
        c.fillRect(
          p.x + i * bw + 0.6,
          p.y + p.h * (1 - this.peaks[i]!),
          Math.max(0.5, bw - 1.2),
          1.5
        )
      })
    } else if (this.mode === 'scope') {
      this.ctx.save()
      c.beginPath()
      c.rect(p.x, p.y, p.w, p.h)
      c.clip()
      let trigger = 0
      for (let i = 1; i < 80; i++)
        if (audio.wave[i - 1]! <= 0 && audio.wave[i]! > 0) {
          trigger = i
          break
        }
      const count = audio.wave.length - 80
      c.strokeStyle = this.ink
      c.lineWidth = 1.8
      c.shadowColor = accent
      c.shadowBlur = 12
      c.beginPath()
      for (let i = 0; i < count; i++) {
        const x = p.x + (i / (count - 1)) * p.w,
          y = p.y + p.h / 2 - (audio.wave[i + trigger]! * p.h) / 2
        if (i === 0) c.moveTo(x, y)
        else c.lineTo(x, y)
      }
      c.stroke()
      c.restore()
      this.text(
        `MONO / RISING EDGE / ${(((count * 4) / audio.sampleRate) * 1000).toFixed(2)} ms`,
        margin,
        p.y + p.h + 24,
        11
      )
    } else if (this.mode === 'spectrogram') {
      this.historyTime += dt
      if (audio.active > 0.1 && this.historyTime >= 1 / 30) {
        this.historyTime %= 1 / 30
        this.historyCtx.drawImage(this.history, 0, 0, 128, 359, 0, 1, 128, 359)
        this.historyCtx.clearRect(0, 0, 128, 1)
        audio.raw.forEach((v, i) => {
          this.historyCtx.fillStyle = this.colors[Math.min(255, Math.max(0, Math.round(v * 255)))]!
          this.historyCtx.fillRect(i, 0, 1, 1)
        })
      }
      c.drawImage(this.history, p.x, p.y, p.w, p.h)
    } else {
      const cx = w / 2,
        cy = p.y + p.h / 2,
        radius = Math.min(p.h / 2, p.w / 2) * 0.92
      c.strokeStyle = this.ink + '30'
      for (const k of [1 / 3, 2 / 3, 1]) {
        c.beginPath()
        c.arc(cx, cy, radius * k, 0, Math.PI * 2)
        c.stroke()
      }
      for (const s of [-1, 1]) {
        c.beginPath()
        c.moveTo(cx - radius * 0.7, cy - s * radius * 0.7)
        c.lineTo(cx + radius * 0.7, cy + s * radius * 0.7)
        c.stroke()
      }
      this.text('L', cx - radius, cy - radius * 0.7)
      this.text('R', cx + radius, cy - radius * 0.7)
      let ll = 0,
        rr = 0,
        lr = 0
      c.fillStyle = this.ink
      c.shadowColor = accent
      c.shadowBlur = 7
      for (let i = 0; i < audio.gonio.length; i += 2) {
        const l = audio.gonio[i]!,
          r = audio.gonio[i + 1]!
        ll += l * l
        rr += r * r
        lr += l * r
        c.globalAlpha = 0.2 + (0.8 * i) / audio.gonio.length
        c.beginPath()
        c.arc(cx + (r - l) * radius * 0.7, cy - (l + r) * radius * 0.7, 1.2, 0, Math.PI * 2)
        c.fill()
      }
      c.globalAlpha = 1
      c.shadowBlur = 0
      this.text(
        'CORRELATION ' + (lr / Math.max(1e-10, Math.sqrt(ll * rr))).toFixed(3),
        margin,
        p.y + p.h + 24
      )
    }
    const meterY = h - bottom + 58
    if (h >= 500) {
      this.text('PEAK L / R', margin, meterY, 10)
      this.text(
        db(audio.peak[0]) + ' / ' + db(audio.peak[1]) + ' dBFS',
        margin,
        meterY + 25,
        narrow ? 14 : 18,
        1
      )
      if (w > 520) {
        this.text('RMS L / R', w * 0.44, meterY, 10)
        this.text(
          db(audio.rms[0]) + ' / ' + db(audio.rms[1]) + ' dBFS',
          w * 0.44,
          meterY + 25,
          narrow ? 14 : 18,
          1
        )
      }
      if (w > 900)
        this.text(
          audio.active > 0.2 ? '● SIGNAL' : '○ IDLE',
          w - margin - 100,
          meterY + 25,
          13,
          audio.active > 0.2 ? 1 : 0.5
        )
    }
    this.texture.needsUpdate = true
  }
  dispose(): void {
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
    this.texture.dispose()
  }
}
export const instrumentScenes: readonly SceneDef[] = [
  {
    id: 'scope',
    name: '示波器',
    hint: '零交越触发 · 实时波形',
    create: () => new Instrument('scope'),
  },
  {
    id: 'spectrum',
    name: '频谱分析仪',
    hint: '对数分频 · 峰值保持',
    create: () => new Instrument('spectrum'),
  },
  {
    id: 'spectrogram',
    name: '时频谱',
    hint: '12 秒历史 · 能量热图',
    create: () => new Instrument('spectrogram'),
  },
  {
    id: 'vectorscope',
    name: '立体声相位仪',
    hint: 'M/S 分布 · 声道相关',
    create: () => new Instrument('vectorscope'),
  },
]
