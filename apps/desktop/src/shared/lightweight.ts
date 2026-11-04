import type { TrackInfo } from './protocol/TrackInfo'
import type { OutputConfig } from './protocol/OutputConfig'
import type { DspConfig } from './protocol/DspConfig'
import type { ThemeMode } from './theme'
export interface LightweightHandoff {
  libraryJson?: string
  track: TrackInfo | null
  state: 'stopped' | 'playing' | 'paused'
  positionMs: number
  volume: number
  output: OutputConfig
  dsp: DspConfig
  externalForce?: boolean
  sharedAudio?: boolean
  appearance?: {
    themeMode: ThemeMode
    resolved: 'light' | 'dark'
    accent: string
    autoAccent: boolean
    activeAccent?: string
  }
}
