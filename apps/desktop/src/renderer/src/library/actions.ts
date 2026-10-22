import { usePlayer } from '../engine/store'
import { useSettings } from '../settings/store'
import { playItem } from './playback'
import { refreshMissing } from './metadata'
import { activeListOf, useLibrary } from './store'
import { siblingKey, importRank } from './quality'
import { expandDiscs, trackMeta } from './discs'

/**
 * 把文件或文件夹加入当前列表（文件夹按设置递归展开）。
 * 未在播放时或 `play` 为真时，自动开播第一首新加入的曲目。
 */
export async function addAudioPaths(
  paths: string[],
  play?: boolean,
  targetId?: string,
  background = false
): Promise<number> {
  const listId = targetId ?? activeListOf(useLibrary.getState()).id
  const expanded = await expandDiscs(
    await window.jap.scanAudio(paths, useSettings.getState().recursiveScan),
    !background
  )
  const candidates = expanded.paths
  const groups = new Map<string, string[]>()
  for (const path of candidates) {
    const key = siblingKey(path)
    groups.set(key, [...(groups.get(key) ?? []), path])
  }
  const audio: string[] = []
  const ranks = new Map<string, number>()
  const current = useLibrary.getState().lists.find((l) => l.id === listId)
  if (!current) return 0
  for (const [key, group] of groups) {
    const siblings = [
      ...new Set([
        ...group,
        ...current.items.filter((i) => siblingKey(i.path) === key).map((i) => i.path),
      ]),
    ]
    if (siblings.length === 1) {
      audio.push(siblings[0]!)
      continue
    }
    const scored: { path: string; rank: number }[] = []
    for (const path of siblings) {
      const info = await usePlayer.getState().probe(path)
      scored.push({ path, rank: info ? importRank(info) : -1 })
    }
    scored.sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path))
    if (scored[0]) {
      audio.push(scored[0].path)
      ranks.set(scored[0].path, scored[0].rank)
    }
  }
  if (audio.length === 0) return 0
  const state = useLibrary.getState()
  const added = state.addPaths(listId, audio)
  for (const track of expanded.tracks) useLibrary.getState().applyMeta(track.path, trackMeta(track))
  for (const [path, qualityRank] of ranks) useLibrary.getState().applyMeta(path, { qualityRank })
  void refreshMissing()
  const shouldPlay = play ?? usePlayer.getState().state !== 'playing'
  if (shouldPlay) {
    const firstId =
      added[0] ??
      useLibrary
        .getState()
        .lists.find((l) => l.id === listId)
        ?.items.find((i) => i.path === audio[0])?.id
    if (firstId) playItem(listId, firstId)
  }
  return added.length
}
