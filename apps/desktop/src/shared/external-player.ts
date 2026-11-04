export interface ExternalDevice {
  name: string
  type: string
  id: number
  deviceId: string
}
export interface ExternalSnapshot {
  found: boolean
  acks: number[]
  track: { id: string; title: string; artist: string; album: string; durationMs: number; coverUrl: string; localPath?: string }
  state: 'playing' | 'paused' | 'stopped'
  positionMs: number
  speed: number
  mode?: 'off' | 'all' | 'one' | 'shuffle' | 'fm' | 'ai'
  queue?: {
    name: string
    items: { id: string; title: string; artist: string; album: string; durationMs: number }[]
    total: number
    truncated: boolean
  }
  lyrics: {
    trackId: string
    type: string
    offset: number
    lines: { time: number; lyric: string }[]
    translation: { time: number; lyric: string }[]
    romanization: { time: number; lyric: string }[]
    yrc: string
  }
  devices: { currentDevice: ExternalDevice; totalDevices: { type: string; devices: ExternalDevice[] }[] } | null
  deviceError: string | null
}
export interface ExternalPlayerState {
  lyricsText?: string | null
  phase: 'disconnected' | 'connecting' | 'ready' | 'routing' | 'error'
  message: string
  snapshot: ExternalSnapshot | null
  path: string | null
  /** Omitted in incremental events when the image did not change. */
  cover?: { mime: string; data: Uint8Array } | null
  audioPackets: number
  nullBytes: string
}
export type ExternalAction = 'connect' | 'disconnect' | 'route' | 'pause' | 'resume' | 'next' | 'previous' | 'seek' | 'status' | 'playIndex' | 'repeatOff' | 'repeatAll' | 'repeatOne' | 'shuffleOn' | 'shuffleOff'
