import * as THREE from 'three'
import type { AudioState } from '../audio'
import type { ShaderDriver } from './shader'
import type { NativeShaderTexture } from '../native-hdr'
import { sampleBand } from '../scenes/common'
import { vuPosition, VU_TICKS, smoothVu } from '../vu-scale'

export const AUDIO_UNIFORMS = `
uniform vec4 uBands[32];uniform vec4 uHold[32];uniform vec4 uWave[64];uniform highp sampler2D uStereoTrace;
uniform vec4 uLevel;uniform float uRate;
float band(float x){float p=clamp(x,0.,1.)*127.;int i=int(p);return mix(uBands[i/4][i%4],uBands[min(i+1,127)/4][min(i+1,127)%4],fract(p));}
float wave(float x){float p=clamp(x,0.,1.)*255.;int i=int(p);return mix(uWave[i/4][i%4],uWave[min(i+1,255)/4][min(i+1,255)%4],fract(p));}
float held(float x){int i=int(clamp(x,0.,1.)*127.);return uHold[i/4][i%4];}
vec2 stereo(int i){float x=(float(clamp(i,0,127))+.5)/128.;return (vec2(texture(uStereoTrace,vec2(x,.25)).r,texture(uStereoTrace,vec2(x,.75)).r)*255.-128.)/127.;}
`

