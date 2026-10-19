import type { TrackInfo } from '@shared/protocol/TrackInfo'
import { pathKey } from '@shared/audio'
export function siblingKey(path: string): string {
  return pathKey(path).replace(/\.[^/.]+$/, '')
}
export function importRank(track: TrackInfo): number {
  const f = track.format
  const rate = f.bits === 1 ? f.sampleRate / 64 : f.sampleRate
  const bits = f.bits === 1 ? 24 : (f.bits ?? 16)
  return track.lossless
    ? 1e9 + Math.min(rate, 768000) * Math.min(bits, 32)
    : (track.bitrateKbps ?? 0) * 1000
}
export function formatRank(path: string): number {
  return ['flac', 'wav', 'aiff', 'aif', 'ape', 'alac', 'dsf', 'dff'].some((ext) =>
    path.toLowerCase().endsWith('.' + ext)
  )
    ? 1e9
    : 0
}
