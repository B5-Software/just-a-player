import { baseName } from '@shared/audio'
import { usePlayer } from '../engine/store'
import { ArrowsOut } from '../icons'
import { stripExtension } from '../lib/text'
import { CoverArt } from './CoverArt'
import { SeekBar } from './SeekBar'
import { Transport } from './Transport'
import { VolumeControl } from './VolumeControl'
import { useCover } from '../cover/store'
import { useSettings } from '../settings/store'
import { CoverFade } from './CoverFade'

/** Selecting floating playback folds this same window into a small audio controller. */
export function MiniPlayer(): React.JSX.Element {
  const track = usePlayer((s) => s.track)
  const art = useCover((s) => s.art)
  const backdrop = useSettings((s) => s.miniCoverBackdrop)
  return (
    <div data-mini-player className="absolute inset-0 flex flex-col bg-surface text-fg">
      {backdrop && art && (
        <div
          data-mini-backdrop
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden"
        >
          <div className="absolute -inset-8 blur-2xl">
            <CoverFade src={art.url} />
          </div>
          <div className="absolute inset-0 bg-surface/80" />
        </div>
      )}
      <header
        className={`drag-region relative flex h-11 shrink-0 items-center gap-3 px-4 ${window.jap.platform === 'darwin' ? 'pl-20' : 'pr-36'}`}
      >
        <span className="whitespace-nowrap text-[11px] font-semibold tracking-wide text-fg-muted">
          Just A Player
        </span>
        <button
          type="button"
          aria-label="展开播放器"
          title="展开播放器"
          onClick={() => {
            void window.jap.setWindowMode('normal')
          }}
          className="no-drag grid size-7 place-items-center rounded-lg text-accent-text hover:bg-hover"
        >
          <ArrowsOut size={16} />
        </button>
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col gap-2 px-4 pb-3">
        <div className="drag-region flex min-w-0 items-center gap-3">
          <CoverArt size={52} />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold">
              {track ? (track.title ?? stripExtension(baseName(track.path))) : '准备好了'}
            </h1>
            <p className="mt-1 truncate text-xs text-fg-muted">
              {track
                ? [track.artist, track.album].filter(Boolean).join(' · ') || '未知艺术家'
                : '打开音频文件开始播放'}
            </p>
          </div>
        </div>
        <SeekBar compact />
        <div className="flex items-center justify-between gap-2">
          <Transport compact />
          <VolumeControl compact />
        </div>
      </div>
    </div>
  )
}
