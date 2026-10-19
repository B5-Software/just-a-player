import type { AudioFormat } from '@shared/protocol/AudioFormat'

export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

export function formatRate(hz: number): string {
  const khz = hz / 1000
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`
}

export function describeFormat(format: AudioFormat): string {
  if (format.bits === 1 && !format.float) {
    return `DSD${format.sampleRate / (format.sampleRate % 44100 === 0 ? 44100 : 48000)} / ${(format.sampleRate / 1e6).toFixed(4)} MHz`
  }
  const depth =
    format.bits === null ? '有损' : `${format.bits}-bit${format.float ? ' 浮点' : ''}`
  return `${depth} / ${formatRate(format.sampleRate)}`
}

export function channelLabel(channels: number): string {
  if (channels === 1) return '单声道'
  if (channels === 2) return '立体声'
  return `${channels} 声道`
}
