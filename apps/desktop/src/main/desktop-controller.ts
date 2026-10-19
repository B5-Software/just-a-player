import { app, BrowserWindow, globalShortcut, screen, Tray, type Rectangle } from 'electron'
import { join } from 'node:path'
import * as native from '@jap/engine'
import { IPC } from '../shared/ipc'
import type { Surface, SystemMediaState, WallpaperState, WallpaperLayout } from '../shared/desktop'
import { desktopLayout } from '../shared/desktop-layout'
import { getSettings, updateSettings } from './settings'
import { icon } from './desktop-icon'
import { getLightingAccent } from './lighting'

type Mode = 'normal' | 'mini' | 'wallpaper'
let mode: Mode = 'normal',
  primary: BrowserWindow | null = null,
  wallpaper: BrowserWindow | null = null,
  popup: BrowserWindow | null = null,
  tray: Tray | null = null
let saved: { bounds: Rectangle; maximized: boolean; fullscreen: boolean } | null = null,
  miniBounds: Rectangle | null = null
let quitting = false,
  loadSurface: (win: BrowserWindow, surface: Surface) => void,
  target: (active: boolean, surface?: string) => void
let wallLive = false,
  revision = 0,
  wallPromise: Promise<BrowserWindow> | null = null,
  pointerTimer: NodeJS.Timeout | null = null
