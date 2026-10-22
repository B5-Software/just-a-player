import type { AppSettings } from './settings'
export interface VideoOptions {
  renderPriority?: 'balanced' | 'fast'
  path: string
  width: number
  height: number
  fps: number
  quality: number
  encoder: string
  intro: number
  outro: number
  start: number
  end: number
  lyrics: '2d' | '3d' | 'none'
  signature?: string
  coverFont?: AppSettings['lyricsFont']
  audio?: 'aac' | 'opus' | 'flac' | 'pcm' | 'copy'
  audioBitrate?: number
  queueId?: string
}
export interface VideoRequest {
  options: VideoOptions
  title: string
  settings: AppSettings
  visual: {
    viewport?: { width: number; height: number }
    sceneId: string
    auto: boolean
    offset: { x: number; y: number; z: number }
    zoom: number
    userCustomOffset: boolean
  }
}
export interface VideoQueueItem {
  id: string
  title: string
  path: string
  target: string
  state: 'waiting' | 'rendering' | 'done' | 'failed' | 'cancelled'
  progress: number
  status: string
  error: string | null
}
