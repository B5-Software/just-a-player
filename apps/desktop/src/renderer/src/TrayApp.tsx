import { useEffect, useState } from 'react'
import { useSettings } from './settings/store'
import { Play, Pause, SkipBack, SkipForward, ArrowsOut, Monitor, X } from './icons'
import type { SystemMediaState } from '@shared/desktop'
import { CoverFade } from './components/CoverFade'
import { ArrowCounterClockwise } from './icons'
import { create } from 'zustand'
import { applyAccent } from './theme/color'
import { useTheme } from './theme/store'
const useTrayMedia = create<SystemMediaState & { accent: string; wallpaper: boolean }>(() => ({
  title: 'Just A Player',
  artist: '音乐与你',
  album: '',
  state: 'stopped',
  durationMs: 0,
  positionMs: 0,
  accent: '#8476ff',
  wallpaper: false
}))
if (window.jap.surface === 'tray') {
  window.jap.onTrayState((value) => useTrayMedia.setState(value))
  const paint = (): void =>
    applyAccent(
      document.documentElement,
      useTrayMedia.getState().accent,
      useTheme.getState().resolved
    )
  useTrayMedia.subscribe(paint)
  useSettings.subscribe(paint)
  useTheme.subscribe(paint)
  paint()
}
export function TrayApp(): React.JSX.Element {
  const media = useTrayMedia()
  const wallpaper = useSettings((s) => s.wallpaperEnabled)
  const action = window.jap.trayAction
  const [cover, setCover] = useState<string | null>(null)
  useEffect(() => {
    if (!media.cover) {
      setCover(null)
      return
    }
    const url = URL.createObjectURL(new Blob([new Uint8Array(media.cover)], { type: 'image/png' }))
    setCover(url)
    return () => {
      setTimeout(() => URL.revokeObjectURL(url), 1200)
    }
  }, [media.cover])
  return (
    <div
      data-tray-menu
      role="dialog"
      aria-label="播放器托盘菜单"
      onKeyDown={(event) => {
        if (event.key === 'Escape') action('close')
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          buttons[
            (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
          ]?.focus()
        }
      }}
      className="m-2 overflow-hidden rounded-[24px] border border-line bg-surface/98 p-4 text-fg"
    >
      <div className="mb-4 flex items-center gap-3">
        <div
          className="relative grid size-11 shrink-0 place-items-center overflow-hidden rounded-2xl text-white"
          style={{ background: 'linear-gradient(135deg,rgb(var(--accent)),rgb(var(--accent-2)))' }}
        >
          {cover ? <CoverFade src={cover} /> : <span className="font-mono text-lg">J</span>}
        </div>
        <div className="min-w-0">
          <p className="text-[10px] font-semibold tracking-[0.16em] text-fg-muted">JUST A PLAYER</p>
          <p className="mt-1 truncate text-sm font-semibold">{media.title || '准备好了'}</p>
          <p className="mt-0.5 truncate text-xs text-fg-muted">{media.artist}</p>
        </div>
      </div>
      <div className="mb-4 flex items-center justify-center gap-5">
        {(
          [
            ['previous', '上一首', SkipBack],
            [
              media.state === 'playing' ? 'pause' : 'play',
              media.state === 'playing' ? '暂停' : '播放',
              media.state === 'playing' ? Pause : Play
            ],
            ['next', '下一首', SkipForward]
          ] as const
        ).map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            aria-label={label}
            onClick={() => action(key)}
            className={`grid place-items-center rounded-full ${key === 'previous' || key === 'next' ? 'size-9 hover:bg-hover' : 'size-11 bg-accent text-on-accent'}`}
          >
            <Icon size={20} weight="fill" />
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-1 border-t border-line pt-2">
        {(
          [
            ['show', '打开播放器', ArrowsOut],
            ['mini', '悬浮播放', Monitor],
            ['wallpaper', wallpaper ? '关闭桌面壁纸' : '开启桌面壁纸', Monitor],
            ['reset', '重置音频缓冲', ArrowCounterClockwise],
            ['quit', '退出播放器', X]
          ] as const
        ).map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            onClick={() => action(key)}
            className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-xs hover:bg-hover"
          >
            <Icon size={16} />
            <span>{label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
