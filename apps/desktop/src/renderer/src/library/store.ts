import { baseName, pathKey } from '@shared/audio'
import { create } from 'zustand'
import { stripExtension } from '../lib/text'
import { siblingKey, formatRank } from './quality'

export type RepeatMode = 'off' | 'all' | 'one'
export type SortKey = 'title' | 'artist' | 'album' | 'duration' | 'path' | 'added'

export interface TrackItem {
  qualityRank?: number
  codec?: string
  sampleRate?: number
  bits?: number | null
  id: string
  path: string
  title: string | null
  artist: string | null
  album: string | null
  durationMs: number | null
  addedAt: number
  /** 文件已不存在。 */
  missing: boolean
  /** 元数据已经探测过（即使失败也置位，避免反复重试）。 */
  metaLoaded: boolean
}

export interface Playlist {
  id: string
  name: string
  items: TrackItem[]
}

/** 当前播放的上下文：从哪个列表、按什么顺序播放。 */
export interface Playback {
  listId: string
  /** 播放顺序，存的是条目 id；随机模式下与列表顺序不同。 */
  order: string[]
  index: number
}

export interface SavedLibrary {
  version: 1 | 2
  activeListId: string
  repeat: RepeatMode
  shuffle: boolean
  lists: Playlist[]
  memories?: Record<string, PlaybackMemory>
}
export interface PlaybackMemory {
  itemId: string
  positionMs: number
  order: string[]
}

export const DEFAULT_LIST_NAME = '默认列表'

export const newId = (): string => crypto.randomUUID()

export function makeItem(path: string, meta: Partial<TrackItem> = {}): TrackItem {
  return {
    id: newId(),
    path,
    title: null,
    artist: null,
    album: null,
    durationMs: null,
    addedAt: Date.now(),
    missing: false,
    metaLoaded: false,
    ...meta
  }
}

export function makeList(name: string, items: TrackItem[] = []): Playlist {
  return { id: newId(), name, items }
}

export function displayTitle(item: TrackItem): string {
  return item.title ?? stripExtension(baseName(item.path))
}

export interface LibraryState {
  lists: Playlist[]
  activeListId: string
  repeat: RepeatMode
  shuffle: boolean
  /** 当前列表里选中的条目 id。 */
  selected: string[]
  filter: string
  loaded: boolean
  playback: Playback | null
  memories: Record<string, PlaybackMemory>
}

interface LibraryActions {
  hydrate: (saved: SavedLibrary | null) => void
  setActive: (id: string) => void
  createList: (name?: string) => string
  renameList: (id: string, name: string) => void
  deleteList: (id: string) => void
  duplicateList: (id: string) => void
  importList: (list: Playlist) => void
  /** 添加路径到列表，跳过已经在该列表里的路径；返回新条目的 id。 */
  addPaths: (listId: string, paths: string[]) => string[]
  removeItems: (listId: string, ids: string[]) => void
  moveItem: (listId: string, from: number, to: number) => void
  transferItems: (ids: string[], fromListId: string, toListId: string, copy: boolean) => void
  clearList: (listId: string) => void
  sortList: (listId: string, key: SortKey, desc: boolean) => void
  /** 去掉重复条目（同一路径，或标题、艺人、时长都相同）；返回移除的数量。 */
  dedupeList: (listId: string) => number
  shuffleList: (listId: string) => void
  applyMeta: (path: string, patch: Partial<TrackItem>) => void
  setMissing: (missing: Record<string, boolean>) => void
  setSelected: (ids: string[]) => void
  setFilter: (text: string) => void
  setRepeat: (mode: RepeatMode) => void
  setShuffle: (on: boolean) => void
  setPlayback: (playback: Playback | null) => void
  rememberPosition: (positionMs: number) => void
}

export type LibraryStore = LibraryState & LibraryActions

export function activeListOf(state: Pick<LibraryState, 'lists' | 'activeListId'>): Playlist {
  return state.lists.find((l) => l.id === state.activeListId) ?? state.lists[0]!
}

const DEFAULT_LISTS = (): { lists: Playlist[]; activeListId: string } => {
  const list = makeList(DEFAULT_LIST_NAME)
  return { lists: [list], activeListId: list.id }
}