let lastVisual: unknown = null
const ready = new Map<number, () => void>()
function wallpaperLayout(): WallpaperLayout {
  const primaryId = screen.getPrimaryDisplay().id
  return desktopLayout(
    screen
      .getAllDisplays()
      .sort((a, b) => Number(b.id === primaryId) - Number(a.id === primaryId))
      .map((display) => ({
        id: display.id,
        ...screen.dipToScreenRect(null, display.bounds)
      }))
  )
}
let media: SystemMediaState = {
  title: 'Just A Player',
  artist: '',
  album: '',
  state: 'stopped',
  durationMs: 0,
  positionMs: 0
}
const nativeDesktop = native as unknown as {
  setDesktopWallpaper(handle: Buffer, enabled: boolean): void
  refreshDesktopWallpaper(handle: Buffer): void
}
export function getWindowMode(): Mode {
  return mode
}
export function getWallpaperWindow(): BrowserWindow | null {
  return wallpaper
}
export function acknowledgeWallpaper(sender: Electron.WebContents, token: number): void {
  if (sender === wallpaper?.webContents) {
    ready.get(token)?.()
    ready.delete(token)
  }
}
export function syncVisual(sender: Electron.WebContents, value: unknown): void {
  if (sender !== primary?.webContents || !value || typeof value !== 'object') return
  const v = value as Record<string, unknown>
  if (typeof v.sceneId !== 'string' || typeof v.auto !== 'boolean' || typeof v.zoom !== 'number')
    return
  lastVisual = value
  wallpaper?.webContents.send(IPC.visualSync, value)
}
export function setDesktopMedia(value: SystemMediaState): void {
  const previous = media.cover
  media = { ...media, ...value }
  const payload = {
    ...media,
    accent: getLightingAccent(),
    wallpaper: getSettings().wallpaperEnabled
  }
  if (media.cover === previous) delete payload.cover
  popup?.webContents.send(IPC.trayState, payload)
  tray?.setToolTip(
    media.title
      ? `${media.title}${media.artist ? ` · ${media.artist}` : ''} — Just A Player`.slice(0, 127)
      : 'Just A Player'
  )
}
function sendCommand(value: string): void {
  primary?.webContents.send(IPC.mediaCommand, value)
}
function ensureWallpaper(): Promise<BrowserWindow> {
  if (wallPromise) return wallPromise
  if (wallpaper && !wallpaper.isDestroyed()) return Promise.resolve(wallpaper)
  wallPromise = new Promise<BrowserWindow>((resolve, reject) => {
    const display = screen.getDisplayMatching(primary!.getBounds())
    const win = (wallpaper = new BrowserWindow({
      ...display.bounds,
      frame: false,
      thickFrame: false,
      show: false,
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      backgroundColor: '#18152c',
      title: 'Just A Player · 桌面壁纸',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        additionalArguments: ['--jap-surface=wallpaper']
      }
    }))
    win.setIgnoreMouseEvents(true)
    win.once('ready-to-show', () => {
      try {
        // Native fitting spans all monitors in physical pixels. OS fullscreen
        // would constrain the wallpaper back to whichever monitor owns the HWND.
        nativeDesktop.setDesktopWallpaper(win.getNativeWindowHandle(), true)
        win.showInactive()
        if (lastVisual) win.webContents.send(IPC.visualSync, lastVisual)
        resolve(win)
      } catch (error) {
        wallpaper = null
        win.destroy()
        reject(error)
      }
    })
    win.on('closed', () => {
      if (wallpaper === win) {
        wallpaper = null
        wallLive = false
      }
    })
    win.once('closed', () => reject(new Error('桌面壁纸窗口已关闭')))
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    loadSurface(win, 'wallpaper')
  }).finally(() => {
    wallPromise = null
  })
  return wallPromise!
}
function destroyWallpaper(): void {
  if (!wallpaper) return
  try {
    nativeDesktop.setDesktopWallpaper(wallpaper.getNativeWindowHandle(), false)
  } catch {
    /* Explorer/window may already be gone */
  }
  wallpaper.destroy()
  wallpaper = null
  wallLive = false
}
function updatePointer(): void {
  const enabled = Boolean(wallpaper && wallLive && getSettings().wallpaperMouseFollow)
  if (pointerTimer) {
    clearInterval(pointerTimer)
    pointerTimer = null
  }
  if (!enabled) {
    wallpaper?.webContents.send(IPC.wallpaperPointer, { x: 0, y: 0 })
    return
  }
  let lastX = Infinity,
    lastY = Infinity
  pointerTimer = setInterval(() => {
    if (!wallpaper || wallpaper.isDestroyed()) return
    const p = screen.getCursorScreenPoint(),
      b = screen.getDisplayNearestPoint(p).bounds
    let x = ((p.x - b.x) / b.width) * 2 - 1,
      y = 1 - ((p.y - b.y) / b.height) * 2
    if (Math.abs(x) > 1 || Math.abs(y) > 1) {
      x = 0
      y = 0
    }
    if (x !== lastX || y !== lastY) {
      wallpaper.webContents.send(IPC.wallpaperPointer, { x, y })
      lastX = x
      lastY = y
    }
  }, 33)
}
async function refresh(): Promise<void> {
  if (!primary || primary.isDestroyed() || quitting) return
  const generation = ++revision,
    visible = primary.isVisible() && !primary.isMinimized(),
    mainDraws = mode === 'normal' && visible
  // Stop primary drawing before handing the analysis stream to another surface.
  primary.webContents.send(IPC.visibilityChanged, false)
  if (!getSettings().wallpaperEnabled) {
    destroyWallpaper()
    updatePointer()
    target(mainDraws, 'main')
    primary.webContents.send(IPC.visibilityChanged, visible)
    return
  }
  try {
    const win = await ensureWallpaper()
    if (generation !== revision || quitting) return
    const live = !mainDraws
    target(false)
    const token = generation
    const ack = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        ready.delete(token)
        resolve()
      }, 1500)
      ready.set(token, () => {
        clearTimeout(timeout)
        resolve()
      })
    })
    win.webContents.send(IPC.wallpaperState, {
      live,
      snapshot: null,
      token,
      layout: wallpaperLayout()
    } satisfies WallpaperState)
    await ack
    if (generation !== revision) return
    wallLive = live
    primary.webContents.send(IPC.visibilityChanged, visible)
    target(true, live ? 'wallpaper' : 'main')
    updatePointer()
  } catch (e) {
    if (generation !== revision || quitting) return
    console.error('[wallpaper]', e)
    destroyWallpaper()
    target(mainDraws, 'main')
    primary.webContents.send(IPC.visibilityChanged, visible)
  }
}
export function refreshDesktopSettings(): void {
  void refresh()
  popup?.webContents.send(IPC.trayState, {
    ...media,
    accent: getLightingAccent(),
    wallpaper: getSettings().wallpaperEnabled
  })
}
let switching: Promise<unknown> = Promise.resolve()
function fullscreen(win: BrowserWindow, value: boolean): Promise<void> {
  if (win.isFullScreen() === value) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timeout)
      win.off('enter-full-screen', done)
      win.off('leave-full-screen', done)
      resolve()
    }
    const timeout = setTimeout(done, 1500)
    if (value) win.once('enter-full-screen', done)
    else win.once('leave-full-screen', done)
    win.setFullScreen(value)
    if (win.isFullScreen() === value) done()
  })
}
export function setWindowMode(win: BrowserWindow, next: Mode): Promise<string> {
  const result = switching.then(() => changeWindowMode(win, next))
  switching = result.catch(() => {})
  return result
}
async function changeWindowMode(win: BrowserWindow, next: Mode): Promise<string> {
  try {
    if (mode === 'normal' && next !== 'normal')
      saved = {
        bounds: win.getNormalBounds(),
        maximized: win.isMaximized(),
        fullscreen: win.isFullScreen()
      }
    if (mode === 'mini') miniBounds = win.getBounds()
    if (next === 'wallpaper') {
      updateSettings({ wallpaperEnabled: true })
      mode = 'wallpaper'
      win.hide()
    } else {
      await fullscreen(win, false)
      if (win.isMaximized()) win.unmaximize()
      if (win.isMinimized()) win.restore()
      win.setResizable(next === 'normal')
      win.setMaximizable(next === 'normal')
      win.setAlwaysOnTop(next === 'mini', 'floating')
      if (next === 'mini') {
        win.setMinimumSize(360, 196)
        const b = screen.getDisplayMatching(miniBounds ?? win.getBounds()).workArea,
          width = 440,
          height = 204
        win.setBounds({
          x: Math.max(
            b.x,
            Math.min(miniBounds?.x ?? b.x + b.width - width - 20, b.x + b.width - width)
          ),
          y: Math.max(
            b.y,
            Math.min(miniBounds?.y ?? b.y + b.height - height - 20, b.y + b.height - height)
          ),
          width,
          height
        })
      } else {
        win.setMinimumSize(960, 640)
        if (saved) win.setBounds(saved.bounds)
      }
      mode = next
      win.show()
      if (next === 'normal' && saved?.maximized) win.maximize()
      if (next === 'normal' && saved?.fullscreen) await fullscreen(win, true)
    }
    win.webContents.send(IPC.windowModeChanged, mode)
    void refresh()
    return mode
  } catch (e) {
    return String(e)
  }
}
function openTrayMenu(): void {
  if (!popup || popup.isDestroyed()) {
    popup = new BrowserWindow({
      width: 304,
      height: 430,
      frame: false,
      transparent: true,
      show: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        additionalArguments: ['--jap-surface=tray']
      }
    })
    popup.on('blur', () => popup?.hide())
    popup.once('ready-to-show', () => openTrayMenu())
    loadSurface(popup, 'tray')
    return
  }
  const at = screen.getCursorScreenPoint(),
    work = screen.getDisplayNearestPoint(at).workArea
  popup.setPosition(
    Math.max(work.x, Math.min(at.x - 150, work.x + work.width - 304)),
    Math.max(work.y, Math.min(at.y - 430, work.y + work.height - 430))
  )
  popup.webContents.send(IPC.trayState, {
    ...media,
    accent: getLightingAccent(),
    wallpaper: getSettings().wallpaperEnabled
  })
  popup.show()
  popup.focus()
}
export function trayAction(value: string): void {
  if (!primary) return
  if (value === 'show') {
    setWindowMode(primary, 'normal')
    primary.focus()
  } else if (value === 'mini') setWindowMode(primary, 'mini')
  else if (value === 'wallpaper') {
    const settings = updateSettings({ wallpaperEnabled: !getSettings().wallpaperEnabled })
    for (const win of BrowserWindow.getAllWindows())
      win.webContents.send(IPC.settingsChanged, settings)
    void refresh()
  } else if (value === 'quit') {
    quitting = true
    app.quit()
  } else if (['play', 'pause', 'previous', 'next', 'stop', 'toggle', 'reset'].includes(value)) {
    sendCommand(value)
    return
  }
  popup?.hide()
}
export function installDesktop(
  win: BrowserWindow,
  onTarget: (active: boolean, surface?: string) => void,
  loader: (win: BrowserWindow, surface: Surface) => void,
  nativeMedia = false
): void {
  primary = win
  target = onTarget
  loadSurface = loader
  tray = new Tray(icon())
  tray.setToolTip('Just A Player')
  if (process.env['JAP_E2E'])
    (globalThis as Record<string, unknown>).__japOpenTrayMenu = (): void => {
      tray?.emit('right-click')
    }
  // The complete menu is our own themed, keyboard-accessible renderer surface.
  tray.on('right-click', openTrayMenu)
  tray.on('double-click', () => trayAction('show'))
  tray.on('click', () => trayAction('show'))
  if (!nativeMedia)
    for (const [key, action] of [
      ['MediaPlayPause', 'toggle'],
      ['MediaNextTrack', 'next'],
      ['MediaPreviousTrack', 'previous'],
      ['MediaStop', 'stop']
    ] as const)
      globalShortcut.register(key, () => sendCommand(action))
  if (process.platform === 'win32')
    win.setThumbarButtons([
      { tooltip: '上一首', icon: icon('previous'), click: () => sendCommand('previous') },
      { tooltip: '播放 / 暂停', icon: icon('play'), click: () => sendCommand('toggle') },
      { tooltip: '下一首', icon: icon('next'), click: () => sendCommand('next') }
    ])
  const visibility = (): void => {
    void refresh()
  }
  win.on('minimize', visibility)
  win.on('restore', visibility)
  win.on('hide', visibility)
  win.on('show', visibility)
  const fit = (): void => {
    if (wallpaper) {
      try {
        nativeDesktop.refreshDesktopWallpaper(wallpaper.getNativeWindowHandle())
        void refresh()
      } catch {
        destroyWallpaper()
        void refresh()
      }
    }
  }
  screen.on('display-metrics-changed', fit)
  screen.on('display-added', fit)
  screen.on('display-removed', fit)
  win.on('close', (event) => {
    if (!quitting && !process.env['JAP_E2E'] && getSettings().backgroundPlayback) {
      event.preventDefault()
      win.hide()
    }
  })
  app.on('before-quit', () => {
    quitting = true
    revision++
    if (pointerTimer) clearInterval(pointerTimer)
    destroyWallpaper()
    popup?.destroy()
    popup = null
    globalShortcut.unregisterAll()
    tray?.destroy()
    tray = null
  })
}
