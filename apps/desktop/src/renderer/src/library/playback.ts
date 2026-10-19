import type { TrackInfo } from '@shared/protocol/TrackInfo'
import { pathKey } from '@shared/audio'
import { loadCover } from '../cover/store'
import { engine } from '../engine/client'
import { livePositionMs } from '../engine/clock'
import { usePlayer } from '../engine/store'
import { loadLyrics } from '../lyrics/store'
import { activeListOf, useLibrary, type LibraryState, type Playback, type TrackItem } from './store'

/** 超过这个位置再点“上一首”，只是回到曲首。 */
const RESTART_MS = 3000

/** 上一次发给引擎的预载路径；`undefined` 表示需要重新发送。 */
let lastQueued: string | null | undefined = undefined

function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

/**
 * 按重复模式找相邻的可播放条目。自动续播时“单曲循环”重播当前曲目；
 * 手动切歌时忽略单曲循环，按列表循环处理。跳过已经失效（文件缺失）的条目。
 */
export function findNeighbour(
  state: LibraryState,
  playback: Playback,
  dir: 1 | -1,
  auto: boolean
): { index: number; item: TrackItem } | null {
  const list = state.lists.find((l) => l.id === playback.listId)
  if (!list) return null
  const byId = new Map(list.items.map((i) => [i.id, i]))
  if (auto && dir === 1 && state.repeat === 'one') {
    const item = byId.get(playback.order[playback.index] ?? '')
    return item && !item.missing ? { index: playback.index, item } : null
  }
  const n = playback.order.length
  let i = playback.index
  for (let step = 0; step < n; step++) {
    i += dir
    if (i >= n || i < 0) {
      if (state.repeat === 'off') return null
      i = i >= n ? 0 : n - 1
    }
    const item = byId.get(playback.order[i] ?? '')
    if (item && !item.missing) return { index: i, item }
  }
  return null
}

function startPlayback(
  listId: string,
  order: string[],
  index: number,
  item: TrackItem,
  startMs = 0
): void {
  useLibrary.getState().rememberPosition(livePositionMs())
  useLibrary.getState().setPlayback({ listId, order, index })
  useLibrary.getState().rememberPosition(startMs)
  lastQueued = undefined
  usePlayer.getState().play(item.path, startMs)
}

/** The preview and Play button resolve exactly the same next item. */
export function pendingItem(state: LibraryState): TrackItem | null {
  const list = activeListOf(state)
  const selected = list.items.find((i) => state.selected.includes(i.id) && !i.missing)
  const remembered = list.items.find((i) => i.id === state.memories[list.id]?.itemId && !i.missing)
  return selected ?? remembered ?? list.items.find((i) => !i.missing) ?? null
}

/** 从列表的某一条开始播放；随机模式下这一条排在最前，其余打乱。 */
export function playItem(listId: string, itemId: string): void {
  const state = useLibrary.getState()
  const list = state.lists.find((l) => l.id === listId)
  const item = list?.items.find((i) => i.id === itemId)
  if (!list || !item) return
  const ids = list.items.map((i) => i.id)
  const order = state.shuffle ? [item.id, ...shuffled(ids.filter((id) => id !== item.id))] : ids
  startPlayback(list.id, order, order.indexOf(item.id), item)
}

export function playNeighbour(dir: 1 | -1): boolean {
  const state = useLibrary.getState()
  const playback = state.playback
  if (!playback) return false
  const next = findNeighbour(state, playback, dir, false)
  if (!next) return false
  startPlayback(playback.listId, playback.order, next.index, next.item)
  return true
}

/** 位置超过 3 秒时回到曲首，否则切到上一首。 */
export function playPrevious(): void {
  if (livePositionMs() > RESTART_MS || !playNeighbour(-1)) usePlayer.getState().seek(0)
}

/** 预载下一首，让引擎无缝衔接；只在下一首真的变化时才发送。 */
export function queueUpcoming(): void {
  const state = useLibrary.getState()
  const playback = state.playback
  const next = playback ? findNeighbour(state, playback, 1, true) : null
  const path = next?.item.path ?? null
  if (path === lastQueued) return
  lastQueued = path
  engine.send({ type: 'queueNext', path })
}

