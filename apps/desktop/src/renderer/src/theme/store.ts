import { DEFAULT_ACCENT } from '@shared/settings'
import type { ThemeMode } from '@shared/theme'
import { useMemo } from 'react'
import { create } from 'zustand'
import { useCover } from '../cover/store'
import { useSettings } from '../settings/store'
import { applyAccent, normalizeHex } from './color'

export { DEFAULT_ACCENT }
export type ResolvedTheme = 'light' | 'dark'
export interface ActiveAccents {
  primary: string
  secondary: string | null
}

export const ACCENT_PRESETS: readonly { name: string; hex: string }[] = [
  { name: '靛紫', hex: '#8476ff' },
  { name: '天青', hex: '#3ea6ff' },
  { name: '青绿', hex: '#2dd4bf' },
  { name: '翠绿', hex: '#3ddc97' },
  { name: '琥珀', hex: '#f5b942' },
  { name: '珊瑚', hex: '#ff7a59' },
  { name: '玫红', hex: '#ff5c8a' },
  { name: '洋红', hex: '#d46bff' }
]

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')

function resolve(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') return darkQuery.matches ? 'dark' : 'light'
  return mode
}

/** 当前生效的强调色：开启自动取色且有封面时用封面颜色，否则用手动颜色。 */
export function activeAccents(): ActiveAccents {
  const { autoAccent, accent } = useSettings.getState()
  const palette = useCover.getState().palette
  if (autoAccent && palette) return { primary: palette.primary, secondary: palette.secondary }
  return { primary: accent, secondary: null }
}

export function useActiveAccents(): ActiveAccents {
  const autoAccent = useSettings((s) => s.autoAccent)
  const accent = useSettings((s) => s.accent)
  const palette = useCover((s) => s.palette)
  return useMemo(
    () =>
      autoAccent && palette
        ? { primary: palette.primary, secondary: palette.secondary }
        : { primary: accent, secondary: null },
    [autoAccent, accent, palette]
  )
}

function paint(resolved: ResolvedTheme): void {
  const root = document.documentElement
  root.dataset['theme'] = resolved
  const { primary, secondary } = activeAccents()
  applyAccent(root, primary, resolved, secondary)
  if (window.jap.surface === 'main') window.jap.setLightingColor(primary)
}

interface ThemeStore {
  mode: ThemeMode
  resolved: ResolvedTheme
  /** 手动选择的强调色；自动取色关闭或没有封面时生效。 */
  accent: string
  setMode: (mode: ThemeMode) => void
  setAccent: (hex: string) => void
  resetAccent: () => void
}

const initial = useSettings.getState()
const initialResolved = resolve(initial.themeMode)
// 在 React 渲染之前就上色，避免先白后黑的闪烁
paint(initialResolved)

export const useTheme = create<ThemeStore>((set, get) => ({
  mode: initial.themeMode,
  resolved: initialResolved,
  accent: initial.accent,

  setMode: (mode) => {
    const resolved = resolve(mode)
    const apply = (): void => {
      useSettings.getState().update({ themeMode: mode })
      set({ mode, resolved })
      paint(resolved)
    }
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    // 用视图过渡做整页交叉淡入，切换深浅色时不生硬
    if (typeof document.startViewTransition === 'function' && !reduceMotion) {
      document.startViewTransition(apply)
    } else {
      apply()
    }
  },

  setAccent: (hex) => {
    const accent = normalizeHex(hex)
    if (!accent) return
    // 手动选色即表示不再自动取色
    useSettings.getState().update({ accent, autoAccent: false })
    set({ accent })
    paint(get().resolved)
  },

  resetAccent: () => get().setAccent(DEFAULT_ACCENT)
}))

useSettings.subscribe((state, prev) => {
  if (state === prev) return
  useTheme.setState({
    accent: state.accent,
    mode: state.themeMode,
    resolved: resolve(state.themeMode)
  })
  paint(useTheme.getState().resolved)
})

useCover.subscribe((state, prev) => {
  if (state.palette !== prev.palette) paint(useTheme.getState().resolved)
})

// 跟随系统时，系统（或主进程切换 nativeTheme）改变配色后同步过来
darkQuery.addEventListener('change', () => {
  const { mode } = useTheme.getState()
  if (mode !== 'system') return
  const resolved = resolve('system')
  useTheme.setState({ resolved })
  paint(resolved)
})
