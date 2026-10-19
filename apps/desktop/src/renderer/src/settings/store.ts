import type { AppSettings } from '@shared/settings'
import { create } from 'zustand'

export type SettingsState = AppSettings & {
  /** 合并更新并持久化到主进程。 */
  update: (patch: Partial<AppSettings>) => void
}

export const useSettings = create<SettingsState>((set) => ({
  ...window.jap.initialSettings,
  update: (patch) => {
    set(patch)
    void window.jap.updateSettings(patch)
  }
}))
if (window.jap.surface !== 'export') window.jap.onSettings((value) => useSettings.setState(value))
