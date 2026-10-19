import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { dirName, isAudioPath } from '../shared/audio'

/** 读取文件时的上限，避免误选超大文件把渲染进程撑爆。 */
const MAX_READ_BYTES = 16 * 1024 * 1024

const COVER_NAMES = ['cover', 'folder', 'front', 'album']
const COVER_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp'
}

function naturalCompare(a: Dirent, b: Dirent): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
}

async function walk(dir: string, recursive: boolean, out: string[]): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries.sort(naturalCompare)) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (recursive) await walk(full, recursive, out)
    } else if (entry.isFile() && isAudioPath(entry.name)) {
      out.push(full)
    }
  }
}

/** 展开路径：文件保留（非音频跳过），目录按自然顺序展开，可选递归。 */
export async function scanAudio(paths: readonly string[], recursive: boolean): Promise<string[]> {
  const out: string[] = []
  for (const path of paths) {
    const info = await stat(path).catch(() => null)
    if (info?.isDirectory()) await walk(path, recursive, out)
    else if (info?.isFile() && isAudioPath(path)) out.push(path)
  }
  return out
}

export function pathsExist(paths: readonly string[]): boolean[] {
  return paths.map((path) => existsSync(path))
}

export function readBounded(path: string): Buffer | null {
  try {
    const info = statSync(path)
    if (!info.isFile() || info.size > MAX_READ_BYTES) return null
    return readFileSync(path)
  } catch {
    return null
  }
}

/** 同目录下名字不区分大小写地查找文件，返回实际路径。 */
function findSibling(dir: string, wanted: (name: string) => boolean): string | null {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  const match = names.find((name) => wanted(name.toLowerCase()))
  return match ? join(dir, match) : null
}

export function sidecarLyrics(trackPath: string): Buffer | null {
  const stem = trackPath
    .replace(/\.[^./\\]+$/, '')
    .split(/[\\/]/)
    .pop()
    ?.toLowerCase()
  if (!stem) return null
  const path = findSibling(dirName(trackPath), (name) => name === `${stem}.lrc`)
  return path ? readBounded(path) : null
}

export function sidecarCover(trackPath: string): { mime: string; data: Buffer } | null {
  const dir = dirName(trackPath)
  for (const name of COVER_NAMES) {
    for (const [ext, mime] of Object.entries(COVER_TYPES)) {
      const path = findSibling(dir, (candidate) => candidate === `${name}.${ext}`)
      if (!path) continue
      const data = readBounded(path)
      if (data) return { mime, data }
    }
  }
  return null
}
