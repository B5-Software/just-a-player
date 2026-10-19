export type Surface = 'main' | 'wallpaper' | 'tray' | 'export'
export interface WallpaperState {
  live: boolean
  snapshot: string | null
  token: number
  layout?: WallpaperLayout
}
export interface WallpaperLayout {
  width: number
  height: number
  displays: { id: number; x: number; y: number; width: number; height: number }[]
}
export interface SystemMediaState {
  title: string
  artist: string
  album: string
  state: string
  durationMs: number
  positionMs: number
  cover?: Uint8Array | null
}
