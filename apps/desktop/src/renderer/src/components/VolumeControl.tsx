import { Range } from '../ui/Range'
import { usePlayer } from '../engine/store'
import { SpeakerHigh, ArrowCounterClockwise } from '../icons'

export function VolumeControl({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const volume = usePlayer((s) => s.volume)
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        aria-label={volume === 0 ? '取消静音' : '静音'}
        aria-pressed={volume === 0}
        onClick={() => usePlayer.getState().toggleMute()}
        className="grid size-8 shrink-0 place-items-center rounded-full text-fg-muted hover:bg-hover"
      >
        <SpeakerHigh size={18} weight={volume === 0 ? 'thin' : 'regular'} />
      </button>
      <Range
        min={0}
        max={100}
        step={1}
        value={Math.round(volume * 100)}
        aria-label="应用内音量"
        onChange={(e) => usePlayer.getState().setVolume(Number(e.target.value) / 100)}
        className={`${compact ? 'w-16' : 'w-20'} accent-accent`}
      />
      <output className="w-8 text-right text-[11px] tabular-nums text-fg-muted">
        {Math.round(volume * 100)}%
      </output>
      {!compact && (
        <button
          type="button"
          aria-label="重置音频缓冲"
          title="重置音频缓冲"
          onClick={() => usePlayer.getState().resetBuffer()}
          className="grid size-8 shrink-0 place-items-center rounded-full text-fg-muted hover:bg-hover"
        >
          <ArrowCounterClockwise size={16} />
        </button>
      )}
    </div>
  )
}
