import { registerDialogs, showOpenDialog, showSaveDialog } from './dialogs'
import { writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  app,
  dialog,
  BrowserWindow,
  ipcMain,
  MessageChannelMain,
  nativeTheme,
  powerSaveBlocker,
  session,
  shell,
  utilityProcess,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type UtilityProcess,
} from 'electron'
import { AUDIO_EXTENSIONS } from '../shared/audio'
import { IPC } from '../shared/ipc'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { CHROME } from '../shared/theme'
import { pathsExist, readBounded, scanAudio, sidecarCover, sidecarLyrics } from './files'
import { getLyricsOverride, loadLibrary, saveLibrary, setLyricsOverride } from './library-store'
import { getSettings, updateSettings } from './settings'
import {
  getWindowMode,
  installDesktop,
  setWindowMode,
  refreshDesktopSettings,
  acknowledgeWallpaper,
  syncVisual,
  trayAction,
} from './desktop'
import { registerVideoIpc } from './video'
import { listFonts, fontData, importFonts } from './fonts'
import { setLightingColor, lightingStatus, syncLighting, closeLighting } from './lighting'
import { initSystemMedia, updateSystemMedia } from './system-media'
import { registerIdentity } from './identity'
import { registerVideoQueue } from './video-queue'
import { selectGpu, registerGpu } from './gpu'
import type { Surface } from '../shared/desktop'
import { discoverAudioTools } from './tools'
import { installFileOpening, attachFileOpening } from './file-opening'
import { registerSoundfonts } from './soundfonts'

const isDev = !app.isPackaged
const isE2E = Boolean(process.env['JAP_E2E'])
// 端到端测试用独立数据目录，不碰用户的设置，也不与正在运行的实例抢单例锁
if (isE2E)
  app.setPath('userData', process.env['JAP_E2E_USERDATA'] || join(tmpdir(), 'jap-e2e-userdata'))

let engine: UtilityProcess | null = null
let exportEngine: UtilityProcess | null = null
const surfaces = new Map<number, Surface>()
app.setName('Just A Player')
if (process.platform === 'win32') app.setAppUserModelId('B5Software.JustAPlayer')
selectGpu()
discoverAudioTools()
installFileOpening()
/** 保存对话框返回过、尚未写入的导出路径。 */
const exportTargets = new Set<string>()
let playingForAwake = false
let displayBlocker: number | null = null
function updateAwake(): void {
  const hold = playingForAwake && getSettings().keepScreenAwake
  if (hold && displayBlocker === null)
    displayBlocker = powerSaveBlocker.start('prevent-display-sleep')
  if (!hold && displayBlocker !== null) {
    powerSaveBlocker.stop(displayBlocker)
    displayBlocker = null
  }
}

function startEngine(): UtilityProcess {
  const child = utilityProcess.fork(join(__dirname, 'engine-host.js'), [], {
    serviceName: 'Just A Player Engine',
    stdio: 'pipe',
  })
  child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk))
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk))
  child.on('exit', (code) => {
    console.error(`[engine] 进程退出，代码 ${code}`)
    if (engine === child) engine = null
    if (exportEngine === child) exportEngine = null
  })
  return child
}

/** 每次页面加载都建一条新的 MessagePort 直连引擎，引擎本身不受页面刷新影响。 */
function attachEngine(win: BrowserWindow, surface: Surface = 'main'): void {
  const host = surface === 'export' ? (exportEngine ??= startEngine()) : (engine ??= startEngine())
  const { port1, port2 } = new MessageChannelMain()
  host.postMessage({ type: 'attach', surface }, [port1])
  if (surface === 'export') host.postMessage({ type: 'visibility', visible: false })
  win.webContents.postMessage(IPC.enginePort, null, [port2])
}

function installContentSecurityPolicy(): void {
  const policy = isDev
    ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'self' blob: ws://localhost:* http://localhost:*; worker-src 'self' blob:"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'self' blob:; worker-src 'self' blob:"

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] },
    })
  })
}

function isTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? ''
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  return isDev && devUrl ? url.startsWith(devUrl) : url.startsWith('file://')
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function registerIpc(): void {
  registerSoundfonts(isTrustedSender)
  ipcMain.on('app:version', (event) => {
    event.returnValue = app.getVersion()
  })
  ipcMain.on('app:bundledMidi', (event) => {
    event.returnValue =
      existsSync(process.env['JAP_SOUNDFONT_PATH'] ?? '') && process.env['JAP_BUNDLE_MIDI'] !== '0'
  })
  ipcMain.on(IPC.librarySave, (event, json: unknown) => {
    if (isTrustedSender(event) && typeof json === 'string') saveLibrary(json)
    event.returnValue = null
  })
  registerGpu(isTrustedSender)
  registerVideoQueue(isTrustedSender, loadSurface)
  ipcMain.on(IPC.wallpaperReady, (event, token: unknown) => {
    if (isTrustedSender(event) && typeof token === 'number')
      acknowledgeWallpaper(event.sender, token)
  })
  ipcMain.on(IPC.visualSync, (event, value: unknown) => {
    if (isTrustedSender(event)) syncVisual(event.sender, value)
  })
  ipcMain.on(IPC.systemMedia, (event, value: unknown) => {
    if (isTrustedSender(event) && surfaces.get(event.sender.id) === 'main') {
      updateSystemMedia(value)
      playingForAwake =
        typeof value === 'object' &&
        value !== null &&
        (value as { state?: string }).state === 'playing'
      updateAwake()
    }
  })
  ipcMain.on(IPC.trayAction, (event, value: unknown) => {
    if (isTrustedSender(event) && typeof value === 'string') trayAction(value)
  })
  ipcMain.on(IPC.lightingColor, (event, hex: unknown) => {
    if (
      isTrustedSender(event) &&
      surfaces.get(event.sender.id) === 'main' &&
      typeof hex === 'string' &&
      /^#[a-f\d]{6}$/i.test(hex)
    ) {
      setLightingColor(hex)
      for (const win of BrowserWindow.getAllWindows())
        if (surfaces.get(win.webContents.id) === 'tray')
          win.webContents.send(IPC.trayState, { accent: hex })
    }
  })
  ipcMain.handle(IPC.lightingStatus, (event) => (isTrustedSender(event) ? lightingStatus() : null))
  ipcMain.on(IPC.fontsList, (event) => {
    event.returnValue = isTrustedSender(event) ? listFonts() : []
  })
  ipcMain.handle(IPC.fontData, (event, id: unknown) =>
    isTrustedSender(event) && typeof id === 'string' ? fontData(id) : null
  )
  ipcMain.handle(IPC.fontsImport, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!isTrustedSender(event) || !win) return { fonts: [], errors: [] }
    const result = await importFonts(win)
    for (const other of BrowserWindow.getAllWindows())
      other.webContents.send(IPC.fontsList, listFonts())
    return result
  })
  registerDialogs(isTrustedSender)
  registerVideoIpc(isTrustedSender)
  ipcMain.handle(IPC.musicFolders, (event) => {
    if (!isTrustedSender(event) || isE2E) return []
    const home = app.getPath('home')
    return [
      ...new Set([
        app.getPath('music'),
        join(home, 'Music', 'CloudMusic'),
        join(home, 'Downloads', 'CloudMusic'),
        join(home, 'Downloads', '网易云音乐'),
        join(home, 'AppData', 'Local', 'CloudMusic', 'CloudMusic'),
        join(home, 'CloudMusic'),
        'C:\\CloudMusic',
        'D:\\CloudMusic',
      ]),
    ].filter((p) => existsSync(p))
  })
  ipcMain.handle(IPC.windowMode, (event, mode: unknown) => {
    if (!isTrustedSender(event) || !['normal', 'mini', 'wallpaper'].includes(String(mode)))
      return '无效窗口模式'
    const win = BrowserWindow.fromWebContents(event.sender)
    return win ? setWindowMode(win, mode as 'normal' | 'mini' | 'wallpaper') : '窗口已关闭'
  })
  ipcMain.on(IPC.settingsGet, (event) => {
    event.returnValue = isTrustedSender(event) ? getSettings() : DEFAULT_SETTINGS
  })

  ipcMain.handle(IPC.settingsUpdate, (event, patch: unknown) => {
    if (!isTrustedSender(event)) return getSettings()
    const previous = getSettings()
    const next = updateSettings(patch)
    updateAwake()
    syncLighting()
    if (next.themeMode !== previous.themeMode) nativeTheme.themeSource = next.themeMode
    for (const other of BrowserWindow.getAllWindows())
      other.webContents.send(IPC.settingsChanged, next)
    if (
      next.wallpaperEnabled !== previous.wallpaperEnabled ||
      next.wallpaperMouseFollow !== previous.wallpaperMouseFollow
    )
      refreshDesktopSettings()
    return next
  })

  ipcMain.handle(IPC.openAudio, async (event) => {
    if (!isTrustedSender(event)) return []
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return []
    const result = await (getWindowMode() === 'mini'
      ? dialog.showOpenDialog.bind(dialog)
      : showOpenDialog)(win, {
      title: '选择音频文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '音频文件', extensions: [...AUDIO_EXTENSIONS] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle(IPC.openFolder, async (event) => {
    if (!isTrustedSender(event)) return []
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return []
    const result = await showOpenDialog(win, {
      title: '选择音乐文件夹',
      properties: ['openDirectory', 'multiSelections'],
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle(IPC.openVisualPlugin, async (event) => {
    if (!isTrustedSender(event)) return []
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return []
    const result = await showOpenDialog(win, {
      title: '导入可视化插件',
      properties: ['openFile'],
      filters: [{ name: 'Just A Player 效果插件', extensions: ['json'] }],
    })
    return result.canceled ? [] : result.filePaths
  })
  ipcMain.handle(IPC.openPlaylist, async (event) => {
    if (!isTrustedSender(event)) return []
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return []
    const result = await showOpenDialog(win, {
      title: '导入播放列表',
      properties: ['openFile'],
      filters: [{ name: '播放列表', extensions: ['m3u', 'm3u8', 'json'] }],
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle(IPC.openLyrics, async (event) => {
    if (!isTrustedSender(event)) return []
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return []
    const result = await showOpenDialog(win, {
      title: '导入歌词',
      properties: ['openFile'],
      filters: [{ name: '歌词文件', extensions: ['lrc', 'txt'] }],
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle(IPC.pickExportPath, async (event, suggestedName: unknown, json: unknown) => {
    if (!isTrustedSender(event) || typeof suggestedName !== 'string') return null
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const result = await showSaveDialog(win, {
      title: '导出播放列表',
      defaultPath: suggestedName,
      filters:
        json === true
          ? [{ name: 'JSON 播放列表', extensions: ['json'] }]
          : [{ name: 'M3U8 播放列表', extensions: ['m3u8'] }],
    })
    if (result.canceled || !result.filePath) return null
    exportTargets.add(result.filePath)
    return result.filePath
  })

  /** 只允许写入刚由保存对话框返回过的路径，每个路径只用一次。 */
  ipcMain.handle(IPC.writeExport, (event, path: unknown, content: unknown) => {
    if (!isTrustedSender(event) || typeof path !== 'string' || typeof content !== 'string')
      return false
    if (!exportTargets.delete(path)) return false
    try {
      writeFileSync(path, content)
      return true
    } catch (error) {
      console.error('[playlist] 导出失败', error)
      return false
    }
  })

  ipcMain.handle(IPC.scanAudio, (event, paths: unknown, recursive: unknown) => {
    if (!isTrustedSender(event) || !isStringArray(paths)) return []
    return scanAudio(paths, recursive !== false)
  })

  ipcMain.handle(IPC.pathsExist, (event, paths: unknown) => {
    if (!isTrustedSender(event) || !isStringArray(paths)) return []
    return pathsExist(paths)
  })

  ipcMain.handle(IPC.readFile, (event, path: unknown) => {
    if (!isTrustedSender(event) || typeof path !== 'string') return null
    return readBounded(path)
  })

  ipcMain.handle(IPC.sidecarCover, (event, path: unknown) => {
    if (!isTrustedSender(event) || typeof path !== 'string') return null
    return sidecarCover(path)
  })

  ipcMain.handle(IPC.sidecarLyrics, (event, path: unknown) => {
    if (!isTrustedSender(event) || typeof path !== 'string') return null
    return sidecarLyrics(path)
  })

  ipcMain.handle(IPC.libraryLoad, (event) => (isTrustedSender(event) ? loadLibrary() : null))

  ipcMain.handle(IPC.librarySave, (event, json: unknown) => {
    if (isTrustedSender(event) && typeof json === 'string') saveLibrary(json)
  })

  ipcMain.handle(IPC.lyricsGet, (event, path: unknown) => {
    if (!isTrustedSender(event) || typeof path !== 'string') return null
    return getLyricsOverride(path)
  })

  ipcMain.handle(IPC.lyricsSet, (event, path: unknown, data: unknown) => {
    if (!isTrustedSender(event) || typeof path !== 'string') return
    setLyricsOverride(path, data instanceof Uint8Array ? data : null)
  })

  ipcMain.handle(IPC.setFullscreen, (event, value: unknown) => {
    if (!isTrustedSender(event) || typeof value !== 'boolean' || getWindowMode() !== 'normal')
      return
    BrowserWindow.fromWebContents(event.sender)?.setFullScreen(value)
  })
}

/** 让窗口底色与 Windows 标题栏按钮颜色跟随当前有效主题。 */
function applyChrome(win: BrowserWindow): void {
  if (surfaces.get(win.webContents.id) !== 'main') return
  const chrome = nativeTheme.shouldUseDarkColors ? CHROME.dark : CHROME.light
  win.setBackgroundColor(chrome.background)
  // 全屏时没有标题栏，此时设置覆盖层会被系统忽略甚至报错，直接跳过
  if (process.platform !== 'darwin' && !win.isFullScreen()) {
    win.setTitleBarOverlay({ color: '#00000000', symbolColor: chrome.symbol, height: 44 })
  }
}
function loadSurface(other: BrowserWindow, surface: Surface): void {
  surfaces.set(other.webContents.id, surface)
  if (surface === 'wallpaper' || surface === 'export')
    other.webContents.on('did-finish-load', () => attachEngine(other, surface))
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) void other.loadURL(`${devUrl}?surface=${surface}${isE2E ? '&e2e=1' : ''}`)
  else
    void other.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { surface, ...(isE2E ? { e2e: '1' } : {}) },
    })
}

function createWindow(): void {
  const chrome = nativeTheme.shouldUseDarkColors ? CHROME.dark : CHROME.light
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: chrome.background,
    title: 'Just A Player',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: chrome.symbol, height: 44 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // 可视化与进度条不该因为窗口被遮挡而卡住
      backgroundThrottling: false,
    },
  })

  win.once('ready-to-show', () => win.show())
  surfaces.set(win.webContents.id, 'main')
  attachFileOpening(win, () => {
    if (getWindowMode() !== 'normal') void setWindowMode(win, 'normal')
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  registerIdentity(win)
  const nativeMedia = initSystemMedia(win)
  installDesktop(
    win,
    (visible, surface) => engine?.postMessage({ type: 'visibility', visible, surface }),
    loadSurface,
    nativeMedia
  )
  win.webContents.on('did-finish-load', () => attachEngine(win))

  // 窗口全屏状态以主进程为准：无论谁改的（按钮、F11、系统），都回灌给界面
  const reportFullscreen = (flag: boolean): void => {
    if (!win.isDestroyed()) win.webContents.send(IPC.fullscreenChanged, flag)
  }
  win.on('enter-full-screen', () => reportFullscreen(true))
  win.on('leave-full-screen', () => {
    applyChrome(win)
    reportFullscreen(false)
  })
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      event.preventDefault()
      if (getWindowMode() === 'normal') win.setFullScreen(!win.isFullScreen())
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) void win.loadURL(devUrl)
  else
    void win.loadFile(
      join(__dirname, '../renderer/index.html'),
      isE2E ? { query: { e2e: '1' } } : {}
    )
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows().find(
      (window) => surfaces.get(window.webContents.id) === 'main'
    )
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  void app.whenReady().then(() => {
    nativeTheme.themeSource = getSettings().themeMode
    nativeTheme.on('updated', () => {
      for (const win of BrowserWindow.getAllWindows()) applyChrome(win)
    })
    installContentSecurityPolicy()
    registerIpc()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => {
    if (displayBlocker !== null) powerSaveBlocker.stop(displayBlocker)
    closeLighting()
    engine?.kill()
    exportEngine?.kill()
    engine = null
  })
}
