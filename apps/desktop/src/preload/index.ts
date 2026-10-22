/// <reference lib="dom" />
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/ipc'
import type { AppSettings } from '../shared/settings'

// MessagePort 无法穿过 contextBridge，只能经 window.postMessage 转交给页面
ipcRenderer.on(IPC.enginePort, (event) => {
  window.postMessage(IPC.enginePort, '*', [...event.ports])
})

let traySnapshot: Record<string, unknown> | undefined
ipcRenderer.on(IPC.trayState, (_event, value: unknown) => {
  traySnapshot = { ...traySnapshot, ...(value as Record<string, unknown>) }
})
contextBridge.exposeInMainWorld('jap', {
  bundledMidi: ipcRenderer.sendSync('app:bundledMidi') as boolean,
  importSoundfont: () => ipcRenderer.invoke(IPC.soundfontImport),
  takeOpenFiles: () => ipcRenderer.invoke(IPC.takeOpenFiles),
  onOpenFiles: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.openFiles, listener)
    return () => ipcRenderer.off(IPC.openFiles, listener)
  },
  onDialogRequest: (callback: (request: unknown) => void) => {
    const listener = (_event: unknown, request: unknown): void => callback(request)
    ipcRenderer.on(IPC.dialogOpen, listener)
    return () => ipcRenderer.off(IPC.dialogOpen, listener)
  },
  browseFiles: (path?: string) => ipcRenderer.invoke(IPC.dialogBrowse, path),
  dialogReply: (id: string, paths: string[]) => ipcRenderer.invoke(IPC.dialogReply, id, paths),
  platform: process.platform,
  version: ipcRenderer.sendSync('app:version') as string,
  gpuInfo: () => ipcRenderer.invoke(IPC.gpuInfo),
  restart: () => ipcRenderer.invoke(IPC.restart),
  surface: process.argv.includes('--jap-surface=export')
    ? 'export'
    : process.argv.includes('--jap-surface=wallpaper')
      ? 'wallpaper'
      : process.argv.includes('--jap-surface=tray')
        ? 'tray'
        : 'main',
  enqueueVideo: (value: unknown) => ipcRenderer.invoke(IPC.videoEnqueue, value),
  videoQueue: () => ipcRenderer.invoke(IPC.videoQueue),
  cancelVideoJob: (id: string) => ipcRenderer.send(IPC.videoQueueCancel, id),
  videoWorkerReady: () => ipcRenderer.send(IPC.videoWorkerReady),
  videoProgress: (value: unknown) => ipcRenderer.send(IPC.videoProgress, value),
  onVideoJob: (callback: (value: unknown) => void) => {
    const listener = (_e: unknown, value: unknown): void => callback(value)
    ipcRenderer.on(IPC.videoWorkerJob, listener)
    return () => ipcRenderer.off(IPC.videoWorkerJob, listener)
  },
  onVideoQueue: (callback: (value: unknown) => void) => {
    const listener = (_e: unknown, value: unknown): void => callback(value)
    ipcRenderer.on(IPC.videoQueue, listener)
    return () => ipcRenderer.off(IPC.videoQueue, listener)
  },
  onVideoCancel: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.videoQueueCancel, listener)
    return () => ipcRenderer.off(IPC.videoQueueCancel, listener)
  },
  onSettings: (callback: (value: AppSettings) => void) => {
    const listener = (_e: unknown, value: AppSettings): void => callback(value)
    ipcRenderer.on(IPC.settingsChanged, listener)
    return () => ipcRenderer.off(IPC.settingsChanged, listener)
  },
  onWallpaperState: (callback: (value: unknown) => void) => {
    const listener = (_e: unknown, value: unknown): void => callback(value)
    ipcRenderer.on(IPC.wallpaperState, listener)
    return () => ipcRenderer.off(IPC.wallpaperState, listener)
  },
  wallpaperReady: (token: number) => ipcRenderer.send(IPC.wallpaperReady, token),
  syncVisual: (value: unknown) => ipcRenderer.send(IPC.visualSync, value),
  onVisualSync: (callback: (value: unknown) => void) => {
    const listener = (_e: unknown, value: unknown): void => callback(value)
    ipcRenderer.on(IPC.visualSync, listener)
    return () => ipcRenderer.off(IPC.visualSync, listener)
  },
  setSystemMedia: (value: unknown) => ipcRenderer.send(IPC.systemMedia, value),
  trayAction: (action: string) => ipcRenderer.send(IPC.trayAction, action),
  onTrayState: (callback: (value: unknown) => void) => {
    if (traySnapshot) callback(traySnapshot)
    const listener = (_e: unknown, value: unknown): void => callback(value)
    ipcRenderer.on(IPC.trayState, listener)
    return () => ipcRenderer.off(IPC.trayState, listener)
  },
  initialFonts: ipcRenderer.sendSync(IPC.fontsList),
  onFonts: (callback: (fonts: unknown) => void) => {
    const listener = (_e: unknown, fonts: unknown): void => callback(fonts)
    ipcRenderer.on(IPC.fontsList, listener)
    return () => ipcRenderer.off(IPC.fontsList, listener)
  },
  importFonts: () => ipcRenderer.invoke(IPC.fontsImport),
  fontData: (id: string) => ipcRenderer.invoke(IPC.fontData, id),
  setLightingColor: (hex: string) => ipcRenderer.send(IPC.lightingColor, hex),
  lightingStatus: () => ipcRenderer.invoke(IPC.lightingStatus),
  onWallpaperPointer: (callback: (point: { x: number; y: number }) => void): (() => void) => {
    const listener = (_e: unknown, point: { x: number; y: number }): void => callback(point)
    ipcRenderer.on(IPC.wallpaperPointer, listener)
    return () => ipcRenderer.off(IPC.wallpaperPointer, listener)
  },
  videoStart: (options: unknown): Promise<unknown> => ipcRenderer.invoke(IPC.videoStart, options),
  videoFrame: (id: string, data: Uint8Array): Promise<void> =>
    ipcRenderer.invoke(IPC.videoFrame, id, data),
  videoFinish: (id: string, audioPath: string): Promise<string> =>
    ipcRenderer.invoke(IPC.videoFinish, id, audioPath),
  videoCancel: (id: string, audioPath?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.videoCancel, id, audioPath),
  musicFolders: (): Promise<string[]> => ipcRenderer.invoke(IPC.musicFolders),
  setWindowMode: (mode: 'normal' | 'mini' | 'wallpaper'): Promise<string> =>
    ipcRenderer.invoke(IPC.windowMode, mode),
  onWindowMode: (callback: (value: 'normal' | 'mini' | 'wallpaper') => void): (() => void) => {
    const listener = (_e: unknown, value: 'normal' | 'mini' | 'wallpaper'): void => callback(value)
    ipcRenderer.on(IPC.windowModeChanged, listener)
    return () => ipcRenderer.off(IPC.windowModeChanged, listener)
  },
  onVisibility: (callback: (visible: boolean) => void): (() => void) => {
    const listener = (_e: unknown, value: boolean): void => callback(value)
    ipcRenderer.on(IPC.visibilityChanged, listener)
    return () => ipcRenderer.off(IPC.visibilityChanged, listener)
  },
  onMediaCommand: (callback: (command: string) => void): (() => void) => {
    const listener = (_e: unknown, value: string): void => callback(value)
    ipcRenderer.on(IPC.mediaCommand, listener)
    return () => ipcRenderer.off(IPC.mediaCommand, listener)
  },
  /** 首帧前就要用到的设置（主题、强调色），启动时同步取一次。 */
  initialSettings: ipcRenderer.sendSync(IPC.settingsGet) as AppSettings,
  updateSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.settingsUpdate, patch),
  openAudioFiles: (): Promise<string[]> => ipcRenderer.invoke(IPC.openAudio),
  openFolders: (): Promise<string[]> => ipcRenderer.invoke(IPC.openFolder),
  openPlaylistFiles: (): Promise<string[]> => ipcRenderer.invoke(IPC.openPlaylist),
  openVisualPluginFiles: (): Promise<string[]> => ipcRenderer.invoke(IPC.openVisualPlugin),
  openLyricsFiles: (): Promise<string[]> => ipcRenderer.invoke(IPC.openLyrics),
  pickExportPath: (suggestedName: string, json: boolean): Promise<string | null> =>
    ipcRenderer.invoke(IPC.pickExportPath, suggestedName, json),
  writeExport: (path: string, content: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.writeExport, path, content),
  scanAudio: (paths: string[], recursive: boolean): Promise<string[]> =>
    ipcRenderer.invoke(IPC.scanAudio, paths, recursive),
  pathsExist: (paths: string[]): Promise<boolean[]> => ipcRenderer.invoke(IPC.pathsExist, paths),
  readFile: (path: string): Promise<Uint8Array | null> => ipcRenderer.invoke(IPC.readFile, path),
  sidecarCover: (path: string): Promise<{ mime: string; data: Uint8Array } | null> =>
    ipcRenderer.invoke(IPC.sidecarCover, path),
  sidecarLyrics: (path: string): Promise<Uint8Array | null> =>
    ipcRenderer.invoke(IPC.sidecarLyrics, path),
  libraryLoad: (): Promise<string | null> => ipcRenderer.invoke(IPC.libraryLoad),
  librarySave: (json: string): Promise<void> => ipcRenderer.invoke(IPC.librarySave, json),
  libraryFlush: (json: string): void => {
    ipcRenderer.sendSync(IPC.librarySave, json)
  },
  lyricsGet: (path: string): Promise<Uint8Array | null> => ipcRenderer.invoke(IPC.lyricsGet, path),
  lyricsSet: (path: string, data: Uint8Array | null): Promise<void> =>
    ipcRenderer.invoke(IPC.lyricsSet, path, data),
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  setFullscreen: (value: boolean): Promise<void> => ipcRenderer.invoke(IPC.setFullscreen, value),
  /** 订阅窗口全屏状态的权威变化（F11、系统快捷键等都会走到这里）。 */
  onFullscreenChange: (callback: (value: boolean) => void): (() => void) => {
    const listener = (_event: unknown, value: boolean): void => callback(value)
    ipcRenderer.on(IPC.fullscreenChanged, listener)
    return () => ipcRenderer.off(IPC.fullscreenChanged, listener)
  },
})
