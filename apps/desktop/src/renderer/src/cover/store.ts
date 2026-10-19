import { create } from 'zustand'
import { engine } from '../engine/client'
import { useSettings } from '../settings/store'
import { renderBackdrop } from './backdrop'
import { extractPalette, type CoverPalette } from './palette'

export interface CoverArt {
  url: string
  mime: string
}

interface CoverEntry {
  art: CoverArt | null
  palette: CoverPalette | null
  backdrop: HTMLCanvasElement | null
}

interface CoverState extends CoverEntry {
  /** 当前封面所属的曲目路径。 */
  path: string | null
}

export const useCover = create<CoverState>(() => ({
  path: null,
  art: null,
  palette: null,
  backdrop: null
}))

const CACHE_LIMIT = 40
const cache = new Map<string, CoverEntry>()
/** 切歌很快时，只让最后一次请求落地。 */
let token = 0

function remember(path: string, entry: CoverEntry): void {
  cache.delete(path)
  cache.set(path, entry)
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    const evicted = cache.get(oldest)
    if (evicted?.art) URL.revokeObjectURL(evicted.art.url)
    cache.delete(oldest)
  }
}

/** 设置变化（如关闭同目录封面）后，下一次加载要重新读取。 */
export function clearCoverCache(): void {
  for (const entry of cache.values()) {
    if (entry.art) URL.revokeObjectURL(entry.art.url)
  }
  cache.clear()
}

async function fetchCover(path: string): Promise<{ mime: string; data: Uint8Array } | null> {
  const embedded = await engine.cover(path)
  if (embedded) return embedded
  if (!useSettings.getState().sidecarCover) return null
  return window.jap.sidecarCover(path)
}

function decodeImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('封面解码失败'))
    image.src = url
  })
}

/** 加载曲目封面（内嵌优先，其次同目录图片），同时算出取色与模糊背景。 */
export async function loadCover(path: string | null): Promise<void> {
  const id = ++token
  if (!path) {
    useCover.setState({ path: null, art: null, palette: null, backdrop: null })
    return
  }
  const cached = cache.get(path)
  if (cached) {
    remember(path, cached)
    useCover.setState({ path, ...cached })
    return
  }

  // Retain the last image and palette until the new cover has decoded.
  useCover.setState({ path })
  let entry: CoverEntry = { art: null, palette: null, backdrop: null }
  try {
    const payload = await fetchCover(path)
    if (payload) {
      const url = URL.createObjectURL(new Blob([payload.data as BlobPart], { type: payload.mime }))
      const image = await decodeImage(url)
      entry = {
        art: { url, mime: payload.mime },
        palette: extractPalette(image),
        backdrop: renderBackdrop(image)
      }
    }
  } catch (error) {
    console.warn('[cover] 封面加载失败', error)
  }
  remember(path, entry)
  if (id === token) useCover.setState({ path, ...entry })
}
