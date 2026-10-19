import { useMemo, useRef, useState } from 'react'
import { formatTime } from '../lib/format'
import {
  Copy,
  DownloadSimple,
  FileAudio,
  FolderSimple,
  MagnifyingGlass,
  MusicNotes,
  PencilSimple,
  Play,
  Plus,
  Shuffle,
  SlidersHorizontal,
  Trash,
  UploadSimple,
  X
} from '../icons'
import { addAudioPaths } from '../library/actions'
import { refreshMissing } from '../library/metadata'
import { exportList, importPlaylists, type ExportFormat } from '../library/io'
import { playDefaultOrResume, playItem } from '../library/playback'
import {
  activeListOf,
  displayTitle,
  useLibrary,
  type SortKey,
  type TrackItem
} from '../library/store'
import { usePlayer } from '../engine/store'
import { scanMusicFolders } from '../library/scanner'

const SORT_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'title:asc', label: '标题 A→Z' },
  { value: 'title:desc', label: '标题 Z→A' },
  { value: 'artist:asc', label: '艺人' },
  { value: 'album:asc', label: '专辑' },
  { value: 'duration:asc', label: '时长 短→长' },
  { value: 'duration:desc', label: '时长 长→短' },
  { value: 'path:asc', label: '路径' },
  { value: 'added:asc', label: '添加时间' }
]

const EXPORT_OPTIONS: readonly { value: ExportFormat; label: string }[] = [
  { value: 'm3u', label: 'M3U8 · 绝对路径' },
  { value: 'm3u-relative', label: 'M3U8 · 相对路径' },
  { value: 'json', label: 'JSON · 完整信息' }
]

const tool =
  'inline-flex items-center gap-1.5 rounded-lg bg-hover px-2.5 py-1.5 text-xs font-medium text-fg ring-1 ring-line transition-colors hover:bg-hover/70 disabled:opacity-40'

