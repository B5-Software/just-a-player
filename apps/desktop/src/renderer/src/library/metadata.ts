import { engine } from '../engine/client'
import { useLibrary } from './store'
import { importRank } from './quality'

/** 元数据探测是后台串行进行的：一次只读一个文件，不抢占界面和播放。 */
const queue: string[] = []
const queued = new Set<string>()
let running = false

export function requestMetadata(): void {
  for (const list of useLibrary.getState().lists) {
    for (const item of list.items) {
      if (item.metaLoaded || item.missing || queued.has(item.path)) continue
      queued.add(item.path)
      queue.push(item.path)
    }
  }
  void pump()
}

async function pump(): Promise<void> {
  if (running) return
  running = true
  try {
    while (queue.length > 0) {
      const path = queue.shift()!
      queued.delete(path)
      const response = await engine.query({ type: 'probeTrack', path })
      if (response.type === 'track') {
        const track = response.track
        useLibrary.getState().applyMeta(path, {
          title: track.title,
          artist: track.artist,
          album: track.album,
          durationMs: track.durationMs,
          metaLoaded: true,
          qualityRank: importRank(track),
          codec: track.codec,
          sampleRate: track.format.sampleRate,
          bits: track.format.bits
        })
      } else {
        useLibrary.getState().applyMeta(path, { metaLoaded: true })
      }
    }
  } finally {
    running = false
  }
}

/** 检查列表里的文件是否还在，缺失的标记出来。 */
export async function refreshMissing(): Promise<void> {
  const paths = [...new Set(useLibrary.getState().lists.flatMap((l) => l.items.map((i) => i.path)))]
  if (paths.length === 0) return
  const exists = await window.jap.pathsExist(paths)
  const missing: Record<string, boolean> = {}
  paths.forEach((path, i) => {
    missing[path] = !exists[i]
  })
  useLibrary.getState().setMissing(missing)
}
