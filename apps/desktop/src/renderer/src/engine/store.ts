import type { DeviceInfo } from '@shared/protocol/DeviceInfo'
import type { OutputConfig } from '@shared/protocol/OutputConfig'
import type { PlaybackState } from '@shared/protocol/PlaybackState'
import type { SignalPath } from '@shared/protocol/SignalPath'
import type { TrackInfo } from '@shared/protocol/TrackInfo'
import { create } from 'zustand'
import { engine } from './client'

const OUTPUT_KEY = 'jap.output'
const DEFAULT_OUTPUT: OutputConfig = {
  api:
    window.jap.platform === 'darwin'
      ? 'coreAudio'
      : window.jap.platform === 'linux'
        ? 'alsaShared'
        : 'wasapiShared',
  deviceId: null,
  bufferMs: 20,
  dsdMode: 'pcm'
}

function loadOutput(): OutputConfig {
  try {
    const raw = localStorage.getItem(OUTPUT_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<OutputConfig>
      const allowed =
        window.jap.platform === 'darwin'
          ? ['coreAudio', 'coreAudioExclusive', 'null']
          : window.jap.platform === 'linux'
            ? ['alsaShared', 'alsaExclusive', 'null']
            : ['wasapiShared', 'wasapiExclusive', 'asio', 'null']
      return saved.api && allowed.includes(saved.api)
        ? { ...DEFAULT_OUTPUT, ...saved }
        : DEFAULT_OUTPUT
    }
  } catch {
    // 配置损坏时回到默认值
  }
  return DEFAULT_OUTPUT
}

interface PlayerStore {
  connected: boolean
  state: PlaybackState
  track: TrackInfo | null
  signalPath: SignalPath | null
  /** 引擎最近一次回报的位置与到达时刻，界面据此做逐帧插值。 */
  position: { ms: number; at: number }
  devices: DeviceInfo[]
  output: OutputConfig
  error: string | null
  volume: number
  lastVolume: number
  bufferResets: number
  setVolume: (gain: number) => void
  toggleMute: () => void
  resetBuffer: () => void

  play: (path: string, startMs?: number) => void
  togglePause: () => void
  stop: () => void
  seek: (ms: number) => void
  setOutput: (patch: Partial<OutputConfig>) => void
  refreshDevices: () => Promise<void>
  /** 只读取曲目信息，不起播。 */
  probe: (path: string) => Promise<TrackInfo | null>
  dismissError: () => void
}

export const usePlayer = create<PlayerStore>((set, get) => ({
  connected: false,
  state: 'stopped',
  track: null,
  signalPath: null,
  position: { ms: 0, at: performance.now() },
  devices: [],
  output: loadOutput(),
  error: null,
  volume: (() => {
    const n = Number(localStorage.getItem('jap.volume') ?? 0.2)
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.2
  })(),
  lastVolume: 0.2,
  bufferResets: 0,
  setVolume: (gain) => engine.send({ type: 'setVolume', gain: Math.max(0, Math.min(1, gain)) }),
  toggleMute: () => {
    const s = get()
    if (s.volume > 0) {
      set({ lastVolume: s.volume })
      s.setVolume(0)
    } else s.setVolume(s.lastVolume || 0.2)
  },
  resetBuffer: () => engine.send({ type: 'resetBuffer' }),

  play: (path, startMs = 0) => {
    set({ error: null })
    engine.send({ type: 'play', path, startMs: Math.max(0, Math.round(startMs)) })
  },

  togglePause: () => {
    const { state, track } = get()
    if (state === 'playing') engine.send({ type: 'pause' })
    else if (state === 'paused') engine.send({ type: 'resume' })
    else if (track) engine.send({ type: 'play', path: track.path })
  },

  stop: () => engine.send({ type: 'stop' }),

  seek: (ms) => {
    set({ position: { ms, at: performance.now() } })
    engine.send({ type: 'seek', positionMs: Math.max(0, Math.round(ms)) })
  },

  setOutput: (patch) => {
    const previous = get().output
    const output = {
      ...previous,
      ...(patch.api && patch.api !== previous.api ? { deviceId: null } : {}),
      ...patch
    }
    localStorage.setItem(OUTPUT_KEY, JSON.stringify(output))
    set({ output })
    engine.send({ type: 'setOutput', config: output })
    if (output.api !== previous.api) void get().refreshDevices()
  },

  refreshDevices: async () => {
    const api = get().output.api
    const response = await engine.query({
      type: 'listOutputDevices', api
    })
    if (response.type === 'devices' && get().output.api === api) set({ devices: response.devices })
  },

  probe: async (path) => {
    const response = await engine.query({ type: 'probeTrack', path })
    return response.type === 'track' ? response.track : null
  },

  dismissError: () => set({ error: null })
}))

/** 把引擎事件灌进 store；模块加载时只注册一次。 */
engine.onEvent((event) => {
  const store = usePlayer
  switch (event.type) {
    case 'state':
      store.setState({ state: event.state })
      break
    case 'volume':
      store.setState({ volume: event.gain })
      localStorage.setItem('jap.volume', String(event.gain))
      break
    case 'bufferReset':
      store.setState((s) => ({ bufferResets: s.bufferResets + 1 }))
      break
    case 'trackChanged':
      store.setState({ track: event.track })
      break
    case 'position':
      store.setState({ position: { ms: event.positionMs, at: performance.now() } })
      break
    case 'signalPath':
      store.setState({ signalPath: event.path })
      break
    case 'error':
      store.setState({ error: event.message })
      break
    case 'queueEnded':
      break
  }
})

engine.onConnect(() => {
  usePlayer.setState({ connected: true })
  if (window.jap.surface !== 'main') return
  engine.send({ type: 'setVolume', gain: usePlayer.getState().volume })
  engine.send({ type: 'setOutput', config: usePlayer.getState().output })
  void usePlayer.getState().refreshDevices()
})