/** 播放列表：多个列表、递归添加、搜索、排序、多选、拖拽排序，以及导入导出。 */
export function PlaylistPanel(): React.JSX.Element {
  const lists = useLibrary((s) => s.lists)
  const activeId = useLibrary((s) => s.activeListId)
  const active = useMemo(() => lists.find((l) => l.id === activeId) ?? lists[0]!, [lists, activeId])
  const selected = useLibrary((s) => s.selected)
  const filter = useLibrary((s) => s.filter)
  const playingId = useLibrary((s) =>
    s.playback && s.playback.listId === active.id
      ? (s.playback.order[s.playback.index] ?? null)
      : null
  )
  const trackPlaying = usePlayer((s) => s.state === 'playing')

  const [dragId, setDragId] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const statusTimer = useRef(0)

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return active.items
    return active.items.filter((item) =>
      [displayTitle(item), item.artist, item.album, item.path].some((v) =>
        v?.toLowerCase().includes(q)
      )
    )
  }, [active.items, filter])

  const selectedSet = useMemo(() => new Set(selected), [selected])
  const totalMs = active.items.reduce((sum, item) => sum + (item.durationMs ?? 0), 0)
  const missingCount = active.items.filter((item) => item.missing).length
  const canReorder = filter.trim() === ''

  const flash = (text: string): void => {
    setStatus(text)
    window.clearTimeout(statusTimer.current)
    statusTimer.current = window.setTimeout(() => setStatus(null), 2600)
  }

  const onAddFiles = async (): Promise<void> => {
    const paths = await window.jap.openAudioFiles()
    if (paths.length) flash(`已添加 ${await addAudioPaths(paths)} 首`)
  }

  const onAddFolders = async (): Promise<void> => {
    const paths = await window.jap.openFolders()
    if (paths.length) flash(`已添加 ${await addAudioPaths(paths)} 首`)
  }

  const onImport = async (): Promise<void> => {
    const count = await importPlaylists()
    if (count) {
      flash(`已导入 ${count} 个列表`)
      if (usePlayer.getState().state !== 'playing') playDefaultOrResume()
    }
    void refreshMissing()
  }

  const onExport = async (format: ExportFormat): Promise<void> => {
    setExportOpen(false)
    if (await exportList(activeListOf(useLibrary.getState()), format)) flash('已导出')
  }

  const onSort = (value: string): void => {
    const [key, dir] = value.split(':') as [SortKey, 'asc' | 'desc']
    useLibrary.getState().sortList(active.id, key, dir === 'desc')
  }

  const onDedupe = (): void => {
    const removed = useLibrary.getState().dedupeList(active.id)
    flash(removed ? `已移除 ${removed} 首重复` : '没有重复项')
  }

  const onCheckMissing = async (): Promise<void> => {
    await refreshMissing()
    const count = activeListOf(useLibrary.getState()).items.filter((i) => i.missing).length
    flash(count ? `${count} 个文件已不存在` : '所有文件都在')
  }

  const onClear = (): void => {
    if (window.confirm(`清空「${active.name}」？`)) useLibrary.getState().clearList(active.id)
  }

  const onRemoveSelected = (): void => useLibrary.getState().removeItems(active.id, selected)

  const onPlaySelected = (): void => {
    const first = active.items.find((item) => selectedSet.has(item.id))
    if (first) playItem(active.id, first.id)
  }

  const onTransfer = (toListId: string, copy: boolean): void => {
    if (!toListId) return
    useLibrary.getState().transferItems(selected, active.id, toListId, copy)
    flash(copy ? '已复制到所选列表' : '已移动到所选列表')
  }

  const onRowClick = (e: React.MouseEvent, item: TrackItem): void => {
    const ids = visible.map((i) => i.id)
    const store = useLibrary.getState()
    if (e.shiftKey && anchor) {
      const a = ids.indexOf(anchor)
      const b = ids.indexOf(item.id)
      const [lo, hi] = a < b ? [a, b] : [b, a]
      store.setSelected(ids.slice(lo, hi + 1))
    } else if (e.ctrlKey || e.metaKey) {
      store.setSelected(
        selectedSet.has(item.id) ? selected.filter((id) => id !== item.id) : [...selected, item.id]
      )
      setAnchor(item.id)
    } else {
      store.setSelected([item.id])
      setAnchor(item.id)
    }
  }

  const onListKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Delete' && selected.length) onRemoveSelected()
    else if (e.key === 'Enter' && selected.length) onPlaySelected()
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      useLibrary.getState().setSelected(visible.map((i) => i.id))
    }
  }

  const onDropOn = (e: React.DragEvent, targetId: string): void => {
    e.preventDefault()
    e.stopPropagation()
    if (!dragId || dragId === targetId) return
    const from = active.items.findIndex((i) => i.id === dragId)
    const to = active.items.findIndex((i) => i.id === targetId)
    if (from >= 0 && to >= 0) useLibrary.getState().moveItem(active.id, from, to)
    setDragId(null)
  }

  const otherLists = lists.filter((l) => l.id !== active.id)

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center gap-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pb-0.5">
          {lists.map((list) => (
            <button
              key={list.id}
              type="button"
              onClick={() => useLibrary.getState().setActive(list.id)}
              onDoubleClick={() => {
                useLibrary.getState().setActive(list.id)
                setRenaming(true)
              }}
              className={`shrink-0 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                list.id === active.id
                  ? 'bg-accent text-on-accent'
                  : 'bg-hover text-fg-muted hover:text-fg'
              }`}
            >
              {list.name}
              <span className="ml-1.5 opacity-70">{list.items.length}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label="新建列表"
          title="新建列表"
          onClick={() => useLibrary.getState().createList()}
          className="grid size-7 shrink-0 place-items-center rounded-lg text-fg-muted hover:bg-hover hover:text-fg"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="flex items-center gap-1">
        {renaming ? (
          <input
            autoFocus
            defaultValue={active.name}
            aria-label="列表名称"
            onBlur={(e) => {
              useLibrary.getState().renameList(active.id, e.currentTarget.value)
              setRenaming(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') setRenaming(false)
            }}
            className="min-w-0 flex-1 rounded-lg bg-hover px-2.5 py-1 text-sm text-fg outline-none ring-1 ring-accent"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{active.name}</span>
        )}
        <button
          type="button"
          aria-label="重命名列表"
          title="重命名（双击列表名也可以）"
          onClick={() => setRenaming(true)}
          className="grid size-7 place-items-center rounded-lg text-fg-muted hover:bg-hover hover:text-fg"
        >
          <PencilSimple size={14} />
        </button>
        <button
          type="button"
          aria-label="复制列表"
          title="复制列表"
          onClick={() => useLibrary.getState().duplicateList(active.id)}
          className="grid size-7 place-items-center rounded-lg text-fg-muted hover:bg-hover hover:text-fg"
        >
          <Copy size={14} />
        </button>
        <button
          type="button"
          aria-label="删除列表"
          title="删除列表"
          disabled={lists.length <= 1}
          onClick={() => {
            if (window.confirm(`删除列表「${active.name}」？`))
              useLibrary.getState().deleteList(active.id)
          }}
          className="grid size-7 place-items-center rounded-lg text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-30"
        >
          <Trash size={14} />
        </button>
      </div>

      <label className="relative block">
        <MagnifyingGlass
          size={14}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle"
        />
        <input
          value={filter}
          onChange={(e) => useLibrary.getState().setFilter(e.target.value)}
          placeholder="搜索标题、艺人、专辑或路径"
          aria-label="搜索播放列表"
          className="w-full rounded-xl bg-hover py-2 pl-8 pr-3 text-sm text-fg outline-none ring-1 ring-line placeholder:text-fg-subtle focus:ring-accent"
        />
      </label>

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          className={tool}
          onClick={() => {
            void scanMusicFolders().then((n) => flash(`扫描完成 · 新增 ${n} 首`))
          }}
        >
          扫描音乐目录
        </button>
        <button type="button" className={tool} onClick={() => void onAddFiles()}>
          <FileAudio size={13} />
          添加文件
        </button>
        <button type="button" className={tool} onClick={() => void onAddFolders()}>
          <FolderSimple size={13} />
          添加文件夹
        </button>
        <button type="button" className={tool} onClick={() => void onImport()}>
          <UploadSimple size={13} />
          导入
        </button>
        <div className="relative">
          <button
            type="button"
            className={tool}
            aria-expanded={exportOpen}
            onClick={() => setExportOpen((v) => !v)}
          >
            <DownloadSimple size={13} />
            导出
          </button>
          {exportOpen && (
            <div className="glass absolute left-0 top-full z-10 mt-1 flex w-52 flex-col gap-0.5 rounded-xl p-1.5">
              {EXPORT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => void onExport(option.value)}
                  className="rounded-lg px-2.5 py-1.5 text-left text-xs text-fg hover:bg-hover"
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <details className="rounded-xl border border-line p-2">
        <summary className="cursor-pointer text-xs text-fg-muted">
          整理列表 · 排序、去重与失效检查
        </summary>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <label className={`${tool} cursor-pointer`}>
            <SlidersHorizontal size={13} />
            <select
              aria-label="排序"
              value=""
              onChange={(e) => onSort(e.target.value)}
              className="max-w-[110px] cursor-pointer bg-transparent text-xs outline-none"
            >
              <option value="" disabled>
                排序
              </option>
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} className="bg-surface text-fg">
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={tool}
            disabled={active.items.length < 2}
            onClick={() => useLibrary.getState().shuffleList(active.id)}
          >
            <Shuffle size={13} />
            打乱
          </button>
          <button
            type="button"
            className={tool}
            disabled={active.items.length < 2}
            onClick={onDedupe}
          >
            去重
          </button>
          <button
            type="button"
            className={tool}
            disabled={active.items.length === 0}
            onClick={() => void onCheckMissing()}
          >
            检查失效
          </button>
          <button
            type="button"
            className={tool}
            disabled={active.items.length === 0}
            onClick={onClear}
          >
            清空
          </button>
        </div>
      </details>
      <div className="flex justify-between px-3 text-[11px] text-fg-subtle">
        <span>双击播放 · 单击选择 · Ctrl / Shift 多选</span>
        <span>格式 / 时长</span>
      </div>

      <ul
        tabIndex={0}
        aria-label={`${active.name} 的曲目`}
        onKeyDown={onListKeyDown}
        className="min-h-0 flex-1 overflow-y-auto rounded-2xl bg-black/10 p-1.5 outline-none ring-1 ring-line focus-visible:ring-accent"
      >
        {visible.length === 0 && (
          <li className="px-3 py-8 text-center text-sm text-fg-muted">
            {active.items.length === 0
              ? '列表是空的。把文件或文件夹拖进窗口，或点击上方的添加。'
              : '没有匹配的曲目'}
          </li>
        )}
        {visible.map((item, index) => {
          const isSelected = selectedSet.has(item.id)
          const isPlaying = item.id === playingId
          return (
            <li
              key={item.id}
              draggable={canReorder}
              onDragStart={(e) => {
                setDragId(item.id)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', item.id)
              }}
              onDragOver={(e) => {
                if (dragId) e.preventDefault()
              }}
              onDrop={(e) => onDropOn(e, item.id)}
              onDragEnd={() => setDragId(null)}
              onClick={(e) => onRowClick(e, item)}
              onDoubleClick={() => playItem(active.id, item.id)}
              className={`group flex items-center gap-3 rounded-xl px-2.5 py-2 text-sm transition-colors cursor-pointer ${
                isSelected ? 'bg-accent/20 ring-1 ring-accent/40' : 'hover:bg-hover'
              } ${item.missing ? 'opacity-50' : ''} ${dragId === item.id ? 'opacity-40' : ''} ${canReorder ? 'cursor-grab' : ''}`}
            >
              <button
                type="button"
                aria-label={`播放 ${displayTitle(item)}`}
                onClick={(e) => {
                  e.stopPropagation()
                  playItem(active.id, item.id)
                }}
                className="grid size-8 shrink-0 place-items-center rounded-full font-mono text-xs text-fg-subtle hover:bg-accent/20 hover:text-accent-text"
              >
                {isPlaying && trackPlaying ? (
                  <MusicNotes size={14} weight="fill" className="text-accent-text" />
                ) : (
                  <>
                    <span className="group-hover:hidden">{index + 1}</span>
                    <Play size={12} weight="fill" className="hidden text-fg group-hover:block" />
                  </>
                )}
              </button>
              <div className="min-w-0 flex-1">
                <div
                  className={`truncate ${isPlaying ? 'font-semibold text-accent-text' : 'font-medium'}`}
                >
                  {displayTitle(item)}
                </div>
                <div className="truncate text-xs text-fg-muted">
                  {item.missing
                    ? '文件已不存在'
                    : [item.artist, item.album].filter(Boolean).join(' · ') || item.path}
                </div>
              </div>
              <span className="hidden shrink-0 rounded-lg bg-hover px-2 py-1 text-[10px] text-fg-muted sm:inline">
                {item.codec ?? item.path.split('.').pop()?.toUpperCase()}
                {item.sampleRate
                  ? ` · ${item.sampleRate > 1e6 ? (item.sampleRate / 1e6).toFixed(2) + 'M' : item.sampleRate / 1000 + 'k'}`
                  : ''}
                {item.bits ? ` / ${item.bits}b` : ''}
              </span>
              <span className="shrink-0 font-mono text-xs text-fg-subtle">
                {item.durationMs ? formatTime(item.durationMs) : ''}
              </span>
              <button
                type="button"
                aria-label={`从列表移除 ${displayTitle(item)}`}
                onClick={(e) => {
                  e.stopPropagation()
                  useLibrary.getState().removeItems(active.id, [item.id])
                }}
                className="grid size-6 shrink-0 place-items-center rounded-md text-fg-muted opacity-0 transition-opacity hover:bg-hover hover:text-fg group-hover:opacity-100"
              >
                <X size={12} />
              </button>
            </li>
          )
        })}
      </ul>

      {selected.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-xl bg-accent/15 px-2.5 py-2 ring-1 ring-accent/30">
          <span className="text-xs font-semibold">已选 {selected.length}</span>
          <button type="button" className={tool} onClick={onPlaySelected}>
            <Play size={12} weight="fill" />
            从头播放所选
          </button>
          {otherLists.length > 0 && (
            <>
              <select
                aria-label="复制到列表"
                value=""
                onChange={(e) => onTransfer(e.target.value, true)}
                className="rounded-lg bg-hover px-2 py-1.5 text-xs text-fg outline-none ring-1 ring-line"
              >
                <option value="" disabled>
                  复制到…
                </option>
                {otherLists.map((l) => (
                  <option key={l.id} value={l.id} className="bg-surface text-fg">
                    {l.name}
                  </option>
                ))}
              </select>
              <select
                aria-label="移动到列表"
                value=""
                onChange={(e) => onTransfer(e.target.value, false)}
                className="rounded-lg bg-hover px-2 py-1.5 text-xs text-fg outline-none ring-1 ring-line"
              >
                <option value="" disabled>
                  移到…
                </option>
                {otherLists.map((l) => (
                  <option key={l.id} value={l.id} className="bg-surface text-fg">
                    {l.name}
                  </option>
                ))}
              </select>
            </>
          )}
          <button type="button" className={tool} onClick={onRemoveSelected}>
            移除
          </button>
          <button
            type="button"
            className={`${tool} ml-auto`}
            onClick={() => useLibrary.getState().setSelected([])}
          >
            取消
          </button>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 text-xs text-fg-muted">
        <span>
          {visible.length === active.items.length
            ? `${active.items.length} 首`
            : `${visible.length} / ${active.items.length} 首`}
          {' · '}
          {formatTime(totalMs)}
          {missingCount > 0 && <span className="text-fg-muted"> · {missingCount} 个失效</span>}
        </span>
        {status && <span className="truncate text-accent-text">{status}</span>}
      </div>
    </div>
  )
}
