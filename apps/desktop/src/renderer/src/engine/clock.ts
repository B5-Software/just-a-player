import { useEffect, useState } from 'react'
import { usePlayer } from './store'

/** 此刻“正在听到”的位置（毫秒），在两次引擎回报之间按时钟外推。 */
export function livePositionMs(): number {
  const { position, state, track } = usePlayer.getState()
  const elapsed = state === 'playing' ? performance.now() - position.at : 0
  const value = position.ms + elapsed
  return track?.durationMs != null ? Math.min(value, track.durationMs) : value
}

/** 以 requestAnimationFrame 在两次引擎回报之间插值，进度条与歌词才能平滑。 */
export function useLivePosition(durationMs: number | null, activeInMini = false): number {
  const position = usePlayer((s) => s.position)
  const playing = usePlayer((s) => s.state === 'playing')
  const [now, setNow] = useState(position.ms)

  useEffect(() => {
    let frame = 0
    let lastUpdate = 0
    const tick = (time: number): void => {
      const mini = document.documentElement.dataset['windowMode'] === 'mini'
      if (
        (document.hidden && document.documentElement.dataset['windowMode'] !== 'wallpaper') ||
        document.documentElement.dataset['renderSuspended'] === '1' ||
        (mini && (!activeInMini || time - lastUpdate < 100))
      ) {
        frame = requestAnimationFrame(tick)
        return
      }
      const elapsed = playing ? performance.now() - position.at : 0
      lastUpdate = time
      const value = position.ms + elapsed
      setNow(durationMs === null ? value : Math.min(value, durationMs))
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [position, playing, durationMs, activeInMini])

  return now
}
