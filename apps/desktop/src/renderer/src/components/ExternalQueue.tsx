import { ui, useLocale } from '../i18n'
import { useState } from 'react'
import { useExternal, setExternalMode } from '../external/store'
import { engine } from '../engine/client'
import { usePlayer } from '../engine/store'
import { Select } from '../ui/Select'
import { Play, MagnifyingGlass } from '../icons'
import { formatTime } from '../lib/format'

export function ExternalQueue({ onLocal }: { onLocal: () => void }): React.JSX.Element {
  useLocale()
  const queue = useExternal(s => s.snapshot?.queue)
  const trackId = useExternal(s => s.snapshot?.track.id)
  const mode = useExternal(s => s.snapshot?.mode)
  const [filter, setFilter] = useState('')
  return ui(<section className="flex min-h-0 flex-col gap-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0"><h3 className="truncate text-base font-semibold" translate={queue?.name && queue.name !== '网易云播放队列' ? 'no' : undefined}>{queue?.name || '网易云播放队列'}</h3><p className="mt-1 text-xs text-fg-muted">网易云负责切歌，列表与播放模式实时同步。</p></div>
      <button className="rounded-xl bg-hover px-3 py-2 text-xs" onClick={onLocal}>本地播放列表</button>
    </div>
    <div className="flex items-center gap-3">
      <label className="flex min-w-0 flex-1 items-center gap-2 rounded-xl bg-hover px-3 py-2"><MagnifyingGlass size={16}/><input className="min-w-0 w-full bg-transparent text-sm outline-none" placeholder="搜索队列" value={filter} onChange={e => setFilter(e.target.value)}/></label>
      <Select aria-label="网易云播放模式" value={mode ?? 'all'} onChange={e => setExternalMode(e.target.value)} className="rounded-xl bg-hover p-2 text-xs">
        <option value="off">顺序播放</option><option value="all">列表循环</option><option value="one">单曲循环</option><option value="shuffle">随机播放</option>
        {mode === 'fm' && <option value="fm">私人漫游</option>}{mode === 'ai' && <option value="ai">心动模式</option>}
      </Select>
    </div>
    <div className="max-h-[50vh] min-h-20 overflow-y-auto overscroll-contain" role="list" aria-label="网易云播放队列">
      {queue?.items.map((item, index) => ({item,index})).filter(({item}) => `${item.title} ${item.artist} ${item.album}`.toLowerCase().includes(filter.toLowerCase())).map(({item,index}) => ui(<button type="button" role="listitem" key={`${item.id}-${index}`} className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-hover ${trackId === item.id ? 'bg-accent/10 text-accent-text' : ''}`} onClick={() => void engine.external('playIndex',index).catch(error => usePlayer.setState({error:String(error)}))}>
        <span className="w-6 shrink-0 text-center text-xs text-fg-subtle">{trackId === item.id ? <Play size={16}/> : index+1}</span>
        <span className="min-w-0 flex-1" translate="no"><span className="block truncate text-sm">{item.title || item.id}</span><span className="mt-1 block truncate text-xs text-fg-muted">{item.artist} {item.album && `· ${item.album}`}</span></span>
        <span className="text-xs tabular-nums text-fg-subtle">{formatTime(item.durationMs)}</span>
      </button>))}
      {!queue?.items.length && <p className="p-5 text-sm text-fg-muted">客户端暂未提供播放队列。</p>}
    </div>
    <p className="text-xs text-fg-subtle">{queue?.total ?? 0} 首{queue?.truncated ? ' · 显示前 2000 首' : ''}</p>
  </section>)
}
