import { create } from 'zustand'
import type { ExternalAction, ExternalPlayerState } from '@shared/external-player'
import { engine } from '../engine/client'
import { usePlayer } from '../engine/store'
import { setExternalCover } from '../cover/store'
import { setExternalLyrics } from '../lyrics/store'
import { externalLyrics } from './lyrics'

export const useExternal = create<ExternalPlayerState>(() => ({ phase: 'disconnected', message: '', snapshot: null, path: null, audioPackets: 0, nullBytes: '0' }))
let lastPath = '', lastLyrics = '', lastCover: Uint8Array | null = null
engine.onExternal(state => {
  const wasRouting = useExternal.getState().phase === 'routing'
  useExternal.setState(state)
  if (wasRouting && (state.phase === 'disconnected' || state.phase === 'error') && usePlayer.getState().track?.path.startsWith('external://'))
    usePlayer.setState({ track: null, signalPath: null, state: 'stopped', position: { ms: 0, at: performance.now() } })
  const s = state.snapshot
  if (!s?.track.id) { lastPath = ''; return }
  const path = `external://netease/${encodeURIComponent(s.track.id)}`, lyrics = externalLyrics(s)
  if (state.phase !== 'routing' && !(state.phase === 'ready' && usePlayer.getState().track?.path === path)) { lastPath = ''; return }
  if (path !== lastPath || (lyrics ?? '') !== lastLyrics) {
    setExternalLyrics(path, lyrics)
    lastLyrics = lyrics ?? ''
  }
  if (state.cover?.data !== lastCover || path !== lastPath) {
    if (state.cover !== undefined) setExternalCover(path, state.cover)
    lastCover = state.cover?.data ?? null
  }
  lastPath = path
})

export function externalControl(action: 'next' | 'previous' | 'resume' | 'pause' | 'toggle'): boolean {
  const external=useExternal.getState()
  if (external.phase !== 'routing' && external.snapshot?.devices?.currentDevice.name !== 'Just A Player HiFi Bridge (Black Hole)') return false
  void engine.external(action === 'toggle' ? (external.snapshot?.state === 'playing' ? 'pause' : 'resume') : action).catch(error => usePlayer.setState({ error: String(error) }))
  return true
}

export function setExternalMode(mode: string): void {
  const action: ExternalAction | undefined = {off:'repeatOff',all:'repeatAll',one:'repeatOne',shuffle:'shuffleOn'}[mode] as ExternalAction | undefined
  if (action) void engine.external(action).catch(error => usePlayer.setState({error:String(error)}))
}
export function externalOwnsTransport(): boolean {
  const state = useExternal.getState()
  return state.phase === 'routing' || state.snapshot?.devices?.currentDevice.name === 'Just A Player HiFi Bridge (Black Hole)'
}
