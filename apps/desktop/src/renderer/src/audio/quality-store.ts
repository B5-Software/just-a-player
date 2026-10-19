import { create } from 'zustand'
import type { QualityReport } from '@shared/protocol/QualityReport'
import { engine } from '../engine/client'
import { usePlayer } from '../engine/store'

interface QualityStore {
  report: QualityReport | null; pending: string | null; error: string | null; automatic: boolean
  analyze: () => void; setAutomatic: (automatic: boolean) => void
}
export const useQuality = create<QualityStore>((set) => ({
  report: null, pending: null, error: null, automatic: localStorage.getItem('jap.quality.auto') !== '0',
  analyze: () => {
    const path = usePlayer.getState().track?.path
    if (!path) return
    set({ pending: path, error: null, report: null })
    engine.send({ type: 'analyzeQuality', path })
  },
  setAutomatic: (automatic) => { localStorage.setItem('jap.quality.auto', automatic ? '1' : '0'); set({ automatic }) }
}))
engine.onEvent((event) => {
  if (event.type === 'trackChanged') {
    useQuality.setState({ report: null, error: null, pending: null })
    if (useQuality.getState().automatic) useQuality.getState().analyze()
  } else if (event.type === 'quality' && event.report.path === usePlayer.getState().track?.path) {
    useQuality.setState({ report: event.report, pending: null, error: null })
  } else if (event.type === 'qualityError' && event.path === useQuality.getState().pending) {
    useQuality.setState({ error: event.message, pending: null })
  }
})
