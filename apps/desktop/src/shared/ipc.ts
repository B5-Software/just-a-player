import type { Command } from './protocol/Command'
import type { Event } from './protocol/Event'
import type { Query } from './protocol/Query'
import type { QueryResponse } from './protocol/QueryResponse'

/** 渲染进程 -> 引擎宿主（utilityProcess），经 MessagePort 直连，不经过主进程。 */
export type RendererToHost =
  | {
      kind: 'offline'
      id: number
      action: 'open' | 'frame' | 'close' | 'original'
      path?: string
      startMs?: number
      writeAudio?: boolean
      soundfont?: string
      midiRate?: number
      timeMs?: number
    }
  | { kind: 'command'; command: Command }
  | { kind: 'query'; id: number; query: Query }
  | { kind: 'cover'; id: number; path: string }

export interface CoverPayload {
  mime: string
  data: Uint8Array
}

export type HostToRenderer =
  | { kind: 'offlineResult'; id: number; frame?: Float32Array; audioPath?: string; error?: string }
  | { kind: 'event'; event: Event }
  | { kind: 'queryResult'; id: number; response: QueryResponse }
  | { kind: 'coverResult'; id: number; cover: CoverPayload | null }
  /** 可视化分析帧，布局见 `viz.ts`。 */
  | { kind: 'viz'; frame: Float32Array }

/** 主进程 IPC 通道名。 */
export const IPC = {
  lightweightOpen: 'lightweight:open',
  lightweightHandoff: 'lightweight:handoff',
  soundfontImport: 'midi:import-soundfont',
  openFiles: 'app:open-files',
  takeOpenFiles: 'app:take-open-files',
  dialogOpen: 'dialog:custom-open',
  dialogBrowse: 'dialog:custom-browse',
  dialogReply: 'dialog:custom-reply',
  gpuInfo: 'gpu:info',
  restart: 'app:restart',
  videoEnqueue: 'video:enqueue',
  videoQueue: 'video:queue',
  videoQueueCancel: 'video:queue-cancel',
  videoWorkerReady: 'video:worker-ready',
  videoWorkerJob: 'video:worker-job',
  videoProgress: 'video:progress',
  settingsChanged: 'settings:changed',
  wallpaperState: 'wallpaper:state',
  wallpaperReady: 'wallpaper:ready',
  visualSync: 'desktop:visual-sync',
  trayState: 'tray:state',
  trayAction: 'tray:action',
  systemMedia: 'media:state',
  fontsList: 'fonts:list',
  fontsImport: 'fonts:import',
  fontData: 'fonts:data',
  wallpaperPointer: 'window:wallpaper-pointer',
  lightingColor: 'lighting:color',
  lightingStatus: 'lighting:status',
  windowMode: 'window:mode',
  windowModeChanged: 'window:mode-changed',
  visibilityChanged: 'window:visibility',
  mediaCommand: 'media:command',
  musicFolders: 'library:music-folders',
  videoStart: 'video:start',
  videoFrame: 'video:frame',
  videoFinish: 'video:finish',
  videoCancel: 'video:cancel',
  enginePort: 'engine-port',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  openAudio: 'dialog:open-audio',
  openFolder: 'dialog:open-folder',
  openPlaylist: 'dialog:open-playlist',
  openVisualPlugin: 'dialog:open-visual-plugin',
  openLyrics: 'dialog:open-lyrics',
  pickExportPath: 'dialog:pick-export-path',
  writeExport: 'fs:write-export',
  scanAudio: 'fs:scan-audio',
  readFile: 'fs:read-file',
  pathsExist: 'fs:paths-exist',
  sidecarCover: 'fs:sidecar-cover',
  sidecarLyrics: 'fs:sidecar-lyrics',
  libraryLoad: 'library:load',
  librarySave: 'library:save',
  lyricsGet: 'lyrics:get',
  lyricsSet: 'lyrics:set',
  setFullscreen: 'window:set-fullscreen',
  fullscreenChanged: 'window:fullscreen-changed',
} as const
