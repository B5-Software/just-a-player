import { showSaveDialog } from './dialogs'
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { IPC } from '../shared/ipc'
import type { VideoRequest, VideoQueueItem } from '../shared/video'
import type { Surface } from '../shared/desktop'
import { cancelVideoOwner } from './video'
const items: VideoQueueItem[] = [],
  requests = new Map<string, VideoRequest>()
let worker: BrowserWindow | null = null,
  current: VideoQueueItem | null = null,
  loaded = false
let load: (win: BrowserWindow, surface: Surface) => void
let lastProgress = 0
export function queueTarget(sender: Electron.WebContents, id: unknown): string | null {
  return sender === worker?.webContents && typeof id === 'string' && current?.id === id
    ? current.target
    : null
}
function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.videoQueue, items)
}
function next(): void {
  if (current) return
  const pending = items.find((j) => j.state === 'waiting')
  if (!pending) {
    setTimeout(() => {
      if (!current && !items.some((i) => i.state === 'waiting')) {
        worker?.destroy()
        worker = null
        loaded = false
      }
    }, 500)
    return
  }
  if (!worker || worker.isDestroyed()) {
    loaded = false
    worker = new BrowserWindow({
      width: 1280,
      height: 720,
      show: false,
      skipTaskbar: true,
      title: 'Just A Player · 后台视频导出',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        partition: 'jap-video-export',
        offscreen: false,
        additionalArguments: ['--jap-surface=export'],
      },
    })
    const own = worker
    worker.webContents.on('render-process-gone', () => {
      if (worker !== own) return
      if (worker) void cancelVideoOwner(worker.webContents.id)
      if (current) {
        current.state = 'failed'
        current.status = '后台渲染进程已退出'
        current.error = current.status
        requests.delete(current.id)
        current = null
        broadcast()
      }
      worker?.destroy()
      worker = null
      loaded = false
      setTimeout(next, 100)
    })
    load(worker, 'export')
    return
  }
  if (!loaded) return
  current = pending
  lastProgress = Date.now()
  current.state = 'rendering'
  current.status = '后台准备…'
  broadcast()
  worker.webContents.send(IPC.videoWorkerJob, { ...requests.get(current.id)!, id: current.id })
}
export function registerVideoQueue(
  trusted: (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => boolean,
  loader: typeof load
): void {
  load = loader
  ipcMain.handle(IPC.videoEnqueue, async (event, request: VideoRequest) => {
    if (
      !trusted(event) ||
      !request?.options ||
      typeof request.options.path !== 'string' ||
      !request.settings ||
      !request.visual ||
      items.filter((i) => i.state === 'waiting').length >= 50
    )
      throw new Error('无效视频任务或队列已满')
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const extension = !request.options.audio || request.options.audio === 'aac' ? 'mp4' : 'mkv'
    const selected = await showSaveDialog(win, {
      title: '加入视频导出队列',
      defaultPath: (request.title || '音乐视频').replace(/[<>:"/\\|?*]/g, '_') + '.' + extension,
      filters: [
        { name: extension === 'mp4' ? 'MP4 视频' : 'Matroska 视频', extensions: [extension] },
      ],
    })
    if (selected.canceled || !selected.filePath) return null
    const item: VideoQueueItem = {
      id: randomUUID(),
      title: request.title,
      path: request.options.path,
      target: selected.filePath,
      state: 'waiting',
      progress: 0,
      status: '排队中',
      error: null,
    }
    // Snapshot settings at enqueue time. Later changes to the live player don't
    // alter an existing export or make the background worker write preferences.
    items.push(item)
    requests.set(item.id, structuredClone(request))
    broadcast()
    next()
    return item
  })
  ipcMain.handle(IPC.videoQueue, (event) => (trusted(event) ? items : []))
  ipcMain.on(IPC.videoWorkerReady, (event) => {
    if (event.sender === worker?.webContents) {
      loaded = true
      next()
    }
  })
  ipcMain.on(
    IPC.videoProgress,
    (
      event,
      value: {
        id: string
        running: boolean
        progress: number
        status: string
        error: string | null
      }
    ) => {
      if (event.sender !== worker?.webContents || current?.id !== value.id) return
      if (current.progress !== value.progress || current.status !== value.status)
        lastProgress = Date.now()
      current.progress = Math.max(0, Math.min(1, value.progress))
      current.status = value.status
      current.error = value.error
      if (!value.running) {
        current.state =
          value.status === '导出完成' ? 'done' : value.status === '已取消' ? 'cancelled' : 'failed'
        requests.delete(current.id)
        current = null
        setTimeout(next, 50)
      }
      broadcast()
    }
  )
  ipcMain.on(IPC.videoQueueCancel, (event, id: unknown) => {
    if (!trusted(event) || typeof id !== 'string') return
    const item = items.find((i) => i.id === id)
    if (item?.state === 'waiting') {
      item.state = 'cancelled'
      item.status = '已取消'
      requests.delete(id)
      broadcast()
    } else if (item === current) {
      item.state = 'cancelled'
      item.status = '已取消'
      requests.delete(id)
      current = null
      const previous = worker
      worker = null
      loaded = false
      if (previous) {
        void cancelVideoOwner(previous.webContents.id)
        previous.destroy()
      }
      broadcast()
      next()
    }
  })
  app.on('before-quit', () => {
    worker?.destroy()
    worker = null
  })
  const watchdog = setInterval(() => {
    if (
      !current ||
      Date.now() - lastProgress < (current.status.includes('合并音频') ? 650000 : 120000)
    )
      return
    current.state = 'failed'
    current.status = '后台生成超时，已释放导出资源'
    current.error = current.status
    requests.delete(current.id)
    current = null
    if (worker) {
      void cancelVideoOwner(worker.webContents.id)
      worker.destroy()
      worker = null
      loaded = false
    }
    broadcast()
    next()
  }, 10000)
  watchdog.unref()
}
