import { create } from 'zustand'
import type { DspConfig } from '@shared/protocol/DspConfig'
import { engine } from '../engine/client'

export const EQ_HZ = [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const
export const DEFAULT_DSP: DspConfig = {
  enabled: false, preampDb: -6, eqDb: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], balance: 0,
  stereoWidth: 1, crossfeed: 0, limiter: true
}
const KEY = 'jap.dsp.v1'
function load(): DspConfig {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (value && Array.isArray(value.eqDb) && value.eqDb.length === 10 && value.eqDb.every((n: unknown) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 12)) {
      const config = { ...DEFAULT_DSP, ...value }
      if ([config.preampDb, config.balance, config.stereoWidth, config.crossfeed].every(Number.isFinite)) return config
    }
  } catch { /* corrupt settings use defaults */ }
  return DEFAULT_DSP
}
export const useDsp = create<{ config: DspConfig; update: (patch: Partial<DspConfig>) => void }>((_, get) => ({
  config: load(),
  update: (patch) => engine.send({ type: 'setDsp', config: { ...get().config, ...patch } })
}))
engine.onEvent((event) => {
  if (event.type === 'dspChanged') {
    useDsp.setState({ config: event.config })
    localStorage.setItem(KEY, JSON.stringify(event.config))
  }
})
engine.onConnect(() => { if (window.jap.surface === 'main') engine.send({ type: 'setDsp', config: useDsp.getState().config }) })

export const DSP_PRESETS: { name: string; patch: Partial<DspConfig> }[] = [
  { name: '平直', patch: { ...DEFAULT_DSP, enabled: true } },
  { name: '温暖', patch: { eqDb: [3, 3, 2, 1, 0, 0, -1, -1, 0, 0], preampDb: -5, stereoWidth: 1, crossfeed: 0 } },
  { name: '人声', patch: { eqDb: [-2, -1, 0, 1, 2, 3, 3, 1, 0, -1], preampDb: -5, stereoWidth: 1, crossfeed: 0 } },
  { name: '摇滚', patch: { eqDb: [4, 3, 1, -1, -2, 0, 2, 3, 2, 1], preampDb: -6, stereoWidth: 1.1, crossfeed: 0 } },
  { name: '爵士', patch: { eqDb: [2, 1, 0, 0, -1, 1, 2, 1, 2, 2], preampDb: -5, stereoWidth: 1.05, crossfeed: 0 } },
  { name: '清亮', patch: { eqDb: [-1, -1, 0, 0, 0, 1, 2, 3, 3, 2], preampDb: -6, stereoWidth: 1, crossfeed: 0 } },
  { name: '耳机串音', patch: { eqDb: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], preampDb: -4, stereoWidth: 0.95, crossfeed: 0.65 } }
]
