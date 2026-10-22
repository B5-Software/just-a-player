import { app, BrowserWindow, ipcMain } from 'electron'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isAudioPath } from '../shared/audio'
import { IPC } from '../shared/ipc'
const pending: string[] = []
let mainWindow: BrowserWindow | null = null
let reveal: () => void = () => {}
function enqueue(inputs: string[], cwd = process.cwd()): void {
  for (let path of inputs.slice(0, 1000)) {
    try {
      if (path.startsWith('file:')) path = fileURLToPath(path)
      if (path.startsWith('-')) continue
      path = resolve(cwd, path)
      if ((isAudioPath(path) || /\.(m3u|m3u8)$/i.test(path)) && statSync(path).isFile())
        pending.push(path)
    } catch {
      /* Invalid command-line arguments never become library entries. */
    }
  }
  if (pending.length && mainWindow && !mainWindow.isDestroyed()) {
    reveal()
    mainWindow.webContents.send(IPC.openFiles)
  }
}
/** Installed before app.ready: Finder can deliver documents during cold launch. */
export function installFileOpening(): void {
  enqueue(process.argv)
  app.on('open-file', (event, path) => {
    event.preventDefault()
    enqueue([path])
  })
  app.on('second-instance', (_event, argv, cwd) => {
    enqueue(argv, cwd)
    reveal()
  })
  ipcMain.handle(IPC.takeOpenFiles, (event) =>
    mainWindow && event.sender === mainWindow.webContents ? pending.splice(0) : []
  )
}
export function attachFileOpening(window: BrowserWindow, show: () => void): void {
  mainWindow = window
  reveal = show
}
