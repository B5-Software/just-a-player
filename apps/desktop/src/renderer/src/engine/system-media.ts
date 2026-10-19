import { usePlayer } from './store'
import { livePositionMs } from './clock'
import { useCover } from '../cover/store'
export function initSystemMediaSync(): void {
  let cover: Uint8Array | null = null, artwork = '', token = 0, lastSent = 0, coverDirty = true
  const send = (): void => {
    const s = usePlayer.getState(), track = s.track
    window.jap.setSystemMedia({ title: track?.title || track?.path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || '', artist: track?.artist || '', album: track?.album || '', durationMs: track?.durationMs || 0, positionMs: livePositionMs(), state: s.state, ...(coverDirty ? { cover } : {}) })
    coverDirty = false
    lastSent = performance.now()
  }
  usePlayer.subscribe((s, old) => { if (s.track !== old.track || s.state !== old.state || performance.now() - lastSent > 1000) send() })
  useCover.subscribe((s) => {
    const url = s.art?.url || ''
    if (url === artwork) return
    artwork = url; const current = ++token
    if (!url) { cover = null; coverDirty = true; send() }
    else void fetch(url).then((r) => r.arrayBuffer()).then((buffer) => { if (current === token) { cover = new Uint8Array(buffer); coverDirty = true; send() } }).catch(() => {})
  })
}