export function audioDriver(raw = false, stereoTrace = false): ShaderDriver {
  const bands = Array<number>(128).fill(0),
    wave = Array<number>(256).fill(0)
  // A compact, shared texture avoids dynamic vec4 uniform-array reads that
  // produce invalid pixels or crash some mobile GL translators.
  const trace = stereoTrace ? dataTexture('uStereoTrace', 128, 2) : null
  trace?.frame.data.fill(128)
  const hold = Array<number>(128).fill(0)
  const values = {
    uBands: bands,
    uHold: hold,
    uWave: wave,
    uLevel: [0, 0, 0, 0],
    uRate: 44100,
  }
  return {
    values,
    textures: trace ? [trace] : [],
    update(a) {
      let traceChanged = false
      for (let i = 0; i < 128; i++) {
        bands[i] = sampleBand(raw ? a.raw : a.bands, i / 127)
        hold[i] = Math.max(bands[i]!, hold[i]! - a.dt * 0.12)
      }
      let trigger = 0
      for (let i = 1; i < a.wave.length / 4; i++)
        if (a.wave[i - 1]! <= 0 && a.wave[i]! > 0) {
          trigger = i
          break
        }
      for (let i = 0; i < 256; i++)
        wave[i] =
          a.wave[
            Math.min(
              a.wave.length - 1,
              trigger + Math.floor((i * (a.wave.length - trigger - 1)) / 255)
            )
          ] ?? 0
      for (let i = 0; trace && i < 128; i++) {
        const index = Math.floor((i * (a.gonio.length / 2 - 1)) / 127) * 2
        for (let ch = 0; ch < 2; ch++) {
          const value = Math.round(128 + Math.max(-1, Math.min(1, a.gonio[index + ch] ?? 0)) * 127),
            at = ch * 128 + i
          if (trace.frame.data[at] !== value) {
            trace.frame.data[at] = value
            traceChanged = true
          }
        }
      }
      if (traceChanged && trace) {
        trace.frame.version++
        trace.texture.needsUpdate = true
      }
      values.uLevel[0] = a.peak[0]
      values.uLevel[1] = a.peak[1]
      values.uLevel[2] = a.rms[0]
      values.uLevel[3] = a.rms[1]
      values.uRate = a.sampleRate
    },
    dispose() {
      trace?.texture.dispose()
    },
  }
}
function dataTexture(name: string, width: number, height: number) {
  const data = new Uint8Array(width * height),
    texture = new THREE.DataTexture(data, width, height, THREE.RedFormat)
  texture.minFilter = texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  texture.unpackAlignment = 1
  texture.needsUpdate = true
  const frame: NativeShaderTexture = { name, width, height, version: 1, data }
  return { texture, frame }
}
export function vuDriver(): ShaderDriver {
  const base = audioDriver(),
    label = dataTexture('uVuLabels', 1, 1)
  const values: ShaderDriver['values'] = { ...base.values, uVu: [0, 0, 0, 0] }
  let width = 0,
    height = 0,
    disposed = false
  const hold = [0, 0],
    timer = [0, 0],
    ball = [0, 0]
  const labels = (): void => {
    if (!width || !height || disposed) return
    const canvas = document.createElement('canvas')
    const density = Math.min(2, 2048 / width, 2048 / height)
    canvas.width = Math.max(1, Math.round(width * density))
    canvas.height = Math.max(1, Math.round(height * density))
    const c = canvas.getContext('2d', { willReadFrequently: true })!
    c.scale(canvas.width / width, canvas.height / height)
    c.fillStyle = '#fff'
    c.textAlign = 'center'
    c.font = `500 ${Math.max(11, height * 0.02)}px "Noto Sans Mono","Noto Sans SC",sans-serif`
    c.fillText('STEREO VU', width * 0.5, height * 0.2)
    c.font = `700 ${Math.max(11, height * 0.017)}px "Noto Sans Mono",monospace`
    c.fillText('PROGRAM RMS · 0 VU = −18 dBFS · 300 ms · +18 VU', width * 0.5, height * 0.76)
    for (let channel = 0; channel < 2; channel++) {
      const center = width * (channel === 0 ? 0.28 : 0.72),
        cy = height * 0.62,
        r = height * 0.25
      c.fillText(channel === 0 ? 'LEFT' : 'RIGHT', center, height * 0.69)
      for (const db of VU_TICKS) {
        const p = (db + 30) / 48,
          angle = 2.55 - p * 1.96
        c.fillText(
          db > 0 ? `+${db}` : `${db}`,
          center + Math.cos(angle) * r,
          cy - Math.sin(angle) * r
        )
      }
    }
    const rgba = c.getImageData(0, 0, canvas.width, canvas.height).data,
      data = new Uint8Array(canvas.width * canvas.height)
    for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4 + 3]!
    Object.assign(label.frame, {
      data,
      width: canvas.width,
      height: canvas.height,
      version: label.frame.version + 1,
    })
    label.texture.dispose()
    label.texture.image = { data, width: canvas.width, height: canvas.height }
    label.texture.needsUpdate = true
  }
  void document.fonts.load('700 13px "Noto Sans Mono"').then(labels)
  return {
    values,
    textures: [label],
    instrument: true,
    resize(w, h) {
      width = Math.round(w)
      height = Math.round(h)
      labels()
    },
    update(a) {
      base.update(a)
      for (let ch = 0; ch < 2; ch++) {
        const target = (a.rawRms ?? a.rms)[ch]!
        ball[ch] = smoothVu(ball[ch]!, target, a.dt)
        if (a.peak[ch]! >= hold[ch]!) {
          hold[ch] = a.peak[ch]!
          timer[ch] = 1.5
        } else if ((timer[ch]! -= a.dt) <= 0) hold[ch] = hold[ch]! * Math.exp(-a.dt * 0.5)
        ;(values.uVu as number[])[ch] = vuPosition(ball[ch]!)
        ;(values.uVu as number[])[ch + 2] = vuPosition(hold[ch]!)
      }
    },
    dispose() {
      disposed = true
      label.texture.dispose()
    },
  }
}
export function instrumentDriver(id: string, name: string): ShaderDriver {
  const base = audioDriver(true),
    history = dataTexture('uHistory', 64, 96),
    labels = dataTexture('uLabels', 1, 1)
  const values: ShaderDriver['values'] = {
    ...base.values,
    uPlot: [0.07, 0.34, 0.86, 0.48],
    uHistoryHead: 0,
  }
  let w = 0,
    h = 0,
    lastTime = -1,
    head = 0,
    disposed = false,
    rate = 44100
  const drawLabels = (): void => {
    if (disposed || !w || !h) return
    const canvas = document.createElement('canvas')
    canvas.width = Math.min(1600, Math.round(w))
    canvas.height = Math.min(1000, Math.round(h))
    const c = canvas.getContext('2d', { willReadFrequently: true })!,
      sx = canvas.width / w,
      sy = canvas.height / h
    c.scale(sx, sy)
    c.fillStyle = '#fff'
    c.font = '500 13px "Noto Sans Mono","Noto Sans SC",sans-serif'
    c.fillText(name, w * 0.07, h * 0.13)
    c.textAlign = 'right'
    c.font = '11px "Noto Sans Mono",monospace'
    c.fillText(
      `${Math.round(rate / 100) / 10} kHz · FFT${id === 'spectrum' ? ' · 3 dB/oct' : ''}`,
      w * 0.93,
      h * 0.13
    )
    c.textAlign = 'left'
    c.font = '10px "Noto Sans Mono",monospace'
    if (id === 'spectrum' || id === 'spectrogram')
      for (const f of [25, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
        if (f > Math.min(rate / 2, 24000)) continue
        const x = w * (0.07 + (0.86 * Math.log(f / 25)) / Math.log(20000 / 25))
        c.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x - 6, h * 0.69)
      }
    else
      for (let i = 0; i <= 4; i++)
        c.fillText(
          id === 'scope' ? `${i * 25}%` : ['−M', '−S', '0', '+S', '+M'][i]!,
          w * (0.07 + (0.86 * i) / 4) - 8,
          h * 0.69
        )
    if (id === 'spectrum')
      for (let i = 0; i <= 4; i++) {
        c.textAlign = 'right'
        c.fillText(`${-6 - i * 21}`, w * 0.06, h * (0.18 + (0.48 * i) / 4) + 4)
      }
    c.textAlign = 'left'
    c.fillText('PEAK L / R · dBFS', w * 0.07, h * 0.76)
    c.fillText('RMS L / R · dBFS', w * 0.52, h * 0.76)
    const pixels = c.getImageData(0, 0, canvas.width, canvas.height).data,
      data = new Uint8Array(canvas.width * canvas.height)
    for (let i = 0; i < data.length; i++) data[i] = pixels[i * 4 + 3]!
    labels.frame.data = data
    labels.frame.width = canvas.width
    labels.frame.height = canvas.height
    labels.frame.version++
    labels.texture.dispose()
    labels.texture.image = { data, width: canvas.width, height: canvas.height }
    labels.texture.needsUpdate = true
  }
  void Promise.all([
    document.fonts.load('400 13px "Noto Sans Mono"'),
    document.fonts.load('500 13px "Noto Sans SC"'),
  ]).then(drawLabels)
  return {
    values,
    textures: [history, labels],
    instrument: true,
    resize(width, height) {
      w = width
      h = height
      drawLabels()
    },
    update(a: AudioState) {
      base.update(a)
      values.uRate = a.sampleRate
      if (id === 'vectorscope') {
        const data = history.frame.data,
          decay = Math.exp(-a.dt * 7)
        let changed = false
        for (let i = 0; i < data.length; i++) {
          const value = Math.floor(data[i]! * decay)
          if (value !== data[i]) changed = true
          data[i] = value
        }
        if (a.active > 0.01)
          for (let i = 0; i < a.gonio.length; i += 2) {
            const l = a.gonio[i]!,
              r = a.gonio[i + 1]!
            const x = Math.max(
              0,
              Math.min(63, Math.round((0.5 + ((r - l) * 0.70710678) / 1.8) * 63))
            )
            const y = Math.max(
              0,
              Math.min(95, Math.round((0.5 + ((r + l) * 0.70710678) / 1.8) * 95))
            )
            const index = y * 64 + x
            data[index] = Math.min(255, data[index]! + 110)
            changed = true
          }
        if (changed) {
          history.frame.version++
          history.texture.needsUpdate = true
        }
      }
      if (rate !== a.sampleRate) {
        rate = a.sampleRate
        drawLabels()
      }
      if (id !== 'spectrogram') return
      const tick = Math.floor(a.time * 8)
      if (tick < lastTime || tick - lastTime > 96) {
        history.frame.data.fill(0)
        head = 0
        lastTime = tick - 1
      }
      if (tick !== lastTime) {
        const steps = Math.min(96, Math.max(1, tick - lastTime))
        for (let j = 0; j < steps; j++) {
          head = (head + 1) % 96
          for (let i = 0; i < 64; i++)
            history.frame.data[head * 64 + i] = Math.round(sampleBand(a.raw, i / 63) * 255)
        }
        lastTime = tick
        values.uHistoryHead = head
        history.frame.version++
        history.texture.needsUpdate = true
      }
    },
    dispose() {
      disposed = true
      history.texture.dispose()
      labels.texture.dispose()
    },
  }
}
