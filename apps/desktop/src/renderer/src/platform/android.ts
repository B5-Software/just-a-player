/** Android installs this adapter before any store reads window.jap. Desktop uses preload. */
import type { FileDialogRequest } from '@shared/dialogs'
import { DEFAULT_SETTINGS, applySettingsPatch, type AppSettings } from '@shared/settings'
import { IPC } from '@shared/ipc'
import { AUDIO_EXTENSIONS, discSource, discTrack } from '@shared/audio'
import { setAndroidSurfaceWidth } from '../lib/pixel-ratio'
type JapBridge = Window['jap']

interface AndroidNative {
  snapshot(): string
  request(id: number, method: string, payload: string): void
  engine(message: string): void
  flushLibrary(json: string): void
}
declare global {
  interface Window {
    NativeAndroid?: AndroidNative
    NativeHarmony?: AndroidNative
    __androidEvent?: (event: string, value: unknown) => void
  }
}
const native = window.NativeAndroid ?? window.NativeHarmony
const harmony = !!window.NativeHarmony
if (native) {
  document.documentElement.dataset['platform'] = harmony ? 'ohos' : 'android'
  type Listener = (value: never) => void
  const listeners = new Map<string, Set<Listener>>()
  const emit = (key: string, value: unknown): void => {
    for (const fn of listeners.get(key) ?? []) fn(value as never)
  }
  const on = <T>(key: string, fn: (value: T) => void): (() => void) => {
    const set = listeners.get(key) ?? new Set<Listener>()
    listeners.set(key, set)
    set.add(fn as Listener)
    return () => {
      set.delete(fn as Listener)
    }
  }
  let nextId = 1
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  const rpc = <T>(method: string, payload: object = {}): Promise<T> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(
        () => {
          pending.delete(id)
          reject(new Error(`Android 请求超时：${method}`))
        },
        method === 'videoFinish' ? 650000 : 60000
      )
      pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      })
      native.request(id, method, JSON.stringify(payload))
    })
  const bytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const b64 = (data: Uint8Array): string => {
    let text = ''
    for (let i = 0; i < data.length; i += 8192)
      text += String.fromCharCode(...data.subarray(i, i + 8192))
    return btoa(text)
  }
  const readBytes = async (method: string, payload: object): Promise<Uint8Array | null> => {
    const value = await rpc<string | null>(method, payload)
    return value === null ? null : bytes(value)
  }
  const channel = new MessageChannel()
  channel.port1.onmessage = (e) => {
    native.engine(JSON.stringify(e.data))
  }
  channel.port1.start()
  window.__androidEvent = (key, value) => {
    if (key === 'rpc') {
      const response = value as { id: number; value?: unknown; error?: string }
      const waiter = pending.get(response.id)
      if (waiter) {
        clearTimeout(waiter.timer)
        pending.delete(response.id)
        response.error ? waiter.reject(new Error(response.error)) : waiter.resolve(response.value)
      }
    } else if (key === 'engine') {
      const message = value as {
        kind: string
        base64?: string
        frame?: Float32Array
        cover?: { mime: string; base64?: string; data?: Uint8Array }
      }
      if (message.base64) {
        message.frame = new Float32Array(bytes(message.base64).buffer)
        delete message.base64
      }
      if (message.cover?.base64) {
        message.cover.data = bytes(message.cover.base64)
        delete message.cover.base64
      }
      channel.port1.postMessage(message)
    } else if (key === 'nativeError') {
      channel.port1.postMessage({
        kind: 'event',
        event: { type: 'error', message: String(value) },
      })
    } else emit(key, value)
  }
  const fire = (method: string, payload: object = {}): void => {
    void rpc(method, payload).catch((error) =>
      window.__androidEvent?.('nativeError', error.message)
    )
  }
  const snapshot = JSON.parse(native.snapshot())
  let settings = applySettingsPatch(DEFAULT_SETTINGS, snapshot.settings)
  let viewport = snapshot.viewport as { width: number; height: number; density: number } | undefined
  let mini = false
  const applyViewport = (): void => {
    if (snapshot.surface === 'export' || !viewport?.width || !viewport.height || !viewport.density)
      return
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
    if (!meta) return
    const referenceHeight = Math.max(480, Math.min(900, viewport.height / 2))
    const pixelsPerUnit = (viewport.height / referenceHeight) * settings.androidUiScale
    // Older WebViews can update devicePixelRatio before their cached DIP size.
    // Measure the browser's actual unzoomed viewport instead of mixing the two.
    const browser = window.visualViewport
    const browserWidth = browser ? browser.width * browser.scale : 0
    const density = browserWidth > 0 ? viewport.width / browserWidth : viewport.density
    const scale = pixelsPerUnit / density
    const fixedScale = scale.toFixed(6)
    const content = mini
      ? 'width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no'
      // WebView otherwise clamps small initial scales or retains a stale page
      // scale after a DPI change. The app's own UI-size preference owns zoom.
      : `width=${Math.round(viewport.width / pixelsPerUnit)}, initial-scale=${fixedScale}, minimum-scale=${fixedScale}, maximum-scale=${fixedScale}, user-scalable=no`
    if (meta.content !== content) meta.content = content
    setAndroidSurfaceWidth(viewport.width)
    document.documentElement.dataset.uiScale = String(settings.androidUiScale)
  }
  let viewportFrame = 0
  const scheduleViewport = (): void => {
    if (viewportFrame) return
    viewportFrame = requestAnimationFrame(() => {
      viewportFrame = 0
      applyViewport()
    })
  }
  window.addEventListener('resize', scheduleViewport)
  window.visualViewport?.addEventListener('resize', scheduleViewport)
  on('viewport', (value: NonNullable<typeof viewport>) => {
    viewport = value
    applyViewport()
  })
  on('windowMode', (mode: string) => {
    mini = mode === 'mini'
    applyViewport()
  })
  applyViewport()
  const dialogs = new Map<string, (paths: string[]) => void>()
  const choose = (options: Omit<FileDialogRequest, 'id'>): Promise<string[]> =>
    new Promise((resolve) => {
      const id = `android-${nextId++}`
      dialogs.set(id, resolve)
      emit('dialog', { ...options, id })
    })
  const audioExtensions = [
    'flac',
    'wav',
    'aif',
    'aiff',
    'mp3',
    'm4a',
    'aac',
    'ogg',
    'oga',
    'opus',
    'mka',
    'caf',
    'alac',
    'dsf',
    'dff',
    'dsd',
    'ncm',
    'ape',
    'dts',
    'dtshd',
    'iso',
    'cue',
    'wv',
    'tta',
  ]
  const bridge: JapBridge = {
    bundledMidi: snapshot.bundledMidi === true,
    nativeHdr:
      snapshot.surface === 'export' || harmony
        ? undefined
        : {
            validate: snapshot.qa ? (frame) => rpc('nativeHdrTest', frame) : undefined,
            info: snapshot.hdr,
            configure: (enabled) => rpc('nativeHdr', { enabled }),
            scene: (frame) => rpc('hdrScene', frame),
            onState: (fn) => on('nativeHdr', fn),
          },
    takeOpenFiles: () => rpc('takeOpenFiles'),
    onOpenFiles: (fn) => on('openFiles', fn),
    importSoundfont: async () => {
      const paths = await choose({
        mode: 'open',
        title: '导入 MIDI 音色库',
        extensions: ['sf2'],
        multiple: false,
      })
      return paths[0] ? rpc('importSoundfont', { path: paths[0] }) : null
    },
    platform: harmony ? 'ohos' : 'android',
    version: snapshot.version,
    surface: snapshot.surface ?? 'main',
    initialSettings: settings,
    initialFonts: snapshot.fonts ?? [],
    onDialogRequest: (fn) => on('dialog', fn),
    browseFiles: (path) => rpc('browse', path ? { path } : {}),
    dialogReply: async (id, paths) => {
      const resolve = dialogs.get(id)
      if (!resolve) return false
      dialogs.delete(id)
      resolve(paths)
      return true
    },
    requestMusicPermission: () => rpc('permission'),
    connectUsb: () => rpc('connectUsb'),
    onUsbChange: (fn) => on('usb', fn),
    openAudioFiles: () =>
      choose({
        title: '导入音乐',
        mode: 'open',
        multiple: true,
        extensions: [...AUDIO_EXTENSIONS],
      }),
    openFolders: () =>
      choose({
        title: '添加音乐目录',
        mode: 'folder',
        multiple: true,
        extensions: [],
      }),
    openLyricsFiles: () =>
      choose({
        title: '导入歌词',
        mode: 'open',
        multiple: false,
        extensions: ['lrc', 'txt'],
      }),
    openVisualPluginFiles: () =>
      choose({ title: '导入可视化插件', mode: 'open', multiple: false, extensions: ['json'] }),
    openPlaylistFiles: () =>
      choose({
        title: '导入播放列表',
        mode: 'open',
        multiple: true,
        extensions: ['json', 'm3u', 'm3u8'],
      }),
    pickExportPath: async (name, json) => {
      const [path] = await choose({
        title: '保存播放列表',
        mode: 'save',
        multiple: false,
        extensions: [json ? 'json' : 'm3u8'],
        defaultPath: name,
      })
      if (!path) return null
      await rpc('grantExport', { path })
      return path
    },
    writeExport: (path, content) => rpc('writeExport', { path, content }),
    scanAudio: async (paths, recursive) => [
      ...paths.filter((p) => discTrack(p)),
      ...(await rpc<string[]>('scan', { paths: paths.filter((p) => !discTrack(p)), recursive })),
    ],
    pathsExist: (paths) => rpc('pathsExist', { paths: paths.map(discSource) }),
    readFile: (path) => readBytes('readFile', { path }),
    sidecarLyrics: (path) =>
      discTrack(path) ? Promise.resolve(null) : readBytes('sidecarLyrics', { path }),
    sidecarCover: async (path) => {
      const cover = await rpc<{ mime: string; base64: string } | null>('sidecarCover', {
        path: discSource(path),
      })
      return cover ? { mime: cover.mime, data: bytes(cover.base64) } : null
    },
    libraryLoad: () => rpc('libraryLoad'),
    librarySave: (json) => rpc('librarySave', { json }),
    libraryFlush: (json) => native.flushLibrary(json),
    lyricsGet: (path) => readBytes('lyricsGet', { path }),
    lyricsSet: (path, data) => rpc('lyricsSet', { path, data: data ? b64(data) : null }),
    musicFolders: () => rpc('musicFolders'),
    pathForFile: () => '',
    updateSettings: async (patch) => {
      settings = applySettingsPatch(settings, patch)
      applyViewport()
      await rpc('settings', { patch: settings })
      emit('settings', settings)
      return settings
    },
    onSettings: (fn) => on('settings', fn),
    importFonts: async () => {
      const paths = await choose({
        title: '导入字体',
        mode: 'open',
        multiple: true,
        extensions: ['ttf', 'otf', 'ttc', 'otc', 'woff', 'woff2'],
      })
      const result = await rpc<{
        fonts: typeof bridge.initialFonts
        errors: string[]
      }>('importFonts', { paths })
      emit('fonts', result.fonts)
      return result
    },
    onFonts: (fn) => on('fonts', fn),
    fontData: (id) => readBytes('fontData', { id }),
    onVisibility: (fn) => {
      if (snapshot.surface === 'export') {
        queueMicrotask(() => fn(false))
        return () => {}
      }
      const off = on('visibility', fn)
      queueMicrotask(() => fn(!document.hidden))
      return off
    },
    onMediaCommand: (fn) => on('media', fn),
    setSystemMedia: (value) =>
      fire('systemMedia', {
        ...value,
        cover: undefined,
        coverBase64: 'cover' in value ? (value.cover ? b64(value.cover) : '') : undefined,
      }),
    setFullscreen: (value) => rpc('fullscreen', { value }),
    onFullscreenChange: (fn) => on('fullscreen', fn),
    setWindowMode: (mode) => rpc('windowMode', { mode }),
    onWindowMode: (fn) => on('windowMode', fn),
    gpuInfo: async () => null,
    restart: () => rpc('restart'),
    lightingStatus: async () => ({
      connected: false,
      message: 'Android 尚未连接 OpenRGB',
      devices: [],
    }),
    setLightingColor: () => {},
    onWallpaperState: () => () => {},
    wallpaperReady: () => {},
    syncVisual: () => {},
    onVisualSync: () => () => {},
    onWallpaperPointer: () => () => {},
    trayAction: () => {},
    onTrayState: () => () => {},
    enqueueVideo: async (request) => {
      const extension = !request.options.audio || request.options.audio === 'aac' ? 'mp4' : 'mkv'
      const [target] = await choose({
        title: '加入视频导出队列',
        mode: 'save',
        multiple: false,
        extensions: [extension],
        defaultPath: request.title.replace(/[<>:"/\\|?*]/g, '_') + '.' + extension,
      })
      return target ? rpc('videoEnqueue', { ...request, target }) : null
    },
    videoQueue: () => rpc('videoQueue'),
    cancelVideoJob: (id) => fire('videoCancelJob', { id }),
    videoWorkerReady: () => fire('videoWorkerReady'),
    videoProgress: (value) => fire('videoProgress', value),
    onVideoJob: (fn) => on('videoJob', fn),
    onVideoQueue: (fn) => on('videoQueue', fn),
    onVideoCancel: (fn) => on('videoCancel', fn),
    videoStart: (options) => rpc('videoStart', options),
    videoFrame: (id, data) => rpc('videoFrame', { id, data: b64(data) }),
    videoFinish: (id, audioPath) => rpc('videoFinish', { id, audioPath }),
    videoCancel: (id, audioPath) => rpc('videoCancel', { id, audioPath }),
  }
  window.jap = bridge
  queueMicrotask(() => {
    window.postMessage(IPC.enginePort, window.location.origin==='null'?'*':window.location.origin, [channel.port2])
  })
}
