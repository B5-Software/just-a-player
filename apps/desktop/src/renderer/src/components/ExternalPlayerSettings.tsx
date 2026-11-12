import { ui, useLocale } from '../i18n'
import { useEffect, useId, useRef, useState } from 'react'
import { SectionTitle, SettingRow, Toggle } from '../ui/controls'
import { useExternal } from '../external/store'
import { engine } from '../engine/client'
import { usePlayer } from '../engine/store'
import { MusicNotes, Pause, Play, SkipBack, SkipForward } from '../icons'
import { formatTime } from '../lib/format'
import type { ExternalAction } from '@shared/external-player'
import { externalPosition } from '@shared/external-player'

export function ExternalPlayerSettings(): React.JSX.Element | null {
  useLocale()
  const state = useExternal()
  const [busy, setBusy] = useState(false)
  const [force, setForce] = useState(() => localStorage.getItem('jap.external.force') === '1')
  const routeHintId = useId()
  const system = state.source === 'system-media'
  const artwork = system ? state.cover : null
  const image = useRef<HTMLImageElement>(null)
  useEffect(() => {
    if (!artwork || !image.current) return
    const url = URL.createObjectURL(new Blob([artwork.data as BlobPart], { type: artwork.mime }))
    image.current.src = url
    return () => URL.revokeObjectURL(url)
  }, [artwork])
  if (window.jap.platform !== 'win32') return null
  const connected = state.phase === 'ready' || state.phase === 'routing'
  const run = async (action: ExternalAction): Promise<void> => {
    setBusy(true)
    try { await engine.external(action, undefined, force) }
    catch (error) { usePlayer.setState({ error: String(error) }) }
    finally { setBusy(false) }
  }
  const media = system ? state.snapshot : null
  const playing = media?.state === 'playing'
  const PlayPause = playing ? Pause : Play
  const control = 'grid size-9 place-items-center rounded-xl bg-hover text-fg hover:bg-accent/15 disabled:opacity-40'
  const routeHint = state.snapshot?.deviceError
    ? '暂时无法读取客户端输出设备。'
    : !state.snapshot?.devices
      ? '正在等待客户端返回输出设备列表。'
      : externalPosition(state.snapshot) === undefined
        ? '客户端播放进度暂不可用，请稍后重试'
        : ''
  return (
    ui(<section className="flex flex-col gap-4 rounded-2xl border border-line bg-hover/40 p-4">
      <SectionTitle>外部播放器 · 网易云音乐</SectionTitle>
      <SettingRow title="系统媒体同步" hint="通过 Windows 同步播放详情和控制，音频由网易云播放。">
        <Toggle label="系统媒体同步" checked={system} disabled={busy || state.phase === 'connecting' || (connected && !system)} onChange={on => { void run(on ? 'connectSystem' : 'disconnect') }} />
      </SettingRow>
      {media && <div className="grid gap-3 rounded-xl bg-panel/60 p-3">
        <div className="flex min-w-0 items-center gap-3">
          {artwork ? <img ref={image} className="size-12 shrink-0 rounded-lg object-cover" alt="" /> : <div className="grid size-12 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent-text"><MusicNotes size={20} /></div>}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium" translate="no">{media.track.title}</p>
            <p className="truncate text-xs text-fg-muted" translate="no">{[media.track.artist, media.track.album].filter(Boolean).join(' · ')}</p>
          </div>
          {media.track.durationMs > 0 && <span className="shrink-0 font-mono text-xs text-fg-muted">{formatTime(media.positionMs)} / {formatTime(media.track.durationMs)}</span>}
        </div>
        <div className="flex gap-2">
          <button type="button" className={control} aria-label="上一首" disabled={busy || !state.controls?.previous} onClick={() => { void run('previous') }}><SkipBack size={17} /></button>
          <button type="button" className={control} aria-label={playing ? '暂停' : '播放'} disabled={busy || !(playing ? state.controls?.pause : state.controls?.play)} onClick={() => { void run(playing ? 'pause' : 'resume') }}><PlayPause size={17} /></button>
          <button type="button" className={control} aria-label="下一首" disabled={busy || !state.controls?.next} onClick={() => { void run('next') }}><SkipForward size={17} /></button>
        </div>
      </div>}
      <SettingRow title="连接客户端" hint="添加专用黑洞设备；原始音频、歌词、封面和控制通过本机通路同步。">
        <Toggle label="连接网易云音乐" checked={!system && (connected || state.phase === 'connecting')} disabled={busy || system} onChange={on => { void run(on ? 'connect' : 'disconnect') }} />
      </SettingRow>
      <SettingRow title="强制接管" hint="跳过客户端版本白名单，尝试适配模块编号变化及更多 PCM 格式；仍检查数据长度、时间戳与内存边界。">
        <Toggle label="强制接管" checked={force} disabled={connected || busy} onChange={value => { setForce(value); localStorage.setItem('jap.external.force', value ? '1' : '0') }} />
      </SettingRow>
      {connected && !system && (
        <>
          <p className="text-xs leading-relaxed text-fg-muted">在网易云输出设备中选择 <span className="text-accent-text">Just A Player HiFi Bridge (Black Hole)</span>，客户端最终输出会直接丢弃，DAC 交给本播放器。也可在下方直接切换。</p>
          {state.phase === 'ready' && (
            <div className="grid gap-2">
              <button type="button" disabled={busy || !!routeHint} aria-describedby={routeHint ? routeHintId : undefined} className="rounded-xl bg-accent px-4 py-2 text-sm text-on-accent disabled:opacity-50" onClick={() => { void run('route') }}>切换客户端到黑洞设备</button>
              {routeHint && (
                <p id={routeHintId} role="status" className="text-xs leading-relaxed text-fg-muted">
                  {routeHint} {state.snapshot?.deviceError}
                </p>
              )}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 rounded-xl bg-panel/60 p-3 text-xs">
            <div><span className="text-fg-muted">接收音频包</span><p className="mt-1 font-mono">{state.audioPackets.toLocaleString()}</p></div>
            <div><span className="text-fg-muted">黑洞已丢弃</span><p className="mt-1 font-mono">{(Number(state.nullBytes) / 1048576).toFixed(1)} MiB</p></div>
          </div>
          <p className="text-[11px] leading-relaxed text-fg-muted">虚拟设备仅出现在已连接的客户端内。FLAC 优先转交原始压缩包；其他编码可接收客户端音效处理前的 PCM。实际通路和 Bit-Perfect 状态见信号链。</p>
        </>
      )}
      {state.message && <p role="status" className="text-xs leading-relaxed text-accent-text">{state.message}</p>}
    </section>)
  )
}
