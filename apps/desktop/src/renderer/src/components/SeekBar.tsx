import { useCallback, useRef, useState } from 'react'
import { useLivePosition } from '../engine/clock'
import { usePlayer } from '../engine/store'
import { formatTime } from '../lib/format'

export function SeekBar({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const durationMs = usePlayer((s) => s.track?.durationMs ?? null)
  const hasTrack = usePlayer((s) => s.track !== null)
  const seek = usePlayer((s) => s.seek)
  const live = useLivePosition(durationMs, compact)

  const trackRef = useRef<HTMLDivElement>(null)
  const [dragFraction, setDragFraction] = useState<number | null>(null)

  const fractionAt = useCallback((clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return 0
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  }, [])

  const enabled = hasTrack && durationMs !== null && durationMs > 0
  const fraction = dragFraction ?? (enabled ? live / durationMs : 0)
  const shownMs = dragFraction !== null && durationMs !== null ? dragFraction * durationMs : live

  return (
    <div className="flex items-center gap-3">
      <span className="w-12 text-right font-mono text-xs text-fg-muted">{formatTime(shownMs)}</span>

      <div
        ref={trackRef}
        role="slider"
        aria-label="播放进度"
        aria-valuemin={0}
        aria-valuemax={durationMs ?? 0}
        aria-valuenow={Math.round(shownMs)}
        tabIndex={enabled ? 0 : -1}
        className={`group relative h-5 flex-1 touch-none outline-none focus-visible:ring-1 focus-visible:ring-accent/60 rounded-full ${
          enabled ? 'cursor-pointer' : 'opacity-40'
        }`}
        onPointerDown={(e) => {
          if (!enabled) return
          e.currentTarget.setPointerCapture(e.pointerId)
          setDragFraction(fractionAt(e.clientX))
        }}
        onPointerMove={(e) => {
          if (dragFraction !== null) setDragFraction(fractionAt(e.clientX))
        }}
        onPointerUp={(e) => {
          if (dragFraction === null || durationMs === null) return
          seek(fractionAt(e.clientX) * durationMs)
          setDragFraction(null)
        }}
        onKeyDown={(e) => {
          if (!enabled || durationMs === null) return
          if (e.key === 'ArrowRight') seek(Math.min(durationMs, live + 5000))
          if (e.key === 'ArrowLeft') seek(Math.max(0, live - 5000))
        }}
      >
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-hover transition-[height] group-hover:h-2">
          <div
            className="h-full rounded-full"
            style={{
              width: `${fraction * 100}%`,
              background: 'linear-gradient(90deg, rgb(var(--accent)), rgb(var(--accent-2)))'
            }}
          />
        </div>
        <div
          className={`absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-fg shadow-[0_2px_8px_rgb(0_0_0/0.4)] transition-transform ${
            dragFraction !== null ? 'scale-125' : 'scale-0 group-hover:scale-100'
          }`}
          style={{ left: `${fraction * 100}%` }}
        />
      </div>

      <span className="w-12 font-mono text-xs text-fg-muted">
        {durationMs === null ? '--:--' : formatTime(durationMs)}
      </span>
    </div>
  )
}
