import {
  app,
  ipcMain,
  type BrowserWindow,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from 'electron'
import { randomUUID } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { logicalDrives } from '@jap/engine'
import { IPC } from '../shared/ipc'
import { matchesFileType, validSaveName, WINDOWS_COMPUTER, type FileDialogRequest, type BrowserListing } from '../shared/dialogs'

const pending = new Map<
  string,
  {
    owner: number
    request: FileDialogRequest
    resolve: (paths: string[]) => void
  }
>()
let lastFolder = ''
const windows = process.platform === 'win32'

function resolveAddress(input: string): string {
  let path = input.trim()
  if (windows) {
    path = path.replace(/^"(.*)"$/, '$1').replace(/%([^%]+)%/g, (token, name) => process.env[name] ?? token)
    if (/^[a-z]:$/i.test(path)) path += '\\'
  }
  return resolve(path)
}
function choose(win: BrowserWindow, request: Omit<FileDialogRequest, 'id'>): Promise<string[]> {
  if (win.isDestroyed()) return Promise.resolve([])
  const id = randomUUID()
  return new Promise((complete) => {
    const closed = (): void => {
      pending.delete(id)
      complete([])
    }
    const resolve = (paths: string[]): void => {
      win.off('closed', closed)
      complete(paths)
    }
    pending.set(id, {
      owner: win.webContents.id,
      request: { ...request, id },
      resolve,
    })
    win.once('closed', closed)
    win.webContents.send(IPC.dialogOpen, { ...request, id })
  })
}
export async function showOpenDialog(
  win: BrowserWindow,
  options: OpenDialogOptions
): Promise<{ canceled: boolean; filePaths: string[] }> {
  const paths = await choose(win, {
    title: options.title ?? '选择文件',
    mode: options.properties?.includes('openDirectory') ? 'folder' : 'open',
    multiple: options.properties?.includes('multiSelections') ?? false,
    extensions: options.filters?.flatMap((f) => f.extensions) ?? [],
    defaultPath: options.defaultPath,
  })
  return { canceled: paths.length === 0, filePaths: paths }
}
export async function showSaveDialog(
  win: BrowserWindow,
  options: SaveDialogOptions
): Promise<{ canceled: boolean; filePath?: string }> {
  const paths = await choose(win, {
    title: options.title ?? '保存文件',
    mode: 'save',
    multiple: false,
    extensions: options.filters?.flatMap((f) => f.extensions) ?? [],
    defaultPath: options.defaultPath,
  })
  return { canceled: paths.length === 0, filePath: paths[0] }
}
export function registerDialogs(trusted: (event: Electron.IpcMainInvokeEvent) => boolean): void {
  ipcMain.handle(IPC.dialogBrowse, async (event, input: unknown): Promise<BrowserListing> => {
    if (!trusted(event)) throw new Error('无效文件访问')
    const roots = [
      { name: '音乐', path: app.getPath('music') },
      { name: '下载', path: app.getPath('downloads') },
      { name: '文档', path: app.getPath('documents') },
      { name: '主目录', path: app.getPath('home') },
      windows ? { name: '此电脑', path: WINDOWS_COMPUTER } : { name: '文件系统', path: parse(app.getPath('home')).root },
      { name: '桌面', path: app.getPath('desktop') },
    ].filter((r, i, a) => a.findIndex((v) => v.path === r.path) === i)
    if (windows && input === WINDOWS_COMPUTER) {
      return {
        path: WINDOWS_COMPUTER,
        parent: null,
        roots,
        virtual: true,
        entries: logicalDrives().map((path) => ({ name: path.slice(0, 2), path, directory: true, size: 0 })),
      }
    }
    let path =
      typeof input === 'string' && input.trim() ? resolveAddress(input) : lastFolder || app.getPath('music')
    let selectedPath: string | undefined
    try {
      if ((await stat(path)).isFile()) {
        selectedPath = path
        path = dirname(path)
      }
    } catch {
      if (!input) path = app.getPath('home')
    }
    const parent = dirname(path) === path ? (windows ? WINDOWS_COMPUTER : null) : dirname(path)
    try {
      const files = await readdir(path, { withFileTypes: true })
      const entries = (await Promise.all(files.filter((e) => !e.name.startsWith('.')).map(async (e) => {
        const entryPath = join(path, e.name)
        // Node reports Windows junctions as links. Resolve their type so they remain navigable.
        const info = e.isSymbolicLink() ? await stat(entryPath).catch(() => null) : e
        if (!info || (!info.isDirectory() && !info.isFile())) return null
        return { name: e.name, path: entryPath, directory: info.isDirectory(), size: 0 }
      }))).filter((entry) => entry !== null)
      entries.sort(
        (a, b) =>
          Number(b.directory) - Number(a.directory) ||
          a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
      )
      return {
        path,
        parent,
        roots,
        entries,
        selectedPath,
      }
    } catch (error) {
      return {
        path,
        parent,
        roots,
        entries: [],
        error: `无法读取此位置：${String(error)}`,
      }
    }
  })
  ipcMain.handle(IPC.dialogReply, async (event, id: unknown, value: unknown) => {
    const item = typeof id === 'string' ? pending.get(id) : undefined
    if (!trusted(event) || !item || item.owner !== event.sender.id) return false
    if (
      !Array.isArray(value) ||
      value.length > 2048 ||
      value.some((p) => typeof p !== 'string' || !isAbsolute(p))
    )
      return false
    const paths = value as string[]
    if (!item.request.multiple && paths.length > 1) return false
    for (const path of paths) {
      const info = await stat(item.request.mode === 'save' ? dirname(path) : path).catch(() => null)
      if (
        !info ||
        (item.request.mode === 'open' && (!info.isFile() || !matchesFileType(basename(path), item.request.extensions))) ||
        (item.request.mode !== 'open' && !info.isDirectory()) ||
        (item.request.mode === 'save' && !validSaveName(basename(path), windows))
      )
        return false
    }
    if (pending.get(item.request.id) !== item) return false
    pending.delete(item.request.id)
    if (paths[0]) lastFolder = item.request.mode === 'folder' ? paths[0] : dirname(paths[0])
    item.resolve(paths)
    return true
  })
}
