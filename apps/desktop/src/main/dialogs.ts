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
import { IPC } from '../shared/ipc'
import type { FileDialogRequest, BrowserListing } from '../shared/dialogs'

const pending = new Map<
  string,
  {
    owner: number
    request: FileDialogRequest
    resolve: (paths: string[]) => void
  }
>()
let lastFolder = ''
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
      { name: '文件系统', path: parse(app.getPath('home')).root },
      { name: '工作目录', path: process.cwd() },
    ].filter((r, i, a) => a.findIndex((v) => v.path === r.path) === i)
    let path =
      typeof input === 'string' && input ? resolve(input) : lastFolder || app.getPath('music')
    try {
      if (!(await stat(path)).isDirectory()) path = dirname(path)
    } catch {
      if (!input) path = app.getPath('home')
    }
    try {
      const entries = (await readdir(path, { withFileTypes: true }))
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => ({
          name: e.name,
          path: join(path, e.name),
          directory: e.isDirectory(),
          size: 0,
        }))
      entries.sort(
        (a, b) =>
          Number(b.directory) - Number(a.directory) ||
          a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
      )
      return {
        path,
        parent: dirname(path) === path ? null : dirname(path),
        roots,
        entries,
      }
    } catch (error) {
      return {
        path,
        parent: dirname(path) === path ? null : dirname(path),
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
        (item.request.mode === 'open' && !info.isFile()) ||
        (item.request.mode !== 'open' && !info.isDirectory()) ||
        !basename(path)
      )
        return false
    }
    pending.delete(item.request.id)
    if (paths[0]) lastFolder = item.request.mode === 'folder' ? paths[0] : dirname(paths[0])
    item.resolve(paths)
    return true
  })
}
