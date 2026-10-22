import type { AppSettings, ImportedFont } from '../shared/settings'
import type { LightingStatus } from '../shared/lighting'
import type { Surface, WallpaperState, SystemMediaState } from '../shared/desktop'
import type { VideoRequest, VideoQueueItem } from '../shared/video'

export interface JapBridge {
  bundledMidi: boolean
  nativeHdr?: {
    validate?(frame: {
      fragment: string
      uniforms: Record<string, number | number[]>
    }): Promise<{ pixels: number[]; renderer: string }>
    info: {
      supported: boolean
      types: number[]
      maxLuminance: number
      wideColor: boolean
      webView: string
    }
    configure(enabled: boolean): Promise<boolean>
    scene(frame: {
      fragment?: string
      uniforms: Record<string, number | number[]>
      width: number
      height: number
      backdrop?: string | null
      textures?: { name: string; width: number; height: number; data: string }[]
    }): Promise<boolean>
    onState(callback: (state: { active: boolean; reason: string }) => void): () => void
  }
  importSoundfont(): Promise<string | null>
  takeOpenFiles(): Promise<string[]>
  onOpenFiles(callback: () => void): () => void
  requestMusicPermission?(): Promise<void>
  connectUsb?(): Promise<string>
  onUsbChange?(callback: (connected: boolean) => void): () => void
  onDialogRequest(
    callback: (request: import('../shared/dialogs').FileDialogRequest) => void
  ): () => void
  browseFiles(path?: string): Promise<import('../shared/dialogs').BrowserListing>
  dialogReply(id: string, paths: string[]): Promise<boolean>
  gpuInfo(): Promise<import('../shared/gpu').GpuInfo | null>
  restart(): Promise<void>
  enqueueVideo(request: VideoRequest): Promise<VideoQueueItem | null>
  videoQueue(): Promise<VideoQueueItem[]>
  cancelVideoJob(id: string): void
  videoWorkerReady(): void
  videoProgress(value: {
    id: string
    progress: number
    status: string
    running: boolean
    error: string | null
    target: string | null
  }): void
  onVideoJob(callback: (value: VideoRequest & { id: string }) => void): () => void
  onVideoQueue(callback: (value: VideoQueueItem[]) => void): () => void
  onVideoCancel(callback: () => void): () => void
  surface: Surface
  onSettings(callback: (value: AppSettings) => void): () => void
  onWallpaperState(callback: (value: WallpaperState) => void): () => void
  wallpaperReady(token: number): void
  syncVisual(value: unknown): void
  onVisualSync(callback: (value: unknown) => void): () => void
  setSystemMedia(value: SystemMediaState): void
  trayAction(action: string): void
  onTrayState(
    callback: (value: SystemMediaState & { accent: string; wallpaper: boolean }) => void
  ): () => void
  initialFonts: ImportedFont[]
  onFonts(callback: (fonts: ImportedFont[]) => void): () => void
  importFonts(): Promise<{ fonts: ImportedFont[]; errors: string[] }>
  fontData(id: string): Promise<Uint8Array | null>
  setLightingColor(hex: string): void
  lightingStatus(): Promise<LightingStatus>
  onWallpaperPointer(callback: (point: { x: number; y: number }) => void): () => void
  videoStart(options: {
    transport?: 'rgba' | 'h264'
    midiSoundfont?: string | null
    originalSourcePath?: string
    audioBits?: number
    musicDuration?: number
    width: number
    height: number
    fps: number
    quality: number
    encoder: string
    intro: number
    duration: number
    title: string
  }): Promise<{ id: string; encoder: string; target: string } | null>
  videoFrame(id: string, data: Uint8Array): Promise<void>
  videoFinish(id: string, audioPath: string): Promise<string>
  videoCancel(id: string, audioPath?: string): Promise<void>
  musicFolders(): Promise<string[]>
  setWindowMode(mode: 'normal' | 'mini' | 'wallpaper'): Promise<string>
  onWindowMode(callback: (mode: 'normal' | 'mini' | 'wallpaper') => void): () => void
  onVisibility(callback: (visible: boolean) => void): () => void
  onMediaCommand(callback: (command: string) => void): () => void
  /** 启动时同步取到的设置快照。 */
  initialSettings: AppSettings
  /** 合并更新设置并持久化，返回更新后的完整设置。 */
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  /** 在应用内选择音频文件。 */
  openAudioFiles(): Promise<string[]>
  openFolders(): Promise<string[]>
  openPlaylistFiles(): Promise<string[]>
  openVisualPluginFiles(): Promise<string[]>
  openLyricsFiles(): Promise<string[]>
  /** 弹出保存对话框，返回用户选择的路径（取消为 null）。 */
  pickExportPath(suggestedName: string, json: boolean): Promise<string | null>
  /** 写入由 `pickExportPath` 返回过的路径，每个路径只能用一次。 */
  writeExport(path: string, content: string): Promise<boolean>
  /** 展开路径：目录按自然顺序展开为音频文件，可选递归。 */
  scanAudio(paths: string[], recursive: boolean): Promise<string[]>
  pathsExist(paths: string[]): Promise<boolean[]>
  readFile(path: string): Promise<Uint8Array | null>
  sidecarCover(path: string): Promise<{ mime: string; data: Uint8Array } | null>
  sidecarLyrics(path: string): Promise<Uint8Array | null>
  libraryLoad(): Promise<string | null>
  librarySave(json: string): Promise<void>
  libraryFlush(json: string): void
  platform: string
  version: string
  lyricsGet(path: string): Promise<Uint8Array | null>
  lyricsSet(path: string, data: Uint8Array | null): Promise<void>
  /** 把拖放进来的 File 换成磁盘路径。 */
  pathForFile(file: File): string
  /** 切换窗口全屏（不是 CSS 假全屏）。 */
  setFullscreen(value: boolean): Promise<void>
  /** 订阅窗口全屏状态变化，返回取消订阅函数。 */
  onFullscreenChange(callback: (value: boolean) => void): () => void
}

declare global {
  interface Window {
    jap: JapBridge
  }
}

export {}
