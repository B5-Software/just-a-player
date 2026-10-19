import { useEffect, useState } from 'react'
import { useSettings } from '../settings/store'
export function ClockOverlay({
  wallpaper = false
}: {
  wallpaper?: boolean
}): React.JSX.Element | null {
  const time = useSettings((s) => (wallpaper ? s.wallpaperTime : s.fullscreenTime))
  const date = useSettings((s) => (wallpaper ? s.wallpaperDate : s.fullscreenDate))
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    if (!time && !date) return
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [time, date])
  if (!time && !date) return null
  return (
    <aside
      data-clock-overlay
      className="pointer-events-none absolute right-10 top-8 z-20 text-right text-white drop-shadow-[0_2px_10px_#0009]"
    >
      {time && (
        <time className="block font-mono text-[clamp(30px,4vw,72px)] font-light leading-none tracking-tight">
          {now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}
        </time>
      )}
      {date && (
        <p className="mt-3 text-sm tracking-[0.14em] text-white/80">
          {now.toLocaleDateString('zh-CN', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            weekday: 'long'
          })}
        </p>
      )}
    </aside>
  )
}
