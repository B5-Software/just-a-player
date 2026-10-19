import { dirName, isAudioPath } from '@shared/audio'
import { decodeText } from '../lib/text'
import {
  useLibrary,
  displayTitle,
  makeItem,
  makeList,
  type Playlist,
  type TrackItem
} from './store'

export type ExportFormat = 'm3u' | 'm3u-relative' | 'json'

const FILE_FORMAT = 'jap-playlist'
const FILE_VERSION = 1

const safeName = (name: string): string => name.replace(/[\\/:*?"<>|]/g, '_').trim() || '播放列表'

function isAbsolute(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\') || path.startsWith('/')
}

/** Relative paths retain POSIX case and separators; Windows volumes remain case-insensitive. */
export function relativePath(fromDir: string, target: string): string {
  if (fromDir.startsWith('/') && target.startsWith('/')) {
    const from = fromDir.split('/').filter(Boolean)
    const to = target.split('/').filter(Boolean)
    let common = 0
    while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++
    return [...Array.from({ length: from.length - common }, () => '..'), ...to.slice(common)].join(
      '/'
    )
  }
  const split = (p: string): string[] => p.replace(/\//g, '\\').split('\\').filter(Boolean)
  const from = split(fromDir)
  const to = split(target)
  if (from[0]?.toLowerCase() !== to[0]?.toLowerCase()) return target
  let common = 0
  while (
    common < from.length &&
    common < to.length - 1 &&
    from[common]!.toLowerCase() === to[common]!.toLowerCase()
  ) {
    common++
  }
  const ups = from.length - common
  return [...Array.from({ length: ups }, () => '..'), ...to.slice(common)].join('\\')
}

function buildM3U(items: TrackItem[], baseDir: string | null): string {
  const lines = ['#EXTM3U']
  for (const item of items) {
    const seconds = item.durationMs ? Math.round(item.durationMs / 1000) : -1
    const label = [item.artist, displayTitle(item)].filter(Boolean).join(' - ')
    lines.push(`#EXTINF:${seconds},${label}`)
    lines.push(baseDir ? relativePath(baseDir, item.path) : item.path)
  }
  return `${lines.join('\r\n')}\r\n`
}

function buildJson(list: Playlist): string {
  return JSON.stringify(
    {
      format: FILE_FORMAT,
      version: FILE_VERSION,
      name: list.name,
      items: list.items.map(({ path, title, artist, album, durationMs }) => ({
        path,
        title,
        artist,
        album,
        durationMs
      }))
    },
    null,
    2
  )
}

/** 导出一个列表：M3U8（绝对或相对路径）或完整的 JSON。返回是否写入成功。 */
export async function exportList(list: Playlist, format: ExportFormat): Promise<boolean> {
  const base = safeName(list.name)
  if (format === 'json') {
    const path = await window.jap.pickExportPath(`${base}.json`, true)
    return path ? window.jap.writeExport(path, buildJson(list)) : false
  }
  const path = await window.jap.pickExportPath(`${base}.m3u8`, false)
  if (!path) return false
  const content = buildM3U(list.items, format === 'm3u-relative' ? dirName(path) : null)
  return window.jap.writeExport(path, content)
}

function parseM3U(text: string, baseDir: string, name: string): Playlist {
  const items: TrackItem[] = []
  let pending: { seconds: number; label: string } | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#EXTINF:')) {
      const match = /^#EXTINF:(-?\d+(?:\.\d+)?),?(.*)$/.exec(line)
      pending = { seconds: match ? Number(match[1]) : -1, label: match?.[2]?.trim() ?? '' }
      continue
    }
    if (line.startsWith('#')) continue
    const posix = baseDir.startsWith('/')
    const normalized = posix ? line.replace(/\\/g, '/') : line.replace(/\//g, '\\')
    const path = isAbsolute(line) ? normalized : `${baseDir}${posix ? '/' : '\\'}${normalized}`
    if (!isAudioPath(path)) continue
    const [artist, title] = pending?.label.includes(' - ')
      ? [
          pending.label.split(' - ')[0]!.trim(),
          pending.label.split(' - ').slice(1).join(' - ').trim()
        ]
      : [null, pending?.label || null]
    items.push(
      makeItem(path, {
        title,
        artist,
        durationMs: pending && pending.seconds > 0 ? pending.seconds * 1000 : null
      })
    )
    pending = null
  }
  return makeList(name, items)
}

function parseJson(text: string, fallbackName: string): Playlist | null {
  try {
    const data = JSON.parse(text) as {
      name?: unknown
      items?: {
        path?: unknown
        title?: unknown
        artist?: unknown
        album?: unknown
        durationMs?: unknown
      }[]
    }
    if (!Array.isArray(data.items)) return null
    const items = data.items
      .filter((i): i is { path: string } & typeof i => typeof i.path === 'string')
      .map((i) =>
        makeItem(i.path, {
          title: typeof i.title === 'string' ? i.title : null,
          artist: typeof i.artist === 'string' ? i.artist : null,
          album: typeof i.album === 'string' ? i.album : null,
          durationMs: typeof i.durationMs === 'number' ? i.durationMs : null
        })
      )
    return makeList(typeof data.name === 'string' ? data.name : fallbackName, items)
  } catch {
    return null
  }
}

/**
 * 导入播放列表文件（M3U / M3U8 / JSON），每个文件导入为一个新列表。
 * 不传 `paths` 时弹出文件选择器；返回导入的列表数。
 */
export async function importPlaylists(paths?: string[]): Promise<number> {
  const files = paths ?? (await window.jap.openPlaylistFiles())
  let count = 0
  for (const file of files) {
    const bytes = await window.jap.readFile(file)
    if (!bytes) continue
    const text = decodeText(bytes)
    const fileName = file.split(/[\\/]/).pop() ?? '导入的列表'
    const name = fileName.replace(/\.[^.]+$/, '')
    const list = file.toLowerCase().endsWith('.json')
      ? parseJson(text, name)
      : parseM3U(text, dirName(file), name)
    if (!list) continue
    useLibrary.getState().importList(list)
    count++
  }
  return count
}
