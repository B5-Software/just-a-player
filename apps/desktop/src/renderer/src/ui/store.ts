import { create } from 'zustand'

export type PanelId =
  | 'signal'
  | 'output'
  | 'playlist'
  | 'lyrics'
  | 'appearance'
  | 'settings'
  | 'dsp'
  | 'quality'
  | 'video'
  | 'exports'

interface UiStore {
  onboardingOpen: boolean
  setOnboardingOpen: (open: boolean) => void
  /** 同一时间只展开一个面板。 */
  panel: PanelId | null
  /** 歌词拖动调整位置的模式。 */
  lyricsAdjusting: boolean
  lyricsPreview: boolean
  togglePanel: (id: PanelId) => void
  closePanel: () => void
  setLyricsAdjusting: (on: boolean) => void
}

export const useUi = create<UiStore>((set, get) => ({
  onboardingOpen:
    !window.jap.initialSettings.onboardingComplete &&
    !new URLSearchParams(location.search).has('e2e'),
  setOnboardingOpen: (onboardingOpen) =>
    set({ onboardingOpen, lyricsAdjusting: false, lyricsPreview: false, panel: null }),
  panel: null,
  lyricsAdjusting: false,
  lyricsPreview: false,
  togglePanel: (id) => {
    const panel = get().panel === id ? null : id
    set({ panel, lyricsAdjusting: panel === 'lyrics' && get().lyricsAdjusting })
  },
  closePanel: () => set({ panel: null, lyricsAdjusting: false }),
  setLyricsAdjusting: (lyricsAdjusting) => set({ lyricsAdjusting })
}))
