import { useState } from 'react'
import { useLivePosition } from '../engine/clock'
import { usePlayer } from '../engine/store'
import { formatTime } from '../lib/format'
import { Range } from '../ui/Range'
export function SeekBar({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const duration = usePlayer((s) => s.track?.durationMs ?? null)
  const hasTrack = usePlayer((s) => s.track !== null)
  const live = useLivePosition(duration, compact)
  const [preview, setPreview] = useState<number | null>(null)
  const enabled = hasTrack && duration !== null && duration > 0
  return (
    <div className="flex items-center gap-3">
      <span className="w-12 text-right font-mono text-xs text-fg-muted">
        {formatTime(preview ?? live)}
      </span>
      <Range
        aria-label="播放进度"
        min={0}
        max={duration ?? 0}
        step={100}
        value={preview ?? live}
        disabled={!enabled}
        className="min-w-0 flex-1"
        onChange={(e) => setPreview(Number(e.target.value))}
        onCommit={(value) => {
          usePlayer.getState().seek(value)
          setPreview(null)
        }}
        onCancel={() => setPreview(null)}
      />
      <span className="w-12 font-mono text-xs text-fg-muted">
        {duration === null ? '--:--' : formatTime(duration)}
      </span>
    </div>
  )
}
