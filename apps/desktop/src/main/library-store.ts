import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { readBounded } from './files'
import { pathKey } from '../shared/audio'

function libraryPath(): string {
  return join(app.getPath('userData'), 'playlists.json')
}

export function loadLibrary(): string | null {
  try {
    return readFileSync(libraryPath(), 'utf8')
  } catch {
    return null
  }
}

export function saveLibrary(json: string): void {
  try {
    const temporary = `${libraryPath()}.tmp`
    writeFileSync(temporary, json)
    renameSync(temporary, libraryPath())
  } catch (error) {
    console.error('[library] 保存失败', error)
  }
}

function lyricsPath(trackPath: string): string {
  const key = createHash('sha1').update(pathKey(trackPath)).digest('hex')
  return join(app.getPath('userData'), 'lyrics', `${key}.lrc`)
}

/** 用户手动导入的歌词，按曲目路径保存；优先级高于同名 .lrc 侧车文件。 */
export function getLyricsOverride(trackPath: string): Buffer | null {
  const path = lyricsPath(trackPath)
  return existsSync(path) ? readBounded(path) : null
}

export function setLyricsOverride(trackPath: string, data: Uint8Array | null): void {
  const path = lyricsPath(trackPath)
  try {
    if (data === null) {
      if (existsSync(path)) unlinkSync(path)
      return
    }
    mkdirSync(join(app.getPath('userData'), 'lyrics'), { recursive: true })
    writeFileSync(path, data)
  } catch (error) {
    console.error('[lyrics] 保存失败', error)
  }
}