function sortValue(item: TrackItem, key: SortKey): string | number {
  switch (key) {
    case 'title':
      return displayTitle(item).toLowerCase()
    case 'artist':
      return (item.artist ?? '').toLowerCase()
    case 'album':
      return (item.album ?? '').toLowerCase()
    case 'duration':
      return item.durationMs ?? 0
    case 'path':
      return item.path.toLowerCase()
    case 'added':
      return item.addedAt
  }
}

export const useLibrary = create<LibraryStore>((set, get) => {
  const mapList = (id: string, fn: (items: TrackItem[]) => TrackItem[]): void =>
    set((s) => ({ lists: s.lists.map((l) => (l.id === id ? { ...l, items: fn(l.items) } : l)) }))

  return {
    ...DEFAULT_LISTS(),
    repeat: 'all',
    shuffle: false,
    selected: [],
    filter: '',
    loaded: false,
    playback: null,
    memories: {},

    hydrate: (saved) => {
      if (saved && saved.lists.length > 0) {
        const active = saved.lists.some((l) => l.id === saved.activeListId)
          ? saved.activeListId
          : saved.lists[0]!.id
        set({
          lists: saved.lists,
          activeListId: active,
          repeat: saved.repeat,
          shuffle: saved.shuffle,
          memories: Object.fromEntries(
            Object.entries(saved.memories ?? {}).filter(
              ([id, memory]) =>
                memory &&
                typeof memory === 'object' &&
                saved.lists.some(
                  (l) => l.id === id && l.items.some((i) => i.id === memory.itemId)
                ) &&
                Number.isFinite(memory.positionMs) &&
                memory.positionMs >= 0 &&
                Array.isArray(memory.order) &&
                memory.order.every((i) => typeof i === 'string')
            )
          ),
          loaded: true
        })
      } else {
        set({ ...DEFAULT_LISTS(), loaded: true })
      }
    },

    setActive: (id) => set({ activeListId: id, selected: [], filter: '' }),

    createList: (name = '新列表') => {
      const list = makeList(name)
      set((s) => ({ lists: [...s.lists, list], activeListId: list.id, selected: [] }))
      return list.id
    },

    renameList: (id, name) => {
      const trimmed = name.trim()
      if (!trimmed) return
      set((s) => ({ lists: s.lists.map((l) => (l.id === id ? { ...l, name: trimmed } : l)) }))
    },

    deleteList: (id) => {
      const { lists, activeListId } = get()
      if (lists.length <= 1) return
      const remaining = lists.filter((l) => l.id !== id)
      set({
        lists: remaining,
        activeListId: id === activeListId ? remaining[0]!.id : activeListId,
        selected: []
      })
    },

    duplicateList: (id) => {
      const source = get().lists.find((l) => l.id === id)
      if (!source) return
      const copy = makeList(
        `${source.name} 副本`,
        source.items.map((i) => ({ ...i, id: newId() }))
      )
      set((s) => ({ lists: [...s.lists, copy], activeListId: copy.id, selected: [] }))
    },

    importList: (list) => {
      set((s) => ({ lists: [...s.lists, list], activeListId: list.id, selected: [] }))
    },

    addPaths: (listId, paths) => {
      const list = get().lists.find((l) => l.id === listId)
      if (!list) return []
      const existing = new Set(list.items.map((i) => pathKey(i.path)))
      // Import selection already compared same-folder variants. Replace in place
      // to preserve item ID, selection and playback order when a better file wins.
      const replacements = new Map(paths.map((p) => [siblingKey(p), p]))
      mapList(listId, (items) =>
        items.map((item) => {
          const path = replacements.get(siblingKey(item.path))
          if (!path || path === item.path) return item
          existing.add(pathKey(path))
          return { ...makeItem(path), id: item.id, addedAt: item.addedAt }
        })
      )
      const added: TrackItem[] = []
      for (const path of paths) {
        const key = pathKey(path)
        if (existing.has(key)) continue
        existing.add(key)
        added.push(makeItem(path))
      }
      if (added.length > 0) mapList(listId, (items) => [...items, ...added])
      return added.map((i) => i.id)
    },

    removeItems: (listId, ids) => {
      const drop = new Set(ids)
      mapList(listId, (items) => items.filter((i) => !drop.has(i.id)))
      set((s) => ({ selected: s.selected.filter((id) => !drop.has(id)) }))
    },

    moveItem: (listId, from, to) => {
      mapList(listId, (items) => {
        if (from === to || from < 0 || from >= items.length) return items
        const next = [...items]
        const [moved] = next.splice(from, 1)
        if (!moved) return items
        next.splice(Math.max(0, Math.min(to, next.length)), 0, moved)
        return next
      })
    },

    transferItems: (ids, fromListId, toListId, copy) => {
      if (fromListId === toListId) return
      const from = get().lists.find((l) => l.id === fromListId)
      if (!from) return
      const picked = from.items.filter((i) => ids.includes(i.id))
      const existing = new Set(
        (get().lists.find((l) => l.id === toListId)?.items ?? []).map((i) => pathKey(i.path))
      )
      const incoming = picked
        .filter((i) => !existing.has(pathKey(i.path)))
        .map((i) => ({ ...i, id: newId() }))
      mapList(toListId, (items) => [...items, ...incoming])
      if (!copy) get().removeItems(fromListId, ids)
    },

    clearList: (listId) => {
      mapList(listId, () => [])
      set({ selected: [] })
    },

    sortList: (listId, key, desc) => {
      mapList(listId, (items) =>
        [...items].sort((a, b) => {
          const va = sortValue(a, key)
          const vb = sortValue(b, key)
          const order =
            typeof va === 'number' && typeof vb === 'number'
              ? va - vb
              : String(va).localeCompare(String(vb), undefined, { numeric: true })
          return desc ? -order : order
        })
      )
    },

    dedupeList: (listId) => {
      const before = get().lists.find((l) => l.id === listId)?.items.length ?? 0
      mapList(listId, (items) => {
        const groups = new Map<string, TrackItem>()
        for (const item of items) {
          // Different folders/performances are never removed just for matching tags.
          const key = siblingKey(item.path),
            previous = groups.get(key)
          const rank = (v: TrackItem): number => v.qualityRank ?? formatRank(v.path)
          if (
            !previous ||
            rank(item) > rank(previous) ||
            (rank(item) === rank(previous) && item.path.localeCompare(previous.path) < 0)
          )
            groups.set(key, item)
        }
        return [...groups.values()]
      })
      const after = get().lists.find((l) => l.id === listId)?.items.length ?? 0
      return before - after
    },

    shuffleList: (listId) => {
      mapList(listId, (items) => {
        const next = [...items]
        for (let i = next.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1))
          ;[next[i], next[j]] = [next[j]!, next[i]!]
        }
        return next
      })
    },

    applyMeta: (path, patch) => {
      const key = pathKey(path)
      set((s) => ({
        lists: s.lists.map((l) =>
          l.items.some((i) => pathKey(i.path) === key)
            ? {
                ...l,
                items: l.items.map((i) => (pathKey(i.path) === key ? { ...i, ...patch } : i))
              }
            : l
        )
      }))
    },

    setMissing: (missing) => {
      set((s) => ({
        lists: s.lists.map((l) => ({
          ...l,
          items: l.items.map((i) => {
            const flag = missing[i.path]
            return flag === undefined || flag === i.missing ? i : { ...i, missing: flag }
          })
        }))
      }))
    },

    setSelected: (ids) => set({ selected: ids }),
    setFilter: (text) => set({ filter: text }),
    setRepeat: (mode) => set({ repeat: mode }),
    setShuffle: (on) => set({ shuffle: on }),
    setPlayback: (playback) => set({ playback }),
    rememberPosition: (positionMs) => {
      const { playback, memories } = get()
      const itemId = playback?.order[playback.index]
      if (!playback || !itemId) return
      const memory = {
        itemId,
        positionMs: Math.max(0, Math.round(positionMs)),
        order: [...playback.order]
      }
      const old = memories[playback.listId]
      if (
        old?.itemId === memory.itemId &&
        old.positionMs === memory.positionMs &&
        old.order.join() === memory.order.join()
      )
        return
      set({ memories: { ...memories, [playback.listId]: memory } })
    }
  }
})
