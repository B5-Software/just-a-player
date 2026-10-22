import { isDiscImage, pathKey } from '@shared/audio'
import type { TrackInfo } from '@shared/protocol/TrackInfo'
import { engine } from '../engine/client'
import { usePlayer } from '../engine/store'
import { makeItem, type TrackItem } from './store'
import { importRank } from './quality'

export function trackMeta(track: TrackInfo): Partial<TrackItem> {
  return {
    title: track.title,
    artist: track.artist,
    album: track.album,
    durationMs: track.durationMs,
    codec: track.codec,
    sampleRate: track.format.sampleRate,
    bits: track.format.bits,
    qualityRank: importRank(track),
    metaLoaded: true,
  }
}
export async function expandDiscs(
  paths: string[],
  reportErrors = true
): Promise<{ paths: string[]; tracks: TrackInfo[] }> {
  const out: string[] = [],
    tracks: TrackInfo[] = [],
    seen = new Set<string>()
  for (const path of paths) {
    let expanded = [path]
    if (isDiscImage(path)) {
      const response = await engine.query({ type: 'discTracks', path })
      if (response.type !== 'tracks') {
        if (reportErrors)
          usePlayer.setState({
            error: response.type === 'error' ? response.message : '无法读取光盘曲目目录',
          })
        continue
      }
      expanded = response.tracks.map((t) => t.path)
      tracks.push(...response.tracks)
    }
    for (const item of expanded)
      if (!seen.has(pathKey(item))) {
        seen.add(pathKey(item))
        out.push(item)
      }
  }
  return { paths: out, tracks }
}
/** Upgrade whole-disc entries from older versions and imported playlists in place. */
export async function expandDiscItems(items: TrackItem[]): Promise<TrackItem[]> {
  const out: TrackItem[] = [],
    seen = new Set<string>()
  for (const item of items) {
    if (!isDiscImage(item.path)) {
      if (!seen.has(pathKey(item.path))) {
        seen.add(pathKey(item.path))
        out.push(item)
      }
      continue
    }
    const response = await engine.query({ type: 'discTracks', path: item.path })
    if (response.type !== 'tracks') {
      out.push(item)
      continue
    }
    response.tracks.forEach((track, index) => {
      if (seen.has(pathKey(track.path))) return
      seen.add(pathKey(track.path))
      out.push(
        makeItem(track.path, {
          ...trackMeta(track),
          ...(index === 0 ? { id: item.id } : {}),
          addedAt: item.addedAt,
        })
      )
    })
  }
  return out
}
