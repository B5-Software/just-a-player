import { create } from 'zustand'
import { decodeText } from '../lib/text'
import { useSettings } from '../settings/store'
import { engine } from '../engine/client'

export type LyricsSource = 'imported' | 'sidecar' | 'embedded'

interface LyricsState {
  path: string | null
  text: string | null
  source: LyricsSource | null
}

export const useLyrics = create<LyricsState>(() => ({ path: null, text: null, source: null }))

let token = 0

/** 歌词来源优先级：用户导入 > 同名 .lrc 侧车文件 > 音频内嵌 LYRICS。 */
export async function loadLyrics(path: string | null): Promise<void> {
  const id = ++token
  if (!path) {
    useLyrics.setState({ path: null, text: null, source: null })
    return
  }
  useLyrics.setState({ path, text: null, source: null })
  let bytes = await window.jap.lyricsGet(path)
  let source: LyricsSource | null = bytes ? 'imported' : null
  if (!bytes && useSettings.getState().sidecarLyrics) {
    bytes = await window.jap.sidecarLyrics(path)
    if (bytes) source = 'sidecar'
  }
  if (id !== token) return
  let text = bytes ? decodeText(bytes) : null
  if (!text) {
    try {
      const result = await engine.query({ type: 'embeddedLyrics', path })
      if (result.type === 'lyrics' && result.text) {
        text = result.text
        source = 'embedded'
      }
    } catch {
      /* Absent/invalid tags must not interrupt playback. */
    }
  }
  if (id !== token) return
  useLyrics.setState({ path, text, source })
}

/** 用户选择一个 LRC 文件，作为该曲目的歌词保存。 */
export async function importLyricsFor(path: string): Promise<boolean> {
  const [file] = await window.jap.openLyricsFiles()
  if (!file) return false
  return setLyricsFromFile(path, file)
}

export async function setLyricsFromFile(path: string, file: string): Promise<boolean> {
  const bytes = await window.jap.readFile(file)
  if (!bytes) return false
  await window.jap.lyricsSet(path, bytes)
  await loadLyrics(path)
  return true
}

export async function clearImportedLyrics(path: string): Promise<void> {
  await window.jap.lyricsSet(path, null)
  await loadLyrics(path)
}
