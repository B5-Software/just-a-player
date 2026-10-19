import * as native from '@jap/engine'
import { app, type BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc'
import type { SystemMediaState } from '../shared/desktop'
import { setDesktopMedia } from './desktop'
const bridge = native as unknown as {
  initSystemMedia(handle: Buffer): boolean
  updateSystemMedia(state: SystemMediaState): void
  pollSystemMedia(): string[]
  closeSystemMedia(): void
}
let initialized = false,
  last: SystemMediaState = {
    title: '',
    artist: '',
    album: '',
    state: 'stopped',
    durationMs: 0,
    positionMs: 0
  }
export function initSystemMedia(win: BrowserWindow): boolean {
  if (process.platform !== 'win32') return false
  try {
    initialized = bridge.initSystemMedia(win.getNativeWindowHandle())
    const timer = setInterval(() => {
      if (!win.isDestroyed())
        for (const action of bridge.pollSystemMedia())
          win.webContents.send(IPC.mediaCommand, action)
    }, 100)
    app.on('before-quit', () => {
      clearInterval(timer)
      bridge.closeSystemMedia()
    })
  } catch (e) {
    console.error('[SMTC] 初始化失败', e)
  }
  return initialized
}
export function updateSystemMedia(value: unknown): void {
  if (!value || typeof value !== 'object') return
  const v = value as Record<string, unknown>
  if (
    !['title', 'artist', 'album', 'state'].every((key) => typeof v[key] === 'string') ||
    !Number.isFinite(v.durationMs) ||
    !Number.isFinite(v.positionMs)
  )
    return
  const next: SystemMediaState = {
    title: String(v.title).slice(0, 1024),
    artist: String(v.artist).slice(0, 1024),
    album: String(v.album).slice(0, 1024),
    state: String(v.state),
    durationMs: Number(v.durationMs),
    positionMs: Number(v.positionMs)
  }
  if (v.cover === null) last.cover = null
  else if (v.cover instanceof Uint8Array && v.cover.length <= 8 * 1024 * 1024)
    last.cover = Buffer.from(v.cover)
  last = { ...last, ...next }
  setDesktopMedia(last)
  if (initialized) {
    try {
      const { cover, ...state } = last
      bridge.updateSystemMedia(cover ? { ...state, cover: Buffer.from(cover) } : state)
    } catch (e) {
      console.error('[SMTC] 更新失败', e)
    }
  }
}
