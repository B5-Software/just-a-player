import type { TrackInfo } from './protocol/TrackInfo'
import type { OutputConfig } from './protocol/OutputConfig'
import type { DspConfig } from './protocol/DspConfig'
export interface LightweightHandoff {
  libraryJson?: string
  track: TrackInfo | null
  state: 'stopped' | 'playing' | 'paused'
  positionMs: number
  volume: number
  output: OutputConfig
  dsp: DspConfig
}
