import { VIZ, VIZ_HEADER, VIZ_OFFSET } from '@shared/viz'
import { engine } from '../engine/client'

export interface AudioState {
  /** 平滑后的频谱（0..1），起音快、释放慢，适合驱动形变。 */
  bands: Float32Array
  /** 引擎最近一帧的原始频谱。 */
  raw: Float32Array
  wave: Float32Array
  /** (L, R) 点对，长度 gonioPoints * 2。 */
  gonio: Float32Array
  peak: [number, number]
  rms: [number, number]
  bass: number
  mid: number
  treble: number
  energy: number
  /** 节拍包络：检测到鼓点时跳到 1，然后指数衰减。 */
  beat: number
  beatCount: number
  /** 自上次鼓点起经过的秒数，用来做扩散波。 */
  sinceBeat: number
  time: number
  dt: number
  /** 是否有音乐在放，0..1 平滑过渡。 */
  active: number
  sampleRate: number
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

function mean(a: Float32Array, from: number, to: number): number {
  let sum = 0
  for (let i = from; i < to; i++) sum += a[i] ?? 0
  return sum / (to - from)
}

/** 把引擎推来的分析帧整理成适合动画的状态：平滑、分频段能量与鼓点检测。 */
class AudioBus {
  private offlineActive = false
  offline(frame: Float32Array, time: number, dt: number): void {
    if (!this.offlineActive) {
      const s = this.state
      s.bands.fill(0)
      s.raw.fill(0)
      s.wave.fill(0)
      s.gonio.fill(0)
      s.peak = [0, 0]
      s.rms = [0, 0]
      s.bass = 0
      s.mid = 0
      s.treble = 0
      s.energy = 0
      s.beat = 0
      s.beatCount = 0
      s.sinceBeat = 10
      s.active = 0
      this.prevRaw.fill(0)
      this.fluxMean = 0
      this.fluxVar = 0
      this.lastBeatAt = -1e9
    }
    this.offlineActive = true
    this.latest = frame
    this.lastFrameAt = time * 1000
    this.lastStepAt = (time - dt) * 1000
    this.state.time = time - dt
  }
  endOffline(): void {
    this.offlineActive = false
    this.latest = null
    this.lastFrameAt = -1e9
    this.lastStepAt = performance.now()
  }
  readonly state: AudioState = {
    bands: new Float32Array(VIZ.bands),
    raw: new Float32Array(VIZ.bands),
    wave: new Float32Array(VIZ.waveLen),
    gonio: new Float32Array(VIZ.gonioPoints * 2),
    peak: [0, 0],
    rms: [0, 0],
    bass: 0,
    mid: 0,
    treble: 0,
    energy: 0,
    beat: 0,
    beatCount: 0,
    sinceBeat: 10,
    time: 0,
    dt: 1 / 60,
    active: 0,
    sampleRate: 44100
  }

  private latest: Float32Array | null = null
  private lastFrameAt = -1e9
  private lastStepAt = 0
  private prevRaw = new Float32Array(VIZ.bands)
  private fluxMean = 0
  private fluxVar = 0
  private lastBeatAt = -1e9

  constructor() {
    engine.onViz((frame) => {
      if (this.offlineActive) return
      this.latest = frame
      this.lastFrameAt = performance.now()
    })
  }

  step(nowMs: number): AudioState {
    const s = this.state
    const dt = Math.min(0.1, Math.max(0.001, (nowMs - this.lastStepAt) / 1000 || 1 / 60))
    this.lastStepAt = nowMs
    s.dt = dt
    s.time += dt

    const frame = this.latest && nowMs - this.lastFrameAt < 140 ? this.latest : null
    if (frame && frame[VIZ_HEADER.sampleRate]! > 0) s.sampleRate = frame[VIZ_HEADER.sampleRate]!
    const attack = 1 - Math.exp(-dt / 0.03)
    const release = 1 - Math.exp(-dt / 0.2)

    for (let i = 0; i < VIZ.bands; i++) {
      const target = frame ? (frame[VIZ_OFFSET.bands + i] ?? 0) : 0
      s.raw[i] = target
      const cur = s.bands[i] ?? 0
      s.bands[i] = cur + (target - cur) * (target > cur ? attack : release)
    }

    const fade = Math.exp(-dt * 7)
    for (let i = 0; i < VIZ.waveLen; i++) {
      s.wave[i] = frame ? (frame[VIZ_OFFSET.wave + i] ?? 0) : (s.wave[i] ?? 0) * fade
    }
    for (let i = 0; i < VIZ.gonioPoints * 2; i++) {
      s.gonio[i] = frame ? (frame[VIZ_OFFSET.gonio + i] ?? 0) : (s.gonio[i] ?? 0) * fade
    }

    const level = (idx: number): number => (frame ? (frame[idx] ?? 0) : 0)
    const smooth = (cur: number, target: number): number =>
      cur + (target - cur) * (target > cur ? attack : release)
    s.peak[0] = smooth(s.peak[0], level(VIZ_HEADER.peakL))
    s.peak[1] = smooth(s.peak[1], level(VIZ_HEADER.peakR))
    s.rms[0] = smooth(s.rms[0], level(VIZ_HEADER.rmsL))
    s.rms[1] = smooth(s.rms[1], level(VIZ_HEADER.rmsR))

    s.bass = mean(s.bands, 0, 14)
    s.mid = mean(s.bands, 24, 72)
    s.treble = mean(s.bands, 84, 128)
    s.energy = clamp01(mean(s.bands, 0, 110) * 1.6)

    // 低中频的正向谱通量 + 自适应阈值，足以抓住大多数鼓点
    let flux = 0
    for (let i = 0; i < 64; i++) flux += Math.max(0, (s.raw[i] ?? 0) - (this.prevRaw[i] ?? 0))
    this.prevRaw.set(s.raw)
    const k = 1 - Math.exp(-dt / 0.7)
    this.fluxMean += (flux - this.fluxMean) * k
    this.fluxVar += ((flux - this.fluxMean) ** 2 - this.fluxVar) * k
    const threshold = this.fluxMean + 1.4 * Math.sqrt(this.fluxVar) + 0.35
    if (frame && flux > threshold && nowMs - this.lastBeatAt > 150) {
      this.lastBeatAt = nowMs
      s.beat = 1
      s.beatCount++
      s.sinceBeat = 0
    }
    s.sinceBeat += dt
    s.beat *= Math.exp(-dt / 0.22)

    s.active += ((frame ? 1 : 0) - s.active) * (1 - Math.exp(-dt / 0.5))
    return s
  }
}

export const audio = new AudioBus()