/** 列表被改动（增删、排序、元数据回填）后，让播放顺序与列表保持一致。 */
export function syncPlayback(): void {
  const state = useLibrary.getState()
  const playback = state.playback
  if (!playback) return
  const list = state.lists.find((l) => l.id === playback.listId)
  if (!list) {
    state.setPlayback(null)
    return
  }
  const current = playback.order[playback.index]
  const ids = list.items.map((i) => i.id)
  const order = state.shuffle
    ? [
        ...playback.order.filter((id) => ids.includes(id)),
        ...ids.filter((id) => !playback.order.includes(id))
      ]
    : ids
  const index = current === undefined ? -1 : order.indexOf(current)
  const same =
    index === playback.index &&
    order.length === playback.order.length &&
    order.every((id, i) => id === playback.order[i])
  if (!same) state.setPlayback({ listId: playback.listId, order, index })
  queueUpcoming()
}

/** 随机模式切换：当前曲目保留在最前面，其余重新排序。 */
export function onShuffleChanged(on: boolean): void {
  const state = useLibrary.getState()
  const playback = state.playback
  if (!playback) return
  const list = state.lists.find((l) => l.id === playback.listId)
  if (!list) return
  const current = playback.order[playback.index]
  const ids = list.items.map((i) => i.id)
  if (on) {
    const rest = ids.filter((id) => id !== current)
    const order = current === undefined ? shuffled(ids) : [current, ...shuffled(rest)]
    state.setPlayback({ listId: list.id, order, index: current === undefined ? -1 : 0 })
  } else {
    state.setPlayback({
      listId: list.id,
      order: ids,
      index: current === undefined ? -1 : ids.indexOf(current)
    })
  }
  queueUpcoming()
}

/** 引擎开始播放新曲目：对齐播放位置，刷新元数据、封面与歌词。 */
export function onTrackChanged(track: TrackInfo): void {
  const state = useLibrary.getState()
  const playback = state.playback
  const path = pathKey(track.path)
  if (playback) {
    const list = state.lists.find((l) => l.id === playback.listId)
    const byId = new Map(list?.items.map((i) => [i.id, i]) ?? [])
    const current = byId.get(playback.order[playback.index] ?? '')
    if (!current || pathKey(current.path) !== path) {
      const found = playback.order.findIndex((id) => pathKey(byId.get(id)?.path ?? '') === path)
      state.setPlayback(found >= 0 ? { ...playback, index: found } : null)
    }
  }
  lastQueued = undefined
  state.applyMeta(track.path, {
    title: track.title,
    artist: track.artist,
    album: track.album,
    durationMs: track.durationMs,
    metaLoaded: true
  })
  queueUpcoming()
  void loadCover(track.path)
  void loadLyrics(track.path)
}

/** 智能起播或暂停：若已在播放则暂停/恢复；若停止且未选曲目，自动从当前列表首曲（或已选项）起播。 */
export function playDefaultOrResume(): void {
  const player = usePlayer.getState()
  if (player.state === 'playing') {
    player.togglePause()
    return
  }
  if (player.state === 'paused') {
    player.togglePause()
    return
  }
  const state = useLibrary.getState()
  const list = activeListOf(state)
  if (!list || list.items.length === 0) {
    if (player.track) player.play(player.track.path)
    return
  }
  const item = pendingItem(state)
  if (!item) return
  const memory = state.memories[list.id]
  if (memory?.itemId !== item.id) {
    playItem(list.id, item.id)
    return
  }
  const ids = list.items.map((i) => i.id)
  const order = state.shuffle
    ? [
        ...memory.order.filter((id) => ids.includes(id)),
        ...ids.filter((id) => !memory.order.includes(id))
      ]
    : ids
  const position =
    item.durationMs !== null && memory.positionMs >= item.durationMs - 500 ? 0 : memory.positionMs
  startPlayback(list.id, order, order.indexOf(item.id), item, position)
}
