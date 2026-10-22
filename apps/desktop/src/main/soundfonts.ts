import { basename, join } from 'node:path'
import { openSync, closeSync, readSync, mkdirSync, statSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { app, BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../shared/ipc'
import { showOpenDialog } from './dialogs'
export function registerSoundfonts(trusted: (event: Electron.IpcMainInvokeEvent) => boolean): void {
  ipcMain.handle(IPC.soundfontImport, async (event) => {
    if (!trusted(event)) return null
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const selected = await showOpenDialog(win, {
      title: '导入 MIDI 音色库',
      properties: ['openFile'],
      filters: [{ name: 'SoundFont 2', extensions: ['sf2'] }],
    })
    const path = selected.filePaths[0]
    if (!path) return null
    if (statSync(path).size > 1024 * 1024 * 1024) throw Error('音色库超过 1 GiB')
    const fd = openSync(path, 'r'),
      header = Buffer.alloc(12)
    try {
      if (
        readSync(fd, header) !== 12 ||
        header.toString('ascii', 0, 4) !== 'RIFF' ||
        header.toString('ascii', 8, 12) !== 'sfbk'
      )
        throw Error('请选择有效的 SF2 音色库')
    } finally {
      closeSync(fd)
    }
    const dir = join(app.getPath('userData'), 'soundfonts')
    mkdirSync(dir, { recursive: true })
    const target = join(
      dir,
      createHash('sha256').update(path).digest('hex').slice(0, 12) + '-' + basename(path)
    )
    if (target !== path) await copyFile(path, target)
    return target
  })
}
