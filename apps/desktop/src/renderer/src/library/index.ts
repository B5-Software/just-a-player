import { loadCover, clearCoverCache, useCover } from '../cover/store'
import { engine } from '../engine/client'
import { usePlayer } from '../engine/store'
import { livePositionMs } from '../engine/clock'
import { useLyrics, loadLyrics } from '../lyrics/store'
import { useSettings } from '../settings/store'
import { DEFAULT_LIST_NAME, makeList, useLibrary, type SavedLibrary } from './store'
import {
  onShuffleChanged,
  onTrackChanged,
  pendingItem,
  playNeighbour,
  queueUpcoming,
  syncPlayback
} from './playback'
import { refreshMissing, requestMetadata } from './metadata'

let saveTimer = 0

function serialize(): string {
  const state = useLibrary.getState()
  const remember = useSettings.getState().rememberPlaylist
  const data: SavedLibrary = {
    version: 2,
    activeListId: state.activeListId,
    repeat: state.repeat,
    shuffle: state.shuffle,
    // 关闭“记住播放列表”时只落盘一个空列表，本次会话内的列表保留在内存里
    lists: remember ? state.lists : [makeList(DEFAULT_LIST_NAME)],
    memories: remember ? state.memories : {}
  }
  return JSON.stringify(data)
}

function schedulePersist(): void {
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    saveTimer = 0
    void window.jap.librarySave(serialize())
  }, 400)
}
function previewUpcoming(): void {
  const path = pendingItem(useLibrary.getState())?.path ?? null
  if (!usePlayer.getState().track && path !== useCover.getState().path) void loadCover(path)
}

async function loadSaved(): Promise<void> {
  let saved: SavedLibrary | null = null
  if (useSettings.getState().rememberPlaylist) {
    const raw = await window.jap.libraryLoad()
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<SavedLibrary>
        if (Array.isArray(parsed.lists)) saved = parsed as SavedLibrary
      } catch {
        saved = null
      }
    }
  }
  useLibrary.getState().hydrate(saved)
}

/** 启动播放列表：加载持久化数据、接上引擎事件，并保持播放顺序、元数据与持久化同步。 */
export function initLibrary(): void {
  engine.onEvent((event) => {
    if (event.type === 'trackChanged') onTrackChanged(event.track)
    if (event.type === 'queueEnded') playNeighbour(1)
    if (event.type === 'position') useLibrary.getState().rememberPosition(event.positionMs)
    if (event.type === 'state' && event.state !== 'playing' && useLibrary.getState().loaded) {
      useLibrary.getState().rememberPosition(livePositionMs())
      schedulePersist()
    }
  })

  useLibrary.subscribe((state, prev) => {
    if (!state.loaded) return
    if (state.lists !== prev.lists) {
      syncPlayback()
      requestMetadata()
    }
    if (
      state.lists !== prev.lists ||
      state.activeListId !== prev.activeListId ||
      state.repeat !== prev.repeat ||
      state.shuffle !== prev.shuffle
    ) {
      schedulePersist()
    }
    if (state.memories !== prev.memories && !saveTimer) {
      saveTimer = window.setTimeout(() => {
        saveTimer = 0
        void window.jap.librarySave(serialize())
      }, 5000)
    }
    if (
      state.activeListId !== prev.activeListId ||
      state.selected !== prev.selected ||
      state.lists !== prev.lists ||
      state.loaded !== prev.loaded
    )
      previewUpcoming()
    if (state.shuffle !== prev.shuffle) onShuffleChanged(state.shuffle)
    if (state.repeat !== prev.repeat) queueUpcoming()
  })

  useSettings.subscribe((state, prev) => {
    if (state.rememberPlaylist !== prev.rememberPlaylist) schedulePersist()
    if (state.sidecarCover !== prev.sidecarCover) {
      clearCoverCache()
      void loadCover(useCover.getState().path)
    }
    if (state.sidecarLyrics !== prev.sidecarLyrics) void loadLyrics(useLyrics.getState().path)
  })

  void loadSaved().then(() => {
    previewUpcoming()
    requestMetadata()
    void refreshMissing()
  })
  window.addEventListener('beforeunload', () => {
    if (!useLibrary.getState().loaded) return
    useLibrary.getState().rememberPosition(livePositionMs())
    window.jap.libraryFlush(serialize())
  })
}
